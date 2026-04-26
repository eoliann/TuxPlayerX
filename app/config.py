from __future__ import annotations

import os
import platform
import sys
from pathlib import Path

from app.version import APP_SLUG


def get_data_dir() -> Path:
    system = platform.system().lower()
    if system == "windows":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        path = Path(base) / APP_SLUG
    elif system == "darwin":
        path = Path.home() / "Library" / "Application Support" / APP_SLUG
    else:
        base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
        path = Path(base) / APP_SLUG

    path.mkdir(parents=True, exist_ok=True)
    return path


def get_config_dir() -> Path:
    system = platform.system().lower()
    if system == "windows":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        path = Path(base) / APP_SLUG
    elif system == "darwin":
        path = Path.home() / "Library" / "Preferences" / APP_SLUG
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
        path = Path(base) / APP_SLUG

    path.mkdir(parents=True, exist_ok=True)
    return path


DATA_DIR = get_data_dir()
CONFIG_DIR = get_config_dir()
DATABASE_PATH = DATA_DIR / "tuxplayerx.sqlite3"
LOG_PATH = DATA_DIR / "tuxplayerx.log"


def resource_path(relative_path: str) -> Path:
    """Return a resource path that works in development and PyInstaller builds."""
    if hasattr(sys, "_MEIPASS"):
        return Path(getattr(sys, "_MEIPASS")) / relative_path
    return Path(__file__).resolve().parent.parent / relative_path


def app_icon_path() -> Path:
    return resource_path("app/assets/icon.png")
