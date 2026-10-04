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
    pub epg_id: Option<String>,
    /// Days of TV archive available for catch-up, when the provider supports it.
    #[serde(default)]
    pub catchup_days: Option<i64>,
    /// "xc" (Xtream timeshift), "default", "append" or "shift" (M3U catchup attribute).
    #[serde(default)]
    pub catchup_type: Option<String>,
    /// M3U catchup-source template, used by the "default" and "append" catch-up types.
    #[serde(default)]
    pub catchup_source: Option<String>,
    /// User-Agent the playlist asks for (`http-user-agent`, `#EXTVLCOPT`, `url|User-Agent=`).
    #[serde(default)]
    pub user_agent: Option<String>,
    /// Referer the playlist asks for (`http-referrer`, `#EXTVLCOPT`, `url|Referer=`).
    #[serde(default)]
    pub referrer: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpgProgram {
    pub channel_id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub description: Option<String>,
    pub start: String,
    pub stop: Option<String>,
    pub start_label: String,
    pub stop_label: Option<String>,
    pub is_now: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelLoadResult {
    pub channels: Vec<Channel>,
    pub from_cache: bool,
    pub fetched_at: i64,
}

/// Minimal channel identity used to look up "now playing" EPG data for many channels at once.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpgChannelKey {
    pub id: String,
    pub name: String,
    pub epg_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpgNow {
    pub title: String,
    pub start_label: String,
    pub stop_label: Option<String>,
    pub progress: Option<f64>,
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
    pub epg_url: String,
    pub epg_timezone_mode: String,
    pub epg_time_offset_minutes: i64,
    #[serde(default = "default_true")]
    pub resume_last_channel: bool,
    /// "auto": built-in player first, VLC bridge only when needed; "vlc": always use the VLC bridge.
    #[serde(default = "default_playback_engine")]
    pub playback_engine: String,
}

fn default_true() -> bool { true }

fn default_playback_engine() -> String { "auto".to_string() }

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

/// Portable backup of subscriptions, favorites, recents and settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    pub app: String,
    pub format_version: u32,
    pub exported_at: String,
    /// Kept as raw JSON so backups from older/newer versions with different settings still import.
    pub settings: serde_json::Value,
    pub subscriptions: Vec<BackupSubscription>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSubscription {
    #[serde(flatten)]
    pub subscription: Subscription,
    #[serde(default)]
    pub favorites: Vec<String>,
    #[serde(default)]
    pub recents: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub added_subscriptions: usize,
    pub existing_subscriptions: usize,
    pub favorites: usize,
    pub settings: AppSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VodCategory {
    pub id: String,
    pub name: String,
}

/// A movie or a series in a provider catalogue.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VodItem {
    pub id: String,
    pub name: String,
    /// "movie" or "series".
    pub kind: String,
    pub poster: Option<String>,
    pub rating: Option<String>,
    pub year: Option<String>,
    pub plot: Option<String>,
    pub extension: Option<String>,
    /// MAC portal command used to create the playback link.
    #[serde(default)]
    pub cmd: Option<String>,
    /// MAC portal episode numbers for series stored as a single VOD item.
    #[serde(default)]
    pub episodes: Option<Vec<i64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VodPage {
    pub items: Vec<VodItem>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VodDetails {
    pub plot: Option<String>,
    pub genre: Option<String>,
    pub cast: Option<String>,
    pub director: Option<String>,
    pub release_date: Option<String>,
    pub duration: Option<String>,
    pub rating: Option<String>,
    pub backdrop: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesEpisode {
    pub id: String,
    pub number: i64,
    pub title: String,
    pub extension: Option<String>,
    pub plot: Option<String>,
    pub duration: Option<String>,
    pub poster: Option<String>,
    #[serde(default)]
    pub cmd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesSeason {
    pub number: i64,
    pub name: String,
    pub episodes: Vec<SeriesEpisode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesInfo {
    pub name: String,
    pub poster: Option<String>,
    pub plot: Option<String>,
    pub seasons: Vec<SeriesSeason>,
}

/// What to play from the VOD catalogue: a movie, or one episode of a series.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VodPlayRequest {
    /// "movie" or "episode".
    pub kind: String,
    pub id: String,
    pub extension: Option<String>,
    #[serde(default)]
    pub cmd: Option<String>,
    /// MAC portal series episode number.
    #[serde(default)]
    pub episode_number: Option<i64>,
}

/// One programme cell in the TV guide grid; times are Unix timestamps (seconds).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpgGridItem {
    pub title: String,
    pub description: Option<String>,
    pub start: i64,
    pub stop: i64,
}
