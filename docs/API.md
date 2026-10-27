# API

DAGENT - это локальный веб-сервер (FastAPI) + интерфейс без сборки. Всё, что умеет интерфейс, доступно и по HTTP/WebSocket: можно писать свои скрипты, боты, плагины или управлять агентом из другого редактора.

* База: `http://127.0.0.1:8420` (порт из `app.port`)
* Аутентификация: заголовок `X-DAGENT-Token: <app.token_secret>`; для WebSocket - `?token=<...>`
* Без токена доступны только `GET /api/health` и `GET /api/ping`
* Swagger (при `app.dev_mode = true`): `/api/docs`
* Все тела и ответы - JSON в UTF-8

```bash
TOKEN=$(python -c "import json,os;print(json.load(open(os.path.expanduser('~/.dagent/settings.json')))['app']['token_secret'])")
curl -s -H "X-DAGENT-Token: $TOKEN" http://127.0.0.1:8420/api/state | python -m json.tool | head -40
```

---

## 1. Основное

| Метод | Путь | Назначение |
| --- | --- | --- |
| `GET` | `/api/health` | Жив ли сервер (без токена) |
| `GET` | `/api/ping` | То же + версия (без токена) |
| `GET` | `/api/state` | **Главный вызов**: всё состояние одним ответом |
| `GET` | `/api/settings` | Документ настроек (секреты маскируются) |
| `PUT` | `/api/settings` | Частичное обновление (глубокое слияние) |
| `POST` | `/api/settings/reset` | `{keep_models: true}` - сброс к значениям по умолчанию |
| `GET` | `/api/settings/schema` | Значения по умолчанию - для подсказок и валидации |
| `POST` | `/api/settings/export` | Экспорт настроек |
| `POST` | `/api/settings/import` | Импорт `{settings: {...}}` |

`GET /api/state` возвращает:

```json
{
  "version": "1.0.0", "author": "frizovdanya", "author_tg": "@frizovdanya",
  "settings": { "...": "публичный документ настроек" },
  "defaults": { "...": "значения по умолчанию" },
  "modes": [ {"id": "assistant", "name": "Ассистент", "tools": ["..."], "auto_approve": false} ],
  "active_model": { "id": "...", "name": "...", "kind": "api" },
  "models": [ "...профили..." ],
  "sessions": [ "...последние сессии..." ], "session_count": 12,
  "tools": [ {"name": "run_command", "description": "...", "category": "system", "render": "command", "parameters": {}} ],
  "providers": {"openai": "https://api.openai.com/v1", "...": "..."},
  "workspace": {"root": "/home/user/DAGENTWorkspace", "exists": true, "files": 42, "size": 123456},
  "system": {"platform": "linux", "python": "3.11.2", "cpu_count": 8, "ram_gb": 16},
  "info": {"gguf": {"installed": false, "hint": "..."}, "pending": 0, "active_runs": 0},
  "hotkeys": {"send": "Enter", "...": "..."},
  "pending": []
}
```

Имена режимов и инструментов приходят **уже переведёнными** на язык из `app.language`.

---

## 2. Чат и сессии

| Метод | Путь | Тело / параметры |
| --- | --- | --- |
| `POST` | `/api/chat` | `{text, session_id?, mode?, model_id?, attachments?, workspace?, regenerate_from?}` |
| `POST` | `/api/chat` | `{message: "..."}` - то же самое, синоним поля |
| `GET` | `/api/sessions` | `?limit=&q=` - список сессий |
| `POST` | `/api/sessions` | `{title?, workspace?, mode?, model_id?}` - новая сессия |
| `GET` | `/api/sessions/{id}` | Сессия + все сообщения |
| `PATCH` | `/api/sessions/{id}` | `{title?, mode?, model_id?, workspace?, pinned?, tags?}` |
| `DELETE` | `/api/sessions/{id}` | Удалить сессию |
| `POST` | `/api/sessions/{id}/duplicate` | Копия сессии |
| `POST` | `/api/sessions/{id}/clear` | Очистить сообщения, сохранив сессию |
| `GET` | `/api/sessions/{id}/export` | Скачать `.json` (или `.md` - `?format=markdown`) |
| `POST` | `/api/sessions/import` | Загрузить сессию из JSON |
| `POST` | `/api/sessions/{id}/retry-last` | Повторить последний ответ |
| `PATCH` | `/api/messages/{id}` | `{text?, role?}` - правка сообщения |
| `DELETE` | `/api/messages/{id}` | Удалить сообщение |
| `POST` | `/api/messages/{id}/regenerate` | Перегенерировать с этого места |
| `POST` | `/api/attachments/upload` | `multipart/form-data`, поле `files` |
| `POST` | `/api/quick-title` | `{text}` - короткое название для сессии |
| `POST` | `/api/summarize-session/{id}` | Сжать историю сессии моделью |

`POST /api/chat` отвечает `{ok, run_id, session_id, session}` и сразу запускает агентный цикл в фоне. Поток событий идёт по WebSocket или через `GET /api/runs/{run_id}/events`.

Ошибки: `409` - нет активной модели или уже есть выполняющаяся задача; `400` - пустое сообщение.

---

## 3. Выполнение (runs)

| Метод | Путь | Назначение |
| --- | --- | --- |
| `GET` | `/api/runs` | Активные и недавние выполнения |
| `GET` | `/api/runs/{run_id}/events` | `?since=<номер>&wait=<сек>` - long-polling событий |
| `POST` | `/api/runs/{run_id}/stop` | Остановить выполнение |
| `POST` | `/api/runs/stop-all` | Остановить всё |

`/api/runs/{id}/events` удобен для скриптов без WebSocket: передайте `since=0&wait=30`, получите пачку событий и новый курсор.

---

## 4. Подтверждения и вопросы

| Метод | Путь | Тело |
| --- | --- | --- |
| `GET` | `/api/interactions` | Список ожидающих решений |
| `POST` | `/api/interactions/{call_id}` | `{approved, scope, note?, answer?, cancelled?}` |

`scope`: `once` \| `session_tool` \| `session_command` \| `session_folder` \| `always`.

Для вопроса модели (`ask_user`) отправьте `{approved: true, answer: "вариант B"}`.

---

## 5. Модели

| Метод | Путь | Назначение |
| --- | --- | --- |
| `GET` | `/api/models` | Все профили (ключи маскируются) |
| `GET` | `/api/models/presets` | 18 готовых пресетов провайдеров |
| `POST` | `/api/models` | Создать профиль (по умолчанию сразу активирует его; `"activate": false` - не активировать) |
| `PUT` | `/api/models/{id}` | Обновить (пустой/маскированный `api_key` сохраняет старый) |
| `DELETE` | `/api/models/{id}` | Удалить |
| `POST` | `/api/models/{id}/duplicate` | Скопировать профиль |
| `POST` | `/api/models/{id}/activate` | Сделать активной |
| `POST` | `/api/models/{id}/test` | Проверить: короткий запрос к модели |
| `GET` | `/api/models/{id}/remote` | Список моделей у провайдера |
| `POST` | `/api/models/probe` | Проверить несохранённый профиль; `{"list_only": true}` - только список моделей |
| `GET` | `/api/models/gguf/status` | Установлен ли `llama-cpp-python`, что загружено |
| `POST` | `/api/models/gguf/scan` | `{dirs?, recursive?, save_dirs?}` - найти `.gguf` |
| `POST` | `/api/models/gguf/preload` | `{profile_id}` - заранее загрузить модель в память |
| `POST` | `/api/models/gguf/unload` | Выгрузить всё из кэша |

Создание API-профиля:

```bash
curl -s -X POST http://127.0.0.1:8420/api/models \
  -H "X-DAGENT-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"DeepSeek","provider_preset":"deepseek","api_key":"sk-...","model":"deepseek-chat",
       "capabilities":{"native_tools":true,"context_window":65536}}'
```

Создание GGUF-профиля:

```bash
curl -s -X POST http://127.0.0.1:8420/api/models \
  -H "X-DAGENT-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"gguf","gguf_path":"~/models/qwen2.5-coder-7b-instruct-q4_k_m.gguf",
       "gguf_options":{"n_ctx":16384,"n_gpu_layers":-1}}'
```

---

## 6. Рабочая папка и файлы

| Метод | Путь | Назначение |
| --- | --- | --- |
| `GET` | `/api/workspace` | Текущая папка, число файлов, размер |
| `POST` | `/api/workspace` | `{root, create?}` - сменить рабочую папку |
| `GET` | `/api/workspace/tree` | `?depth=3&path=` - дерево (для панели «Файлы») |
| `GET` | `/api/fs/browse` | `?path=&show_hidden=` - просмотр любой папки (для диалога выбора) |
| `GET` | `/api/fs/gguf` | `?path=&recursive=` - поиск `.gguf` |
| `GET` | `/api/fs/file` | `?path=&max_bytes=` - прочитать файл (вне папки - только с `workspace.allow_read_outside`) |
| `GET` | `/api/fs/open` | `?path=` - показать в системном файловом менеджере |
| `GET` | `/api/search` | `?q=&limit=` - поиск по сессиям и сообщениям |
| `GET` | `/api/audit` | `?limit=200` - журнал действий |
| `GET` | `/api/modes` | Режимы (локализованные) + активный |
| `POST` | `/api/modes` | Добавить свой режим |
| `POST` | `/api/terminal` | `{command, cwd?, session_id?, timeout?}` - выполнить команду от имени пользователя |

`POST /api/terminal` - это встроенный терминал: команда проходит через тот же `SafetyEngine` (блокировки и классификация риска действуют), но выполняется по вашему действию, а не по решению модели.

---

## 7. WebSocket `/ws`

Подключение: `ws://127.0.0.1:8420/ws?token=<token>`.

Сразу после подключения сервер присылает `hello`:

```json
{"kind": "hello", "data": {"version": "1.0.0", "info": {}, "system": {},
  "pending": [], "active_runs": 0, "recent_events": [ "...последние события..." ]}}
```

Клиент может отправлять:

```json
{"kind": "ping"}
{"kind": "resolve", "call_id": "abc123", "approved": true, "scope": "once"}
{"kind": "stop", "run_id": "abc123"}
```

### Формат события

```json
{"id": 42, "kind": "token", "ts": 1730000000.123, "run_id": "r1", "session_id": "s1",
 "data": {"text": "Привет"}}
```

### Все виды событий

| `kind` | `data` |
| --- | --- |
| `run.start` | `{run, model, mode, protocol, tools[]}` |
| `run.end` | `{run, session, stop_reason, elapsed_ms}` |
| `status` | `{text, iteration?, tokens?, context?, compressed?}` - человекочитаемый статус |
| `context` | `{history_messages, estimated_tokens, context_window, compressed}` |
| `assistant.start` | `{message_id}` |
| `token` | `{text}` - кусок ответа |
| `reasoning` | `{text}` - «размышления» модели |
| `tool.start` | `{id, tool, args, risk, reason, description}` |
| `tool.progress` | `{tool, stream, text}` - поток вывода команды |
| `tool.result` | полная запись инструмента (см. ниже) |
| `plan` | `{steps: [{title, detail?, status}]}` |
| `message.saved` / `message.updated` / `message.deleted` | `{message}` / `{message_id}` |
| `session.created` / `session.updated` / `session.deleted` / `session.cleared` / `session.truncated` | `{session}` |
| `approval.required` / `question.required` | `{call_id, tool?, args?, risk?, reason?, description?, preview?}` |
| `log` | `{level, text}` |
| `error` | `{message, hint}` |
| `models.changed` | `{profiles, active_id}` |
| `model.active` | `{profile}` |
| `model.tested` | `{ok, profile_id, latency_ms, error?, hint?}` |
| `terminal.command` | `{command, ok, session_id}` |

Запись `tool.result`:

```json
{"id": "call_1", "tool": "run_command", "args": {"command": "ls -la"},
 "origin": "model", "started_at": 1730000000.0, "risk": "low", "reason": "Simple read-only style command",
 "ok": true, "output": "total 8\n...", "data": {"exit_code": 0},
 "render": "command", "error": "", "status": "done", "duration_ms": 42}
```

`status`: `done` \| `error` \| `blocked` \| `denied`.

---

## 8. Мини-пример: задача из скрипта

```python
import json, os, urllib.request

BASE = "http://127.0.0.1:8420"
TOKEN = json.load(open(os.path.expanduser("~/.dagent/settings.json")))["app"]["token_secret"]


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                headers={"X-DAGENT-Token": TOKEN, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


# 1) запускаем задачу
run = call("POST", "/api/chat", {"text": "Покажи структуру рабочей папки", "mode": "analyst"})

# 2) собираем события long-polling'ом
since, answer = 0, ""
while True:
    batch = call("GET", f"/api/runs/{run['run_id']}/events?since={since}&wait=15")
    for event in batch["events"]:
        since = max(since, event["id"])
        if event["kind"] == "token":
            answer += event["data"].get("text", "")
        if event["kind"] == "run.end":
            print("готово за", event["data"].get("elapsed_ms"), "мс")
            print(answer)
            raise SystemExit
```

Тот же сценарий с WebSocket - см. `tests/test_websocket.py` (это живой тест, который поднимает сервер и проходит весь цикл: сообщение -> инструменты -> подтверждение -> ответ).

---

## 9. Коды ответов

| Код | Когда |
| --- | --- |
| `200` | Успех |
| `400` | Неверное тело запроса |
| `403` | Нет токена, чужой `Origin`, чтение вне рабочей папки запрещено |
| `404` | Сессия/профиль/файл не найдены |
| `409` | Нет активной модели или задача уже выполняется |
| `500` | Внутренняя ошибка (приходит и событием `error` с подсказкой) |
