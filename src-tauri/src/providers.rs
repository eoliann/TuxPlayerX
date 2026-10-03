use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};
use chrono::{DateTime, Duration as ChronoDuration, Local, LocalResult, NaiveDateTime, TimeZone, Utc};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, CONNECTION, COOKIE, USER_AGENT};
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::Url;
use crate::models::{Channel, EpgChannelKey, EpgNow, EpgProgram, Subscription, SubscriptionInfo};

const MAC_USER_AGENT: &str = "Mozilla/5.0 (QtEmbedded; U; Linux; en-US) AppleWebKit/533.3 (KHTML, like Gecko) MAG254 stbapp ver: 4 rev: 2721 Mobile Safari/533.3";
/// How long a MAC portal token is reused before a new handshake is made.
const MAC_SESSION_TTL: Duration = Duration::from_secs(10 * 60);
/// How long a downloaded XMLTV guide is kept in memory before it is downloaded again.
const EPG_CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);

/// Shared HTTP client so connections, DNS lookups and TLS sessions are reused between requests.
fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("TuxPlayerX/2.0")
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(180))
            .build()
            .expect("failed to build HTTP client")
    })
}

#[derive(Clone)]
struct MacPortalSession {
    client: reqwest::Client,
    api_url: String,
    token: String,
    mac: String,
}

pub async fn load_channels(sub: &Subscription) -> anyhow::Result<Vec<Channel>> {
    match sub.sub_type.as_str() {
        "m3u" => load_m3u_channels(sub).await,
        "mac" => load_mac_channels(sub).await,
        other => anyhow::bail!("Unsupported subscription type: {other}"),
    }
}

pub async fn resolve_channel_stream(sub: &Subscription, channel: &Channel) -> anyhow::Result<String> {
    if sub.sub_type == "mac" {
        if let Some(cmd) = &channel.raw_cmd {
            return create_mac_link(sub, cmd).await;
        }
    }
    Ok(channel.stream_url.clone())
}

pub async fn refresh_info(sub: &Subscription) -> anyhow::Result<SubscriptionInfo> {
    match sub.sub_type.as_str() {
        "m3u" => refresh_m3u_info(sub).await,
        "mac" => refresh_mac_info(sub).await,
        _ => anyhow::bail!("Unsupported subscription type"),
    }
}

async fn read_source(source: &str) -> anyhow::Result<String> {
    if source.starts_with("http://") || source.starts_with("https://") {
        let text = http()
            .get(source)
            .send()
            .await?
            .error_for_status()?
            .text()
            .await?;
        Ok(text)
    } else {
        Ok(std::fs::read_to_string(source)?)
    }
}

async fn load_m3u_channels(sub: &Subscription) -> anyhow::Result<Vec<Channel>> {
    let source = sub.url.as_deref().ok_or_else(|| anyhow::anyhow!("Missing M3U URL"))?;
    let body = read_source(source).await?;
    Ok(parse_m3u(&body))
}

/// Builds an id that survives playlist reordering, so favorites and recents keep pointing at the same channel.
fn stable_m3u_id(name: &str, group: Option<&str>, seen: &mut HashMap<String, usize>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(name.trim().to_lowercase().as_bytes());
    hasher.update(b"|");
    hasher.update(group.unwrap_or_default().trim().to_lowercase().as_bytes());
    let base = format!("m3u-{}", &format!("{:x}", hasher.finalize())[..12]);
    let count = seen.entry(base.clone()).or_insert(0);
    *count += 1;
    if *count == 1 { base } else { format!("{base}-{count}") }
}

fn parse_m3u(body: &str) -> Vec<Channel> {
    let mut channels = Vec::new();
    let mut seen_ids: HashMap<String, usize> = HashMap::new();
    let mut current_name: Option<String> = None;
    let mut current_logo: Option<String> = None;
    let mut current_group: Option<String> = None;
    let mut current_epg_id: Option<String> = None;

    for line in body.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if line.starts_with("#EXTINF") {
            current_name = Some(line.split_once(',').map(|(_, name)| name.trim().to_string()).unwrap_or_else(|| "Unnamed channel".to_string()));
            current_logo = extract_attr(line, "tvg-logo");
            current_group = extract_attr(line, "group-title");
            current_epg_id = extract_attr(line, "tvg-id").or_else(|| extract_attr(line, "tvg-name"));
        } else if !line.starts_with('#') {
            let idx = channels.len() + 1;
            let name = current_name.take().unwrap_or_else(|| format!("Channel {idx}"));
            let group = current_group.take();
            channels.push(Channel {
                id: stable_m3u_id(&name, group.as_deref(), &mut seen_ids),
                name,
                stream_url: line.to_string(),
                logo: current_logo.take(),
                group,
                raw_cmd: None,
                epg_id: current_epg_id.take(),
            });
        }
    }
    channels
}

fn extract_attr(line: &str, key: &str) -> Option<String> {
    let needle = format!("{key}=\"");
    let start = line.find(&needle)? + needle.len();
    let rest = &line[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

async fn refresh_m3u_info(sub: &Subscription) -> anyhow::Result<SubscriptionInfo> {
    let source = sub.url.as_deref().ok_or_else(|| anyhow::anyhow!("Missing M3U URL"))?;
    let url = Url::parse(source)?;
    let username = sub.username.clone().or_else(|| query_value(&url, "username"));
    let password = sub.password.clone().or_else(|| query_value(&url, "password"));
    let username = username.ok_or_else(|| anyhow::anyhow!("Cannot detect username in M3U URL"))?;
    let password = password.ok_or_else(|| anyhow::anyhow!("Cannot detect password in M3U URL"))?;
    let base = format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default());
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    let api_url = format!("{base}{port}/player_api.php?username={}&password={}", urlencoding::encode(&username), urlencoding::encode(&password));
    let json: Value = http().get(api_url).send().await?.error_for_status()?.json().await?;
    let user_info = json.get("user_info").unwrap_or(&json);
    let exp = user_info.get("exp_date").and_then(value_to_string).and_then(format_exp_date);
    let active = user_info.get("active_cons").or_else(|| user_info.get("active_connections")).and_then(value_to_i64);
    let max = user_info.get("max_connections").and_then(value_to_i64);
    let status = user_info.get("status").and_then(value_to_string).unwrap_or_else(|| "Unknown".to_string());
    Ok(SubscriptionInfo { status, expires_at: exp, active_connections: active, max_connections: max, message: Some("M3U/Xtream info refreshed.".to_string()) })
}

fn query_value(url: &Url, key: &str) -> Option<String> {
    url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.to_string())
}

fn normalize_mac(mac: &str) -> anyhow::Result<String> {
    let normalized = mac.trim().to_uppercase().replace('-', ":");
    let parts: Vec<&str> = normalized.split(':').collect();
    if parts.len() == 6 && parts.iter().all(|p| p.len() == 2 && p.chars().all(|c| c.is_ascii_hexdigit())) {
        Ok(normalized)
    } else {
        anyhow::bail!("Invalid MAC address format. Expected format: 00:1A:79:XX:XX:XX")
    }
}

fn candidate_api_urls(input: &str) -> anyhow::Result<Vec<String>> {
    let parsed = Url::parse(input.trim())?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        anyhow::bail!("Portal URL must start with http:// or https://")
    }
    let host = parsed.host_str().ok_or_else(|| anyhow::anyhow!("Portal URL is missing host"))?;
    let port = parsed.port().map(|p| format!(":{p}")).unwrap_or_default();
    let base = format!("{scheme}://{host}{port}");
    let path = parsed.path().trim_end_matches('/');
    let mut candidates: Vec<String> = Vec::new();

    if path.ends_with("/server/load.php") {
        candidates.push(format!("{base}{path}"));
    } else if path.ends_with("/c") {
        let parent = &path[..path.len() - 2];
        candidates.push(format!("{base}{parent}/server/load.php"));
    } else if let Some(pos) = path.find("stalker_portal") {
        let stalker_root = &path[..pos + "stalker_portal".len()];
        candidates.push(format!("{base}{stalker_root}/server/load.php"));
    } else if !path.is_empty() && path != "/" {
        candidates.push(format!("{base}{path}/server/load.php"));
        candidates.push(format!("{base}{path}/stalker_portal/server/load.php"));
    } else {
        candidates.push(format!("{base}/stalker_portal/server/load.php"));
        candidates.push(format!("{base}/server/load.php"));
    }

    let mut unique = Vec::new();
    for candidate in candidates {
        if !unique.contains(&candidate) {
            unique.push(candidate);
        }
    }
    Ok(unique)
}

fn mac_client(mac: &str) -> anyhow::Result<reqwest::Client> {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(MAC_USER_AGENT));
    headers.insert(ACCEPT, HeaderValue::from_static("*/*"));
    headers.insert(CONNECTION, HeaderValue::from_static("Keep-Alive"));
    headers.insert("X-User-Agent", HeaderValue::from_static("Model: MAG254; Link: Ethernet"));
    headers.insert(COOKIE, HeaderValue::from_str(&format!("mac={}; stb_lang=en; timezone=Europe/Bucharest", mac))?);
    Ok(reqwest::Client::builder().default_headers(headers).cookie_store(true).build()?)
}

fn js_payload(payload: &Value) -> &Value {
    if let Some(js) = payload.get("js") {
        js
    } else if let Some(data) = payload.get("data") {
        data
    } else {
        payload
    }
}

async fn mac_handshake(sub: &Subscription) -> anyhow::Result<MacPortalSession> {
    let portal_url = sub.portal_url.as_deref().ok_or_else(|| anyhow::anyhow!("Missing portal URL"))?;
    let mac = normalize_mac(sub.mac_address.as_deref().ok_or_else(|| anyhow::anyhow!("Missing MAC address"))?)?;
    let client = mac_client(&mac)?;
    let mut last_error = String::from("unknown error");

    for api_url in candidate_api_urls(portal_url)? {
        let response = client
            .get(&api_url)
            .query(&[("type", "stb"), ("action", "handshake"), ("token", ""), ("JsHttpRequest", "1-xml")])
            .send()
            .await;

        match response {
            Ok(resp) => match resp.error_for_status() {
                Ok(ok_resp) => match ok_resp.json::<Value>().await {
                    Ok(json) => {
                        let js = js_payload(&json);
                        if let Some(token) = js.get("token").or_else(|| js.get("access_token")).and_then(value_to_string) {
                            return Ok(MacPortalSession { client, api_url, token, mac });
                        }
                        last_error = "handshake response did not contain a token".to_string();
                    }
                    Err(e) => last_error = format!("invalid JSON response: {e}"),
                },
                Err(e) => last_error = e.to_string(),
            },
            Err(e) => last_error = e.to_string(),
        }
    }

    anyhow::bail!("Could not authenticate with the MAC portal. Last error: {last_error}")
}

fn mac_sessions() -> &'static StdMutex<HashMap<String, (MacPortalSession, Instant)>> {
    static SESSIONS: OnceLock<StdMutex<HashMap<String, (MacPortalSession, Instant)>>> = OnceLock::new();
    SESSIONS.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn mac_session_key(sub: &Subscription) -> String {
    format!("{}|{}", sub.portal_url.as_deref().unwrap_or_default().trim(), sub.mac_address.as_deref().unwrap_or_default().trim().to_uppercase())
}

/// Returns an authenticated portal session, reusing a recent token unless `fresh` is set.
/// Avoids a handshake + get_profile round trip on every channel switch.
async fn mac_session(sub: &Subscription, fresh: bool) -> anyhow::Result<MacPortalSession> {
    let key = mac_session_key(sub);
    if !fresh {
        if let Ok(cache) = mac_sessions().lock() {
            if let Some((session, created)) = cache.get(&key) {
                if created.elapsed() < MAC_SESSION_TTL {
                    return Ok(session.clone());
                }
            }
        }
    }
    let session = mac_handshake(sub).await?;
    let _ = mac_get_profile(&session).await;
    if let Ok(mut cache) = mac_sessions().lock() {
        cache.insert(key, (session.clone(), Instant::now()));
    }
    Ok(session)
}

fn device_id(mac: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(mac.as_bytes());
    format!("{:X}", hasher.finalize())
}

fn signature(mac: &str, device_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{mac}{device_id}").as_bytes());
    format!("{:X}", hasher.finalize())
}

async fn mac_request(session: &MacPortalSession, params: Vec<(String, String)>) -> anyhow::Result<Value> {
    let mut query = params;
    if !query.iter().any(|(k, _)| k == "JsHttpRequest") {
        query.push(("JsHttpRequest".to_string(), "1-xml".to_string()));
    }
    let json = session.client
        .get(&session.api_url)
        .bearer_auth(&session.token)
        .query(&query)
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    Ok(json)
}

async fn mac_get_profile(session: &MacPortalSession) -> anyhow::Result<Value> {
    let dev = device_id(&session.mac);
    let params = vec![
        ("type".to_string(), "stb".to_string()),
        ("action".to_string(), "get_profile".to_string()),
        ("hd".to_string(), "1".to_string()),
        ("ver".to_string(), "ImageDescription: 0.2.18-r23-254; ImageDate: Wed Mar 18 18:09:40 EET 2015; PORTAL version: 5.6.6; API Version: JS API version: 328; STB API version: 134; Player Engine version: 0x566".to_string()),
        ("num_banks".to_string(), "2".to_string()),
        ("sn".to_string(), dev.chars().take(13).collect::<String>()),
        ("stb_type".to_string(), "MAG254".to_string()),
        ("image_version".to_string(), "218".to_string()),
        ("video_out".to_string(), "hdmi".to_string()),
        ("device_id".to_string(), dev.clone()),
        ("device_id2".to_string(), dev.clone()),
        ("signature".to_string(), signature(&session.mac, &dev)),
        ("auth_second_step".to_string(), "1".to_string()),
        ("hw_version".to_string(), "1.7-BD-00".to_string()),
        ("not_valid_token".to_string(), "0".to_string()),
    ];
    mac_request(session, params).await
}

async fn mac_get_genres(session: &MacPortalSession) -> std::collections::HashMap<String, String> {
    let mut genres = std::collections::HashMap::new();
    let params = vec![("type".to_string(), "itv".to_string()), ("action".to_string(), "get_genres".to_string())];
    if let Ok(payload) = mac_request(session, params).await {
        let js = js_payload(&payload);
        let data = js.get("data").unwrap_or(js);
        if let Some(arr) = data.as_array() {
            for item in arr {
                if let Some(obj) = item.as_object() {
                    let id = obj.get("id").or_else(|| obj.get("number")).and_then(value_to_string);
                    let title = obj.get("title").or_else(|| obj.get("name")).and_then(value_to_string);
                    if let (Some(id), Some(title)) = (id, title) {
                        genres.insert(id, title);
                    }
                }
            }
        }
    }
    genres
}

fn clean_stream_url(value: &str) -> String {
    let mut text = value.trim().to_string();
    for prefix in ["ffmpeg ", "auto "] {
        if text.to_ascii_lowercase().starts_with(prefix) {
            text = text[prefix.len()..].trim().to_string();
        }
    }
    text
}

async fn load_mac_channels(sub: &Subscription) -> anyhow::Result<Vec<Channel>> {
    let session = mac_session(sub, true).await?;
    let genres = mac_get_genres(&session).await;
    let params = vec![
        ("type".to_string(), "itv".to_string()),
        ("action".to_string(), "get_all_channels".to_string()),
        ("force_ch_link_check".to_string(), "".to_string()),
    ];
    let payload = mac_request(&session, params).await?;
    let js = js_payload(&payload);
    let data = js.get("data").unwrap_or(js);
    let arr = data.as_array().ok_or_else(|| anyhow::anyhow!("MAC portal did not return a channel list"))?;

    let mut out = Vec::new();
    for (idx, item) in arr.iter().enumerate() {
        let name = item.get("name").or_else(|| item.get("title")).and_then(value_to_string).unwrap_or_else(|| format!("Channel {}", idx + 1));
        let raw_cmd = item.get("cmd").or_else(|| item.get("url")).and_then(value_to_string).unwrap_or_default();
        if raw_cmd.trim().is_empty() { continue; }
        let group_id = item.get("tv_genre_id").or_else(|| item.get("genre_id")).or_else(|| item.get("category_id")).and_then(value_to_string);
        let group = group_id.as_ref().and_then(|id| genres.get(id).cloned()).or_else(|| item.get("category_name").and_then(value_to_string)).or_else(|| Some("Live TV".to_string()));
        let logo = item.get("logo").or_else(|| item.get("icon")).and_then(value_to_string);
        let id = item.get("id").and_then(value_to_string).unwrap_or_else(|| format!("mac-{}", idx + 1));
        let epg_id = item.get("xmltv_id")
            .or_else(|| item.get("tvg_id"))
            .or_else(|| item.get("epg_id"))
            .or_else(|| item.get("id"))
            .and_then(value_to_string);
        out.push(Channel { id, name, stream_url: clean_stream_url(&raw_cmd), logo, group, raw_cmd: Some(raw_cmd), epg_id });
    }

    if out.is_empty() {
        anyhow::bail!("No channels were found in this MAC subscription.")
    }
    Ok(out)
}

fn is_playable_url(url: &str) -> bool {
    ["http://", "https://", "rtmp://", "rtsp://"].iter().any(|prefix| url.starts_with(prefix))
}

async fn create_mac_link(sub: &Subscription, cmd: &str) -> anyhow::Result<String> {
    // Try the cached token first; if the portal rejects it, retry once with a fresh handshake.
    let cached = mac_session(sub, false).await?;
    let result = match request_mac_link(&cached, cmd).await {
        Ok(url) => Ok(url),
        Err(_) => request_mac_link(&mac_session(sub, true).await?, cmd).await,
    };
    result.or_else(|e| {
        let clean_cmd = clean_stream_url(cmd);
        if is_playable_url(&clean_cmd) { Ok(clean_cmd) } else { Err(e) }
    })
}

async fn request_mac_link(session: &MacPortalSession, cmd: &str) -> anyhow::Result<String> {
    let params = vec![
        ("type".to_string(), "itv".to_string()),
        ("action".to_string(), "create_link".to_string()),
        ("cmd".to_string(), cmd.to_string()),
        ("series".to_string(), "0".to_string()),
        ("forced_storage".to_string(), "0".to_string()),
        ("disable_ad".to_string(), "0".to_string()),
    ];
    let payload = mac_request(session, params).await?;
    let js = js_payload(&payload);
    let link = js.get("cmd").or_else(|| js.get("url")).or_else(|| js.get("link")).and_then(value_to_string)
        .ok_or_else(|| anyhow::anyhow!("MAC portal did not return a playable link"))?;
    let stream_url = clean_stream_url(&link);
    if is_playable_url(&stream_url) {
        return Ok(stream_url);
    }
    anyhow::bail!("Portal did not return a playable stream URL for this channel.")
}

async fn refresh_mac_info(sub: &Subscription) -> anyhow::Result<SubscriptionInfo> {
    let session = mac_session(sub, true).await?;
    let profile = mac_get_profile(&session).await.ok();
    let mut payloads: Vec<Value> = Vec::new();
    if let Some(profile) = profile { payloads.push(profile); }

    for action in ["get_main_info", "get_account_info"] {
        let params = vec![("type".to_string(), "account_info".to_string()), ("action".to_string(), action.to_string())];
        if let Ok(payload) = mac_request(&session, params).await {
            payloads.push(payload);
        }
    }

    let status = first_value(&payloads, &["status", "account_status", "state"]).unwrap_or_else(|| "Active".to_string());
    let expires = first_value(&payloads, &["end_date", "expire_billing_date", "expires", "exp_date", "expiration", "expire_date", "account_expire", "login_expire", "tariff_plan_until"]);
    let active = first_value(&payloads, &["active_cons", "active_connections", "online", "online_count", "now_online", "current_connections"]).and_then(|v| parse_i64(&v));
    let max = first_value(&payloads, &["max_online", "max_connections", "max_cons", "allowed_cons", "allowed_connections", "total_connections"]).and_then(|v| parse_i64(&v));

    Ok(SubscriptionInfo {
        status,
        expires_at: expires.and_then(format_exp_date),
        active_connections: active,
        max_connections: max,
        message: Some("MAC account info loaded from the authorized portal response where available.".to_string()),
    })
}


/// One `<programme>` entry from the XMLTV file, kept in memory between channel switches.
struct EpgEntry {
    channel_id: String,
    title: String,
    subtitle: Option<String>,
    description: Option<String>,
    start_raw: String,
    stop_raw: Option<String>,
    start_auto: DateTime<Utc>,
    stop_auto: Option<DateTime<Utc>>,
}

/// XMLTV guide parsed once and indexed by normalized channel key.
struct EpgIndex {
    /// Normalized `<programme channel="...">` value -> programmes sorted by start time.
    programmes: HashMap<String, Vec<EpgEntry>>,
    /// Normalized channel id or display-name -> normalized XMLTV channel ids.
    aliases: HashMap<String, Vec<String>>,
}

struct EpgCacheEntry {
    source: String,
    loaded_at: Instant,
    index: Arc<EpgIndex>,
}

fn epg_cache() -> &'static tokio::sync::Mutex<Option<EpgCacheEntry>> {
    static CACHE: OnceLock<tokio::sync::Mutex<Option<EpgCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| tokio::sync::Mutex::new(None))
}

/// Returns the parsed guide, downloading it only when it is missing, stale or `force` is set.
/// The async mutex also makes concurrent callers wait for a single download instead of starting several.
async fn epg_index(epg_url: &str, force: bool) -> anyhow::Result<Arc<EpgIndex>> {
    let source = epg_url.trim();
    if source.is_empty() {
        anyhow::bail!("Set an XMLTV EPG URL in Settings first.");
    }

    let mut cache = epg_cache().lock().await;
    if let Some(entry) = cache.as_ref() {
        if !force && entry.source == source && entry.loaded_at.elapsed() < EPG_CACHE_TTL {
            return Ok(entry.index.clone());
        }
    }

    let loaded = async {
        let xml = read_source(source).await?;
        let index = tokio::task::spawn_blocking(move || build_epg_index(&xml)).await??;
        anyhow::Ok(Arc::new(index))
    }
    .await;

    match loaded {
        Ok(index) => {
            *cache = Some(EpgCacheEntry { source: source.to_string(), loaded_at: Instant::now(), index: index.clone() });
            Ok(index)
        }
        // Keep showing the previous guide when a refresh fails (e.g. temporary network issue).
        Err(e) => match cache.as_ref() {
            Some(entry) if entry.source == source => Ok(entry.index.clone()),
            _ => Err(e),
        },
    }
}

fn build_epg_index(xml: &str) -> anyhow::Result<EpgIndex> {
    let doc = roxmltree::Document::parse(xml)?;
    let mut aliases: HashMap<String, Vec<String>> = HashMap::new();
    let mut add_alias = |alias: &str, channel_key: &str| {
        let alias = normalize_epg_key(alias);
        if alias.is_empty() || channel_key.is_empty() { return; }
        let list = aliases.entry(alias).or_default();
        if !list.iter().any(|existing| existing == channel_key) {
            list.push(channel_key.to_string());
        }
    };

    for node in doc.descendants().filter(|node| node.is_element() && node.tag_name().name() == "channel") {
        let Some(id) = node.attribute("id") else { continue };
        let channel_key = normalize_epg_key(id);
        add_alias(id, &channel_key);
        for display in node.children().filter(|child| child.is_element() && child.tag_name().name() == "display-name") {
            if let Some(text) = node_text(display) {
                add_alias(&text, &channel_key);
            }
        }
    }

    // Only keep a window around "now"; the margin covers any manual offset (max ±12h).
    let now = Utc::now();
    let min_time = now - ChronoDuration::hours(24);
    let max_time = now + ChronoDuration::days(4);
    let mut programmes: HashMap<String, Vec<EpgEntry>> = HashMap::new();

    for node in doc.descendants().filter(|node| node.is_element() && node.tag_name().name() == "programme") {
        let channel_id = node.attribute("channel").unwrap_or_default();
        let channel_key = normalize_epg_key(channel_id);
        if channel_key.is_empty() { continue; }
        let Some(start_raw) = node.attribute("start") else { continue };
        let Some(start_auto) = parse_xmltv_datetime_auto(start_raw) else { continue };
        let stop_raw = node.attribute("stop").map(str::to_string);
        let stop_auto = stop_raw.as_deref().and_then(parse_xmltv_datetime_auto);
        if start_auto > max_time || stop_auto.unwrap_or(start_auto) < min_time { continue; }

        programmes.entry(channel_key).or_default().push(EpgEntry {
            channel_id: channel_id.to_string(),
            title: first_child_text(node, "title").unwrap_or_else(|| "Untitled programme".to_string()),
            subtitle: first_child_text(node, "sub-title"),
            description: first_child_text(node, "desc"),
            start_raw: start_raw.to_string(),
            stop_raw,
            start_auto,
            stop_auto,
        });
    }

    for list in programmes.values_mut() {
        list.sort_by_key(|entry| entry.start_auto);
    }

    Ok(EpgIndex { programmes, aliases })
}

/// Same matching rules as before: tvg-id / portal EPG id, channel id and channel name are compared
/// (normalized) against XMLTV channel ids, display names and programme channel attributes.
fn epg_entries_for<'a>(index: &'a EpgIndex, id: &str, name: &str, epg_id: Option<&str>) -> Vec<&'a EpgEntry> {
    let mut candidate_keys: Vec<String> = Vec::new();
    if let Some(epg_id) = epg_id {
        candidate_keys.push(normalize_epg_key(epg_id));
    }
    candidate_keys.push(normalize_epg_key(id));
    candidate_keys.push(normalize_epg_key(name));

    let mut programme_keys: HashSet<&str> = HashSet::new();
    for key in candidate_keys.iter().filter(|key| !key.is_empty()) {
        if let Some((stored_key, _)) = index.programmes.get_key_value(key.as_str()) {
            programme_keys.insert(stored_key.as_str());
        }
        if let Some(channel_keys) = index.aliases.get(key.as_str()) {
            for channel_key in channel_keys {
                programme_keys.insert(channel_key.as_str());
            }
        }
    }

    let mut entries: Vec<&EpgEntry> = programme_keys
        .into_iter()
        .filter_map(|key| index.programmes.get(key))
        .flatten()
        .collect();
    entries.sort_by_key(|entry| entry.start_auto);
    entries
}

/// Programme start/stop according to the user's EPG time mode.
fn entry_times(entry: &EpgEntry, timezone_mode: &str, manual_offset_minutes: i64) -> Option<(DateTime<Utc>, Option<DateTime<Utc>>)> {
    let mode = timezone_mode.trim().to_ascii_lowercase();
    let (start, stop) = if mode == "local" {
        (
            parse_compact_xmltv_naive(&entry.start_raw).map(local_naive_to_utc)?,
            entry.stop_raw.as_deref().and_then(parse_compact_xmltv_naive).map(local_naive_to_utc),
        )
    } else {
        (entry.start_auto, entry.stop_auto)
    };
    if mode == "manual" && manual_offset_minutes != 0 {
        let offset = ChronoDuration::minutes(manual_offset_minutes);
        return Some((start + offset, stop.map(|stop| stop + offset)));
    }
    Some((start, stop))
}

pub async fn load_epg_programs(
    epg_url: &str,
    channel: &Channel,
    timezone_mode: &str,
    manual_offset_minutes: i64,
    force: bool,
) -> anyhow::Result<Vec<EpgProgram>> {
    let index = epg_index(epg_url, force).await?;
    let now = Utc::now();
    let min_time = now - ChronoDuration::hours(6);
    let max_time = now + ChronoDuration::hours(72);
    let mut programs = Vec::new();

    for entry in epg_entries_for(&index, &channel.id, &channel.name, channel.epg_id.as_deref()) {
        let Some((start_dt, stop_dt)) = entry_times(entry, timezone_mode, manual_offset_minutes) else { continue };
        if start_dt > max_time { continue; }
        if let Some(stop) = stop_dt {
            if stop < min_time { continue; }
        } else if start_dt < min_time {
            continue;
        }

        let is_now = start_dt <= now && stop_dt.as_ref().map(|stop| *stop >= now).unwrap_or(false);
        programs.push(EpgProgram {
            channel_id: entry.channel_id.clone(),
            title: entry.title.clone(),
            subtitle: entry.subtitle.clone(),
            description: entry.description.clone(),
            start: start_dt.to_rfc3339(),
            stop: stop_dt.as_ref().map(|stop| stop.to_rfc3339()),
            start_label: epg_label(&start_dt),
            stop_label: stop_dt.as_ref().map(epg_label),
            is_now,
        });
        if programs.len() >= 60 { break; }
    }

    Ok(programs)
}

/// Current programme for many channels at once, used to show "now playing" in the channel list.
pub async fn load_epg_now(
    epg_url: &str,
    channels: &[EpgChannelKey],
    timezone_mode: &str,
    manual_offset_minutes: i64,
) -> anyhow::Result<HashMap<String, EpgNow>> {
    let index = epg_index(epg_url, false).await?;
    let now = Utc::now();
    let mut out = HashMap::new();

    for channel in channels {
        let entries = epg_entries_for(&index, &channel.id, &channel.name, channel.epg_id.as_deref());
        let current = entries.into_iter().find_map(|entry| {
            let (start, stop) = entry_times(entry, timezone_mode, manual_offset_minutes)?;
            let stop = stop?;
            (start <= now && now < stop).then_some((entry, start, stop))
        });
        if let Some((entry, start, stop)) = current {
            let total = (stop - start).num_seconds().max(1) as f64;
            let elapsed = (now - start).num_seconds() as f64;
            out.insert(channel.id.clone(), EpgNow {
                title: entry.title.clone(),
                start_label: epg_label(&start),
                stop_label: Some(epg_label(&stop)),
                progress: Some((elapsed / total).clamp(0.0, 1.0)),
            });
        }
    }

    Ok(out)
}

fn normalize_epg_key(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .replace('&', "and")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

fn node_text(node: roxmltree::Node<'_, '_>) -> Option<String> {
    node.text()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn first_child_text(node: roxmltree::Node<'_, '_>, tag: &str) -> Option<String> {
    node.children()
        .find(|child| child.is_element() && child.tag_name().name() == tag)
        .and_then(node_text)
}

fn local_naive_to_utc(naive: NaiveDateTime) -> DateTime<Utc> {
    match Local.from_local_datetime(&naive) {
        LocalResult::Single(dt) => dt.with_timezone(&Utc),
        LocalResult::Ambiguous(earliest, _) => earliest.with_timezone(&Utc),
        LocalResult::None => Utc.from_utc_datetime(&naive),
    }
}

fn parse_compact_xmltv_naive(raw: &str) -> Option<NaiveDateTime> {
    let trimmed = raw.trim();
    if trimmed.is_empty() { return None; }
    let compact = trimmed.split_whitespace().next().unwrap_or(trimmed);
    let core = compact.chars().take(14).collect::<String>();
    NaiveDateTime::parse_from_str(&core, "%Y%m%d%H%M%S").ok()
}

fn parse_xmltv_datetime_auto(raw: &str) -> Option<DateTime<Utc>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() { return None; }

    if let Ok(dt) = DateTime::parse_from_str(trimmed, "%Y%m%d%H%M%S %z") {
        return Some(dt.with_timezone(&Utc));
    }
    if let Ok(dt) = DateTime::parse_from_str(trimmed, "%Y%m%d%H%M%S%z") {
        return Some(dt.with_timezone(&Utc));
    }

    // XMLTV sources without an explicit timezone are normally meant to be read as local guide time.
    parse_compact_xmltv_naive(trimmed).map(local_naive_to_utc)
}

fn epg_label(dt: &DateTime<Utc>) -> String {
    dt.with_timezone(&Local).format("%H:%M").to_string()
}

fn first_value(payloads: &[Value], keys: &[&str]) -> Option<String> {
    for payload in payloads {
        if let Some(v) = first_value_in(payload, keys) {
            return Some(v);
        }
    }
    None
}

fn first_value_in(value: &Value, keys: &[&str]) -> Option<String> {
    if let Some(obj) = value.as_object() {
        for (key, val) in obj {
            if keys.iter().any(|wanted| key.eq_ignore_ascii_case(wanted)) {
                if let Some(out) = value_to_string(val) {
                    if !out.trim().is_empty() { return Some(out); }
                }
            }
        }
        for val in obj.values() {
            if let Some(found) = first_value_in(val, keys) { return Some(found); }
        }
    } else if let Some(arr) = value.as_array() {
        for val in arr {
            if let Some(found) = first_value_in(val, keys) { return Some(found); }
        }
    }
    None
}

fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn value_to_i64(value: &Value) -> Option<i64> {
    match value {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => parse_i64(s),
        _ => None,
    }
}

fn parse_i64(s: &str) -> Option<i64> {
    let trimmed = s.trim();
    if trimmed.is_empty() || matches!(trimmed.to_ascii_lowercase().as_str(), "null" | "none" | "unknown" | "unlimited") {
        return None;
    }
    trimmed.parse::<f64>().ok().map(|v| v as i64)
}

fn format_exp_date(raw: String) -> Option<String> {
    let raw = raw.trim().to_string();
    if raw.is_empty() || raw.eq_ignore_ascii_case("null") || raw.eq_ignore_ascii_case("none") || raw.eq_ignore_ascii_case("unknown") { return None; }
    if raw == "0" || raw == "-1" { return Some("Unlimited".to_string()); }
    if let Ok(ts) = raw.parse::<i64>() {
        if ts > 0 {
            let dt = DateTime::<Utc>::from_timestamp(ts, 0)?;
            return Some(dt.format("%Y-%m-%d").to_string());
        }
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(&raw) {
        return Some(dt.format("%Y-%m-%d").to_string());
    }
    if let Ok(dt) = NaiveDateTime::parse_from_str(&raw, "%Y-%m-%d %H:%M:%S") {
        return Some(dt.date().to_string());
    }
    Some(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn xmltv_time(dt: DateTime<Utc>) -> String {
        dt.format("%Y%m%d%H%M%S +0000").to_string()
    }

    #[test]
    fn m3u_ids_are_stable_across_reordering() {
        let a = parse_m3u("#EXTM3U\n#EXTINF:-1 group-title=\"News\",Alpha\nhttp://a\n#EXTINF:-1 group-title=\"News\",Beta\nhttp://b\n");
        let b = parse_m3u("#EXTM3U\n#EXTINF:-1 group-title=\"News\",Beta\nhttp://b2\n#EXTINF:-1 group-title=\"News\",Alpha\nhttp://a2\n");
        assert_eq!(a[0].id, b[1].id);
        assert_eq!(a[1].id, b[0].id);
        let dup = parse_m3u("#EXTINF:-1,Same\nhttp://1\n#EXTINF:-1,Same\nhttp://2\n");
        assert_ne!(dup[0].id, dup[1].id);
    }

    #[test]
    fn epg_index_matches_by_id_and_display_name() {
        let now = Utc::now();
        let xml = format!(
            r#"<tv>
                <channel id="pro.tv.ro"><display-name>PRO TV</display-name></channel>
                <programme channel="pro.tv.ro" start="{}" stop="{}"><title>Stirile</title></programme>
                <programme channel="pro.tv.ro" start="{}" stop="{}"><title>Next</title></programme>
            </tv>"#,
            xmltv_time(now - ChronoDuration::minutes(30)),
            xmltv_time(now + ChronoDuration::minutes(30)),
            xmltv_time(now + ChronoDuration::minutes(30)),
            xmltv_time(now + ChronoDuration::minutes(90)),
        );
        let index = build_epg_index(&xml).unwrap();

        let by_name = epg_entries_for(&index, "mac-1", "Pro TV", None);
        assert_eq!(by_name.len(), 2);
        assert_eq!(by_name[0].title, "Stirile");

        let by_id = epg_entries_for(&index, "x", "Unrelated", Some("pro.tv.ro"));
        assert_eq!(by_id.len(), 2);

        assert!(epg_entries_for(&index, "x", "Other channel", None).is_empty());

        let (start, stop) = entry_times(by_name[0], "manual", 60).unwrap();
        assert_eq!(start - by_name[0].start_auto, ChronoDuration::minutes(60));
        assert_eq!(stop.unwrap() - by_name[0].stop_auto.unwrap(), ChronoDuration::minutes(60));
    }
}

#[cfg(test)]
mod bench {
    use super::*;

    /// Manual timing check: `EPG_FILE=/path/epg.xml cargo test --release epg_timing -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn epg_timing() {
        let path = std::env::var("EPG_FILE").expect("set EPG_FILE");
        let xml = std::fs::read_to_string(path).unwrap();
        let started = Instant::now();
        let index = build_epg_index(&xml).unwrap();
        println!("parse + index: {:?}", started.elapsed());

        let doc = roxmltree::Document::parse(&xml).unwrap();
        let names: Vec<String> = doc.descendants()
            .filter(|n| n.is_element() && n.tag_name().name() == "channel")
            .filter_map(|n| n.children().find(|c| c.tag_name().name() == "display-name").and_then(node_text))
            .collect();

        let started = Instant::now();
        let mut found = 0;
        for name in &names {
            if !epg_entries_for(&index, "x", name, None).is_empty() { found += 1; }
        }
        println!("lookup for {} channels ({} with data): {:?}", names.len(), found, started.elapsed());
    }
}
