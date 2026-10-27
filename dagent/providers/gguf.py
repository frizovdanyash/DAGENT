"""Local GGUF inference through ``llama-cpp-python``.

The dependency is optional: DAGENT starts fine without it and shows a friendly
setup hint in the GUI. Models are cached in RAM between requests so switching
between several local GGUF files is instant after the first load.
"""

from __future__ import annotations

import asyncio
import json
import os
import queue
import threading
from typing import Any, AsyncIterator, Dict, List, Optional

from .base import BaseProvider, Chunk, ProviderError, ToolCall

INSTALL_HINT = (
    "llama-cpp-python is not installed. Run one of:\n"
    "  CPU:      pip install llama-cpp-python\n"
    "  CUDA:     CMAKE_ARGS='-DGGML_CUDA=on' pip install llama-cpp-python --upgrade --force-reinstall\n"
    "  macOS ML: CMAKE_ARGS='-DGGML_METAL=on' pip install llama-cpp-python --upgrade --force-reinstall\n"
    "No compiler? Use a local server instead: LM Studio, Ollama or llama.cpp server "
    "and add the model as an 'API' profile (http://localhost:1234/v1)."
)

_CACHE: Dict[str, Any] = {}
_CACHE_LOCK = threading.Lock()
_CACHE_MAX = 2


def llama_available() -> bool:
    try:
        import llama_cpp  # noqa: F401

        return True
    except Exception:  # noqa: BLE001
        return False


def llama_version() -> str:
    try:
        import llama_cpp  # noqa: F401

        return str(getattr(llama_cpp, "__version__", "unknown"))
    except Exception:  # noqa: BLE001
        return ""


def clear_cache(keep_path: Optional[str] = None) -> None:
    with _CACHE_LOCK:
        for key in list(_CACHE.keys()):
            if keep_path and key == keep_path:
                continue
            model = _CACHE.pop(key, None)
            try:
                if model is not None:
                    model.close()
            except Exception:  # noqa: BLE001
                pass


def cached_models() -> List[Dict[str, Any]]:
    with _CACHE_LOCK:
        return [{"path": key} for key in _CACHE.keys()]


def _load_model(path: str, options: Dict[str, Any]) -> Any:
    """Load (or reuse) a GGUF file. Runs in a worker thread."""
    if not path or not os.path.exists(path):
        raise ProviderError(f"GGUF file not found: {path}", hint="Pick an existing .gguf file in Settings -> Models.",
                            code="file_not_found")
    key = f"{path}|{options.get('n_ctx')}|{options.get('n_gpu_layers')}|{options.get('n_threads')}"
    with _CACHE_LOCK:
        if key in _CACHE:
            return _CACHE[key]
    try:
        from llama_cpp import Llama
    except Exception as exc:  # noqa: BLE001
        raise ProviderError(f"llama-cpp-python import failed: {exc}", hint=INSTALL_HINT, code="missing_dependency") from exc

    kwargs: Dict[str, Any] = {
        "model_path": path,
        "n_ctx": int(options.get("n_ctx") or 4096),
        "n_gpu_layers": int(options.get("n_gpu_layers") or 0),
        "n_batch": int(options.get("n_batch") or 512),
        "verbose": bool(options.get("verbose")),
        "use_mmap": bool(options.get("use_mmap", True)),
        "use_mlock": bool(options.get("use_mlock", False)),
    }
    if options.get("n_threads"):
        kwargs["n_threads"] = int(options["n_threads"])
    if options.get("main_gpu") is not None:
        kwargs["main_gpu"] = int(options["main_gpu"])
    try:
        model = Llama(**kwargs)
    except TypeError:
        kwargs.pop("use_mmap", None)
        kwargs.pop("use_mlock", None)
        model = Llama(**kwargs)
    except Exception as exc:  # noqa: BLE001
        raise ProviderError(f"Failed to load {os.path.basename(path)}: {exc}", hint=INSTALL_HINT,
                            code="load_error") from exc
    with _CACHE_LOCK:
        while len(_CACHE) >= _CACHE_MAX:
            old_key = next(iter(_CACHE))
            old = _CACHE.pop(old_key, None)
            try:
                if old is not None:
                    old.close()
            except Exception:  # noqa: BLE001
                pass
        _CACHE[key] = model
    return model


def _convert_messages(messages: List[Dict[str, Any]], emulate_tool_role: bool) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for message in messages:
        role = message.get("role") or "user"
        content = message.get("content") or ""
        if role == "tool" and emulate_tool_role:
            out.append(
                {
                    "role": "user",
                    "content": (
                        "<tool_result>\n"
                        f"{content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)}\n"
                        "</tool_result>"
                    ),
                }
            )
            continue
        item: Dict[str, Any] = {"role": role, "content": content}
        if role == "tool":
            item["tool_call_id"] = message.get("tool_call_id") or ""
        if role == "assistant" and message.get("tool_calls"):
            item["tool_calls"] = [
                {
                    "id": call.get("id") or "",
                    "type": "function",
                    "function": {
                        "name": call.get("tool") or "",
                        "arguments": json.dumps(call.get("args") or {}, ensure_ascii=False),
                    },
                }
                for call in message["tool_calls"]
            ]
        out.append(item)
    # llama.cpp requires the transcript to start with system/user, never tool.
    while out and out[0]["role"] == "tool":
        out.pop(0)
    return out


class GGUFProvider(BaseProvider):
    kind = "gguf"

    def __init__(self, profile: Dict[str, Any], settings: Any = None) -> None:
        super().__init__(profile, settings)
        caps = profile.get("capabilities") or {}
        self.native_tools = caps.get("native_tools")
        self.emulate_tool_role = bool(caps.get("emulate_tool_role", True))

    @property
    def gguf_path(self) -> str:
        return str(self.profile.get("gguf_path") or self.profile.get("path") or "")

    def _options(self, params: Dict[str, Any]) -> Dict[str, Any]:
        gguf_defaults = {}
        if self.settings is not None:
            try:
                gguf_defaults = dict(self.settings.get("gguf") or {})
            except Exception:  # noqa: BLE001
                gguf_defaults = {}
        merged = {**gguf_defaults, **(self.profile.get("gguf_options") or {})}
        for key in ("n_ctx", "n_gpu_layers", "n_threads", "n_batch", "verbose", "use_mmap", "use_mlock", "main_gpu"):
            if params.get(key) is not None:
                merged[key] = params[key]
        return merged

    async def stream(self, messages: List[Dict[str, Any]], tools: Optional[List[Dict[str, Any]]] = None,
                     params: Optional[Dict[str, Any]] = None) -> AsyncIterator[Chunk]:
        params = self.params(params)
        if not llama_available():
            raise ProviderError("llama-cpp-python is not installed", hint=INSTALL_HINT, code="missing_dependency")
        path = self.gguf_path
        options = self._options(params)
        chat_format = str((self.profile.get("gguf_options") or {}).get("chat_format") or options.get("chat_format") or "auto")
        if chat_format in ("", "auto", "none"):
            chat_format = None

        loop = asyncio.get_running_loop()
        events: "queue.Queue[Optional[Dict[str, Any]]]" = queue.Queue(maxsize=256)

        def worker() -> None:
            try:
                model = _load_model(path, options)
                kwargs: Dict[str, Any] = {
                    "messages": _convert_messages(messages, self.emulate_tool_role),
                    "stream": True,
                    "temperature": float(params.get("temperature", 0.7)),
                    "top_p": float(params.get("top_p", 0.95)),
                    "max_tokens": int(params.get("max_tokens") or 1024),
                }
                if params.get("top_k"):
                    kwargs["top_k"] = int(params["top_k"])
                if params.get("repeat_penalty"):
                    kwargs["repeat_penalty"] = float(params["repeat_penalty"])
                if params.get("seed") is not None:
                    kwargs["seed"] = int(params["seed"])
                stop = params.get("stop_sequences") or []
                if stop:
                    kwargs["stop"] = list(stop)
                if chat_format:
                    kwargs["chat_format"] = chat_format
                use_tools = bool(tools) and self.native_tools is not False
                if use_tools:
                    kwargs["tools"] = [
                        {
                            "type": "function",
                            "function": {
                                "name": tool["name"],
                                "description": tool.get("description", ""),
                                "parameters": tool.get("parameters") or {"type": "object", "properties": {}},
                            },
                        }
                        for tool in tools
                    ]
                try:
                    stream = model.create_chat_completion(**kwargs)
                except Exception as exc:  # noqa: BLE001
                    text = str(exc)
                    if use_tools and ("tool" in text.lower() or "unexpected" in text.lower()):
                        kwargs.pop("tools", None)
                        stream = model.create_chat_completion(**kwargs)
                    else:
                        raise
                for piece in stream:
                    choice = (piece.get("choices") or [{}])[0]
                    delta = choice.get("delta") or {}
                    if delta.get("content"):
                        events.put({"kind": "text", "text": delta["content"]})
                    for call in delta.get("tool_calls") or []:
                        events.put({"kind": "tool_call_delta", "data": call})
                    if choice.get("finish_reason"):
                        events.put({"kind": "meta", "finish_reason": choice["finish_reason"]})
                    usage = piece.get("usage")
                    if usage:
                        events.put({"kind": "usage", "usage": usage})
                events.put({"kind": "done"})
            except ProviderError as exc:
                events.put({"kind": "error", "error": exc.message, "hint": exc.hint})
            except Exception as exc:  # noqa: BLE001
                events.put({"kind": "error", "error": f"{type(exc).__name__}: {exc}"})
            finally:
                events.put(None)

        thread = threading.Thread(target=worker, daemon=True, name="dagent-gguf")
        thread.start()

        tool_buffers: Dict[int, Dict[str, str]] = {}
        while True:
            item = await loop.run_in_executor(None, events.get)
            if item is None:
                break
            kind = item.get("kind")
            if kind == "text":
                yield Chunk(kind="text", text=item["text"])
            elif kind == "reasoning":
                yield Chunk(kind="reasoning", text=item["text"])
            elif kind == "usage":
                usage = item["usage"]
                yield Chunk(kind="usage", usage={
                    "prompt_tokens": usage.get("prompt_tokens", 0),
                    "completion_tokens": usage.get("completion_tokens", 0),
                    "total_tokens": usage.get("total_tokens", 0),
                })
            elif kind == "meta":
                yield Chunk(kind="meta", meta={"finish_reason": item.get("finish_reason", "")})
            elif kind == "tool_call_delta":
                call = item["data"]
                index = int(call.get("index") or 0)
                buffer = tool_buffers.setdefault(index, {"id": "", "name": "", "arguments": ""})
                if call.get("id"):
                    buffer["id"] = call["id"]
                function = call.get("function") or {}
                if function.get("name") and not buffer["name"]:
                    buffer["name"] = function["name"]
                if function.get("arguments"):
                    buffer["arguments"] += function["arguments"]
            elif kind == "error":
                yield Chunk(kind="error", error=item["error"], meta={"hint": item.get("hint", "")})
                return
            elif kind == "done":
                break
        calls: List[ToolCall] = []
        for index in sorted(tool_buffers):
            buffer = tool_buffers[index]
            if not buffer["name"]:
                continue
            try:
                args = json.loads(buffer["arguments"]) if buffer["arguments"] else {}
            except json.JSONDecodeError:
                args = {"_raw": buffer["arguments"]}
            calls.append(ToolCall(id=buffer["id"] or f"local_{index}", tool=buffer["name"], args=args,
                                  raw=buffer["arguments"], origin="native"))
        if calls:
            yield Chunk(kind="tool_calls", tool_calls=calls)
        yield Chunk(kind="done", meta={"tools_emitted": bool(calls)})

    async def test(self) -> Dict[str, Any]:
        if not llama_available():
            return {"ok": False, "message": "llama-cpp-python is not installed", "hint": INSTALL_HINT}
        path = self.gguf_path
        if not path:
            return {"ok": False, "message": "No GGUF file selected"}
        if not os.path.exists(path):
            return {"ok": False, "message": f"File does not exist: {path}"}
        size_mb = round(os.path.getsize(path) / (1024 * 1024), 1)
        started = asyncio.get_event_loop().time()
        try:
            result = await self.complete(
                [{"role": "user", "content": "Say ok"}], params={"max_tokens": 8, "temperature": 0}
            )
        except ProviderError as exc:
            return {"ok": False, "message": exc.message, "hint": exc.hint}
        elapsed = int((asyncio.get_event_loop().time() - started) * 1000)
        if result.ok:
            return {"ok": True, "message": f"Loaded in {elapsed} ms ({size_mb} MB file)", "latency_ms": elapsed,
                    "usage": result.usage}
        return {"ok": False, "message": result.error}


def scan_gguf_files(directories: List[str], recursive: bool = True, limit: int = 400) -> List[Dict[str, Any]]:
    """Find ``.gguf`` files in the given folders (used by the model picker)."""
    found: List[Dict[str, Any]] = []
    for directory in directories:
        root_path = os.path.expanduser(directory or "")
        if not root_path or not os.path.isdir(root_path):
            continue
        if recursive:
            for current, dirs, files in os.walk(root_path):
                dirs[:] = [d for d in dirs if not d.startswith(".")]
                for name in files:
                    if name.lower().endswith(".gguf"):
                        full = os.path.join(current, name)
                        found.append(_describe_gguf(full))
                        if len(found) >= limit:
                            return found
        else:
            for name in os.listdir(root_path):
                full = os.path.join(root_path, name)
                if os.path.isfile(full) and name.lower().endswith(".gguf"):
                    found.append(_describe_gguf(full))
    found.sort(key=lambda item: item["name"].lower())
    return found


def _describe_gguf(path: str) -> Dict[str, Any]:
    try:
        size = os.path.getsize(path)
    except OSError:
        size = 0
    name = os.path.basename(path)
    quant = ""
    lowered = name.lower()
    for token in ("q2_k", "q3_k_s", "q3_k_m", "q3_k_l", "q4_k_s", "q4_k_m", "q4_k_l", "q5_k_s", "q5_k_m",
                  "q6_k", "q8_0", "f16", "bf16"):
        if token in lowered:
            quant = token.upper()
            break
    return {
        "name": name,
        "path": path,
        "size_mb": round(size / (1024 * 1024), 1),
        "quant": quant,
        "modified": os.path.getmtime(path) if os.path.exists(path) else 0,
    }
