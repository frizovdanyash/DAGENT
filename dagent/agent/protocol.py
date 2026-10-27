"""Tool-calling protocol.

Two ways DAGENT talks to a model:

1. **native** - OpenAI/Anthropic style function calling (``tools`` parameter).
2. **json**   - a strict text protocol for models without function calling
   (most local GGUF files). The model answers with a fenced JSON block, DAGENT
   parses it, runs the tool and sends the result back as a
   ``<tool_result>`` message.

:func:`parse_tool_calls` is deliberately forgiving: it understands fenced JSON,
XML-ish tags, bare JSON objects and a simple ``TOOL:/ARGS:`` form, so even small
7B models can drive the agent.
"""

from __future__ import annotations

import json
import re
import uuid
from typing import Any, Dict, List, Tuple

from ..providers.base import ToolCall

JSON_BLOCK_RE = re.compile(r"```(?:json|JSON)?\s*(\{.*?\}|\[.*?\])\s*```", re.DOTALL)
TOOL_TAG_RE = re.compile(
    r"<(tool_call|toolcall|tool|action|function_call|invoke|dagent_tool)\b[^>]*>(.*?)</\1>",
    re.DOTALL | re.IGNORECASE,
)
THINK_TAG_RE = re.compile(r"<(thinking|think|reasoning|thought)>(.*?)</\1>", re.DOTALL | re.IGNORECASE)
BARE_JSON_RE = re.compile(r"(\{[\s\S]*\}|\[[\s\S]*\])")
LINE_TOOL_RE = re.compile(
    r"^\s*(?:TOOL|ACTION|CALL)\s*:\s*([A-Za-z_][\w.]*)\s*\n\s*(?:ARGS|ARGUMENTS|PARAMS|INPUT)\s*:\s*(\{.*?\}|\[.*?\]|.*)\s*$",
    re.MULTILINE | re.DOTALL,
)
NAME_KEYS = ("tool", "name", "action", "function", "tool_name", "command_name")
ARG_KEYS = ("args", "arguments", "parameters", "params", "input", "kwargs", "options")
FINAL_MARKERS = ("FINAL_ANSWER", "final_answer", "ОТВЕТ:", "ANSWER:")


def tool_doc_block(specs: List[Dict[str, Any]]) -> str:
    """Human/model readable description of the available tools (JSON protocol)."""
    lines: List[str] = []
    for spec in specs:
        params = spec.get("parameters") or {}
        props = params.get("properties") or {}
        required = set(params.get("required") or [])
        signature = []
        for key, schema in props.items():
            kind = schema.get("type", "string")
            if kind == "array":
                item_kind = (schema.get("items") or {}).get("type", "string")
                kind = f"array<{item_kind}>"
            marker = "*" if key in required else ""
            signature.append(f"{key}{marker}: {kind}")
        lines.append(f"- {spec['name']}({', '.join(signature)})")
        lines.append(f"    {spec.get('description', '').strip()}")
        enum_notes = []
        for key, schema in props.items():
            if schema.get("enum"):
                enum_notes.append(f"{key} ∈ {'|'.join(str(v) for v in schema['enum'])}")
        if enum_notes:
            lines.append("    " + "; ".join(enum_notes))
    return "\n".join(lines)


def system_prompt_tools_section(specs: List[Dict[str, Any]]) -> str:
    return (
        "## Tools you can use\n"
        f"{tool_doc_block(specs)}\n\n"
        "## How to call a tool\n"
        "When you need a tool, reply with ONLY a fenced JSON block and nothing else:\n"
        "```json\n"
        '{"tool": "run_command", "args": {"command": "ls -la"}}\n'
        "```\n"
        "Rules:\n"
        "1. One tool call per message. Wait for the result before the next step.\n"
        "2. Use exact tool names and argument names from the list above (marked * = required).\n"
        "3. Valid JSON only: double quotes, no comments, no trailing commas.\n"
        "4. After the tool result arrives (inside <tool_result> tags), continue: call another tool "
        "or write the final answer in plain text/markdown.\n"
        "5. Never invent tool output yourself and never claim you ran something you did not.\n"
        "6. When the task is complete, answer normally - no JSON block.\n"
    )


def extract_thinking(text: str) -> Tuple[str, str]:
    """Split ``<thinking>...</thinking>`` blocks out of the visible answer."""
    if not text:
        return "", ""
    thoughts: List[str] = []

    def repl(match: re.Match) -> str:
        thoughts.append(match.group(2).strip())
        return ""

    cleaned = THINK_TAG_RE.sub(repl, text).strip()
    return cleaned, "\n\n".join(thoughts).strip()


def _coerce_args(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return {}
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict):
                return parsed
            return {"value": parsed}
        except json.JSONDecodeError:
            return {"command": text} if len(text.split()) > 1 else {"value": text}
    if value is None:
        return {}
    return {"value": value}


def _make_call(name: Any, args: Any, origin: str, raw: str = "") -> ToolCall:
    if isinstance(name, dict):
        payload = name
        resolved_name = None
        for key in NAME_KEYS:
            if payload.get(key):
                resolved_name = payload[key]
                break
        if resolved_name is None and payload.get("function"):
            resolved_name = (payload.get("function") or {}).get("name")
            args = args or (payload.get("function") or {}).get("arguments")
        if resolved_name is None:
            for key in ARG_KEYS:
                if key in payload:
                    args = payload[key]
                    break
        name = resolved_name
    if isinstance(name, str) and name.startswith("{"):
        try:
            return _make_call(json.loads(name), args, origin, raw)
        except json.JSONDecodeError:
            pass
    if not isinstance(name, str) or not name.strip():
        return ToolCall(id="", tool="", args={}, raw=raw, origin=origin)
    tool_name = name.strip().split(".")[-1]
    return ToolCall(
        id=f"tc_{uuid.uuid4().hex[:10]}",
        tool=tool_name,
        args=_coerce_args(args),
        raw=raw,
        origin=origin,
    )


def parse_tool_calls(text: str) -> Tuple[str, List[ToolCall]]:
    """Find tool calls in a model reply. Returns ``(visible_text, calls)``."""
    if not text or not text.strip():
        return text or "", []
    calls: List[ToolCall] = []
    remaining = text

    # 1) explicit tags ----------------------------------------------------- #
    def tag_repl(match: re.Match) -> str:
        body = match.group(2).strip()
        calls.extend(_calls_from_body(body, origin="xml", raw=body))
        return ""

    remaining = TOOL_TAG_RE.sub(tag_repl, remaining)
    if calls:
        return _tidy(remaining), calls

    # 2) fenced json blocks ------------------------------------------------ #
    def fence_repl(match: re.Match) -> str:
        body = match.group(1).strip()
        found = _calls_from_body(body, origin="json", raw=body)
        if found:
            calls.extend(found)
            return ""
        return match.group(0)

    remaining = JSON_BLOCK_RE.sub(fence_repl, remaining)
    if calls:
        return _tidy(remaining), calls

    # 3) TOOL: / ARGS: line form ------------------------------------------- #
    line_match = LINE_TOOL_RE.search(remaining)
    if line_match:
        name = line_match.group(1).strip()
        body = line_match.group(2).strip()
        try:
            args = json.loads(body)
        except json.JSONDecodeError:
            args = _coerce_args(body)
        calls.append(_make_call(name, args, origin="line", raw=body))
        remaining = remaining[: line_match.start()] + remaining[line_match.end():]
        return _tidy(remaining), calls

    # 4) bare JSON object that looks like a call ----------------------------- #
    stripped = remaining.strip()
    if stripped.startswith("{") or stripped.startswith("["):
        body = stripped
        found = _calls_from_body(body, origin="json", raw=body, strict=True)
        if found:
            return "", found
    for match in BARE_JSON_RE.finditer(remaining):
        body = match.group(1).strip()
        if len(body) < 12:
            continue
        found = _calls_from_body(body, origin="json", raw=body, strict=True)
        if found:
            calls.extend(found)
            remaining = remaining.replace(match.group(0), "", 1)
            break
    return _tidy(remaining), calls


def _calls_from_body(body: str, origin: str, raw: str = "", strict: bool = False) -> List[ToolCall]:
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        repaired = _repair_json(body)
        try:
            parsed = json.loads(repaired)
        except json.JSONDecodeError:
            return []
    candidates = parsed if isinstance(parsed, list) else [parsed]
    calls: List[ToolCall] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        name = None
        for key in NAME_KEYS:
            if candidate.get(key):
                name = candidate[key]
                break
        if name is None and isinstance(candidate.get("function"), dict):
            name = candidate["function"].get("name")
        if not name:
            if strict and len(candidate) == 1:
                only_key = next(iter(candidate))
                name = only_key
                args = candidate[only_key]
                call = _make_call(name, args, origin, raw)
                if call.tool:
                    calls.append(call)
            continue
        args: Any = None
        for key in ARG_KEYS:
            if key in candidate:
                args = candidate[key]
                break
        if args is None and isinstance(candidate.get("function"), dict):
            args = candidate["function"].get("arguments")
        call = _make_call(name, args, origin, raw if not isinstance(raw, str) else raw)
        if call.tool:
            calls.append(call)
    return calls


def _repair_json(text: str) -> str:
    """Best-effort fixes for the JSON small models tend to produce."""
    cleaned = text.strip()
    if cleaned.startswith("json"):
        cleaned = cleaned[4:].strip()
    cleaned = re.sub(r"//[^\n]*", "", cleaned)
    cleaned = re.sub(r",(\s*[}\]])", r"\1", cleaned)
    cleaned = cleaned.replace("\u201c", '"').replace("\u201d", '"').replace("\u2018", "'").replace("\u2019", "'")
    if cleaned.count("{") > cleaned.count("}"):
        cleaned += "}" * (cleaned.count("{") - cleaned.count("}"))
    if cleaned.count("[") > cleaned.count("]"):
        cleaned += "]" * (cleaned.count("[") - cleaned.count("]"))
    return cleaned


def _tidy(text: str) -> str:
    return re.sub(r"\n{3,}", "\n\n", text or "").strip()


def is_final_answer(text: str) -> bool:
    stripped = (text or "").strip()
    return any(stripped.startswith(marker) for marker in FINAL_MARKERS)


def strip_final_marker(text: str) -> str:
    stripped = (text or "").strip()
    for marker in FINAL_MARKERS:
        if stripped.startswith(marker):
            return stripped[len(marker):].lstrip(" :\-")
    return text


def wrap_tool_result(tool_name: str, output: str, ok: bool = True, call_id: str = "") -> str:
    """Message content used when tool results go back through the text protocol."""
    status = "ok" if ok else "error"
    attrs = f' tool="{tool_name}" status="{status}"'
    if call_id:
        attrs += f' id="{call_id}"'
    return f"<tool_result{attrs}>\n{output}\n</tool_result>"
