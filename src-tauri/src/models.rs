use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub id: Option<i64>,
    pub name: String,
    #[serde(rename = "type")]
    pub sub_type: String,
    pub url: Option<String>,
    pub portal_url: Option<String>,
    pub mac_address: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub is_default: bool,
    pub expires_at: Option<String>,
    pub active_connections: Option<i64>,
    pub max_connections: Option<i64>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub stream_url: String,
    pub logo: Option<String>,
    pub group: Option<String>,
    pub raw_cmd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionInfo {
    pub status: String,
    pub expires_at: Option<String>,
    pub active_connections: Option<i64>,
    pub max_connections: Option<i64>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String,
    pub network_cache_ms: i64,
    pub auto_load_default: bool,
    pub auto_restart: bool,
    pub external_player_command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub author: String,
    pub repository: String,
    pub license: String,
    pub download_url: String,
}
