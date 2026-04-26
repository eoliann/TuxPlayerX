from __future__ import annotations

import os
import platform
import shutil
from pathlib import Path


def is_vlc_available() -> bool:
    try:
        import vlc  # type: ignore

        instance = vlc.Instance()
        return instance is not None
    except Exception:
        return False


def find_vlc_binary() -> str | None:
    system = platform.system().lower()

    if system == "linux":
        return shutil.which("vlc")

    if system == "windows":
        candidates = [
            Path(os.environ.get("PROGRAMFILES", "")) / "VideoLAN" / "VLC" / "vlc.exe",
            Path(os.environ.get("PROGRAMFILES(X86)", "")) / "VideoLAN" / "VLC" / "vlc.exe",
        ]
        for candidate in candidates:
            if candidate.exists():
                return str(candidate)

    return None


def get_vlc_status_message() -> str:
    if is_vlc_available():
        return "VLC/libVLC is available."

    system = platform.system().lower()
    if system == "windows":
        return (
            "VLC/libVLC was not found. Install VLC Media Player from the official VideoLAN website "
            "or run: winget install VideoLAN.VLC"
        )

    if system == "linux":
        return "VLC/libVLC was not found. On Debian/Ubuntu, run: sudo apt install vlc libvlc5"

    return "VLC/libVLC was not found. Install VLC Media Player for your operating system."
