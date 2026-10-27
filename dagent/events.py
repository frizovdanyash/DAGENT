"""Event hub: everything the GUI needs to see, in real time.

One process-wide hub. Every event is broadcast to all WebSocket subscribers and
also appended to a per-run ring buffer so the browser can fall back to HTTP
long-polling if WebSockets are blocked by a proxy.
"""

from __future__ import annotations

import asyncio
import collections
import itertools
import json
import time
from typing import Any, Deque, Dict, List, Optional

_sequence = itertools.count(1)
RING_SIZE = 2000


def make_event(kind: str, payload: Optional[Dict[str, Any]] = None, run_id: str = "", session_id: str = "") -> Dict[str, Any]:
    event: Dict[str, Any] = {
        "id": next(_sequence),
        "kind": kind,
        "ts": time.time(),
        "run_id": run_id,
        "session_id": session_id,
    }
    if payload:
        event["data"] = payload
    return event


class Hub:
    def __init__(self) -> None:
        self._subscribers: List[asyncio.Queue] = []
        self._history: Deque[Dict[str, Any]] = collections.deque(maxlen=RING_SIZE)
        self._by_run: Dict[str, Deque[Dict[str, Any]]] = {}
        self._lock = asyncio.Lock()
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    # ------------------------------------------------------------------ #
    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    async def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._subscribers.append(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        if queue in self._subscribers:
            self._subscribers.remove(queue)

    def publish(self, event: Dict[str, Any]) -> Dict[str, Any]:
        """Thread-safe publish (can be called from sync code / threads)."""
        self._history.append(event)
        run_id = event.get("run_id") or ""
        if run_id:
            self._by_run.setdefault(run_id, collections.deque(maxlen=RING_SIZE)).append(event)
        if len(self._by_run) > 60:
            for stale in list(self._by_run.keys())[: len(self._by_run) - 60]:
                self._by_run.pop(stale, None)
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                # drop the oldest event for this slow consumer
                try:
                    queue.get_nowait()
                    queue.put_nowait(event)
                except Exception:  # noqa: BLE001
                    pass
            except RuntimeError:
                pass
        return event

    def emit(self, kind: str, payload: Optional[Dict[str, Any]] = None, run_id: str = "", session_id: str = "") -> Dict[str, Any]:
        return self.publish(make_event(kind, payload, run_id=run_id, session_id=session_id))

    # ------------------------------------------------------------------ #
    def history(self, since_id: int = 0, run_id: str = "", limit: int = 500) -> List[Dict[str, Any]]:
        source: Any = self._by_run.get(run_id) if run_id else self._history
        if source is None:
            return []
        events = [event for event in list(source) if event.get("id", 0) > since_id]
        return events[-limit:]

    def recent(self, limit: int = 40) -> List[Dict[str, Any]]:
        return list(self._history)[-limit:]

    def clear_run(self, run_id: str) -> None:
        self._by_run.pop(run_id, None)


hub = Hub()
