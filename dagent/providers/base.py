"""Common abstractions for every model backend DAGENT can talk to."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Dict, List, Optional

# Message roles used internally (superset of the OpenAI convention).
ROLE_SYSTEM = "system"
ROLE_USER = "user"
ROLE_ASSISTANT = "assistant"
ROLE_TOOL = "tool"


@dataclass
class ToolCall:
    """One tool invocation requested by the model."""

    id: str
    tool: str
    args: Dict[str, Any] = field(default_factory=dict)
    raw: str = ""
    origin: str = "native"      # native | json | xml | heuristic


@dataclass
class Chunk:
    """A single streaming event coming from a provider."""

    kind: str                   # text | reasoning | tool_calls | usage | done | error | meta
    text: str = ""
    tool_calls: List[ToolCall] = field(default_factory=list)
    usage: Dict[str, Any] = field(default_factory=dict)
    error: str = ""
    meta: Dict[str, Any] = field(default_factory=dict)


@dataclass
class CompletionResult:
    content: str = ""
    reasoning: str = ""
    tool_calls: List[ToolCall] = field(default_factory=list)
    usage: Dict[str, Any] = field(default_factory=dict)
    finish_reason: str = ""
    error: str = ""
    model: str = ""
    latency_ms: int = 0

    @property
    def ok(self) -> bool:
        return not self.error


class ProviderError(Exception):
    """Raised when a backend cannot be used (bad key, missing dependency...)."""

    def __init__(self, message: str, hint: str = "", code: str = "provider_error") -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint
        self.code = code

    def as_dict(self) -> Dict[str, Any]:
        return {"error": self.message, "hint": self.hint, "code": self.code}


class BaseProvider:
    """Interface implemented by every backend (API / GGUF / local server)."""

    kind = "base"

    def __init__(self, profile: Dict[str, Any], settings: Any = None) -> None:
        self.profile = profile or {}
        self.settings = settings
        self.created_at = time.time()

    # -- naming ------------------------------------------------------------ #
    @property
    def name(self) -> str:
        return str(self.profile.get("name") or self.profile.get("model") or self.kind)

    @property
    def model_id(self) -> str:
        return str(self.profile.get("model") or "")

    def params(self, overrides: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Merge per-profile params with runtime overrides."""
        base: Dict[str, Any] = {}
        base.update(self.profile.get("params") or {})
        base.update(overrides or {})
        return base

    # -- required API ------------------------------------------------------ #
    async def stream(self, messages: List[Dict[str, Any]], tools: Optional[List[Dict[str, Any]]] = None,
                     params: Optional[Dict[str, Any]] = None) -> AsyncIterator[Chunk]:
        raise NotImplementedError
        yield  # pragma: no cover - makes this an async generator

    async def complete(self, messages: List[Dict[str, Any]], tools: Optional[List[Dict[str, Any]]] = None,
                       params: Optional[Dict[str, Any]] = None) -> CompletionResult:
        """Non-streaming helper built on top of :meth:`stream`."""
        started = time.time()
        result = CompletionResult(model=self.model_id)
        async for chunk in self.stream(messages, tools=tools, params=params):
            if chunk.kind == "text":
                result.content += chunk.text
            elif chunk.kind == "reasoning":
                result.reasoning += chunk.text
            elif chunk.kind == "tool_calls":
                result.tool_calls.extend(chunk.tool_calls)
            elif chunk.kind == "usage":
                result.usage.update(chunk.usage)
            elif chunk.kind == "done":
                result.finish_reason = chunk.meta.get("finish_reason", "") or result.finish_reason
            elif chunk.kind == "error":
                result.error = chunk.error
        result.latency_ms = int((time.time() - started) * 1000)
        return result

    async def list_remote_models(self) -> List[str]:
        return []

    async def test(self) -> Dict[str, Any]:
        """Cheap connectivity check used by the "Test connection" button."""
        try:
            result = await self.complete(
                [{"role": "user", "content": "Reply with the single word: ok"}],
                params={"max_tokens": 8, "temperature": 0},
            )
            if result.ok:
                return {
                    "ok": True,
                    "message": (result.content or "ok").strip()[:200],
                    "latency_ms": result.latency_ms,
                    "usage": result.usage,
                }
            return {"ok": False, "message": result.error}
        except ProviderError as exc:
            return {"ok": False, "message": exc.message, "hint": exc.hint}
        except Exception as exc:  # noqa: BLE001 - surfaced to the GUI as text
            return {"ok": False, "message": f"{type(exc).__name__}: {exc}"}

    def describe(self) -> Dict[str, Any]:
        return {
            "id": self.profile.get("id"),
            "name": self.name,
            "kind": self.kind,
            "model": self.model_id,
            "supports_tools": self.profile.get("capabilities", {}).get("native_tools") is not False,
        }


def estimate_tokens(text: str) -> int:
    """Rough token estimate (~4 chars/token) used for the context meter."""
    if not text:
        return 0
    return max(1, int(len(text) / 3.6))
