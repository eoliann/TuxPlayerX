from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urljoin, urlparse

import requests

from app.providers.m3u_provider import Channel


@dataclass(slots=True)
class MacPortalInfo:
    status: str = "Unknown"
    expires_at: str | None = None
    active_connections: int | None = None
    max_connections: int | None = None
    message: str = "MAC portal info loaded with the generic authorized-portal adapter."


class MacProviderError(RuntimeError):
    pass


class MacProvider:
    """
    Generic adapter for authorized Stalker/Ministra-style MAC portals.

    Use this only with services for which the user has explicit access rights.
    It does not bypass DRM, payment checks, provider restrictions, or account limits.
    Some providers customize their API, so they may still require a dedicated adapter.
    """

    USER_AGENT = (
        "Mozilla/5.0 (QtEmbedded; U; Linux; en-US) "
        "AppleWebKit/533.3 (KHTML, like Gecko) MAG254 stbapp ver: 4 rev: 2721 Mobile Safari/533.3"
    )

    def __init__(self, portal_url: str, mac_address: str, timeout: int = 20) -> None:
        self.portal_url = portal_url.strip().rstrip("/")
        self.mac_address = self._normalize_mac(mac_address)
        self.timeout = timeout
        self.session = requests.Session()
        self.token: str | None = None
        self.api_url: str | None = None
        self.session.headers.update(
            {
                "User-Agent": self.USER_AGENT,
                "Accept": "*/*",
                "Connection": "Keep-Alive",
                "X-User-Agent": "Model: MAG254; Link: Ethernet",
            }
        )
        self.session.cookies.set("mac", self.mac_address)
        self.session.cookies.set("stb_lang", "en")
        self.session.cookies.set("timezone", "Europe/Bucharest")

    @staticmethod
    def _normalize_mac(mac_address: str) -> str:
        mac = mac_address.strip().upper().replace("-", ":")
        if not re.fullmatch(r"[0-9A-F]{2}(:[0-9A-F]{2}){5}", mac):
            raise MacProviderError("Invalid MAC address format. Expected format: 00:1A:79:XX:XX:XX")
        return mac

    def _candidate_api_urls(self) -> list[str]:
        if not self.portal_url:
            raise MacProviderError("Portal URL is required.")

        parsed = urlparse(self.portal_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise MacProviderError("Portal URL must start with http:// or https://")

        base = f"{parsed.scheme}://{parsed.netloc}"
        path = parsed.path.rstrip("/")
        candidates: list[str] = []

        if path.endswith("/server/load.php"):
            candidates.append(f"{base}{path}")
        elif path.endswith("/c"):
            parent = path[: -len("/c")]
            candidates.append(f"{base}{parent}/server/load.php")
        elif "stalker_portal" in path:
            stalker_root = path.split("stalker_portal", 1)[0] + "stalker_portal"
            candidates.append(f"{base}{stalker_root}/server/load.php")
        elif path:
            candidates.append(f"{base}{path}/server/load.php")
            candidates.append(f"{base}{path}/stalker_portal/server/load.php")
        else:
            candidates.append(f"{base}/stalker_portal/server/load.php")
            candidates.append(f"{base}/server/load.php")

        seen: set[str] = set()
        unique: list[str] = []
        for candidate in candidates:
            if candidate not in seen:
                unique.append(candidate)
                seen.add(candidate)
        return unique

    def _request(self, params: dict[str, Any], require_token: bool = True) -> dict[str, Any]:
        if require_token and not self.token:
            self.handshake()

        headers: dict[str, str] = {}
        if require_token and self.token:
            headers["Authorization"] = f"Bearer {self.token}"

        api_url = self.api_url
        if not api_url:
            self.handshake()
            api_url = self.api_url
        if not api_url:
            raise MacProviderError("Could not determine portal API endpoint.")

        request_params = dict(params)
        request_params.setdefault("JsHttpRequest", "1-xml")

        try:
            response = self.session.get(api_url, params=request_params, headers=headers, timeout=self.timeout)
            response.raise_for_status()
        except requests.RequestException as exc:
            raise MacProviderError(f"Portal request failed: {exc}") from exc

        try:
            payload = response.json()
        except json.JSONDecodeError as exc:
            raise MacProviderError("Portal returned a non-JSON response. Check the portal URL.") from exc

        if not isinstance(payload, dict):
            raise MacProviderError("Portal returned an invalid response.")
        return payload

    @staticmethod
    def _js(payload: dict[str, Any]) -> dict[str, Any]:
        js = payload.get("js")
        if isinstance(js, dict):
            return js
        if isinstance(payload.get("data"), dict):
            return payload["data"]
        return payload

    def handshake(self) -> str:
        last_error: str | None = None
        for api_url in self._candidate_api_urls():
            self.api_url = api_url
            try:
                response = self.session.get(
                    api_url,
                    params={"type": "stb", "action": "handshake", "token": "", "JsHttpRequest": "1-xml"},
                    timeout=self.timeout,
                )
                response.raise_for_status()
                payload = response.json()
                js = self._js(payload)
                token = js.get("token") or js.get("access_token")
                if token:
                    self.token = str(token)
                    return self.token
                last_error = "handshake response did not contain a token"
            except Exception as exc:  # Try the next candidate endpoint.
                last_error = str(exc)
                continue

        self.api_url = None
        raise MacProviderError(
            "Could not authenticate with the MAC portal. "
            f"Last error: {last_error or 'unknown error'}"
        )

    def _device_id(self) -> str:
        return hashlib.sha256(self.mac_address.encode("utf-8")).hexdigest().upper()

    def _get_profile(self) -> dict[str, Any]:
        device_id = self._device_id()
        params = {
            "type": "stb",
            "action": "get_profile",
            "hd": "1",
            "ver": "ImageDescription: 0.2.18-r23-254; ImageDate: Wed Mar 18 18:09:40 EET 2015; PORTAL version: 5.6.6; API Version: JS API version: 328; STB API version: 134; Player Engine version: 0x566",
            "num_banks": "2",
            "sn": device_id[:13],
            "stb_type": "MAG254",
            "image_version": "218",
            "video_out": "hdmi",
            "device_id": device_id,
            "device_id2": device_id,
            "signature": hashlib.sha256((self.mac_address + device_id).encode("utf-8")).hexdigest().upper(),
            "auth_second_step": "1",
            "hw_version": "1.7-BD-00",
            "not_valid_token": "0",
        }
        payload = self._request(params)
        return self._js(payload)

    def _get_genres(self) -> dict[str, str]:
        try:
            payload = self._request({"type": "itv", "action": "get_genres"})
            js = self._js(payload)
            data = js.get("data", js)
            genres: dict[str, str] = {}
            if isinstance(data, list):
                for item in data:
                    if not isinstance(item, dict):
                        continue
                    genre_id = item.get("id") or item.get("number")
                    title = item.get("title") or item.get("name")
                    if genre_id is not None and title:
                        genres[str(genre_id)] = str(title)
            return genres
        except MacProviderError:
            return {}

    @staticmethod
    def _clean_stream_url(value: Any) -> str:
        text = str(value or "").strip()
        if text.startswith("ffmpeg "):
            text = text[len("ffmpeg ") :].strip()
        if text.startswith("auto "):
            text = text[len("auto ") :].strip()
        return text


    @staticmethod
    def _iter_dicts(value: Any):
        if isinstance(value, dict):
            yield value
            for child in value.values():
                yield from MacProvider._iter_dicts(child)
        elif isinstance(value, list):
            for child in value:
                yield from MacProvider._iter_dicts(child)

    @staticmethod
    def _first_value(payload: Any, keys: tuple[str, ...]) -> Any:
        lowered = {key.lower() for key in keys}
        for item in MacProvider._iter_dicts(payload):
            for key, value in item.items():
                if str(key).lower() in lowered and value not in (None, ""):
                    return value
        return None

    @staticmethod
    def _to_int(value: Any) -> int | None:
        if value is None:
            return None
        try:
            text = str(value).strip()
            if not text or text.lower() in {"null", "none", "unknown", "unlimited"}:
                return None
            return int(float(text))
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _format_text(value: Any) -> str | None:
        if value is None:
            return None
        text = str(value).strip()
        if not text or text.lower() in {"null", "none", "unknown"}:
            return None
        if text in {"0", "-1"}:
            return "Unlimited"
        return text

    def get_info(self) -> MacPortalInfo:
        self.handshake()
        profile: dict[str, Any] = {}
        try:
            profile = self._get_profile()
        except MacProviderError:
            # Some portals allow account_info without a full profile call.
            pass

        info = MacPortalInfo(status="Active", message="Authorized MAC portal responded successfully.")
        payloads: list[Any] = [profile]

        for action in ("get_main_info", "get_account_info"):
            try:
                payload = self._request({"type": "account_info", "action": action})
                payloads.append(self._js(payload))
            except MacProviderError:
                continue

        status = self._first_value(payloads, ("status", "account_status", "state"))
        expires = self._first_value(
            payloads,
            (
                "end_date",
                "expire_billing_date",
                "expires",
                "exp_date",
                "expiration",
                "expire_date",
                "account_expire",
                "login_expire",
                "tariff_plan_until",
            ),
        )
        active_connections = self._first_value(
            payloads,
            ("active_cons", "active_connections", "online", "online_count", "now_online", "current_connections"),
        )
        max_connections = self._first_value(
            payloads,
            ("max_online", "max_connections", "max_cons", "allowed_cons", "allowed_connections", "total_connections"),
        )

        if status is not None:
            info.status = str(status)
        info.expires_at = self._format_text(expires)
        info.active_connections = self._to_int(active_connections)
        info.max_connections = self._to_int(max_connections)

        if info.expires_at or info.active_connections is not None or info.max_connections is not None:
            info.message = "MAC account info loaded from the authorized portal response."
        else:
            info.message = "Portal responded, but it did not expose expiration or connection counters in a recognized field."
        return info

    def load_channels(self) -> list[Channel]:
        self.handshake()
        try:
            self._get_profile()
        except MacProviderError:
            # Some portals do not require get_profile before channel listing.
            pass

        genres = self._get_genres()
        payload = self._request({"type": "itv", "action": "get_all_channels", "force_ch_link_check": ""})
        js = self._js(payload)
        data = js.get("data", js)
        if not isinstance(data, list):
            raise MacProviderError("Portal did not return a channel list.")

        channels: list[Channel] = []
        for item in data:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or item.get("title") or "Unnamed channel").strip()
            raw_cmd = str(item.get("cmd") or item.get("url") or "").strip()
            if not raw_cmd:
                continue
            group_id = item.get("tv_genre_id") or item.get("genre_id") or item.get("category_id")
            group = genres.get(str(group_id), "Live TV") if group_id is not None else "Live TV"
            url = self._clean_stream_url(raw_cmd)
            channels.append(
                Channel(
                    name=name,
                    url=url,
                    group=group,
                    logo=item.get("logo") or item.get("icon"),
                    tvg_id=str(item.get("id")) if item.get("id") is not None else None,
                    raw_cmd=raw_cmd,
                )
            )

        if not channels:
            raise MacProviderError("No channels were found in this MAC subscription.")
        return channels

    def create_link(self, raw_cmd: str) -> str:
        if not raw_cmd:
            raise MacProviderError("Selected MAC channel has no stream command.")
        payload = self._request(
            {
                "type": "itv",
                "action": "create_link",
                "cmd": raw_cmd,
                "series": "0",
                "forced_storage": "0",
                "disable_ad": "0",
            }
        )
        js = self._js(payload)
        cmd = js.get("cmd") or js.get("url") or js.get("link")
        stream_url = self._clean_stream_url(cmd)
        if not stream_url.startswith(("http://", "https://", "rtmp://", "rtsp://")):
            raise MacProviderError("Portal did not return a playable stream URL for this channel.")
        return stream_url
