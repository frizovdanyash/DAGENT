#!/usr/bin/env python3
"""
Record real API payloads into tests/fixtures/*.json.

The front-end harness (tests/test_frontend.mjs) replays these fixtures through a
stubbed fetch/WebSocket, so the browser code is exercised against the exact
shapes the Python backend produces - no browser and no model required.

    python3 tests/capture_fixtures.py
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import tempfile
import time
from typing import Any, Dict, List

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESTS = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(TESTS, "fixtures")
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

HOME = tempfile.mkdtemp(prefix="dagent-fixtures-home-")
WORKSPACE = tempfile.mkdtemp(prefix="dagent-fixtures-ws-")
os.environ["DAGENT_HOME"] = HOME
MOCK_PORT = int(os.environ.get("DAGENT_MOCK_PORT", "8601"))


FAKE_WORKSPACE = "/home/demo/DAGENTWorkspace"
FAKE_HOME = "/home/demo/.dagent"


def _clean(text: str) -> str:
    """Temp dirs must not leak into the committed fixtures."""
    return text.replace(WORKSPACE, FAKE_WORKSPACE).replace(HOME, FAKE_HOME)


def dump(name: str, payload: Any) -> None:
    os.makedirs(FIXTURES, exist_ok=True)
    target = os.path.join(FIXTURES, name)
    if isinstance(payload, str):
        text = _clean(payload)
    else:
        text = _clean(json.dumps(payload, ensure_ascii=False, indent=1))
    with open(target, "w", encoding="utf-8") as fh:
        fh.write(text)
    print(f"  wrote {name} ({os.path.getsize(target) / 1024:.1f} KB)")


async def main() -> int:
    import httpx
    from dagent.demo_model import serve as serve_mock, set_script

    server = serve_mock(port=MOCK_PORT)
    print(f"mock model on :{MOCK_PORT} (started={server.started})")

    from dagent.app import create_app
    from dagent.config import settings as app_settings

    app_settings.set("app.dev_mode", True, persist=True)
    app_settings.set("app.token_secret", "", persist=True)
    app_settings.set("app.language", "ru", persist=True)
    app_settings.set("app.first_run_done", True, persist=True)
    app_settings.set("workspace.root", WORKSPACE, persist=True)
    app_settings.set("agent.mode", "assistant", persist=True)
    app_settings.set("ui.theme", "midnight", persist=True)

    # a realistic little project for the workspace tree / file previews
    os.makedirs(os.path.join(WORKSPACE, "src"), exist_ok=True)
    os.makedirs(os.path.join(WORKSPACE, "docs"), exist_ok=True)
    with open(os.path.join(WORKSPACE, "src", "main.py"), "w", encoding="utf-8") as fh:
        fh.write("def main() -> None:\n    print('DAGENT demo project')\n\n\nif __name__ == '__main__':\n    main()\n")
    with open(os.path.join(WORKSPACE, "docs", "notes.md"), "w", encoding="utf-8") as fh:
        fh.write("# Notes\n\n- first\n- second\n")
    with open(os.path.join(WORKSPACE, "README.md"), "w", encoding="utf-8") as fh:
        fh.write("# Demo\n\nSample workspace used by the DAGENT fixtures.\n")

    app = create_app(app_settings)
    transport = httpx.ASGITransport(app=app)

    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8420", timeout=60.0) as client:
            # --- model profile -------------------------------------------------
            profile_payload = {
                "name": "Demo GPT-4o mini",
                "kind": "api",
                "provider_preset": "openai",
                "base_url": f"http://127.0.0.1:{MOCK_PORT}/v1",
                "api_key": "sk-demo-0123456789abcdef",
                "model": "mock-gpt",
                "capabilities": {"native_tools": True, "context_window": 8192, "vision": False, "emulate_tool_role": True},
                "params": {"temperature": 0.4, "max_tokens": 1200},
                "notes": "Fixture profile used by the front-end test harness.",
            }
            response = await client.post("/api/models", json=profile_payload)
            profile = response.json()["profile"]
            await client.post(f"/api/models/{profile['id']}/activate", json={"session_id": ""})

            local_profile = {
                "name": "LM Studio (local)",
                "kind": "api",
                "provider_preset": "lmstudio",
                "base_url": "http://localhost:1234/v1",
                "model": "qwen2.5-coder-7b-instruct",
                "capabilities": {"native_tools": True, "context_window": 32768, "emulate_tool_role": True},
                "enabled": False,
                "activate": False,
            }
            await client.post("/api/models", json=local_profile)
            await client.post(f"/api/models/{profile['id']}/activate", json={"session_id": ""})

            dump("models.json", (await client.get("/api/models")).json())
            dump("modes.json", (await client.get("/api/modes")).json())
            dump("settings.json", (await client.get("/api/settings")).json())
            dump("workspace.json", (await client.get("/api/workspace")).json())
            dump("tree.json", (await client.get("/api/workspace/tree", params={"depth": 3})).json())

            # --- a real agent run ---------------------------------------------
            set_script([
                {"reasoning": "Сначала посмотрю, что лежит в проекте.",
                 "tool_calls": [{"name": "workspace_tree", "arguments": {"depth": 2}}]},
                {"tool_calls": [{"name": "read_file", "arguments": {"path": "src/main.py"}}]},
                {"tool_calls": [{"name": "update_plan", "arguments": {"steps": [
                    {"title": "Изучить структуру проекта", "status": "done"},
                    {"title": "Прочитать src/main.py", "status": "done"},
                    {"title": "Запустить скрипт и проверить вывод", "status": "in_progress"},
                    {"title": "Написать отчёт docs/report.md", "status": "pending"},
                ]}}]},
                {"tool_calls": [{"name": "run_command", "arguments": {"command": "python3 src/main.py"}}]},
                {"tool_calls": [{"name": "write_file", "arguments": {
                    "path": "docs/report.md",
                    "content": "# Отчёт DAGENT\n\n## Структура\n\n- `src/main.py` - точка входа\n- `docs/notes.md` - заметки\n\n## Проверка\n\n```bash\n$ python3 src/main.py\nDAGENT demo project\n```\n\nВсё работает.\n"}}]},
                {"tool_calls": [{"name": "edit_file", "arguments": {
                    "path": "README.md",
                    "old_text": "# Demo",
                    "new_text": "# Demo (проверено DAGENT)"}}]},
                {"content": "Готово! Я изучил проект, запустил `src/main.py`, записал отчёт в `docs/report.md` "
                            "и обновил заголовок README.\n\n### Что сделано\n\n1. Прочитал структуру\n2. Запустил скрипт\n"
                            "3. Создал `docs/report.md`\n4. Поправил `README.md`\n\n```python\nprint('DAGENT demo project')\n```"},
            ])

            response = await client.post("/api/sessions", json={"title": "Анализ проекта", "mode": "assistant"})
            session_id = response.json()["session"]["id"]
            response = await client.post("/api/chat", json={
                "session_id": session_id,
                "text": "Изучи проект, запусти main.py и напиши короткий отчёт в docs/report.md",
            })
            run_id = response.json()["run_id"]

            events: List[Dict[str, Any]] = []
            since = 0
            deadline = time.time() + 60
            while time.time() < deadline:
                body = (await client.get(f"/api/runs/{run_id}/events", params={"since": since, "wait": 2})).json()
                for event in body.get("events") or []:
                    events.append(event)
                    since = max(since, event["id"])
                    if event["kind"] == "approval.required":
                        await client.post(f"/api/interactions/{event['data']['call_id']}",
                                          json={"approved": True, "scope": "once", "note": ""})
                if any(event["kind"] == "run.end" for event in events):
                    break
                await asyncio.sleep(0.05)

            # renumber so the harness can replay them from zero
            for index, event in enumerate(events, start=1):
                event["id"] = index
            dump("events.json", {"run_id": run_id, "session_id": session_id, "events": events})

            dump("session.json", (await client.get(f"/api/sessions/{session_id}")).json())
            dump("sessions.json", (await client.get("/api/sessions")).json())
            dump("audit.json", (await client.get("/api/audit", params={"limit": 60})).json())
            dump("runs.json", (await client.get("/api/runs")).json())
            dump("state.json", (await client.get("/api/state")).json())
            dump("file.json", (await client.get("/api/fs/file", params={"path": os.path.join(WORKSPACE, "src", "main.py")})).json())
            dump("browse.json", (await client.get("/api/fs/browse", params={"path": WORKSPACE})).json())
            dump("terminal.json", (await client.post("/api/terminal", json={"command": "echo fixture-terminal", "cwd": WORKSPACE})).json())
            dump("export.md.txt", (await client.get(f"/api/sessions/{session_id}/export", params={"fmt": "md"})).text)

    print("\nfixtures written to", FIXTURES)
    shutil.rmtree(HOME, ignore_errors=True)
    shutil.rmtree(WORKSPACE, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
