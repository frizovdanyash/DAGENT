"""OpenAI-compatible chat completions backend.

Works with: OpenAI, OpenRouter, Groq, DeepSeek, Mistral, Together, Fireworks,
YandexGPT/any OpenAI-shaped gateway, LM Studio, llama.cpp ``server``, Ollama
(``/v1``), vLLM, text-generation-webui, KoboldCpp and every custom endpoint.
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx

from .base import BaseProvider, Chunk, ProviderError, ToolCall

PRESETS: Dict[str, Dict[str, Any]] = {
    "openai": {"base_url": "https://api.openai.com/v1", "label": "OpenAI", "native_tools": True},
    "openrouter": {"base_url": "https://openrouter.ai/api/v1", "label": "OpenRouter", "native_tools": True},
    "deepseek": {"base_url": "https://api.deepseek.com/v1", "label": "DeepSeek", "native_tools": True},
    "groq": {"base_url": "https://api.groq.com/openai/v1", "label": "Groq", "native_tools": True},
    "mistral": {"base_url": "https://api.mistral.ai/v1", "label": "Mistral AI", "native_tools": True},
    "together": {"base_url": "https://api.together.xyz/v1", "label": "Together AI", "native_tools": True},
    "fireworks": {"base_url": "https://api.fireworks.ai/inference/v1", "label": "Fireworks", "native_tools": True},
    "anthropic_proxy": {"base_url": "https://api.anthropic.com/v1", "label": "Anthropic (proxy)", "native_tools": True},
    "xai": {"base_url": "https://api.x.ai/v1", "label": "xAI (Grok)", "native_tools": True},
    "moonshot": {"base_url": "https://api.moonshot.ai/v1", "label": "Moonshot", "native_tools": True},
    "qwen": {"base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "label": "Qwen / DashScope", "native_tools": True},
    "siliconflow": {"base_url": "https://api.siliconflow.cn/v1", "label": "SiliconFlow", "native_tools": True},
    "lmstudio": {"base_url": "http://localhost:1234/v1", "label": "LM Studio", "native_tools": True},
    "ollama": {"base_url": "http://localhost:11434/v1", "label": "Ollama", "native_tools": False},
    "llamacpp": {"base_url": "http://localhost:8080/v1", "label": "llama.cpp server", "native_tools": False},
    "vllm": {"base_url": "http://localhost:8000/v1", "label": "vLLM", "native_tools": True},
    "koboldcpp": {"base_url": "http://localhost:5001/v1", "label": "KoboldCpp", "native_tools": False},
    "custom": {"base_url": "", "label": "Custom / self-hosted", "native_tools": None},
}


def preset_list() -> List[Dict[str, Any]]:
    return [{"id": key, **value} for key, value in PRESETS.items()]


class OpenAICompatProvider(BaseProvider):
    kind = "api"

    def __init__(self, profile: Dict[str, Any], settings: Any = None) -> None:
        super().__init__(profile, settings)
        caps = profile.get("capabilities") or {}
        self.native_tools = caps.get("native_tools")
        if self.native_tools is None:
            preset = PRESETS.get(str(profile.get("provider_preset") or "custom"), {})
            self.native_tools = preset.get("native_tools")
        preset = PRESETS.get(str(profile.get("provider_preset") or "custom"), {})
        self.base_url = (profile.get("base_url") or preset.get("base_url") or "").rstrip("/")

    # ------------------------------------------------------------------ #
    def _headers(self) -> Dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        key = str(self.profile.get("api_key") or "").strip()
        if key:
            from ..config import expand_secret

            resolved = expand_secret(key)
            if resolved:
                headers["Authorization"] = f"Bearer {resolved}"
        for key_name, value in (self.profile.get("extra_headers") or {}).items():
            if value:
                headers[str(key_name)] = str(value)
        return headers

    def _endpoint(self, suffix: str = "/chat/completions") -> str:
        if not self.base_url:
            raise ProviderError(
                "Base URL is not set for this model profile",
                hint="Open Settings -> Models and fill in the endpoint, e.g. https://api.openai.com/v1",
                code="missing_base_url",
            )
        return self.base_url + suffix

    def _payload(self, messages: List[Dict[str, Any]], tools: Optional[List[Dict[str, Any]]],
                 params: Dict[str, Any], stream: bool) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "model": self.model_id,
            "messages": [_to_wire_message(m) for m in messages],
            "stream": stream,
        }
        if stream:
            payload["stream_options"] = {"include_usage": True}
        temp = params.get("temperature")
        if temp is not None:
            payload["temperature"] = float(temp)
        if params.get("top_p"):
            payload["top_p"] = float(params["top_p"])
        if params.get("max_tokens"):
            payload["max_tokens"] = int(params["max_tokens"])
        if params.get("frequency_penalty"):
            payload["frequency_penalty"] = float(params["frequency_penalty"])
        if params.get("presence_penalty"):
            payload["presence_penalty"] = float(params["presence_penalty"])
        stop = params.get("stop_sequences") or params.get("stop") or []
        if isinstance(stop, str):
            stop = [stop]
        if stop:
            payload["stop"] = list(stop)[:4]
        if params.get("seed") is not None:
            payload["seed"] = int(params["seed"])
        if tools and self.native_tools is not False and params.get("use_native_tools", True):
            payload["tools"] = [{"type": "function", "function": _to_openai_tool(t)} for t in tools]
            payload["tool_choice"] = params.get("tool_choice") or "auto"
        for key, value in (self.profile.get("extra_body") or {}).items():
            payload[key] = value
        return payload

    # ------------------------------------------------------------------ #
    async def stream(self, messages: List[Dict[str, Any]], tools: Optional[List[Dict[str, Any]]] = None,
                     params: Optional[Dict[str, Any]] = None) -> AsyncIterator[Chunk]:
        params = self.params(params)
        url = self._endpoint()
        timeout = float(params.get("request_timeout") or 300)
        payload = self._payload(messages, tools, params, stream=True)
        attempt = 0
        while True:
            attempt += 1
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=20.0)) as client:
                    async with client.stream("POST", url, headers=self._headers(), json=payload) as response:
                        if response.status_code >= 400:
                            body = (await response.aread()).decode("utf-8", "replace")
                            if attempt == 1 and self._should_strip_tools(response.status_code, body) and "tools" in payload:
                                payload.pop("tools", None)
                                payload.pop("tool_choice", None)
                                continue
                            if attempt == 1 and "stream_options" in body:
                                payload.pop("stream_options", None)
                                continue
                            raise ProviderError(*_explain_http(response.status_code, body))
                        async for chunk in _parse_sse_stream(response):
                            yield chunk
                        return
            except ProviderError:
                raise
            except httpx.ConnectError as exc:
                raise ProviderError(
                    f"Cannot reach {url}: {exc}",
                    hint="Is the server running and is the URL/port correct? For local servers check 'Allow remote apps' / CORS.",
                    code="connect_error",
                ) from exc
            except httpx.TimeoutException as exc:
                raise ProviderError(f"Request timed out after {timeout:.0f}s", hint="Increase the timeout in Settings -> Agent.",
                                    code="timeout") from exc
            except httpx.HTTPError as exc:
                raise ProviderError(f"HTTP error: {type(exc).__name__}: {exc}", code="http_error") from exc

    async def list_remote_models(self) -> List[str]:
        url = self._endpoint("/models")
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                response = await client.get(url, headers=self._headers())
                if response.status_code >= 400:
                    raise ProviderError(*_explain_http(response.status_code, response.text))
                data = response.json()
        except ProviderError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise ProviderError(f"Could not fetch model list: {exc}", code="list_error") from exc
        items = data.get("data") if isinstance(data, dict) else data
        models: List[str] = []
        for item in items or []:
            if isinstance(item, dict):
                mid = item.get("id") or item.get("name")
                if mid:
                    models.append(str(mid))
            elif isinstance(item, str):
                models.append(item)
        # Ollama exposes /api/tags as well
        if not models and self.base_url.endswith("/v1"):
            try:
                async with httpx.AsyncClient(timeout=15.0) as client:
                    resp = await client.get(self.base_url[:-3] + "/api/tags", headers=self._headers())
                    if resp.status_code < 400:
                        for entry in resp.json().get("models", []):
                            name = entry.get("name") or entry.get("model")
                            if name:
                                models.append(str(name))
            except Exception:  # noqa: BLE001
                pass
        return sorted(set(models))


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def _should_strip_tools(status: int, body: str) -> bool:
    text = body.lower()
    return status in (400, 404, 422) and ("tool" in text or "function" in text or "unexpected" in text or "unknown" in text)


def _explain_http(status: int, body: str) -> Any:
    message = f"HTTP {status}"
    hint = ""
    try:
        data = json.loads(body)
        err = data.get("error")
        if isinstance(err, dict):
            message = f"HTTP {status}: {err.get('message') or err}"
            code = str(err.get("code") or "")
        elif isinstance(err, str):
            message = f"HTTP {status}: {err}"
            code = ""
        else:
            message = f"HTTP {status}: {str(data)[:300]}"
            code = ""
    except Exception:  # noqa: BLE001
        message = f"HTTP {status}: {body[:300]}"
        code = ""
    lowered = message.lower()
    if status in (401, 403):
        hint = "The API key was rejected. Check Settings -> Models -> API key (and that the key has access to this model)."
    elif status == 404:
        hint = "Wrong endpoint or model name. The URL usually ends with /v1 and the model must exist on that provider."
    elif status == 429:
        hint = "Rate limit or quota exhausted. Wait a moment, switch model, or top up the provider balance."
    elif status >= 500:
        hint = "The provider returned a server error. Try again or switch to another model."
    elif "context" in lowered and "length" in lowered:
        hint = "The conversation is longer than the model context. Start a new session or reduce the history."
    return message, hint, f"http_{status}"


def _to_openai_tool(tool: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "name": tool["name"],
        "description": tool.get("description", ""),
        "parameters": tool.get("parameters") or {"type": "object", "properties": {}},
    }


def _to_wire_message(message: Dict[str, Any]) -> Dict[str, Any]:
    """Convert the internal message shape to the OpenAI wire format."""
    role = message.get("role") or "user"
    content = message.get("content") or ""
    out: Dict[str, Any] = {"role": role, "content": content}
    if message.get("name"):
        out["name"] = message["name"]
    if role == "tool":
        out["tool_call_id"] = message.get("tool_call_id") or message.get("id") or ""
        out["content"] = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
    calls = message.get("tool_calls")
    if role == "assistant" and calls:
        out["tool_calls"] = []
        for call in calls:
            out["tool_calls"].append(
                {
                    "id": call.get("id") or "",
                    "type": "function",
                    "function": {
                        "name": call.get("tool") or call.get("name") or "",
                        "arguments": json.dumps(call.get("args") or call.get("arguments") or {}, ensure_ascii=False),
                    },
                }
            )
        # Some strict servers dislike content=null with tool_calls; keep "" instead.
        if out["content"] is None:
            out["content"] = ""
    return out


async def _parse_sse_stream(response: httpx.Response) -> AsyncIterator[Chunk]:
    """Parse an SSE chat-completion stream into :class:`Chunk` objects."""
    tool_buffers: Dict[int, Dict[str, Any]] = {}
    emitted_tools = False
    async for raw_line in response.aiter_lines():
        if raw_line is None:
            continue
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith(":"):
            continue
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            payload = json.loads(data)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict) and payload.get("error"):
            err = payload["error"]
            message = err.get("message") if isinstance(err, dict) else str(err)
            yield Chunk(kind="error", error=str(message or err))
            return
        usage = payload.get("usage") if isinstance(payload, dict) else None
        if usage:
            yield Chunk(kind="usage", usage=_normalize_usage(usage))
        for choice in payload.get("choices") or []:
            delta = choice.get("delta") or {}
            message_obj = choice.get("message") or {}
            source = delta if delta else message_obj
            text = source.get("content")
            if isinstance(text, list):  # some gateways send content parts
                text = "".join(part.get("text", "") for part in text if isinstance(part, dict))
            if text:
                yield Chunk(kind="text", text=str(text))
            reasoning = (
                source.get("reasoning_content")
                or source.get("reasoning")
                or source.get("thinking")
                or delta.get("reasoning_details")
            )
            if isinstance(reasoning, list):
                reasoning = "".join(
                    part.get("text", "") for part in reasoning if isinstance(part, dict)
                )
            if reasoning:
                yield Chunk(kind="reasoning", text=str(reasoning))
            for call in source.get("tool_calls") or []:
                index = int(call.get("index") or 0)
                buffer = tool_buffers.setdefault(index, {"id": "", "name": "", "arguments": ""})
                if call.get("id"):
                    buffer["id"] = call["id"]
                function = call.get("function") or {}
                if function.get("name"):
                    buffer["name"] += function["name"] if not buffer["name"] else ""
                if function.get("arguments"):
                    buffer["arguments"] += function["arguments"]
                if call.get("name"):
                    buffer["name"] = call["name"]
            if choice.get("finish_reason"):
                yield Chunk(kind="meta", meta={"finish_reason": choice["finish_reason"]})
    if tool_buffers:
        calls: List[ToolCall] = []
        for index in sorted(tool_buffers):
            buffer = tool_buffers[index]
            if not buffer["name"]:
                continue
            args = _safe_json(buffer["arguments"])
            calls.append(
                ToolCall(
                    id=buffer["id"] or f"call_{index}",
                    tool=buffer["name"],
                    args=args if isinstance(args, dict) else {"_raw": buffer["arguments"]},
                    raw=buffer["arguments"],
                    origin="native",
                )
            )
        if calls:
            emitted_tools = True
            yield Chunk(kind="tool_calls", tool_calls=calls)
    yield Chunk(kind="done", meta={"tools_emitted": emitted_tools})


def _safe_json(text: str) -> Any:
    if not text:
        return {}
    try:
        return json.loads(text)
    except Exception:  # noqa: BLE001
        cleaned = text.strip().strip("`")
        if cleaned.startswith("json"):
            cleaned = cleaned[4:].strip()
        try:
            return json.loads(cleaned)
        except Exception:  # noqa: BLE001
            return {"_raw": text}


def _normalize_usage(usage: Dict[str, Any]) -> Dict[str, Any]:
    out = {
        "prompt_tokens": usage.get("prompt_tokens") or usage.get("input_tokens") or 0,
        "completion_tokens": usage.get("completion_tokens") or usage.get("output_tokens") or 0,
        "total_tokens": usage.get("total_tokens") or 0,
    }
    if not out["total_tokens"]:
        out["total_tokens"] = out["prompt_tokens"] + out["completion_tokens"]
    return out
