#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod db;
mod media_proxy;
mod models;
mod providers;
mod xtream;

use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Manager, State};
use db::Database;
use models::{AppInfo, AppSettings, BackupFile, Channel, ChannelLoadResult, EpgChannelKey, EpgGridItem, EpgNow, EpgProgram, ImportSummary, SeriesInfo, Subscription, SubscriptionInfo, VodCategory, VodDetails, VodItem, VodPage, VodPlayRequest};

/// Channel lists are served from the local cache for this long before being downloaded again.
const CHANNEL_CACHE_MAX_AGE_SECS: i64 = 6 * 60 * 60;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

struct VlcBridge {
    child: Child,
    stop_flag: Arc<AtomicBool>,
    work_dir: PathBuf,
    generation: u64,
}

struct AppState {
    db: Mutex<Database>,
    external_player: Mutex<Option<Child>>,
    vlc_bridge: Mutex<Option<VlcBridge>>,
}

impl Drop for AppState {
    fn drop(&mut self) {
        if let Ok(bridge) = self.vlc_bridge.get_mut() {
            if let Some(running) = bridge.take() {
                running.stop_flag.store(true, Ordering::Relaxed);
                kill_child_process_tree(running.child);
                let _ = fs::remove_dir_all(running.work_dir);
            }
        }

        if let Ok(external_player) = self.external_player.get_mut() {
            if let Some(child) = external_player.take() {
                kill_child_process_tree(child);
            }
        }
    }
}

fn err<E: std::fmt::Display>(e: E) -> String { e.to_string() }

#[cfg(target_os = "windows")]
fn kill_child_process_tree(mut child: Child) {
    let pid = child.id().to_string();
    let mut taskkill = Command::new("taskkill");
    taskkill.creation_flags(CREATE_NO_WINDOW);
    let _ = taskkill.args(["/PID", &pid, "/T", "/F"]).output();
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(target_os = "windows"))]
fn kill_child_process_tree(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn stop_external_player_internal(state: &AppState) -> Result<(), String> {
    let mut external_player = state.external_player.lock().map_err(err)?;
    if let Some(child) = external_player.take() {
        kill_child_process_tree(child);
    }
    Ok(())
}

fn cleanup_playback_internal(state: &AppState) -> Result<(), String> {
    let bridge_result = stop_vlc_bridge_internal(state);
    let external_result = stop_external_player_internal(state);
    bridge_result?;
    external_result?;
    Ok(())
}

fn content_type_for(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".m3u8") { "application/vnd.apple.mpegurl" }
    else if lower.ends_with(".ts") { "video/mp2t" }
    else if lower.ends_with(".html") { "text/html; charset=utf-8" }
    else { "application/octet-stream" }
}

fn serve_bridge_file(mut stream: std::net::TcpStream, root: &std::path::Path) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buffer = [0_u8; 2048];
    let read = stream.read(&mut buffer).unwrap_or(0);
    let request = String::from_utf8_lossy(&buffer[..read]);
    let mut path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/stream.m3u8")
        .split('?')
        .next()
        .unwrap_or("/stream.m3u8")
        .trim_start_matches('/')
        .to_string();

    if path.is_empty() { path = "stream.m3u8".to_string(); }
    if path.contains("..") { path = "stream.m3u8".to_string(); }

    match fs::read(root.join(&path)) {
        Ok(bytes) => {
            let headers = format!(
                "HTTP/1.1 200 OK
Content-Type: {}
Content-Length: {}
Access-Control-Allow-Origin: *
Cache-Control: no-cache, no-store, must-revalidate
Pragma: no-cache
Connection: close

",
                content_type_for(&path),
                bytes.len()
            );
            let _ = stream.write_all(headers.as_bytes());
            let _ = stream.write_all(&bytes);
        }
        Err(_) => {
            let body = b"Not ready";
            let headers = format!(
                "HTTP/1.1 404 Not Found
Content-Type: text/plain
Content-Length: {}
Access-Control-Allow-Origin: *
Cache-Control: no-cache
Connection: close

",
                body.len()
            );
            let _ = stream.write_all(headers.as_bytes());
            let _ = stream.write_all(body);
        }
    }
}

fn start_static_hls_server(listener: TcpListener, root: PathBuf, stop_flag: Arc<AtomicBool>) {
    let _ = listener.set_nonblocking(true);
    let root = Arc::new(root);
    thread::spawn(move || {
        while !stop_flag.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream, _addr)) => {
                    // One short-lived thread per request so a slow segment download never blocks the playlist.
                    let _ = stream.set_nonblocking(false);
                    let root = Arc::clone(&root);
                    thread::spawn(move || serve_bridge_file(stream, &root));
                }
                Err(_) => thread::sleep(Duration::from_millis(50)),
            }
        }
    });
}

fn stop_vlc_bridge_internal(state: &AppState) -> Result<(), String> {
    let mut bridge = state.vlc_bridge.lock().map_err(err)?;
    if let Some(running) = bridge.take() {
        running.stop_flag.store(true, Ordering::Relaxed);
        kill_child_process_tree(running.child);
        let _ = fs::remove_dir_all(running.work_dir);
    }
    Ok(())
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        name: "TuxPlayerX".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        author: env!("CARGO_PKG_AUTHORS").to_string(),
        repository: "eoliann/TuxPlayerX".to_string(),
        license: env!("CARGO_PKG_LICENSE").to_string(),
        download_url: "https://github.com/eoliann/TuxPlayerX/releases".to_string(),
    }
}


#[tauri::command]
fn current_platform() -> String {
    std::env::consts::OS.to_string()
}

#[cfg(target_os = "windows")]
fn find_windows_vlc() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(program_files) = std::env::var_os("PROGRAMFILES") {
        candidates.push(PathBuf::from(program_files).join("VideoLAN").join("VLC").join("vlc.exe"));
    }

    if let Some(program_files_x86) = std::env::var_os("PROGRAMFILES(X86)") {
        candidates.push(PathBuf::from(program_files_x86).join("VideoLAN").join("VLC").join("vlc.exe"));
    }

    candidates.into_iter().find(|path| path.exists())
}

fn build_external_player_command(command_setting: &str) -> (Command, String) {
    let trimmed = command_setting.trim();

    #[cfg(target_os = "windows")]
    {
        if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("vlc") || trimmed.eq_ignore_ascii_case("vlc.exe") {
            if let Some(vlc_path) = find_windows_vlc() {
                let label = vlc_path.display().to_string();
                return (Command::new(vlc_path), label);
            }
        }
    }

    let command = if trimmed.is_empty() { "vlc" } else { trimmed };
    (Command::new(command), command.to_string())
}

/// Passes the User-Agent / Referer a playlist asks for on to VLC.
fn add_vlc_http_headers(cmd: &mut Command, user_agent: Option<&str>, referrer: Option<&str>) {
    if let Some(user_agent) = user_agent.map(str::trim).filter(|v| !v.is_empty()) {
        cmd.arg(format!("--http-user-agent={user_agent}"));
    }
    if let Some(referrer) = referrer.map(str::trim).filter(|v| !v.is_empty()) {
        cmd.arg(format!("--http-referrer={referrer}"));
    }
}

fn open_player_process(state: State<AppState>, url: String, detached: bool, user_agent: Option<String>, referrer: Option<String>) -> Result<(), String> {
    let settings = state.db.lock().map_err(err)?.get_settings().map_err(err)?;
    let (mut cmd, label) = build_external_player_command(&settings.external_player_command);

    let mut external_player = state.external_player.lock().map_err(err)?;
    if let Some(mut child) = external_player.take() {
        let _ = child.kill();
        let _ = child.wait();
    }

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.arg("--no-qt-privacy-ask");
        cmd.arg("--no-qt-error-dialogs");
        cmd.arg(format!("--network-caching={}", settings.network_cache_ms));
        if detached {
            cmd.arg("--qt-minimal-view");
            cmd.arg("--video-on-top");
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if detached {
            cmd.arg("--video-on-top");
        }
    }

    add_vlc_http_headers(&mut cmd, user_agent.as_deref(), referrer.as_deref());
    cmd.arg(url);

    let child = cmd
        .spawn()
        .map_err(|e| format!("Could not start external player '{label}'. Install VLC or set the full path in Settings. Details: {e}"))?;
    *external_player = Some(child);
    Ok(())
}


/// Prepares a stream for direct playback in the WebView through the local media proxy.
#[tauri::command]
async fn prepare_direct_stream(url: String, user_agent: Option<String>, referrer: Option<String>) -> Result<media_proxy::DirectStream, String> {
    let headers = media_proxy::StreamHeaders { user_agent, referrer };
    media_proxy::prepare(&url, &headers).await.map_err(err)
}

#[tauri::command]
fn stop_vlc_bridge(state: State<AppState>) -> Result<(), String> {
    stop_vlc_bridge_internal(&state)
}

/// How long the bridge may take to produce the first HLS segment before playback is reported as failed.
const VLC_BRIDGE_READY_TIMEOUT: Duration = Duration::from_secs(25);

/// Each bridge gets a generation number so a start request that was superseded (fast zapping) can tell.
static VLC_BRIDGE_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Returns true when the bridge playlist exists and already lists at least one segment.
fn bridge_playlist_ready(index_path: &std::path::Path) -> bool {
    fs::read_to_string(index_path).map(|text| text.contains("#EXTINF")).unwrap_or(false)
}

/// Starts VLC as a local HLS segmenter for the embedded player.
/// By default the video is only remuxed (no re-encoding) and just the audio is converted to AAC,
/// which keeps CPU usage low. `transcode = true` also re-encodes video to H.264 for codecs the
/// WebView cannot decode (HEVC, MPEG-2, ...).
#[tauri::command]
async fn start_vlc_bridge(
    state: State<'_, AppState>,
    url: String,
    transcode: Option<bool>,
    user_agent: Option<String>,
    referrer: Option<String>,
) -> Result<String, String> {
    stop_vlc_bridge_internal(&state)?;
    let generation = VLC_BRIDGE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let transcode = transcode.unwrap_or(false);

    let settings = state.db.lock().map_err(err)?.get_settings().map_err(err)?;
    let (mut cmd, label) = build_external_player_command(&settings.external_player_command);

    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Could not start local playback bridge server: {e}"))?;
    let port = listener.local_addr().map_err(err)?.port();

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(err)?
        .as_millis();
    let work_dir = std::env::temp_dir().join(format!("tuxplayerx-vlc-bridge-{}-{stamp}", std::process::id()));
    fs::create_dir_all(&work_dir).map_err(err)?;

    let index_path = work_dir.join("stream.m3u8");
    let segment_pattern = work_dir.join("stream-########.ts");
    let index = index_path.to_string_lossy().replace('\\', "/");
    let segment = segment_pattern.to_string_lossy().replace('\\', "/");
    let index_url = format!("http://127.0.0.1:{port}/stream-########.ts");
    let playback_url = format!("http://127.0.0.1:{port}/stream.m3u8");

    let stop_flag = Arc::new(AtomicBool::new(false));
    start_static_hls_server(listener, work_dir.clone(), stop_flag.clone());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let (codecs, seglen) = if transcode {
        ("vcodec=h264,venc=x264{preset=veryfast,tune=zerolatency},vb=2500,acodec=mp4a,ab=160,channels=2,samplerate=48000,scodec=none", 4)
    } else {
        ("acodec=mp4a,ab=160,channels=2,samplerate=48000,scodec=none", 2)
    };
    let sout = format!(
        "#transcode{{{codecs}}}:std{{access=livehttp{{seglen={seglen},delsegs=true,numsegs=10,index={index},index-url={index_url}}},mux=ts{{use-key-frames}},dst={segment}}}"
    );

    cmd.arg("-I")
        .arg("dummy")
        .arg("--quiet")
        .arg("--no-video-title-show")
        .arg("--http-reconnect")
        .arg(format!("--network-caching={}", settings.network_cache_ms));
    add_vlc_http_headers(&mut cmd, user_agent.as_deref(), referrer.as_deref());
    cmd.arg(url)
        .arg("--sout")
        .arg(sout)
        .arg("--sout-keep");

    let child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            stop_flag.store(true, Ordering::Relaxed);
            let _ = fs::remove_dir_all(&work_dir);
            return Err(format!("Could not start VLC bridge using '{label}'. Install VLC or set the full path in Settings. Details: {e}"));
        }
    };

    {
        let mut bridge = state.vlc_bridge.lock().map_err(err)?;
        *bridge = Some(VlcBridge { child, stop_flag, work_dir, generation });
    }

    // Poll without blocking the UI thread until VLC has written a playlist with at least one segment.
    let deadline = Instant::now() + VLC_BRIDGE_READY_TIMEOUT;
    loop {
        tokio::time::sleep(Duration::from_millis(150)).await;

        {
            let mut bridge = state.vlc_bridge.lock().map_err(err)?;
            match bridge.as_mut() {
                Some(running) if running.generation == generation => {
                    if let Ok(Some(status)) = running.child.try_wait() {
                        if let Some(stopped) = bridge.take() {
                            stopped.stop_flag.store(true, Ordering::Relaxed);
                            let _ = fs::remove_dir_all(&stopped.work_dir);
                        }
                        return Err(format!("VLC bridge stopped before producing a playable stream (exit status: {status}). The channel may be offline."));
                    }
                }
                // Another channel was started or playback was stopped meanwhile.
                _ => return Err("Playback request was replaced by a newer one.".to_string()),
            }
        }

        if bridge_playlist_ready(&index_path) {
            return Ok(playback_url);
        }

        if Instant::now() >= deadline {
            let still_current = state.vlc_bridge.lock().map_err(err)?.as_ref().map(|running| running.generation) == Some(generation);
            if still_current {
                stop_vlc_bridge_internal(&state)?;
            }
            return Err(format!(
                "The channel did not start within {} seconds. The server may be offline or overloaded.",
                VLC_BRIDGE_READY_TIMEOUT.as_secs()
            ));
        }
    }
}

#[tauri::command]
fn list_subscriptions(state: State<AppState>) -> Result<Vec<Subscription>, String> {
    state.db.lock().map_err(err)?.list_subscriptions().map_err(err)
}

#[tauri::command]
fn save_subscription(state: State<AppState>, subscription: Subscription) -> Result<i64, String> {
    let db = state.db.lock().map_err(err)?;
    let id = db.save_subscription(&subscription).map_err(err)?;
    // Source URL or credentials may have changed, so the cached channel list is no longer trustworthy.
    db.clear_cached_channels(id).map_err(err)?;
    Ok(id)
}

#[tauri::command]
fn delete_subscription(state: State<AppState>, id: i64) -> Result<(), String> {
    state.db.lock().map_err(err)?.delete_subscription(id).map_err(err)
}

#[tauri::command]
fn set_default_subscription(state: State<AppState>, id: i64) -> Result<(), String> {
    state.db.lock().map_err(err)?.set_default_subscription(id).map_err(err)
}

#[tauri::command]
fn get_default_subscription(state: State<AppState>) -> Result<Option<Subscription>, String> {
    state.db.lock().map_err(err)?.get_default_subscription().map_err(err)
}

#[tauri::command]
async fn load_channels(state: State<'_, AppState>, id: i64, force: Option<bool>) -> Result<ChannelLoadResult, String> {
    if !force.unwrap_or(false) {
        let cached = state.db.lock().map_err(err)?.get_cached_channels(id, CHANNEL_CACHE_MAX_AGE_SECS).map_err(err)?;
        if let Some((channels, fetched_at)) = cached {
            return Ok(ChannelLoadResult { channels, from_cache: true, fetched_at });
        }
    }
    let sub = { state.db.lock().map_err(err)?.get_subscription(id).map_err(err)? };
    let sub = sub.ok_or_else(|| "Subscription not found".to_string())?;
    let channels = providers::load_channels(&sub).await.map_err(err)?;
    let fetched_at = state.db.lock().map_err(err)?.store_cached_channels(id, &channels).map_err(err)?;
    Ok(ChannelLoadResult { channels, from_cache: false, fetched_at })
}

/// Writes a backup JSON file to the Downloads folder (or home as a fallback) and returns its path.
#[tauri::command]
fn export_backup(state: State<AppState>) -> Result<String, String> {
    let backup = state.db.lock().map_err(err)?.export_backup().map_err(err)?;
    let folder = dirs_next::download_dir()
        .or_else(dirs_next::home_dir)
        .ok_or_else(|| "Could not find the Downloads folder".to_string())?;
    let file_name = format!("TuxPlayerX-backup-{}.json", chrono::Local::now().format("%Y%m%d-%H%M"));
    let path = folder.join(file_name);
    fs::write(&path, serde_json::to_string_pretty(&backup).map_err(err)?).map_err(err)?;
    Ok(path.display().to_string())
}

#[tauri::command]
fn import_backup(state: State<AppState>, content: String) -> Result<ImportSummary, String> {
    let backup: BackupFile = serde_json::from_str(&content).map_err(|e| format!("Invalid backup file: {e}"))?;
    state.db.lock().map_err(err)?.import_backup(&backup).map_err(err)
}

#[tauri::command]
fn list_favorites(state: State<AppState>, subscription_id: i64) -> Result<Vec<String>, String> {
    state.db.lock().map_err(err)?.list_favorites(subscription_id).map_err(err)
}

#[tauri::command]
fn toggle_favorite(state: State<AppState>, subscription_id: i64, channel_id: String) -> Result<bool, String> {
    state.db.lock().map_err(err)?.toggle_favorite(subscription_id, &channel_id).map_err(err)
}

#[tauri::command]
fn list_recents(state: State<AppState>, subscription_id: i64) -> Result<Vec<String>, String> {
    state.db.lock().map_err(err)?.list_recents(subscription_id).map_err(err)
}

#[tauri::command]
fn record_recent(state: State<AppState>, subscription_id: i64, channel_id: String) -> Result<(), String> {
    state.db.lock().map_err(err)?.record_recent(subscription_id, &channel_id).map_err(err)
}

#[tauri::command]
async fn resolve_channel_stream(state: State<'_, AppState>, subscription_id: i64, channel: Channel) -> Result<String, String> {
    let sub = { state.db.lock().map_err(err)?.get_subscription(subscription_id).map_err(err)? };
    let sub = sub.ok_or_else(|| "Subscription not found".to_string())?;
    providers::resolve_channel_stream(&sub, &channel).await.map_err(err)
}

fn subscription_by_id(state: &State<'_, AppState>, id: i64) -> Result<Subscription, String> {
    state.db.lock().map_err(err)?.get_subscription(id).map_err(err)?.ok_or_else(|| "Subscription not found".to_string())
}

#[tauri::command]
async fn load_epg_grid(state: State<'_, AppState>, channels: Vec<EpgChannelKey>, from: i64, to: i64) -> Result<std::collections::HashMap<String, Vec<EpgGridItem>>, String> {
    let settings = state.db.lock().map_err(err)?.get_settings().map_err(err)?;
    providers::load_epg_grid(&settings.epg_url, &channels, from, to, &settings.epg_timezone_mode, settings.epg_time_offset_minutes).await.map_err(err)
}

/// `start` / `stop` are Unix timestamps (seconds) of the programme to replay.
#[tauri::command]
async fn resolve_catchup_stream(channel: Channel, start: i64, stop: i64) -> Result<String, String> {
    let start = chrono::DateTime::from_timestamp(start, 0).ok_or("Invalid start time")?;
    let stop = chrono::DateTime::from_timestamp(stop, 0).ok_or("Invalid stop time")?;
    providers::resolve_catchup_stream(&channel, start, stop).await.map_err(err)
}

#[tauri::command]
async fn vod_categories(state: State<'_, AppState>, subscription_id: i64, kind: String) -> Result<Vec<VodCategory>, String> {
    let sub = subscription_by_id(&state, subscription_id)?;
    providers::vod_categories(&sub, &kind).await.map_err(err)
}

#[tauri::command]
async fn vod_items(state: State<'_, AppState>, subscription_id: i64, kind: String, category_id: String, page: Option<u32>, force: Option<bool>) -> Result<VodPage, String> {
    let sub = subscription_by_id(&state, subscription_id)?;
    providers::vod_items(&sub, &kind, &category_id, page.unwrap_or(1), force.unwrap_or(false)).await.map_err(err)
}

#[tauri::command]
async fn vod_details(state: State<'_, AppState>, subscription_id: i64, item: VodItem) -> Result<VodDetails, String> {
    let sub = subscription_by_id(&state, subscription_id)?;
    providers::vod_details(&sub, &item).await.map_err(err)
}

#[tauri::command]
async fn series_info(state: State<'_, AppState>, subscription_id: i64, item: VodItem) -> Result<SeriesInfo, String> {
    let sub = subscription_by_id(&state, subscription_id)?;
    providers::series_info(&sub, &item).await.map_err(err)
}

#[tauri::command]
async fn resolve_vod_stream(state: State<'_, AppState>, subscription_id: i64, request: VodPlayRequest) -> Result<String, String> {
    let sub = subscription_by_id(&state, subscription_id)?;
    providers::resolve_vod_stream(&sub, &request).await.map_err(err)
}

#[tauri::command]
async fn refresh_subscription_info(state: State<'_, AppState>, id: i64) -> Result<SubscriptionInfo, String> {
    let sub = { state.db.lock().map_err(err)?.get_subscription(id).map_err(err)? };
    let sub = sub.ok_or_else(|| "Subscription not found".to_string())?;
    let info = providers::refresh_info(&sub).await.map_err(err)?;
    state.db.lock().map_err(err)?.update_subscription_info(id, &info).map_err(err)?;
    Ok(info)
}


#[tauri::command]
async fn load_epg_programs(state: State<'_, AppState>, channel: Channel, force: Option<bool>) -> Result<Vec<EpgProgram>, String> {
    let settings = state.db.lock().map_err(err)?.get_settings().map_err(err)?;
    providers::load_epg_programs(&settings.epg_url, &channel, &settings.epg_timezone_mode, settings.epg_time_offset_minutes, force.unwrap_or(false)).await.map_err(err)
}

#[tauri::command]
async fn load_epg_now(state: State<'_, AppState>, channels: Vec<EpgChannelKey>) -> Result<std::collections::HashMap<String, EpgNow>, String> {
    let settings = state.db.lock().map_err(err)?.get_settings().map_err(err)?;
    providers::load_epg_now(&settings.epg_url, &channels, &settings.epg_timezone_mode, settings.epg_time_offset_minutes).await.map_err(err)
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Result<AppSettings, String> {
    state.db.lock().map_err(err)?.get_settings().map_err(err)
}

#[tauri::command]
fn save_settings(state: State<AppState>, settings: AppSettings) -> Result<(), String> {
    state.db.lock().map_err(err)?.save_settings(&settings).map_err(err)
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    open::that(url).map_err(err)
}

#[tauri::command]
fn stop_external_player(state: State<AppState>) -> Result<(), String> {
    stop_external_player_internal(&state)
}

#[tauri::command]
fn shutdown_playback(state: State<AppState>, app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("pip-player") {
        let _ = win.eval("window.__cleanupPip && window.__cleanupPip();");
        let _ = win.destroy();
    }
    cleanup_playback_internal(&state)
}

#[tauri::command]
fn open_external_player(state: State<AppState>, url: String, user_agent: Option<String>, referrer: Option<String>) -> Result<(), String> {
    stop_vlc_bridge_internal(&state)?;
    open_player_process(state, url, false, user_agent, referrer)
}

#[tauri::command]
fn open_detached_external_player(state: State<AppState>, url: String, user_agent: Option<String>, referrer: Option<String>) -> Result<(), String> {
    stop_vlc_bridge_internal(&state)?;
    open_player_process(state, url, true, user_agent, referrer)
}

#[tauri::command]
fn close_pip_window(app: tauri::AppHandle, state: State<AppState>) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("pip-player") {
        let _ = win.eval("window.__cleanupPip && window.__cleanupPip();");
        let _ = win.destroy();
    }
    stop_vlc_bridge_internal(&state)?;
    Ok(())
}

#[tauri::command]
fn open_pip_window(app: tauri::AppHandle, url: String, title: String) -> Result<(), String> {
    let js_url = serde_json::to_string(&url).map_err(err)?;
    let js_title = serde_json::to_string(&title).map_err(err)?;
    if let Some(win) = app.get_webview_window("pip-player") {
        win.eval(&format!("window.__setPipSource && window.__setPipSource({js_url}, {js_title});")).map_err(err)?;
        win.set_focus().map_err(err)?;
        return Ok(());
    }

    let pip_url = format!(
        "pip.html?src={}&title={}",
        urlencoding::encode(&url),
        urlencoding::encode(&title)
    );

    tauri::WebviewWindowBuilder::new(&app, "pip-player", tauri::WebviewUrl::App(pip_url.into()))
        .title(format!("TuxPlayerX - {title}"))
        .inner_size(640.0, 360.0)
        .min_inner_size(320.0, 180.0)
        .resizable(true)
        .always_on_top(true)
        .build()
        .map(|_| ())
        .map_err(err)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data = app.path().app_data_dir().map_err(|e| Box::<dyn std::error::Error>::from(e))?;
            let db_path = app_data.join("tuxplayerx.sqlite3");
            let db = Database::new(db_path).map_err(|e| Box::<dyn std::error::Error>::from(e))?;
            app.manage(AppState { db: Mutex::new(db), external_player: Mutex::new(None), vlc_bridge: Mutex::new(None) });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<AppState>();
                if window.label() == "main" {
                    if let Some(pip) = window.app_handle().get_webview_window("pip-player") {
                        let _ = pip.eval("window.__cleanupPip && window.__cleanupPip();");
                        let _ = pip.destroy();
                    }
                    let _ = cleanup_playback_internal(state.inner());
                    window.app_handle().exit(0);
                } else if window.label() == "pip-player" {
                    let _ = stop_vlc_bridge_internal(state.inner());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            current_platform,
            list_subscriptions,
            save_subscription,
            delete_subscription,
            set_default_subscription,
            get_default_subscription,
            load_channels,
            resolve_channel_stream,
            refresh_subscription_info,
            load_epg_programs,
            load_epg_now,
            load_epg_grid,
            resolve_catchup_stream,
            vod_categories,
            vod_items,
            vod_details,
            series_info,
            resolve_vod_stream,
            export_backup,
            import_backup,
            list_favorites,
            toggle_favorite,
            list_recents,
            record_recent,
            get_settings,
            save_settings,
            open_url,
            start_vlc_bridge,
            prepare_direct_stream,
            stop_vlc_bridge,
            open_external_player,
            open_detached_external_player,
            stop_external_player,
            shutdown_playback,
            open_pip_window,
            close_pip_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running TuxPlayerX");
}

fn main() {
    run();
}
