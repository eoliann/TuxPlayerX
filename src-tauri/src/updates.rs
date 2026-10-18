//! Checks GitHub for a newer published release of this edition (desktop `vX.Y.Z`, Android `android-vX.Y.Z`).

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::providers::http;

const RELEASES_API: &str = "https://api.github.com/repos/eoliann/TuxPlayerX/releases?per_page=30";
/// Only links into the project's own releases are handed to the browser.
const RELEASES_PREFIX: &str = "https://github.com/eoliann/TuxPlayerX/releases/";
const MAX_NOTES_CHARS: usize = 800;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub available: bool,
    /// The release page.
    pub release_url: String,
    /// The installer for this system, or the release page when there is none.
    pub download_url: String,
    pub notes: String,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

fn tag_prefix() -> &'static str {
    if cfg!(target_os = "android") { "android-v" } else { "v" }
}

fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let core = text.trim().split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|part| part.parse::<u64>().ok());
    let version = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(version)
}

/// File extension of the installer that fits this system.
fn installer_extension() -> Option<&'static str> {
    if cfg!(target_os = "android") {
        Some(".apk")
    } else if cfg!(target_os = "windows") {
        Some(".exe")
    } else if cfg!(target_os = "linux") {
        if std::path::Path::new("/usr/bin/dpkg").exists() {
            Some(".deb")
        } else if std::path::Path::new("/usr/bin/rpm").exists() {
            Some(".rpm")
        } else {
            None
        }
    } else {
        None
    }
}

fn project_link(url: &str) -> Option<String> {
    url.starts_with(RELEASES_PREFIX).then(|| url.to_string())
}

fn pick_latest(releases: Vec<Release>, current: &str) -> Option<UpdateInfo> {
    let prefix = tag_prefix();
    let (version, release) = releases
        .into_iter()
        .filter(|r| !r.draft && !r.prerelease)
        .filter_map(|r| {
            let rest = r.tag_name.strip_prefix(prefix)?;
            Some((parse_version(rest)?, r))
        })
        .max_by_key(|(version, _)| *version)?;

    let release_url = project_link(&release.html_url)?;
    let download_url = installer_extension()
        .and_then(|ext| release.assets.iter().find(|a| a.name.to_ascii_lowercase().ends_with(ext)))
        .and_then(|asset| project_link(&asset.browser_download_url))
        .unwrap_or_else(|| release_url.clone());
    let notes: String = release.body.unwrap_or_default().trim().chars().take(MAX_NOTES_CHARS).collect();
    let available = parse_version(current).is_some_and(|installed| version > installed);

    Some(UpdateInfo {
        current_version: current.to_string(),
        latest_version: format!("{}.{}.{}", version.0, version.1, version.2),
        available,
        release_url,
        download_url,
        notes,
    })
}

pub async fn check(current: &str) -> anyhow::Result<UpdateInfo> {
    let releases: Vec<Release> = http()
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(20))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    pick_latest(releases, current).ok_or_else(|| anyhow::anyhow!("No published release was found."))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, assets: &[&str]) -> Release {
        Release {
            tag_name: tag.to_string(),
            html_url: format!("{RELEASES_PREFIX}tag/{tag}"),
            body: Some("notes".to_string()),
            draft: false,
            prerelease: false,
            assets: assets
                .iter()
                .map(|name| Asset { name: name.to_string(), browser_download_url: format!("{RELEASES_PREFIX}download/{tag}/{name}") })
                .collect(),
        }
    }

    #[test]
    fn parses_versions() {
        assert_eq!(parse_version("2.0.12"), Some((2, 0, 12)));
        assert_eq!(parse_version("2.0.12-beta.1"), Some((2, 0, 12)));
        assert_eq!(parse_version("2.0"), None);
        assert_eq!(parse_version("2.0.1.4"), None);
        assert_eq!(parse_version("x.y.z"), None);
    }

    #[test]
    fn picks_newest_release_of_this_edition() {
        let releases = vec![
            release("android-v9.9.9", &["TuxPlayerX-android.apk"]),
            release("v2.0.10", &[]),
            release("v2.0.13", &["TuxPlayerX_2.0.13_x64-setup.exe", "TuxPlayerX_amd64.deb", "TuxPlayerX_x86_64.rpm"]),
            release("v2.0.9", &[]),
        ];
        let info = pick_latest(releases, "2.0.12").unwrap();
        assert_eq!(info.latest_version, "2.0.13");
        assert!(info.available);
        assert!(info.release_url.ends_with("/tag/v2.0.13"));
        if cfg!(target_os = "windows") {
            assert!(info.download_url.ends_with(".exe"));
        }
    }

    #[test]
    fn skips_drafts_prereleases_and_reports_up_to_date() {
        let mut beta = release("v3.0.0", &[]);
        beta.prerelease = true;
        let mut draft = release("v4.0.0", &[]);
        draft.draft = true;
        let info = pick_latest(vec![beta, draft, release("v2.0.12", &[])], "2.0.12").unwrap();
        assert_eq!(info.latest_version, "2.0.12");
        assert!(!info.available);
    }

    #[test]
    fn falls_back_to_release_page_without_installer() {
        let info = pick_latest(vec![release("v2.0.13", &["notes.txt"])], "2.0.12").unwrap();
        assert_eq!(info.download_url, info.release_url);
    }

    /// Asks the real GitHub API: `cargo test --lib updates::tests::live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_check_against_github() {
        let info = tauri::async_runtime::block_on(check("0.0.1")).expect("GitHub check failed");
        println!("{info:?}");
        assert!(info.available);
        assert!(info.download_url.starts_with(RELEASES_PREFIX));
    }

    #[test]
    fn ignores_links_outside_the_project() {
        let mut other = release("v2.0.13", &[]);
        other.html_url = "https://example.com/evil".to_string();
        assert!(pick_latest(vec![other], "2.0.12").is_none());
    }
}
