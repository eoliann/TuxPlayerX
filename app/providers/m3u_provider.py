from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

import requests


@dataclass(slots=True)
class Channel:
    name: str
    url: str
    group: str = "Uncategorized"
    logo: str | None = None
    tvg_id: str | None = None
    raw_cmd: str | None = None


@dataclass(slots=True)
class M3USubscriptionInfo:
    status: str = "Unknown"
    expires_at: str | None = None
    active_connections: int | None = None
    max_connections: int | None = None
    message: str = "M3U subscription info loaded."


class M3UError(RuntimeError):
    pass


class M3UInfoError(RuntimeError):
    pass


def _extract_attr(line: str, attr: str) -> str | None:
    token = f'{attr}="'
    start = line.find(token)
    if start < 0:
        return None
    start += len(token)
    end = line.find('"', start)
    if end < 0:
        return None
    value = line[start:end].strip()
    return value or None


def _extract_name(line: str) -> str:
    if "," in line:
        name = line.rsplit(",", 1)[-1].strip()
        if name:
            return name
    return "Unnamed channel"


def _to_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        text = str(value).strip()
        if not text or text.lower() in {"null", "none", "unlimited", "unknown"}:
            return None
        return int(float(text))
    except (TypeError, ValueError):
        return None


def _format_expiration(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() in {"null", "none", "unknown"}:
        return None
    if text in {"0", "-1"}:
        return "Unlimited"
    if text.isdigit():
        try:
            timestamp = int(text)
            if timestamp <= 0:
                return "Unlimited"
            return datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d %H:%M")
        except (OSError, OverflowError, ValueError):
            return text
    return text


def parse_m3u(content: str) -> list[Channel]:
    channels: list[Channel] = []
    pending: dict[str, str | None] | None = None

    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        if line.startswith("#EXTINF"):
            pending = {
                "name": _extract_name(line),
                "group": _extract_attr(line, "group-title") or "Uncategorized",
                "logo": _extract_attr(line, "tvg-logo"),
                "tvg_id": _extract_attr(line, "tvg-id"),
            }
            continue

        if line.startswith("#"):
            continue

        if pending:
            channels.append(
                Channel(
                    name=str(pending.get("name") or "Unnamed channel"),
                    url=line,
                    group=str(pending.get("group") or "Uncategorized"),
                    logo=pending.get("logo"),
                    tvg_id=pending.get("tvg_id"),
                )
            )
            pending = None
        else:
            channels.append(Channel(name=line, url=line))

    return channels


def load_m3u(source: str, timeout: int = 20) -> list[Channel]:
    source = source.strip()
    if not source:
        raise M3UError("M3U source is empty.")

    parsed = urlparse(source)
    if parsed.scheme in {"http", "https"}:
        try:
            response = requests.get(source, timeout=timeout, headers={"User-Agent": "TuxPlayerX/0.1"})
            response.raise_for_status()
        except requests.RequestException as exc:
            raise M3UError(f"Could not download M3U playlist: {exc}") from exc
        content = response.text
    else:
        path = Path(source).expanduser()
        if not path.exists():
            raise M3UError(f"M3U file was not found: {path}")
        content = path.read_text(encoding="utf-8", errors="replace")

    channels = parse_m3u(content)
    if not channels:
        raise M3UError("No channels were found in this M3U playlist.")
    return channels


def _extract_xtream_credentials(source: str, username: str | None = None, password: str | None = None) -> tuple[str, str, str] | None:
    parsed = urlparse(source.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None

    query = parse_qs(parsed.query)
    user = (username or "").strip() or (query.get("username", [""])[0] or "").strip()
    pwd = (password or "").strip() or (query.get("password", [""])[0] or "").strip()
    if not user or not pwd:
        return None

    api_url = urlunparse((parsed.scheme, parsed.netloc, "/player_api.php", "", urlencode({"username": user, "password": pwd}), ""))
    return api_url, user, pwd


def get_m3u_subscription_info(
    source: str,
    username: str | None = None,
    password: str | None = None,
    timeout: int = 20,
) -> M3USubscriptionInfo:
    credentials = _extract_xtream_credentials(source, username, password)
    if not credentials:
        raise M3UInfoError(
            "This M3U source does not expose Xtream Codes credentials in the URL and no username/password was saved."
        )

    api_url, _user, _pwd = credentials
    try:
        response = requests.get(api_url, timeout=timeout, headers={"User-Agent": "TuxPlayerX/0.1"})
        response.raise_for_status()
        payload = response.json()
    except requests.RequestException as exc:
        raise M3UInfoError(f"Could not load M3U subscription info: {exc}") from exc
    except ValueError as exc:
        raise M3UInfoError("The M3U provider did not return valid JSON from player_api.php.") from exc

    if not isinstance(payload, dict):
        raise M3UInfoError("The M3U provider returned an invalid info response.")

    user_info = payload.get("user_info")
    if not isinstance(user_info, dict):
        raise M3UInfoError("The M3U provider response does not include user_info.")

    return M3USubscriptionInfo(
        status=str(user_info.get("status") or "Unknown"),
        expires_at=_format_expiration(
            user_info.get("exp_date")
            or user_info.get("expires")
            or user_info.get("expiration")
            or user_info.get("expire_date")
        ),
        active_connections=_to_int(user_info.get("active_cons") or user_info.get("active_connections")),
        max_connections=_to_int(user_info.get("max_connections") or user_info.get("max_cons")),
        message="M3U account info loaded through the provider player_api.php endpoint.",
    )
