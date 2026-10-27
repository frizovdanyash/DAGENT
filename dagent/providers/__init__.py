"""Provider registry: build the right backend for a model profile."""

from __future__ import annotations

import time
import uuid
from typing import Any, Dict, List, Optional

from .base import BaseProvider, Chunk, CompletionResult, ProviderError, ToolCall
from .openai_compat import PRESETS, OpenAICompatProvider, preset_list
from .anthropic import AnthropicProvider
from . import gguf as gguf_module

KINDS = {
    "api": OpenAICompatProvider,
    "openai": OpenAICompatProvider,
    "anthropic": AnthropicProvider,
    "gguf": gguf_module.GGUFProvider,
    "local": gguf_module.GGUFProvider,
}


def build_provider(profile: Dict[str, Any], settings: Any = None) -> BaseProvider:
    kind = str(profile.get("kind") or "api").lower()
    if kind in ("gguf", "local") or profile.get("gguf_path"):
        kind = "gguf"
    if str(profile.get("provider_preset") or "").lower() == "anthropic":
        kind = "anthropic"
    cls = KINDS.get(kind, OpenAICompatProvider)
    provider = cls(profile, settings)
    provider.native_tools = _native_tools(profile, provider)
    return provider


def _native_tools(profile: Dict[str, Any], provider: BaseProvider) -> Optional[bool]:
    caps = profile.get("capabilities") or {}
    if caps.get("native_tools") is not None:
        return bool(caps["native_tools"])
    preset = PRESETS.get(str(profile.get("provider_preset") or ""), {})
    if preset.get("native_tools") is not None:
        return preset["native_tools"]
    return getattr(provider, "native_tools", None)


def new_profile(
    name: str,
    kind: str = "api",
    preset: str = "custom",
    model: str = "",
    base_url: str = "",
    api_key: str = "",
    gguf_path: str = "",
    params: Optional[Dict[str, Any]] = None,
    capabilities: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Create a well-formed model profile dictionary."""
    preset_data = PRESETS.get(preset, {})
    now = time.time()
    profile: Dict[str, Any] = {
        "id": uuid.uuid4().hex[:12],
        "name": name or (model or gguf_path.split("/")[-1] or "Model"),
        "kind": "gguf" if (kind in ("gguf", "local") or gguf_path) else ("anthropic" if preset == "anthropic" else "api"),
        "provider_preset": preset,
        "provider_label": preset_data.get("label") or preset,
        "base_url": base_url or preset_data.get("base_url") or "",
        "api_key": api_key or "",
        "model": model or "",
        "gguf_path": gguf_path or "",
        "gguf_options": {},
        "params": params or {},
        "capabilities": capabilities
        or {
            "native_tools": preset_data.get("native_tools"),
            "vision": False,
            "context_window": 8192,
            "emulate_tool_role": True,
        },
        "extra_headers": {},
        "extra_body": {},
        "enabled": True,
        "favorite": False,
        "color": "",
        "notes": "",
        "created_at": now,
        "updated_at": now,
        "last_used": None,
        "usage_count": 0,
    }
    return profile


def provider_status(settings: Any) -> Dict[str, Any]:
    """Runtime information shown in the GUI (dependency availability etc.)."""
    return {
        "llama_cpp_installed": gguf_module.llama_available(),
        "llama_cpp_version": gguf_module.llama_version(),
        "llama_cpp_hint": gguf_module.INSTALL_HINT,
        "loaded_gguf": gguf_module.cached_models(),
        "presets": preset_list(),
    }


__all__ = [
    "BaseProvider",
    "Chunk",
    "CompletionResult",
    "ProviderError",
    "ToolCall",
    "OpenAICompatProvider",
    "AnthropicProvider",
    "build_provider",
    "new_profile",
    "preset_list",
    "provider_status",
    "gguf_module",
    "PRESETS",
]
