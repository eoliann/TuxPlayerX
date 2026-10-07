//! Xtream Codes API: TV archive (catch-up), movies and series.

use std::collections::HashMap;
use chrono::{DateTime, Duration as ChronoDuration, NaiveDateTime, Utc};
use serde_json::Value;
use url::Url;
use crate::models::{SeriesEpisode, SeriesInfo, SeriesSeason, Subscription, VodCategory, VodDetails, VodItem};
use crate::providers::{http, value_to_i64, value_to_string};

#[derive(Debug, Clone, PartialEq)]
pub struct XtreamAccount {
    /// scheme://host[:port]
    pub base: String,
    pub username: String,
    pub password: String,
}

fn origin(url: &Url) -> String {
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    format!("{}://{}{port}", url.scheme(), url.host_str().unwrap_or_default())
}

/// Detects Xtream credentials from an M3U subscription (get.php?username=..&password=.. or the explicit fields).
pub fn account(sub: &Subscription) -> Option<XtreamAccount> {
    if sub.sub_type != "m3u" {
        return None;
    }
    let url = Url::parse(sub.url.as_deref()?.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let query = |key: &str| url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.to_string());
    let username = sub.username.clone().filter(|v| !v.trim().is_empty()).or_else(|| query("username"))?;
    let password = sub.password.clone().filter(|v| !v.trim().is_empty()).or_else(|| query("password"))?;
    Some(XtreamAccount { base: origin(&url), username, password })
}

/// Parses `http://host/live/user/pass/123.ts` (or `http://host/user/pass/123`) into account + stream id.
pub fn parse_stream_url(stream_url: &str) -> Option<(XtreamAccount, String)> {
    let url = Url::parse(stream_url).ok()?;
    let segments: Vec<&str> = url.path_segments()?.filter(|s| !s.is_empty()).collect();
    if segments.len() < 3 {
        return None;
    }
    let last = segments[segments.len() - 1];
    let stream_id = last.split('.').next().unwrap_or(last);
    if stream_id.is_empty() || !stream_id.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let account = XtreamAccount {
        base: origin(&url),
        username: urlencoding::decode(segments[segments.len() - 3]).ok()?.into_owned(),
        password: urlencoding::decode(segments[segments.len() - 2]).ok()?.into_owned(),
    };
    Some((account, stream_id.to_string()))
}

impl XtreamAccount {
    async fn api(&self, action: Option<&str>, extra: &[(&str, &str)]) -> anyhow::Result<Value> {
        let mut query: Vec<(&str, &str)> = vec![("username", &self.username), ("password", &self.password)];
        if let Some(action) = action {
            query.push(("action", action));
        }
        query.extend_from_slice(extra);
        let response = http()
            .get(format!("{}/player_api.php", self.base))
            .query(&query)
            .send()
            .await
            .map_err(|e| e.without_url())?
            .error_for_status()
            .map_err(|e| e.without_url())?;
        crate::security::read_json_limited(response).await
    }

    fn path_part(&self) -> String {
        format!("{}/{}", urlencoding::encode(&self.username), urlencoding::encode(&self.password))
    }

    /// stream_id -> archive days, for channels where the provider keeps a TV archive.
    pub async fn archive_days(&self) -> anyhow::Result<HashMap<String, i64>> {
        let streams = self.api(Some("get_live_streams"), &[]).await?;
        let mut out = HashMap::new();
        for stream in streams.as_array().into_iter().flatten() {
            let has_archive = stream.get("tv_archive").and_then(value_to_i64).unwrap_or(0) > 0;
            let days = stream.get("tv_archive_duration").and_then(value_to_i64).unwrap_or(0);
            if let (true, Some(id)) = (has_archive && days > 0, stream.get("stream_id").and_then(value_to_string)) {
                out.insert(id, days);
            }
        }
        Ok(out)
    }

    /// Offset of the server clock from UTC; timeshift URLs use the server's local time.
    async fn server_offset(&self) -> ChronoDuration {
        let local_offset = || ChronoDuration::seconds(chrono::Local::now().offset().local_minus_utc() as i64);
        let Ok(info) = self.api(None, &[]).await else { return local_offset() };
        let server = info.get("server_info");
        let timestamp = server.and_then(|s| s.get("timestamp_now")).and_then(value_to_i64);
        let time_now = server
            .and_then(|s| s.get("time_now"))
            .and_then(value_to_string)
            .and_then(|t| NaiveDateTime::parse_from_str(&t, "%Y-%m-%d %H:%M:%S").ok());
        match (timestamp.and_then(|ts| DateTime::<Utc>::from_timestamp(ts, 0)), time_now) {
            (Some(utc), Some(local)) => {
                // Round to the nearest 15 minutes to absorb request latency.
                let minutes = ((local - utc.naive_utc()).num_seconds() as f64 / 900.0).round() as i64 * 15;
                // Real time zones are within ±14 h; anything beyond ±26 h is a broken server answer.
                if minutes.abs() > 26 * 60 { local_offset() } else { ChronoDuration::minutes(minutes) }
            }
            _ => local_offset(),
        }
    }

    pub async fn timeshift_url(&self, stream_id: &str, start: DateTime<Utc>, stop: DateTime<Utc>) -> String {
        let local_start = start.naive_utc() + self.server_offset().await;
        let minutes = ((stop - start).num_seconds() as f64 / 60.0).ceil().max(1.0) as i64;
        format!(
            "{}/timeshift/{}/{minutes}/{}/{stream_id}.ts",
            self.base,
            self.path_part(),
            local_start.format("%Y-%m-%d:%H-%M"),
        )
    }

    pub async fn categories(&self, kind: &str) -> anyhow::Result<Vec<VodCategory>> {
        let action = if kind == "series" { "get_series_categories" } else { "get_vod_categories" };
        let json = self.api(Some(action), &[]).await?;
        Ok(json
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|c| {
                Some(VodCategory {
                    id: c.get("category_id").and_then(value_to_string)?,
                    name: c.get("category_name").and_then(value_to_string).unwrap_or_else(|| "Untitled".to_string()),
                })
            })
            .collect())
    }

    pub async fn items(&self, kind: &str, category_id: &str) -> anyhow::Result<Vec<VodItem>> {
        let action = if kind == "series" { "get_series" } else { "get_vod_streams" };
        let extra: Vec<(&str, &str)> = if category_id == "*" { vec![] } else { vec![("category_id", category_id)] };
        let json = self.api(Some(action), &extra).await?;
        let text = |item: &Value, keys: &[&str]| keys.iter().find_map(|k| item.get(*k).and_then(value_to_string)).filter(|v| !v.trim().is_empty());
        Ok(json
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| {
                let id = if kind == "series" { text(item, &["series_id"]) } else { text(item, &["stream_id"]) }?;
                let year = text(item, &["year", "releaseDate", "release_date"]).map(|y| y.chars().take(4).collect());
                Some(VodItem {
                    id,
                    name: text(item, &["name", "title"]).unwrap_or_else(|| "Untitled".to_string()),
                    kind: kind.to_string(),
                    poster: text(item, &["stream_icon", "cover"]),
                    rating: text(item, &["rating"]).filter(|r| r != "0"),
                    year,
                    plot: text(item, &["plot"]),
                    extension: text(item, &["container_extension"]),
                    cmd: None,
                    episodes: None,
                })
            })
            .collect())
    }

    pub async fn movie_details(&self, id: &str) -> anyhow::Result<VodDetails> {
        let json = self.api(Some("get_vod_info"), &[("vod_id", id)]).await?;
        let info = json.get("info").cloned().unwrap_or(Value::Null);
        let text = |keys: &[&str]| keys.iter().find_map(|k| info.get(*k).and_then(value_to_string)).filter(|v| !v.trim().is_empty());
        Ok(VodDetails {
            plot: text(&["plot", "description"]),
            genre: text(&["genre"]),
            cast: text(&["cast", "actors"]),
            director: text(&["director"]),
            release_date: text(&["releasedate", "release_date"]),
            duration: text(&["duration"]),
            rating: text(&["rating"]).filter(|r| r != "0"),
            backdrop: info.get("backdrop_path").and_then(|b| b.as_array().and_then(|a| a.first()).or(Some(b))).and_then(value_to_string),
        })
    }

    pub async fn series_info(&self, id: &str) -> anyhow::Result<SeriesInfo> {
        let json = self.api(Some("get_series_info"), &[("series_id", id)]).await?;
        let info = json.get("info").cloned().unwrap_or(Value::Null);
        let text = |v: &Value, keys: &[&str]| keys.iter().find_map(|k| v.get(*k).and_then(value_to_string)).filter(|s| !s.trim().is_empty());

        // Episodes come either as {"1": [...], "2": [...]} or as a flat array with a "season" field.
        let mut by_season: std::collections::BTreeMap<i64, Vec<SeriesEpisode>> = std::collections::BTreeMap::new();
        let mut push = |season: i64, episode: &Value| {
            let Some(id) = text(episode, &["id"]) else { return };
            let ep_info = episode.get("info").cloned().unwrap_or(Value::Null);
            let number = episode.get("episode_num").and_then(value_to_i64).unwrap_or(0);
            let entry = SeriesEpisode {
                id,
                number,
                title: text(episode, &["title"]).unwrap_or_else(|| format!("Episode {number}")),
                extension: text(episode, &["container_extension"]),
                plot: text(&ep_info, &["plot"]),
                duration: text(&ep_info, &["duration"]),
                poster: text(&ep_info, &["movie_image", "cover_big"]),
                cmd: None,
            };
            by_season.entry(season).or_default().push(entry);
        };
        match json.get("episodes") {
            Some(Value::Object(map)) => {
                for (season, list) in map {
                    let number = season.parse().unwrap_or(0);
                    for episode in list.as_array().into_iter().flatten() {
                        push(number, episode);
                    }
                }
            }
            Some(Value::Array(list)) => {
                for episode in list {
                    let season = episode.get("season").and_then(value_to_i64).unwrap_or(1);
                    push(season, episode);
                }
            }
            _ => {}
        }

        let season_names: HashMap<i64, String> = json
            .get("seasons")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|s| Some((s.get("season_number").and_then(value_to_i64)?, s.get("name").and_then(value_to_string)?)))
            .collect();
        let seasons = by_season
            .into_iter()
            .map(|(number, mut episodes)| {
                episodes.sort_by_key(|e| e.number);
                SeriesSeason { number, name: season_names.get(&number).cloned().unwrap_or_else(|| format!("Season {number}")), episodes }
            })
            .collect();

        Ok(SeriesInfo {
            name: text(&info, &["name"]).unwrap_or_default(),
            poster: text(&info, &["cover", "cover_big"]),
            plot: text(&info, &["plot"]),
            seasons,
        })
    }

    pub fn movie_url(&self, id: &str, extension: Option<&str>) -> String {
        format!("{}/movie/{}/{id}.{}", self.base, self.path_part(), extension.unwrap_or("mp4"))
    }

    pub fn episode_url(&self, id: &str, extension: Option<&str>) -> String {
        format!("{}/series/{}/{id}.{}", self.base, self.path_part(), extension.unwrap_or("mp4"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_live_stream_urls() {
        let (account, id) = parse_stream_url("http://host.tv:8080/live/john/s3cret/12345.ts").unwrap();
        assert_eq!(account, XtreamAccount { base: "http://host.tv:8080".into(), username: "john".into(), password: "s3cret".into() });
        assert_eq!(id, "12345");
        assert_eq!(parse_stream_url("http://host.tv/john/s3cret/777").unwrap().1, "777");
        assert!(parse_stream_url("http://host.tv/hls/channel/index.m3u8").is_none());
    }

    #[test]
    fn detects_account_from_m3u_url() {
        let sub = Subscription {
            id: None, name: "x".into(), sub_type: "m3u".into(),
            url: Some("http://host.tv:8080/get.php?username=john&password=pw&type=m3u_plus".into()),
            portal_url: None, mac_address: None, username: None, password: None, is_default: false,
            expires_at: None, active_connections: None, max_connections: None, created_at: None, updated_at: None,
        };
        let account = account(&sub).unwrap();
        assert_eq!(account.base, "http://host.tv:8080");
        assert_eq!(account.movie_url("55", Some("mkv")), "http://host.tv:8080/movie/john/pw/55.mkv");
    }
}
