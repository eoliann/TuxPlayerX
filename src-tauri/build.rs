/// Every app command, so each window gets only the commands its capability lists (security audit S6):
/// the main window uses them all, the detached Picture-in-Picture window only `close_pip_window`.
const COMMANDS: &[&str] = &[
    "app_info",
    "current_platform",
    "list_subscriptions",
    "save_subscription",
    "delete_subscription",
    "set_default_subscription",
    "get_default_subscription",
    "load_channels",
    "resolve_channel_stream",
    "refresh_subscription_info",
    "load_epg_programs",
    "load_epg_now",
    "load_epg_grid",
    "resolve_catchup_stream",
    "vod_categories",
    "vod_items",
    "vod_details",
    "series_info",
    "resolve_vod_stream",
    "export_backup",
    "import_backup",
    "list_favorites",
    "toggle_favorite",
    "list_recents",
    "record_recent",
    "get_settings",
    "save_settings",
    "open_url",
    "reveal_backup",
    "start_vlc_bridge",
    "prepare_direct_stream",
    "import_playlist_file",
    "stop_vlc_bridge",
    "open_external_player",
    "open_detached_external_player",
    "stop_external_player",
    "shutdown_playback",
    "open_pip_window",
    "close_pip_window",
];

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("failed to run tauri-build");
}
