"""Core REST routes: bootstrap state, settings, workspace, filesystem, tools, audit."""

from __future__ import annotations

import getpass
import os
import platform
import shutil
import socket
import sys
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import JSONResponse

from .. import __version__, paths
from ..agent.modes import localize_modes
from ..agent.tools import TOOL_SPECS, guess_language, is_binary, read_text_safely, rel
from ..config import DEFAULTS, mask_secret
from ..providers import provider_status
from ..state import state

router = APIRouter(prefix="/api")


# --------------------------------------------------------------------------- #
# bootstrap
# --------------------------------------------------------------------------- #

@router.get("/health")
async def health() -> Dict[str, Any]:
    return {"ok": True, "app": "DAGENT", "version": __version__, "time": time.time()}


@router.get("/state")
async def bootstrap() -> Dict[str, Any]:
    """Everything the GUI needs on first paint - one request, no waterfall."""
    settings_public = state.settings.public()
    active = state.settings.active_profile()
    sessions = state.store.list_sessions(limit=200)
    language = str(settings_public.get("app", {}).get("language", "ru"))
    return {
        "version": __version__,
        "author": "frizovdanya",
        "author_tg": "https://t.me/frizovdanya",
        "settings": settings_public,
        "defaults": DEFAULTS,
        "modes": localize_modes(language),
        "active_model": _public_profile(active) if active else None,
        "models": [_public_profile(p) for p in settings_public.get("models", {}).get("profiles", [])],
        "sessions": sessions,
        "session_count": len(sessions),
        "tools": [
            {
                "name": spec.name,
                "description": spec.description,
                "category": spec.category,
                "render": spec.render,
                "parameters": spec.parameters,
            }
            for spec in TOOL_SPECS
        ],
        "providers": provider_status(state.settings),
        "workspace": workspace_info(),
        "system": system_info(),
        "info": state.info(),
        "hotkeys": settings_public.get("hotkeys", {}),
        "pending": [request.public() for request in state.runs.pending.values()],
    }


def _public_profile(profile: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not profile:
        return None
    out = dict(profile)
    key = str(out.get("api_key") or "")
    out["api_key_masked"] = mask_secret(key)
    out["has_api_key"] = bool(key)
    if state.settings.get("models.hide_keys", True):
        out["api_key"] = ""
    return out


def system_info() -> Dict[str, Any]:
    try:
        cpu_count = os.cpu_count() or 0
    except Exception:  # noqa: BLE001
        cpu_count = 0
    total_ram = getattr(shutil, "_get_disk_usage", None)  # placeholder to keep imports tidy
    memory: Dict[str, Any] = {}
    try:
        import resource  # noqa: F401

        if sys.platform.startswith("linux"):
            with open("/proc/meminfo", "r", encoding="utf-8") as fh:
                for line in fh:
                    if line.startswith("MemTotal:"):
                        memory["total_mb"] = int(line.split()[1]) // 1024
                    elif line.startswith("MemAvailable:"):
                        memory["available_mb"] = int(line.split()[1]) // 1024
    except Exception:  # noqa: BLE001
        memory = {}
    disk: Dict[str, Any] = {}
    try:
        usage = shutil.disk_usage(str(paths.home_dir()))
        disk = {"total_gb": round(usage.total / 1024 ** 3, 1), "free_gb": round(usage.free / 1024 ** 3, 1)}
    except Exception:  # noqa: BLE001
        disk = {}
    return {
        "os": platform.system(),
        "os_release": platform.release(),
        "machine": platform.machine(),
        "python": sys.version.split()[0],
        "hostname": socket.gethostname(),
        "user": _current_user(),
        "cpu_count": cpu_count,
        "memory": memory,
        "disk": disk,
        "data_dir": str(paths.home_dir()),
    }


def _current_user() -> str:
    try:
        return getpass.getuser()
    except Exception:  # noqa: BLE001
        return os.environ.get("USER") or os.environ.get("USERNAME") or "user"


def workspace_info(root: Optional[str] = None) -> Dict[str, Any]:
    root = os.path.abspath(os.path.expanduser(root or state.settings.get("workspace.root") or "."))
    exists = os.path.isdir(root)
    info: Dict[str, Any] = {
        "root": root,
        "exists": exists,
        "name": os.path.basename(root) or root,
        "is_git": os.path.isdir(os.path.join(root, ".git")),
        "recent": state.settings.get("workspace.recent", []) or [],
        "sandbox": bool(state.settings.get("workspace.sandbox", True)),
    }
    if exists:
        try:
            entries = os.listdir(root)
            info["entries"] = len(entries)
            info["size_bytes"] = _folder_size(root, limit=2000)
        except OSError:
            info["entries"] = 0
    return info


def _folder_size(root: str, limit: int = 2000) -> int:
    total = 0
    seen = 0
    hidden = set(state.settings.get("workspace.hidden_entries", []) or [])
    for current, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in hidden and not d.startswith(".")]
        for name in files:
            seen += 1
            if seen > limit:
                return total
            try:
                total += os.path.getsize(os.path.join(current, name))
            except OSError:
                continue
    return total


# --------------------------------------------------------------------------- #
# settings
# --------------------------------------------------------------------------- #

@router.get("/settings")
async def get_settings() -> Dict[str, Any]:
    return state.settings.public()


@router.put("/settings")
async def put_settings(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Deep-merge a partial settings document (what the GUI sends on every change)."""
    if not isinstance(payload, dict):
        raise HTTPException(400, "Settings payload must be an object")
    payload.pop("version", None)
    cleaned = _sanitize_settings(payload)
    updated = state.settings.patch(cleaned)
    if "workspace" in cleaned and cleaned["workspace"].get("root"):
        new_root = os.path.abspath(os.path.expanduser(str(cleaned["workspace"]["root"])))
        os.makedirs(new_root, exist_ok=True)
        updated["workspace"]["root"] = new_root
        state.settings.set("workspace.root", new_root)
        _push_recent(new_root)
    state.settings.save()
    return {"ok": True, "settings": state.settings.public(), "workspace": workspace_info()}


def _sanitize_settings(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Drop keys the client must not control and coerce obvious types."""
    forbidden = {"token_secret"}
    out: Dict[str, Any] = {}
    for key, value in payload.items():
        if key == "app" and isinstance(value, dict):
            value = {k: v for k, v in value.items() if k not in forbidden}
        out[key] = value
    port = out.get("app", {}).get("port") if isinstance(out.get("app"), dict) else None
    if port is not None:
        try:
            out["app"]["port"] = max(1024, min(65535, int(port)))
        except (TypeError, ValueError):
            out["app"].pop("port", None)
    return out


def _push_recent(root: str) -> None:
    recent: List[str] = list(state.settings.get("workspace.recent", []) or [])
    if root in recent:
        recent.remove(root)
    recent.insert(0, root)
    state.settings.set("workspace.recent", recent[:12])


@router.post("/settings/reset")
async def reset_settings(payload: Dict[str, Any] = Body(default={})) -> Dict[str, Any]:
    keep_models = bool(payload.get("keep_models", True))
    data = state.settings.reset(keep_models=keep_models)
    return {"ok": True, "settings": state.settings.public(), "reset": not keep_models}


@router.get("/settings/schema")
async def settings_schema() -> Dict[str, Any]:
    """Machine-readable description of every setting (used by the GUI hints)."""
    return {"defaults": DEFAULTS, "version": __version__}


@router.post("/settings/export")
async def export_settings() -> Dict[str, Any]:
    return {"ok": True, "settings": state.settings.public()}


@router.post("/settings/import")
async def import_settings(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    incoming = payload.get("settings") if isinstance(payload.get("settings"), dict) else payload
    if not isinstance(incoming, dict):
        raise HTTPException(400, "Expected {'settings': {...}}")
    if incoming.get("models", {}).get("profiles"):
        for profile in incoming["models"]["profiles"]:
            if not profile.get("id"):
                profile["id"] = os.urandom(6).hex()
    state.settings.patch(_sanitize_settings(incoming))
    state.settings.save()
    return {"ok": True, "settings": state.settings.public()}


# --------------------------------------------------------------------------- #
# workspace & filesystem browsing (for the GUI file tree and pickers)
# --------------------------------------------------------------------------- #

@router.get("/workspace")
async def get_workspace() -> Dict[str, Any]:
    return workspace_info()


@router.post("/workspace")
async def set_workspace(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    raw = str(payload.get("root") or payload.get("path") or "").strip()
    create = bool(payload.get("create", True))
    if not raw:
        raise HTTPException(400, "Workspace path is required")
    root = os.path.abspath(os.path.expanduser(raw))
    if not os.path.isdir(root):
        if not create:
            raise HTTPException(404, f"Folder does not exist: {root}")
        os.makedirs(root, exist_ok=True)
    state.settings.set("workspace.root", root)
    _push_recent(root)
    return {"ok": True, "workspace": workspace_info(root)}


@router.get("/workspace/tree")
async def get_workspace_tree(depth: int = Query(3, ge=1, le=6), path: str = Query("")) -> Dict[str, Any]:
    root = os.path.abspath(os.path.expanduser(path or state.settings.get("workspace.root") or "."))
    hidden = set(state.settings.get("workspace.hidden_entries", []) or [])
    limit = 1500
    nodes: List[Dict[str, Any]] = []

    def walk(current: str, level: int) -> None:
        if level > depth or len(nodes) >= limit:
            return
        try:
            names = sorted(os.listdir(current), key=lambda n: (not os.path.isdir(os.path.join(current, n)), n.lower()))
        except OSError:
            return
        for name in names:
            if len(nodes) >= limit:
                return
            if name in hidden or name.startswith("."):
                continue
            full = os.path.join(current, name)
            is_dir = os.path.isdir(full)
            try:
                size = 0 if is_dir else os.path.getsize(full)
            except OSError:
                size = 0
            nodes.append({
                "name": name,
                "path": rel(full, root),
                "abs": full,
                "type": "dir" if is_dir else "file",
                "depth": level,
                "size": size,
                "language": None if is_dir else guess_language(full),
            })
            if is_dir:
                walk(full, level + 1)

    walk(root, 1)
    return {"root": root, "nodes": nodes, "truncated": len(nodes) >= limit}


@router.get("/fs/browse")
async def fs_browse(path: str = Query(""), show_hidden: bool = Query(False)) -> Dict[str, Any]:
    """Directory browser for the in-app pickers (GGUF files, workspace folder...)."""
    if not path:
        if os.name == "nt":
            drives = []
            for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
                candidate = f"{letter}:\\"
                if os.path.exists(candidate):
                    drives.append({"name": f"{letter}:", "path": candidate, "type": "dir"})
            home = os.path.expanduser("~")
            return {
                "path": "",
                "parent": None,
                "entries": ([{"name": "Home", "path": home, "type": "dir"}] + drives),
                "roots": True,
            }
        path = os.path.expanduser("~")
    target = os.path.abspath(os.path.expanduser(path))
    if not os.path.isdir(target):
        raise HTTPException(404, f"Not a folder: {target}")
    hidden = {".git", "node_modules", "__pycache__", ".venv", "venv"}
    entries: List[Dict[str, Any]] = []
    try:
        names = os.listdir(target)
    except PermissionError:
        raise HTTPException(403, f"Permission denied: {target}")
    for name in sorted(names, key=lambda n: (not os.path.isdir(os.path.join(target, n)), n.lower())):
        if not show_hidden and (name in hidden or name.startswith(".")):
            continue
        full = os.path.join(target, name)
        try:
            is_dir = os.path.isdir(full)
            size = 0 if is_dir else os.path.getsize(full)
        except OSError:
            continue
        entries.append({
            "name": name,
            "path": full,
            "type": "dir" if is_dir else "file",
            "size": size,
            "gguf": name.lower().endswith(".gguf"),
        })
    parent = os.path.dirname(target)
    return {
        "path": target,
        "parent": parent if parent != target else None,
        "entries": entries,
        "home": os.path.expanduser("~"),
    }


@router.get("/fs/gguf")
async def fs_gguf_scan(path: str = Query(""), recursive: bool = Query(True)) -> Dict[str, Any]:
    """Scan folders for ``.gguf`` files (Settings -> Models -> local file picker)."""
    from ..providers.gguf import scan_gguf_files

    dirs = [path] if path else list(state.settings.get("gguf.scan_dirs", []) or [])
    if not dirs:
        dirs = [os.path.expanduser("~/Downloads"), os.path.expanduser("~/models"), os.path.expanduser("~")]
    found = await _to_thread(scan_gguf_files, dirs, recursive, 300)
    return {"files": found, "scanned": dirs, "count": len(found)}


@router.get("/fs/file")
async def fs_read_file(path: str = Query(...), max_bytes: int = Query(400_000)) -> Dict[str, Any]:
    target = os.path.abspath(os.path.expanduser(path))
    if not os.path.isfile(target):
        raise HTTPException(404, f"File not found: {target}")
    if not _read_allowed(target):
        raise HTTPException(403, "Reading files outside the workspace is disabled "
                                 "(workspace.allow_read_outside = false)")
    if is_binary(target):
        return {"path": target, "binary": True, "size": os.path.getsize(target), "content": ""}
    content = await _to_thread(read_text_safely, target, max_bytes)
    return {
        "path": target,
        "binary": False,
        "size": os.path.getsize(target),
        "content": content,
        "language": guess_language(target),
    }


def _read_allowed(target: str) -> bool:
    """File *contents* stay inside the workspace unless the user opted in.

    Browsing (listing) is always allowed so the workspace/GGUF pickers work.
    """
    if bool(state.settings.get("workspace.allow_read_outside", False)):
        return True
    root = os.path.abspath(os.path.expanduser(str(state.settings.get("workspace.root") or "")))
    if not root:
        return True
    try:
        return os.path.commonpath([root, target]) == root
    except ValueError:
        return False


@router.get("/fs/open")
async def fs_open(path: str = Query(...)) -> Dict[str, Any]:
    """Reveal a path in the system file manager."""
    target = os.path.abspath(os.path.expanduser(path))
    if not os.path.exists(target):
        raise HTTPException(404, f"Path not found: {target}")
    folder = target if os.path.isdir(target) else os.path.dirname(target)
    try:
        if sys.platform == "darwin":
            os.system(f'open "{folder}"')
        elif os.name == "nt":
            os.startfile(folder)  # type: ignore[attr-defined]
        else:
            os.system(f'xdg-open "{folder}" >/dev/null 2>&1 &')
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc), "path": folder}
    return {"ok": True, "path": folder}


@router.get("/audit")
async def get_audit(limit: int = Query(200, le=1000)) -> Dict[str, Any]:
    return {"entries": state.store.list_audit(limit)}


@router.get("/search")
async def search_all(q: str = Query(..., min_length=1), limit: int = Query(60)) -> Dict[str, Any]:
    return {"results": state.store.search(q, limit)}


async def _to_thread(func, *args, **kwargs):
    import asyncio

    return await asyncio.to_thread(func, *args, **kwargs)


@router.get("/ping")
async def ping() -> JSONResponse:
    return JSONResponse({"pong": True, "ts": time.time()})
