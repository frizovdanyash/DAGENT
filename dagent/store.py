"""SQLite persistence for sessions, messages and the audit trail.

Only the standard library is used, so DAGENT has no database server to install.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

from . import paths

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL DEFAULT 'New session',
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL,
    model_id    TEXT,
    mode        TEXT DEFAULT 'assistant',
    workspace   TEXT,
    pinned      INTEGER DEFAULT 0,
    archived    INTEGER DEFAULT 0,
    tags        TEXT DEFAULT '[]',
    stats       TEXT DEFAULT '{}',
    meta        TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT DEFAULT '',
    created_at  REAL NOT NULL,
    meta        TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);

CREATE TABLE IF NOT EXISTS audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  REAL NOT NULL,
    session_id  TEXT,
    kind        TEXT,
    tool        TEXT,
    detail      TEXT,
    approved    INTEGER,
    ok          INTEGER
);
"""


def _now() -> float:
    return time.time()


def new_id() -> str:
    return uuid.uuid4().hex[:16]


class Store:
    def __init__(self, path: Optional[str] = None) -> None:
        self.path = path or str(paths.database_file())
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._conn.executescript(SCHEMA)
            self._conn.commit()

    # ------------------------------------------------------------------ #
    # sessions
    # ------------------------------------------------------------------ #
    def create_session(
        self,
        title: str = "",
        model_id: Optional[str] = None,
        mode: str = "assistant",
        workspace: Optional[str] = None,
        meta: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        sid = new_id()
        now = _now()
        with self._lock:
            self._conn.execute(
                "INSERT INTO sessions (id,title,created_at,updated_at,model_id,mode,workspace,tags,stats,meta)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    sid,
                    title or "New session",
                    now,
                    now,
                    model_id,
                    mode,
                    workspace or "",
                    "[]",
                    "{}",
                    json.dumps(meta or {}, ensure_ascii=False),
                ),
            )
            self._conn.commit()
        return self.get_session(sid) or {}

    def list_sessions(
        self,
        query: str = "",
        include_archived: bool = False,
        limit: int = 500,
    ) -> List[Dict[str, Any]]:
        sql = (
            "SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS msg_count "
            "FROM sessions s"
        )
        args: List[Any] = []
        where: List[str] = []
        if not include_archived:
            where.append("s.archived = 0")
        if query:
            where.append(
                "(s.title LIKE ? OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.content LIKE ?))"
            )
            args.extend([f"%{query}%", f"%{query}%"])
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY s.pinned DESC, s.updated_at DESC LIMIT ?"
        args.append(limit)
        with self._lock:
            rows = self._conn.execute(sql, args).fetchall()
        out = []
        for row in rows:
            item = dict(row)
            item["tags"] = json.loads(item.get("tags") or "[]")
            item["stats"] = json.loads(item.get("stats") or "{}")
            item["meta"] = json.loads(item.get("meta") or "{}")
            out.append(item)
        return out

    def get_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            row = self._conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if not row:
            return None
        item = dict(row)
        item["tags"] = json.loads(item.get("tags") or "[]")
        item["stats"] = json.loads(item.get("stats") or "{}")
        item["meta"] = json.loads(item.get("meta") or "{}")
        return item

    def update_session(self, session_id: str, **fields: Any) -> Optional[Dict[str, Any]]:
        if not fields:
            return self.get_session(session_id)
        allowed = {"title", "model_id", "mode", "workspace", "pinned", "archived", "tags", "stats", "meta"}
        sets: List[str] = []
        args: List[Any] = []
        for key, value in fields.items():
            if key not in allowed:
                continue
            if key in ("tags", "stats", "meta"):
                value = json.dumps(value or ({} if key != "tags" else []), ensure_ascii=False)
            sets.append(f"{key} = ?")
            args.append(value)
        if not sets:
            return self.get_session(session_id)
        sets.append("updated_at = ?")
        args.append(_now())
        args.append(session_id)
        with self._lock:
            self._conn.execute(f"UPDATE sessions SET {', '.join(sets)} WHERE id = ?", args)
            self._conn.commit()
        return self.get_session(session_id)

    def touch(self, session_id: str) -> None:
        with self._lock:
            self._conn.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (_now(), session_id))
            self._conn.commit()

    def delete_session(self, session_id: str) -> bool:
        with self._lock:
            self._conn.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
            cur = self._conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
            self._conn.commit()
            return cur.rowcount > 0

    def duplicate_session(self, session_id: str, with_messages: bool = True) -> Optional[Dict[str, Any]]:
        source = self.get_session(session_id)
        if not source:
            return None
        copy = self.create_session(
            title=f"{source['title']} (copy)",
            model_id=source.get("model_id"),
            mode=source.get("mode") or "assistant",
            workspace=source.get("workspace"),
            meta={"duplicated_from": session_id},
        )
        if with_messages:
            for msg in self.list_messages(session_id):
                self.add_message(
                    copy["id"],
                    msg["role"],
                    msg["content"],
                    meta=msg.get("meta") or {},
                )
        return copy

    # ------------------------------------------------------------------ #
    # messages
    # ------------------------------------------------------------------ #
    def add_message(
        self,
        session_id: str,
        role: str,
        content: str = "",
        meta: Optional[Dict[str, Any]] = None,
        message_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        with self._lock:
            row = self._conn.execute(
                "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            seq = int(row["next"]) if row else 1
            mid = message_id or new_id()
            now = _now()
            self._conn.execute(
                "INSERT INTO messages (id,session_id,seq,role,content,created_at,meta) VALUES (?,?,?,?,?,?,?)",
                (mid, session_id, seq, role, content or "", now, json.dumps(meta or {}, ensure_ascii=False)),
            )
            self._conn.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (now, session_id))
            self._conn.commit()
        return self.get_message(mid) or {}

    def get_message(self, message_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            row = self._conn.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
        if not row:
            return None
        item = dict(row)
        item["meta"] = json.loads(item.get("meta") or "{}")
        return item

    def list_messages(self, session_id: str) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC", (session_id,)
            ).fetchall()
        out = []
        for row in rows:
            item = dict(row)
            item["meta"] = json.loads(item.get("meta") or "{}")
            out.append(item)
        return out

    def update_message(self, message_id: str, content: Optional[str] = None, meta: Optional[Dict[str, Any]] = None,
                       role: Optional[str] = None) -> Optional[Dict[str, Any]]:
        sets: List[str] = []
        args: List[Any] = []
        if content is not None:
            sets.append("content = ?")
            args.append(content)
        if role is not None:
            sets.append("role = ?")
            args.append(role)
        if meta is not None:
            existing = self.get_message(message_id) or {}
            merged = {**(existing.get("meta") or {}), **meta}
            sets.append("meta = ?")
            args.append(json.dumps(merged, ensure_ascii=False))
        if not sets:
            return self.get_message(message_id)
        args.append(message_id)
        with self._lock:
            self._conn.execute(f"UPDATE messages SET {', '.join(sets)} WHERE id = ?", args)
            self._conn.commit()
        return self.get_message(message_id)

    def delete_message(self, message_id: str) -> bool:
        with self._lock:
            cur = self._conn.execute("DELETE FROM messages WHERE id = ?", (message_id,))
            self._conn.commit()
            return cur.rowcount > 0

    def delete_messages_from(self, session_id: str, seq: int) -> int:
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM messages WHERE session_id = ? AND seq >= ?", (session_id, seq)
            )
            self._conn.commit()
            return cur.rowcount

    def truncate_session(self, session_id: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
            self._conn.commit()

    def session_stats(self, session_id: str) -> Dict[str, Any]:
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*) AS c, COALESCE(SUM(LENGTH(content)),0) AS chars FROM messages WHERE session_id = ?",
                (session_id,),
            ).fetchone()
        msgs = self.list_messages(session_id)
        tokens = sum(int((m.get("meta") or {}).get("usage", {}).get("total_tokens", 0) or 0) for m in msgs)
        return {
            "messages": int(row["c"]) if row else 0,
            "chars": int(row["chars"]) if row else 0,
            "tokens": tokens,
        }

    def search(self, query: str, limit: int = 100) -> List[Dict[str, Any]]:
        like = f"%{query}%"
        with self._lock:
            rows = self._conn.execute(
                "SELECT m.*, s.title AS session_title FROM messages m JOIN sessions s ON s.id = m.session_id "
                "WHERE m.content LIKE ? ORDER BY m.created_at DESC LIMIT ?",
                (like, limit),
            ).fetchall()
        out = []
        for row in rows:
            item = dict(row)
            item["meta"] = json.loads(item.get("meta") or "{}")
            snippet = item.get("content") or ""
            idx = snippet.lower().find(query.lower())
            start = max(0, idx - 60)
            item["snippet"] = ("..." if start else "") + snippet[start:start + 180].replace("\n", " ")
            out.append(item)
        return out

    def totals(self) -> Dict[str, Any]:
        with self._lock:
            s = self._conn.execute("SELECT COUNT(*) AS c FROM sessions").fetchone()
            m = self._conn.execute("SELECT COUNT(*) AS c FROM messages").fetchone()
        return {"sessions": int(s["c"]), "messages": int(m["c"])}

    # ------------------------------------------------------------------ #
    # audit
    # ------------------------------------------------------------------ #
    def audit(self, kind: str, detail: str = "", tool: str = "", session_id: str = "",
              approved: Optional[bool] = None, ok: Optional[bool] = None) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO audit (created_at,session_id,kind,tool,detail,approved,ok) VALUES (?,?,?,?,?,?,?)",
                (
                    _now(),
                    session_id or "",
                    kind,
                    tool or "",
                    detail[:4000],
                    None if approved is None else int(approved),
                    None if ok is None else int(ok),
                ),
            )
            self._conn.commit()
        if kind in ("tool", "command"):
            try:
                with open(paths.audit_file(), "a", encoding="utf-8") as fh:
                    fh.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')}\t{kind}\t{tool}\t{detail[:500]}\n")
            except Exception:
                pass

    def list_audit(self, limit: int = 300) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM audit ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]

    def close(self) -> None:
        with self._lock:
            try:
                self._conn.close()
            except Exception:
                pass


def export_session(store: Store, session_id: str, fmt: str = "json") -> Tuple[str, str]:
    """Return ``(filename, content)`` for a session export."""
    session = store.get_session(session_id) or {}
    messages = store.list_messages(session_id)
    safe_title = "".join(ch if ch.isalnum() or ch in " -_" else "" for ch in str(session.get("title", "session")))[:40]
    safe_title = safe_title.strip().replace(" ", "_") or "session"
    if fmt == "md":
        lines = [f"# {session.get('title', 'DAGENT session')}", ""]
        lines.append(f"- created: {time.strftime('%Y-%m-%d %H:%M', time.localtime(session.get('created_at', 0)))}")
        lines.append(f"- mode: {session.get('mode', '')}  |  model: {session.get('model_id', '')}")
        lines.append("")
        for msg in messages:
            meta = msg.get("meta") or {}
            lines.append(f"## {msg['role'].upper()}")
            if meta.get("tool_calls"):
                for call in meta["tool_calls"]:
                    lines.append(f"> tool `{call.get('tool')}` args `{json.dumps(call.get('args', {}), ensure_ascii=False)[:300]}`")
            lines.append("")
            lines.append(msg.get("content") or "")
            lines.append("")
            for result in meta.get("tool_results") or []:
                lines.append("```")
                lines.append(str(result.get("output", ""))[:4000])
                lines.append("```")
                lines.append("")
        return f"{safe_title}.md", "\n".join(lines)
    payload = {"session": session, "messages": messages, "exported_at": _now(), "app": "DAGENT"}
    return f"{safe_title}.json", json.dumps(payload, ensure_ascii=False, indent=2)


store = Store()
