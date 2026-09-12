"""Rebuildable desktop projection index over authoritative append-only session logs."""

from __future__ import annotations

import base64
import json
import sqlite3
import uuid
from contextlib import closing

from cleo.desktop.projection import timeline_from_events
from cleo.memory.paths import events_path

PAGE_SIZE = 80
PREVIEW_CHARS = 8192
PAGE_BYTES = 512 * 1024


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


class TimelineIndex:
    """Incrementally project new events; page logical items with stable indexed positions."""

    def __init__(self, store, manifest):
        self.store = store
        self.source = events_path(
            store.memory_root, manifest["space"], manifest["project"], manifest["id"]
        )
        self.path = self.source.with_name(".desktop-timeline-v1.sqlite3")
        self.session_id = manifest["id"]

    def _connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.is_symlink():
            raise ValueError("历史索引不能使用链接文件。")
        try:
            return self._open_database()
        except sqlite3.DatabaseError as exc:
            if getattr(exc, "sqlite_errorcode", None) not in {
                sqlite3.SQLITE_CORRUPT,
                sqlite3.SQLITE_NOTADB,
            }:
                raise
            self.path.unlink(missing_ok=True)
            return self._open_database()

    def _open_database(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            db.executescript("""
            CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS items (
                position INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL,
                turn_id TEXT NOT NULL, body TEXT NOT NULL, preview TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS items_turn ON items(turn_id);
            CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, answered INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS relations (
                turn_id TEXT, kind TEXT, alias TEXT, item_id TEXT,
                PRIMARY KEY(turn_id,kind,alias));
            CREATE TABLE IF NOT EXISTS events (
                offset INTEGER PRIMARY KEY, type TEXT NOT NULL, body TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS events_type ON events(type, offset);
            """)
        except sqlite3.DatabaseError:
            db.close()
            raise
        return db

    def _sync(self, db):
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT value FROM metadata WHERE id=1").fetchone()
        old = json.loads(row[0]) if row else None
        try:
            info = self.source.stat()
        except FileNotFoundError:
            info = None
        signature = [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns] if info else None
        if old and old["signature"] == signature:
            db.commit()
            return old
        reset = (
            old is None
            or signature is None
            or old["signature"] is None
            or signature[:2] != old["signature"][:2]
            or signature[2] <= old["signature"][2]
        )
        start = 0 if reset else old["offset"]
        epoch = uuid.uuid4().hex if reset else old["epoch"]
        if reset:
            for table in ("items", "events", "turns", "relations"):
                db.execute(f"DELETE FROM {table}")
        position = db.execute("SELECT coalesce(max(position),0) FROM items").fetchone()[0]
        turn_id = "initial" if reset else old["turn_id"]
        offset = start
        if info is not None:
            with self.source.open("rb") as stream:
                stream.seek(start)
                while line := stream.readline():
                    line_start = stream.tell() - len(line)
                    if not line.endswith(b"\n"):
                        break  # An append still in progress is read on the next refresh.
                    event = json.loads(line)
                    if (not isinstance(event, dict) or event.get("schema_version", 1) != 1
                            or type(event.get("seq")) is not int):
                        raise ValueError("无法读取此版本的会话历史。")
                    changed = []
                    state = {"turn_id": turn_id, "changed": changed}
                    kinds = ("tools", "plans", "thoughts", "questions", "answers")
                    state.update(
                        {kind: _ProjectionMap(db, turn_id, kind, changed) for kind in kinds}
                    )
                    projected = timeline_from_events([event], state=state)
                    turn_id = state["turn_id"]
                    db.execute("INSERT OR IGNORE INTO turns VALUES (?,0)", (turn_id,))
                    for item in {item["id"]: item for item in projected}.values():
                        if item["type"] not in {"message", "question"} and not item[
                            "id"
                        ].startswith(item["turnId"] + ":"):
                            item["id"] = f"{item['turnId']}:{item['id']}"
                        if (item["type"] == "message" and item["role"] == "assistant"
                                and item["content"].strip()):
                            db.execute("UPDATE turns SET answered=1 WHERE id=?", (turn_id,))
                        saved = db.execute(
                            "SELECT position FROM items WHERE id=?", (item["id"],)
                        ).fetchone()
                        if saved is None:
                            position += 1
                        preview = dict(item)
                        for field in ("content", "output", "command"):
                            value = preview.get(field)
                            if isinstance(value, str) and len(value) > PREVIEW_CHARS:
                                preview[field] = value[:PREVIEW_CHARS]
                                preview.setdefault("more", {})[field] = len(value)
                        db.execute(
                            "INSERT OR REPLACE INTO items VALUES (?,?,?,?,?)",
                            (
                                saved[0] if saved else position,
                                item["id"],
                                item["turnId"],
                                _json(item),
                                _json(preview),
                            ),
                        )
                    db.execute(
                        "INSERT INTO events VALUES (?,?,?)",
                        (line_start, str(event.get("type") or ""), _json(event)),
                    )
                    offset = stream.tell()
        meta = {
            "signature": signature,
            "epoch": epoch,
            "turn_id": turn_id,
            "offset": offset,
            "total": position,
        }
        db.execute("INSERT OR REPLACE INTO metadata VALUES (1,?)", (_json(meta),))
        db.commit()
        return meta

    @staticmethod
    def _cursor(epoch, position):
        return base64.urlsafe_b64encode(_json([epoch, position]).encode()).decode().rstrip("=")

    @staticmethod
    def _position(cursor, epoch):
        try:
            decoded = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
            version, position = json.loads(decoded)
        except (ValueError, TypeError, UnicodeError) as exc:
            raise ValueError("历史游标无效，请回到最新。") from exc
        if version != epoch or type(position) is not int or position < 0:
            raise ValueError("历史已变化，请回到最新重新加载。")
        return position

    def page(self, *, cursor=None, direction="latest", limit=PAGE_SIZE):
        if direction not in {"latest", "before", "after"} or type(limit) is not int:
            raise ValueError("历史分页参数无效。")
        if not 1 <= limit <= 100 or (direction != "latest" and not isinstance(cursor, str)):
            raise ValueError("历史分页参数无效。")
        with closing(self._connect()) as db, db:
            meta = self._sync(db)
            pivot = (
                meta["total"] + 1
                if direction == "latest"
                else self._position(cursor, meta["epoch"])
            )
            operator, order = (">", "ASC") if direction == "after" else ("<", "DESC")
            rows = db.execute(
                "SELECT position,preview,answered FROM items JOIN turns ON turns.id=items.turn_id "
                f"WHERE position{operator}? "
                f"ORDER BY position {order} LIMIT ?",
                (pivot, limit),
            )
            selected = []
            size = 0
            for row in rows:
                length = len(row["preview"].encode())
                if selected and size + length > PAGE_BYTES:
                    break
                item = json.loads(row["preview"])
                item["turnHasAnswer"] = bool(row["answered"])
                selected.append((row["position"], item))
                size += length
            if direction != "after":
                selected.reverse()
            first = selected[0][0] if selected else (pivot if direction == "after" else 1)
            last = (
                selected[-1][0] if selected else (pivot if direction == "before" else meta["total"])
            )
            for position, item in selected:
                item["cursor"] = self._cursor(meta["epoch"], position)
                item["order"] = position
            return {
                "items": [item for _, item in selected],
                "total": meta["total"],
                "before": self._cursor(meta["epoch"], first),
                "after": self._cursor(meta["epoch"], last),
                "hasBefore": first > 1,
                "hasAfter": last < meta["total"],
                "revision": f"{meta['epoch']}:{meta['offset']}",
            }

    def content(self, item_id, field, offset=0, limit=16384):
        if field not in {"content", "output", "command"} or type(offset) is not int or offset < 0:
            raise ValueError("正文分页参数无效。")
        if type(limit) is not int or not 1 <= limit <= 16384:
            raise ValueError("正文分页参数无效。")
        with closing(self._connect()) as db, db:
            self._sync(db)
            row = db.execute(
                "SELECT substr(json_extract(body,?),?,?),length(json_extract(body,?)) "
                "FROM items WHERE id=?",
                (f"$.{field}", offset + 1, limit, f"$.{field}", item_id),
            ).fetchone()
            if row is None or row[0] is None:
                raise ValueError("找不到这条历史内容，请重新加载。")
            return {"text": row[0], "offset": offset, "next": offset + len(row[0]), "total": row[1]}

    def recent_events(self):
        with closing(self._connect()) as db, db:
            self._sync(db)
            # Sidebar metadata is bounded too; history browsing uses page(), never read_events().
            rows = db.execute(
                "SELECT body FROM events WHERE type IN "
                "('user_message','human','status','terminal_output','file_change','turn_diff') "
                "ORDER BY offset DESC LIMIT 200",
            )
            return list(reversed([json.loads(row[0]) for row in rows]))

    def location_for(self, item_id):
        with closing(self._connect()) as db, db:
            meta = self._sync(db)
            row = db.execute("SELECT position FROM items WHERE id=?", (item_id,)).fetchone()
            return {"cursor": self._cursor(meta["epoch"], row[0]), "order": row[0]} if row else None


class _ProjectionMap:
    """Load only the tool/plan/thought/question touched by a new event."""

    def __init__(self, db, turn_id, kind, changed):
        self.db, self.turn_id, self.kind, self.changed = db, turn_id, kind, changed

    def get(self, key):
        row = self.db.execute(
            "SELECT body FROM relations JOIN items ON items.id=relations.item_id "
            "WHERE relations.turn_id=? AND kind=? AND alias=?",
            (self.turn_id, self.kind, key),
        ).fetchone()
        if row is not None:
            item = json.loads(row[0])
            self.changed.append(item)
            return item
        return None

    def __contains__(self, key):
        return (
            self.db.execute(
                "SELECT 1 FROM relations WHERE turn_id=? AND kind=? AND alias=?",
                (self.turn_id, self.kind, key),
            ).fetchone()
            is not None
        )

    def __getitem__(self, key):
        result = self.get(key)
        if result is None:
            raise KeyError(key)
        return result

    def __setitem__(self, key, item):
        if item["type"] not in {"question", "message"} and not item["id"].startswith(
            self.turn_id + ":"
        ):
            item["id"] = f"{self.turn_id}:{item['id']}"
        self.db.execute(
            "INSERT OR REPLACE INTO relations VALUES (?,?,?,?)",
            (self.turn_id, self.kind, key, item["id"]),
        )

    def values(self):
        rows = self.db.execute(
            "SELECT body FROM items WHERE turn_id=? AND json_extract(body,'$.status')='running' "
            "AND json_extract(body,'$.type')='tool'",
            (self.turn_id,),
        )
        values = [json.loads(row[0]) for row in rows]
        self.changed.extend(values)
        return values
