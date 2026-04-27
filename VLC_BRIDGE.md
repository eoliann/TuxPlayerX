# VLC bridge playback mode

TuxPlayerX 2.0.0 keeps the Tauri/React interface, but adds a local VLC bridge for Windows playback compatibility.

Why this exists:

- Some IPTV streams play correctly in VLC.
- The same streams may fail in Windows WebView with `Failed to load because no supported source was found`.
- The reason is codec/protocol support: WebView is browser-based, while VLC has its own multimedia engine.

How the bridge works:

1. TuxPlayerX resolves the selected channel URL.
2. On Windows, it starts VLC in dummy/background mode.
3. VLC transcodes the stream to a temporary local HLS stream.
4. TuxPlayerX serves the generated HLS files from `127.0.0.1`.
5. The in-app WebView player plays that local HLS URL with `hls.js`.

This keeps playback inside the application instead of opening VLC as a visible external player.

Notes:

- VLC must be installed on Windows.
- The bridge is used for in-app playback on Windows.
- Linux keeps the existing direct embedded WebView playback path.
- `Open in VLC` remains available as an explicit user action.
- Closing the PiP window stops the local bridge.

The approach is inspired by TV-Lite's design choice of using VLC as the real multimedia backend. TV-Lite embeds libVLC into a native wxWidgets panel through native window handles. TuxPlayerX cannot do that directly inside a WebView DOM node, so this bridge is a practical compatibility layer for the Tauri version.
