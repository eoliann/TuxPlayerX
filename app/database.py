from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from app.config import DATABASE_PATH


@dataclass(slots=True)
class Subscription:
    id: int | None
    name: str
    type: str
    url: str | None = None
    portal_url: str | None = None
    mac_address: str | None = None
    username: str | None = None
    password: str | None = None
    is_default: bool = False
    expires_at: str | None = None
    active_connections: int | None = None
    max_connections: int | None = None
    created_at: str | None = None
    updated_at: str | None = None


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


class Database:
    def __init__(self, path: Path = DATABASE_PATH) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.init_db()

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def init_db(self) -> None:
        with self.connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS subscriptions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    type TEXT NOT NULL CHECK(type IN ('m3u', 'mac')),
                    url TEXT,
                    portal_url TEXT,
                    mac_address TEXT,
                    username TEXT,
                    password TEXT,
                    is_default INTEGER NOT NULL DEFAULT 0,
                    expires_at TEXT,
                    active_connections INTEGER,
                    max_connections INTEGER,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS favorites (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    subscription_id INTEGER NOT NULL,
                    channel_name TEXT NOT NULL,
                    stream_url TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
                );
                """
            )
            defaults = {
                "theme": "dark",
                "check_updates_on_startup": "true",
                "network_cache_ms": "3000",
                "resume_last_channel": "true",
                "mask_sensitive_data": "true",
            }
            for key, value in defaults.items():
                conn.execute(
                    "INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)",
                    (key, value),
                )

    @staticmethod
    def _row_to_subscription(row: sqlite3.Row) -> Subscription:
        return Subscription(
            id=row["id"],
            name=row["name"],
            type=row["type"],
            url=row["url"],
            portal_url=row["portal_url"],
            mac_address=row["mac_address"],
            username=row["username"],
            password=row["password"],
            is_default=bool(row["is_default"]),
            expires_at=row["expires_at"],
            active_connections=row["active_connections"],
            max_connections=row["max_connections"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def list_subscriptions(self) -> list[Subscription]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM subscriptions ORDER BY is_default DESC, name COLLATE NOCASE ASC"
            ).fetchall()
        return [self._row_to_subscription(row) for row in rows]

    def get_subscription(self, subscription_id: int) -> Subscription | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM subscriptions WHERE id = ?", (subscription_id,)
            ).fetchone()
        return self._row_to_subscription(row) if row else None

    def get_default_subscription(self) -> Subscription | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM subscriptions WHERE is_default = 1 ORDER BY id DESC LIMIT 1"
            ).fetchone()
        return self._row_to_subscription(row) if row else None

    def save_subscription(self, subscription: Subscription) -> int:
        timestamp = now_iso()
        with self.connect() as conn:
            if subscription.is_default:
                conn.execute("UPDATE subscriptions SET is_default = 0")

            if subscription.id is None:
                cursor = conn.execute(
                    """
                    INSERT INTO subscriptions(
                        name, type, url, portal_url, mac_address, username, password,
                        is_default, expires_at, active_connections, max_connections,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        subscription.name,
                        subscription.type,
                        subscription.url,
                        subscription.portal_url,
                        subscription.mac_address,
                        subscription.username,
                        subscription.password,
                        1 if subscription.is_default else 0,
                        subscription.expires_at,
                        subscription.active_connections,
                        subscription.max_connections,
                        timestamp,
                        timestamp,
                    ),
                )
                return int(cursor.lastrowid)

            conn.execute(
                """
                UPDATE subscriptions
                SET name = ?, type = ?, url = ?, portal_url = ?, mac_address = ?,
                    username = ?, password = ?, is_default = ?, expires_at = ?,
                    active_connections = ?, max_connections = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    subscription.name,
                    subscription.type,
                    subscription.url,
                    subscription.portal_url,
                    subscription.mac_address,
                    subscription.username,
                    subscription.password,
                    1 if subscription.is_default else 0,
                    subscription.expires_at,
                    subscription.active_connections,
                    subscription.max_connections,
                    timestamp,
                    subscription.id,
                ),
            )
            return int(subscription.id)

    def delete_subscription(self, subscription_id: int) -> None:
        with self.connect() as conn:
            conn.execute("DELETE FROM subscriptions WHERE id = ?", (subscription_id,))

    def set_default_subscription(self, subscription_id: int) -> None:
        with self.connect() as conn:
            conn.execute("UPDATE subscriptions SET is_default = 0")
            conn.execute(
                "UPDATE subscriptions SET is_default = 1, updated_at = ? WHERE id = ?",
                (now_iso(), subscription_id),
            )

    def update_subscription_info(
        self,
        subscription_id: int,
        expires_at: str | None = None,
        active_connections: int | None = None,
        max_connections: int | None = None,
    ) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE subscriptions
                SET expires_at = ?, active_connections = ?, max_connections = ?, updated_at = ?
                WHERE id = ?
                """,
                (expires_at, active_connections, max_connections, now_iso(), subscription_id),
            )

    def get_setting(self, key: str, default: str = "") -> str:
        with self.connect() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return str(row["value"]) if row else default

    def set_setting(self, key: str, value: Any) -> None:
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, str(value)),
            )

    def get_all_settings(self) -> dict[str, str]:
        with self.connect() as conn:
            rows = conn.execute("SELECT key, value FROM settings").fetchall()
        return {row["key"]: row["value"] for row in rows}

    def add_favorite(self, subscription_id: int, channel_name: str, stream_url: str) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO favorites(subscription_id, channel_name, stream_url, created_at)
                VALUES(?, ?, ?, ?)
                """,
                (subscription_id, channel_name, stream_url, now_iso()),
            )

    def remove_favorite(self, subscription_id: int, stream_url: str) -> None:
        with self.connect() as conn:
            conn.execute(
                "DELETE FROM favorites WHERE subscription_id = ? AND stream_url = ?",
                (subscription_id, stream_url),
            )

    def list_favorites(self, subscription_id: int) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM favorites WHERE subscription_id = ? ORDER BY channel_name COLLATE NOCASE ASC",
                (subscription_id,),
            ).fetchall()
        return [dict(row) for row in rows]
