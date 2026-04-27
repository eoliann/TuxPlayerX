use std::path::PathBuf;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use crate::models::{AppSettings, Subscription, SubscriptionInfo};

pub struct Database {
    path: PathBuf,
}

impl Database {
    pub fn new(path: PathBuf) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let db = Self { path };
        db.init()?;
        Ok(db)
    }

    fn connect(&self) -> anyhow::Result<Connection> {
        let conn = Connection::open(&self.path)?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        Ok(conn)
    }

    fn init(&self) -> anyhow::Result<()> {
        let conn = self.connect()?;
        conn.execute_batch(
            r#"
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
            "#,
        )?;

        let defaults = [
            ("theme", "dark"),
            ("network_cache_ms", "3000"),
            ("auto_load_default", "true"),
            ("auto_restart", "true"),
            ("external_player_command", "vlc"),
        ];
        for (key, value) in defaults {
            conn.execute(
                "INSERT OR IGNORE INTO settings(key, value) VALUES(?1, ?2)",
                params![key, value],
            )?;
        }
        Ok(())
    }

    pub fn list_subscriptions(&self) -> anyhow::Result<Vec<Subscription>> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare("SELECT * FROM subscriptions ORDER BY is_default DESC, name COLLATE NOCASE ASC")?;
        let rows = stmt.query_map([], row_to_subscription)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn get_subscription(&self, id: i64) -> anyhow::Result<Option<Subscription>> {
        let conn = self.connect()?;
        conn.query_row("SELECT * FROM subscriptions WHERE id = ?1", params![id], row_to_subscription)
            .optional()
            .map_err(Into::into)
    }

    pub fn get_default_subscription(&self) -> anyhow::Result<Option<Subscription>> {
        let conn = self.connect()?;
        conn.query_row("SELECT * FROM subscriptions WHERE is_default = 1 ORDER BY id DESC LIMIT 1", [], row_to_subscription)
            .optional()
            .map_err(Into::into)
    }

    pub fn save_subscription(&self, sub: &Subscription) -> anyhow::Result<i64> {
        let conn = self.connect()?;
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        if sub.is_default {
            conn.execute("UPDATE subscriptions SET is_default = 0", [])?;
        }
        if let Some(id) = sub.id {
            conn.execute(
                "UPDATE subscriptions SET name=?1, type=?2, url=?3, portal_url=?4, mac_address=?5, username=?6, password=?7, is_default=?8, expires_at=?9, active_connections=?10, max_connections=?11, updated_at=?12 WHERE id=?13",
                params![
                    sub.name,
                    sub.sub_type,
                    sub.url,
                    sub.portal_url,
                    sub.mac_address,
                    sub.username,
                    sub.password,
                    if sub.is_default { 1 } else { 0 },
                    sub.expires_at,
                    sub.active_connections,
                    sub.max_connections,
                    now,
                    id
                ],
            )?;
            Ok(id)
        } else {
            conn.execute(
                "INSERT INTO subscriptions(name, type, url, portal_url, mac_address, username, password, is_default, expires_at, active_connections, max_connections, created_at, updated_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    sub.name,
                    sub.sub_type,
                    sub.url,
                    sub.portal_url,
                    sub.mac_address,
                    sub.username,
                    sub.password,
                    if sub.is_default { 1 } else { 0 },
                    sub.expires_at,
                    sub.active_connections,
                    sub.max_connections,
                    now,
                    now
                ],
            )?;
            Ok(conn.last_insert_rowid())
        }
    }

    pub fn delete_subscription(&self, id: i64) -> anyhow::Result<()> {
        let conn = self.connect()?;
        conn.execute("DELETE FROM subscriptions WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn set_default_subscription(&self, id: i64) -> anyhow::Result<()> {
        let conn = self.connect()?;
        conn.execute("UPDATE subscriptions SET is_default = 0", [])?;
        conn.execute("UPDATE subscriptions SET is_default = 1 WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn update_subscription_info(&self, id: i64, info: &SubscriptionInfo) -> anyhow::Result<()> {
        let conn = self.connect()?;
        conn.execute(
            "UPDATE subscriptions SET expires_at=?1, active_connections=?2, max_connections=?3, updated_at=?4 WHERE id=?5",
            params![
                info.expires_at,
                info.active_connections,
                info.max_connections,
                Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                id
            ],
        )?;
        Ok(())
    }

    pub fn get_settings(&self) -> anyhow::Result<AppSettings> {
        let conn = self.connect()?;
        let get = |key: &str, default: &str| -> anyhow::Result<String> {
            let value: Option<String> = conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |row| row.get(0)).optional()?;
            Ok(value.unwrap_or_else(|| default.to_string()))
        };
        Ok(AppSettings {
            theme: get("theme", "dark")?,
            network_cache_ms: get("network_cache_ms", "3000")?.parse().unwrap_or(3000),
            auto_load_default: get("auto_load_default", "true")? == "true",
            auto_restart: get("auto_restart", "true")? == "true",
            external_player_command: get("external_player_command", "vlc")?,
        })
    }

    pub fn save_settings(&self, settings: &AppSettings) -> anyhow::Result<()> {
        let conn = self.connect()?;
        let values = [
            ("theme", settings.theme.clone()),
            ("network_cache_ms", settings.network_cache_ms.to_string()),
            ("auto_load_default", settings.auto_load_default.to_string()),
            ("auto_restart", settings.auto_restart.to_string()),
            ("external_player_command", settings.external_player_command.clone()),
        ];
        for (key, value) in values {
            conn.execute(
                "INSERT INTO settings(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![key, value],
            )?;
        }
        Ok(())
    }
}

fn row_to_subscription(row: &rusqlite::Row<'_>) -> rusqlite::Result<Subscription> {
    Ok(Subscription {
        id: row.get("id")?,
        name: row.get("name")?,
        sub_type: row.get("type")?,
        url: row.get("url")?,
        portal_url: row.get("portal_url")?,
        mac_address: row.get("mac_address")?,
        username: row.get("username")?,
        password: row.get("password")?,
        is_default: row.get::<_, i64>("is_default")? == 1,
        expires_at: row.get("expires_at")?,
        active_connections: row.get("active_connections")?,
        max_connections: row.get("max_connections")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}
