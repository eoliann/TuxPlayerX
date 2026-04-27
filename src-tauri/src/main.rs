#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

mod db;
mod models;
mod providers;

use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Manager, State};
use db::Database;
use models::{AppInfo, AppSettings, Channel, Subscription, SubscriptionInfo};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

struct VlcBridge {
    child: Child,
    stop_flag: Arc<AtomicBool>,
    work_dir: PathBuf,
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

fn start_static_hls_server(listener: TcpListener, root: PathBuf, stop_flag: Arc<AtomicBool>) {
    let _ = listener.set_nonblocking(true);
    thread::spawn(move || {
        while !stop_flag.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut stream, _addr)) => {
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

                    let file_path = root.join(&path);
                    match fs::read(&file_path) {
                        Ok(bytes) => {
                            let headers = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-cache, no-store, must-revalidate\r\nPragma: no-cache\r\nConnection: close\r\n\r\n",
                                content_type_for(&path),
                                bytes.len()
                            );
                            let _ = stream.write_all(headers.as_bytes());
                            let _ = stream.write_all(&bytes);
                        }
                        Err(_) => {
                            let body = b"Not ready";
                            let headers = format!(
                                "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
                                body.len()
                            );
                            let _ = stream.write_all(headers.as_bytes());
                            let _ = stream.write_all(body);
                        }
                    }
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

fn open_player_process(state: State<AppState>, url: String, detached: bool) -> Result<(), String> {
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

    cmd.arg(url);

    let child = cmd
        .spawn()
        .map_err(|e| format!("Could not start external player '{label}'. Install VLC or set the full path in Settings. Details: {e}"))?;
    *external_player = Some(child);
    Ok(())
}


#[tauri::command]
fn stop_vlc_bridge(state: State<AppState>) -> Result<(), String> {
    stop_vlc_bridge_internal(&state)
}

#[tauri::command]
fn start_vlc_bridge(state: State<AppState>, url: String) -> Result<String, String> {
    stop_vlc_bridge_internal(&state)?;

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

    let sout = format!(
        "#transcode{{vcodec=h264,vb=1800,acodec=mp4a,ab=128,channels=2,samplerate=44100,scodec=none}}:std{{access=livehttp{{seglen=4,delsegs=true,numsegs=6,index={index},index-url={index_url}}},mux=ts{{use-key-frames}},dst={segment}}}"
    );

    cmd.arg("-I")
        .arg("dummy")
        .arg("--quiet")
        .arg("--no-video-title-show")
        .arg("--http-reconnect")
        .arg(format!("--network-caching={}", settings.network_cache_ms))
        .arg(url)
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
        *bridge = Some(VlcBridge { child, stop_flag, work_dir });
    }

    for _ in 0..120 {
        if index_path.exists() && fs::metadata(&index_path).map(|m| m.len() > 0).unwrap_or(false) {
            return Ok(playback_url);
        }

        {
            let mut bridge = state.vlc_bridge.lock().map_err(err)?;
            if let Some(running) = bridge.as_mut() {
                if let Ok(Some(status)) = running.child.try_wait() {
                    let _ = fs::remove_dir_all(&running.work_dir);
                    *bridge = None;
                    return Err(format!("VLC bridge stopped before producing a playable stream. Exit status: {status}"));
                }
            }
        }

        thread::sleep(Duration::from_millis(100));
    }

    Ok(playback_url)
}

#[tauri::command]
fn list_subscriptions(state: State<AppState>) -> Result<Vec<Subscription>, String> {
    state.db.lock().map_err(err)?.list_subscriptions().map_err(err)
}

#[tauri::command]
fn save_subscription(state: State<AppState>, subscription: Subscription) -> Result<i64, String> {
    state.db.lock().map_err(err)?.save_subscription(&subscription).map_err(err)
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
async fn load_channels(state: State<'_, AppState>, id: i64) -> Result<Vec<Channel>, String> {
    let sub = { state.db.lock().map_err(err)?.get_subscription(id).map_err(err)? };
    let sub = sub.ok_or_else(|| "Subscription not found".to_string())?;
    providers::load_channels(&sub).await.map_err(err)
}

#[tauri::command]
async fn resolve_channel_stream(state: State<'_, AppState>, subscription_id: i64, channel: Channel) -> Result<String, String> {
    let sub = { state.db.lock().map_err(err)?.get_subscription(subscription_id).map_err(err)? };
    let sub = sub.ok_or_else(|| "Subscription not found".to_string())?;
    providers::resolve_channel_stream(&sub, &channel).await.map_err(err)
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
fn open_external_player(state: State<AppState>, url: String) -> Result<(), String> {
    stop_vlc_bridge_internal(&state)?;
    open_player_process(state, url, false)
}

#[tauri::command]
fn open_detached_external_player(state: State<AppState>, url: String) -> Result<(), String> {
    stop_vlc_bridge_internal(&state)?;
    open_player_process(state, url, true)
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
            get_settings,
            save_settings,
            open_url,
            start_vlc_bridge,
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
