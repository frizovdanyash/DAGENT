# Настройки DAGENT

Всё, что можно изменить - в окне настроек (`Ctrl+,`) или в файле `~/.dagent/settings.json`.
Файл можно править вручную при выключенном DAGENT; изменения подхватятся при следующем запуске.

Настроек: **117** в **9** группах.

| Группа | Назначение |
| --- | --- |
| `app` - Приложение | Запуск, адрес сервера, язык, защита локального API. (12) |
| `ui` - Интерфейс | Темы, шрифты, плотность, фон, поведение чата. (26) |
| `workspace` - Рабочая папка | Где агент работает и что ему там разрешено. (6) |
| `agent` - Агент | Режим, параметры генерации, контекст, промпты, протокол инструментов. (25) |
| `security` - Безопасность | Подтверждения, команда, таймауты, запреты, журнал. (18) |
| `models` - Модели | Подключённые профили и активная модель. (3) |
| `gguf` - Локальные GGUF | Параметры llama.cpp для моделей `.gguf`. (11) |
| `hotkeys` - Горячие клавиши | Все сочетания можно переназначить в настройках. (12) |
| `chat` - Чат | Вложения и поведение ленты сообщений. (4) |

## `app` - Приложение

Запуск, адрес сервера, язык, защита локального API.

| Ключ | По умолчанию | Описание |
| --- | --- | --- |
| `app.language` | `ru` | Язык интерфейса и ответов агента: `ru` или `en` |
| `app.first_run_done` | `false` | Показывать ли мастер первичной настройки (сбросьте в `false`, чтобы пройти его снова) |
| `app.host` | `127.0.0.1` | Адрес, на котором слушает сервер (`127.0.0.1` - только этот компьютер, `0.0.0.0` - вся локальная сеть) |
| `app.port` | `8420` | Порт веб-интерфейса |
| `app.open_on_start` | `true` | Открывать браузер автоматически при запуске |
| `app.window_mode` | `false` | Открывать в отдельном окне через pywebview (если пакет установлен) |
| `app.window_size` | `[1440, 900]` | Размер окна `[ширина, высота]` |
| `app.show_console` | `false` | Показывать консоль с логами (для отладки) |
| `app.auto_update_check` | `false` | Проверять обновления при старте |
| `app.dev_mode` | `false` | Режим разработчика: открытые CORS, Swagger на `/api/docs`, без токена |
| `app.token_secret` | `""` | Секретный токен локального API (генерируется автоматически, в браузер отдаётся пустым) |
| `app.allowed_origins` | `[]` | Дополнительные Origin-адреса, которым разрешён доступ (туннели, обратные прокси) |

## `ui` - Интерфейс

Темы, шрифты, плотность, фон, поведение чата.

| Ключ | По умолчанию | Описание |
| --- | --- | --- |
| `ui.theme` | `midnight` | Тема оформления: `midnight`, `obsidian`, `nebula`, `forest`, `nord`, `daylight`, `paper` |
| `ui.accent` | `#7c5cff` | Акцентный цвет (готовый пресет или свой HEX) |
| `ui.custom_css` | `""` | Свой CSS - применяется поверх темы |
| `ui.font_family` | `system` | Шрифт интерфейса |
| `ui.font_size` | `14.5` | Размер шрифта, px (Ctrl+колесо мыши тоже меняет его) |
| `ui.mono_font` | `mono` | Моноширинный шрифт для кода |
| `ui.density` | `comfortable` | Плотность интерфейса: `compact`, `comfortable`, `cozy` |
| `ui.animations` | `true` | Анимации и переходы |
| `ui.background_fx` | `aurora` | Фон: `aurora`, `grid`, `stars`, `none` |
| `ui.blur` | `true` | Размытие панелей (стекло) - красивее, но требует GPU |
| `ui.corner_radius` | `14` | Скругление углов, px |
| `ui.content_width` | `860` | Ширина колонки сообщений, px |
| `ui.sidebar_collapsed` | `false` | Скрывать левую панель при запуске |
| `ui.show_monitor` | `true` | Показывать правую панель мониторинга |
| `ui.monitor_tab` | `activity` | Вкладка мониторинга по умолчанию: `activity`, `plan`, `files`, `terminal`, `info` |
| `ui.show_timestamps` | `true` | Показывать время у сообщений |
| `ui.show_avatars` | `true` | Показывать аватары |
| `ui.show_token_stats` | `true` | Показывать расход токенов у ответа |
| `ui.code_wrap` | `false` | Переносить длинные строки в коде (иначе - горизонтальная прокрутка) |
| `ui.code_line_numbers` | `true` | Номера строк в блоках кода |
| `ui.markdown` | `true` | Рендерить Markdown в ответах модели |
| `ui.stream_smooth` | `true` | Плавная отрисовка потока (небольшая буферизация токенов) |
| `ui.sound` | `false` | Короткий сигнал в конце задачи |
| `ui.confirm_on_close` | `true` | Предупреждать при закрытии вкладки во время выполнения |
| `ui.compact_tool_cards` | `false` | Компактные карточки инструментов |
| `ui.message_spacing` | `18` | Расстояние между сообщениями, px |

## `workspace` - Рабочая папка

Где агент работает и что ему там разрешено.

| Ключ | По умолчанию | Описание |
| --- | --- | --- |
| `workspace.root` | `""` | Рабочая папка агента - всё, что он читает и меняет |
| `workspace.recent` | `[]` | Последние открытые папки (для быстрого переключения) |
| `workspace.sandbox` | `true` | Держать агента внутри рабочей папки |
| `workspace.allow_read_outside` | `false` | Разрешить чтение файлов вне рабочей папки |
| `workspace.hidden_entries` | `[".git", "node_modules", "__pycache__", ".venv", "venv", ...` | Папки и файлы, которые не показываются в дереве и поиске |
| `workspace.max_tree_files` | `4000` | Ограничение числа файлов в дереве |

## `agent` - Агент

Режим, параметры генерации, контекст, промпты, протокол инструментов.

| Ключ | По умолчанию | Описание |
| --- | --- | --- |
| `agent.mode` | `assistant` | Режим по умолчанию: `chat`, `assistant`, `autopilot`, `code`, `terminal`, `analyst` |
| `agent.max_iterations` | `15` | Сколько шагов «инструмент -> ответ» агент может сделать за одну задачу |
| `agent.temperature` | `0.7` | Температура генерации (0 - максимально детерминированно) |
| `agent.top_p` | `0.95` | Ядро выборки (nucleus sampling) |
| `agent.top_k` | `0` | Top-K выборка (для локальных моделей) |
| `agent.max_tokens` | `2048` | Максимум токенов в одном ответе модели |
| `agent.context_window` | `8192` | Размер контекста модели в токенах - по нему считается заполненность окна |
| `agent.frequency_penalty` | `0.0` | Штраф за частоту повторов |
| `agent.presence_penalty` | `0.0` | Штраф за присутствие повторов |
| `agent.repeat_penalty` | `1.1` | Повторный штраф (llama.cpp / GGUF) |
| `agent.stop_sequences` | `[]` | Стоп-последовательности |
| `agent.stream` | `true` | Стриминг ответа токенами |
| `agent.extra_system_prompt` | `""` | Свой текст, который добавляется в системный промпт |
| `agent.memory_enabled` | `true` | Инструмент `remember` и файл памяти |
| `agent.memory_file` | `DAGENT_MEMORY.md` | Имя файла памяти в рабочей папке |
| `agent.auto_title` | `true` | Придумывать название сессии по первому сообщению |
| `agent.compress_history` | `true` | Сжимать историю, когда контекст заполнен |
| `agent.compress_ratio` | `0.7` | Насколько агрессивно сжимать историю (0-1) |
| `agent.retry_on_error` | `2` | Повторять запрос при ошибке провайдера |
| `agent.request_timeout` | `300` | Таймаут запроса к модели, сек |
| `agent.show_reasoning` | `true` | Показывать «размышления» модели отдельным блоком |
| `agent.tool_protocol` | `auto` | Как передавать инструменты: `auto`, `native` (function calling), `json` (текстовый протокол) |
| `agent.include_environment` | `true` | Добавлять в промпт сведения о системе и папке |
| `agent.include_file_tree` | `false` | Добавлять в промпт дерево рабочей папки |
| `agent.seed` | `null` | Seed генерации (-1 = случайный) |

## `security` - Безопасность

Подтверждения, команда, таймауты, запреты, журнал.

| Ключ | По умолчанию | Описание |
| --- | --- | --- |
| `security.auto_approve` | `false` | Выполнять любые действия без подтверждения (глобально) |
| `security.auto_approve_reads` | `true` | Чтение, списки и безопасные команды - без подтверждения |
| `security.confirm_timeout` | `300` | Через сколько секунд неподтверждённое действие отменяется |
| `security.shell` | `auto` | Оболочка для команд: `auto`, `bash`, `powershell`, `cmd`, `custom` |
| `security.custom_shell` | `""` | Своя оболочка (например `/usr/bin/zsh`) |
| `security.command_timeout` | `120` | Максимальное время выполнения команды, сек |
| `security.max_output_chars` | `120000` | Сколько символов вывода команды вернуть модели |
| `security.allow_network_tools` | `true` | Разрешить `web_fetch` |
| `security.allow_delete` | `true` | Разрешить удаление файлов |
| `security.confirm_delete` | `true` | Спрашивать подтверждение при удалении |
| `security.allow_python_exec` | `true` | Разрешить `python_run` |
| `security.allow_write_outside_workspace` | `false` | Опасно: разрешить запись вне рабочей папки |
| `security.audit_log` | `true` | Писать журнал действий (БД + `logs/audit.log`) |
| `security.denied_commands` | `["rm\\s+-rf\\s+/(?!home|tmp)\\S*", ":\\(\\)\\s*\\{\\s*:\\...` | Регулярные выражения: такие команды блокируются всегда |
| `security.always_allow_commands` | `["ls", "ll", "dir", "pwd", "cd", "cat", "type", "head", "...` | Префиксы команд, которые не требуют подтверждения |
| `security.sensitive_paths` | `["/etc", "/root", "/proc", "/sys", "/boot", "/dev", "/hom...` | Пути, куда агенту нельзя (SSH, ключи, системные папки) |
| `security.max_file_write_bytes` | `8000000` | Максимальный размер записываемого файла |
| `security.max_file_read_bytes` | `2000000` | Максимальный размер читаемого файла |

## `models` - Модели

Подключённые профили и активная модель.

| Ключ | По умолчанию | Описание |
| --- | --- | --- |
| `models.active_id` | `null` | Активная модель |
| `models.profiles` | `[]` | Список подключённых моделей (API и GGUF) |
| `models.hide_keys` | `true` | Прятать API-ключи в ответах сервера и в интерфейсе |

## `gguf` - Локальные GGUF

Параметры llama.cpp для моделей `.gguf`.

| Ключ | По умолчанию | Описание |
| --- | --- | --- |
| `gguf.scan_dirs` | `[]` | Папки, где искать файлы `.gguf` |
| `gguf.n_ctx` | `8192` | Размер контекста llama.cpp |
| `gguf.n_gpu_layers` | `0` | Слоёв на GPU (-1 = все, 0 = CPU) |
| `gguf.n_threads` | `0` | Потоков CPU (0 = авто) |
| `gguf.n_batch` | `512` | Размер батча llama.cpp |
| `gguf.chat_format` | `auto` | Формат чата: `auto`, `chatml`, `llama-2`, `llama-3`, `mistral-instruct`, `vicuna` ... |
| `gguf.verbose` | `false` | Подробный лог llama.cpp |
| `gguf.main_gpu` | `0` | Индекс основного GPU |
| `gguf.use_mmap` | `true` | Использовать mmap при загрузке модели |
| `gguf.use_mlock` | `false` | Держать модель в памяти (mlock) |
| `gguf.seed` | `-1` | Seed для llama.cpp |

## `hotkeys` - Горячие клавиши

Все сочетания можно переназначить в настройках.

| Ключ | По умолчанию | Описание |
| --- | --- | --- |
| `hotkeys.send` | `Enter` | Отправить сообщение |
| `hotkeys.newline` | `Shift+Enter` | Перенос строки |
| `hotkeys.palette` | `Ctrl+K` | Командная палитра |
| `hotkeys.settings` | `Ctrl+,` | Настройки |
| `hotkeys.new_session` | `Ctrl+N` | Новая сессия |
| `hotkeys.switch_model` | `Ctrl+M` | Переключить модель |
| `hotkeys.stop_run` | `Ctrl+.` | Остановить выполнение |
| `hotkeys.focus_input` | `Ctrl+L` | Фокус в поле ввода |
| `hotkeys.toggle_sidebar` | `Ctrl+B` | Скрыть/показать левую панель |
| `hotkeys.toggle_monitor` | `Ctrl+J` | Скрыть/показать мониторинг |
| `hotkeys.search_sessions` | `Ctrl+F` | Поиск по сессиям |
| `hotkeys.regenerate` | `Ctrl+R` | Перегенерировать ответ |

## `chat` - Чат

Вложения и поведение ленты сообщений.

| Ключ | По умолчанию | Описание |
| --- | --- | --- |
| `chat.attachments_as` | `text` | Как передавать вложения: `text` (содержимое в промпт) или `path` (только путь) |
| `chat.max_attachment_bytes` | `400000` | Максимальный размер вложения |
| `chat.scroll_on_stream` | `true` | Прокручивать чат во время стриминга |
| `chat.send_on_enter` | `true` | Enter отправляет сообщение |

## Профили моделей

Каждый профиль в `models.profiles` описывает одну модель:

```json
{
  "id": "a1b2c3d4e5f6",
  "name": "DeepSeek V3",
  "kind": "api",
  "provider_preset": "deepseek",
  "base_url": "https://api.deepseek.com/v1",
  "api_key": "sk-...",
  "model": "deepseek-chat",
  "params": {
    "temperature": 0.4,
    "max_tokens": 2048
  },
  "capabilities": {
    "native_tools": true,
    "context_window": 65536,
    "vision": false
  },
  "extra_headers": {},
  "extra_body": {},
  "gguf_path": "",
  "gguf_options": {},
  "enabled": true,
  "favorite": false,
  "color": "#7c5cff",
  "notes": ""
}
```

* `kind`: `api` (любой OpenAI-совместимый сервер), `anthropic`, `gguf` (локальный файл через llama-cpp-python).
* `capabilities.native_tools`: `false` - DAGENT сам передаст инструменты текстом (JSON-протокол).
* `capabilities.emulate_tool_role`: для серверов, которые не принимают роль `tool` - результат придёт как `user`.
* API-ключи в ответах сервера маскируются (`models.hide_keys`), а в браузере не показываются вовсе.

## Сброс

* В интерфейсе: Настройки -> Данные -> «Сбросить настройки» (модели можно сохранить).
* Вручную: удалить `~/.dagent/settings.json` - DAGENT пересоздаст его при следующем запуске.
* Из кода: `POST /api/settings/reset` с `{"keep_models": true}`.
