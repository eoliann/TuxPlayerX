//! Input validation and limits shared by the backend (see docs/security-audit-2026-10.md).
//!
//! Playlists, portals, guides and backups come from outside the app, so everything they provide is
//! checked here before it reaches the file system, an external process, the network stack or the UI.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};

/// Largest M3U playlist accepted (very large providers list a few hundred thousand entries).
pub const MAX_PLAYLIST_BYTES: usize = 256 * 1024 * 1024;
/// Largest JSON answer accepted from Xtream panels and MAC portals.
pub const MAX_JSON_BYTES: usize = 64 * 1024 * 1024;
/// Largest XMLTV guide download (compressed or not).
pub const MAX_GUIDE_DOWNLOAD_BYTES: usize = 200 * 1024 * 1024;
/// Largest XMLTV guide after decompression.
pub const MAX_GUIDE_XML_BYTES: usize = 1024 * 1024 * 1024;
/// Longest User-Agent / Referer taken from a playlist.
pub const MAX_HEADER_VALUE_LEN: usize = 512;

/// Stream schemes the players may open. Everything else (`file:`, `screen:`, `dshow:`, UNC paths,
/// values starting with `-` that VLC would read as options) is refused.
const STREAM_SCHEMES: [&str; 7] = ["http://", "https://", "rtmp://", "rtmps://", "rtsp://", "rtp://", "udp://"];

/// True for a network stream address the players may open.
pub fn is_allowed_stream_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    !url.trim_start().starts_with('-')
        && STREAM_SCHEMES.iter().any(|scheme| lower.starts_with(scheme) && lower.len() > scheme.len())
        && !url.chars().any(|c| c.is_control())
}

/// Returns the stream address unchanged, or an error the UI can show.
pub fn check_stream_url(url: &str) -> Result<&str, String> {
    if is_allowed_stream_url(url) {
        Ok(url.trim())
    } else {
        Err("This stream address is not supported (only http, https, rtmp, rtsp, rtp and udp streams can be played).".to_string())
    }
}

/// True for Windows network paths (`\\server\share`, `//server/share`, `\\?\UNC\...`), which make
/// Windows contact another machine and send it the user's NTLM credentials.
pub fn is_network_path(path: &str) -> bool {
    let trimmed = path.trim().trim_matches('"');
    let normalized = trimmed.replace('/', "\\");
    normalized.starts_with("\\\\")
}

/// A local playlist or guide file: an existing regular file, not a network path, with an expected extension.
pub fn check_local_source_file(path: &Path, allowed_extensions: &[&str]) -> Result<PathBuf, String> {
    let text = path.to_string_lossy();
    if is_network_path(&text) {
        return Err("Network paths (\\\\server\\share) are not allowed as playlist or guide sources.".to_string());
    }
    let extension = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    if !allowed_extensions.iter().any(|allowed| *allowed == extension) {
        return Err(format!("Unsupported file type '.{extension}'. Expected one of: {}.", allowed_extensions.join(", ")));
    }
    let canonical = std::fs::canonicalize(path).map_err(|e| format!("Could not open '{}': {e}", path.display()))?;
    // Windows returns verbatim paths: `\\?\C:\...` is local, `\\?\UNC\server\share` is a network share
    // (a mapped drive or link can lead there even when the path the user gave looked local).
    let resolved = canonical.to_string_lossy().to_string();
    let resolved = match resolved.strip_prefix("\\\\?\\") {
        Some(rest) if rest.to_ascii_uppercase().starts_with("UNC\\") => format!("\\\\{}", &rest[4..]),
        Some(rest) => rest.to_string(),
        None => resolved,
    };
    if is_network_path(&resolved) {
        return Err("Network paths are not allowed as playlist or guide sources.".to_string());
    }
    let metadata = std::fs::metadata(&canonical).map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err(format!("'{}' is not a file.", path.display()));
    }
    Ok(canonical)
}

/// Removes control characters (CR/LF could break headers) and caps the length of a header value.
pub fn clean_header_value(value: &str) -> Option<String> {
    let cleaned: String = value.chars().filter(|c| !c.is_control()).take(MAX_HEADER_VALUE_LEN).collect();
    let cleaned = cleaned.trim().to_string();
    (!cleaned.is_empty()).then_some(cleaned)
}

/// Hides credentials in text shown to the user (error messages often contain the full request URL):
/// `password=` / `username=` query values and the `/live|movie|series|timeshift/<user>/<pass>/` path segments.
pub fn redact(text: &str) -> String {
    let mut out = redact_query_values(text, &["password=", "username=", "pass=", "token=", "mac="]);
    for prefix in ["/live/", "/movie/", "/series/", "/timeshift/"] {
        out = redact_path_credentials(&out, prefix);
    }
    out
}

fn redact_query_values(text: &str, keys: &[&str]) -> String {
    let mut out = String::with_capacity(text.len());
    let lower = text.to_ascii_lowercase();
    let mut index = 0;
    while index < text.len() {
        let hit = keys
            .iter()
            .filter_map(|key| lower[index..].find(key).map(|pos| (index + pos, key.len())))
            .min_by_key(|(pos, _)| *pos);
        let Some((pos, key_len)) = hit else {
            out.push_str(&text[index..]);
            break;
        };
        // Only a real query parameter: preceded by ? or & (or the start of the text).
        let boundary_ok = pos == 0 || matches!(text.as_bytes()[pos - 1], b'?' | b'&' | b' ' | b'"' | b'\'' | b'(');
        let value_start = pos + key_len;
        out.push_str(&text[index..value_start]);
        if boundary_ok {
            let value_end = text[value_start..]
                .find(|c: char| c == '&' || c == '#' || c.is_whitespace() || c == '"' || c == '\'' || c == ')')
                .map(|offset| value_start + offset)
                .unwrap_or(text.len());
            if value_end > value_start {
                out.push_str("***");
            }
            index = value_end;
        } else {
            index = value_start;
        }
    }
    out
}

fn redact_path_credentials(text: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find(prefix) {
        let after = pos + prefix.len();
        out.push_str(&rest[..after]);
        let tail = &rest[after..];
        // `<user>/<pass>/...`: hide the first two segments.
        let mut segments = tail.splitn(3, '/');
        match (segments.next(), segments.next(), segments.next()) {
            (Some(user), Some(pass), Some(_)) if !user.is_empty() && !pass.is_empty() && !user.contains(char::is_whitespace) => {
                out.push_str("***/***/");
                rest = &tail[user.len() + pass.len() + 2..];
            }
            _ => rest = tail,
        }
    }
    out.push_str(rest);
    out
}

/// True for loopback, private, link-local and unique-local addresses (and `localhost` names).
pub fn is_private_host(host: &str) -> bool {
    let host = host.trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => is_private_v4(ip),
        Ok(IpAddr::V6(ip)) => is_private_v6(ip),
        Err(_) => false,
    }
}

fn is_private_v4(ip: Ipv4Addr) -> bool {
    ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified() || ip.is_broadcast()
        // Carrier-grade NAT 100.64.0.0/10.
        || (ip.octets()[0] == 100 && (ip.octets()[1] & 0xC0) == 64)
}

fn is_private_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_private_v4(v4);
    }
    let first = ip.segments()[0];
    ip.is_loopback() || ip.is_unspecified() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
}

/// Reads a response body, refusing to keep more than `limit` bytes in memory.
pub async fn read_body_limited(mut response: reqwest::Response, limit: usize) -> anyhow::Result<Vec<u8>> {
    if let Some(length) = response.content_length() {
        if length > limit as u64 {
            anyhow::bail!("The server sent {} MB, more than the {} MB allowed.", length / 1_048_576, limit / 1_048_576);
        }
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.without_url())? {
        if body.len() + chunk.len() > limit {
            anyhow::bail!("The server sent more than the {} MB allowed.", limit / 1_048_576);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Reads a JSON response with the JSON size limit.
pub async fn read_json_limited<T: serde::de::DeserializeOwned>(response: reqwest::Response) -> anyhow::Result<T> {
    let body = read_body_limited(response, MAX_JSON_BYTES).await?;
    Ok(serde_json::from_slice(&body)?)
}

/// Redirect policy for every HTTP client: at most 10 hops, never from https to plain http, and never from
/// a public server to a loopback/private address (a playlist must not be able to reach the user's LAN).
pub fn safe_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 10 {
            return attempt.error("too many redirects");
        }
        let next = attempt.url();
        let Some(first) = attempt.previous().first() else { return attempt.follow() };
        if first.scheme() == "https" && next.scheme() != "https" {
            return attempt.error("refusing a redirect from https to http");
        }
        let first_private = first.host_str().map(is_private_host).unwrap_or(false);
        let next_private = next.host_str().map(is_private_host).unwrap_or(false);
        if next_private && !first_private {
            return attempt.error("refusing a redirect from a public server to a local address");
        }
        attempt.follow()
    })
}

/// Origins of the app's own pages (Windows/Android, Linux, `tauri dev`). The local servers only send CORS
/// headers to these, so other web pages cannot read their responses even if they guessed the token.
const APP_ORIGINS: [&str; 5] = ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost", "http://localhost:3000", "http://127.0.0.1:3000"];

/// The `Access-Control-Allow-Origin` header line (with CRLF) for a request's `Origin`, if it is the app.
pub fn cors_header_for(origin: Option<&str>) -> String {
    match origin.map(str::trim) {
        Some(origin) if APP_ORIGINS.iter().any(|allowed| allowed.eq_ignore_ascii_case(origin)) => {
            format!("Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\n")
        }
        _ => String::new(),
    }
}

/// The `Origin` header of a raw HTTP request head.
pub fn origin_of(head: &str) -> Option<&str> {
    head.lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("origin"))
        .map(|(_, value)| value.trim())
}

/// Constant-time comparison for secrets such as URL tokens.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// 128 random bits from the operating system, hex encoded.
pub fn random_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("the operating system random generator is unavailable");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_urls_are_limited_to_network_schemes() {
        for ok in ["http://h/1.ts", "https://h/a.m3u8", "rtmp://h/live", "rtsp://h:554/x", "udp://@239.0.0.1:1234", "RTP://h/x"] {
            assert!(is_allowed_stream_url(ok), "{ok}");
        }
        for bad in ["--config=x", "-I dummy", "file:///etc/passwd", "\\\\host\\share\\a.ts", "//host/share", "screen://", "dshow://", "C:\\x.ts", "http://", "http://h/\nx", ""] {
            assert!(!is_allowed_stream_url(bad), "{bad}");
        }
    }

    #[test]
    fn network_paths_are_detected() {
        assert!(is_network_path("\\\\attacker\\share\\x.m3u"));
        assert!(is_network_path("//attacker/share/x.m3u"));
        assert!(is_network_path("\\\\?\\UNC\\attacker\\share"));
        assert!(!is_network_path("C:\\Lists\\tv.m3u"));
        assert!(!is_network_path("/home/me/tv.m3u"));
    }

    #[test]
    fn credentials_are_redacted() {
        let text = "error sending request for url (http://h:8080/player_api.php?username=john&password=s3cr3t&action=x)";
        let out = redact(text);
        assert!(!out.contains("s3cr3t") && !out.contains("john"), "{out}");
        assert!(out.contains("password=***") && out.contains("action=x"), "{out}");
        let out = redact("http://h/live/john/s3cr3t/123.ts and http://h/movie/a/b/9.mkv");
        assert_eq!(out, "http://h/live/***/***/123.ts and http://h/movie/***/***/9.mkv");
        assert_eq!(redact("no secrets here"), "no secrets here");
        assert_eq!(redact("compassword=1"), "compassword=1");
    }

    #[test]
    fn header_values_are_cleaned() {
        assert_eq!(clean_header_value("VLC\r\nX-Evil: 1").as_deref(), Some("VLCX-Evil: 1"));
        assert_eq!(clean_header_value("   ").as_deref(), None);
        assert_eq!(clean_header_value(&"a".repeat(2000)).map(|v| v.len()), Some(MAX_HEADER_VALUE_LEN));
    }

    #[test]
    fn private_hosts_are_recognised() {
        for host in ["127.0.0.1", "localhost", "10.1.2.3", "192.168.1.1", "172.16.0.5", "169.254.169.254", "[::1]", "fd00::1", "fe80::1", "100.64.1.1", "printer.local"] {
            assert!(is_private_host(host), "{host}");
        }
        for host in ["8.8.8.8", "example.com", "2001:4860::8888", "172.32.0.1"] {
            assert!(!is_private_host(host), "{host}");
        }
    }

    #[test]
    fn cors_is_only_granted_to_the_app() {
        assert_eq!(cors_header_for(Some("http://tauri.localhost")), "Access-Control-Allow-Origin: http://tauri.localhost\r\nVary: Origin\r\n");
        assert!(!cors_header_for(Some("tauri://localhost")).is_empty());
        assert!(cors_header_for(Some("https://evil.example")).is_empty());
        assert!(cors_header_for(Some("http://tauri.localhost.evil.example")).is_empty());
        assert!(cors_header_for(None).is_empty());
        assert_eq!(origin_of("GET / HTTP/1.1\r\nHost: x\r\nOrigin: tauri://localhost\r\n\r\n"), Some("tauri://localhost"));
    }

    #[test]
    fn tokens_are_random_and_compared_safely() {
        let a = random_token();
        assert_eq!(a.len(), 32);
        assert_ne!(a, random_token());
        assert!(constant_time_eq(a.as_bytes(), a.as_bytes()));
        assert!(!constant_time_eq(a.as_bytes(), b"short"));
    }
}
