#!/usr/bin/env python3
"""
DAGENT launcher.

    python run.py                 # start on 127.0.0.1:8420 and open the browser
    python run.py --port 9000
    python run.py --host 0.0.0.0 --no-browser
    python run.py --workspace ~/Projects
    python run.py --dev           # CORS *, /api/docs, no token

Everything else is configured in the GUI (Ctrl+,).
Creator: frizovdanya - https://t.me/frizovdanya
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        prog="DAGENT",
        description="Local AI agent with a graphical interface (GGUF + any OpenAI-compatible API).",
    )
    parser.add_argument("--host", default=None, help="Bind address (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=None, help="Port (default 8420)")
    parser.add_argument("--workspace", default=None, help="Working folder for the agent")
    parser.add_argument("--language", choices=["ru", "en"], default=None, help="Interface language")
    parser.add_argument("--dev", action="store_true", help="Developer mode: open CORS, /api/docs, no token")
    parser.add_argument("--no-browser", action="store_true", help="Do not open a browser window")
    parser.add_argument("--reload", action="store_true", help="Auto-reload on code changes (development)")
    parser.add_argument("--token", default=None, help="Override the API token")
    parser.add_argument("--print-token", action="store_true", help="Print the GUI token and exit")
    parser.add_argument("--home", default=None, help="Data folder (default ~/.dagent)")
    parser.add_argument("--version", action="store_true", help="Print the version and exit")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)

    if args.home:
        os.environ["DAGENT_HOME"] = os.path.abspath(os.path.expanduser(args.home))

    from dagent import APP_NAME, __author_tg__, __version__
    from dagent.config import settings

    if args.version:
        print(f"{APP_NAME} {__version__} - creator frizovdanya ({__author_tg__})")
        return 0

    if args.dev:
        settings.set("app.dev_mode", True, persist=False)
        settings.set("app.token_secret", "", persist=False)
    if args.token is not None:
        settings.set("app.token_secret", args.token, persist=False)
    if args.host:
        settings.set("app.host", args.host, persist=False)
    if args.port:
        settings.set("app.port", int(args.port), persist=False)
    if args.language:
        settings.set("app.language", args.language, persist=False)
    if args.workspace:
        root = os.path.abspath(os.path.expanduser(args.workspace))
        os.makedirs(root, exist_ok=True)
        settings.set("workspace.root", root, persist=False)

    host = str(settings.get("app.host") or "127.0.0.1")
    port = int(settings.get("app.port") or 8420)
    url = f"http://{'localhost' if host in ('0.0.0.0', '::') else host}:{port}/"

    if args.print_token:
        print(str(settings.get("app.token_secret") or ""))
        return 0

    try:
        import uvicorn
    except ImportError:
        print("uvicorn is not installed. Run:  pip install -r requirements.txt", file=sys.stderr)
        return 1

    banner = f"""
  ____    _    ____ _   _ _____ ____
 |  _ \\  / \\  / ___| | | | ____|  _ \\      v{__version__}
 | | | |/ _ \\| |  _| |_| |  _| | |_) |     local AI agent
 | |_| / ___ \\ |_| |  _  | |___|  _ <      creator: frizovdanya
 |____/_/   \\_\\____|_| |_|_____|_| \\_\\     {__author_tg__}

  GUI  ->  {url}
  Data ->  {os.path.dirname(str(settings.path))}
  Work ->  {settings.get('workspace.root') or '(chosen on first run)'}
  Stop ->  Ctrl+C
"""
    print(banner, flush=True)

    if not args.no_browser and settings.get("app.open_on_start", True):
        threading.Timer(1.1, lambda: webbrowser.open(url)).start()

    try:
        uvicorn.run(
            "dagent.app:app",
            host=host,
            port=port,
            reload=bool(args.reload),
            log_level="info",
            access_log=False,
            server_header=False,
        )
    except KeyboardInterrupt:
        print("\nDAGENT stopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
