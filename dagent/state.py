"""Application state shared by all routes."""

from __future__ import annotations

import time
from typing import Any, Dict

from .agent.loop import RunManager
from .config import Settings, settings as default_settings
from .store import Store, store as default_store


class AppState:
    def __init__(self, settings: Settings = None, store: Store = None) -> None:
        self.settings = settings or default_settings
        self.store = store or default_store
        self.runs = RunManager(self.settings, self.store)
        self.started_at = time.time()
        self.stats: Dict[str, Any] = {"runs": 0, "tool_calls": 0, "errors": 0}

    @property
    def workspace(self) -> str:
        return str(self.settings.get("workspace.root") or "")

    def info(self) -> Dict[str, Any]:
        totals = self.store.totals()
        return {
            "uptime_seconds": int(time.time() - self.started_at),
            "workspace": self.workspace,
            "sessions": totals.get("sessions", 0),
            "messages": totals.get("messages", 0),
            "active_runs": [run.public() for run in self.runs.runs.values() if run.status in ("running", "waiting")],
            **self.stats,
        }


state = AppState()
