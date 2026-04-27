# Native VLC/libVLC playback plan

The current Tauri UI uses WebView video playback for the embedded player. This works for browser-compatible HLS streams, but many IPTV streams that VLC can play are not supported by WebView on Windows.

A true embedded VLC engine requires a native rendering target:

- Windows: libVLC needs a Win32 `HWND` for `set_hwnd`.
- Linux/X11: libVLC needs an X11 window id for `set_xwindow`.

Tauri WebView content does not expose a simple native video surface handle for React components. Because of that, the correct next stage is to add a native playback surface/window managed by Rust and libVLC, while keeping the React/Tailwind UI as the shell.

Current status in this package:

- PiP close handling has been hardened with `getCurrentWindow().destroy()` from the Tauri window API.
- The existing WebView player remains unchanged for Linux/browser-compatible streams.
- VLC external playback remains available as fallback.
- Native embedded libVLC is planned as the next implementation stage, not claimed as complete in this package.
