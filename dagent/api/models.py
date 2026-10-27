"""Model management routes: profiles, presets, activation, health checks, GGUF."""

from __future__ import annotations

import asyncio
import os
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, HTTPException, Query

from ..config import mask_secret
from ..events import hub
from ..providers import PRESETS, build_provider, new_profile, preset_list, provider_status
from ..providers import gguf as gguf_module
from ..state import state

router = APIRouter(prefix="/api/models")


def _profile_out(profile: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(profile)
    key = str(out.get("api_key") or "")
    out["has_api_key"] = bool(key)
    out["api_key_masked"] = mask_secret(key)
    if state.settings.get("models.hide_keys", True):
        out["api_key"] = ""
    return out


def _require(profile_id: str) -> Dict[str, Any]:
    profile = state.settings.profile(profile_id)
    if not profile:
        raise HTTPException(404, f"Model profile not found: {profile_id}")
    return profile


@router.get("")
async def list_models() -> Dict[str, Any]:
    profiles = [_profile_out(p) for p in state.settings.profiles()]
    active = state.settings.active_profile()
    return {
        "profiles": profiles,
        "active_id": active.get("id") if active else None,
        "presets": preset_list(),
        "status": provider_status(state.settings),
        "count": len(profiles),
    }


@router.get("/presets")
async def get_presets() -> Dict[str, Any]:
    return {"presets": preset_list(), "status": provider_status(state.settings)}


@router.post("")
async def create_model(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    name = str(payload.get("name") or "").strip()
    kind = str(payload.get("kind") or ("gguf" if payload.get("gguf_path") else "api")).lower()
    preset = str(payload.get("provider_preset") or "custom")
    model = str(payload.get("model") or "").strip()
    base_url = str(payload.get("base_url") or "").strip()
    api_key = str(payload.get("api_key") or "").strip()
    gguf_path = str(payload.get("gguf_path") or "").strip()

    if kind in ("gguf", "local"):
        if not gguf_path:
            raise HTTPException(400, "gguf_path is required for a local GGUF model")
        gguf_path = os.path.abspath(os.path.expanduser(gguf_path))
        if not os.path.isfile(gguf_path):
            raise HTTPException(404, f"GGUF file not found: {gguf_path}")
        name = name or os.path.basename(gguf_path).replace(".gguf", "")
        model = model or os.path.basename(gguf_path)
    else:
        if not model:
            raise HTTPException(400, "Model name/id is required (for example gpt-4o-mini)")
        if preset not in PRESETS and not base_url:
            raise HTTPException(400, "base_url is required for a custom provider")
        name = name or f"{model}"

    profile = new_profile(
        name=name,
        kind=kind,
        preset=preset if kind not in ("gguf", "local") else "gguf",
        model=model,
        base_url=base_url,
        api_key=api_key,
        gguf_path=gguf_path,
        params=payload.get("params") or {},
        capabilities=payload.get("capabilities") or None,
    )
    for key in ("extra_headers", "extra_body", "gguf_options", "notes", "color", "favorite"):
        if payload.get(key) is not None:
            profile[key] = payload[key]
    if kind in ("gguf", "local"):
        profile["provider_label"] = "Local GGUF"
        profile["gguf_options"] = payload.get("gguf_options") or {}
    if payload.get("context_window"):
        profile.setdefault("capabilities", {})["context_window"] = int(payload["context_window"])
    if payload.get("native_tools") is not None:
        profile.setdefault("capabilities", {})["native_tools"] = bool(payload["native_tools"])

    saved = state.settings.save_profile(profile)
    if payload.get("activate", True) or not state.settings.get("models.active_id"):
        state.settings.set("models.active_id", saved["id"])
    hub.emit("models.changed", {"profiles": [_profile_out(p) for p in state.settings.profiles()],
                                "active_id": state.settings.get("models.active_id")})
    return {"ok": True, "profile": _profile_out(saved), "active_id": state.settings.get("models.active_id")}


@router.put("/{profile_id}")
async def update_model(profile_id: str, payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    profile = dict(_require(profile_id))
    for key, value in payload.items():
        if key in ("id", "created_at"):
            continue
        if key == "api_key":
            text = str(value or "").strip()
            if not text:
                continue          # empty string means "keep the stored key"
            if text == profile.get("api_key_masked"):
                continue
            profile["api_key"] = text
            continue
        profile[key] = value
    if profile.get("gguf_path"):
        profile["gguf_path"] = os.path.abspath(os.path.expanduser(str(profile["gguf_path"])))
    profile["updated_at"] = time.time()
    saved = state.settings.save_profile(profile)
    if profile.get("kind") in ("gguf", "local"):
        gguf_module.clear_cache()
    hub.emit("models.changed", {"profiles": [_profile_out(p) for p in state.settings.profiles()],
                                "active_id": state.settings.get("models.active_id")})
    return {"ok": True, "profile": _profile_out(saved)}


@router.delete("/{profile_id}")
async def delete_model(profile_id: str) -> Dict[str, Any]:
    _require(profile_id)
    state.settings.delete_profile(profile_id)
    gguf_module.clear_cache()
    hub.emit("models.changed", {"profiles": [_profile_out(p) for p in state.settings.profiles()],
                                "active_id": state.settings.get("models.active_id")})
    return {"ok": True, "active_id": state.settings.get("models.active_id")}


@router.post("/{profile_id}/duplicate")
async def duplicate_model(profile_id: str) -> Dict[str, Any]:
    source = _require(profile_id)
    copy = dict(source)
    copy["id"] = os.urandom(6).hex()
    copy["name"] = f"{source.get('name')} (copy)"
    copy["created_at"] = time.time()
    saved = state.settings.save_profile(copy)
    return {"ok": True, "profile": _profile_out(saved)}


@router.post("/{profile_id}/activate")
async def activate_model(profile_id: str, payload: Dict[str, Any] = Body(default={})) -> Dict[str, Any]:
    profile = _require(profile_id)
    state.settings.set("models.active_id", profile_id)
    session_id = payload.get("session_id")
    if session_id:
        state.store.update_session(session_id, model_id=profile_id)
    provider = build_provider(profile, state.settings)
    hub.emit("model.active", {"profile": _profile_out(profile), "session_id": session_id or ""})
    return {"ok": True, "profile": _profile_out(profile), "provider": provider.describe()}


@router.post("/{profile_id}/test")
async def test_model(profile_id: str, payload: Dict[str, Any] = Body(default={})) -> Dict[str, Any]:
    profile = dict(_require(profile_id))
    if payload.get("api_key"):
        profile["api_key"] = str(payload["api_key"])
    provider = build_provider(profile, state.settings)
    started = time.time()
    result = await provider.test()
    result["latency_ms"] = result.get("latency_ms") or int((time.time() - started) * 1000)
    result["model"] = provider.describe()
    hub.emit("model.tested", {"profile_id": profile_id, "result": result})
    return result


@router.get("/{profile_id}/remote")
async def remote_models(profile_id: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    profile = dict(_require(profile_id))
    provider = build_provider(profile, state.settings)
    try:
        models = await provider.list_remote_models()
    except Exception as exc:  # noqa: BLE001
        message = getattr(exc, "message", str(exc))
        hint = getattr(exc, "hint", "")
        return {"ok": False, "models": [], "error": message, "hint": hint}
    return {"ok": True, "models": models, "count": len(models)}


@router.post("/probe")
async def probe_profile(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Test a profile that is not saved yet (used by the add-model dialog)."""
    kind = str(payload.get("kind") or ("gguf" if payload.get("gguf_path") else "api")).lower()
    profile = new_profile(
        name=str(payload.get("name") or "probe"),
        kind=kind,
        preset=str(payload.get("provider_preset") or "custom"),
        model=str(payload.get("model") or ""),
        base_url=str(payload.get("base_url") or ""),
        api_key=str(payload.get("api_key") or ""),
        gguf_path=str(payload.get("gguf_path") or ""),
        params=payload.get("params") or {},
        capabilities=payload.get("capabilities") or None,
    )
    profile["extra_headers"] = payload.get("extra_headers") or {}
    provider = build_provider(profile, state.settings)
    if payload.get("list_only"):
        try:
            models = await provider.list_remote_models()
            return {"ok": True, "models": models, "count": len(models)}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "models": [], "error": getattr(exc, "message", str(exc)),
                    "hint": getattr(exc, "hint", "")}
    result = await provider.test()
    result["model"] = provider.describe()
    return result


# --------------------------------------------------------------------------- #
# GGUF specific
# --------------------------------------------------------------------------- #

@router.get("/gguf/status")
async def gguf_status() -> Dict[str, Any]:
    return {
        "installed": gguf_module.llama_available(),
        "version": gguf_module.llama_version(),
        "hint": gguf_module.INSTALL_HINT,
        "loaded": gguf_module.cached_models(),
        "scan_dirs": state.settings.get("gguf.scan_dirs", []),
        "defaults": state.settings.get("gguf", {}),
    }


@router.post("/gguf/scan")
async def gguf_scan(payload: Dict[str, Any] = Body(default={})) -> Dict[str, Any]:
    dirs: List[str] = payload.get("dirs") or []
    if not dirs:
        dirs = list(state.settings.get("gguf.scan_dirs") or []) or [
            os.path.expanduser("~/Downloads"), os.path.expanduser("~/models"), os.path.expanduser("~"),
        ]
    recursive = bool(payload.get("recursive", True))
    files = await asyncio.to_thread(gguf_module.scan_gguf_files, dirs, recursive, 400)
    if payload.get("save_dirs"):
        state.settings.set("gguf.scan_dirs", [str(d) for d in dirs][:10])
    return {"ok": True, "files": files, "count": len(files), "dirs": dirs}


@router.post("/gguf/preload")
async def gguf_preload(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Load a GGUF file into RAM ahead of time so the first message is fast."""
    profile_id = str(payload.get("profile_id") or "")
    profile = _require(profile_id) if profile_id else None
    if not profile or profile.get("kind") not in ("gguf", "local"):
        raise HTTPException(400, "preload works only for local GGUF profiles")
    if not gguf_module.llama_available():
        return {"ok": False, "error": "llama-cpp-python is not installed", "hint": gguf_module.INSTALL_HINT}
    provider = build_provider(profile, state.settings)
    started = time.time()
    try:
        result = await provider.test()
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}
    result["load_ms"] = int((time.time() - started) * 1000)
    return result


@router.post("/gguf/unload")
async def gguf_unload() -> Dict[str, Any]:
    gguf_module.clear_cache()
    hub.emit("models.changed", {"profiles": [_profile_out(p) for p in state.settings.profiles()],
                                "active_id": state.settings.get("models.active_id")})
    return {"ok": True, "loaded": gguf_module.cached_models()}
