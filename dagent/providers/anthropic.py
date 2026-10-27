"""Native Anthropic (Claude) Messages API backend with streaming + tool use."""

from __future__ import annotations

import json
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx

from .base import BaseProvider, Chunk, ProviderError, ToolCall

ANTHROPIC_VERSION = "2023-06-01"


class AnthropicProvider(BaseProvider):
    kind = "anthropic"

    def __init__(self, profile: Dict[str, Any], settings: Any = None) -> None:
        super().__init__(profile, settings)
        self.base_url = (profile.get("base_url") or "https://api.anthropic.com").rstrip("/")
        caps = profile.get("capabilities") or {}
        self.native_tools = caps.get("native_tools", True)

    def _headers(self) -> Dict[str, str]:
        from ..config import expand_secret

        key = expand_secret(str(self.profile.get("api_key") or "").strip())
        headers = {
            "content-type": "application/json",
            "anthropic-version": ANTHROPIC_VERSION,
        }
        if key:
            headers["x-api-key"] = key
        for name, value in (self.profile.get("extra_headers") or {}).items():
            if value:
                headers[str(name)] = str(value)
        return headers

    def _payload(self, messages: List[Dict[str, Any]], tools: Optional[List[Dict[str, Any]]],
                 params: Dict[str, Any]) -> Dict[str, Any]:
        system_parts: List[str] = []
        wire: List[Dict[str, Any]] = []
        for message in messages:
            role = message.get("role")
            content = message.get("content") or ""
            if role == "system":
                if content:
                    system_parts.append(content)
                continue
            if role == "tool":
                wire.append(
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": message.get("tool_call_id") or "",
                                "content": content if isinstance(content, str) else json.dumps(content, ensure_ascii=False),
                            }
                        ],
                    }
                )
                continue
            blocks: List[Dict[str, Any]] = []
            for call in message.get("tool_calls") or []:
                blocks.append(
                    {
                        "type": "tool_use",
                        "id": call.get("id") or "",
                        "name": call.get("tool") or "",
                        "input": call.get("args") or {},
                    }
                )
            if content:
                blocks.insert(0, {"type": "text", "text": content})
            if not blocks:
                blocks = [{"type": "text", "text": ""}]
            wire.append({"role": "assistant" if role == "assistant" else "user", "content": blocks})
        # Anthropic requires alternating roles; merge consecutive same-role turns.
        merged: List[Dict[str, Any]] = []
        for item in wire:
            if merged and merged[-1]["role"] == item["role"]:
                merged[-1]["content"] = list(merged[-1]["content"]) + list(item["content"])
            else:
                merged.append(item)
        if not merged:
            merged = [{"role": "user", "content": [{"type": "text", "text": ""}]}]
        if merged[0]["role"] != "user":
            merged.insert(0, {"role": "user", "content": [{"type": "text", "text": "(continue)"}]})

        payload: Dict[str, Any] = {
            "model": self.model_id,
            "messages": merged,
            "max_tokens": int(params.get("max_tokens") or 2048),
            "stream": True,
        }
        if system_parts:
            payload["system"] = "\n\n".join(system_parts)
        if params.get("temperature") is not None:
            payload["temperature"] = float(params["temperature"])
        if params.get("top_p"):
            payload["top_p"] = float(params["top_p"])
        stop = params.get("stop_sequences") or []
        if stop:
            payload["stop_sequences"] = list(stop)[:4]
        if tools and self.native_tools is not False:
            payload["tools"] = [
                {
                    "name": tool["name"],
                    "description": tool.get("description", ""),
                    "input_schema": tool.get("parameters") or {"type": "object", "properties": {}},
                }
                for tool in tools
            ]
        for key, value in (self.profile.get("extra_body") or {}).items():
            payload[key] = value
        return payload

    async def stream(self, messages: List[Dict[str, Any]], tools: Optional[List[Dict[str, Any]]] = None,
                     params: Optional[Dict[str, Any]] = None) -> AsyncIterator[Chunk]:
        params = self.params(params)
        if not str(self.profile.get("api_key") or "").strip():
            raise ProviderError("Anthropic API key is missing", hint="Settings -> Models -> API key", code="missing_key")
        url = f"{self.base_url}/v1/messages"
        timeout = float(params.get("request_timeout") or 300)
        payload = self._payload(messages, tools, params)
        tool_uses: Dict[int, Dict[str, Any]] = {}
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=20.0)) as client:
                async with client.stream("POST", url, headers=self._headers(), json=payload) as response:
                    if response.status_code >= 400:
                        body = (await response.aread()).decode("utf-8", "replace")
                        try:
                            data = json.loads(body)
                            message = data.get("error", {}).get("message") or body[:300]
                        except Exception:  # noqa: BLE001
                            message = body[:300]
                        hint = ""
                        if response.status_code in (401, 403):
                            hint = "Check the x-api-key value in Settings -> Models."
                        elif response.status_code == 429:
                            hint = "Rate limited - wait or switch model."
                        raise ProviderError(f"HTTP {response.status_code}: {message}", hint=hint,
                                            code=f"http_{response.status_code}")
                    async for line in response.aiter_lines():
                        line = (line or "").strip()
                        if not line.startswith("data:"):
                            continue
                        try:
                            event = json.loads(line[5:].strip())
                        except json.JSONDecodeError:
                            continue
                        etype = event.get("type")
                        if etype == "message_start":
                            usage = (event.get("message") or {}).get("usage") or {}
                            if usage:
                                yield Chunk(kind="usage", usage={
                                    "prompt_tokens": usage.get("input_tokens", 0),
                                    "completion_tokens": usage.get("output_tokens", 0),
                                    "total_tokens": usage.get("input_tokens", 0) + usage.get("output_tokens", 0),
                                })
                        elif etype == "content_block_start":
                            block = event.get("content_block") or {}
                            if block.get("type") == "tool_use":
                                tool_uses[int(event.get("index", 0))] = {
                                    "id": block.get("id", ""),
                                    "name": block.get("name", ""),
                                    "json": "",
                                }
                        elif etype == "content_block_delta":
                            delta = event.get("delta") or {}
                            dtype = delta.get("type")
                            if dtype == "text_delta" and delta.get("text"):
                                yield Chunk(kind="text", text=delta["text"])
                            elif dtype == "thinking_delta" and delta.get("thinking"):
                                yield Chunk(kind="reasoning", text=delta["thinking"])
                            elif dtype == "input_json_delta":
                                slot = tool_uses.get(int(event.get("index", 0)))
                                if slot is not None:
                                    slot["json"] += delta.get("partial_json", "")
                        elif etype == "message_delta":
                            usage = event.get("usage") or {}
                            if usage.get("output_tokens"):
                                yield Chunk(kind="usage", usage={
                                    "completion_tokens": usage["output_tokens"],
                                    "total_tokens": usage["output_tokens"],
                                })
                            stop_reason = (event.get("delta") or {}).get("stop_reason")
                            if stop_reason:
                                yield Chunk(kind="meta", meta={"finish_reason": stop_reason})
                        elif etype == "error":
                            yield Chunk(kind="error", error=str((event.get("error") or {}).get("message", "error")))
                            return
        except ProviderError:
            raise
        except httpx.ConnectError as exc:
            raise ProviderError(f"Cannot reach {url}: {exc}", hint="Check your network / proxy settings.",
                                code="connect_error") from exc
        except httpx.TimeoutException as exc:
            raise ProviderError("Request timed out", hint="Increase timeout in Settings -> Agent", code="timeout") from exc
        except httpx.HTTPError as exc:
            raise ProviderError(f"HTTP error: {type(exc).__name__}: {exc}", code="http_error") from exc

        calls: List[ToolCall] = []
        for index in sorted(tool_uses):
            slot = tool_uses[index]
            if not slot["name"]:
                continue
            try:
                args = json.loads(slot["json"]) if slot["json"] else {}
            except json.JSONDecodeError:
                args = {"_raw": slot["json"]}
            calls.append(ToolCall(id=slot["id"] or f"toolu_{index}", tool=slot["name"], args=args,
                                  raw=slot["json"], origin="native"))
        if calls:
            yield Chunk(kind="tool_calls", tool_calls=calls)
        yield Chunk(kind="done", meta={"tools_emitted": bool(calls)})

    async def list_remote_models(self) -> List[str]:
        url = f"{self.base_url}/v1/models"
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                response = await client.get(url, headers=self._headers())
                if response.status_code >= 400:
                    return [
                        "claude-sonnet-4-5", "claude-opus-4-1", "claude-3-5-haiku-latest",
                    ]
                data = response.json()
        except Exception:  # noqa: BLE001
            return ["claude-sonnet-4-5", "claude-3-5-haiku-latest"]
        return [str(item.get("id")) for item in (data.get("data") or []) if item.get("id")]
