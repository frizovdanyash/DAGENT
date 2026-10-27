#!/usr/bin/env python3
"""
Try DAGENT without an API key.

Starts the built-in offline demo model (dagent/demo_model.py) plus the GUI, so
every part of the interface can be explored - streaming, tool cards, approvals,
the plan panel, the terminal, themes and settings - with no internet access and
nothing to install.

    python3 scripts/demo.py
    python3 scripts/demo.py --port 9000 --no-browser
    python3 scripts/demo.py --fresh        # throw-away config in a temp folder

When you are done, open Settings (Ctrl+,) -> Models and add a real model:
an API key (OpenAI, DeepSeek, OpenRouter, Groq, Anthropic, ...) or a local
GGUF through LM Studio / Ollama / llama.cpp.

DAGENT - creator frizovdanya, https://t.me/frizovdanya
"""

from __future__ import annotations

import argparse
import os
import socket
import sys
import tempfile
import threading
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

DEMO_FILES = {
    "README.md": """# Демо-проект DAGENT

Это маленькая рабочая папка, чтобы агенту было с чем поработать.

Попробуйте написать ему:

- «покажи структуру проекта»
- «прочитай src/main.py и объясни, что он делает»
- «запусти src/main.py»
- «создай файл notes/ideas.md со списком идей»
""",
    "src/main.py": """\"\"\"Точка входа демо-проекта.\"\"\"

from data import load_rows


def main() -> None:
    rows = load_rows()
    total = sum(row["value"] for row in rows)
    print(f"DAGENT demo project: {len(rows)} строк, сумма = {total}")


if __name__ == "__main__":
    main()
""",
    "src/data.py": """\"\"\"Загрузка данных из CSV.\"\"\"

import csv
import os

HERE = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(os.path.dirname(HERE), "data", "sample.csv")


def load_rows():
    if not os.path.exists(CSV_PATH):
        return []
    with open(CSV_PATH, "r", encoding="utf-8") as fh:
        return [{"name": row["name"], "value": int(row["value"])} for row in csv.DictReader(fh)]
""",
    "data/sample.csv": """name,value
alpha,12
beta,30
gamma,7
delta,45
""",
    "notes/todo.md": """# TODO

- [ ] подключить настоящую модель
- [ ] выбрать режим (Ассистент / Автопилот / Код)
- [ ] попросить агента отрефакторить src/main.py
""",
}


def free_port(preferred: int = 8611) -> int:
    for port in [preferred] + list(range(preferred + 1, preferred + 40)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("No free port for the demo model")


def seed_workspace(root: str) -> int:
    created = 0
    for relative, content in DEMO_FILES.items():
        target = os.path.join(root, relative)
        if os.path.exists(target):
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(content)
        created += 1
    return created


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Run DAGENT with the built-in offline demo model.")
    parser.add_argument("--host", default=None, help="GUI bind address (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=None, help="GUI port (default 8420)")
    parser.add_argument("--workspace", default=None, help="Working folder (default ~/DAGENTWorkspace)")
    parser.add_argument("--fresh", action="store_true", help="Use a throw-away config folder")
    parser.add_argument("--no-browser", action="store_true", help="Do not open a browser window")
    parser.add_argument("--keep-demo-profile", action="store_true", help="Do not remove an existing demo profile")
    args = parser.parse_args(argv)

    if args.fresh:
        os.environ["DAGENT_HOME"] = tempfile.mkdtemp(prefix="dagent-demo-")

    from dagent import __author_tg__, __version__
    from dagent.config import settings
    from dagent.demo_model import serve as serve_demo, set_demo
    from dagent.providers import new_profile

    workspace = os.path.abspath(os.path.expanduser(args.workspace or settings.get("workspace.root")
                                                    or "~/DAGENTWorkspace"))
    os.makedirs(workspace, exist_ok=True)
    created = seed_workspace(workspace)

    demo_port = free_port()
    set_demo(True)
    serve_demo(host="127.0.0.1", port=demo_port)

    demo_url = f"http://127.0.0.1:{demo_port}/v1"
    existing = [profile for profile in settings.profiles() if profile.get("base_url") == demo_url]
    if existing and not args.keep_demo_profile:
        profile = existing[0]
    elif existing:
        profile = existing[0]
    else:
        profile = new_profile(
            name="Демо-модель (офлайн)",
            kind="api",
            preset="custom",
            model="dagent-demo",
            base_url=demo_url,
            api_key="demo",
            capabilities={"native_tools": True, "context_window": 8192, "emulate_tool_role": True},
            params={"temperature": 0.4, "max_tokens": 1024},
        )
        profile["notes"] = ("Built-in offline demo model. It answers locally and can call one tool per turn - "
                            "perfect for exploring the interface. Replace it with a real model in Settings -> Models.")
        profile["color"] = "#35d07f"
        settings.save_profile(profile)
    settings.set("models.active_id", profile["id"])
    settings.set("workspace.root", workspace)
    if args.host:
        settings.set("app.host", args.host, persist=False)
    if args.port:
        settings.set("app.port", int(args.port), persist=False)

    host = str(settings.get("app.host") or "127.0.0.1")
    port = int(settings.get("app.port") or 8420)
    url = f"http://{'localhost' if host in ('0.0.0.0', '::') else host}:{port}/"

    version = __version__
    author_tg = __author_tg__
    print(f"""
  DAGENT {version} - offline demo
  GUI         ->  {url}
  demo model  ->  {demo_url}  (built-in, no internet)
  workspace   ->  {workspace}{f'  (+{created} demo files)' if created else ''}
  config      ->  {os.path.dirname(str(settings.path))}
  creator     ->  frizovdanya {author_tg}

  Next: Ctrl+, -> Models -> add your own API key or a local GGUF file.
  Stop: Ctrl+C
""", flush=True)

    try:
        import uvicorn
    except ImportError:
        print("uvicorn is not installed. Run:  pip install -r requirements.txt", file=sys.stderr)
        return 1

    if not args.no_browser and settings.get("app.open_on_start", True):
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    try:
        uvicorn.run("dagent.app:app", host=host, port=port, log_level="warning", access_log=False)
    except KeyboardInterrupt:
        print("\nDAGENT demo stopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
