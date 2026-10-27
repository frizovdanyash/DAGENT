"""Filesystem locations used by DAGENT.

Everything user-owned lives in a single directory (``~/.dagent`` by default) so the
application itself stays portable and can be deleted without leftovers.
"""

from __future__ import annotations

import os
from pathlib import Path

APP_DIR_NAME = ".dagent"


def home_dir() -> Path:
    """Root directory for DAGENT data (override with ``DAGENT_HOME``)."""
    env = os.environ.get("DAGENT_HOME")
    if env:
        path = Path(env).expanduser()
    else:
        path = Path.home() / APP_DIR_NAME
    path.mkdir(parents=True, exist_ok=True)
    return path


def data_dir() -> Path:
    path = home_dir() / "data"
    path.mkdir(parents=True, exist_ok=True)
    return path


def logs_dir() -> Path:
    path = home_dir() / "logs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def settings_file() -> Path:
    return home_dir() / "settings.json"


def database_file() -> Path:
    return data_dir() / "sessions.db"


def audit_file() -> Path:
    return logs_dir() / "audit.log"


def default_workspace() -> Path:
    """Workspace used on first run - a folder the agent is allowed to touch."""
    path = Path.home() / "DAGENTWorkspace"
    path.mkdir(parents=True, exist_ok=True)
    return path


def web_dir() -> Path:
    """Directory with the bundled graphical interface (no build step needed)."""
    return Path(__file__).resolve().parent / "web"
