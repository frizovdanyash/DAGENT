"""WebSocket endpoint - the real-time channel between the agent and the GUI."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..events import hub
from ..state import state

router = APIRouter()


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    token = websocket.query_params.get("token") or websocket.headers.get("x-dagent-token") or ""
    expected = str(state.settings.get("app.token_secret") or "")
    if expected and token != expected:
        await websocket.close(code=4401)
        return

    await websocket.accept()
    queue = await hub.subscribe()
    hub.bind_loop(asyncio.get_running_loop())
    beat: Optional[asyncio.Task] = None
    read_task: Optional[asyncio.Task] = None

    async def send(payload: Dict[str, Any]) -> None:
        try:
            await websocket.send_text(json.dumps(payload, ensure_ascii=False, default=str))
        except Exception:  # noqa: BLE001 - the client is gone
            raise WebSocketDisconnect()

    try:
        await send({
            "kind": "hello",
            "data": {
                "version": state.info().get("version", ""),
                "info": state.info(),
                "pending": [request.public() for request in state.runs.pending.values()],
                "active_runs": [run.public() for run in state.runs.runs.values() if run.status in ("running", "waiting")],
                "recent_events": hub.recent(30),
            },
        })

        async def heartbeat() -> None:
            while True:
                await asyncio.sleep(20)
                await send({"kind": "ping", "data": {"ts": asyncio.get_event_loop().time()}})

        beat = asyncio.create_task(heartbeat())

        async def reader() -> None:
            while True:
                raw = await websocket.receive_text()
                try:
                    message = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                kind = message.get("kind")
                if kind == "ping":
                    await send({"kind": "pong", "data": message.get("data") or {}})
                elif kind == "resolve":
                    call_id = str(message.get("call_id") or "")
                    state.runs.resolve(call_id, message.get("decision") or {})
                elif kind == "stop":
                    run_id = str(message.get("run_id") or "")
                    if run_id:
                        state.runs.stop(run_id)
                    else:
                        state.runs.stop_all()

        read_task = asyncio.create_task(reader())

        while True:
            event = await queue.get()
            await send(event)
    except WebSocketDisconnect:
        pass
    except asyncio.CancelledError:
        pass
    except Exception:  # noqa: BLE001
        pass
    finally:
        for handle in (beat, read_task):
            if handle is not None:
                handle.cancel()
        hub.unsubscribe(queue)
