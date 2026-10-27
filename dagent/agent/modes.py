"""Agent operating modes.

A mode is a bundle of: system prompt style, which tools are available, whether
actions need confirmation and sensible generation defaults. The GUI shows modes
as big cards so a new user can pick one and start immediately.
"""

from __future__ import annotations

from typing import Any, Dict, List

READ_TOOLS = [
    "list_dir", "read_file", "file_info", "search_files", "workspace_tree",
]
WRITE_TOOLS = ["write_file", "edit_file", "create_dir", "move_path", "copy_path", "remember"]
DESTRUCTIVE_TOOLS = ["delete_path"]
EXEC_TOOLS = ["run_command", "python_run"]
NETWORK_TOOLS = ["web_fetch"]
HUMAN_TOOLS = ["ask_user"]
# Planning is a meta tool: it changes nothing on disk but keeps the GUI plan
# panel (and the model itself) in sync, so every working mode gets it.
META_TOOLS = ["update_plan"]

MODES: List[Dict[str, Any]] = [
    {
        "id": "chat",
        "icon": "chat",
        "name": {"ru": "Общение", "en": "Chat"},
        "tagline": {"ru": "Просто разговор, без доступа к системе", "en": "Pure conversation, no system access"},
        "description": {
            "ru": "Модель отвечает текстом и не может трогать файлы или запускать команды. "
                  "Безопасный режим для вопросов, текстов, идей и перевода.",
            "en": "The model only writes text and cannot touch files or run commands. "
                  "Safe mode for questions, writing, ideas and translation.",
        },
        "tools": [],
        "auto_approve": False,
        "defaults": {"temperature": 0.8, "max_iterations": 1, "max_tokens": 2048},
        "accent": "#4ea1ff",
    },
    {
        "id": "assistant",
        "icon": "wand",
        "name": {"ru": "Ассистент", "en": "Assistant"},
        "tagline": {"ru": "Полный доступ, каждое действие подтверждается", "en": "Full access, every action confirmed"},
        "description": {
            "ru": "Агент умеет всё: читать и создавать файлы, запускать команды, искать в интернете. "
                  "Опасные шаги показываются в окне подтверждения - вы всегда контролируете процесс.",
            "en": "The agent can do everything: read and create files, run commands, fetch pages. "
                  "Risky steps appear in an approval dialog - you stay in control.",
        },
        "tools": READ_TOOLS + WRITE_TOOLS + DESTRUCTIVE_TOOLS + EXEC_TOOLS + NETWORK_TOOLS + HUMAN_TOOLS + META_TOOLS,
        "auto_approve": False,
        "defaults": {"temperature": 0.5, "max_iterations": 12, "max_tokens": 2048},
        "accent": "#7c5cff",
    },
    {
        "id": "autopilot",
        "icon": "rocket",
        "name": {"ru": "Автопилот", "en": "Autopilot"},
        "tagline": {"ru": "Работает сам, без остановок на подтверждения", "en": "Runs on its own without pauses"},
        "description": {
            "ru": "Агент выполняет длинные задачи самостоятельно: много шагов, файлов и команд подряд. "
                  "Запрещённые команды и выход за пределы рабочей папки всё равно блокируются.",
            "en": "The agent completes long tasks on its own: many steps, files and commands in a row. "
                  "Denied commands and escaping the workspace are still blocked.",
        },
        "tools": READ_TOOLS + WRITE_TOOLS + DESTRUCTIVE_TOOLS + EXEC_TOOLS + NETWORK_TOOLS + META_TOOLS,
        "auto_approve": True,
        "defaults": {"temperature": 0.4, "max_iterations": 30, "max_tokens": 3072},
        "accent": "#ff7a45",
    },
    {
        "id": "code",
        "icon": "code",
        "name": {"ru": "Код", "en": "Code"},
        "tagline": {"ru": "Разработка: анализ проекта, правки, тесты, git", "en": "Development: analysis, edits, tests, git"},
        "description": {
            "ru": "Режим программиста. Агент изучает структуру проекта, пишет и рефакторит код, "
                  "запускает тесты и сборку, работает с git - и объясняет каждое изменение.",
            "en": "Programmer mode. The agent explores the project, writes and refactors code, "
                  "runs tests and builds, works with git - and explains every change.",
        },
        "tools": READ_TOOLS + WRITE_TOOLS + DESTRUCTIVE_TOOLS + EXEC_TOOLS + HUMAN_TOOLS + META_TOOLS,
        "auto_approve": False,
        "defaults": {"temperature": 0.25, "max_iterations": 25, "max_tokens": 4096},
        "accent": "#35d07f",
    },
    {
        "id": "terminal",
        "icon": "terminal",
        "name": {"ru": "Терминал", "en": "Terminal"},
        "tagline": {"ru": "Команды, установка, диагностика системы", "en": "Commands, installs, system diagnostics"},
        "description": {
            "ru": "Упор на консоль: агент строит цепочки команд, ставит пакеты, ищет ошибки в логах "
                  "и настраивает окружение. Файлы редактирует только когда это нужно.",
            "en": "Console-first: the agent builds command chains, installs packages, hunts errors "
                  "in logs and sets up environments. Files are edited only when needed.",
        },
        "tools": READ_TOOLS + EXEC_TOOLS + WRITE_TOOLS + NETWORK_TOOLS + HUMAN_TOOLS + META_TOOLS,
        "auto_approve": False,
        "defaults": {"temperature": 0.2, "max_iterations": 20, "max_tokens": 2048},
        "accent": "#00c2a8",
    },
    {
        "id": "analyst",
        "icon": "search",
        "name": {"ru": "Аналитик", "en": "Analyst"},
        "tagline": {"ru": "Только чтение: исследование и отчёты", "en": "Read-only: research and reports"},
        "description": {
            "ru": "Агент читает файлы, ищет по содержимому и собирает выводы в отчёт. "
                  "Ничего не изменяет и не удаляет - идеально для аудита и знакомства с проектом.",
            "en": "The agent reads files, searches their contents and produces a report. "
                  "Nothing is modified or deleted - ideal for audits and project onboarding.",
        },
        "tools": READ_TOOLS + NETWORK_TOOLS + ["remember"] + META_TOOLS,
        "auto_approve": True,
        "defaults": {"temperature": 0.3, "max_iterations": 15, "max_tokens": 3072},
        "accent": "#f5b942",
    },
]

MODE_INDEX: Dict[str, Dict[str, Any]] = {mode["id"]: mode for mode in MODES}
DEFAULT_MODE = "assistant"


def get_mode(mode_id: str) -> Dict[str, Any]:
    return MODE_INDEX.get(mode_id or DEFAULT_MODE, MODE_INDEX[DEFAULT_MODE])


def mode_tools(mode_id: str) -> List[str]:
    return list(get_mode(mode_id).get("tools") or [])


def mode_is_autonomous(mode_id: str) -> bool:
    return bool(get_mode(mode_id).get("auto_approve"))


def localize_modes(language: str = "ru") -> List[Dict[str, Any]]:
    lang = language if language in ("ru", "en") else "ru"
    out = []
    for mode in MODES:
        out.append(
            {
                "id": mode["id"],
                "icon": mode["icon"],
                "name": mode["name"][lang],
                "tagline": mode["tagline"][lang],
                "description": mode["description"][lang],
                "accent": mode["accent"],
                "tools": mode["tools"],
                "auto_approve": mode["auto_approve"],
                "defaults": mode["defaults"],
            }
        )
    return out
