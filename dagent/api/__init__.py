"""Aggregated API routers."""

from __future__ import annotations

from fastapi import APIRouter

from . import chat, core, models, ws


def build_router() -> APIRouter:
    router = APIRouter()
    router.include_router(core.router)
    router.include_router(models.router)
    router.include_router(chat.router)
    return router


__all__ = ["build_router", "core", "models", "chat", "ws"]
