"""The agent's hands: every tool DAGENT can run on the user's machine.

Each tool is declared with a JSON schema (so it can be offered to the model via
native function calling *or* the JSON fallback protocol) and an async handler
returning a :class:`ToolResult`. Results carry two payloads:

* ``output`` - text the model reads,
* ``data``   - structured payload the GUI renders (diffs, terminal output, trees...).
"""

from __future__ import annotations

import asyncio
import difflib
import fnmatch
import html
import json
import os
import re
import shutil
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional

from .safety import SafetyEngine

MAX_OUTPUT_CHARS_DEFAULT = 120_000


@dataclass
class ToolResult:
    ok: bool = True
    output: str = ""
    data: Dict[str, Any] = field(default_factory=dict)
    error: str = ""
    render: str = "text"          # command | diff | file | list | search | tree | web | plan | question | text
    meta: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ok": self.ok,
            "output": self.output,
            "data": self.data,
            "error": self.error,
            "render": self.render,
            "meta": self.meta,
        }


@dataclass
class ToolSpec:
    name: str
    description: str
    parameters: Dict[str, Any]
    handler: Callable[[Any, Dict[str, Any]], Awaitable[ToolResult]]
    category: str = "files"       # files | system | code | web | meta
    render: str = "text"
    examples: List[Dict[str, Any]] = field(default_factory=list)


class ToolContext:
    """Everything a tool handler may need."""

    def __init__(
        self,
        settings: Any,
        safety: SafetyEngine,
        store: Any,
        session_id: str = "",
        workspace: str = "",
        emit: Optional[Callable[..., Awaitable[None]]] = None,
        approval_callback: Optional[Callable[[str, Dict[str, Any]], Awaitable[Dict[str, Any]]]] = None,
        cancel_event: Optional[asyncio.Event] = None,
        language: str = "ru",
        run_meta: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.settings = settings
        self.safety = safety
        self.store = store
        self.session_id = session_id
        self.workspace = workspace or safety.workspace_root
        self._emit = emit
        self.approval_callback = approval_callback
        self.cancel_event = cancel_event or asyncio.Event()
        self.language = language
        self.run_meta = run_meta or {}

    async def emit(self, event_type: str, **payload: Any) -> None:
        if self._emit is None:
            return
        try:
            await self._emit(event_type, payload)
        except Exception:  # noqa: BLE001 - UI events must never break a tool
            pass

    @property
    def max_output(self) -> int:
        return int(self.settings.get("security.max_output_chars", MAX_OUTPUT_CHARS_DEFAULT) or MAX_OUTPUT_CHARS_DEFAULT)

    def audit(self, kind: str, detail: str, tool: str = "", approved: Optional[bool] = None, ok: Optional[bool] = None) -> None:
        if not self.settings.get("security.audit_log", True):
            return
        try:
            self.store.audit(kind=kind, detail=detail, tool=tool, session_id=self.session_id, approved=approved, ok=ok)
        except Exception:  # noqa: BLE001
            pass


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #

def clip(text: str, limit: int, head_ratio: float = 0.7) -> str:
    """Trim long output keeping the beginning and the end (most useful parts)."""
    if text is None:
        return ""
    if len(text) <= limit:
        return text
    head = int(limit * head_ratio)
    tail = limit - head
    omitted = len(text) - head - tail
    return (
        text[:head]
        + f"\n\n... [DAGENT trimmed {omitted:,} characters] ...\n\n"
        + text[-tail:]
    )


def rel(path: str, workspace: str) -> str:
    try:
        return os.path.relpath(path, workspace)
    except ValueError:
        return path


def read_text_safely(path: str, limit_bytes: int) -> str:
    size = os.path.getsize(path)
    with open(path, "rb") as fh:
        raw = fh.read(limit_bytes)
    for encoding in ("utf-8", "utf-8-sig", "cp1251", "latin-1"):
        try:
            text = raw.decode(encoding)
            if encoding != "utf-8" and size <= limit_bytes:
                text = text
            break
        except UnicodeDecodeError:
            continue
    else:
        text = raw.decode("utf-8", "replace")
    if size > limit_bytes:
        text += f"\n... [file truncated, {size - limit_bytes:,} bytes not shown]"
    return text


def unified_diff(before: str, after: str, path: str, max_lines: int = 400) -> str:
    diff = difflib.unified_diff(
        before.splitlines(), after.splitlines(),
        fromfile=f"a/{path}", tofile=f"b/{path}", lineterm="", n=3,
    )
    lines = list(diff)
    if len(lines) > max_lines:
        lines = lines[:max_lines] + [f"... [{len(lines) - max_lines} more diff lines]"]
    return "\n".join(lines)


def is_binary(path: str) -> bool:
    try:
        with open(path, "rb") as fh:
            chunk = fh.read(2048)
        return b"\x00" in chunk
    except OSError:
        return True


def guess_language(path: str) -> str:
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    mapping = {
        "py": "python", "js": "javascript", "mjs": "javascript", "cjs": "javascript", "ts": "typescript",
        "tsx": "typescript", "jsx": "javascript", "json": "json", "md": "markdown", "html": "html",
        "css": "css", "scss": "css", "yml": "yaml", "yaml": "yaml", "toml": "toml", "sh": "bash",
        "bash": "bash", "bat": "batch", "ps1": "powershell", "c": "c", "h": "c", "cpp": "cpp",
        "hpp": "cpp", "cs": "csharp", "go": "go", "rs": "rust", "rb": "ruby", "php": "php",
        "java": "java", "kt": "kotlin", "sql": "sql", "xml": "xml", "ini": "ini", "cfg": "ini",
        "txt": "text", "env": "bash", "dockerfile": "docker", "vue": "html", "svelte": "html",
    }
    name = os.path.basename(path).lower()
    if name in ("dockerfile", "makefile", "license", "readme"):
        return {"dockerfile": "docker", "makefile": "make", "license": "text", "readme": "markdown"}[name]
    return mapping.get(ext, ext or "text")


# --------------------------------------------------------------------------- #
# tool implementations
# --------------------------------------------------------------------------- #

async def tool_run_command(ctx: ToolContext, args: Dict[str, Any]) -> ToolResult:
    command = str(args.get("command") or "").strip()
    if not command:
        return ToolResult(ok=False, error="No command given", output="Error: empty command", render="command")
    cwd_arg = args.get("cwd") or ""
    workspace = ctx.workspace
    if cwd_arg:
        resolved, error = ctx.safety.resolve(str(cwd_arg))
        if error:
            return ToolResult(ok=False, error=error, output=f"Error: {error}", render="command")
        workspace = resolved or workspace
    timeout = float(args.get("timeout") or ctx.settings.get("security.command_timeout", 120) or 120)
    timeout = min(max(timeout, 1.0), 3600.0)
    argv, shell_label = ctx.safety.shell_command()
    started = time.time()

    env = os.environ.copy()
    env["DAGENT"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["GIT_PAGER"] = "cat"
    env["PAGER"] = "cat"
    env["TERM"] = env.get("TERM") or "xterm-256color"
    env.pop("GIT_TERMINAL_PROMPT", None)
    env["GIT_TERMINAL_PROMPT"] = "0"

    chunks: List[str] = []
    total = 0
    truncated = False
    max_chars = ctx.max_output

    try:
        process = await asyncio.create_subprocess_exec(
            *argv, command,
            cwd=workspace,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        return ToolResult(ok=False, error=str(exc), output=f"Error: shell not available ({exc})", render="command")
    except Exception as exc:  # noqa: BLE001
        return ToolResult(ok=False, error=str(exc), output=f"Error starting command: {exc}", render="command")

    async def pump(stream: Any, label: str) -> None:
        nonlocal total, truncated
        while True:
            if ctx.cancel_event.is_set():
                break
            try:
                line = await stream.readline()
            except Exception:  # noqa: BLE001
                break
            if not line:
                break
            text = line.decode("utf-8", "replace")
            total += len(text)
            if total <= max_chars:
                chunks.append(text)
                await ctx.emit("tool.progress", tool="run_command", stream=label, text=text)
            else:
                truncated = True

    pump_out = asyncio.create_task(pump(process.stdout, "stdout"))
    pump_err = asyncio.create_task(pump(process.stderr, "stderr"))
    try:
        return_code = await asyncio.wait_for(process.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        try:
            process.kill()
        except ProcessLookupError:
            pass
        return_code = -1
        chunks.append(f"\n[DAGENT] command timed out after {timeout:.0f}s and was killed\n")
    finally:
        await asyncio.gather(pump_out, pump_err, return_exceptions=True)

    duration_ms = int((time.time() - started) * 1000)
    output = "".join(chunks).rstrip()
    if truncated:
        output += f"\n[DAGENT] output truncated at {max_chars:,} characters"
    if not output:
        output = "(no output)"
    result_text = f"exit code: {return_code}\n{clip(output, max(4000, max_chars // 3))}"
    ctx.audit("command", f"{command} -> exit {return_code}", tool="run_command", ok=return_code == 0)
    return ToolResult(
        ok=return_code == 0,
        output=result_text,
        render="command",
        data={
            "command": command,
            "cwd": workspace,
            "shell": shell_label,
            "exit_code": return_code,
            "output": clip(output, max_chars),
            "duration_ms": duration_ms,
            "truncated": truncated,
            "timed_out": return_code == -1,
        },
        error="" if return_code == 0 else f"Command exited with code {return_code}",
        meta={"duration_ms": duration_ms, "exit_code": return_code},
    )


async def tool_python_run(ctx: ToolContext, args: Dict[str, Any]) -> ToolResult:
    code = str(args.get("code") or "")
    if not code.strip():
        return ToolResult(ok=False, error="No code given", output="Error: empty code", render="command")
    timeout = float(args.get("timeout") or 60)
    tmp_dir = os.path.join(ctx.workspace, ".dagent_tmp")
    os.makedirs(tmp_dir, exist_ok=True)
    script = os.path.join(tmp_dir, f"run_{int(time.time() * 1000)}.py")
    with open(script, "w", encoding="utf-8") as fh:
        fh.write(code)
    python = args.get("interpreter") or sys.executable or "python3"
    command = f'"{python}" "{script}"' if " " in str(python) or " " in script else f"{python} {script}"
    result = await tool_run_command(ctx, {"command": command, "cwd": ctx.workspace, "timeout": timeout})
    try:
        if not args.get("keep_file"):
            os.remove(script)
    except OSError:
        pass
    result.data["language"] = "python"
    result.data["code"] = code
    result.render = "command"
    ctx.audit("python", code[:500], tool="python_run", ok=result.ok)
    return result


async def tool_read_file(ctx: ToolContext, args: Dict[str, Any]) -> ToolResult:
    raw_path = str(args.get("path") or "")
    resolved, error = ctx.safety.resolve(raw_path)
    if error:
        return ToolResult(ok=False, error=error, output=f"Error: {error}")
    path = resolved or ""
    if not os.path.exists(path):
        return ToolResult(ok=False, error="File not found", output=f"Error: file not found: {rel(path, ctx.workspace)}")
    if os.path.isdir(path):
        return await tool_list_dir(ctx, {"path": raw_path})
    if is_binary(path):
        info = os.stat(path)
        return ToolResult(
            ok=True,
            output=f"{rel(path, ctx.workspace)} is a binary file ({info.st_size:,} bytes) - content not shown.",
            render="file",
            data={"path": rel(path, ctx.workspace), "binary": True, "size": info.st_size},
        )
    limit_bytes = int(ctx.settings.get("security.max_file_read_bytes", 2_000_000) or 2_000_000)
    text = await asyncio.to_thread(read_text_safely, path, limit_bytes)
    start_line = int(args.get("start_line") or 1)
    max_lines = int(args.get("max_lines") or 2000)
    lines = text.splitlines()
    selected = lines[max(0, start_line - 1): max(0, start_line - 1) + max_lines]
    numbered = "\n".join(f"{start_line + i:>5} | {line}" for i, line in enumerate(selected))
    more = len(lines) - (start_line - 1 + len(selected))
    if more > 0:
        numbered += f"\n\n... [{more} more lines - use start_line to continue]"
    return ToolResult(
        ok=True,
        output=numbered or "(empty file)",
        render="file",
        data={
            "path": rel(path, ctx.workspace),
            "absolute_path": path,
            "content": "\n".join(selected),
            "language": guess_language(path),
            "total_lines": len(lines),
            "start_line": start_line,
            "shown_lines": len(selected),
            "size": os.path.getsize(path),
        },
    )


async def tool_write_file(ctx: ToolContext, args: Dict[str, Any]) -> ToolResult:
    raw_path = str(args.get("path") or "")
    content = args.get("content")
    if content is None:
        content = args.get("text", "")
    content = "" if content is None else str(content)
    mode = str(args.get("mode") or "overwrite").lower()
    resolved, error = ctx.safety.resolve(raw_path, for_write=True)
    if error:
        return ToolResult(ok=False, error=error, output=f"Error: {error}")
    path = resolved or ""
    max_bytes = int(ctx.settings.get("security.max_file_write_bytes", 8_000_000) or 8_000_000)
    if len(content.encode("utf-8")) > max_bytes:
        return ToolResult(ok=False, error="Content too large", output=f"Error: content exceeds {max_bytes:,} bytes limit")
    existed = os.path.exists(path)
    before = ""
    if existed and mode == "overwrite" and not is_binary(path):
        try:
            before = read_text_safely(path, 1_000_000)
        except OSError:
            before = ""
    if args.get("create_dirs", True):
        os.makedirs(os.path.dirname(path) or ctx.workspace, exist_ok=True)
    try:
        if mode == "append":
            with open(path, "a", encoding="utf-8", newline="\n") as fh:
                fh.write(content)
            after = before + content
        else:
            with open(path, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(content)
            after = content
    except OSError as exc:
        return ToolResult(ok=False, error=str(exc), output=f"Error writing file: {exc}")
    diff = unified_diff(before, after, rel(path, ctx.workspace)) if mode == "overwrite" and existed else ""
    stats = os.stat(path)
    ctx.audit("write", f"{rel(path, ctx.workspace)} ({'append' if mode == 'append' else 'write'}, {stats.st_size} bytes)",
              tool="write_file", ok=True)
    summary = (
        f"{'Appended to' if mode == 'append' else ('Updated' if existed else 'Created')} "
        f"{rel(path, ctx.workspace)} ({stats.st_size:,} bytes, {len(after.splitlines()):,} lines)"
    )
    return ToolResult(
        ok=True,
        output=summary + (f"\n\n{clip(diff, 6000)}" if diff else ""),
        render="diff" if diff else "file",
        data={
            "path": rel(path, ctx.workspace),
            "absolute_path": path,
            "created": not existed,
            "mode": mode,
            "size": stats.st_size,
            "lines": len(after.splitlines()),
            "diff": diff,
            "language": guess_language(path),
            "content_preview": after[:4000],
        },
        meta={"bytes": stats.st_size},
    )


async def tool_edit_file(ctx: ToolContext, args: Dict[str, Any]) -> ToolResult:
    raw_path = str(args.get("path") or "")
    old_text = args.get("old_text")
    new_text = args.get("new_text")
    if old_text is None or new_text is None:
        return ToolResult(ok=False, error="old_text and new_text are required",
                          output="Error: edit_file needs both 'old_text' and 'new_text'")
    old_text, new_text = str(old_text), str(new_text)
    resolved, error = ctx.safety.resolve(raw_path, for_write=True)
    if error:
        return ToolResult(ok=False, error=error, output=f"Error: {error}")
    path = resolved or ""
    if not os.path.exists(path):
        return ToolResult(ok=False, error="File not found", output=f"Error: file not found: {rel(path, ctx.workspace)}")
    before = read_text_safely(path, int(ctx.settings.get("security.max_file_read_bytes", 2_000_000)))
    after, how = _apply_edit(before, old_text, new_text, bool(args.get("replace_all")))
    if after is None:
        return ToolResult(
            ok=False,
            error="Text not found",
            output=(
                f"Error: the given old_text was not found in {rel(path, ctx.workspace)}. "
                "Read the file first and copy the exact text (including indentation)."
            ),
            render="file",
            data={"path": rel(path, ctx.workspace)},
        )
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(after)
    diff = unified_diff(before, after, rel(path, ctx.workspace))
    ctx.audit("edit", f"{rel(path, ctx.workspace)} [{how}]", tool="edit_file", ok=True)
    return ToolResult(
        ok=True,
        output=f"Edited {rel(path, ctx.workspace)} ({how}).\n\n{clip(diff, 8000)}",
        render="diff",
        data={
            "path": rel(path, ctx.workspace),
            "absolute_path": path,
            "diff": diff,
            "how": how,
            "language": guess_language(path),
            "size": os.path.getsize(path),
        },
    )


def _apply_edit(before: str, old_text: str, new_text: str, replace_all: bool) -> Any:
    if old_text == "":
        return (before + new_text), "appended to end"
    if old_text in before:
        count = before.count(old_text)
        if count > 1 and not replace_all:
            return None, ""
        after = before.replace(old_text, new_text) if replace_all else before.replace(old_text, new_text, 1)
        return after, f"{'all ' + str(count) + ' occurrences replaced' if replace_all else '1 occurrence replaced'}"
    # tolerant match: ignore trailing spaces / line ending differences
    normalised = before.replace("\r\n", "\n")
    needle = old_text.replace("\r\n", "\n")
    if needle in normalised:
        after = normalised.replace(needle, new_text.replace("\r\n", "\n"), -1 if replace_all else 1)
        return after, "replaced after line-ending normalisation"
    pattern = re.compile(
        r"[ \t]*".join(re.escape(part) for part in re.split(r"[ \t]+", needle.strip("\n")))
    )
    match = pattern.search(normalised)
    if match:
        after = normalised[: match.start()] + new_text + normalised[match.end():]
        return after, "replaced using whitespace-tolerant match"
    return None, ""


async def tool_delete_path(ctx: ToolContext, args: Dict[str, Any]) -> ToolResult:
    raw_path = str(args.get("path") or "")
    resolved, error = ctx.safety.resolve(raw_path, for_write=True)
    if error:
        return ToolResult(ok=False, error=error, output=f"Error: {error}")
    path = resolved or ""
    if not os.path.exists(path):
        return ToolResult(ok=False, error="Path not found", output=f"Error: path not found: {rel(path, ctx.workspace)}")
    if os.path.abspath(path) == os.path.abspath(ctx.workspace):
        return ToolResult(ok=False, error="Refusing to delete the workspace root",
                          output="Error: refusing to delete the workspace root itself")
    recursive = bool(args.get("recursive")) or os.path.isdir(path)
    try:
        if os.path.isdir(path):
            if not recursive:
                return ToolResult(ok=False, error="Folder needs recursive=true",
                                  output="Error: it is a folder - pass recursive: true to delete it")
            shutil.rmtree(path)
            action = "folder deleted"
        else:
            os.remove(path)
            action = "file deleted"
    except OSError as exc:
        return ToolResult(ok=False, error=str(exc), output=f"Error deleting: {exc}")
    ctx.audit("delete", f"{rel(path, ctx.workspace)} ({action})", tool="delete_path", ok=True)
    return ToolResult(
        ok=True,
        output=f"Deleted {rel(path, ctx.workspace)} ({action})",
        render="file",
        data={"path": rel(path, ctx.workspace), "deleted": True, "kind": action},
    )


async def tool_create_dir(ctx: ToolContext, args: Dict[str, Any]) -> ToolResult:
    raw_path = str(args.get("path") or "")
    resolved, error = ctx.safety.resolve(raw_path, for_write=True)
    if error:
        return ToolResult(ok=False, error=error, output=f"Error: {error}")
    path = resolved or ""
    existed = os.path.isdir(path)
    try:
        os.makedirs(path, exist_ok=True)
    except OSError as exc:
        return ToolResult(ok=False, error=str(exc), output=f"Error: {exc}")
    return ToolResult(
        ok=True,
        output=f"Folder {'already exists' if existed else 'created'}: {rel(path, ctx.workspace)}",
        render="file",
        data={"path": rel(path, ctx.workspace), "created": not existed},
    )


async def tool_move_path(ctx: ToolContext, args: Dict[str, Any]) -> ToolResult:
    source, error = ctx.safety.resolve(str(args.get("source") or args.get("path") or ""))
    if error:
        return ToolResult(ok=False, error=error, output=f"Error: {error}")
    destination, error = ctx.safety.resolve(str(args.get("destination") or args.get("to") or ""), for_write=True)
    if error:
        return ToolResult(ok=False, error=error, output=f"Error: {error}")
    if not source or not destination:
        return ToolResult(ok=False, error="source and destination are required", output="Error: source and destination are required")
    if not os.path.exists(source):
        return ToolResult(ok=False, error="Source not found", output=f"Error: source not found: {rel(source, ctx.workspace)}")
    os.makedirs(os.path.dirname(destination) or ctx.workspace, exist_ok=True)
    try:
        shutil.move(source, destination)
    except (OSError, shutil.Error) as exc:
        return ToolResult(ok=False, error=str(exc), output=f"Error: {exc}")
    ctx.audit("move", f"{rel(source, ctx.workspace)} -> {rel(destination, ctx.workspace)}", tool="move_path", ok=True)
    return ToolResult(
        ok=True,
        output=f"Moved {rel(source, ctx.workspace)} -> {rel(destination, ctx.workspace)}",
        render="file",
        data={"from": rel(source, ctx.workspace), "to": rel(destination, ctx.workspace)},
    )


async def tool_copy_path(ctx: ToolContext, args: Dict[str, Any]) -> ToolResult:
    source, error = ctx.safety.resolve(str(args.get("source") or args.get("path") or ""))
    if error:
        return ToolResult(ok=False, error=error, output=f"Error: {error}")
    destination, error = ctx.safety.resolve(str(args.get("destination") or args.get("to") or ""), for_write=True)
    if error:
        return ToolResult(ok=False, error=error, output=f"Error: {error}")
    if not source or not destination:
        return ToolResult(ok=False, error="source and destination are required", output="Error: source and destination are required")
    if not os.path.exists(source):
        return ToolResult(ok=False, error="Source not found", output=f"Error: source not found: {source}")
    try:
        if os.path.isdir(source):
            shutil.copytree(source, destination, dirs_exist_ok=True)
        else:
            os.makedirs(os.path.dirname(destination) or ctx.workspace, exist_ok=True)
            shutil.copy2(source, destination)
    except (OSError, shutil.Error) as exc:
        return ToolResult(ok=False, error=str(exc), output=f"Error: {exc}")
    return ToolResult(
        ok=True,
        output=f"Copied {rel(source, ctx.workspace)} -> {rel(destination, ctx.workspace)}",
        render="file",
        data={"from": rel(source, ctx.workspace), "to": rel(destination, ctx.workspace)},
    )


async def tool_list_dir(ctx: ToolContext, args: Dict[str, Any]) -> ToolResult:
    raw_path = str(args.get("path") or ".")
    resolved, error = ctx.safety.resolve(raw_path)
    if error:
        return ToolResult(ok=False, error=error, output=f"Error: {error}")
    path = resolved or ctx.workspace
    if not os.path.isdir(path):
        return ToolResult(ok=False, error="Not a folder", output=f"Error: not a folder: {rel(path, ctx.workspace)}")
    recursive = bool(args.get("recursive"))
    depth = int(args.get("depth") or (3 if recursive else 1))
    pattern = str(args.get("pattern") or "")
    hidden = set(ctx.settings.get("workspace.hidden_entries", []) or [])
    show_hidden = bool(args.get("show_hidden"))
    entries: List[Dict[str, Any]] = []
    limit = int(args.get("limit") or 500)

    def walk(current: str, level: int) -> None:
        if len(entries) >= limit or level > depth:
            return
        try:
            names = sorted(os.listdir(current), key=lambda n: (not os.path.isdir(os.path.join(current, n)), n.lower()))
        except OSError:
            return
        for name in names:
            if len(entries) >= limit:
                return
            if not show_hidden and (name in hidden or name.startswith(".")):
                continue
            full = os.path.join(current, name)
            if pattern and not fnmatch.fnmatch(name.lower(), pattern.lower()):
                continue
            try:
                stat = os.stat(full)
            except OSError:
                continue
            is_dir = os.path.isdir(full)
            entries.append({
                "name": name,
                "path": rel(full, ctx.workspace),
                "type": "dir" if is_dir else "file",
                "size": 0 if is_dir else stat.st_size,
                "modified": stat.st_mtime,
                "depth": level,
            })
            if is_dir and recursive:
                walk(full, level + 1)

    walk(path, 1)
    lines = []
    for entry in entries:
        indent = "  " * (entry["depth"] - 1)
        if entry["type"] == "dir":
            lines.append(f"{indent}{entry['name']}/")
        else:
            lines.append(f"{indent}{entry['name']}  ({_human_size(entry['size'])})")
    header = f"{rel(path, ctx.workspace)}/ - {len(entries)} entries"
    if len(entries) >= limit:
        header += f" (limit {limit})"
    return ToolResult(
        ok=True,
        output=header + "\n" + "\n".join(lines) if lines else header + " (empty)",
        render="list",
        data={"path": rel(path, ctx.workspace), "entries": entries[:limit], "count": len(entries)},
    )


async def tool_file_info(ctx: ToolContext, args: Dict[str, Any]) -> ToolResult:
    raw_path = str(args.get("path") or ".")
    resolved, error = ctx.safety.resolve(raw_path)
    if error:
        return ToolResult(ok=False, error=error, output=f"Error: {error}")
    path = resolved or ""
    if not os.path.exists(path):
        return ToolResult(ok=False, error="Path not found", output=f"Error: path not found: {path}")
    stat = os.stat(path)
    is_dir = os.path.isdir(path)
    info = {
        "path": rel(path, ctx.workspace),
        "absolute_path": path,
        "type": "directory" if is_dir else "file",
        "size": stat.st_size,
        "size_human": _human_size(stat.st_size),
        "modified": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(stat.st_mtime)),
        "created": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(getattr(stat, "st_birthtime", stat.st_ctime))),
        "readable": os.access(path, os.R_OK),
        "writable": os.access(path, os.W_OK),
        "language": None if is_dir else guess_language(path),
    }
    if is_dir:
        try:
            info["entries"] = len(os.listdir(path))
        except OSError:
            info["entries"] = -1
    lines = [f"{key}: {value}" for key, value in info.items() if value is not None]
    return ToolResult(ok=True, output="\n".join(lines), render="file", data=info)


async def tool_search_files(ctx: ToolContext, args: Dict[str, Any]) -> ToolResult:
    pattern = str(args.get("pattern") or args.get("query") or "")
    if not pattern:
        return ToolResult(ok=False, error="pattern is required", output="Error: search pattern is empty")
    root_arg = str(args.get("path") or ".")
    resolved, error = ctx.safety.resolve(root_arg)
    if error:
        return ToolResult(ok=False, error=error, output=f"Error: {error}")
    root = resolved or ctx.workspace
    include = str(args.get("include") or "*")
    exclude = str(args.get("exclude") or "")
    ignore_case = bool(args.get("ignore_case", True))
    use_regex = bool(args.get("regex", True))
    max_results = int(args.get("max_results") or 50)
    by_name = bool(args.get("by_name"))
    hidden = set(ctx.settings.get("workspace.hidden_entries", []) or [])
    max_bytes = 2_000_000

    if use_regex:
        try:
            regex = re.compile(pattern, re.IGNORECASE if ignore_case else 0)
        except re.error as exc:
            return ToolResult(ok=False, error=f"Invalid regex: {exc}", output=f"Error: invalid regex: {exc}")
    else:
        flags = re.IGNORECASE if ignore_case else 0
        regex = re.compile(re.escape(pattern), flags)

    matches: List[Dict[str, Any]] = []
    files_scanned = 0
    started = time.time()
    for current, dirs, files in os.walk(root):
        if len(matches) >= max_results or time.time() - started > 25:
            break
        dirs[:] = [d for d in dirs if d not in hidden and not d.startswith(".")]
        for name in files:
            if len(matches) >= max_results:
                break
            if name in hidden or name.startswith("."):
                continue
            if include and not fnmatch.fnmatch(name.lower(), include.lower()):
                continue
            if exclude and fnmatch.fnmatch(name.lower(), exclude.lower()):
                continue
            full = os.path.join(current, name)
            try:
                if os.path.getsize(full) > max_bytes or is_binary(full):
                    continue
                files_scanned += 1
                if by_name:
                    if regex.search(name):
                        matches.append({"path": rel(full, ctx.workspace), "line": 0, "text": name, "kind": "name"})
                    continue
                text = read_text_safely(full, max_bytes)
            except OSError:
                continue
            for line_number, line in enumerate(text.splitlines(), start=1):
                if regex.search(line):
                    matches.append({
                        "path": rel(full, ctx.workspace),
                        "line": line_number,
                        "text": line.strip()[:300],
                        "kind": "content",
                    })
                    if len(matches) >= max_results:
                        break
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for match in matches:
        grouped.setdefault(match["path"], []).append(match)
    lines = [f"Found {len(matches)} matches in {len(grouped)} files ({files_scanned} files scanned):"]
    for path, items in grouped.items():
        lines.append(f"\n{path}")
        for item in items[:12]:
            lines.append(f"  {item['line']}: {item['text']}")
        if len(items) > 12:
            lines.append(f"  ... {len(items) - 12} more")
    return ToolResult(
        ok=True,
        output=clip("\n".join(lines), 20_000),
        render="search",
        data={"matches": matches, "files_scanned": files_scanned, "pattern": pattern, "grouped": grouped},
        meta={"count": len(matches)},
    )


async def tool_workspace_tree(ctx: ToolContext, args: Dict[str, Any]) -> ToolResult:
    depth = int(args.get("depth") or 3)
    root = ctx.workspace
    hidden = set(ctx.settings.get("workspace.hidden_entries", []) or [])
    lines: List[str] = []
    file_count = 0
    limit = int(ctx.settings.get("workspace.max_tree_files", 4000) or 4000)

    def walk(current: str, prefix: str, level: int) -> None:
        nonlocal file_count
        if level > depth or file_count > limit:
            return
        try:
            names = sorted(os.listdir(current), key=lambda n: (not os.path.isdir(os.path.join(current, n)), n.lower()))
        except OSError:
            return
        names = [n for n in names if n not in hidden and not n.startswith(".")]
        for index, name in enumerate(names):
            if file_count > limit:
                lines.append(f"{prefix}... (truncated)")
                return
            full = os.path.join(current, name)
            is_dir = os.path.isdir(full)
            last = index == len(names) - 1
            connector = "└── " if last else "├── "
            lines.append(f"{prefix}{connector}{name}{'/' if is_dir else ''}")
            file_count += 0 if is_dir else 1
            if is_dir:
                walk(full, prefix + ("    " if last else "│   "), level + 1)

    lines.append(os.path.basename(root) + "/")
    walk(root, "", 1)
    output = "\n".join(lines[:400])
    if len(lines) > 400:
        output += f"\n... [{len(lines) - 400} more entries]"
    return ToolResult(
        ok=True,
        output=f"Workspace tree ({root}):\n{output}",
        render="tree",
        data={"root": root, "tree": output, "files": file_count},
    )


async def tool_web_fetch(ctx: ToolContext, args: Dict[str, Any]) -> ToolResult:
    url = str(args.get("url") or "").strip()
    if not url:
        return ToolResult(ok=False, error="url is required", output="Error: url is empty")
    if not re.match(r"^https?://", url, re.IGNORECASE):
        url = "https://" + url
    max_chars = int(args.get("max_chars") or 12_000)
    try:
        import httpx
    except ImportError:
        return ToolResult(ok=False, error="httpx is not installed", output="Error: httpx dependency missing")
    headers = {"User-Agent": "DAGENT/1.0 (+local agent)"}
    started = time.time()
    try:
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True, headers=headers) as client:
            response = await client.get(url)
    except Exception as exc:  # noqa: BLE001
        return ToolResult(ok=False, error=str(exc), output=f"Error fetching {url}: {exc}")
    content_type = response.headers.get("content-type", "")
    body = response.text
    if "html" in content_type.lower():
        body = _html_to_text(body)
    duration_ms = int((time.time() - started) * 1000)
    ctx.audit("web", f"GET {url} -> {response.status_code}", tool="web_fetch", ok=response.status_code < 400)
    return ToolResult(
        ok=response.status_code < 400,
        output=f"HTTP {response.status_code} from {url}\n\n{clip(body.strip(), max_chars)}",
        render="web",
        data={
            "url": str(response.url),
            "status": response.status_code,
            "content_type": content_type,
            "text": clip(body.strip(), max_chars),
            "duration_ms": duration_ms,
        },
        error="" if response.status_code < 400 else f"HTTP {response.status_code}",
    )


_TAG_RE = re.compile(r"<(script|style|noscript|svg|head)[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)
_ANY_TAG_RE = re.compile(r"<[^>]+>")


def _html_to_text(raw_html: str) -> str:
    text = _TAG_RE.sub(" ", raw_html or "")
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</(p|div|li|h[1-6]|tr|section|article)>", "\n", text, flags=re.IGNORECASE)
    text = _ANY_TAG_RE.sub("", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    return text.strip()


async def tool_ask_user(ctx: ToolContext, args: Dict[str, Any]) -> ToolResult:
    question = str(args.get("question") or "").strip()
    if not question:
        return ToolResult(ok=False, error="question is required", output="Error: empty question")
    options = args.get("options") or []
    if isinstance(options, str):
        options = [part.strip() for part in options.split("|") if part.strip()]
    if ctx.approval_callback is None:
        return ToolResult(ok=False, error="No interactive channel available",
                          output="Error: cannot ask the user right now - continue with a reasonable assumption and state it.")
    payload = {
        "kind": "question",
        "question": question,
        "options": list(options)[:6],
        "allow_text": bool(args.get("allow_text", True)),
    }
    response = await ctx.approval_callback("ask_user", payload)
    answer = str(response.get("answer") or response.get("value") or "").strip()
    cancelled = bool(response.get("cancelled"))
    if cancelled or not answer:
        return ToolResult(ok=False, error="User skipped the question",
                          output="The user did not answer. Proceed with the most reasonable option and mention your assumption.",
                          render="question", data=payload)
    return ToolResult(ok=True, output=f"User answered: {answer}", render="question",
                      data={**payload, "answer": answer})


async def tool_remember(ctx: ToolContext, args: Dict[str, Any]) -> ToolResult:
    text = str(args.get("text") or "").strip()
    if not text:
        return ToolResult(ok=False, error="text is required", output="Error: nothing to remember")
    if not ctx.settings.get("agent.memory_enabled", True):
        return ToolResult(ok=False, error="Memory is disabled", output="Error: memory is disabled in Settings -> Agent")
    filename = str(ctx.settings.get("agent.memory_file", "DAGENT_MEMORY.md") or "DAGENT_MEMORY.md")
    path, error = ctx.safety.resolve(os.path.join(ctx.workspace, filename), for_write=True)
    if error:
        return ToolResult(ok=False, error=error, output=f"Error: {error}")
    path = path or os.path.join(ctx.workspace, filename)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tag = str(args.get("tag") or "note")
    stamp = time.strftime("%Y-%m-%d %H:%M")
    entry = f"- [{stamp}] ({tag}) {text}\n"
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(entry)
    return ToolResult(ok=True, output=f"Saved to memory ({rel(path, ctx.workspace)}): {text}",
                      render="file", data={"path": rel(path, ctx.workspace), "entry": entry.strip()})


async def tool_update_plan(ctx: ToolContext, args: Dict[str, Any]) -> ToolResult:
    steps = args.get("steps") or args.get("plan") or []
    if isinstance(steps, str):
        steps = [{"title": part.strip(), "status": "pending"} for part in steps.splitlines() if part.strip()]
    normalised: List[Dict[str, Any]] = []
    for step in steps:
        if isinstance(step, str):
            normalised.append({"title": step, "status": "pending"})
        elif isinstance(step, dict):
            normalised.append({
                "title": str(step.get("title") or step.get("text") or ""),
                "status": str(step.get("status") or "pending").lower(),
                "detail": str(step.get("detail") or ""),
            })
    if not normalised:
        return ToolResult(ok=False, error="No steps given", output="Error: plan is empty")
    await ctx.emit("plan", steps=normalised)
    try:
        ctx.store.update_session(ctx.session_id, meta={"plan": normalised})
    except Exception:  # noqa: BLE001
        pass
    lines = [f"{i + 1}. [{'x' if s['status'] == 'done' else ' '}] {s['title']}" for i, s in enumerate(normalised)]
    return ToolResult(ok=True, output="Plan updated:\n" + "\n".join(lines), render="plan",
                      data={"steps": normalised})


def _human_size(size: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


# --------------------------------------------------------------------------- #
# registry
# --------------------------------------------------------------------------- #

def _schema(properties: Dict[str, Any], required: List[str]) -> Dict[str, Any]:
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


_STR = {"type": "string"}
_BOOL = {"type": "boolean"}
_INT = {"type": "integer"}

TOOL_SPECS: List[ToolSpec] = [
    ToolSpec(
        name="run_command",
        category="system",
        render="command",
        description=(
            "Run a shell command on the user's machine inside the current workspace and return its output. "
            "Use it for builds, tests, git, package managers and diagnostics. Long output is trimmed."
        ),
        parameters=_schema(
            {
                "command": {**_STR, "description": "Full command line, e.g. 'git status' or 'npm run build'"},
                "cwd": {**_STR, "description": "Optional working directory (relative to the workspace)"},
                "timeout": {**_INT, "description": "Timeout in seconds (default 120)"},
            },
            ["command"],
        ),
        handler=tool_run_command,
        examples=[{"command": "git status --short"}],
    ),
    ToolSpec(
        name="python_run",
        category="code",
        render="command",
        description="Execute a Python snippet with the interpreter DAGENT runs on. Good for calculations, data processing and quick scripts.",
        parameters=_schema(
            {
                "code": {**_STR, "description": "Python source code to execute"},
                "timeout": {**_INT, "description": "Timeout in seconds (default 60)"},
                "keep_file": {**_BOOL, "description": "Keep the temporary script file after running"},
            },
            ["code"],
        ),
        handler=tool_python_run,
    ),
    ToolSpec(
        name="read_file",
        category="files",
        render="file",
        description="Read a text file from the workspace and return it with line numbers. Always read a file before editing it.",
        parameters=_schema(
            {
                "path": {**_STR, "description": "File path relative to the workspace (or absolute)"},
                "start_line": {**_INT, "description": "First line to return (1-based)"},
                "max_lines": {**_INT, "description": "Maximum number of lines to return (default 2000)"},
            },
            ["path"],
        ),
        handler=tool_read_file,
    ),
    ToolSpec(
        name="write_file",
        category="files",
        render="diff",
        description="Create a new file or replace/append to an existing one. Parent folders are created automatically.",
        parameters=_schema(
            {
                "path": {**_STR, "description": "File path relative to the workspace"},
                "content": {**_STR, "description": "Full file content to write"},
                "mode": {"type": "string", "enum": ["overwrite", "append"], "description": "Write mode (default overwrite)"},
                "create_dirs": {**_BOOL, "description": "Create missing parent directories (default true)"},
            },
            ["path", "content"],
        ),
        handler=tool_write_file,
    ),
    ToolSpec(
        name="edit_file",
        category="files",
        render="diff",
        description=(
            "Replace an exact piece of text inside a file. Provide enough surrounding context so the match is unique. "
            "Preferred over write_file for existing files."
        ),
        parameters=_schema(
            {
                "path": {**_STR, "description": "File path relative to the workspace"},
                "old_text": {**_STR, "description": "Exact text to find (copy it from read_file output)"},
                "new_text": {**_STR, "description": "Replacement text"},
                "replace_all": {**_BOOL, "description": "Replace every occurrence instead of the first one"},
            },
            ["path", "old_text", "new_text"],
        ),
        handler=tool_edit_file,
    ),
    ToolSpec(
        name="delete_path",
        category="files",
        render="file",
        description="Delete a file or (with recursive=true) a folder. This needs user confirmation unless autopilot is on.",
        parameters=_schema(
            {
                "path": {**_STR, "description": "Path to delete"},
                "recursive": {**_BOOL, "description": "Delete folders with their content"},
            },
            ["path"],
        ),
        handler=tool_delete_path,
    ),
    ToolSpec(
        name="create_dir",
        category="files",
        render="file",
        description="Create a directory (including all missing parents).",
        parameters=_schema({"path": {**_STR, "description": "Directory path"}}, ["path"]),
        handler=tool_create_dir,
    ),
    ToolSpec(
        name="move_path",
        category="files",
        render="file",
        description="Move or rename a file/folder.",
        parameters=_schema(
            {
                "source": {**_STR, "description": "Current path"},
                "destination": {**_STR, "description": "New path"},
            },
            ["source", "destination"],
        ),
        handler=tool_move_path,
    ),
    ToolSpec(
        name="copy_path",
        category="files",
        render="file",
        description="Copy a file or folder to another location.",
        parameters=_schema(
            {
                "source": {**_STR, "description": "Path to copy from"},
                "destination": {**_STR, "description": "Path to copy to"},
            },
            ["source", "destination"],
        ),
        handler=tool_copy_path,
    ),
    ToolSpec(
        name="list_dir",
        category="files",
        render="list",
        description="List files and folders. Use recursive=true with depth to explore a subtree.",
        parameters=_schema(
            {
                "path": {**_STR, "description": "Directory to list (default: workspace root)"},
                "recursive": {**_BOOL, "description": "Walk into subfolders"},
                "depth": {**_INT, "description": "Maximum depth when recursive"},
                "pattern": {**_STR, "description": "Glob filter for names, e.g. '*.py'"},
                "show_hidden": {**_BOOL, "description": "Include dot-files and ignored folders"},
                "limit": {**_INT, "description": "Maximum entries to return"},
            },
            [],
        ),
        handler=tool_list_dir,
    ),
    ToolSpec(
        name="file_info",
        category="files",
        render="file",
        description="Show metadata for a path: size, type, timestamps, permissions.",
        parameters=_schema({"path": {**_STR, "description": "File or folder path"}}, ["path"]),
        handler=tool_file_info,
    ),
    ToolSpec(
        name="search_files",
        category="files",
        render="search",
        description="Search file contents (regex by default) or file names across the workspace and return matching lines.",
        parameters=_schema(
            {
                "pattern": {**_STR, "description": "Regex or literal text to find"},
                "path": {**_STR, "description": "Folder to search in (default: workspace root)"},
                "include": {**_STR, "description": "Glob for file names, e.g. '*.py' (default all)"},
                "exclude": {**_STR, "description": "Glob to skip, e.g. '*.min.js'"},
                "by_name": {**_BOOL, "description": "Match file names instead of contents"},
                "regex": {**_BOOL, "description": "Treat pattern as a regular expression (default true)"},
                "ignore_case": {**_BOOL, "description": "Case-insensitive search (default true)"},
                "max_results": {**_INT, "description": "Maximum matches to return (default 50)"},
            },
            ["pattern"],
        ),
        handler=tool_search_files,
    ),
    ToolSpec(
        name="workspace_tree",
        category="files",
        render="tree",
        description="Print a compact tree of the workspace - the fastest way to understand a project layout.",
        parameters=_schema({"depth": {**_INT, "description": "Tree depth (default 3)"}}, []),
        handler=tool_workspace_tree,
    ),
    ToolSpec(
        name="web_fetch",
        category="web",
        render="web",
        description="Download a web page or JSON endpoint and return its readable text content.",
        parameters=_schema(
            {
                "url": {**_STR, "description": "URL to fetch (http/https)"},
                "max_chars": {**_INT, "description": "Maximum characters to return (default 12000)"},
            },
            ["url"],
        ),
        handler=tool_web_fetch,
    ),
    ToolSpec(
        name="ask_user",
        category="meta",
        render="question",
        description=(
            "Ask the user a question and wait for the answer. Use it when a decision is ambiguous or a choice is needed "
            "(for example which variant to implement, or missing credentials)."
        ),
        parameters=_schema(
            {
                "question": {**_STR, "description": "The question to show"},
                "options": {"type": "array", "items": _STR, "description": "Optional list of suggested answers"},
                "allow_text": {**_BOOL, "description": "Allow a free-form text answer (default true)"},
            },
            ["question"],
        ),
        handler=tool_ask_user,
    ),
    ToolSpec(
        name="remember",
        category="meta",
        render="file",
        description="Save a durable note (user preference, project fact, decision) into the workspace memory file so future sessions remember it.",
        parameters=_schema(
            {
                "text": {**_STR, "description": "What to remember"},
                "tag": {**_STR, "description": "Short category, e.g. 'preference', 'project', 'decision'"},
            },
            ["text"],
        ),
        handler=tool_remember,
    ),
    ToolSpec(
        name="update_plan",
        category="meta",
        render="plan",
        description=(
            "Create or update the visible step plan for a complex task. Call it once at the start with all steps, "
            "then again with status='done' as steps complete. The user sees it as a live checklist."
        ),
        parameters=_schema(
            {
                "steps": {
                    "type": "array",
                    "description": "Ordered plan steps",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {**_STR, "description": "Short step title"},
                            "status": {"type": "string", "enum": ["pending", "active", "done", "skipped"]},
                            "detail": {**_STR, "description": "Optional extra info"},
                        },
                        "required": ["title", "status"],
                    },
                }
            },
            ["steps"],
        ),
        handler=tool_update_plan,
    ),
]

TOOL_INDEX: Dict[str, ToolSpec] = {spec.name: spec for spec in TOOL_SPECS}


def tools_for(names: List[str]) -> List[ToolSpec]:
    return [TOOL_INDEX[name] for name in names if name in TOOL_INDEX]


def specs_for_prompt(specs: List[ToolSpec]) -> List[Dict[str, Any]]:
    """Serialise tool specs for the JSON fallback protocol."""
    return [
        {"name": spec.name, "description": spec.description, "parameters": spec.parameters}
        for spec in specs
    ]


def all_tool_names() -> List[str]:
    return list(TOOL_INDEX.keys())
