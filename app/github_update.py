from __future__ import annotations

from dataclasses import dataclass

import requests
from packaging.version import InvalidVersion, Version

from app.version import APP_VERSION, GITHUB_REPO


@dataclass(slots=True)
class UpdateResult:
    ok: bool
    current_version: str
    latest_version: str | None = None
    update_available: bool = False
    release_url: str | None = None
    message: str = ""


def normalize_tag(tag: str) -> str:
    return tag.strip().lstrip("vV")


def check_for_updates(timeout: int = 10) -> UpdateResult:
    if not GITHUB_REPO or "/" not in GITHUB_REPO:
        return UpdateResult(
            ok=False,
            current_version=APP_VERSION,
            message="GitHub repository is not configured yet in app/version.py.",
        )

    api_url = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
    try:
        response = requests.get(api_url, timeout=timeout, headers={"User-Agent": "TuxPlayerXUpdateCheck"})
        response.raise_for_status()
        data = response.json()
    except requests.RequestException as exc:
        return UpdateResult(ok=False, current_version=APP_VERSION, message=f"Update check failed: {exc}")

    latest_tag = str(data.get("tag_name") or "")
    html_url = data.get("html_url")
    if not latest_tag:
        return UpdateResult(ok=False, current_version=APP_VERSION, message="Latest release has no tag_name.")

    try:
        latest_version = Version(normalize_tag(latest_tag))
        current_version = Version(normalize_tag(APP_VERSION))
    except InvalidVersion:
        return UpdateResult(
            ok=False,
            current_version=APP_VERSION,
            latest_version=latest_tag,
            release_url=html_url,
            message="Could not compare version numbers.",
        )

    update_available = latest_version > current_version
    return UpdateResult(
        ok=True,
        current_version=APP_VERSION,
        latest_version=str(latest_version),
        update_available=update_available,
        release_url=html_url,
        message="Update available." if update_available else "You are using the latest version.",
    )
