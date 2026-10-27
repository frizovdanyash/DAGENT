#!/usr/bin/env python3
"""
A tiny OpenAI-compatible model that ships with DAGENT.

Two purposes:

* **demo mode** (`scripts/demo.py`) - answers freely so the whole GUI can be
  tried without an API key, a download or an internet connection;
* **test mode** - replays a scripted sequence of tool calls and answers, which
  makes `tests/test_agent_flow.py` and `tests/capture_fixtures.py` deterministic.

Run standalone:   python3 -m dagent.demo_model --demo --port 8611
"""

from __future__ import annotations

import argparse
import json
import threading
import time
import uuid
from typing import Any, Dict, List, Optional

from fastapi import Body, FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI(title="DAGENT mock model")

LOCK = threading.Lock()
STATE: Dict[str, Any] = {
    "script": [],
    "requests": [],
    "calls": 0,
    "demo": False,
}


def set_demo(enabled: bool = True) -> None:
    """Demo mode answers freely (no script) so the GUI can be tried without a model."""
    with LOCK:
        STATE["demo"] = bool(enabled)


def set_script(steps: List[Dict[str, Any]]) -> None:
    with LOCK:
        STATE["script"] = list(steps)
        STATE["requests"] = []
        STATE["calls"] = 0


def next_step(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    with LOCK:
        STATE["calls"] += 1
        if STATE["script"]:
            return STATE["script"].pop(0)
        demo = STATE["demo"]
    if demo:
        return demo_reply(payload or {})
    return {"content": "No more scripted steps - the mock model is done."}


DEMO_TOOL_WORDS = (
    "запусти", "выполни", "команд", "run", "exec", "ls ", "файл", "file", "проект", "project",
    "структур", "покажи", "создай", "create", "write", "напиши", "удали", "delete", "прочитай", "read",
)


def demo_reply(payload: Dict[str, Any]) -> Dict[str, Any]:
    """A tiny deterministic 'model' used by scripts/demo.py.

    It understands one turn of tool use so the GUI can be explored (streaming,
    tool cards, approvals, diffs, plan panel) without any API key or download.
    """
    messages = payload.get("messages") or []
    last_user = ""
    for message in reversed(messages):
        if message.get("role") == "user":
            last_user = str(message.get("content") or "")
            break
    tool_messages = [message for message in messages if message.get("role") == "tool"]
    text = last_user.lower()

    if not tool_messages and any(word in text for word in DEMO_TOOL_WORDS):
        if any(word in text for word in ("структур", "проект", "project", "дерево", "tree", "os")):
            return {"tool_calls": [{"name": "workspace_tree", "arguments": {"depth": 2}}]}
        if any(word in text for word in ("создай", "create", "напиши файл", "write file", "запиши")):
            return {"tool_calls": [{"name": "write_file", "arguments": {
                "path": "DEMO.md",
                "content": "# DEMO\n\nЭтот файл создал DAGENT в демо-режиме.\n\n- агент работает\n- инструменты доступны\n"}}]}
        if any(word in text for word in ("прочитай", "read", "покажи файл")):
            return {"tool_calls": [{"name": "list_dir", "arguments": {"path": "."}}]}
        return {"tool_calls": [{"name": "run_command", "arguments": {
            "command": "echo 'DAGENT demo: привет от локальной модели!' && python3 -V"}}]}

    if tool_messages:
        output = str(tool_messages[-1].get("content") or "").strip()
        snippet = output[:600]
        return {"content": (
            f"Готово! Я выполнил инструмент и получил результат.\n\n"
            f"### Вывод\n\n```text\n{snippet}\n```\n\n"
            f"Это **демо-модель** DAGENT: она работает полностью офлайн и нужна, чтобы показать интерфейс. "
            f"Подключите настоящую модель в настройках (`Ctrl+,` → Модели): API-ключ OpenAI/DeepSeek/OpenRouter "
            f"или локальный GGUF через LM Studio / Ollama / llama.cpp."
        )}

    return {"content": (
        f"Привет! Я **демо-модель DAGENT** - работаю офлайн, без ключей и скачиваний.\n\n"
        f"Вы написали: _{last_user.strip()[:200] or '(пустое сообщение)'}_\n\n"
        f"### Что умеет DAGENT\n\n"
        f"1. Читать, создавать, изменять и удалять файлы в рабочей папке\n"
        f"2. Запускать команды и Python-скрипты (с подтверждением опасных шагов)\n"
        f"3. Держать план задачи, историю сессий и журнал изменений\n"
        f"4. Работать с любой моделью: API (OpenAI, DeepSeek, OpenRouter, Groq, Anthropic...) "
        f"или локальный GGUF (LM Studio, Ollama, llama.cpp)\n\n"
        f"Попробуйте написать: _«покажи структуру проекта»_, _«запусти команду»_ или _«создай файл DEMO.md»_.\n\n"
        f"```python\nprint('DAGENT by @frizovdanya')\n```"
    )}


@app.get("/v1/models")
async def models() -> Dict[str, Any]:
    return {
        "object": "list",
        "data": [
            {"id": "mock-gpt", "object": "model", "owned_by": "dagent-tests"},
            {"id": "mock-coder", "object": "model", "owned_by": "dagent-tests"},
        ],
    }


@app.post("/__inspect")
async def inspect(payload: Dict[str, Any] = Body(default={})) -> Dict[str, Any]:
    """Test helper: replace the script ({"script": [...]}) and reset counters."""
    set_script(payload.get("script") or [])
    return {"ok": True}


@app.get("/__requests")
async def requests_log() -> Dict[str, Any]:
    with LOCK:
        return {"calls": STATE["calls"], "requests": STATE["requests"], "left": len(STATE["script"])}


def _tool_calls_payload(step: Dict[str, Any], model: str) -> Dict[str, Any]:
    calls = []
    for index, call in enumerate(step.get("tool_calls") or []):
        arguments = call.get("arguments")
        if not isinstance(arguments, str):
            arguments = json.dumps(arguments or {}, ensure_ascii=False)
        calls.append(
            {
                "id": call.get("id") or f"call_{uuid.uuid4().hex[:10]}",
                "type": "function",
                "index": index,
                "function": {"name": call["name"], "arguments": arguments},
            }
        )
    content = step.get("content") or ""
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": content,
                    "tool_calls": calls,
                    **({"reasoning_content": step["reasoning"]} if step.get("reasoning") else {}),
                },
                "finish_reason": "tool_calls" if calls else "stop",
            }
        ],
        "usage": {"prompt_tokens": 120, "completion_tokens": 40, "total_tokens": 160},
    }


@app.post("/v1/chat/completions")
async def chat_completions(request: Request, payload: Dict[str, Any] = Body(...)) -> Any:
    model = str(payload.get("model") or "mock-gpt")
    with LOCK:
        STATE["requests"].append(
            {
                "model": model,
                "stream": bool(payload.get("stream")),
                "tools": [tool.get("function", {}).get("name") for tool in payload.get("tools") or []],
                "messages": [
                    {"role": message.get("role"), "content": str(message.get("content") or "")[:400],
                     "tool_calls": bool(message.get("tool_calls")), "tool_call_id": message.get("tool_call_id")}
                    for message in payload.get("messages") or []
                ],
                "temperature": payload.get("temperature"),
                "max_tokens": payload.get("max_tokens"),
            }
        )
    step = next_step(payload)

    if not payload.get("stream"):
        return JSONResponse(_tool_calls_payload(step, model))

    base = _tool_calls_payload(step, model)
    message = base["choices"][0]["message"]

    async def event_stream():
        created = base["created"]
        chunk_id = base["id"]

        def chunk(delta: Dict[str, Any], finish: str | None = None) -> str:
            body = {
                "id": chunk_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
            }
            return f"data: {json.dumps(body, ensure_ascii=False)}\n\n"

        if message.get("reasoning_content"):
            text = str(message["reasoning_content"])
            for part in (text[i:i + 24] for i in range(0, len(text), 24)):
                yield chunk({"role": "assistant", "reasoning_content": part})
        content = str(message.get("content") or "")
        if content:
            yield chunk({"role": "assistant", "content": ""})
            for part in (content[i:i + 12] for i in range(0, len(content), 12)):
                yield chunk({"content": part})
        for call in message.get("tool_calls") or []:
            arguments = call["function"]["arguments"]
            yield chunk({
                "tool_calls": [{
                    "index": call["index"],
                    "id": call["id"],
                    "type": "function",
                    "function": {"name": call["function"]["name"], "arguments": ""},
                }]
            })
            for part in (arguments[i:i + 18] for i in range(0, len(arguments), 18)):
                yield chunk({
                    "tool_calls": [{
                        "index": call["index"],
                        "function": {"arguments": part},
                    }]
                })
        yield chunk({}, base["choices"][0]["finish_reason"])
        final = {
            "id": chunk_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [],
            "usage": base["usage"],
        }
        yield f"data: {json.dumps(final)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


def serve(host: str = "127.0.0.1", port: int = 8599) -> Any:
    """Start the mock server in a daemon thread; returns the uvicorn server."""
    import uvicorn

    config = uvicorn.Config(app, host=host, port=port, log_level="warning", access_log=False)
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True, name="mock-model")
    thread.start()
    deadline = time.time() + 12
    while not server.started and time.time() < deadline:
        time.sleep(0.05)
    if not server.started:
        raise RuntimeError("mock model server did not start")
    return server


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8599)
    parser.add_argument("--demo", action="store_true", help="answer freely instead of replaying a script")
    args = parser.parse_args()
    if args.demo:
        set_demo(True)
    else:
        set_script([
            {"content": "Hello! I am the mock model. Ask me to run a command."},
        ])
    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
