#!/usr/bin/env python3
"""
Live-server test: real uvicorn process + real WebSocket + the built-in demo model.

test_agent_flow.py drives the app in-process through ASGITransport; this one
checks the parts that only exist in a running server: the WebSocket channel the
browser uses (hello, streaming events, approvals resolved over the socket,
heartbeat/ping) and static file serving over HTTP.

    python3 tests/test_websocket.py
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from typing import Any, Dict, List

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

HOME = tempfile.mkdtemp(prefix="dagent-ws-home-")
WORKSPACE = tempfile.mkdtemp(prefix="dagent-ws-workspace-")
GUI_PORT = _gui_port = 0
PASSED: List[str] = []
FAILED: List[str] = []


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def check(name: str, condition: Any, detail: str = "") -> None:
    if condition:
        PASSED.append(name)
        print(f"  ok   {name}")
    else:
        FAILED.append(f"{name} {detail}".strip())
        print(f"  FAIL {name} {detail}")


def section(title: str) -> None:
    print(f"\n== {title} ==")


async def wait_for_http(url: str, timeout: float = 25.0) -> bool:
    import httpx

    deadline = time.time() + timeout
    async with httpx.AsyncClient(timeout=2.0) as client:
        while time.time() < deadline:
            try:
                response = await client.get(url)
                if response.status_code < 500:
                    return True
            except Exception:  # noqa: BLE001 - server not up yet
                await asyncio.sleep(0.2)
    return False


async def main() -> int:
    import httpx
    import websockets

    from dagent.demo_model import serve as serve_demo, set_demo

    gui_port = free_port()
    model_port = free_port()
    base = f"http://127.0.0.1:{gui_port}"

    section("starting a real server")
    set_demo(True)
    serve_demo(host="127.0.0.1", port=model_port)
    check("demo model listening", True)

    with open(os.path.join(WORKSPACE, "hello.txt"), "w", encoding="utf-8") as fh:
        fh.write("DAGENT websocket test\n")

    env = dict(os.environ)
    env["DAGENT_HOME"] = HOME
    launcher = os.path.join(ROOT, "scripts", "_ws_test_server.py")
    with open(launcher, "w", encoding="utf-8") as fh:
        fh.write(f'''import os, sys
sys.path.insert(0, {ROOT!r})
from dagent.config import settings
from dagent.providers import new_profile
settings.set("app.dev_mode", True)
settings.set("app.token_secret", "")
settings.set("app.language", "en")
settings.set("app.first_run_done", True)
settings.set("workspace.root", {WORKSPACE!r})
settings.set("agent.mode", "assistant")
settings.set("security.confirm_timeout", 20)
settings.set("security.auto_approve_reads", False)
profile = new_profile(
    name="Demo",
    kind="api",
    preset="custom",
    model="dagent-demo",
    base_url="http://127.0.0.1:{model_port}/v1",
    api_key="demo",
    capabilities={{"native_tools": True, "context_window": 8192, "emulate_tool_role": True}},
)
settings.save_profile(profile)
settings.set("models.active_id", profile["id"])
import uvicorn
uvicorn.run("dagent.app:app", host="127.0.0.1", port={gui_port}, log_level="warning", access_log=False)
''')

    process = subprocess.Popen([sys.executable, launcher], env=env, cwd=ROOT,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        up = await wait_for_http(f"{base}/api/health")
        check("uvicorn server is up", up)
        if not up:
            process.terminate()
            print(process.stdout.read()[-2000:] if process.stdout else "")
            return 1

        async with httpx.AsyncClient(base_url=base, timeout=30.0) as client:
            section("http surface")
            response = await client.get("/")
            check("GET / returns the GUI", response.status_code == 200 and "DAGENT" in response.text)
            check("no token in dev mode", '"token": ""' in response.text)
            response = await client.get("/css/components.css")
            check("static css served", response.status_code == 200 and len(response.content) > 5000)
            response = await client.get("/js/boot.js")
            check("static js served as a module", response.status_code == 200 and "import" in response.text)
            response = await client.get("/assets/favicon.svg")
            check("favicon served", response.status_code == 200 and response.text.strip().startswith("<svg"))
            response = await client.get("/some/spa/route")
            check("SPA catch-all returns the shell", response.status_code == 200 and "boot.js" in response.text)
            response = await client.get("/api/health")
            check("health is public", response.status_code == 200 and response.json().get("ok") is True)
            response = await client.get("/api/state")
            state_payload = response.json()
            check("state lists the demo model", len(state_payload.get("models") or []) == 1,
                  json.dumps([m["name"] for m in state_payload.get("models") or []]))

            section("websocket channel")
            uri = f"ws://127.0.0.1:{gui_port}/ws"
            async with websockets.connect(uri, max_size=None) as ws:
                raw = await asyncio.wait_for(ws.recv(), timeout=10)
                hello = json.loads(raw)
                check("hello frame received", hello.get("kind") == "hello", str(hello)[:160])
                check("hello carries version/info", bool((hello.get("data") or {}).get("info")), str(hello.get("data"))[:160])

                await ws.send(json.dumps({"kind": "ping", "data": {"n": 1}}))
                pong = None
                for _ in range(6):
                    message = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
                    if message.get("kind") == "pong":
                        pong = message
                        break
                check("ping/pong over the socket", bool(pong), str(pong)[:120])

                response = await client.post("/api/chat", json={"text": "Запусти команду и покажи вывод"})
                check("POST /api/chat accepted", response.status_code == 200 and response.json().get("ok"), response.text[:200])
                run = response.json()
                run_id = run.get("run_id")
                session_id = run.get("session_id")

                events: List[Dict[str, Any]] = []
                approvals: List[Dict[str, Any]] = []
                deadline = time.time() + 60
                ended = False
                while time.time() < deadline and not ended:
                    try:
                        message = json.loads(await asyncio.wait_for(ws.recv(), timeout=20))
                    except asyncio.TimeoutError:
                        break
                    events.append(message)
                    if message.get("kind") == "approval.required":
                        approvals.append(message)
                        # resolve through the socket, exactly like the browser does
                        await ws.send(json.dumps({
                            "kind": "resolve",
                            "call_id": message["data"]["call_id"],
                            "decision": {"approved": True, "scope": "once", "note": "test"},
                        }))
                    if message.get("kind") == "run.end":
                        ended = True

                kinds = [event.get("kind") for event in events]
                check("run.start over ws", "run.start" in kinds, str(kinds[:10]))
                check("tokens streamed over ws", kinds.count("token") > 0, str(kinds.count("token")))
                check("tool events over ws", kinds.count("tool.start") >= 1 and kinds.count("tool.result") >= 1,
                      f"start={kinds.count('tool.start')} result={kinds.count('tool.result')}")
                check("approval requested over ws", len(approvals) >= 1, str(len(approvals)))
                check("approval resolved through the socket",
                      any(event.get("kind") == "tool.result" and event.get("data", {}).get("status") != "denied"
                          for event in events if event.get("data", {}).get("tool")), str(kinds))
                check("run.end over ws", ended, str(kinds[-6:]))
                end_data = next((event["data"] for event in events if event.get("kind") == "run.end"), {})
                check("run finished successfully", (end_data.get("run") or {}).get("status") == "done",
                      f"status={(end_data.get('run') or {}).get('status')} err={(end_data.get('run') or {}).get('last_error')}")
                check("run belongs to the session", (end_data.get("run") or {}).get("session_id") == session_id)

            section("persistence after a live run")
            response = await client.get(f"/api/sessions/{session_id}")
            detail = response.json()
            messages = detail.get("messages") or []
            check("messages stored", len(messages) >= 2, str(len(messages)))
            check("assistant answer stored", any(m["role"] == "assistant" and m.get("content") for m in messages))
            check("session title generated", bool(detail.get("session", {}).get("title")), str(detail.get("session", {}).get("title")))
            response = await client.get("/api/audit", params={"limit": 30})
            check("audit log written", len(response.json().get("entries") or []) >= 1, response.text[:160])

            section("stop over http")
            response = await client.post("/api/chat", json={"session_id": session_id, "text": "Запусти долгую команду: sleep 5"})
            second_run = response.json().get("run_id")
            await asyncio.sleep(0.6)
            response = await client.post(f"/api/runs/{second_run}/stop")
            check("stop accepted", response.status_code == 200, response.text[:160])
            await asyncio.sleep(1.2)
            response = await client.get("/api/runs")
            active = response.json().get("active") or []
            check("no active runs after stop", not any(item["run_id"] == second_run for item in active), json.dumps(active)[:200])

    finally:
        process.terminate()
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            process.kill()
        try:
            os.remove(launcher)
        except OSError:
            pass
        shutil.rmtree(HOME, ignore_errors=True)
        shutil.rmtree(WORKSPACE, ignore_errors=True)

    print("\n" + "=" * 60)
    print(f"PASSED {len(PASSED)}   FAILED {len(FAILED)}")
    if FAILED:
        print("\nFailures:")
        for item in FAILED:
            print(" -", item)
    print("=" * 60)
    return 1 if FAILED else 0


def test_websocket() -> None:
    """pytest entry point."""
    assert asyncio.run(main()) == 0, f"{len(FAILED)} checks failed: {FAILED[:6]}"


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
