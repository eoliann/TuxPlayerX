use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};
use chrono::{DateTime, Duration as ChronoDuration, Local, LocalResult, NaiveDateTime, TimeZone, Utc};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, CONNECTION, COOKIE, USER_AGENT};
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::Url;
use crate::models::{Channel, EpgChannelKey, EpgGridItem, EpgNow, EpgProgram, SeriesEpisode, SeriesInfo, SeriesSeason, Subscription, SubscriptionInfo, VodCategory, VodDetails, VodItem, VodPage, VodPlayRequest};
use crate::xtream;

const MAC_USER_AGENT: &str = "Mozilla/5.0 (QtEmbedded; U; Linux; en-US) AppleWebKit/533.3 (KHTML, like Gecko) MAG254 stbapp ver: 4 rev: 2721 Mobile Safari/533.3";
/// How long a MAC portal token is reused before a new handshake is made.
const MAC_SESSION_TTL: Duration = Duration::from_secs(10 * 60);
/// How long a downloaded XMLTV guide is kept in memory before it is downloaded again.
const EPG_CACHE_TTL: Duration = Duration::from_secs(6 * 60 * 60);

/// Shared HTTP client so connections, DNS lookups and TLS sessions are reused between requests.
pub(crate) fn http() -> &'static reqwest::Client {
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
        let path = local_path(source);
        let bytes = std::fs::read(&path).map_err(|e| anyhow::anyhow!("Could not read playlist file '{}': {e}", path.display()))?;
        Ok(decode_text(bytes))
    }
}

/// Accepts plain paths as well as `file://` URLs (as produced by drag & drop or copied from a browser).
fn local_path(source: &str) -> std::path::PathBuf {
    let trimmed = source.trim().trim_matches('"');
    if trimmed.to_ascii_lowercase().starts_with("file:") {
        if let Ok(path) = Url::parse(trimmed).and_then(|url| url.to_file_path().map_err(|_| url::ParseError::RelativeUrlWithoutBase)) {
            return path;
        }
    }
    std::path::PathBuf::from(trimmed)
}

/// Playlists are usually UTF-8 (sometimes with a BOM); older ones are Latin-1/Windows-1252, decoded byte by byte.
fn decode_text(bytes: Vec<u8>) -> String {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).map(<[u8]>::to_vec).unwrap_or(bytes);
    match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(e) => e.into_bytes().iter().map(|&b| b as char).collect(),
    }
}

/// Reads an XMLTV guide from a URL or local file, transparently decompressing `.xml.gz` content.
async fn read_xmltv_source(source: &str) -> anyhow::Result<String> {
    let bytes = if source.starts_with("http://") || source.starts_with("https://") {
        http().get(source).send().await?.error_for_status()?.bytes().await?.to_vec()
    } else {
        std::fs::read(source)?
    };
    if bytes.starts_with(&[0x1f, 0x8b]) {
        tokio::task::spawn_blocking(move || {
            use std::io::Read;
            let mut text = String::new();
            flate2::read::MultiGzDecoder::new(bytes.as_slice()).read_to_string(&mut text)?;
            anyhow::Ok(text)
        })
        .await?
    } else {
        Ok(String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()))
    }
}

/// The EPG setting may hold several sources, one per line (or separated by ';').
fn epg_sources(epg_url: &str) -> Vec<String> {
    epg_url
        .split(['\n', ';'])
        .map(str::trim)
        .filter(|source| !source.is_empty())
        .map(str::to_string)
        .collect()
}

async fn load_m3u_channels(sub: &Subscription) -> anyhow::Result<Vec<Channel>> {
    let source = sub.url.as_deref().ok_or_else(|| anyhow::anyhow!("Missing M3U URL"))?;
    let body = read_source(source).await?;
    let mut channels = parse_m3u(&body);

    // Xtream providers expose which channels keep a TV archive; mark them for catch-up.
    if let Some(account) = xtream::account(sub) {
        if let Ok(archive) = account.archive_days().await {
            for channel in &mut channels {
                let Some((_, stream_id)) = xtream::parse_stream_url(&channel.stream_url) else { continue };
                if let Some(days) = archive.get(&stream_id) {
                    channel.catchup_days = Some(*days);
                    channel.catchup_type = Some("xc".to_string());
                }
            }
        }
    }
    Ok(channels)
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
    let mut current_catchup: (Option<String>, Option<i64>, Option<String>) = (None, None, None);
    let mut current_headers = (None::<String>, None::<String>);

    for line in body.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if line.starts_with("#EXTINF") {
            current_name = Some(extinf_title(line).unwrap_or_else(|| "Unnamed channel".to_string()));
            current_logo = extract_attr(line, "tvg-logo");
            current_group = extract_attr(line, "group-title");
            current_epg_id = extract_attr(line, "tvg-id").or_else(|| extract_attr(line, "tvg-name"));
            let days = extract_attr(line, "catchup-days")
                .or_else(|| extract_attr(line, "tvg-rec"))
                .and_then(|d| d.trim().parse::<i64>().ok())
                .filter(|d| *d > 0);
            let kind = extract_attr(line, "catchup").map(|k| k.trim().to_ascii_lowercase()).filter(|k| !k.is_empty());
            current_catchup = (kind.clone(), days.or(kind.as_ref().map(|_| 7)), extract_attr(line, "catchup-source"));
            current_headers = (
                extract_attr(line, "http-user-agent").or_else(|| extract_attr(line, "user-agent")),
                extract_attr(line, "http-referrer").or_else(|| extract_attr(line, "http-referer")),
            );
        } else if let Some(option) = line.strip_prefix("#EXTVLCOPT:") {
            let (key, value) = option.split_once('=').unwrap_or((option, ""));
            let value = Some(value.trim().to_string()).filter(|v| !v.is_empty());
            match key.trim().to_ascii_lowercase().as_str() {
                "http-user-agent" => current_headers.0 = value.or(current_headers.0.take()),
                "http-referrer" | "http-referer" => current_headers.1 = value.or(current_headers.1.take()),
                _ => {}
            }
        } else if let Some(json) = line.strip_prefix("#EXTHTTP:") {
            // Kodi style: #EXTHTTP:{"User-Agent":"...","Referer":"..."}
            if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(json) {
                for (key, value) in map {
                    let value = value.as_str().map(str::to_string);
                    match key.to_ascii_lowercase().as_str() {
                        "user-agent" => current_headers.0 = value.or(current_headers.0.take()),
                        "referer" | "referrer" => current_headers.1 = value.or(current_headers.1.take()),
                        _ => {}
                    }
                }
            }
        } else if !line.starts_with('#') {
            let idx = channels.len() + 1;
            let name = current_name.take().unwrap_or_else(|| format!("Channel {idx}"));
            let group = current_group.take();
            let (stream_url, pipe_headers) = split_pipe_headers(line);
            let (mut user_agent, mut referrer) = std::mem::take(&mut current_headers);
            user_agent = pipe_headers.0.or(user_agent);
            referrer = pipe_headers.1.or(referrer);
            channels.push(Channel {
                id: stable_m3u_id(&name, group.as_deref(), &mut seen_ids),
                name,
                stream_url,
                user_agent,
                referrer,
                logo: current_logo.take(),
                group,
                raw_cmd: None,
                epg_id: current_epg_id.take(),
                catchup_type: current_catchup.0.take(),
                catchup_days: current_catchup.1.take(),
                catchup_source: current_catchup.2.take(),
            });
        }
    }
    channels
}

/// Splits Kodi-style `url|User-Agent=...&Referer=...` into the clean URL and its headers.
fn split_pipe_headers(line: &str) -> (String, (Option<String>, Option<String>)) {
    let Some((url, options)) = line.split_once('|') else {
        return (line.to_string(), (None, None));
    };
    let mut headers = (None, None);
    for (key, value) in url::form_urlencoded::parse(options.as_bytes()) {
        let value = Some(value.trim().to_string()).filter(|v| !v.is_empty());
        match key.to_ascii_lowercase().as_str() {
            "user-agent" => headers.0 = value,
            "referer" | "referrer" => headers.1 = value,
            _ => {}
        }
    }
    (url.trim().to_string(), headers)
}

/// The channel name is after the first comma that is not inside a quoted attribute
/// (attributes such as http-user-agent="... KHTML, like Gecko ..." may contain commas).
fn extinf_title(line: &str) -> Option<String> {
    let mut in_quotes = false;
    for (index, c) in line.char_indices() {
        match c {
            '"' => in_quotes = !in_quotes,
            ',' if !in_quotes => {
                let title = line[index + 1..].trim();
                return (!title.is_empty()).then(|| title.to_string());
            }
            _ => {}
        }
    }
    None
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
    if !source.starts_with("http://") && !source.starts_with("https://") {
        let path = local_path(source);
        anyhow::ensure!(path.is_file(), "Playlist file not found: {}", path.display());
        return Ok(SubscriptionInfo {
            status: "Local file".to_string(),
            expires_at: None,
            active_connections: None,
            max_connections: None,
            message: Some("Local playlist files have no account information.".to_string()),
        });
    }
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
        out.push(Channel {
            id, name, stream_url: clean_stream_url(&raw_cmd), logo, group, raw_cmd: Some(raw_cmd), epg_id,
            catchup_days: None, catchup_type: None, catchup_source: None, user_agent: None, referrer: None,
        });
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
    let result = match request_mac_link(&cached, "itv", cmd, 0).await {
        Ok(url) => Ok(url),
        Err(_) => request_mac_link(&mac_session(sub, true).await?, "itv", cmd, 0).await,
    };
    result.or_else(|e| {
        let clean_cmd = clean_stream_url(cmd);
        if is_playable_url(&clean_cmd) { Ok(clean_cmd) } else { Err(e) }
    })
}

async fn request_mac_link(session: &MacPortalSession, link_type: &str, cmd: &str, series: i64) -> anyhow::Result<String> {
    let params = vec![
        ("type".to_string(), link_type.to_string()),
        ("action".to_string(), "create_link".to_string()),
        ("cmd".to_string(), cmd.to_string()),
        ("series".to_string(), series.to_string()),
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


// ---------------------------------------------------------------------------------------------
// Catch-up (TV archive)
// ---------------------------------------------------------------------------------------------

/// Fills an M3U `catchup-source` template with the programme time range.
fn fill_catchup_template(template: &str, start: DateTime<Utc>, stop: DateTime<Utc>) -> String {
    let now = Utc::now();
    let local = start.with_timezone(&Local);
    let duration = (stop - start).num_seconds().max(60);
    let replacements: Vec<(&str, String)> = vec![
        ("${start}", start.timestamp().to_string()),
        ("{utc}", start.timestamp().to_string()),
        ("{start}", start.timestamp().to_string()),
        ("${end}", stop.timestamp().to_string()),
        ("{utcend}", stop.timestamp().to_string()),
        ("{end}", stop.timestamp().to_string()),
        ("${timestamp}", now.timestamp().to_string()),
        ("${now}", now.timestamp().to_string()),
        ("{lutc}", now.timestamp().to_string()),
        ("{now}", now.timestamp().to_string()),
        ("${duration}", duration.to_string()),
        ("{duration:60}", (duration / 60).to_string()),
        ("{duration}", duration.to_string()),
        ("${offset}", (now - start).num_seconds().to_string()),
        ("{offset}", (now - start).num_seconds().to_string()),
        ("{Y}", local.format("%Y").to_string()),
        ("{m}", local.format("%m").to_string()),
        ("{d}", local.format("%d").to_string()),
        ("{H}", local.format("%H").to_string()),
        ("{M}", local.format("%M").to_string()),
        ("{S}", local.format("%S").to_string()),
    ];
    replacements.iter().fold(template.to_string(), |text, (key, value)| text.replace(key, value))
}

fn append_query(url: &str, query: &str) -> String {
    let query = query.trim_start_matches(['?', '&']);
    format!("{url}{}{query}", if url.contains('?') { '&' } else { '?' })
}

pub async fn resolve_catchup_stream(channel: &Channel, start: DateTime<Utc>, stop: DateTime<Utc>) -> anyhow::Result<String> {
    if start >= Utc::now() {
        anyhow::bail!("This programme has not aired yet.");
    }
    let kind = channel.catchup_type.as_deref().map(str::to_ascii_lowercase);
    let source = channel.catchup_source.as_deref().map(str::trim).filter(|s| !s.is_empty());
    match (kind.as_deref(), source) {
        (Some("xc") | Some("xtream"), _) | (None, None) if channel.catchup_days.is_some() => {
            let (account, stream_id) = xtream::parse_stream_url(&channel.stream_url)
                .ok_or_else(|| anyhow::anyhow!("Cannot detect the Xtream stream id for this channel."))?;
            Ok(account.timeshift_url(&stream_id, start, stop).await)
        }
        (Some("default"), Some(template)) => Ok(fill_catchup_template(template, start, stop)),
        (Some("append"), Some(template)) => {
            let suffix = fill_catchup_template(template, start, stop);
            Ok(if suffix.starts_with('?') || suffix.starts_with('&') { append_query(&channel.stream_url, &suffix) } else { format!("{}{suffix}", channel.stream_url) })
        }
        (Some("shift") | Some("default") | Some("append"), _) => Ok(append_query(
            &channel.stream_url,
            &format!("utc={}&lutc={}", start.timestamp(), Utc::now().timestamp()),
        )),
        (Some(other), _) => anyhow::bail!("Catch-up type '{other}' is not supported yet."),
        _ => anyhow::bail!("This channel has no TV archive."),
    }
}

// ---------------------------------------------------------------------------------------------
// Movies & series (VOD)
// ---------------------------------------------------------------------------------------------

const VOD_CACHE_TTL: Duration = Duration::from_secs(30 * 60);

fn vod_cache() -> &'static StdMutex<HashMap<String, (Instant, Vec<VodItem>)>> {
    static CACHE: OnceLock<StdMutex<HashMap<String, (Instant, Vec<VodItem>)>>> = OnceLock::new();
    CACHE.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn require_xtream(sub: &Subscription) -> anyhow::Result<xtream::XtreamAccount> {
    xtream::account(sub).ok_or_else(|| anyhow::anyhow!(
        "Movies and series need an Xtream subscription (M3U URL with username and password) or a MAC portal."
    ))
}

pub async fn vod_categories(sub: &Subscription, kind: &str) -> anyhow::Result<Vec<VodCategory>> {
    let mut categories = vec![VodCategory { id: "*".to_string(), name: "All".to_string() }];
    if sub.sub_type == "mac" {
        categories.extend(mac_vod_categories(sub).await?);
    } else {
        categories.extend(require_xtream(sub)?.categories(kind).await?);
    }
    Ok(categories)
}

pub async fn vod_items(sub: &Subscription, kind: &str, category_id: &str, page: u32, force: bool) -> anyhow::Result<VodPage> {
    if sub.sub_type == "mac" {
        return mac_vod_items(sub, kind, category_id, page.max(1)).await;
    }
    // Xtream returns a whole category at once; keep it in memory so browsing back and forth is instant.
    let key = format!("{}|{}|{kind}|{category_id}", sub.id.unwrap_or_default(), sub.url.as_deref().unwrap_or_default());
    if !force {
        if let Some((loaded, items)) = vod_cache().lock().ok().and_then(|c| c.get(&key).cloned()) {
            if loaded.elapsed() < VOD_CACHE_TTL {
                return Ok(VodPage { items, has_more: false });
            }
        }
    }
    let items = require_xtream(sub)?.items(kind, category_id).await?;
    if let Ok(mut cache) = vod_cache().lock() {
        cache.insert(key, (Instant::now(), items.clone()));
    }
    Ok(VodPage { items, has_more: false })
}

pub async fn vod_details(sub: &Subscription, item: &VodItem) -> anyhow::Result<VodDetails> {
    if sub.sub_type == "mac" {
        return Ok(VodDetails { plot: item.plot.clone(), rating: item.rating.clone(), release_date: item.year.clone(), ..Default::default() });
    }
    require_xtream(sub)?.movie_details(&item.id).await
}

pub async fn series_info(sub: &Subscription, item: &VodItem) -> anyhow::Result<SeriesInfo> {
    if sub.sub_type == "mac" {
        // MAC portals store a series as one VOD item with a list of episode numbers.
        let episodes = item.episodes.clone().unwrap_or_default().into_iter().map(|number| SeriesEpisode {
            id: format!("{}-{number}", item.id),
            number,
            title: format!("Episode {number}"),
            extension: None,
            plot: None,
            duration: None,
            poster: None,
            cmd: item.cmd.clone(),
        }).collect();
        return Ok(SeriesInfo {
            name: item.name.clone(),
            poster: item.poster.clone(),
            plot: item.plot.clone(),
            seasons: vec![SeriesSeason { number: 1, name: "Episodes".to_string(), episodes }],
        });
    }
    require_xtream(sub)?.series_info(&item.id).await
}

pub async fn resolve_vod_stream(sub: &Subscription, request: &VodPlayRequest) -> anyhow::Result<String> {
    if sub.sub_type == "mac" {
        let cmd = request.cmd.as_deref().ok_or_else(|| anyhow::anyhow!("Missing VOD command"))?;
        let series = request.episode_number.unwrap_or(0);
        let cached = mac_session(sub, false).await?;
        return match request_mac_link(&cached, "vod", cmd, series).await {
            Ok(url) => Ok(url),
            Err(_) => request_mac_link(&mac_session(sub, true).await?, "vod", cmd, series).await,
        };
    }
    let account = require_xtream(sub)?;
    let url = match request.kind.as_str() {
        "episode" => account.episode_url(&request.id, request.extension.as_deref()),
        _ => account.movie_url(&request.id, request.extension.as_deref()),
    };
    ensure_vod_available(&url).await?;
    Ok(url)
}

/// Some providers list a VOD catalogue but answer every movie request with an empty HTML page
/// (typically when the package does not include movies/series). Detect that up front so the user
/// gets a clear message instead of a generic player error. Network errors are ignored here and
/// left to the player.
async fn ensure_vod_available(url: &str) -> anyhow::Result<()> {
    let Ok(response) = http()
        .get(url)
        .header(reqwest::header::RANGE, "bytes=0-1")
        .timeout(Duration::from_secs(15))
        .send()
        .await
    else {
        return Ok(());
    };
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if status.is_client_error() || status.is_server_error() {
        anyhow::bail!("The provider refused this title (HTTP {}). Your subscription may not include movies/series.", status.as_u16());
    }
    if content_type.starts_with("text/html") || content_type.starts_with("text/plain") {
        anyhow::bail!("The provider returned no video for this title. Your subscription may not include movies/series.");
    }
    Ok(())
}

fn portal_origin(sub: &Subscription) -> String {
    sub.portal_url
        .as_deref()
        .and_then(|u| Url::parse(u.trim()).ok())
        .map(|u| format!("{}://{}{}", u.scheme(), u.host_str().unwrap_or_default(), u.port().map(|p| format!(":{p}")).unwrap_or_default()))
        .unwrap_or_default()
}

async fn mac_vod_categories(sub: &Subscription) -> anyhow::Result<Vec<VodCategory>> {
    let session = mac_session(sub, false).await?;
    let params = vec![("type".to_string(), "vod".to_string()), ("action".to_string(), "get_categories".to_string())];
    let payload = mac_request(&session, params).await?;
    let js = js_payload(&payload);
    let data = js.get("data").unwrap_or(js);
    Ok(data
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let id = c.get("id").and_then(value_to_string)?;
            (id != "*").then(|| VodCategory { id, name: c.get("title").and_then(value_to_string).unwrap_or_else(|| "Untitled".to_string()) })
        })
        .collect())
}

async fn mac_vod_items(sub: &Subscription, kind: &str, category_id: &str, page: u32) -> anyhow::Result<VodPage> {
    let session = mac_session(sub, false).await?;
    let params = vec![
        ("type".to_string(), "vod".to_string()),
        ("action".to_string(), "get_ordered_list".to_string()),
        ("category".to_string(), category_id.to_string()),
        ("genre".to_string(), "*".to_string()),
        ("sortby".to_string(), "added".to_string()),
        ("p".to_string(), page.to_string()),
    ];
    let payload = mac_request(&session, params).await?;
    let js = js_payload(&payload);
    let total = js.get("total_items").and_then(value_to_i64).unwrap_or(0);
    let per_page = js.get("max_page_items").and_then(value_to_i64).unwrap_or(14).max(1);
    let origin = portal_origin(sub);
    let absolute = |path: String| if path.starts_with("http") { path } else { format!("{origin}{}{path}", if path.starts_with('/') { "" } else { "/" }) };
    let items = js
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let text = |keys: &[&str]| keys.iter().find_map(|k| item.get(*k).and_then(value_to_string)).filter(|v| !v.trim().is_empty());
            let episodes: Vec<i64> = item.get("series").and_then(Value::as_array).into_iter().flatten().filter_map(value_to_i64).collect();
            let is_series = !episodes.is_empty() || text(&["is_series"]).as_deref() == Some("1");
            if (kind == "series") != is_series {
                return None;
            }
            Some(VodItem {
                id: text(&["id"])?,
                name: text(&["name", "o_name"]).unwrap_or_else(|| "Untitled".to_string()),
                kind: kind.to_string(),
                poster: text(&["screenshot_uri", "cover_big"]).map(absolute),
                rating: text(&["rating_imdb", "rating_kinopoisk"]).filter(|r| r != "0" && r != "N/A"),
                year: text(&["year"]),
                plot: text(&["description"]),
                extension: None,
                cmd: text(&["cmd"]),
                episodes: (!episodes.is_empty()).then_some(episodes),
            })
        })
        .collect();
    Ok(VodPage { items, has_more: (page as i64) * per_page < total })
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
    /// Loose key (see `loose_name_key` / `loose_id_key`) -> normalized XMLTV channel id.
    /// Used only when the exact match finds nothing.
    loose_aliases: HashMap<String, String>,
}

/// Words dropped from the end of channel names before loose matching ("Antena 1 HD" -> "antena1").
const QUALITY_WORDS: &[&str] = &[
    "hd", "sd", "fhd", "uhd", "4k", "8k", "hevc", "h264", "h265", "fibra", "backup", "raw", "hq", "lq",
    "1080p", "1080i", "720p", "576p", "480p", "360p", "50fps", "60fps",
];

fn loose_words_key(text: &str) -> String {
    // Drop bracketed parts such as "(Romania)" or "[Geo-blocked]".
    let mut plain = String::new();
    let mut depth = 0usize;
    for c in text.chars() {
        match c {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = depth.saturating_sub(1),
            _ if depth == 0 => plain.push(c),
            _ => {}
        }
    }
    let mut words: Vec<&str> = plain.split(|c: char| !c.is_alphanumeric() && c != '+').filter(|w| !w.is_empty()).collect();
    while words.len() > 1 && words.last().is_some_and(|w| QUALITY_WORDS.contains(w)) {
        words.pop();
    }
    words.concat()
}

/// Loose key for a channel name / display-name: ignores a two-letter country prefix ("RO - ", "RO:", "RO|"),
/// quality suffixes and bracketed text.
fn loose_name_key(name: &str) -> String {
    let lower = name.trim().to_lowercase();
    let chars: Vec<char> = lower.chars().collect();
    let mut start = 0;
    if chars.len() > 3 && chars[0].is_ascii_alphabetic() && chars[1].is_ascii_alphabetic() {
        let mut i = 2;
        while i < chars.len() && chars[i] == ' ' { i += 1; }
        if i < chars.len() && matches!(chars[i], '-' | ':' | '|') {
            start = i + 1;
        }
    }
    loose_words_key(&chars[start..].iter().collect::<String>())
}

/// Loose key for an XMLTV / tvg-id such as "Antena1.ro" or "Antena1.ro@SD" -> "antena1".
fn loose_id_key(id: &str) -> String {
    let lower = id.trim().to_lowercase();
    let base = lower.split('@').next().unwrap_or_default();
    let base = match base.rsplit_once('.') {
        Some((head, tld)) if !head.is_empty() && (2..=3).contains(&tld.len()) && tld.chars().all(|c| c.is_ascii_alphabetic()) => head,
        _ => base,
    };
    loose_words_key(base)
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
    let sources = epg_sources(epg_url);
    if sources.is_empty() {
        anyhow::bail!("Set an XMLTV EPG URL in Settings first.");
    }
    let source = sources.join("\n");
    let source = source.as_str();

    let mut cache = epg_cache().lock().await;
    if let Some(entry) = cache.as_ref() {
        if !force && entry.source == source && entry.loaded_at.elapsed() < EPG_CACHE_TTL {
            return Ok(entry.index.clone());
        }
    }

    let loaded = async {
        // Download all sources in parallel; a failing source is skipped as long as another one works.
        let downloads: Vec<_> = sources
            .iter()
            .cloned()
            .map(|source| tokio::spawn(async move { read_xmltv_source(&source).await.map_err(|e| format!("{source}: {e}")) }))
            .collect();
        let mut documents = Vec::new();
        let mut errors = Vec::new();
        for download in downloads {
            match download.await {
                Ok(Ok(xml)) => documents.push(xml),
                Ok(Err(e)) => errors.push(e),
                Err(e) => errors.push(e.to_string()),
            }
        }
        if documents.is_empty() {
            anyhow::bail!("Could not load any EPG source. {}", errors.join("; "));
        }
        let index = tokio::task::spawn_blocking(move || build_epg_index(&documents)).await??;
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

fn build_epg_index(documents: &[String]) -> anyhow::Result<EpgIndex> {
    let mut aliases: HashMap<String, Vec<String>> = HashMap::new();
    let mut loose_aliases: HashMap<String, String> = HashMap::new();
    let mut add_loose = |key: String, channel_key: &str| {
        if !key.is_empty() && !channel_key.is_empty() {
            loose_aliases.entry(key).or_insert_with(|| channel_key.to_string());
        }
    };
    let mut add_alias = |alias: &str, channel_key: &str| {
        let alias = normalize_epg_key(alias);
        if alias.is_empty() || channel_key.is_empty() { return; }
        let list = aliases.entry(alias).or_default();
        if !list.iter().any(|existing| existing == channel_key) {
            list.push(channel_key.to_string());
        }
    };

    // Only keep a window around "now"; the margin covers any manual offset (max ±12h).
    let now = Utc::now();
    let min_time = now - ChronoDuration::hours(24);
    let max_time = now + ChronoDuration::days(4);
    let mut programmes: HashMap<String, Vec<EpgEntry>> = HashMap::new();
    let mut parsed_any = false;
    let mut last_error = None;

    for xml in documents {
        let doc = match roxmltree::Document::parse(xml) {
            Ok(doc) => doc,
            Err(e) => {
                last_error = Some(e);
                continue;
            }
        };
        parsed_any = true;

        for node in doc.descendants().filter(|node| node.is_element() && node.tag_name().name() == "channel") {
            let Some(id) = node.attribute("id") else { continue };
            let channel_key = normalize_epg_key(id);
            add_alias(id, &channel_key);
            add_loose(loose_id_key(id), &channel_key);
            for display in node.children().filter(|child| child.is_element() && child.tag_name().name() == "display-name") {
                if let Some(text) = node_text(display) {
                    add_alias(&text, &channel_key);
                    add_loose(loose_name_key(&text), &channel_key);
                }
            }
        }

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
    }

    if !parsed_any {
        if let Some(e) = last_error {
            return Err(e.into());
        }
    }

    for list in programmes.values_mut() {
        list.sort_by_key(|entry| entry.start_auto);
        // The same programme can appear in several sources; keep the first one.
        list.dedup_by(|a, b| a.start_auto == b.start_auto);
    }

    Ok(EpgIndex { programmes, aliases, loose_aliases })
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

    // Nothing matched exactly: fall back to the loose keys ("ANTENA 1 HD" -> "RO - Antena 1").
    if !programme_keys.iter().any(|key| index.programmes.contains_key(*key)) {
        let loose_keys = [epg_id.map(loose_id_key), epg_id.map(loose_name_key), Some(loose_name_key(name))];
        for key in loose_keys.into_iter().flatten().filter(|key| !key.is_empty()) {
            if let Some(channel_key) = index.loose_aliases.get(&key) {
                programme_keys.insert(channel_key.as_str());
                break;
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

/// Programmes between `from` and `to` (Unix seconds) for the channels shown in the TV guide grid.
pub async fn load_epg_grid(
    epg_url: &str,
    channels: &[EpgChannelKey],
    from: i64,
    to: i64,
    timezone_mode: &str,
    manual_offset_minutes: i64,
) -> anyhow::Result<HashMap<String, Vec<EpgGridItem>>> {
    let index = epg_index(epg_url, false).await?;
    let mut out = HashMap::new();
    for channel in channels {
        let items: Vec<EpgGridItem> = epg_entries_for(&index, &channel.id, &channel.name, channel.epg_id.as_deref())
            .into_iter()
            .filter_map(|entry| {
                let (start, stop) = entry_times(entry, timezone_mode, manual_offset_minutes)?;
                // Programmes without a stop time are shown as 30 minutes long.
                let stop = stop.unwrap_or(start + ChronoDuration::minutes(30));
                (stop.timestamp() > from && start.timestamp() < to).then(|| EpgGridItem {
                    title: entry.title.clone(),
                    description: entry.description.clone(),
                    start: start.timestamp(),
                    stop: stop.timestamp(),
                })
            })
            .collect();
        if !items.is_empty() {
            out.insert(channel.id.clone(), items);
        }
    }
    Ok(out)
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

pub(crate) fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

pub(crate) fn value_to_i64(value: &Value) -> Option<i64> {
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
    fn parses_stream_headers_from_all_playlist_styles() {
        let channels = parse_m3u(concat!(
            "#EXTM3U\n",
            "#EXTINF:-1 http-user-agent=\"Attr UA\",A\n#EXTVLCOPT:http-referrer=https://ref.example/\nhttp://s/a.m3u8\n",
            "#EXTINF:-1,B\nhttp://s/b.ts|User-Agent=Pipe%20UA&Referer=https://pipe.example/\n",
            "#EXTINF:-1,C\n#EXTHTTP:{\"User-Agent\":\"Json UA\"}\nhttp://s/c.ts\n",
            "#EXTINF:-1,D\nhttp://s/d.ts\n",
        ));
        assert_eq!(channels[0].user_agent.as_deref(), Some("Attr UA"));
        assert_eq!(channels[0].referrer.as_deref(), Some("https://ref.example/"));
        assert_eq!(channels[1].stream_url, "http://s/b.ts");
        assert_eq!(channels[1].user_agent.as_deref(), Some("Pipe UA"));
        assert_eq!(channels[1].referrer.as_deref(), Some("https://pipe.example/"));
        assert_eq!(channels[2].user_agent.as_deref(), Some("Json UA"));
        assert_eq!(channels[3].user_agent, None);
    }

    #[test]
    fn local_playlists_accept_file_urls_bom_and_latin1() {
        assert_eq!(decode_text(b"\xEF\xBB\xBF#EXTM3U".to_vec()), "#EXTM3U");
        assert_eq!(decode_text(b"#EXTINF:-1,Rom\xE2nia".to_vec()), "#EXTINF:-1,Rom\u{e2}nia");
        assert_eq!(local_path("  \"list.m3u\" "), std::path::PathBuf::from("list.m3u"));
        #[cfg(windows)]
        assert_eq!(local_path("file:///C:/Lists/my%20list.m3u"), std::path::PathBuf::from("C:\\Lists\\my list.m3u"));
        #[cfg(not(windows))]
        assert_eq!(local_path("file:///home/me/my%20list.m3u"), std::path::PathBuf::from("/home/me/my list.m3u"));
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
    fn parses_catchup_attributes_and_builds_urls() {
        let channels = parse_m3u(concat!(
            "#EXTINF:-1 catchup=\"append\" catchup-days=\"3\" catchup-source=\"?utc={utc}&lutc={lutc}\",Arch\nhttp://s/a.m3u8\n",
            "#EXTINF:-1 tvg-rec=\"5\",Rec\nhttp://s/b.m3u8\n",
            "#EXTINF:-1,Plain\nhttp://s/c.m3u8\n",
        ));
        assert_eq!(channels[0].catchup_type.as_deref(), Some("append"));
        assert_eq!(channels[0].catchup_days, Some(3));
        assert_eq!(channels[1].catchup_days, Some(5));
        assert!(channels[2].catchup_days.is_none() && channels[2].catchup_type.is_none());

        let start = DateTime::<Utc>::from_timestamp(1_700_000_000, 0).unwrap();
        let stop = start + ChronoDuration::minutes(30);
        let filled = fill_catchup_template("http://x/{utc}/{utcend}/{duration}", start, stop);
        assert_eq!(filled, "http://x/1700000000/1700001800/1800");

        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let url = runtime.block_on(resolve_catchup_stream(&channels[0], start, stop)).unwrap();
        assert!(url.starts_with("http://s/a.m3u8?utc=1700000000&lutc="), "{url}");
    }

    #[test]
    fn loose_epg_matching_handles_quality_suffixes_and_prefixes() {
        assert_eq!(loose_name_key("ANTENA 1 HD"), "antena1");
        assert_eq!(loose_name_key("ANTENA 1 FIBRA"), "antena1");
        assert_eq!(loose_name_key("RO - Antena 1"), "antena1");
        assert_eq!(loose_name_key("RO| Pro TV FHD"), "protv");
        assert_eq!(loose_name_key("Antena 1 (Romania)"), "antena1");
        assert_eq!(loose_name_key("HBO 3"), "hbo3");
        assert_eq!(loose_name_key("Pro TV"), "protv");
        assert_eq!(loose_id_key("Antena1.ro@SD"), "antena1");
        assert_eq!(loose_id_key("Antena1.ro"), "antena1");

        let now = Utc::now();
        let xml = format!(
            r#"<tv><channel id="Antena1.ro"><display-name>RO - Antena 1</display-name></channel>
               <channel id="AntenaStars.ro"><display-name>RO - Antena Stars</display-name></channel>
               <programme channel="Antena1.ro" start="{}" stop="{}"><title>Observator</title></programme></tv>"#,
            xmltv_time(now - ChronoDuration::minutes(5)),
            xmltv_time(now + ChronoDuration::minutes(55)),
        );
        let index = build_epg_index(&[xml]).unwrap();
        assert_eq!(epg_entries_for(&index, "x", "ANTENA 1 HD", None)[0].title, "Observator");
        assert_eq!(epg_entries_for(&index, "x", "Antena 1 (Romania)", Some("Antena1.ro@SD"))[0].title, "Observator");
        assert!(epg_entries_for(&index, "x", "ANTENA 3 HD", None).is_empty());
    }

    #[test]
    fn extinf_title_ignores_commas_inside_attributes() {
        let channels = parse_m3u("#EXTINF:-1 http-user-agent=\"Mozilla/5.0 (KHTML, like Gecko)\" group-title=\"Peru\",Antena 1 (Peru)\nhttp://x/1\n");
        assert_eq!(channels[0].name, "Antena 1 (Peru)");
        assert_eq!(channels[0].group.as_deref(), Some("Peru"));
    }

    #[test]
    fn epg_sources_split_lines_and_semicolons_but_keep_spaces() {
        let sources = epg_sources(" https://a/epg.xml \n\n/mnt/My Files/guide.xml.gz;https://b/x.xml ");
        assert_eq!(sources, vec!["https://a/epg.xml", "/mnt/My Files/guide.xml.gz", "https://b/x.xml"]);
    }

    #[test]
    fn reads_gzipped_and_merges_multiple_guides() {
        use std::io::Write;
        let now = Utc::now();
        let guide = |channel: &str, title: &str| format!(
            r#"<tv><channel id="{channel}"><display-name>{channel}</display-name></channel><programme channel="{channel}" start="{}" stop="{}"><title>{title}</title></programme></tv>"#,
            xmltv_time(now - ChronoDuration::minutes(10)),
            xmltv_time(now + ChronoDuration::minutes(10)),
        );
        let dir = std::env::temp_dir().join(format!("tuxplayerx-epg-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let gz_path = dir.join("guide.xml.gz");
        let mut encoder = flate2::write::GzEncoder::new(std::fs::File::create(&gz_path).unwrap(), flate2::Compression::default());
        encoder.write_all(guide("alpha", "From gzip").as_bytes()).unwrap();
        encoder.finish().unwrap();

        let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let unzipped = runtime.block_on(read_xmltv_source(gz_path.to_str().unwrap())).unwrap();
        let index = build_epg_index(&[unzipped, guide("beta", "Plain"), "not xml".to_string()]).unwrap();
        assert_eq!(epg_entries_for(&index, "x", "alpha", None)[0].title, "From gzip");
        assert_eq!(epg_entries_for(&index, "x", "beta", None)[0].title, "Plain");
        let _ = std::fs::remove_dir_all(dir);
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
        let index = build_epg_index(&[xml]).unwrap();

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
        let index = build_epg_index(std::slice::from_ref(&xml)).unwrap();
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

    /// Match report for real channel names: `EPG_FILE=... EPG_NAMES_FILE=names.txt cargo test epg_match_report -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn epg_match_report() {
        let xml = std::fs::read_to_string(std::env::var("EPG_FILE").expect("set EPG_FILE")).unwrap();
        let names = std::fs::read_to_string(std::env::var("EPG_NAMES_FILE").expect("set EPG_NAMES_FILE")).unwrap();
        let index = build_epg_index(&[xml]).unwrap();
        let (mut matched, mut total) = (0, 0);
        for line in names.lines().filter(|l| !l.trim().is_empty()) {
            let (name, epg_id) = line.split_once('\t').map(|(n, e)| (n, (!e.is_empty()).then_some(e))).unwrap_or((line, None));
            total += 1;
            let entries = epg_entries_for(&index, "x", name, epg_id);
            if !entries.is_empty() { matched += 1; }
            if name.to_lowercase().contains("antena") || name.to_lowercase().contains("pro tv") {
                println!("{name:30} -> {}", entries.first().map(|e| e.channel_id.as_str()).unwrap_or("-"));
            }
        }
        println!("matched {matched}/{total}");
    }
}
