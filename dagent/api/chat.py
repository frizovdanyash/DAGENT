"""Chat routes: sessions, messages, runs, approvals and the built-in terminal."""

from __future__ import annotations

import asyncio
import json
import os
import time
from urllib.parse import quote

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, File, HTTPException, Query, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse

from ..agent.modes import MODE_INDEX, get_mode, localize_modes
from ..agent.safety import SafetyEngine
from ..agent.tools import ToolContext, is_binary, read_text_safely, rel
from ..events import hub
from ..providers import build_provider
from ..store import export_session
from ..state import state

router = APIRouter(prefix="/api")


# --------------------------------------------------------------------------- #
# sessions
# --------------------------------------------------------------------------- #

@router.get("/sessions")
async def list_sessions(q: str = Query(""), include_archived: bool = Query(False), limit: int = Query(300)) -> Dict[str, Any]:
    sessions = state.store.list_sessions(query=q, include_archived=include_archived, limit=limit)
    return {"sessions": sessions, "count": len(sessions)}


@router.post("/sessions")
async def create_session(payload: Dict[str, Any] = Body(default={})) -> Dict[str, Any]:
    language = str(state.settings.get("app.language", "ru"))
    default_title = "New session" if language == "en" else "Новая сессия"
    session = state.store.create_session(
        title=str(payload.get("title") or default_title),
        model_id=payload.get("model_id") or state.settings.get("models.active_id"),
        mode=str(payload.get("mode") or state.settings.get("agent.mode") or "assistant"),
        workspace=payload.get("workspace") or state.settings.get("workspace.root"),
        meta={"created_by": "user"},
    )
    hub.emit("session.created", {"session": session})
    return {"ok": True, "session": session}


@router.get("/sessions/{session_id}")
async def get_session(session_id: str) -> Dict[str, Any]:
    session = state.store.get_session(session_id)
    if not session:
        raise HTTPException(404, f"Session not found: {session_id}")
    messages = state.store.list_messages(session_id)
    run = state.runs.active_run(session_id)
    return {
        "session": session,
        "messages": messages,
        "stats": state.store.session_stats(session_id),
        "run": run.public() if run else None,
        "pending": [p.public() for p in state.runs.pending.values() if p.session_id == session_id],
    }


@router.patch("/sessions/{session_id}")
async def patch_session(session_id: str, payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    if not state.store.get_session(session_id):
        raise HTTPException(404, "Session not found")
    fields: Dict[str, Any] = {}
    for key in ("title", "mode", "model_id", "workspace", "pinned", "archived", "tags"):
        if key in payload:
            fields[key] = payload[key]
    if "mode" in fields and fields["mode"] not in MODE_INDEX:
        raise HTTPException(400, f"Unknown mode: {fields['mode']}")
    if "meta" in payload and isinstance(payload["meta"], dict):
        current = state.store.get_session(session_id) or {}
        fields["meta"] = {**(current.get("meta") or {}), **payload["meta"]}
    session = state.store.update_session(session_id, **fields)
    hub.emit("session.updated", {"session": session})
    return {"ok": True, "session": session}


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str) -> Dict[str, Any]:
    run = state.runs.active_run(session_id)
    if run:
        state.runs.stop(run.run_id)
    state.store.delete_session(session_id)
    hub.emit("session.deleted", {"session_id": session_id})
    return {"ok": True}


@router.post("/sessions/{session_id}/duplicate")
async def duplicate_session(session_id: str, payload: Dict[str, Any] = Body(default={})) -> Dict[str, Any]:
    copy = state.store.duplicate_session(session_id, with_messages=bool(payload.get("with_messages", True)))
    if not copy:
        raise HTTPException(404, "Session not found")
    hub.emit("session.created", {"session": copy})
    return {"ok": True, "session": copy}


@router.post("/sessions/{session_id}/clear")
async def clear_session(session_id: str) -> Dict[str, Any]:
    state.store.truncate_session(session_id)
    hub.emit("session.cleared", {"session_id": session_id})
    return {"ok": True, "session": state.store.get_session(session_id)}


def _content_disposition(filename: str) -> str:
    """HTTP headers are latin-1: keep an ASCII fallback plus RFC 5987 for the real name."""
    fallback = "".join(char if char.isascii() and (char.isalnum() or char in "._-") else "_" for char in filename)
    fallback = fallback.strip("_") or "dagent-session"
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename)}"


@router.get("/sessions/{session_id}/export")
async def export_one_session(session_id: str, fmt: str = Query("json")) -> Any:
    if not state.store.get_session(session_id):
        raise HTTPException(404, "Session not found")
    filename, content = export_session(state.store, session_id, fmt if fmt in ("json", "md") else "json")
    if fmt == "md":
        return PlainTextResponse(content, headers={"Content-Disposition": _content_disposition(filename),
                                                   "Content-Type": "text/markdown; charset=utf-8"})
    return JSONResponse(
        json.loads(content),
        headers={"Content-Disposition": _content_disposition(filename)},
    )


@router.post("/sessions/import")
async def import_session(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    data = payload.get("data") or payload
    session_data = data.get("session") or {}
    messages = data.get("messages") or []
    if not isinstance(messages, list):
        raise HTTPException(400, "Expected a DAGENT export with a 'messages' array")
    session = state.store.create_session(
        title=str(session_data.get("title") or "Imported session"),
        model_id=session_data.get("model_id"),
        mode=str(session_data.get("mode") or "assistant"),
        workspace=session_data.get("workspace"),
        meta={"imported": True},
    )
    for message in messages:
        state.store.add_message(
            session["id"],
            str(message.get("role") or "user"),
            str(message.get("content") or ""),
            meta=message.get("meta") or {},
        )
    hub.emit("session.created", {"session": session})
    return {"ok": True, "session": session, "messages": len(messages)}


# --------------------------------------------------------------------------- #
# attachments
# --------------------------------------------------------------------------- #

@router.post("/attachments/upload")
async def upload_attachment(file: UploadFile = File(...), session_id: str = Query("")) -> Dict[str, Any]:
    raw = await file.read()
    limit = int(state.settings.get("chat.max_attachment_bytes", 400_000) or 400_000)
    name = file.filename or "attachment"
    if len(raw) > limit:
        raise HTTPException(413, f"Attachment is too large ({len(raw):,} bytes > {limit:,})")
    workspace = state.settings.get("workspace.root") or ""
    upload_dir = os.path.join(workspace, ".dagent_uploads")
    os.makedirs(upload_dir, exist_ok=True)
    safe_name = "".join(ch for ch in os.path.basename(name) if ch.isalnum() or ch in "._- ")[:80] or "file"
    target = os.path.join(upload_dir, f"{int(time.time())}_{safe_name}")
    with open(target, "wb") as fh:
        fh.write(raw)
    text = ""
    binary = b"\x00" in raw[:2048]
    if not binary:
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("cp1251", "replace")
    return {
        "ok": True,
        "attachment": {
            "name": name,
            "path": rel(target, workspace) if workspace else target,
            "abs_path": target,
            "size": len(raw),
            "binary": binary,
            "content": text if not binary else "",
        },
    }


def _resolve_attachments(attachments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Load content for attachments that only carry a path."""
    limit = int(state.settings.get("chat.max_attachment_bytes", 400_000) or 400_000)
    out: List[Dict[str, Any]] = []
    for item in attachments or []:
        entry = dict(item)
        content = entry.get("content")
        path = entry.get("abs_path") or entry.get("path")
        if content is None and path:
            absolute = path if os.path.isabs(str(path)) else os.path.join(state.settings.get("workspace.root") or "", str(path))
            try:
                if os.path.isfile(absolute) and not is_binary(absolute):
                    content = read_text_safely(absolute, limit)
                    entry["abs_path"] = absolute
                    entry["name"] = entry.get("name") or os.path.basename(absolute)
                    entry["size"] = os.path.getsize(absolute)
            except OSError:
                content = None
        if content is not None:
            entry["content"] = str(content)[:limit]
        out.append(entry)
    return out


# --------------------------------------------------------------------------- #
# chat / runs
# --------------------------------------------------------------------------- #

@router.post("/chat")
async def start_chat(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    text = str(payload.get("text") or payload.get("message") or "")
    attachments = _resolve_attachments(payload.get("attachments") or [])
    session_id = str(payload.get("session_id") or "")
    mode = str(payload.get("mode") or "")
    model_id = payload.get("model_id") or None

    if not text.strip() and not attachments:
        raise HTTPException(400, "Message text is required")
    if not state.settings.active_profile():
        raise HTTPException(409, "No model is configured. Open Settings -> Models and add an API key or a GGUF file.")

    if not session_id:
        language = str(state.settings.get("app.language", "ru"))
        session = state.store.create_session(
            title=(text.strip().split("\n")[0][:48] or ("New session" if language == "en" else "Новая сессия")),
            model_id=model_id or state.settings.get("models.active_id"),
            mode=mode or str(state.settings.get("agent.mode", "assistant")),
            workspace=payload.get("workspace") or state.settings.get("workspace.root"),
        )
        session_id = session["id"]
        hub.emit("session.created", {"session": session})
    else:
        existing = state.store.get_session(session_id)
        if not existing:
            raise HTTPException(404, "Session not found")
        updates: Dict[str, Any] = {}
        if mode:
            updates["mode"] = mode
        if model_id:
            updates["model_id"] = model_id
        if updates:
            state.store.update_session(session_id, **updates)

    running = state.runs.active_run(session_id)
    if running:
        raise HTTPException(409, "This session already has a running task. Stop it first.")

    state.stats["runs"] = state.stats.get("runs", 0) + 1
    try:
        run_id = state.runs.start(
            session_id,
            text,
            attachments=attachments,
            model_id=model_id,
            mode=mode or None,
            regenerate_from=payload.get("regenerate_from"),
        )
    except ValueError as exc:
        raise HTTPException(409, "No model is configured. Add one in Settings -> Models.") from exc
    return {"ok": True, "run_id": run_id, "session_id": session_id, "session": state.store.get_session(session_id)}


@router.get("/runs")
async def list_runs() -> Dict[str, Any]:
    runs = [run.public() for run in state.runs.runs.values()]
    runs.sort(key=lambda item: item.get("started_at") or 0, reverse=True)
    return {"runs": runs[:30], "active": [r for r in runs if r["status"] in ("running", "waiting")]}


@router.post("/runs/{run_id}/stop")
async def stop_run(run_id: str) -> Dict[str, Any]:
    if not state.runs.stop(run_id):
        raise HTTPException(404, "Run not found")
    return {"ok": True, "run_id": run_id}


@router.post("/runs/stop-all")
async def stop_all_runs() -> Dict[str, Any]:
    return {"ok": True, "stopped": state.runs.stop_all()}


@router.get("/runs/{run_id}/events")
async def run_events(run_id: str, since: int = Query(0), wait: float = Query(25.0, le=55.0)) -> Dict[str, Any]:
    """Long-polling fallback for environments where WebSockets are blocked."""
    deadline = time.time() + wait
    while True:
        events = hub.history(since_id=since, run_id=run_id)
        if events or time.time() > deadline:
            run = state.runs.runs.get(run_id)
            return {
                "events": events,
                "last_id": events[-1]["id"] if events else since,
                "run": run.public() if run else None,
            }
        await asyncio.sleep(0.25)


# --------------------------------------------------------------------------- #
# messages
# --------------------------------------------------------------------------- #

@router.patch("/messages/{message_id}")
async def edit_message(message_id: str, payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    message = state.store.get_message(message_id)
    if not message:
        raise HTTPException(404, "Message not found")
    content = payload.get("content")
    meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else None
    updated = state.store.update_message(message_id, content=None if content is None else str(content), meta=meta)
    hub.emit("message.updated", {"message": updated})
    result: Dict[str, Any] = {"ok": True, "message": updated}
    if payload.get("rerun"):
        session_id = message["session_id"]
        if state.runs.active_run(session_id):
            raise HTTPException(409, "A run is already active in this session")
        run_id = state.runs.start(session_id, "", regenerate_from=message_id)
        result["run_id"] = run_id
    return result


@router.delete("/messages/{message_id}")
async def delete_message(message_id: str, cascade: bool = Query(False)) -> Dict[str, Any]:
    message = state.store.get_message(message_id)
    if not message:
        raise HTTPException(404, "Message not found")
    if cascade:
        removed = state.store.delete_messages_from(message["session_id"], int(message["seq"]))
    else:
        state.store.delete_message(message_id)
        removed = 1
    hub.emit("message.deleted", {"message_id": message_id, "session_id": message["session_id"], "removed": removed})
    return {"ok": True, "removed": removed, "messages": state.store.list_messages(message["session_id"])}


@router.post("/messages/{message_id}/regenerate")
async def regenerate_message(message_id: str) -> Dict[str, Any]:
    message = state.store.get_message(message_id)
    if not message:
        raise HTTPException(404, "Message not found")
    if state.runs.active_run(message["session_id"]):
        raise HTTPException(409, "A run is already active in this session")
    run_id = state.runs.start(message["session_id"], "", regenerate_from=message_id)
    return {"ok": True, "run_id": run_id}


@router.post("/sessions/{session_id}/retry-last")
async def retry_last(session_id: str) -> Dict[str, Any]:
    messages = state.store.list_messages(session_id)
    for message in reversed(messages):
        if message.get("role") == "assistant":
            run_id = state.runs.start(session_id, "", regenerate_from=message["id"])
            return {"ok": True, "run_id": run_id}
    for message in reversed(messages):
        if message.get("role") == "user":
            run_id = state.runs.start(session_id, message.get("content") or "", regenerate_from=message["id"])
            return {"ok": True, "run_id": run_id}
    raise HTTPException(409, "Nothing to retry in this session")


# --------------------------------------------------------------------------- #
# approvals & questions
# --------------------------------------------------------------------------- #

@router.get("/interactions")
async def list_interactions() -> Dict[str, Any]:
    return {"pending": [request.public() for request in state.runs.pending.values()]}


@router.post("/interactions/{call_id}")
async def resolve_interaction(call_id: str, payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    decision = {
        "approved": bool(payload.get("approved", payload.get("accept", False))),
        "scope": str(payload.get("scope") or "once"),
        "note": str(payload.get("note") or ""),
        "answer": str(payload.get("answer") or payload.get("value") or ""),
        "cancelled": bool(payload.get("cancelled")),
    }
    if not state.runs.resolve(call_id, decision):
        raise HTTPException(404, "This request is no longer pending (it may have timed out)")
    return {"ok": True, "call_id": call_id, "decision": decision}


# --------------------------------------------------------------------------- #
# built-in terminal (user-driven, not model-driven)
# --------------------------------------------------------------------------- #

@router.post("/terminal")
async def terminal_run(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    command = str(payload.get("command") or "").strip()
    if not command:
        raise HTTPException(400, "Command is required")
    workspace = str(payload.get("cwd") or state.settings.get("workspace.root") or os.getcwd())
    safety = SafetyEngine(state.settings, workspace)
    risk, reason = safety.classify_command(command)
    if risk == "blocked":
        return {"ok": False, "blocked": True, "reason": reason, "output": f"Blocked by DAGENT policy: {reason}"}
    session_id = str(payload.get("session_id") or "")
    ctx = ToolContext(
        settings=state.settings,
        safety=safety,
        store=state.store,
        session_id=session_id,
        workspace=workspace,
        emit=_terminal_emit,
    )
    from ..agent.tools import tool_run_command

    result = await tool_run_command(ctx, {"command": command, "cwd": str(payload.get("cwd") or ""),
                                          "timeout": payload.get("timeout")})
    hub.emit("terminal.command", {"command": command, "ok": result.ok, "session_id": session_id})
    return {"ok": result.ok, "result": result.to_dict(), "risk": risk, "reason": reason}


async def _terminal_emit(event_type: str, payload: Dict[str, Any]) -> None:
    hub.emit(event_type, payload)


# --------------------------------------------------------------------------- #
# misc helpers used by the GUI
# --------------------------------------------------------------------------- #

@router.get("/modes")
async def modes() -> Dict[str, Any]:
    language = str(state.settings.get("app.language", "ru"))
    return {"modes": localize_modes(language), "active": state.settings.get("agent.mode")}


@router.post("/quick-title")
async def quick_title(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Ask the active model for a short title (used by the rename dialog)."""
    from ..agent.prompts import title_prompt

    text = str(payload.get("text") or "")
    if not text:
        raise HTTPException(400, "text is required")
    profile = state.settings.active_profile()
    if not profile:
        raise HTTPException(409, "No model configured")
    provider = build_provider(profile, state.settings)
    result = await provider.complete(title_prompt(text, str(state.settings.get("app.language", "ru"))),
                                     params={"max_tokens": 24, "temperature": 0.3})
    title = (result.content or "").strip().strip('".«»“”').split("\n")[0][:60]
    return {"ok": result.ok, "title": title or text[:40], "error": result.error}


@router.post("/summarize-session/{session_id}")
async def summarize_session(session_id: str) -> Dict[str, Any]:
    from ..agent.prompts import compression_prompt

    messages = state.store.list_messages(session_id)
    if not messages:
        raise HTTPException(409, "Session is empty")
    transcript = "\n".join(f"{m['role'].upper()}: {str(m.get('content') or '')[:1500]}" for m in messages)
    profile = state.settings.active_profile()
    if not profile:
        raise HTTPException(409, "No model configured")
    provider = build_provider(profile, state.settings)
    result = await provider.complete(
        compression_prompt(transcript, str(state.settings.get("app.language", "ru"))),
        params={"max_tokens": 800, "temperature": 0.3},
    )
    if not result.ok:
        raise HTTPException(502, result.error or "Model error")
    summary = result.content.strip()
    session = state.store.update_session(session_id, meta={"summary": summary})
    hub.emit("session.updated", {"session": session})
    return {"ok": True, "summary": summary, "session": session}
