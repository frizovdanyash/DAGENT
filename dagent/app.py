"""FastAPI application factory: serves the GUI and the local agent API."""

from __future__ import annotations

import json
import os
import secrets
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import __author_tg__, __version__, paths
from .api import build_router, ws
from .config import settings as default_settings
from .events import hub
from .state import state

EXEMPT_PATHS = {"/api/health", "/api/ping"}


def _allowed_origins(settings: Any) -> List[str]:
    host = str(settings.get("app.host") or "127.0.0.1")
    port = int(settings.get("app.port") or 8420)
    origins = [
        f"http://127.0.0.1:{port}",
        f"http://localhost:{port}",
        f"http://{host}:{port}",
    ]
    extra = settings.get("app.allowed_origins") or []
    if isinstance(extra, str):
        extra = [item.strip() for item in extra.split(",") if item.strip()]
    for item in extra:
        origins.append(str(item).rstrip("/"))
    if settings.get("app.dev_mode"):
        origins.append("*")
    return origins


def create_app(settings: Any = None) -> FastAPI:
    settings = settings or default_settings

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        import asyncio

        hub.bind_loop(asyncio.get_running_loop())
        workspace = str(settings.get("workspace.root") or paths.default_workspace())
        os.makedirs(os.path.expanduser(workspace), exist_ok=True)
        if not settings.get("workspace.root"):
            settings.set("workspace.root", os.path.expanduser(workspace))
        if not settings.get("models.profiles"):
            _install_demo_profile(settings)
        yield
        state.runs.stop_all()

    app = FastAPI(
        title="DAGENT",
        version=__version__,
        description="Local AI agent with a graphical interface. Creator: @frizovdanya",
        docs_url="/api/docs" if settings.get("app.dev_mode") else None,
        redoc_url=None,
        openapi_url="/api/openapi.json" if settings.get("app.dev_mode") else None,
        lifespan=lifespan,
    )

    allowed = _allowed_origins(settings)
    if "*" in allowed:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_credentials=False,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    token = _ensure_token(settings)

    @app.middleware("http")
    async def guard(request: Request, call_next):
        path = request.url.path
        provided = request.headers.get("x-dagent-token") or request.query_params.get("token") or ""
        has_token = bool(token) and provided == token
        protected = path.startswith("/api") or path == "/ws"
        if protected and not has_token and not _origin_allowed(request, allowed):
            # Browsers never send Origin for a same-origin navigation, so this only
            # blocks a foreign web page from scripting the local agent.
            return JSONResponse({"ok": False, "error": "Origin not allowed"}, status_code=403)
        if path.startswith("/api") and path not in EXEMPT_PATHS and token and not has_token:
            return JSONResponse(
                {"ok": False, "error": "Invalid or missing DAGENT token"}, status_code=403
            )
        response = await call_next(request)
        response.headers["X-DAGENT-Version"] = __version__
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        response.headers["Cache-Control"] = "no-store" if path.startswith("/api") else "public, max-age=60"
        return response

    app.include_router(build_router())
    app.include_router(ws.router)

    web = paths.web_dir()
    for folder in ("css", "js", "assets", "vendor"):
        directory = web / folder
        if directory.is_dir():
            app.mount(f"/{folder}", StaticFiles(directory=str(directory)), name=folder)

    @app.get("/", response_class=HTMLResponse)
    async def index() -> HTMLResponse:
        return HTMLResponse(_render_index(web / "index.html", token))

    @app.get("/favicon.ico")
    async def favicon():
        icon = web / "assets" / "favicon.svg"
        if icon.exists():
            from fastapi.responses import FileResponse

            return FileResponse(str(icon), media_type="image/svg+xml")
        return JSONResponse({"ok": True})

    @app.get("/{spa_path:path}", response_class=HTMLResponse)
    async def spa(spa_path: str) -> Any:
        if spa_path.startswith("api/") or spa_path.startswith("ws"):
            return JSONResponse({"ok": False, "error": "Not found"}, status_code=404)
        candidate = web / spa_path
        if candidate.is_file():
            from fastapi.responses import FileResponse

            return FileResponse(str(candidate))
        return HTMLResponse(_render_index(web / "index.html", token))

    return app


def _ensure_token(settings: Any) -> str:
    """The GUI is token protected: generate a secret on first run and persist it."""
    token = str(settings.get("app.token_secret") or "").strip()
    if token:
        return token
    if settings.get("app.dev_mode"):
        return ""
    token = secrets.token_urlsafe(24)
    try:
        settings.set("app.token_secret", token)
    except Exception:  # noqa: BLE001 - a read-only home directory must not break startup
        return token
    return token


def _origin_allowed(request: Request, allowed: List[str]) -> bool:
    origin = (request.headers.get("origin") or "").strip()
    if not origin:
        return True
    if "*" in allowed:
        return True
    netloc = urlsplit(origin).netloc.lower()
    if not netloc:
        return False
    hosts = {
        (request.headers.get("host") or "").lower(),
        (request.headers.get("x-forwarded-host") or "").lower(),
    }
    hosts.discard("")
    # Same-origin requests (also through a tunnel or reverse proxy) are always fine.
    if netloc in hosts:
        return True
    normalized = {str(item).rstrip("/").lower() for item in allowed}
    if origin.rstrip("/").lower() in normalized:
        return True
    # Compare without the scheme as well: the GUI may be served over http and
    # reached through an https tunnel.
    return any(netloc == urlsplit(item).netloc.lower() for item in normalized if item)


def _render_index(index_path: os.PathLike, token: str) -> str:
    try:
        with open(index_path, "r", encoding="utf-8") as fh:
            html = fh.read()
    except OSError:
        return "<h1>DAGENT</h1><p>Web interface files are missing.</p>"
    boot = {
        "token": token,
        "version": __version__,
        "author": "frizovdanya",
        "author_tg": __author_tg__,
    }
    html = html.replace("<!--DAGENT_BOOT-->", f"<script>window.DAGENT_BOOT = {json.dumps(boot)};</script>")
    html = html.replace("__DAGENT_TOKEN__", token)
    html = html.replace("__DAGENT_VERSION__", __version__)
    return html


def _install_demo_profile(settings: Any) -> None:
    """First run: add a ready-to-use local preset so the model dialog is not empty."""
    from .providers import new_profile

    profile = new_profile(
        name="LM Studio (local)",
        kind="api",
        preset="lmstudio",
        model="local-model",
        capabilities={"native_tools": True, "context_window": 8192, "vision": False, "emulate_tool_role": True},
    )
    profile["notes"] = "Example profile. Start LM Studio's local server (port 1234) and load any model, or edit this one."
    profile["enabled"] = True
    settings.save_profile(profile)
    settings.set("models.active_id", profile["id"])
    settings.set("app.first_run_done", False)


app = create_app()
