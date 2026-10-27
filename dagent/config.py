"""Settings store: defaults, load/save, dotted patching and validation.

The whole configuration is a single JSON document. Every knob the GUI exposes is
declared here in :data:`DEFAULTS`, so adding a setting is a one-line change.
"""

from __future__ import annotations

import copy
import json
import os
import re
import threading
import time
from typing import Any, Dict, Iterable, List, Optional

from . import paths

SETTINGS_VERSION = 6

# --------------------------------------------------------------------------- #
# Defaults
# --------------------------------------------------------------------------- #

DEFAULTS: Dict[str, Any] = {
    "version": SETTINGS_VERSION,
    "app": {
        "language": "ru",
        "first_run_done": False,
        "host": "127.0.0.1",
        "port": 8420,
        "open_on_start": True,
        "window_mode": False,          # True -> native window via pywebview (if installed)
        "window_size": [1440, 900],
        "show_console": False,
        "auto_update_check": False,
        "dev_mode": False,
        "token_secret": "",               # random per-install token protecting the local API
        # extra browser origins allowed to talk to the API (tunnels, reverse proxies)
        "allowed_origins": [],
    },
    "ui": {
        "theme": "midnight",
        "accent": "#7c5cff",
        "custom_css": "",
        "font_family": "system",
        "font_size": 14.5,
        "mono_font": "mono",
        "density": "comfortable",
        "animations": True,
        "background_fx": "aurora",
        "blur": True,
        "corner_radius": 14,
        "content_width": 860,
        "sidebar_collapsed": False,
        "show_monitor": True,
        "monitor_tab": "activity",
        "show_timestamps": True,
        "show_avatars": True,
        "show_token_stats": True,
        "code_wrap": False,
        "code_line_numbers": True,
        "markdown": True,
        "stream_smooth": True,
        "sound": False,
        "confirm_on_close": True,
        "compact_tool_cards": False,
        "message_spacing": 18,
    },
    "workspace": {
        "root": "",
        "recent": [],
        "sandbox": True,               # forbid paths outside the workspace
        "allow_read_outside": False,
        "hidden_entries": [
            ".git", "node_modules", "__pycache__", ".venv", "venv",
            ".idea", ".vscode", "dist", "build", ".mypy_cache", ".pytest_cache",
        ],
        "max_tree_files": 4000,
    },
    "agent": {
        "mode": "assistant",
        "max_iterations": 15,
        "temperature": 0.7,
        "top_p": 0.95,
        "top_k": 0,
        "max_tokens": 2048,
        "context_window": 8192,
        "frequency_penalty": 0.0,
        "presence_penalty": 0.0,
        "repeat_penalty": 1.1,
        "stop_sequences": [],
        "stream": True,
        "extra_system_prompt": "",
        "memory_enabled": True,
        "memory_file": "DAGENT_MEMORY.md",
        "auto_title": True,
        "compress_history": True,
        "compress_ratio": 0.7,
        "retry_on_error": 2,
        "request_timeout": 300,
        "show_reasoning": True,
        "tool_protocol": "auto",       # auto | native | json
        "include_environment": True,
        "include_file_tree": False,
        "seed": None,
    },
    "security": {
        "auto_approve": False,
        "auto_approve_reads": True,
        "confirm_timeout": 300,
        "shell": "auto",               # auto | bash | powershell | cmd | custom
        "custom_shell": "",
        "command_timeout": 120,
        "max_output_chars": 120000,
        "allow_network_tools": True,
        "allow_delete": True,
        "confirm_delete": True,
        "allow_python_exec": True,
        "allow_write_outside_workspace": False,
        "audit_log": True,
        "denied_commands": [
            r"rm\s+-rf\s+/(?!home|tmp)\S*",
            r":\(\)\s*\{\s*:\|:&\s*\}\s*;:",
            r"mkfs(\.\w+)?\s",
            r"dd\s+if=.*of=/dev/",
            r"shutdown|reboot|halt|poweroff",
            r"chmod\s+-R\s+777\s+/",
            r">\s*/dev/sd[a-z]",
            r"format\s+[a-z]:",
            r"rd\s+/s\s+/q\s+[a-z]:\\?$",
            r"Remove-Item\s+.*-Recurse.*[A-Z]:\\$",
            r"curl\s+.*\|\s*(ba)?sh",
            r"wget\s+.*\|\s*(ba)?sh",
            r"git\s+push\s+.*--force(?!-with-lease)\s+.*main",
        ],
        "always_allow_commands": [
            "ls", "ll", "dir", "pwd", "cd", "cat", "type", "head", "tail",
            "echo", "grep", "rg", "find", "tree", "wc", "stat", "file",
            "git status", "git log", "git diff", "git branch", "git show",
            "python --version", "python3 --version", "pip list", "node --version",
        ],
        "sensitive_paths": [
            "/etc", "/root", "/proc", "/sys", "/boot", "/dev",
            os.path.expanduser("~/.ssh"),
            os.path.expanduser("~/.aws"),
            os.path.expanduser("~/.gnupg"),
            "C:\\Windows", "C:\\Program Files",
        ],
        "max_file_write_bytes": 8_000_000,
        "max_file_read_bytes": 2_000_000,
    },
    "models": {
        "active_id": None,
        "profiles": [],
        "hide_keys": True,
    },
    "gguf": {
        "scan_dirs": [],
        "n_ctx": 8192,
        "n_gpu_layers": 0,
        "n_threads": 0,
        "n_batch": 512,
        "chat_format": "auto",
        "verbose": False,
        "main_gpu": 0,
        "use_mmap": True,
        "use_mlock": False,
        "seed": -1,
    },
    "hotkeys": {
        "send": "Enter",
        "newline": "Shift+Enter",
        "palette": "Ctrl+K",
        "settings": "Ctrl+,",
        "new_session": "Ctrl+N",
        "switch_model": "Ctrl+M",
        "stop_run": "Ctrl+.",
        "focus_input": "Ctrl+L",
        "toggle_sidebar": "Ctrl+B",
        "toggle_monitor": "Ctrl+J",
        "search_sessions": "Ctrl+F",
        "regenerate": "Ctrl+R",
    },
    "chat": {
        "attachments_as": "text",      # text | path
        "max_attachment_bytes": 400_000,
        "scroll_on_stream": True,
        "send_on_enter": True,
    },
}


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def deep_merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    """Recursively merge ``override`` into a copy of ``base``."""
    out = copy.deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def get_path(data: Dict[str, Any], dotted: str, default: Any = None) -> Any:
    node: Any = data
    for part in dotted.split("."):
        if not isinstance(node, dict) or part not in node:
            return default
        node = node[part]
    return node


def set_path(data: Dict[str, Any], dotted: str, value: Any) -> None:
    parts = dotted.split(".")
    node = data
    for part in parts[:-1]:
        nxt = node.get(part)
        if not isinstance(nxt, dict):
            nxt = {}
            node[part] = nxt
        node = nxt
    node[parts[-1]] = value


def expand_secret(value: str) -> str:
    """Resolve ``${ENV_VAR}`` / ``env:NAME`` references inside stored secrets."""
    if not isinstance(value, str) or not value:
        return value
    if value.startswith("env:"):
        return os.environ.get(value[4:], "")
    return re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", lambda m: os.environ.get(m.group(1), ""), value)


# --------------------------------------------------------------------------- #
# Store
# --------------------------------------------------------------------------- #

class Settings:
    """Thread-safe JSON settings store with atomic writes."""

    def __init__(self, path=None) -> None:
        self.path = path or paths.settings_file()
        self._lock = threading.RLock()
        self._data: Dict[str, Any] = copy.deepcopy(DEFAULTS)
        self.load()

    # -- persistence ------------------------------------------------------- #
    def load(self) -> Dict[str, Any]:
        with self._lock:
            data = copy.deepcopy(DEFAULTS)
            try:
                if os.path.exists(self.path):
                    with open(self.path, "r", encoding="utf-8") as fh:
                        stored = json.load(fh)
                    data = deep_merge(data, stored)
            except Exception as exc:  # corrupted file -> keep defaults, keep a backup
                try:
                    os.replace(self.path, str(self.path) + f".broken.{int(time.time())}")
                except Exception:
                    pass
                data = deep_merge(copy.deepcopy(DEFAULTS), {"_load_error": str(exc)})
            if not data.get("workspace", {}).get("root"):
                data["workspace"]["root"] = str(paths.default_workspace())
            if not data.get("app", {}).get("token_secret"):
                data["app"]["token_secret"] = os.urandom(16).hex()
            self._data = data
            return copy.deepcopy(self._data)

    def save(self) -> None:
        with self._lock:
            tmp = str(self.path) + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(self._data, fh, ensure_ascii=False, indent=2)
            os.replace(tmp, self.path)

    # -- access ------------------------------------------------------------ #
    def all(self) -> Dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._data)

    def get(self, dotted: str, default: Any = None) -> Any:
        with self._lock:
            return get_path(self._data, dotted, default)

    def set(self, dotted: str, value: Any, persist: bool = True) -> None:
        with self._lock:
            set_path(self._data, dotted, value)
            if persist:
                self.save()

    def patch(self, updates: Dict[str, Any], persist: bool = True) -> Dict[str, Any]:
        """Merge a (possibly nested) partial document."""
        with self._lock:
            self._data = deep_merge(self._data, updates or {})
            if persist:
                self.save()
            return copy.deepcopy(self._data)

    def reset(self, keep_models: bool = True) -> Dict[str, Any]:
        with self._lock:
            models = self._data.get("models") if keep_models else None
            self._data = copy.deepcopy(DEFAULTS)
            if models:
                self._data["models"] = models
            self.save()
            return copy.deepcopy(self._data)

    def public(self) -> Dict[str, Any]:
        """Settings safe to ship to the browser (API keys masked)."""
        data = self.all()
        if data.get("models", {}).get("hide_keys", True):
            for profile in data["models"].get("profiles", []):
                if profile.get("api_key"):
                    key = str(profile["api_key"])
                    profile["api_key_masked"] = mask_secret(key)
                    profile["api_key"] = ""
                    profile["has_api_key"] = True
                else:
                    profile["api_key_masked"] = ""
                    profile["has_api_key"] = False
        else:
            for profile in data["models"].get("profiles", []):
                profile["api_key_masked"] = mask_secret(str(profile.get("api_key") or ""))
                profile["has_api_key"] = bool(profile.get("api_key"))
        data.setdefault("app", {})["token_secret"] = ""
        return data

    # -- model profiles ---------------------------------------------------- #
    def profiles(self) -> List[Dict[str, Any]]:
        return list(self.get("models.profiles", []) or [])

    def profile(self, profile_id: str) -> Optional[Dict[str, Any]]:
        for item in self.profiles():
            if item.get("id") == profile_id:
                return item
        return None

    def active_profile(self) -> Optional[Dict[str, Any]]:
        active = self.get("models.active_id")
        if active:
            found = self.profile(active)
            if found:
                return found
        items = self.profiles()
        return items[0] if items else None

    def save_profile(self, profile: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            items = self.profiles()
            replaced = False
            for index, item in enumerate(items):
                if item.get("id") == profile.get("id"):
                    items[index] = profile
                    replaced = True
                    break
            if not replaced:
                items.append(profile)
            self._data["models"]["profiles"] = items
            if not self._data["models"].get("active_id") and items:
                self._data["models"]["active_id"] = items[0]["id"]
            self.save()
            return copy.deepcopy(profile)

    def delete_profile(self, profile_id: str) -> bool:
        with self._lock:
            items = [p for p in self.profiles() if p.get("id") != profile_id]
            self._data["models"]["profiles"] = items
            if self._data["models"].get("active_id") == profile_id:
                self._data["models"]["active_id"] = items[0]["id"] if items else None
            self.save()
            return True


def mask_secret(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 8:
        return "*" * len(value)
    return f"{value[:4]}{'*' * 6}{value[-4:]}"


# Application-wide singleton ------------------------------------------------ #
settings = Settings()


def iter_hotkeys() -> Iterable[Any]:
    return (settings.get("hotkeys") or {}).items()
