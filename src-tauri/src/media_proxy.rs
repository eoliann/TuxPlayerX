//! Small local HTTP proxy that lets the WebView play IPTV streams directly, without VLC.
//!
//! The WebView cannot read most IPTV servers by itself: they send no CORS headers, often need a
//! specific User-Agent or Referer, and HLS playlists may redirect to other hosts. The proxy fetches
//! the stream with the shared Rust HTTP stack, adds CORS headers, applies per-channel headers and
//! rewrites HLS playlists so every segment, key and variant playlist also goes through it.
//! Nothing is decoded or re-encoded here; bytes are passed through as they arrive.

use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::header::{ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE, REFERER, USER_AGENT};
use serde::Serialize;
use sha2::{Digest, Sha256};
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
            let proxy = Arc::new(Proxy { port: listener.local_addr()?.port(), token: new_token() });
            let shared = Arc::clone(&proxy);
            tauri::async_runtime::spawn(async move {
                loop {
                    if let Ok((stream, _)) = listener.accept().await {
                        let proxy = Arc::clone(&shared);
                        tauri::async_runtime::spawn(async move {
                            let _ = handle(stream, &proxy).await;
                        });
                    }
                }
            });
            anyhow::Ok(proxy)
        })
        .await
}

fn new_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    // RandomState is seeded from the operating system's random source.
    let random = || std::collections::hash_map::RandomState::new().build_hasher().finish();
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(random().to_le_bytes());
    hasher.update(random().to_le_bytes());
    hasher.update(nanos.to_le_bytes());
    format!("{:x}", hasher.finalize())[..24].to_string()
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
    if let Some(ua) = headers.user_agent.as_deref().filter(|v| !v.is_empty()) {
        request = request.header(USER_AGENT, ua);
    }
    if let Some(referrer) = headers.referrer.as_deref().filter(|v| !v.is_empty()) {
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

/// Reads the request head (request line and headers) sent by the WebView.
async fn read_head(stream: &mut TcpStream) -> anyhow::Result<String> {
    let mut buffer = Vec::with_capacity(2048);
    let mut chunk = [0_u8; 2048];
    loop {
        let read = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut chunk)).await??;
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

const CORS_HEADERS: &str = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\nCache-Control: no-cache\r\nConnection: close\r\n";

async fn respond(stream: &mut TcpStream, status: &str, content_type: &str, body: &[u8]) -> std::io::Result<()> {
    let head = format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n{CORS_HEADERS}\r\n", body.len());
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body).await
}

async fn handle(mut stream: TcpStream, proxy: &Proxy) -> anyhow::Result<()> {
    let head = read_head(&mut stream).await?;
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next().unwrap_or_default().split_whitespace();
    let method = request_line.next().unwrap_or_default().to_ascii_uppercase();
    let path = request_line.next().unwrap_or("/");
    let range = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("range"))
        .map(|(_, value)| value.trim().to_string());

    if method == "OPTIONS" {
        stream.write_all(format!("HTTP/1.1 204 No Content\r\n{CORS_HEADERS}\r\n").as_bytes()).await?;
        return Ok(());
    }

    let request_url = Url::parse(&format!("http://127.0.0.1{path}"))?;
    if request_url.path_segments().and_then(|mut segments| segments.next()) != Some(proxy.token.as_str()) {
        respond(&mut stream, "403 Forbidden", "text/plain", b"Forbidden").await?;
        return Ok(());
    }
    let query = |key: &str| request_url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned());
    let Some(target) = query("u") else {
        respond(&mut stream, "400 Bad Request", "text/plain", b"Missing stream URL").await?;
        return Ok(());
    };
    let headers = StreamHeaders { user_agent: query("ua"), referrer: query("ref") };

    let mut response = match send(&target, &headers, range.as_deref()).await {
        Ok(response) => response,
        Err(e) => {
            respond(&mut stream, "502 Bad Gateway", "text/plain", e.to_string().as_bytes()).await?;
            return Ok(());
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
        let rewritten = rewrite_playlist(&text, &final_url, proxy, &headers);
        let body = if method == "HEAD" { Vec::new() } else { rewritten.into_bytes() };
        respond(&mut stream, &status_line, "application/vnd.apple.mpegurl", &body).await?;
        return Ok(());
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
    head.push_str(CORS_HEADERS);
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await?;
    if method == "HEAD" {
        return Ok(());
    }

    // Pass the bytes through as they arrive. When the player goes away the write fails and the
    // upstream connection is dropped at once, which matters for providers that allow one connection.
    stream.write_all(&first).await?;
    while let Some(chunk) = response.chunk().await? {
        stream.write_all(&chunk).await?;
    }
    Ok(())
}

/// Points every URI in an HLS playlist (segments, variant playlists, keys, maps) at the proxy,
/// resolving relative URIs against the playlist's final URL after redirects.
fn rewrite_playlist(text: &str, base: &Url, proxy: &Proxy, headers: &StreamHeaders) -> String {
    let proxied = |uri: &str| -> Option<String> {
        let absolute = base.join(uri.trim()).ok()?;
        let name = if absolute.path().to_ascii_lowercase().ends_with(".m3u8") { "stream.m3u8" } else { "media" };
        Some(proxy.url_for(absolute.as_str(), headers, name))
    };
    let mut out = String::with_capacity(text.len() * 2);
    for line in text.lines() {
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
    out
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
            let headers = StreamHeaders { user_agent: Some("Test UA".into()), referrer: None };
            // No extension in the URL: the format is probed (through the redirect).
            let direct = prepare(&format!("http://127.0.0.1:{upstream}/live/ch"), &headers).await.unwrap();
            assert_eq!(direct.format, "hls");
            assert!(direct.url.contains("/stream.m3u8?"), "{}", direct.url);

            let plain = reqwest::Client::new();
            let playlist = plain.get(&direct.url).send().await.unwrap();
            assert_eq!(playlist.headers()["access-control-allow-origin"], "*");
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
        });
    }

    #[test]
    fn rewrites_playlist_uris_through_the_proxy() {
        let proxy = Proxy { port: 1234, token: "tok".into() };
        let base = Url::parse("http://cdn.example/live/ch1/index.m3u8").unwrap();
        let headers = StreamHeaders { user_agent: Some("UA 1".into()), referrer: None };
        let text = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x1\n#EXTINF:6,\nseg1.ts\n\nhttp://other.example/seg2.ts\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"audio/en.m3u8\"\n";
        let out = rewrite_playlist(text, &base, &proxy, &headers);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "#EXTM3U");
        assert!(lines[1].starts_with("#EXT-X-KEY:METHOD=AES-128,URI=\"http://127.0.0.1:1234/tok/media?u=http%3A%2F%2Fcdn.example%2Flive%2Fch1%2Fkey.bin&ua=UA+1\",IV=0x1"), "{}", lines[1]);
        assert_eq!(lines[3], "http://127.0.0.1:1234/tok/media?u=http%3A%2F%2Fcdn.example%2Flive%2Fch1%2Fseg1.ts&ua=UA+1");
        assert_eq!(lines[4], "");
        assert_eq!(lines[5], "http://127.0.0.1:1234/tok/media?u=http%3A%2F%2Fother.example%2Fseg2.ts&ua=UA+1");
        assert!(lines[6].contains("/tok/stream.m3u8?u=http%3A%2F%2Fcdn.example%2Flive%2Fch1%2Faudio%2Fen.m3u8"), "{}", lines[6]);
    }
}
