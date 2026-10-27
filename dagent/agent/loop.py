"""The agent loop: model -> tool calls -> results -> model, until the task is done.

This module owns everything that happens during a "run": prompt assembly,
streaming, context compression, permission checks, tool execution, persistence
and real-time events for the GUI.
"""

from __future__ import annotations

import asyncio
import json
import time
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from .. import store as store_module
from ..config import Settings
from ..events import hub
from ..providers import build_provider
from ..providers.base import Chunk, CompletionResult, ProviderError, ToolCall, estimate_tokens
from . import protocol
from .modes import get_mode, mode_tools
from .prompts import build_system_prompt, compression_prompt, title_prompt
from .safety import SafetyEngine
from .tools import ToolContext, ToolResult, ToolSpec, specs_for_prompt, tools_for

RUNNING = "running"
WAITING = "waiting"
DONE = "done"
STOPPED = "stopped"
ERROR = "error"


# --------------------------------------------------------------------------- #
# run bookkeeping
# --------------------------------------------------------------------------- #

@dataclass
class RunState:
    run_id: str
    session_id: str
    model_id: str
    mode: str
    status: str = RUNNING
    started_at: float = field(default_factory=time.time)
    finished_at: Optional[float] = None
    iterations: int = 0
    max_iterations: int = 12
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    tools_used: int = 0
    last_error: str = ""
    stop_reason: str = ""
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    task: Optional[asyncio.Task] = None

    def public(self) -> Dict[str, Any]:
        return {
            "run_id": self.run_id,
            "session_id": self.session_id,
            "model_id": self.model_id,
            "mode": self.mode,
            "status": self.status,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "iterations": self.iterations,
            "max_iterations": self.max_iterations,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total_tokens,
            "tools_used": self.tools_used,
            "last_error": self.last_error,
            "stop_reason": self.stop_reason,
            "elapsed_ms": int(((self.finished_at or time.time()) - self.started_at) * 1000),
        }


class PendingRequest:
    """An approval / question the GUI has to answer."""

    def __init__(self, kind: str, call_id: str, run_id: str, session_id: str, payload: Dict[str, Any]) -> None:
        self.kind = kind
        self.call_id = call_id
        self.run_id = run_id
        self.session_id = session_id
        self.payload = payload
        self.future: asyncio.Future = asyncio.get_event_loop().create_future()
        self.created_at = time.time()

    def resolve(self, value: Dict[str, Any]) -> None:
        if not self.future.done():
            self.future.set_result(value)

    def public(self) -> Dict[str, Any]:
        return {
            "call_id": self.call_id,
            "kind": self.kind,
            "run_id": self.run_id,
            "session_id": self.session_id,
            "payload": self.payload,
            "created_at": self.created_at,
        }


class RunManager:
    def __init__(self, settings: Settings, store: store_module.Store) -> None:
        self.settings = settings
        self.store = store
        self.runs: Dict[str, RunState] = {}
        self.pending: Dict[str, PendingRequest] = {}
        self.session_allow: Dict[str, set] = {}

    # -- lifecycle --------------------------------------------------------- #
    def active_run(self, session_id: Optional[str] = None) -> Optional[RunState]:
        for state in self.runs.values():
            if state.status in (RUNNING, WAITING):
                if session_id is None or state.session_id == session_id:
                    return state
        return None

    def start(self, session_id: str, text: str, *, attachments: Optional[List[Dict[str, Any]]] = None,
              model_id: Optional[str] = None, mode: Optional[str] = None,
              regenerate_from: Optional[str] = None) -> str:
        runner = AgentRunner(self, session_id=session_id, text=text, attachments=attachments or [],
                             model_id=model_id, mode=mode, regenerate_from=regenerate_from)
        state = runner.state
        self.runs[state.run_id] = state
        state.task = asyncio.get_event_loop().create_task(runner.execute())
        return state.run_id

    def stop(self, run_id: str) -> bool:
        state = self.runs.get(run_id)
        if not state:
            return False
        state.cancel_event.set()
        state.stop_reason = "stopped by user"
        for call_id, request in list(self.pending.items()):
            if request.run_id == run_id:
                request.resolve({"cancelled": True, "approved": False, "answer": ""})
        if state.task and not state.task.done():
            state.task.cancel()
        return True

    def stop_all(self) -> int:
        count = 0
        for run_id in list(self.runs.keys()):
            if self.runs[run_id].status in (RUNNING, WAITING):
                self.stop(run_id)
                count += 1
        return count

    # -- interaction ------------------------------------------------------- #
    async def request(self, kind: str, run_id: str, session_id: str, payload: Dict[str, Any],
                      timeout: float = 0) -> Dict[str, Any]:
        call_id = payload.get("call_id") or uuid.uuid4().hex[:12]
        pending = PendingRequest(kind, call_id, run_id, session_id, payload)
        self.pending[call_id] = pending
        hub.emit(f"{kind}.required", pending.public(), run_id=run_id, session_id=session_id)
        state = self.runs.get(run_id)
        if state:
            state.status = WAITING
        try:
            if timeout and timeout > 0:
                try:
                    answer = await asyncio.wait_for(pending.future, timeout=timeout)
                except asyncio.TimeoutError:
                    answer = {"approved": False, "cancelled": True, "timeout": True}
            else:
                answer = await pending.future
        finally:
            self.pending.pop(call_id, None)
            if state and state.status == WAITING:
                state.status = RUNNING
        return answer or {}

    def resolve(self, call_id: str, decision: Dict[str, Any]) -> bool:
        pending = self.pending.get(call_id)
        if not pending:
            return False
        pending.resolve(decision)
        return True

    def remember_choice(self, session_id: str, key: str) -> None:
        self.session_allow.setdefault(session_id, set()).add(key)

    def allowed_for(self, session_id: str) -> set:
        return self.session_allow.setdefault(session_id, set())


# --------------------------------------------------------------------------- #
# the runner
# --------------------------------------------------------------------------- #

class AgentRunner:
    def __init__(
        self,
        manager: RunManager,
        session_id: str,
        text: str,
        attachments: Optional[List[Dict[str, Any]]] = None,
        model_id: Optional[str] = None,
        mode: Optional[str] = None,
        regenerate_from: Optional[str] = None,
    ) -> None:
        self.manager = manager
        self.settings = manager.settings
        self.store = manager.store
        self.session_id = session_id
        self.text = text or ""
        self.attachments = attachments or []
        self.regenerate_from = regenerate_from

        session = self.store.get_session(session_id) or {}
        self.session = session
        self.mode = (mode or session.get("mode") or self.settings.get("agent.mode") or "assistant")
        self.mode_data = get_mode(self.mode)

        profile = None
        wanted = model_id or session.get("model_id") or self.settings.get("models.active_id")
        if wanted:
            profile = self.settings.profile(wanted)
        if profile is None:
            profile = self.settings.active_profile()
        if profile is None:
            raise ValueError("no-model")
        self.profile = profile
        self.provider = build_provider(profile, self.settings)

        self.state = RunState(
            run_id=uuid.uuid4().hex[:12],
            session_id=session_id,
            model_id=str(profile.get("id")),
            mode=self.mode,
            max_iterations=int(self.mode_data.get("defaults", {}).get("max_iterations")
                               or self.settings.get("agent.max_iterations", 12)),
        )
        self.safety = SafetyEngine(self.settings, session.get("workspace") or self.settings.get("workspace.root") or "")
        self.tool_names = mode_tools(self.mode)
        self.specs: List[ToolSpec] = tools_for(self.tool_names)
        self.protocol_mode = self._decide_protocol()
        self.summary_cache: Optional[str] = None
        self._user_message_id = ""
        self._last_assistant_text = ""

    # ------------------------------------------------------------------ #
    # helpers
    # ------------------------------------------------------------------ #
    def _decide_protocol(self) -> str:
        configured = str(self.settings.get("agent.tool_protocol", "auto") or "auto").lower()
        if configured in ("native", "json"):
            return configured
        if not self.specs:
            return "native"
        return "native" if self.provider.native_tools is not False else "json"

    async def emit(self, kind: str, payload: Optional[Dict[str, Any]] = None) -> None:
        hub.emit(kind, payload, run_id=self.state.run_id, session_id=self.session_id)

    def _params(self) -> Dict[str, Any]:
        defaults = self.mode_data.get("defaults", {})
        params: Dict[str, Any] = {
            "temperature": self.settings.get("agent.temperature", defaults.get("temperature", 0.7)),
            "top_p": self.settings.get("agent.top_p", 0.95),
            "top_k": self.settings.get("agent.top_k", 0) or None,
            "max_tokens": self.settings.get("agent.max_tokens", defaults.get("max_tokens", 2048)),
            "frequency_penalty": self.settings.get("agent.frequency_penalty", 0),
            "presence_penalty": self.settings.get("agent.presence_penalty", 0),
            "repeat_penalty": self.settings.get("agent.repeat_penalty", 1.1),
            "stop_sequences": self.settings.get("agent.stop_sequences", []) or [],
            "seed": self.settings.get("agent.seed"),
            "request_timeout": self.settings.get("agent.request_timeout", 300),
            "use_native_tools": self.protocol_mode == "native",
        }
        profile_params = self.profile.get("params") or {}
        for key, value in profile_params.items():
            if value not in (None, "", 0) or key in ("temperature",):
                params[key] = value
        ctx_window = int(profile_params.get("context_window")
                         or (self.profile.get("capabilities") or {}).get("context_window")
                         or self.settings.get("agent.context_window", 8192) or 8192)
        params["context_window"] = ctx_window
        gguf_options = self.profile.get("gguf_options") or {}
        params.update({key: value for key, value in gguf_options.items() if value is not None})
        if params.get("max_tokens") and params["max_tokens"] > ctx_window:
            params["max_tokens"] = max(256, ctx_window // 2)
        return params

    # ------------------------------------------------------------------ #
    # message assembly
    # ------------------------------------------------------------------ #
    def _system_prompt(self) -> str:
        tools_doc = protocol.system_prompt_tools_section(specs_for_prompt(self.specs)) if self.specs else ""
        shell = " ".join(self.safety.shell_command()[0])
        return build_system_prompt(
            mode=self.mode,
            language=str(self.settings.get("app.language", "ru")),
            workspace=self.safety.workspace_root,
            model_name=self.profile.get("name") or self.profile.get("model") or "",
            tools_doc=tools_doc,
            protocol=self.protocol_mode,
            settings=self.settings,
            shell=shell,
            session_title=str(self.session.get("title") or ""),
        )

    @staticmethod
    def _stored_to_model(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Expand persisted messages (with meta.tool_calls) into wire messages."""
        out: List[Dict[str, Any]] = []
        for message in messages:
            role = message.get("role")
            meta = message.get("meta") or {}
            content = message.get("content") or ""
            if role == "assistant":
                calls = meta.get("tool_calls") or []
                item: Dict[str, Any] = {"role": "assistant", "content": content}
                if calls:
                    item["tool_calls"] = [
                        {"id": call.get("id") or "", "tool": call.get("tool") or "", "args": call.get("args") or {}}
                        for call in calls
                    ]
                out.append(item)
                for result in meta.get("tool_results") or []:
                    out.append({
                        "role": "tool",
                        "tool_call_id": result.get("id") or "",
                        "name": result.get("tool") or "",
                        "content": result.get("output") or "",
                    })
            elif role == "user":
                attachments = meta.get("attachments") or []
                if attachments:
                    parts = [content] if content else []
                    for attachment in attachments:
                        if attachment.get("content"):
                            parts.append(
                                f"<attached_file path=\"{attachment.get('name')}\">\n{attachment['content']}\n</attached_file>"
                            )
                        else:
                            parts.append(f"<attached_file path=\"{attachment.get('name')}\" />")
                    content = "\n\n".join(parts)
                if content:
                    out.append({"role": "user", "content": content})
            elif role == "system":
                if content:
                    out.append({"role": "system", "content": content})
        return out

    async def _build_messages(self) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
        params = self._params()
        history = self.store.list_messages(self.session_id)
        wire_history = self._stored_to_model(history)
        system = self._system_prompt()
        budget = int(params.get("context_window") or 8192)
        reserve = int(params.get("max_tokens") or 1024)
        used = estimate_tokens(system) + sum(estimate_tokens(str(m.get("content") or "")) for m in wire_history)
        info = {"history_messages": len(wire_history), "estimated_tokens": used, "context_window": budget,
                "compressed": False}
        if (
            self.settings.get("agent.compress_history", True)
            and budget
            and used > (budget - reserve) * float(self.settings.get("agent.compress_ratio", 0.7))
            and len(wire_history) > 6
        ):
            compressed = await self._compress(wire_history, budget - reserve)
            if compressed is not None:
                wire_history = compressed
                used = estimate_tokens(system) + sum(estimate_tokens(str(m.get("content") or "")) for m in wire_history)
                info.update({"compressed": True, "estimated_tokens": used, "history_messages": len(wire_history)})
        messages = [{"role": "system", "content": system}] + wire_history
        return messages, info

    async def _compress(self, history: List[Dict[str, Any]], budget: int) -> Optional[List[Dict[str, Any]]]:
        """Summarise the oldest part of the transcript to fit the context window."""
        keep = max(6, len(history) // 3)
        old, recent = history[:-keep], history[-keep:]
        if not old:
            return None
        transcript = "\n".join(
            f"{m.get('role', 'user').upper()}: {str(m.get('content') or '')[:2000]}" for m in old
        )
        try:
            result = await self.provider.complete(
                compression_prompt(transcript, str(self.settings.get("app.language", "ru"))),
                params={"max_tokens": 700, "temperature": 0.2},
            )
        except Exception:  # noqa: BLE001 - compression is best effort
            return None
        if not result.ok or not result.content.strip():
            return None
        self.summary_cache = result.content.strip()
        await self.emit("status", {"text": "History compressed to fit the context window", "detail": "compression"})
        return [{"role": "system", "content": f"## Summary of the earlier part of this conversation\n{self.summary_cache}"}] + recent

    # ------------------------------------------------------------------ #
    # streaming one completion
    # ------------------------------------------------------------------ #
    async def _completion(self, messages: List[Dict[str, Any]]) -> CompletionResult:
        params = self._params()
        tools = specs_for_prompt(self.specs) if (self.specs and self.protocol_mode == "native") else None
        result = CompletionResult(model=self.profile.get("model") or "")
        message_started = False
        finish_reason = ""
        last_error = ""
        retries = int(self.settings.get("agent.retry_on_error", 2) or 0)

        for attempt in range(retries + 1):
            if self.state.cancel_event.is_set():
                break
            try:
                async for chunk in self.provider.stream(messages, tools=tools, params=params):
                    if self.state.cancel_event.is_set():
                        break
                    if chunk.kind == "text":
                        if not message_started:
                            message_started = True
                            await self.emit("assistant.start", {"run_id": self.state.run_id})
                        result.content += chunk.text
                        await self.emit("token", {"text": chunk.text})
                    elif chunk.kind == "reasoning":
                        result.reasoning += chunk.text
                        if self.settings.get("agent.show_reasoning", True):
                            await self.emit("reasoning", {"text": chunk.text})
                    elif chunk.kind == "tool_calls":
                        result.tool_calls.extend(chunk.tool_calls)
                    elif chunk.kind == "usage":
                        for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
                            value = chunk.usage.get(key)
                            if value:
                                if key == "total_tokens":
                                    result.usage[key] = max(int(value), result.usage.get(key, 0))
                                else:
                                    result.usage[key] = int(value)
                    elif chunk.kind == "meta":
                        finish_reason = chunk.meta.get("finish_reason") or finish_reason
                    elif chunk.kind == "error":
                        last_error = chunk.error
                    elif chunk.kind == "done":
                        finish_reason = chunk.meta.get("finish_reason", finish_reason)
                if last_error and not result.content and not result.tool_calls:
                    raise ProviderError(last_error)
                break
            except ProviderError as exc:
                last_error = exc.message + (f" | Hint: {exc.hint}" if exc.hint else "")
                if attempt < retries and not self.state.cancel_event.is_set():
                    await self.emit("status", {"text": f"Retrying after error ({attempt + 1}/{retries}): {exc.message}"})
                    await asyncio.sleep(min(2 ** attempt, 6))
                    continue
                result.error = last_error
                result.meta_hint = exc.hint  # type: ignore[attr-defined]
                return result
            except Exception as exc:  # noqa: BLE001
                result.error = f"{type(exc).__name__}: {exc}"
                hub.emit("log", {"level": "error", "text": traceback.format_exc(limit=6)}, run_id=self.state.run_id)
                return result

        if self.protocol_mode != "native" or not result.tool_calls:
            visible, parsed_calls = protocol.parse_tool_calls(result.content)
            if parsed_calls:
                known = {spec.name for spec in self.specs}
                parsed_calls = [call for call in parsed_calls if call.tool in known] or parsed_calls
                result.tool_calls.extend(parsed_calls)
                result.content = visible
            if result.content:
                cleaned, reasoning = protocol.extract_thinking(result.content)
                if reasoning:
                    result.reasoning = (result.reasoning + "\n" + reasoning).strip()
                    result.content = cleaned
        result.finish_reason = finish_reason
        result.error = result.error or last_error if (not result.content and not result.tool_calls and last_error) else result.error
        self._account_usage(result.usage)
        return result

    def _account_usage(self, usage: Dict[str, Any]) -> None:
        self.state.prompt_tokens += int(usage.get("prompt_tokens") or 0)
        self.state.completion_tokens += int(usage.get("completion_tokens") or 0)
        if usage.get("total_tokens"):
            self.state.total_tokens += int(usage["total_tokens"])
        else:
            self.state.total_tokens += int(usage.get("prompt_tokens") or 0) + int(usage.get("completion_tokens") or 0)

    # ------------------------------------------------------------------ #
    # tool execution
    # ------------------------------------------------------------------ #
    def _tool_context(self) -> ToolContext:
        return ToolContext(
            settings=self.settings,
            safety=self.safety,
            store=self.store,
            session_id=self.session_id,
            workspace=self.safety.workspace_root,
            emit=self._tool_emit,
            approval_callback=self._interactive_callback,
            cancel_event=self.state.cancel_event,
            language=str(self.settings.get("app.language", "ru")),
            run_meta=self.state.public(),
        )

    async def _tool_emit(self, event_type: str, payload: Dict[str, Any]) -> None:
        await self.emit(event_type, payload)

    async def _interactive_callback(self, kind: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        call_id = payload.get("call_id") or uuid.uuid4().hex[:10]
        payload = {**payload, "call_id": call_id}
        return await self.manager.request(kind, self.state.run_id, self.session_id, payload,
                                          timeout=float(self.settings.get("security.confirm_timeout", 300) or 300))

    async def _execute_call(self, ctx: ToolContext, call: ToolCall, spec_map: Dict[str, ToolSpec]) -> Dict[str, Any]:
        spec = spec_map.get(call.tool)
        record: Dict[str, Any] = {
            "id": call.id or uuid.uuid4().hex[:10],
            "tool": call.tool,
            "args": call.args,
            "origin": call.origin,
            "started_at": time.time(),
        }
        await self.emit("tool.start", {**record, "status": "running"})

        if spec is None:
            available = ", ".join(sorted(spec_map))
            message = f"Unknown tool '{call.tool}'. Available tools: {available}."
            record.update({"ok": False, "output": message, "status": "error", "risk": "blocked"})
            await self.emit("tool.result", record)
            return record

        decision = self.safety.decide(
            call.tool,
            call.args,
            mode=self.mode,
            mode_auto_approve=bool(self.mode_data.get("auto_approve")),
            session_allow=self.manager.allowed_for(self.session_id),
        )
        record["risk"] = decision.risk
        record["reason"] = decision.reason

        if decision.blocked:
            message = f"BLOCKED by DAGENT safety policy: {decision.reason}"
            record.update({"ok": False, "output": message, "status": "blocked"})
            ctx.audit("blocked", f"{call.tool} {json.dumps(call.args, ensure_ascii=False)[:300]}", tool=call.tool,
                      approved=False, ok=False)
            await self.emit("tool.result", record)
            return record

        if decision.needs_approval:
            payload = {
                "call_id": record["id"],
                "tool": call.tool,
                "args": call.args,
                "risk": decision.risk,
                "reason": decision.reason,
                "description": spec.description,
                "preview": _preview_args(call.tool, call.args),
            }
            answer = await self.manager.request(
                "approval", self.state.run_id, self.session_id, payload,
                timeout=float(self.settings.get("security.confirm_timeout", 300) or 300),
            )
            approved = bool(answer.get("approved"))
            if answer.get("scope") in ("session_tool", "always"):
                self.manager.remember_choice(self.session_id, f"tool:{call.tool}")
            if answer.get("scope") == "session_command" and call.tool == "run_command":
                from .safety import _command_signature

                self.manager.remember_choice(self.session_id, f"cmd:{_command_signature(str(call.args.get('command') or ''))}")
            if answer.get("scope") == "session_folder" and call.tool in ("write_file", "edit_file"):
                import os

                path, _ = self.safety.resolve(str(call.args.get("path") or ""), for_write=True)
                if path:
                    self.manager.remember_choice(self.session_id, f"write:{os.path.dirname(path)}")
            ctx.audit("approval", f"{call.tool} {json.dumps(call.args, ensure_ascii=False)[:300]}", tool=call.tool,
                      approved=approved)
            if not approved:
                note = answer.get("note") or "The user rejected this action."
                message = f"DENIED by the user: {note} Do not retry the same call - adjust the plan or ask what to do instead."
                record.update({"ok": False, "output": message, "status": "denied"})
                await self.emit("tool.result", record)
                return record

        started = time.time()
        try:
            result: ToolResult = await asyncio.wait_for(
                spec.handler(ctx, call.args),
                timeout=float(self.settings.get("security.command_timeout", 120) or 120) + 30
                if call.tool in ("run_command", "python_run") else 180,
            )
        except asyncio.TimeoutError:
            result = ToolResult(ok=False, error="Tool timed out", output="Error: the tool exceeded its time limit")
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            result = ToolResult(ok=False, error=f"{type(exc).__name__}: {exc}",
                                output=f"Error while running {call.tool}: {exc}",
                                meta={"trace": traceback.format_exc(limit=4)})
        duration_ms = int((time.time() - started) * 1000)
        self.state.tools_used += 1
        record.update({
            "ok": result.ok,
            "output": result.output,
            "data": result.data,
            "render": result.render,
            "error": result.error,
            "status": "done" if result.ok else "error",
            "duration_ms": duration_ms,
        })
        await self.emit("tool.result", record)
        return record

    # ------------------------------------------------------------------ #
    # main entry
    # ------------------------------------------------------------------ #
    async def execute(self) -> None:
        state = self.state
        started = time.time()
        hub.emit("run.start", {
            "run": state.public(),
            "model": self.provider.describe(),
            "mode": self.mode,
            "protocol": self.protocol_mode,
            "tools": [spec.name for spec in self.specs],
        }, run_id=state.run_id, session_id=self.session_id)

        try:
            if self.regenerate_from:
                await self._truncate_for_regeneration()

            # 1) persist the user message (unless we are regenerating)
            if not self.regenerate_from and (self.text or self.attachments):
                user_message = self.store.add_message(
                    self.session_id,
                    "user",
                    self.text,
                    meta={"attachments": self.attachments, "mode": self.mode, "model_id": self.profile.get("id")},
                )
                self._user_message_id = user_message.get("id", "")
                hub.emit("message.saved", {"message": user_message}, run_id=state.run_id, session_id=self.session_id)
                if self.settings.get("agent.auto_title", True) and str(self.session.get("title") or "").strip() in ("", "New session", "Новая сессия"):
                    asyncio.get_event_loop().create_task(self._auto_title())

            spec_map = {spec.name: spec for spec in self.specs}
            stop_reason = "completed"

            while state.iterations < state.max_iterations:
                if state.cancel_event.is_set():
                    stop_reason = "stopped by user"
                    break
                state.iterations += 1
                messages, info = await self._build_messages()
                await self.emit("status", {
                    "text": f"Thinking (step {state.iterations}/{state.max_iterations})",
                    "iteration": state.iterations,
                    "tokens": info.get("estimated_tokens"),
                    "context": info.get("context_window"),
                    "compressed": info.get("compressed"),
                })
                await self.emit("context", info)

                result = await self._completion(messages)

                if state.cancel_event.is_set():
                    stop_reason = "stopped by user"
                    if result.content:
                        self._persist_assistant(result, partial=True)
                    break

                if result.error and not result.content and not result.tool_calls:
                    stop_reason = f"model error: {result.error}"
                    state.last_error = result.error
                    await self.emit("error", {"message": result.error, "hint": getattr(result, "meta_hint", "")})
                    break

                if not result.tool_calls:
                    text = protocol.strip_final_marker(result.content or "")
                    if not text.strip() and state.iterations > 1:
                        text = "Done." if str(self.settings.get("app.language")) == "en" else "Готово."
                    self._persist_assistant(result, final_text=text)
                    stop_reason = "final answer"
                    break

                # tool round
                self._persist_assistant(result)
                ctx = self._tool_context()
                tool_results: List[Dict[str, Any]] = []
                for call in result.tool_calls:
                    if state.cancel_event.is_set():
                        break
                    record = await self._execute_call(ctx, call, spec_map)
                    tool_results.append(record)
                await self._attach_tool_results(tool_results)
                if state.cancel_event.is_set():
                    stop_reason = "stopped by user"
                    break
                if result.finish_reason == "length":
                    await self.emit("status", {"text": "Model hit the max_tokens limit - continuing"})
            else:
                stop_reason = f"iteration limit ({state.max_iterations}) reached"
                await self.emit("status", {"text": stop_reason})

            state.stop_reason = stop_reason
            state.status = STOPPED if stop_reason == "stopped by user" else (ERROR if state.last_error else DONE)
        except asyncio.CancelledError:
            state.status = STOPPED
            state.stop_reason = "cancelled"
            await self.emit("status", {"text": "Run cancelled"})
        except Exception as exc:  # noqa: BLE001
            state.status = ERROR
            state.last_error = f"{type(exc).__name__}: {exc}"
            hub.emit("log", {"level": "error", "text": traceback.format_exc()}, run_id=state.run_id)
            await self.emit("error", {"message": state.last_error})
        finally:
            state.finished_at = time.time()
            self._touch_profile()
            stats = self.store.session_stats(self.session_id)
            stats["last_run_tokens"] = state.total_tokens
            self.store.update_session(self.session_id, stats=stats)
            session = self.store.get_session(self.session_id) or {}
            hub.emit("run.end", {
                "run": state.public(),
                "session": session,
                "stop_reason": state.stop_reason,
                "elapsed_ms": int((state.finished_at - started) * 1000),
            }, run_id=state.run_id, session_id=self.session_id)

    # ------------------------------------------------------------------ #
    # persistence helpers
    # ------------------------------------------------------------------ #
    def _touch_profile(self) -> None:
        """Remember that this model was used (shown in the model switcher)."""
        profile_id = str(self.profile.get("id") or "")
        if not profile_id:
            return
        try:
            current = self.settings.profile(profile_id)
            if not current:
                return
            updated = dict(current)
            updated["usage_count"] = int(current.get("usage_count") or 0) + 1
            updated["last_used"] = time.time()
            self.settings.save_profile(updated)
        except Exception:  # noqa: BLE001 - statistics must never break a run
            pass

    def _persist_assistant(self, result: CompletionResult, final_text: Optional[str] = None, partial: bool = False) -> Dict[str, Any]:
        text = final_text if final_text is not None else result.content
        meta: Dict[str, Any] = {
            "model_id": self.profile.get("id"),
            "model": self.profile.get("model") or self.profile.get("name"),
            "mode": self.mode,
            "usage": result.usage,
            "finish_reason": result.finish_reason,
            "reasoning": result.reasoning if self.settings.get("agent.show_reasoning", True) else "",
            "iteration": self.state.iterations,
            "run_id": self.state.run_id,
            "partial": partial,
            "latency_ms": result.latency_ms,
        }
        if result.tool_calls:
            meta["tool_calls"] = [
                {"id": call.id, "tool": call.tool, "args": call.args, "origin": call.origin}
                for call in result.tool_calls
            ]
        if result.error:
            meta["error"] = result.error
        message = self.store.add_message(self.session_id, "assistant", text or "", meta=meta)
        hub.emit("message.saved", {"message": message}, run_id=self.state.run_id, session_id=self.session_id)
        self._last_assistant_text = text or ""
        return message

    async def _attach_tool_results(self, records: List[Dict[str, Any]]) -> None:
        """Append tool results to the last assistant message (kept in its meta)."""
        messages = self.store.list_messages(self.session_id)
        if not messages:
            return
        last = messages[-1]
        if last.get("role") != "assistant":
            return
        slim = []
        for record in records:
            slim.append({
                "id": record.get("id"),
                "tool": record.get("tool"),
                "args": record.get("args"),
                "ok": record.get("ok"),
                "output": (record.get("output") or "")[:20000],
                "render": record.get("render"),
                "data": _slim_data(record.get("data") or {}),
                "status": record.get("status"),
                "duration_ms": record.get("duration_ms"),
                "risk": record.get("risk"),
                "error": record.get("error"),
            })
        meta = dict(last.get("meta") or {})
        meta["tool_results"] = (meta.get("tool_results") or []) + slim
        self.store.update_message(last["id"], meta=meta)
        hub.emit("message.updated", {"message": self.store.get_message(last["id"])},
                 run_id=self.state.run_id, session_id=self.session_id)

    async def _truncate_for_regeneration(self) -> None:
        messages = self.store.list_messages(self.session_id)
        target = None
        for message in reversed(messages):
            if message.get("id") == self.regenerate_from or message.get("role") == "assistant":
                target = message
                break
        if target:
            self.store.delete_messages_from(self.session_id, int(target.get("seq", 1)))
            hub.emit("session.truncated", {"seq": target.get("seq")}, run_id=self.state.run_id,
                     session_id=self.session_id)

    async def _auto_title(self) -> None:
        """Generate a short session title from the first user message."""
        text = self.text.strip()
        if not text:
            return
        fallback = text.split("\n")[0][:48].strip()
        try:
            result = await self.provider.complete(
                title_prompt(text, str(self.settings.get("app.language", "ru"))),
                params={"max_tokens": 24, "temperature": 0.3},
            )
            title = (result.content or "").strip().strip('".«»“”') if result.ok else ""
            title = title.split("\n")[0][:60].strip() or fallback
        except Exception:  # noqa: BLE001
            title = fallback
        if not title:
            title = fallback
        session = self.store.update_session(self.session_id, title=title)
        hub.emit("session.updated", {"session": session}, run_id=self.state.run_id, session_id=self.session_id)


def _slim_data(data: Dict[str, Any]) -> Dict[str, Any]:
    """Keep tool payloads small enough for the database and the UI."""
    slim: Dict[str, Any] = {}
    for key, value in data.items():
        if isinstance(value, str):
            slim[key] = value if len(value) <= 60000 else value[:60000] + "\n... [trimmed]"
        elif isinstance(value, (int, float, bool)) or value is None:
            slim[key] = value
        elif isinstance(value, list):
            slim[key] = value[:400]
        elif isinstance(value, dict):
            slim[key] = _slim_data(value)
        else:
            slim[key] = str(value)
    return slim


def _preview_args(tool: str, args: Dict[str, Any]) -> str:
    """Short human preview shown on the approval card."""
    if tool == "run_command":
        return str(args.get("command") or "")
    if tool == "python_run":
        code = str(args.get("code") or "")
        return code[:600]
    if tool in ("write_file", "edit_file"):
        path = str(args.get("path") or "")
        if tool == "edit_file":
            return f"{path}\n- {str(args.get('old_text') or '')[:300]}\n+ {str(args.get('new_text') or '')[:300]}"
        return f"{path}\n{str(args.get('content') or '')[:600]}"
    if tool == "delete_path":
        return str(args.get("path") or "")
    if tool == "web_fetch":
        return str(args.get("url") or "")
    return json.dumps(args, ensure_ascii=False)[:600]
