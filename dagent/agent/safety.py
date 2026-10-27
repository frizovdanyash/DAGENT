"""Permission & safety engine.

Every tool call passes through here. The engine decides between three outcomes:

* **allow**          - execute immediately
* **ask**            - the GUI shows an approval card and waits for the user
* **block**          - refuse and explain why (nothing is executed)

Rules come from settings (deny patterns, always-allow list, sandbox, sensitive
paths) plus the current mode (Chat has no tools, Autopilot auto-approves...).
"""

from __future__ import annotations

import os
import re
import shlex
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

RISK_LOW = "low"
RISK_MEDIUM = "medium"
RISK_HIGH = "high"
RISK_BLOCKED = "blocked"

HIGH_RISK_KEYWORDS = [
    "rm -rf", "rm -r ", "rm -f", "sudo", "su ", "chmod -r", "chown -r", "mkfs", "dd if=",
    "shutdown", "reboot", "kill -9 1", ":(){", "git push --force", "git reset --hard",
    "git clean -fd", "curl", "wget", "nc ", "netcat", "scp ", "rsync", "ssh ",
    "del /f", "del /s", "rmdir /s", "format", "reg delete", "reg add", "powershell -enc",
    "iex", "invoke-expression", "remove-item -recurse", "set-executionpolicy", "npm publish",
    "pip install", "npm install -g", "apt install", "apt-get install", "brew install",
    "docker rm", "docker system prune", "kubectl delete", "truncate", "shred",
]

EXECUTION_TOOLS = {"run_command", "python_run"}
WRITE_TOOLS = {"write_file", "edit_file", "create_dir", "move_path", "copy_path", "delete_path", "remember"}
NETWORK_TOOLS = {"web_fetch"}
READ_TOOLS = {"read_file", "list_dir", "file_info", "search_files", "workspace_tree", "session_context"}
INTERACTIVE_TOOLS = {"ask_user"}

# Tool -> default risk when nothing else matches.
DEFAULT_RISK = {
    **{name: RISK_LOW for name in READ_TOOLS},
    "write_file": RISK_MEDIUM,
    "edit_file": RISK_MEDIUM,
    "create_dir": RISK_LOW,
    "move_path": RISK_MEDIUM,
    "copy_path": RISK_LOW,
    "delete_path": RISK_HIGH,
    "remember": RISK_LOW,
    "run_command": RISK_MEDIUM,
    "python_run": RISK_MEDIUM,
    "web_fetch": RISK_MEDIUM,
    "ask_user": RISK_LOW,
}


@dataclass
class Decision:
    allowed: bool
    needs_approval: bool = False
    risk: str = RISK_LOW
    reason: str = ""
    blocked: bool = False
    detail: Dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "allowed": self.allowed,
            "needs_approval": self.needs_approval,
            "risk": self.risk,
            "reason": self.reason,
            "blocked": self.blocked,
            "detail": self.detail,
        }


ALLOW = Decision(allowed=True, risk=RISK_LOW, reason="auto-approved")


class SafetyEngine:
    def __init__(self, settings: Any, workspace_root: str = "") -> None:
        self.settings = settings
        self.workspace_root = os.path.abspath(os.path.expanduser(workspace_root or settings.get("workspace.root") or "."))

    # ------------------------------------------------------------------ #
    # configuration helpers
    # ------------------------------------------------------------------ #
    def set_workspace(self, workspace_root: str) -> None:
        self.workspace_root = os.path.abspath(os.path.expanduser(workspace_root or "."))

    def _sec(self, key: str, default: Any = None) -> Any:
        return self.settings.get(f"security.{key}", default)

    def _compiled_deny(self) -> List[re.Pattern]:
        patterns = []
        for raw in self._sec("denied_commands", []) or []:
            try:
                patterns.append(re.compile(raw, re.IGNORECASE))
            except re.error:
                patterns.append(re.compile(re.escape(raw), re.IGNORECASE))
        return patterns

    # ------------------------------------------------------------------ #
    # path handling
    # ------------------------------------------------------------------ #
    def resolve(self, raw_path: str, for_write: bool = False) -> Tuple[Optional[str], Optional[str]]:
        """Resolve a user/model supplied path. Returns ``(absolute_path, error)``."""
        if not raw_path or not str(raw_path).strip():
            return None, "Path is empty"
        candidate = str(raw_path).strip().strip('"').strip("'")
        expanded = os.path.expanduser(candidate)
        if os.path.isabs(expanded):
            absolute = os.path.abspath(expanded)
        else:
            absolute = os.path.abspath(os.path.join(self.workspace_root, expanded))
        # Resolve symlinks when the target exists so escapes are detected.
        try:
            if os.path.exists(absolute):
                absolute = str(Path(absolute).resolve())
        except OSError:
            pass
        sandbox = bool(self.settings.get("workspace.sandbox", True))
        inside = self._is_inside(absolute, self.workspace_root)
        if not inside and sandbox:
            if for_write or not self.settings.get("workspace.allow_read_outside", False):
                return None, (
                    f"Path is outside the workspace ({self.workspace_root}). "
                    "Enable 'Allow paths outside workspace' in Settings -> Workspace if you really need this."
                )
        for sensitive in self._sec("sensitive_paths", []) or []:
            sensitive_abs = os.path.abspath(os.path.expanduser(str(sensitive)))
            if absolute == sensitive_abs or absolute.startswith(sensitive_abs + os.sep):
                return None, f"Access to a protected system path is blocked: {sensitive_abs}"
        return absolute, None

    @staticmethod
    def _is_inside(path: str, root: str) -> bool:
        if not root:
            return True
        try:
            return os.path.commonpath([os.path.abspath(path), os.path.abspath(root)]) == os.path.abspath(root)
        except ValueError:
            return False

    def inside_workspace(self, path: str) -> bool:
        return self._is_inside(path, self.workspace_root)

    # ------------------------------------------------------------------ #
    # commands
    # ------------------------------------------------------------------ #
    def classify_command(self, command: str) -> Tuple[str, str]:
        """Return ``(risk, reason)`` for a shell command."""
        text = (command or "").strip()
        if not text:
            return RISK_BLOCKED, "Empty command"
        for pattern in self._compiled_deny():
            if pattern.search(text):
                return RISK_BLOCKED, f"Command matches a blocked pattern: {pattern.pattern}"
        lowered = f" {text.lower()} "
        hits = [keyword for keyword in HIGH_RISK_KEYWORDS if keyword in lowered]
        always_allow = [str(item).strip().lower() for item in self._sec("always_allow_commands", []) or [] if str(item).strip()]
        head = text.lower()
        for allowed in always_allow:
            if head == allowed or head.startswith(allowed + " ") or head.startswith(allowed + ";"):
                return RISK_LOW, "Command is in the always-allow list"
        if hits:
            return RISK_HIGH, "Potentially destructive or network command: " + ", ".join(sorted(set(hits))[:4])
        if re.search(r"[|;&`$><]|\&\&|\|\|", text):
            return RISK_MEDIUM, "Command uses shell operators (pipes, redirects or chaining)"
        return RISK_LOW, "Simple read-only style command"

    def shell_command(self) -> Tuple[List[str], str]:
        """Return the argv prefix and shell label used to run commands."""
        choice = str(self._sec("shell", "auto") or "auto").lower()
        custom = str(self._sec("custom_shell", "") or "")
        if choice == "custom" and custom:
            return [custom, "-c"], custom
        if os.name == "nt":
            if choice in ("powershell", "auto"):
                exe = os.environ.get("COMSPEC", "")
                ps = "powershell.exe"
                return [ps, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"], "powershell"
            if choice == "cmd":
                return [os.environ.get("COMSPEC", "cmd.exe"), "/c"], "cmd"
            return ["cmd.exe", "/c"], "cmd"
        if choice in ("bash", "auto"):
            for candidate in ("/bin/bash", "/usr/bin/bash", "/opt/homebrew/bin/bash"):
                if os.path.exists(candidate):
                    return [candidate, "-lc"], "bash"
        return ["/bin/sh", "-c"], "sh"

    # ------------------------------------------------------------------ #
    # main entry point
    # ------------------------------------------------------------------ #
    def decide(
        self,
        tool: str,
        args: Dict[str, Any],
        mode: str = "assistant",
        mode_auto_approve: bool = False,
        session_allow: Optional[set] = None,
    ) -> Decision:
        global_auto = bool(self._sec("auto_approve", False))
        auto = global_auto or bool(mode_auto_approve)
        session_allow = session_allow or set()
        risk, reason = RISK_LOW, ""

        # -- tool level switches ------------------------------------------- #
        if tool in EXECUTION_TOOLS and not self._sec("allow_python_exec", True) and tool == "python_run":
            return Decision(allowed=False, blocked=True, risk=RISK_BLOCKED,
                            reason="Python execution is disabled in Settings -> Security")
        if tool in NETWORK_TOOLS and not self._sec("allow_network_tools", True):
            return Decision(allowed=False, blocked=True, risk=RISK_BLOCKED,
                            reason="Network tools are disabled in Settings -> Security")
        if tool == "delete_path" and not self._sec("allow_delete", True):
            return Decision(allowed=False, blocked=True, risk=RISK_BLOCKED,
                            reason="Deleting files is disabled in Settings -> Security")

        # -- commands ------------------------------------------------------- #
        if tool == "run_command":
            command = str(args.get("command") or "")
            risk, reason = self.classify_command(command)
            if risk == RISK_BLOCKED:
                return Decision(allowed=False, blocked=True, risk=risk, reason=reason,
                                detail={"command": command})
            key = f"cmd:{_command_signature(command)}"
            if key in session_allow:
                return Decision(allowed=True, risk=RISK_LOW, reason="Approved earlier in this session")
            if risk == RISK_LOW and self._sec("auto_approve_reads", True):
                return Decision(allowed=True, risk=risk, reason=reason)
            if auto:
                return Decision(allowed=True, risk=risk, reason=f"Auto-approve is on ({reason})")
            return Decision(allowed=True, needs_approval=True, risk=risk, reason=reason, detail={"command": command})

        if tool == "python_run":
            code = str(args.get("code") or "")
            risk = RISK_HIGH if re.search(r"subprocess|os\.system|shutil\.rmtree|socket|requests|urllib", code) else RISK_MEDIUM
            reason = "Executes arbitrary Python code"
            if auto:
                return Decision(allowed=True, risk=risk, reason=f"Auto-approve is on ({reason})")
            return Decision(allowed=True, needs_approval=True, risk=risk, reason=reason)

        # -- paths ---------------------------------------------------------- #
        path_arg = args.get("path") or args.get("file") or args.get("target") or args.get("destination") or ""
        if isinstance(path_arg, list):
            path_arg = path_arg[0] if path_arg else ""
        absolute: Optional[str] = None
        if path_arg:
            for_write = tool in WRITE_TOOLS
            resolved, error = self.resolve(str(path_arg), for_write=for_write)
            if error:
                return Decision(allowed=False, blocked=True, risk=RISK_BLOCKED, reason=error,
                                detail={"path": str(path_arg)})
            absolute = resolved
            if for_write and absolute and not self.inside_workspace(absolute):
                if not self._sec("allow_write_outside_workspace", False):
                    return Decision(allowed=False, blocked=True, risk=RISK_BLOCKED,
                                    reason="Writing outside the workspace is disabled in Settings -> Security",
                                    detail={"path": absolute})
            # second path argument (move/copy source or destination)
            for extra_key in ("source", "destination", "new_path", "to"):
                extra = args.get(extra_key)
                if extra:
                    extra_abs, extra_err = self.resolve(str(extra), for_write=for_write)
                    if extra_err:
                        return Decision(allowed=False, blocked=True, risk=RISK_BLOCKED, reason=extra_err,
                                        detail={"path": str(extra)})

        risk = DEFAULT_RISK.get(tool, RISK_MEDIUM)
        if tool == "delete_path":
            risk = RISK_HIGH
            reason = "Deletes files or folders"
            target_is_dir = bool(absolute and os.path.isdir(absolute))
            if not self._sec("confirm_delete", True) and auto:
                return Decision(allowed=True, risk=RISK_MEDIUM, reason="Delete confirmation disabled")
            if auto and not target_is_dir:
                return Decision(allowed=True, risk=risk, reason="Auto-approve is on")
            return Decision(allowed=True, needs_approval=True, risk=risk, reason=reason,
                            detail={"path": absolute, "recursive": bool(args.get("recursive"))})
        if tool in ("write_file", "edit_file", "move_path"):
            reason = "Modifies a file"
            key = f"write:{os.path.dirname(absolute or '')}"
            if key in session_allow:
                return Decision(allowed=True, risk=RISK_LOW, reason="Folder approved earlier in this session")
            if auto:
                return Decision(allowed=True, risk=risk, reason="Auto-approve is on")
            return Decision(allowed=True, needs_approval=True, risk=risk, reason=reason, detail={"path": absolute})
        if tool in NETWORK_TOOLS:
            reason = "Requests an external URL"
            if auto:
                return Decision(allowed=True, risk=risk, reason="Auto-approve is on")
            key = f"host:{_host_of(str(args.get('url') or ''))}"
            if key in session_allow:
                return Decision(allowed=True, risk=RISK_LOW, reason="Host approved earlier in this session")
            return Decision(allowed=True, needs_approval=True, risk=risk, reason=reason)
        if tool in READ_TOOLS or tool in INTERACTIVE_TOOLS or tool == "create_dir" or tool == "copy_path" \
                or tool == "remember":
            return Decision(allowed=True, risk=RISK_LOW, reason=reason or "Read-only / safe operation")

        # unknown tool -> be careful
        if auto:
            return Decision(allowed=True, risk=risk, reason="Auto-approve is on")
        return Decision(allowed=True, needs_approval=True, risk=risk, reason="Unknown tool - please confirm")


def _command_signature(command: str) -> str:
    """First two tokens of a command, used for 'always allow this' decisions."""
    try:
        tokens = shlex.split(command, posix=os.name != "nt")
    except ValueError:
        tokens = command.split()
    return " ".join(tokens[:2]).lower()


def _host_of(url: str) -> str:
    match = re.match(r"[a-zA-Z][a-zA-Z0-9+.-]*://([^/]+)", url or "")
    return match.group(1) if match else (url or "")[:40]


def risk_color(risk: str) -> str:
    return {
        RISK_LOW: "#35d07f",
        RISK_MEDIUM: "#f5b942",
        RISK_HIGH: "#ff6b6b",
        RISK_BLOCKED: "#ff3b3b",
    }.get(risk, "#8b93a7")
