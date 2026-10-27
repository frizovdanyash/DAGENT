# Разработка

Как устроен DAGENT, как его запускать из исходников и как проверять изменения.

---

## Стек

| Слой | Технология |
| --- | --- |
| Сервер | Python 3.10+, FastAPI, uvicorn, httpx |
| Хранилище | SQLite (сессии, сообщения, журнал) + JSON-файл настроек |
| Интерфейс | Vanilla JS (ES-модули), свои CSS-переменные, без сборки и без CDN |
| Локальные модели | `llama-cpp-python` (опционально) |
| Тесты | `unittest`-подобные скрипты на Python + jsdom для интерфейса |

Никакого фронтенд-фреймворка и никакого шага сборки: `dagent/web/` раздаётся как есть, поэтому интерфейс работает офлайн и открывается мгновенно.

---

## Запуск из исходников

```bash
git clone https://github.com/frizovdanyash/DAGENT.git
cd DAGENT
python -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python run.py                                          # http://127.0.0.1:8420
```

Флаги `run.py` (все необязательные - остальное настраивается в интерфейсе):

```bash
python run.py --host 0.0.0.0 --port 9000   # адрес и порт
python run.py --workspace ~/projects/demo  # рабочая папка
python run.py --language en                # язык интерфейса (ru | en)
python run.py --no-browser                 # не открывать браузер
python run.py --dev                        # dev_mode: Swagger, CORS *, без токена
python run.py --reload                     # автоперезагрузка при правках кода
python run.py --home ~/.dagent-test        # другая папка данных
python run.py --print-token                # напечатать токен GUI и выйти
python run.py --version
```

То же самое через модуль: `python -m dagent`. Офлайн-демо запускается отдельно: `python scripts/demo.py`.

---

## Структура

```
DAGENT/
├── run.py                      точка входа (парсинг флагов, запуск uvicorn)
├── requirements.txt
├── scripts/
│   ├── install.sh|.bat         установка зависимостей
│   ├── start.sh|.bat           обычный запуск
│   ├── demo.py                 офлайн-демо: демо-модель + примеры файлов
│   └── demo.bat
├── dagent/
│   ├── app.py                  сборка FastAPI: middleware, lifespan, раздача web/
│   ├── config.py               DEFAULTS (117 настроек) и синглтон Settings
│   ├── paths.py                где живут ~/.dagent, БД, логи
│   ├── state.py                общее состояние: store, settings, runs, pending
│   ├── store.py                SQLite: сессии, сообщения, журнал, поиск
│   ├── events.py               Hub - публикация событий в WebSocket
│   ├── demo_model.py           встроенная OpenAI-совместимая демо-модель
│   ├── providers/
│   │   ├── base.py             ProviderError, интерфейс провайдера
│   │   ├── openai_compat.py    18 пресетов, SSE-стриминг, tool-дельты
│   │   ├── anthropic.py        нативный API Anthropic
│   │   └── gguf.py             llama-cpp-python: загрузка, кэш, чат-форматы
│   ├── agent/
│   │   ├── modes.py            6 режимов + локализация названий
│   │   ├── safety.py           SafetyEngine: песочница, риски, подтверждения
│   │   ├── tools.py            17 инструментов и их рендер-схемы
│   │   ├── protocol.py         native (function calling) и json-протокол
│   │   ├── prompts.py          системные промпты, память, окружение
│   │   └── loop.py             AgentRunner: цикл «модель -> инструменты -> ответ»
│   ├── api/
│   │   ├── core.py             /api/state, settings, workspace, fs, audit, search
│   │   ├── models.py           /api/models/*, GGUF
│   │   ├── chat.py             /api/chat, сессии, runs, interactions, terminal
│   │   └── ws.py               /ws
│   └── web/
│       ├── index.html          каркас (262 строки)
│       ├── css/                tokens, base, layout, components (1642 строки)
│       └── js/                 23 модуля (8282 строки): api, state, events, i18n,
│                               theme, markdown, highlight, icons, boot + ui/*
├── tests/
│   ├── README.md               как устроены тесты и что именно они проверяют
│   ├── test_agent_flow.py      118 проверок бэкенда (in-process ASGI)
│   ├── test_websocket.py       28 проверок живого сервера и WebSocket
│   ├── test_frontend.mjs       87 проверок интерфейса (jsdom)
│   ├── capture_fixtures.py     запись фикстур для jsdom-тестов
│   └── fixtures/               снятые ответы API (~120 КБ, в репозитории)
├── docs/                       документация + баннер и логотип (assets/)
├── LICENSE                     MIT
└── .gitignore
```

Объём: ~7 300 строк Python в `dagent/`, ~1 100 в тестах и скриптах, ~9 900 строк фронтенда.

---

## Как это работает внутри

### Поток одной задачи

```
POST /api/chat {text, mode, model_id}
   └─ RunManager.start() -> AgentRunner
        ├─ prompts.build_system(...)       режим + окружение + дерево + MEMORY.md
        ├─ protocol.specs_for_prompt(...)  инструменты под возможности модели
        ├─ provider.stream(messages, tools)
        │     └─ события: token / reasoning / tool.start
        ├─ SafetyEngine.decide(tool, args)
        │     ├─ allowed          -> tools.dispatch(...)
        │     ├─ needs_approval   -> pending + событие approval.required (цикл ждёт)
        │     └─ blocked          -> отказ с причиной, модель видит его
        ├─ результат инструмента -> в историю (+ meta.tool_calls для восстановления)
        ├─ update_plan -> событие plan
        └─ повторять до отсутствия вызовов или до agent.max_iterations
   события идут в Hub -> WebSocket -> интерфейс
```

### Ключевые решения

* **Один источник событий.** Бэкенд ничего не знает про UI: он публикует события (`hub.emit`), а интерфейс на них подписан. Поэтому API, WebSocket и jsdom-тесты видят одну и ту же картину.
* **Инструменты декларативны.** Каждый инструмент - функция `async def tool_x(ctx, args) -> ToolResult` плюс `ToolSpec` с JSON-схемой, категорией и типом рендера. Добавить инструмент = добавить две записи и указать его в режимах.
* **Два протокола инструментов.** `native` - настоящий function calling; `json` - текстовый протокол для моделей без него. Выбор автоматический (`agent.tool_protocol = auto`) по флагу `capabilities.native_tools`.
* **История восстанавливается.** Ответы ассистента хранятся вместе с `meta.tool_calls` и `meta.tool_results` (вывод обрезается до 20 000 символов), поэтому при открытии старой сессии карточки инструментов рисуются заново, а модель получает полный контекст.
* **Настройки - глубокое слияние.** `PUT /api/settings` принимает только изменившиеся ветки; `Settings.set("ui.theme", "nord")` сохраняет сразу.
* **Интерфейс без сборки.** Модули ES, никаких импортов из `node_modules`, никаких внешних шрифтов и CDN - всё офлайн.

---

## Тесты

Три независимых набора. Все запускаются из корня репозитория и не требуют интернета. Подробный разбор каждого набора - что именно проверяется и какие есть подводные камни - в **[tests/README.md](../tests/README.md)**.

### 1. Бэкенд, 118 проверок

```bash
python tests/test_agent_flow.py
```

Поднимает приложение in-process через `httpx.ASGITransport` и встроенную демо-модель (`dagent/demo_model.py`), поэтому настоящий сервер и сеть не нужны. Проверяет раздачу интерфейса и внедрение токена, `/api/state`, профили моделей (создание, маска ключа, список моделей у провайдера, `probe`, `test`, активация, дублирование, удаление, GGUF-статус), сессии, полный агентный прогон со всеми событиями и счётчиками, сохранение вызовов инструментов в `meta`, работу инструментов с файлами и командами, песочницу и классификацию риска, блокировку опасных команд, подтверждения, рабочую папку и файловую систему, встроенный терминал, журнал и поиск, настройки (слияние, экспорт, импорт, санитизация), экспорт сессий в JSON и Markdown, суммаризацию, остановку выполнения, защиту токена и `Origin`, слой хранилища.

```
PASSED 118   FAILED 0
```

### 2. Живой сервер и WebSocket, 28 проверок

```bash
python tests/test_websocket.py
```

Запускает настоящий `uvicorn` в отдельном процессе (с временным `DAGENT_HOME`), подключается к `/ws` и проходит весь цикл: раздачу интерфейса, кадр `hello`, `ping`/`pong`, запуск задачи, стриминг токенов, события инструментов, подтверждение **через сокет**, конец выполнения, сохранение сообщений и автоматический заголовок сессии, запись в журнале, остановку выполнения.

```
PASSED 28   FAILED 0
```

### 3. Интерфейс, 87 проверок (jsdom)

```bash
npm install              # один раз, ставит только jsdom
node tests/test_frontend.mjs
DAGENT_DEBUG=1 node tests/test_frontend.mjs    # с диагностикой
```

Загружает реальные модули из `dagent/web/js/` в jsdom, подменяет `fetch`/`WebSocket` записанными фикстурами и проходит пользовательский сценарий целиком: загрузка и первый экран, рендер сообщений, Markdown, подсветка кода, diff, карточки инструментов, подтверждение действия, вкладки мониторинга, план и изменённые файлы, шкала контекста, палитра команд, все 8 разделов настроек, смена темы и языка, отправка сообщения и стриминг, слэш-меню, переключение моделей, превью файла, мастер первого запуска. Отдельно проверяется, что ошибок в консоли нет и что **ни один** запрос не ушёл мимо заглушки.

```
PASSED 87   FAILED 0
```

### Фикстуры

Фикстуры в `tests/fixtures/` - это настоящие ответы API, снятые с бэкенда:

```bash
python tests/capture_fixtures.py
```

Скрипт поднимает демо-модель на `:8601`, прогоняет задачу и сохраняет `state.json`, `events.json`, `session.json`, `models.json`, `modes.json`, `settings.json`, `tree.json`, `browse.json`, `file.json`, `terminal.json`, `audit.json`, `runs.json`, `workspace.json`, `sessions.json`, `export.md.txt`. Перезаписывайте их, если меняли формат ответов API, - иначе jsdom-тесты будут проверять старый контракт.

### Проверки без запуска

```bash
python -c "import dagent.app"                    # бэкенд импортируется
for f in $(find dagent/web/js -name '*.js'); do node --check "$f"; done   # синтаксис JS
```

### Что стоит проверять руками

Тесты покрывают логику, но не пиксели. После изменений в `dagent/web/css/` или в компонентах откройте интерфейс и посмотрите: все 7 тем, три плотности, свёрнутые панели, мобильную ширину, длинный вывод команды, большой diff, карточку плана. Быстрее всего - `python scripts/demo.py`: демо-модель сразу покажет все типы карточек.

---

## Соглашения

* **Без внешних зависимостей в интерфейсе.** Если нужен шрифт, иконка или подсветка - реализуем сами в `dagent/web/`.
* **Иконки - инлайн-SVG.** Все в `js/icons.js` по именам; добавляя иконку, добавьте её и в RU/EN-подписи, если она видна в меню.
* **Строки - только через `t()`.** Переводы в `js/i18n.js`, ключи `ru`/`en` обязаны совпадать. Названия режимов и инструментов локализуются на сервере.
* **Новая настройка = три места.** `DEFAULTS` в `config.py`, контрол в `js/ui/settings.js`, ключи в `js/i18n.js` (+ описание в `docs/SETTINGS.md`).
* **Новое событие = два места.** `hub.emit("kind", data)` на бэкенде и обработчик `stream.on("kind", ...)` в интерфейсе (+ строка в `docs/API.md`).
* **Новый инструмент = четыре места.** `ToolSpec` + обработчик в `agent/tools.py`, упоминание в режимах (`agent/modes.py`), рендер в `js/ui/chat.js`, строки в `docs/TOOLS.md`.
* **Секреты - только в `~/.dagent/settings.json`.** В ответы API ключи попадают маскированными, в браузер - никогда.
* **Русский - основной язык интерфейса и документации**, английский поддерживается наравне (`app.language`).

---

## Отладка

| Задача | Как |
| --- | --- |
| Посмотреть запросы к модели | `python run.py --dev`, затем логи uvicorn; `agent.stream = false` убирает SSE-шум |
| Полный лог событий | Мониторинг -> Журнал, или `GET /api/runs/{id}/events?since=0` |
| Что видит модель | `GET /api/sessions/{id}` -> `meta` сообщений, либо вкладка «Активность» |
| Настройки не применяются | Проверьте `~/.dagent/settings.json` и `GET /api/settings`; глубокая структура обязательна |
| GGUF не грузится | `GET /api/models/gguf/status`, затем `gguf.verbose = true` |
| Интерфейс «залип» | `Ctrl+Shift+P` -> «Перезагрузить состояние»; в крайнем случае - сброс настроек |
| Порт занят | `python run.py --port 8500` |

Логи: `~/.dagent/logs/`, база: `~/.dagent/data/sessions.db`, настройки: `~/.dagent/settings.json`. Всё можно удалить при выключенном DAGENT - приложение пересоздаст файлы при следующем запуске.

---

## Идеи для вклада

* новые инструменты (например работа с git-объектами, CSV/Excel, изображениями);
* провайдеры: Gemini, локальные серверы с нестандартным API;
* темы и плотность интерфейса;
* переводы (сейчас `ru` и `en`);
* тесты под Windows и macOS (сейчас наборы проверялись в Linux);
* упаковка в один исполняемый файл (PyInstaller) и установщики.

Автор: **frizovdanya** - Telegram [@frizovdanya](https://t.me/frizovdanya). Лицензия MIT.
