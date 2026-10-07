//! Small local HTTP proxy that lets the WebView play IPTV streams directly, without VLC.
//!
//! The WebView cannot read most IPTV servers by itself: they send no CORS headers, often need a
//! specific User-Agent or Referer, and HLS playlists may redirect to other hosts. The proxy fetches
//! the stream with the shared Rust HTTP stack, adds CORS headers, applies per-channel headers and
//! rewrites HLS playlists so every segment, key and variant playlist also goes through it.
//! Nothing is decoded or re-encoded here; bytes are passed through as they arrive.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use reqwest::header::{ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE, REFERER, USER_AGENT};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use url::Url;

/// Most IPTV servers accept VLC; some block unknown or browser user agents.
const DEFAULT_USER_AGENT: &str = "VLC/3.0.21 LibVLC/3.0.21";
/// HLS playlists larger than this are not rewritten (they are not real playlists).
const MAX_PLAYLIST_BYTES: usize = 8 * 1024 * 1024;
/// How many bytes are read to recognise the stream format when the URL does not tell.
const PROBE_BYTES: usize = 1024;

/// Optional request headers a playlist asks for (`#EXTVLCOPT`, `http-user-agent=`, `url|User-Agent=`).
#[derive(Debug, Clone, Default)]
pub struct StreamHeaders {
    pub user_agent: Option<String>,
    pub referrer: Option<String>,
    /// Set for addresses listed by a playlist that came from a public server: they may not point to
    /// a local or private address.
    pub public_parent: bool,
}

/// A stream prepared for the embedded player: the local proxy URL and how to play it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectStream {
    pub url: String,
    /// "hls" (hls.js), "mpegts" (mpegts.js) or "native" (plain <video> source).
    pub format: String,
}

struct Proxy {
    port: u16,
    token: String,
}

/// Streaming client: no overall timeout (live streams never end), but a stalled read is abandoned.
fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(DEFAULT_USER_AGENT)
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(20))
            // Never pass the previous address (it may hold credentials) to another server; no https→http
            // downgrade and no redirect from a public server into the local network.
            .referer(false)
            .redirect(crate::security::safe_redirect_policy())
            .build()
            .expect("failed to build media proxy HTTP client")
    })
}

/// Starts the proxy on first use and returns its address. A random token in every path keeps
/// other local programs and web pages from using it as an open proxy.
async fn proxy() -> anyhow::Result<&'static Arc<Proxy>> {
    static PROXY: tokio::sync::OnceCell<Arc<Proxy>> = tokio::sync::OnceCell::const_new();
    PROXY
        .get_or_try_init(|| async {
            let listener = TcpListener::bind("127.0.0.1:0").await?;
            let proxy = Arc::new(Proxy { port: listener.local_addr()?.port(), token: crate::security::random_token() });
            let shared = Arc::clone(&proxy);
            // A player needs a handful of connections; the cap keeps a misbehaving client from exhausting the app.
            let slots = Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS));
            tauri::async_runtime::spawn(async move {
                loop {
                    let Ok(permit) = Arc::clone(&slots).acquire_owned().await else { break };
                    if let Ok((stream, _)) = listener.accept().await {
                        let proxy = Arc::clone(&shared);
                        tauri::async_runtime::spawn(async move {
                            let _ = handle(stream, &proxy).await;
                            drop(permit);
                        });
                    }
                }
            });
            anyhow::Ok(proxy)
        })
        .await
}

impl Proxy {
    /// `name` ends the path (stream.m3u8 / stream.ts) so players that look at the URL pick the right engine.
    fn url_for(&self, target: &str, headers: &StreamHeaders, name: &str) -> String {
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        query.append_pair("u", target);
        if let Some(ua) = headers.user_agent.as_deref().filter(|v| !v.is_empty()) {
            query.append_pair("ua", ua);
        }
        if let Some(referrer) = headers.referrer.as_deref().filter(|v| !v.is_empty()) {
            query.append_pair("ref", referrer);
        }
        if headers.public_parent {
            query.append_pair("pp", "1");
        }
        format!("http://127.0.0.1:{}/{}/{name}?{}", self.port, self.token, query.finish())
    }
}

/// Guesses the stream format from the URL path; `None` when it has to be probed.
fn format_from_url(target: &str) -> Option<&'static str> {
    let path = Url::parse(target).map(|url| url.path().to_ascii_lowercase()).unwrap_or_else(|_| target.to_ascii_lowercase());
    if path.ends_with(".m3u8") || path.ends_with(".m3u") {
        Some("hls")
    } else if path.ends_with(".ts") || path.ends_with(".mts") || path.ends_with(".m2ts") {
        Some("mpegts")
    } else if [".mp4", ".m4v", ".mov", ".webm", ".mkv", ".mp3", ".aac"].iter().any(|ext| path.ends_with(ext)) {
        Some("native")
    } else {
        None
    }
}

/// Recognises the format from the response content type and first bytes.
fn sniff_format(content_type: &str, bytes: &[u8]) -> Option<&'static str> {
    let content_type = content_type.to_ascii_lowercase();
    let text = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    let text_start = text.iter().position(|b| !b.is_ascii_whitespace()).map(|i| &text[i..]).unwrap_or(text);
    if content_type.contains("mpegurl") || text_start.starts_with(b"#EXTM3U") {
        return Some("hls");
    }
    // MPEG-TS packets are 188 bytes and start with the 0x47 sync byte.
    if content_type.contains("mp2t") || (bytes.first() == Some(&0x47) && (bytes.len() <= 188 || bytes[188] == 0x47)) {
        return Some("mpegts");
    }
    if bytes.get(4..8) == Some(b"ftyp".as_slice()) || bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) || content_type.starts_with("video/mp4") {
        return Some("native");
    }
    None
}

async fn send(target: &str, headers: &StreamHeaders, range: Option<&str>) -> anyhow::Result<reqwest::Response> {
    let mut request = client().get(target);
    if let Some(ua) = headers.user_agent.as_deref().and_then(crate::security::clean_header_value) {
        request = request.header(USER_AGENT, ua);
    }
    if let Some(referrer) = headers.referrer.as_deref().and_then(crate::security::clean_header_value) {
        request = request.header(REFERER, referrer);
    }
    if let Some(range) = range {
        request = request.header(RANGE, range);
    }
    Ok(request.send().await?)
}

fn header_text(response: &reqwest::Response, name: reqwest::header::HeaderName) -> String {
    response.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string()
}

/// Returns the proxy URL for `target` and the engine the embedded player should use.
/// Fails when the stream cannot be reached or its format is not one the WebView can handle,
/// so the caller can fall back to the VLC bridge.
pub async fn prepare(target: &str, headers: &StreamHeaders) -> anyhow::Result<DirectStream> {
    let format = match format_from_url(target) {
        Some(format) => format,
        None => {
            let mut response = send(target, headers, None).await?.error_for_status()?;
            let content_type = header_text(&response, CONTENT_TYPE);
            let mut bytes = Vec::new();
            while bytes.len() < PROBE_BYTES {
                match tokio::time::timeout(Duration::from_secs(10), response.chunk()).await {
                    Ok(Ok(Some(chunk))) => bytes.extend_from_slice(&chunk),
                    Ok(Ok(None)) => break,
                    Ok(Err(e)) => return Err(e.into()),
                    Err(_) => anyhow::bail!("The stream sent no data within 10 seconds."),
                }
            }
            sniff_format(&content_type, &bytes).ok_or_else(|| anyhow::anyhow!("Unrecognised stream format ({content_type})"))?
        }
    };
    let name = match format {
        "hls" => "stream.m3u8",
        "mpegts" => "stream.ts",
        _ => "stream",
    };
    let proxy = proxy().await?;
    Ok(DirectStream { url: proxy.url_for(target, headers, name), format: format.to_string() })
}

/// Most connections the proxy serves at the same time.
const MAX_CONNECTIONS: usize = 64;
/// Longest time a client may take to send its request head.
const HEAD_DEADLINE: Duration = Duration::from_secs(15);
/// Longest time one write to the player may block (a player that stopped reading is dropped).
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
/// Largest rewritten HLS playlist and number of lines handled.
const MAX_REWRITTEN_BYTES: usize = 32 * 1024 * 1024;
const MAX_PLAYLIST_LINES: usize = 200_000;

/// Reads the request head (request line and headers) sent by the WebView.
async fn read_head(stream: &mut TcpStream) -> anyhow::Result<String> {
    let mut buffer = Vec::with_capacity(2048);
    let mut chunk = [0_u8; 2048];
    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|w| w == b"\r\n\r\n") || buffer.len() > 16 * 1024 {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&buffer).into_owned())
}

/// Writes to the player, giving up when it stops reading.
async fn write_all(stream: &mut TcpStream, bytes: &[u8]) -> anyhow::Result<()> {
    tokio::time::timeout(WRITE_TIMEOUT, stream.write_all(bytes)).await??;
    Ok(())
}

/// CORS headers (only the app's own origin may read the responses) and the common response headers.
fn common_headers(origin: Option<&str>) -> String {
    let cors = crate::security::cors_header_for(origin);
    let allow = if cors.is_empty() {
        String::new()
    } else {
        "Access-Control-Allow-Headers: Range\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\n".to_string()
    };
    format!("{cors}{allow}Cache-Control: no-cache\r\nConnection: close\r\n")
}

async fn respond(stream: &mut TcpStream, status: &str, content_type: &str, body: &[u8], origin: Option<&str>) -> anyhow::Result<()> {
    let head = format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n{}\r\n", body.len(), common_headers(origin));
    write_all(stream, head.as_bytes()).await?;
    write_all(stream, body).await
}

async fn handle(mut stream: TcpStream, proxy: &Proxy) -> anyhow::Result<()> {
    let head = tokio::time::timeout(HEAD_DEADLINE, read_head(&mut stream)).await??;
    let header = |wanted: &str| {
        head.split("\r\n")
            .skip(1)
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.trim().eq_ignore_ascii_case(wanted))
            .map(|(_, value)| value.trim().to_string())
    };
    let mut request_line = head.split("\r\n").next().unwrap_or_default().split_whitespace();
    let method = request_line.next().unwrap_or_default().to_ascii_uppercase();
    let path = request_line.next().unwrap_or("/");
    let range = header("range");
    let origin = header("origin");
    let origin = origin.as_deref();

    // Only requests addressed to this proxy (not to another host name resolving to 127.0.0.1, as in DNS
    // rebinding) and carrying the random token are served.
    let host_ok = header("host").map(|host| host == format!("127.0.0.1:{}", proxy.port)).unwrap_or(false);
    if !host_ok {
        return respond(&mut stream, "403 Forbidden", "text/plain", b"Forbidden", None).await;
    }
    if method == "OPTIONS" {
        return write_all(&mut stream, format!("HTTP/1.1 204 No Content\r\n{}\r\n", common_headers(origin)).as_bytes()).await;
    }

    let request_url = Url::parse(&format!("http://127.0.0.1{path}"))?;
    let given_token = request_url.path_segments().and_then(|mut segments| segments.next()).unwrap_or_default();
    if !crate::security::constant_time_eq(given_token.as_bytes(), proxy.token.as_bytes()) {
        return respond(&mut stream, "403 Forbidden", "text/plain", b"Forbidden", origin).await;
    }
    let query = |key: &str| request_url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned());
    let Some(target) = query("u") else {
        return respond(&mut stream, "400 Bad Request", "text/plain", b"Missing stream URL", origin).await;
    };
    let target_url = Url::parse(&target).ok().filter(|url| matches!(url.scheme(), "http" | "https"));
    let Some(target_url) = target_url else {
        return respond(&mut stream, "400 Bad Request", "text/plain", b"Unsupported stream URL", origin).await;
    };
    let public_parent = query("pp").as_deref() == Some("1");
    // A playlist from a public server may not send the app into the local network (security audit S12).
    if public_parent && target_url.host_str().map(crate::security::is_private_host).unwrap_or(true) {
        return respond(&mut stream, "403 Forbidden", "text/plain", b"Local address refused", origin).await;
    }
    let headers = StreamHeaders { user_agent: query("ua"), referrer: query("ref"), public_parent };

    let mut response = match send(&target, &headers, range.as_deref()).await {
        Ok(response) => response,
        Err(e) => {
            let message = crate::security::redact(&e.to_string());
            return respond(&mut stream, "502 Bad Gateway", "text/plain", message.as_bytes(), origin).await;
        }
    };
    let status = response.status();
    let status_line = format!("{} {}", status.as_u16(), status.canonical_reason().unwrap_or(""));
    let final_url = response.url().clone();
    let content_type = header_text(&response, CONTENT_TYPE);

    // The first chunk tells whether this is an HLS playlist that must be rewritten.
    let first = response.chunk().await?.unwrap_or_default();
    if status.is_success() && sniff_format(&content_type, &first) == Some("hls") && !content_type.to_ascii_lowercase().contains("mp2t") {
        let mut body = first.to_vec();
        while let Some(chunk) = response.chunk().await? {
            body.extend_from_slice(&chunk);
            if body.len() > MAX_PLAYLIST_BYTES {
                anyhow::bail!("Playlist too large");
            }
        }
        let text = String::from_utf8_lossy(&body);
        let rewritten = rewrite_playlist(&text, &final_url, proxy, &headers)?;
        let body = if method == "HEAD" { Vec::new() } else { rewritten.into_bytes() };
        return respond(&mut stream, &status_line, "application/vnd.apple.mpegurl", &body, origin).await;
    }

    let mut head = format!("HTTP/1.1 {status_line}\r\n");
    if !content_type.is_empty() {
        head.push_str(&format!("Content-Type: {content_type}\r\n"));
    }
    for name in [CONTENT_LENGTH, CONTENT_RANGE, ACCEPT_RANGES] {
        let value = header_text(&response, name.clone());
        if !value.is_empty() {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
    }
    head.push_str(&common_headers(origin));
    head.push_str("\r\n");
    write_all(&mut stream, head.as_bytes()).await?;
    if method == "HEAD" {
        return Ok(());
    }

    // Pass the bytes through as they arrive. When the player goes away the write fails and the
    // upstream connection is dropped at once, which matters for providers that allow one connection.
    write_all(&mut stream, &first).await?;
    while let Some(chunk) = response.chunk().await? {
        write_all(&mut stream, &chunk).await?;
    }
    Ok(())
}

/// Points every URI in an HLS playlist (segments, variant playlists, keys, maps) at the proxy,
/// resolving relative URIs against the playlist's final URL after redirects.
fn rewrite_playlist(text: &str, base: &Url, proxy: &Proxy, headers: &StreamHeaders) -> anyhow::Result<String> {
    // URIs listed by a playlist from a public server are marked, so the proxy refuses local addresses.
    let child_headers = StreamHeaders {
        public_parent: headers.public_parent || !base.host_str().map(crate::security::is_private_host).unwrap_or(false),
        ..headers.clone()
    };
    let proxied = |uri: &str| -> Option<String> {
        let absolute = base.join(uri.trim()).ok()?;
        let name = if absolute.path().to_ascii_lowercase().ends_with(".m3u8") { "stream.m3u8" } else { "media" };
        Some(proxy.url_for(absolute.as_str(), &child_headers, name))
    };
    let mut out = String::with_capacity(text.len() * 2);
    for (index, line) in text.lines().enumerate() {
        if index >= MAX_PLAYLIST_LINES || out.len() > MAX_REWRITTEN_BYTES {
            anyhow::bail!("Playlist too large");
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            out.push_str(line);
        } else if trimmed.starts_with('#') {
            out.push_str(&rewrite_uri_attributes(trimmed, &proxied));
        } else {
            out.push_str(&proxied(trimmed).unwrap_or_else(|| trimmed.to_string()));
        }
        out.push('\n');
    }
    Ok(out)
}

/// Rewrites `URI="..."` attributes in tags such as #EXT-X-KEY, #EXT-X-MEDIA and #EXT-X-MAP.
fn rewrite_uri_attributes(line: &str, proxied: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(start) = rest.find("URI=\"") {
        let value_start = start + 5;
        let Some(len) = rest[value_start..].find('"') else { break };
        let value = &rest[value_start..value_start + len];
        out.push_str(&rest[..value_start]);
        // data: URIs (inline keys) are left as they are.
        if value.starts_with("data:") {
            out.push_str(value);
        } else {
            out.push_str(&proxied(value).unwrap_or_else(|| value.to_string()));
        }
        rest = &rest[value_start + len..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_formats_from_url_and_bytes() {
        assert_eq!(format_from_url("http://h/live/u/p/1.ts"), Some("mpegts"));
        assert_eq!(format_from_url("http://h/hls/index.m3u8?token=1"), Some("hls"));
        assert_eq!(format_from_url("http://h/movie/u/p/2.mkv"), Some("native"));
        assert_eq!(format_from_url("http://h/u/p/3"), None);
        assert_eq!(sniff_format("text/plain", b"\n#EXTM3U\n"), Some("hls"));
        let mut ts = vec![0_u8; 376];
        ts[0] = 0x47;
        ts[188] = 0x47;
        assert_eq!(sniff_format("application/octet-stream", &ts), Some("mpegts"));
        assert_eq!(sniff_format("", b"\0\0\0\x20ftypisom"), Some("native"));
        assert_eq!(sniff_format("text/html", b"<html>"), None);
    }

    /// Serves a playlist (after a redirect) and a TS segment, checking the User-Agent it receives.
    fn fake_upstream() -> u16 {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut buffer = [0_u8; 4096];
                let read = stream.read(&mut buffer).unwrap();
                let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
                let ua_ok = request.to_ascii_lowercase().contains("user-agent: test ua");
                let response: Vec<u8> = match (path.as_str(), ua_ok) {
                    (_, false) => b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
                    ("/live/ch", _) => b"HTTP/1.1 302 Found\r\nLocation: /cdn/ch/index.m3u8\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
                    ("/cdn/ch/index.m3u8", _) => {
                        let body = "#EXTM3U\n#EXTINF:2,\nseg1.ts\n";
                        format!("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).into_bytes()
                    }
                    ("/cdn/ch/seg1.ts", _) => {
                        let mut body = vec![0_u8; 376];
                        body[0] = 0x47;
                        body[188] = 0x47;
                        let mut out = format!("HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
                        out.extend(body);
                        out
                    }
                    _ => b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
                };
                let _ = stream.write_all(&response);
            }
        });
        port
    }

    #[test]
    fn proxies_redirected_playlists_and_segments_with_cors() {
        let upstream = fake_upstream();
        tauri::async_runtime::block_on(async move {
            let headers = StreamHeaders { user_agent: Some("Test UA".into()), ..Default::default() };
            // No extension in the URL: the format is probed (through the redirect).
            let direct = prepare(&format!("http://127.0.0.1:{upstream}/live/ch"), &headers).await.unwrap();
            assert_eq!(direct.format, "hls");
            assert!(direct.url.contains("/stream.m3u8?"), "{}", direct.url);

            let plain = reqwest::Client::new();
            // CORS is granted to the app's own origin only.
            let foreign = plain.get(&direct.url).header("Origin", "https://evil.example").send().await.unwrap();
            assert!(foreign.headers().get("access-control-allow-origin").is_none());
            let playlist = plain.get(&direct.url).header("Origin", "http://tauri.localhost").send().await.unwrap();
            assert_eq!(playlist.headers()["access-control-allow-origin"], "http://tauri.localhost");
            let text = playlist.text().await.unwrap();
            let segment_url = text.lines().find(|line| line.starts_with("http://127.0.0.1")).expect(&text).to_string();
            assert!(segment_url.contains("cdn%2Fch%2Fseg1.ts"), "{segment_url}");

            let segment = plain.get(&segment_url).send().await.unwrap();
            assert_eq!(segment.status(), 200);
            assert_eq!(segment.headers()["content-type"], "video/mp2t");
            let bytes = segment.bytes().await.unwrap();
            assert_eq!((bytes.len(), bytes[0], bytes[188]), (376, 0x47, 0x47));

            // Requests without the proxy token are refused.
            let proxy_port = Url::parse(&direct.url).unwrap().port().unwrap();
            let forbidden = format!("http://127.0.0.1:{proxy_port}/wrongtoken/stream.m3u8?u=http%3A%2F%2Fexample.com%2F");
            assert_eq!(plain.get(&forbidden).send().await.unwrap().status(), 403);
            // Another host name pointing at 127.0.0.1 (DNS rebinding) is refused even with the token.
            let rebound = plain.get(&direct.url).header(reqwest::header::HOST, "evil.example").send().await.unwrap();
            assert_eq!(rebound.status(), 403);
            // An address listed by a public playlist may not lead into the local network.
            let token = Url::parse(&direct.url).unwrap().path_segments().unwrap().next().unwrap().to_string();
            let local = format!("http://127.0.0.1:{proxy_port}/{token}/media?u=http%3A%2F%2F127.0.0.1%3A{upstream}%2Fcdn%2Fch%2Fseg1.ts&pp=1");
            assert_eq!(plain.get(&local).send().await.unwrap().status(), 403);
        });
    }

    #[test]
    fn rewrites_playlist_uris_through_the_proxy() {
        let proxy = Proxy { port: 1234, token: "tok".into() };
        let base = Url::parse("http://cdn.example/live/ch1/index.m3u8").unwrap();
        let headers = StreamHeaders { user_agent: Some("UA 1".into()), ..Default::default() };
        let text = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x1\n#EXTINF:6,\nseg1.ts\n\nhttp://other.example/seg2.ts\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"audio/en.m3u8\"\n";
        let out = rewrite_playlist(text, &base, &proxy, &headers).unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "#EXTM3U");
        assert!(lines[1].starts_with("#EXT-X-KEY:METHOD=AES-128,URI=\"http://127.0.0.1:1234/tok/media?u=http%3A%2F%2Fcdn.example%2Flive%2Fch1%2Fkey.bin&ua=UA+1&pp=1\",IV=0x1"), "{}", lines[1]);
        assert_eq!(lines[3], "http://127.0.0.1:1234/tok/media?u=http%3A%2F%2Fcdn.example%2Flive%2Fch1%2Fseg1.ts&ua=UA+1&pp=1");
        assert_eq!(lines[4], "");
        assert_eq!(lines[5], "http://127.0.0.1:1234/tok/media?u=http%3A%2F%2Fother.example%2Fseg2.ts&ua=UA+1&pp=1");
        assert!(lines[6].contains("/tok/stream.m3u8?u=http%3A%2F%2Fcdn.example%2Flive%2Fch1%2Faudio%2Fen.m3u8"), "{}", lines[6]);
        // A playlist from a local server (e.g. a home IPTV server) does not mark its segments.
        let local = Url::parse("http://192.168.1.10/live/index.m3u8").unwrap();
        let out = rewrite_playlist("#EXTM3U
seg.ts
", &local, &proxy, &StreamHeaders::default()).unwrap();
        assert!(!out.contains("pp=1"), "{out}");
    }
}
