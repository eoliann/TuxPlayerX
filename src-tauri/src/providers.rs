use chrono::{DateTime, NaiveDateTime, Utc};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, CONNECTION, COOKIE, USER_AGENT};
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::Url;
use crate::models::{Channel, Subscription, SubscriptionInfo};

const MAC_USER_AGENT: &str = "Mozilla/5.0 (QtEmbedded; U; Linux; en-US) AppleWebKit/533.3 (KHTML, like Gecko) MAG254 stbapp ver: 4 rev: 2721 Mobile Safari/533.3";

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
        let text = reqwest::Client::new()
            .get(source)
            .header(USER_AGENT, "TuxPlayerX/2.0")
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

fn parse_m3u(body: &str) -> Vec<Channel> {
    let mut channels = Vec::new();
    let mut current_name: Option<String> = None;
    let mut current_logo: Option<String> = None;
    let mut current_group: Option<String> = None;

    for line in body.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if line.starts_with("#EXTINF") {
            current_name = Some(line.split_once(',').map(|(_, name)| name.trim().to_string()).unwrap_or_else(|| "Unnamed channel".to_string()));
            current_logo = extract_attr(line, "tvg-logo");
            current_group = extract_attr(line, "group-title");
        } else if !line.starts_with('#') {
            let idx = channels.len() + 1;
            channels.push(Channel {
                id: format!("m3u-{idx}"),
                name: current_name.take().unwrap_or_else(|| format!("Channel {idx}")),
                stream_url: line.to_string(),
                logo: current_logo.take(),
                group: current_group.take(),
                raw_cmd: None,
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
    let json: Value = reqwest::get(api_url).await?.error_for_status()?.json().await?;
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
    let session = mac_handshake(sub).await?;
    let _ = mac_get_profile(&session).await;
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
        out.push(Channel { id, name, stream_url: clean_stream_url(&raw_cmd), logo, group, raw_cmd: Some(raw_cmd) });
    }

    if out.is_empty() {
        anyhow::bail!("No channels were found in this MAC subscription.")
    }
    Ok(out)
}

async fn create_mac_link(sub: &Subscription, cmd: &str) -> anyhow::Result<String> {
    let clean_cmd = clean_stream_url(cmd);
    let session = mac_handshake(sub).await?;
    let _ = mac_get_profile(&session).await;
    let params = vec![
        ("type".to_string(), "itv".to_string()),
        ("action".to_string(), "create_link".to_string()),
        ("cmd".to_string(), cmd.to_string()),
        ("series".to_string(), "0".to_string()),
        ("forced_storage".to_string(), "0".to_string()),
        ("disable_ad".to_string(), "0".to_string()),
    ];
    match mac_request(&session, params).await {
        Ok(payload) => {
            let js = js_payload(&payload);
            let link = js.get("cmd").or_else(|| js.get("url")).or_else(|| js.get("link")).and_then(value_to_string)
                .ok_or_else(|| anyhow::anyhow!("MAC portal did not return a playable link"))?;
            let stream_url = clean_stream_url(&link);
            if stream_url.starts_with("http://") || stream_url.starts_with("https://") || stream_url.starts_with("rtmp://") || stream_url.starts_with("rtsp://") {
                return Ok(stream_url);
            }
            anyhow::bail!("Portal did not return a playable stream URL for this channel.")
        }
        Err(e) => {
            if clean_cmd.starts_with("http://") || clean_cmd.starts_with("https://") || clean_cmd.starts_with("rtmp://") || clean_cmd.starts_with("rtsp://") {
                Ok(clean_cmd)
            } else {
                Err(e)
            }
        }
    }
}

async fn refresh_mac_info(sub: &Subscription) -> anyhow::Result<SubscriptionInfo> {
    let session = mac_handshake(sub).await?;
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
