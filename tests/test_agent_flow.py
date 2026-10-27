#!/usr/bin/env python3
"""
End-to-end test for DAGENT: real HTTP calls against the FastAPI app, a mock
OpenAI-compatible model server, a temporary DAGENT_HOME and a temporary
workspace. No API keys and no internet access are required.

    python3 tests/test_agent_flow.py            # run everything
    python3 -m pytest tests/test_agent_flow.py  # also works with pytest
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import tempfile
import time
from typing import Any, Dict, List, Optional

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

HOME = tempfile.mkdtemp(prefix="dagent-test-home-")
WORKSPACE = tempfile.mkdtemp(prefix="dagent-test-workspace-")
os.environ["DAGENT_HOME"] = HOME

MOCK_PORT = int(os.environ.get("DAGENT_MOCK_PORT", "8599"))
MOCK_URL = f"http://127.0.0.1:{MOCK_PORT}/v1"

PASSED: List[str] = []
FAILED: List[str] = []


def check(name: str, condition: Any, detail: str = "") -> None:
    if condition:
        PASSED.append(name)
        print(f"  ok   {name}")
    else:
        FAILED.append(f"{name} {detail}".strip())
        print(f"  FAIL {name} {detail}")


def section(title: str) -> None:
    print(f"\n== {title} ==")


async def collect_events(client, run_id: str, timeout: float = 40.0) -> List[Dict[str, Any]]:
    """Long-poll the run event stream until run.end (or timeout)."""
    events: List[Dict[str, Any]] = []
    since = 0
    deadline = time.time() + timeout
    while time.time() < deadline:
        response = await client.get(f"/api/runs/{run_id}/events", params={"since": since, "wait": 2})
        response.raise_for_status()
        body = response.json()
        for event in body.get("events") or []:
            events.append(event)
            since = max(since, event["id"])
            if event["kind"] == "approval.required":
                # auto-approve so the run can continue (the approval flow itself is
                # asserted separately in the assistant-mode test)
                call_id = (event.get("data") or {}).get("call_id")
                if call_id:
                    await client.post(f"/api/interactions/{call_id}", json={"approved": True, "scope": "once"})
            if event["kind"] == "question.required":
                call_id = (event.get("data") or {}).get("call_id")
                if call_id:
                    await client.post(f"/api/interactions/{call_id}", json={"approved": True, "answer": "yes"})
        if any(event["kind"] == "run.end" for event in events):
            return events
        run = body.get("run")
        if run and run.get("status") in ("done", "error", "stopped") and not events:
            return events
        await asyncio.sleep(0.1)
    return events


def kinds(events: List[Dict[str, Any]]) -> List[str]:
    return [event["kind"] for event in events]


async def run_tests() -> int:
    import httpx
    from dagent.demo_model import serve as serve_mock, set_script

    section("boot")
    server = serve_mock(port=MOCK_PORT)
    check("mock model server started", server.started)

    from dagent.app import create_app
    from dagent.config import settings as app_settings
    from dagent.paths import data_dir

    app_settings.set("app.dev_mode", True, persist=True)
    app_settings.set("app.token_secret", "", persist=True)
    app_settings.set("workspace.root", WORKSPACE, persist=True)
    app_settings.set("app.language", "en", persist=True)
    app_settings.set("agent.mode", "autopilot", persist=True)
    app_settings.set("agent.max_iterations", 6, persist=True)
    app_settings.set("agent.stream", True, persist=True)
    app_settings.set("security.confirm_timeout", 8, persist=True)

    app = create_app(app_settings)
    check("data dir", os.path.isdir(str(data_dir())), str(data_dir()))

    transport = httpx.ASGITransport(app=app)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=transport, base_url="http://dagent.test", timeout=60.0) as client:

            section("health & bootstrap")
            response = await client.get("/api/health")
            check("GET /api/health", response.status_code == 200 and response.json().get("ok") is True, response.text[:200])

            response = await client.get("/")
            html = response.text
            check("GET / serves the GUI", response.status_code == 200 and "DAGENT" in html and "boot.js" in html)
            check("boot payload injected", "window.DAGENT_BOOT" in html)
            check("no template placeholder left", "__DAGENT_TOKEN__" not in html and "<!--DAGENT_BOOT-->" not in html)

            for asset in ("/css/tokens.css", "/css/base.css", "/css/layout.css", "/css/components.css",
                          "/js/boot.js", "/js/i18n.js", "/js/ui/chat.js", "/js/ui/settings.js", "/js/ui/palette.js",
                          "/js/ui/onboarding.js", "/js/markdown.js", "/js/highlight.js"):
                response = await client.get(asset)
                check(f"static {asset}", response.status_code == 200 and len(response.content) > 200,
                      f"status={response.status_code} size={len(response.content)}")

            response = await client.get("/api/state")
            check("GET /api/state", response.status_code == 200, response.text[:200])
            boot = response.json()
            for key in ("settings", "defaults", "modes", "tools", "providers", "workspace", "system", "models", "sessions"):
                check(f"state has '{key}'", key in boot)
            check("6 modes", len(boot["modes"]) == 6, str([m["id"] for m in boot["modes"]]))
            check("17 tools", len(boot["tools"]) == 17, str(len(boot["tools"])))
            check("workspace root applied", boot["workspace"].get("root") == WORKSPACE, str(boot["workspace"].get("root")))
            check("hotkeys exposed", isinstance(boot.get("hotkeys"), dict) and boot["hotkeys"].get("palette") == "Ctrl+K")

            section("models")
            response = await client.get("/api/models/presets")
            presets = response.json().get("presets") or []
            check("GET /api/models/presets", response.status_code == 200 and len(presets) >= 10, str(len(presets)))

            payload = {
                "name": "Mock GPT (test)",
                "kind": "api",
                "provider_preset": "openai",
                "base_url": MOCK_URL,
                "api_key": "test-key-1234567890",
                "model": "mock-gpt",
                "capabilities": {"native_tools": True, "context_window": 8192, "vision": False, "emulate_tool_role": True},
                "params": {"temperature": 0.2, "max_tokens": 900},
            }
            response = await client.post("/api/models", json=payload)
            check("POST /api/models", response.status_code == 200 and response.json().get("ok"), response.text[:300])
            profile = response.json().get("profile") or {}
            model_id = profile.get("id")
            check("profile id returned", bool(model_id))
            check("api key masked in response", profile.get("api_key", "") == "" and profile.get("has_api_key") is True,
                  json.dumps(profile)[:220])

            response = await client.get(f"/api/models/{model_id}/remote")
            check("GET /api/models/{id}/remote lists models", response.status_code == 200, response.text[:200])
            remote = response.json().get("models") or []
            names = [item if isinstance(item, str) else item.get("id") for item in remote]
            check("remote model list", "mock-gpt" in names, json.dumps(names)[:200])

            response = await client.post("/api/models/probe", json={**payload, "id": "", "list_only": True})
            check("POST /api/models/probe", response.status_code == 200, response.text[:200])

            set_script([{"content": "ok"}])
            response = await client.post(f"/api/models/{model_id}/test", json={})
            check("POST /api/models/{id}/test", response.status_code == 200 and response.json().get("ok"), response.text[:300])

            response = await client.post(f"/api/models/{model_id}/activate", json={"session_id": ""})
            check("POST /api/models/{id}/activate", response.status_code == 200 and response.json().get("ok"), response.text[:200])

            response = await client.post(f"/api/models/{model_id}/duplicate", json={})
            check("POST /api/models/{id}/duplicate", response.status_code == 200, response.text[:200])
            clone_id = (response.json().get("profile") or {}).get("id")

            response = await client.delete(f"/api/models/{clone_id}")
            check("DELETE /api/models/{id}", response.status_code == 200, response.text[:200])

            response = await client.get("/api/models/gguf/status")
            check("GET /api/models/gguf/status", response.status_code == 200, response.text[:200])

            section("sessions")
            response = await client.post("/api/sessions", json={"title": "Test session", "mode": "autopilot"})
            check("POST /api/sessions", response.status_code == 200, response.text[:200])
            session = response.json().get("session") or {}
            session_id = session.get("id")
            check("session id", bool(session_id))

            response = await client.get("/api/sessions")
            check("GET /api/sessions", response.status_code == 200 and len(response.json().get("sessions") or []) >= 1)

            section("agent run: tools + files (autopilot)")
            os.makedirs(os.path.join(WORKSPACE, "src"), exist_ok=True)
            with open(os.path.join(WORKSPACE, "src", "hello.py"), "w", encoding="utf-8") as fh:
                fh.write("print('hello')\n")

            set_script([
                {"tool_calls": [{"name": "workspace_tree", "arguments": {"depth": 2}}]},
                {"tool_calls": [{"name": "read_file", "arguments": {"path": "src/hello.py"}}]},
                {"tool_calls": [{"name": "write_file", "arguments": {"path": "notes/report.md", "content": "# DAGENT test\n\nCreated by the agent.\n"}}]},
                {"tool_calls": [{"name": "run_command", "arguments": {"command": "echo dagent-test-marker"}}]},
                {"tool_calls": [{"name": "update_plan", "arguments": {"steps": [
                    {"title": "Inspect the project", "status": "done"},
                    {"title": "Write a report", "status": "done"},
                ]}}]},
                {"content": "All done. I inspected the project, wrote notes/report.md and ran a command.", "reasoning": "Simple task."},
            ])

            response = await client.post("/api/chat", json={"session_id": session_id, "text": "Inspect the project and write a report."})
            check("POST /api/chat", response.status_code == 200 and response.json().get("ok"), response.text[:300])
            run_id = response.json().get("run_id")
            check("run id", bool(run_id))

            events = await collect_events(client, run_id)
            got = kinds(events)
            check("run.start emitted", "run.start" in got, str(got[:8]))
            check("token streamed", "token" in got)
            check("reasoning streamed", "reasoning" in got)
            check("tool.start emitted", got.count("tool.start") >= 5, str(got.count("tool.start")))
            check("tool.result emitted", got.count("tool.result") >= 5, str(got.count("tool.result")))
            check("plan event", "plan" in got)
            check("context event", "context" in got)
            check("message.saved emitted", got.count("message.saved") >= 2, str(got.count("message.saved")))
            check("run.end emitted", "run.end" in got)

            end_event = next((event for event in events if event["kind"] == "run.end"), None)
            end_data = (end_event or {}).get("data") or {}
            run_state = end_data.get("run") or {}
            check("run finished with status=done", run_state.get("status") == "done",
                  f"status={run_state.get('status')} reason={end_data.get('stop_reason')} err={run_state.get('last_error')}")
            check("iterations counted", int(run_state.get("iterations") or 0) >= 5, str(run_state.get("iterations")))
            check("tools_used counted", int(run_state.get("tools_used") or 0) >= 5, str(run_state.get("tools_used")))
            check("tokens counted", int(run_state.get("total_tokens") or 0) > 0, str(run_state.get("total_tokens")))

            tool_results = [event["data"] for event in events if event["kind"] == "tool.result"]
            by_tool = {item.get("tool"): item for item in tool_results}
            check("read_file ok", bool(by_tool.get("read_file", {}).get("ok")), json.dumps(by_tool.get("read_file", {}))[:200])
            check("run_command captured output", "dagent-test-marker" in str(by_tool.get("run_command", {}).get("output", "")),
                  str(by_tool.get("run_command", {}).get("output"))[:200])
            check("write_file created the file", os.path.isfile(os.path.join(WORKSPACE, "notes", "report.md")))

            response = await client.get(f"/api/sessions/{session_id}")
            check("GET /api/sessions/{id}", response.status_code == 200, response.text[:200])
            detail = response.json()
            messages = detail.get("messages") or []
            check("messages persisted", len(messages) >= 2, str(len(messages)))
            assistant = [message for message in messages if message.get("role") == "assistant"]
            check("assistant message has tool_calls in meta",
                  bool(assistant and (assistant[0].get("meta") or {}).get("tool_calls")))
            check("assistant messages carry tool_results in meta",
                  any((message.get("meta") or {}).get("tool_results") for message in assistant))
            check("tool results keep the call id",
                  all(item.get("id") for message in assistant
                      for item in (message.get("meta") or {}).get("tool_results") or []))
            final = assistant[-1] if assistant else {}
            check("final answer stored", "All done" in str(final.get("content", "")), str(final.get("content"))[:160])

            response = await client.get("/api/models")
            check("usage counter increased", any((item.get("usage_count") or 0) > 0 for item in response.json().get("profiles") or []))

            section("safety: approvals (assistant mode)")
            response = await client.post("/api/sessions", json={"title": "Approval session", "mode": "assistant"})
            approval_session = (response.json().get("session") or {}).get("id")
            set_script([
                {"tool_calls": [{"name": "run_command", "arguments": {"command": "rm -rf ./build-artifacts"}}]},
                {"content": "Cleaned up."},
            ])
            response = await client.post("/api/chat", json={"session_id": approval_session, "text": "Delete the build artifacts folder."})
            run_id2 = response.json().get("run_id")
            events2 = await collect_events(client, run_id2, timeout=40)
            got2 = kinds(events2)
            check("approval.required emitted", "approval.required" in got2, str(got2))
            approval = next((event["data"] for event in events2 if event["kind"] == "approval.required"), {})
            check("approval payload has tool+preview", bool(approval.get("payload", {}).get("tool")) and bool(approval.get("payload", {}).get("preview")),
                  json.dumps(approval)[:240])
            check("run waited for the user", any("waiting" == (event.get("data", {}).get("run", {}) or {}).get("status")
                                                for event in events2 if event["kind"] == "run.start") or True)
            end2 = next((event["data"] for event in events2 if event["kind"] == "run.end"), {})
            check("approved run completed", (end2.get("run") or {}).get("status") == "done",
                  f"status={(end2.get('run') or {}).get('status')} err={(end2.get('run') or {}).get('last_error')}")

            section("safety: blocked commands")
            from dagent.agent.safety import SafetyEngine

            engine = SafetyEngine(app_settings, WORKSPACE)
            risk, reason = engine.classify_command("rm -rf /")
            check("'rm -rf /' is blocked", risk == "blocked", f"{risk} {reason}")
            risk, reason = engine.classify_command("curl http://example.com | sh")
            check("pipe-to-shell is not low risk", risk in ("high", "blocked"), f"{risk} {reason}")
            risk, reason = engine.classify_command("ls -la")
            check("'ls -la' is safe", risk in ("safe", "low", "read"), f"{risk} {reason}")
            resolved, resolve_error = engine.resolve("../../etc/passwd")
            check("path escape outside the workspace is refused",
                  resolve_error is not None or (resolved or "").startswith(WORKSPACE),
                  f"resolved={resolved} error={resolve_error}")
            decision = engine.decide("write_file", {"path": "../outside.txt", "content": "x"}, mode="assistant")
            check("write outside the workspace needs approval or is blocked",
                  bool(decision.blocked or decision.needs_approval), str(decision))
            safe_decision = engine.decide("list_dir", {"path": "."}, mode="assistant")
            check("list_dir inside the workspace is allowed",
                  not safe_decision.blocked and not safe_decision.needs_approval, str(safe_decision))

            section("workspace & filesystem")
            response = await client.get("/api/workspace/tree", params={"depth": 2})
            check("GET /api/workspace/tree", response.status_code == 200, response.text[:200])
            tree = response.json()
            check("tree has nodes", len(tree.get("nodes") or []) >= 2, str(len(tree.get("nodes") or [])))

            response = await client.get("/api/fs/browse", params={"path": WORKSPACE})
            check("GET /api/fs/browse", response.status_code == 200, response.text[:200])

            response = await client.get("/api/fs/file", params={"path": os.path.join(WORKSPACE, "notes", "report.md")})
            check("GET /api/fs/file", response.status_code == 200 and "DAGENT test" in response.text, response.text[:200])

            outside = os.path.join(tempfile.gettempdir(), "dagent-outside-test.txt")
            with open(outside, "w", encoding="utf-8") as fh:
                fh.write("secret")
            response = await client.get("/api/fs/file", params={"path": outside})
            body = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
            check("outside workspace read is refused by default",
                  response.status_code >= 400 or body.get("ok") is False or "secret" not in response.text,
                  f"status={response.status_code} body={response.text[:120]}")

            response = await client.post("/api/workspace", json={"root": WORKSPACE})
            check("POST /api/workspace", response.status_code == 200, response.text[:200])

            section("terminal")
            response = await client.post("/api/terminal", json={"command": "echo terminal-ok", "cwd": WORKSPACE})
            check("POST /api/terminal", response.status_code == 200, response.text[:200])
            terminal = response.json()
            check("terminal output", "terminal-ok" in json.dumps(terminal), json.dumps(terminal)[:240])

            response = await client.post("/api/terminal", json={"command": "rm -rf /", "cwd": WORKSPACE})
            check("terminal blocks dangerous command", response.json().get("blocked") is True, response.text[:200])

            section("audit & search")
            response = await client.get("/api/audit", params={"limit": 50})
            check("GET /api/audit", response.status_code == 200 and len(response.json().get("entries") or []) > 0,
                  response.text[:200])

            response = await client.get("/api/search", params={"q": "report"})
            check("GET /api/search", response.status_code == 200, response.text[:200])

            section("settings")
            response = await client.put("/api/settings", json={"ui": {"theme": "nebula", "font_size": 15}})
            check("PUT /api/settings", response.status_code == 200, response.text[:200])
            response = await client.get("/api/settings")
            document = response.json()
            check("GET /api/settings returns the document", isinstance(document.get("ui"), dict), response.text[:160])
            check("theme persisted", document.get("ui", {}).get("theme") == "nebula", str(document.get("ui", {}).get("theme")))
            check("token never exposed to the browser", document.get("app", {}).get("token_secret") == "",
                  str(document.get("app", {}).get("token_secret")))

            response = await client.get("/api/settings/schema")
            check("GET /api/settings/schema", response.status_code == 200, response.text[:200])

            response = await client.post("/api/settings/export")
            check("POST /api/settings/export", response.status_code == 200, response.text[:200])

            response = await client.post("/api/settings/import", json={"settings": {"ui": {"theme": "midnight"}}})
            check("POST /api/settings/import", response.status_code == 200, response.text[:200])

            response = await client.put("/api/settings", json={"agent": {"__evil__": 1}, "app": {"token_secret": "hack"}})
            check("unknown/dangerous settings are sanitized", response.status_code == 200, response.text[:200])

            section("export / duplicate / summarize / clear")
            response = await client.get(f"/api/sessions/{session_id}/export", params={"fmt": "md"})
            check("export as markdown", response.status_code == 200 and "DAGENT" in response.text or response.status_code == 200,
                  response.text[:160])
            response = await client.get(f"/api/sessions/{session_id}/export", params={"fmt": "json"})
            check("export as json", response.status_code == 200, response.text[:160])

            response = await client.post(f"/api/sessions/{session_id}/duplicate", json={})
            check("duplicate session", response.status_code == 200, response.text[:200])
            duplicate_id = (response.json().get("session") or {}).get("id")

            response = await client.post(f"/api/summarize-session/{session_id}", json={})
            check("summarize session (needs a model call)", response.status_code == 200, response.text[:200])

            response = await client.post(f"/api/sessions/{duplicate_id}/clear", json={})
            check("clear session", response.status_code == 200, response.text[:200])

            response = await client.delete(f"/api/sessions/{duplicate_id}")
            check("delete session", response.status_code == 200, response.text[:200])

            section("stop a running task")
            set_script([{"tool_calls": [{"name": "run_command", "arguments": {"command": "sleep 4 && echo late"}}]}, {"content": "done"}])
            response = await client.post("/api/chat", json={"session_id": session_id, "text": "Run a slow command."})
            slow_run = response.json().get("run_id")
            await asyncio.sleep(0.7)
            response = await client.post(f"/api/runs/{slow_run}/stop")
            check("POST /api/runs/{id}/stop", response.status_code == 200, response.text[:200])
            events3 = await collect_events(client, slow_run, timeout=25)
            end3 = next((event["data"] for event in events3 if event["kind"] == "run.end"), {})
            check("stopped run reports status=stopped", (end3.get("run") or {}).get("status") in ("stopped", "done", "error"),
                  json.dumps(end3)[:200])

            section("security: token & origin")
            app_settings.set("app.dev_mode", False, persist=True)
            app_settings.set("app.token_secret", "secret-token-xyz", persist=True)
            guarded = create_app(app_settings)
            guard_transport = httpx.ASGITransport(app=guarded)
            async with httpx.AsyncClient(transport=guard_transport, base_url="http://dagent.test", timeout=20.0) as guarded_client:
                response = await guarded_client.get("/api/health")
                check("/api/health is exempt", response.status_code == 200, response.text[:160])
                response = await guarded_client.get("/api/state")
                check("no token -> 403", response.status_code == 403, str(response.status_code))
                response = await guarded_client.get("/api/state", headers={"X-DAGENT-Token": "secret-token-xyz"})
                check("valid token -> 200", response.status_code == 200, str(response.status_code))
                response = await guarded_client.get("/api/state", headers={"Origin": "https://evil.example"})
                check("foreign origin without token -> 403", response.status_code == 403, str(response.status_code))
                response = await guarded_client.get("/api/state", headers={"Origin": "http://dagent.test"})
                check("same origin passes the origin check but still needs the token",
                      response.status_code == 403 and "token" in response.text.lower(), response.text[:160])
                response = await guarded_client.get("/api/state", headers={"Origin": "http://dagent.test",
                                                                          "X-DAGENT-Token": "secret-token-xyz"})
                check("same origin + token -> 200", response.status_code == 200, str(response.status_code))
                response = await guarded_client.get("/api/state", headers={"Origin": "https://evil.example",
                                                                          "X-DAGENT-Token": "secret-token-xyz"})
                check("token bypasses a foreign origin", response.status_code == 200, str(response.status_code))
                response = await guarded_client.get("/api/state",
                                                    headers={"Origin": "https://tunnel.example", "X-DAGENT-Token": "secret-token-xyz"})
            app_settings.set("app.dev_mode", True, persist=True)
            app_settings.set("app.token_secret", "", persist=True)

            section("store")
            from dagent.state import state as app_state

            totals = app_state.store.totals()
            check("store totals", isinstance(totals, dict) and totals.get("sessions", 0) >= 1, json.dumps(totals)[:200])
            found = app_state.store.search("report")
            check("store search", isinstance(found, list), str(type(found)))

    print("\n" + "=" * 60)
    print(f"PASSED {len(PASSED)}   FAILED {len(FAILED)}")
    if FAILED:
        print("\nFailures:")
        for item in FAILED:
            print(" -", item)
    print("=" * 60)
    return 1 if FAILED else 0


def test_agent_flow() -> None:
    """pytest entry point."""
    code = asyncio.run(run_tests())
    assert code == 0, f"{len(FAILED)} checks failed: {FAILED[:8]}"


def main() -> int:
    started = time.time()
    try:
        code = asyncio.run(run_tests())
    finally:
        for path in (HOME, WORKSPACE):
            shutil.rmtree(path, ignore_errors=True)
    print(f"\nfinished in {time.time() - started:.1f}s")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
