from __future__ import annotations

import platform
from typing import Any

from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtGui import QKeyEvent, QMouseEvent
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QPushButton,
    QSlider,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from app.database import Database, Subscription
from app.providers.m3u_provider import Channel, M3UError, M3UInfoError, get_m3u_subscription_info, load_m3u
from app.providers.mac_provider import MacProvider, MacProviderError
from app.vlc_check import get_vlc_status_message, is_vlc_available

try:
    import vlc  # type: ignore
except Exception:  # pragma: no cover - depends on host system
    vlc = None  # type: ignore


class VideoFrame(QFrame):
    double_clicked = Signal()

    def mouseDoubleClickEvent(self, event: QMouseEvent) -> None:  # type: ignore[override]
        self.double_clicked.emit()
        event.accept()


class FullscreenVideoWindow(QWidget):
    exit_requested = Signal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("Fullscreen video")
        self.setWindowFlags(Qt.WindowType.Window | Qt.WindowType.FramelessWindowHint)
        self.setStyleSheet("background: #000000;")
        self.layout = QVBoxLayout(self)
        self.layout.setContentsMargins(0, 0, 0, 0)
        self.layout.setSpacing(0)

    def keyPressEvent(self, event: QKeyEvent) -> None:  # type: ignore[override]
        if event.key() == Qt.Key.Key_Escape:
            self.exit_requested.emit()
            return
        super().keyPressEvent(event)

    def mouseDoubleClickEvent(self, event: QMouseEvent) -> None:  # type: ignore[override]
        self.exit_requested.emit()
        event.accept()


class PlayerWidget(QWidget):
    status_changed = Signal(str)

    def __init__(self, db: Database, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.db = db
        self.channels: list[Channel] = []
        self.filtered_channels: list[Channel] = []
        self.current_subscription: Subscription | None = None
        self.current_channel: Channel | None = None
        self.instance: Any | None = None
        self.player: Any | None = None
        self._video_fullscreen_window: FullscreenVideoWindow | None = None
        self._manual_stop = True
        self._last_playback_time = -1
        self._stall_ticks = 0
        self._restart_attempts = 0
        self._build_ui()
        self._init_vlc()

        self.watchdog_timer = QTimer(self)
        self.watchdog_timer.setInterval(5000)
        self.watchdog_timer.timeout.connect(self._watch_playback_health)
        self.watchdog_timer.start()

    def _build_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(12)

        top_bar = QHBoxLayout()
        self.load_default_btn = QPushButton("Load default subscription")
        self.load_default_btn.setProperty("success", True)
        self.load_default_btn.clicked.connect(self.load_default_subscription)
        self.stop_btn = QPushButton("Stop")
        self.stop_btn.clicked.connect(self.stop)
        self.fullscreen_btn = QPushButton("Video fullscreen")
        self.fullscreen_btn.clicked.connect(self.toggle_fullscreen)
        top_bar.addWidget(self.load_default_btn)
        top_bar.addWidget(self.stop_btn)
        top_bar.addWidget(self.fullscreen_btn)
        top_bar.addStretch(1)
        layout.addLayout(top_bar)

        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QFrame()
        left.setProperty("card", True)
        left.setMinimumWidth(340)
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(12, 12, 12, 12)
        left_layout.setSpacing(8)
        self.search = QLineEdit()
        self.search.setPlaceholderText("Search channels...")
        self.search.textChanged.connect(self.apply_filter)
        self.channel_list = QListWidget()
        self.channel_list.itemDoubleClicked.connect(self.play_selected_item)
        left_layout.addWidget(QLabel("Channels"))
        left_layout.addWidget(self.search)
        left_layout.addWidget(self.channel_list)

        right = QFrame()
        right.setProperty("card", True)
        self.right_layout = QVBoxLayout(right)
        self.right_layout.setContentsMargins(12, 12, 12, 12)
        self.right_layout.setSpacing(8)
        self.video_frame = VideoFrame()
        self.video_frame.setMinimumSize(640, 360)
        self.video_frame.setStyleSheet("background: #000000; border-radius: 8px;")
        self.video_frame.double_clicked.connect(self.toggle_fullscreen)
        self.now_playing = QLabel("No channel playing.")
        self.now_playing.setProperty("muted", True)

        controls = QHBoxLayout()
        self.play_btn = QPushButton("Play selected")
        self.play_btn.clicked.connect(self.play_selected_item)
        self.pause_btn = QPushButton("Pause/Resume")
        self.pause_btn.clicked.connect(self.pause_resume)
        self.volume = QSlider(Qt.Orientation.Horizontal)
        self.volume.setRange(0, 100)
        self.volume.setValue(80)
        self.volume.valueChanged.connect(self.set_volume)
        controls.addWidget(self.play_btn)
        controls.addWidget(self.pause_btn)
        controls.addWidget(QLabel("Volume"))
        controls.addWidget(self.volume)

        self.right_layout.addWidget(self.video_frame, 1)
        self.right_layout.addWidget(self.now_playing)
        self.right_layout.addLayout(controls)

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([380, 840])
        layout.addWidget(splitter, 1)

    def _init_vlc(self) -> None:
        if vlc is None or not is_vlc_available():
            self.set_status(get_vlc_status_message())
            return
        try:
            cache_ms = self.db.get_setting("network_cache_ms", "3000")
            self.instance = vlc.Instance(f"--network-caching={cache_ms}")
            self.player = self.instance.media_player_new()
            self.player.audio_set_volume(self.volume.value())
            self._bind_video_output()
            self.set_status("VLC/libVLC is ready.")
        except Exception as exc:
            self.set_status(f"Could not initialize VLC/libVLC: {exc}")

    def _bind_video_output(self) -> None:
        if not self.player:
            return
        win_id = int(self.video_frame.winId())
        system = platform.system().lower()
        if system == "linux":
            self.player.set_xwindow(win_id)
        elif system == "windows":
            self.player.set_hwnd(win_id)
        elif system == "darwin":
            self.player.set_nsobject(win_id)

    def set_status(self, message: str) -> None:
        self.status_changed.emit(message)

    def refresh_from_database(self) -> None:
        self.current_subscription = self.db.get_default_subscription()

    def load_default_subscription_on_startup(self) -> None:
        subscription = self.db.get_default_subscription()
        if not subscription:
            self.set_status("No default subscription configured.")
            return
        self.load_subscription(subscription, autoplay_first=False)

    def load_default_subscription(self) -> None:
        subscription = self.db.get_default_subscription()
        if not subscription:
            QMessageBox.information(self, "No default subscription", "Add a subscription and mark it as default first.")
            return
        self.load_subscription(subscription, autoplay_first=False)

    def load_subscription(self, subscription: Subscription, autoplay_first: bool = False) -> None:
        self.current_subscription = subscription
        self.channel_list.clear()
        self.channels = []
        self.filtered_channels = []
        self.set_status(f"Loading {subscription.name}...")

        if subscription.type == "m3u":
            if not subscription.url:
                QMessageBox.warning(self, "Invalid subscription", "This M3U subscription has no URL/file path.")
                self.set_status("Invalid M3U subscription.")
                return
            try:
                self.channels = load_m3u(subscription.url)
            except M3UError as exc:
                QMessageBox.warning(self, "M3U error", str(exc))
                self.set_status("Could not load M3U playlist.")
                return
            self._try_update_loaded_subscription_info(subscription)
            self.apply_filter()
            self.set_status(f"Loaded {len(self.channels)} channels from {subscription.name}.")
            if autoplay_first and self.filtered_channels:
                self.channel_list.setCurrentRow(0)
                self.play_channel(self.filtered_channels[0])
            return

        if subscription.type == "mac":
            try:
                provider = MacProvider(subscription.portal_url or "", subscription.mac_address or "")
                self.channels = provider.load_channels()
                self._try_update_loaded_subscription_info(subscription, provider)
            except MacProviderError as exc:
                QMessageBox.warning(self, "MAC portal error", str(exc))
                self.set_status("Could not load MAC subscription.")
                return
            self.apply_filter()
            self.set_status(f"Loaded {len(self.channels)} channels from {subscription.name}.")
            if autoplay_first and self.filtered_channels:
                self.channel_list.setCurrentRow(0)
                self.play_channel(self.filtered_channels[0])
            return

    def _save_subscription_info(
        self,
        subscription: Subscription,
        expires_at: str | None,
        active_connections: int | None,
        max_connections: int | None,
    ) -> None:
        if not subscription.id:
            return
        self.db.update_subscription_info(
            subscription.id,
            expires_at=expires_at,
            active_connections=active_connections,
            max_connections=max_connections,
        )

    def _try_update_loaded_subscription_info(self, subscription: Subscription, provider: MacProvider | None = None) -> None:
        try:
            if subscription.type == "m3u" and subscription.url:
                info = get_m3u_subscription_info(subscription.url, subscription.username, subscription.password)
                self._save_subscription_info(
                    subscription,
                    info.expires_at,
                    info.active_connections,
                    info.max_connections,
                )
            elif subscription.type == "mac":
                mac_provider = provider or MacProvider(subscription.portal_url or "", subscription.mac_address or "")
                info = mac_provider.get_info()
                self._save_subscription_info(
                    subscription,
                    info.expires_at,
                    info.active_connections,
                    info.max_connections,
                )
        except (M3UInfoError, MacProviderError):
            # Channel loading should not fail just because account metadata is unavailable.
            return

    def apply_filter(self) -> None:
        text = self.search.text().strip().lower()
        if text:
            self.filtered_channels = [
                channel for channel in self.channels
                if text in channel.name.lower() or text in channel.group.lower()
            ]
        else:
            self.filtered_channels = list(self.channels)

        self.channel_list.clear()
        for channel in self.filtered_channels:
            item = QListWidgetItem(f"{channel.name}  ·  {channel.group}")
            item.setData(Qt.ItemDataRole.UserRole, channel)
            self.channel_list.addItem(item)

    def play_selected_item(self) -> None:
        item = self.channel_list.currentItem()
        if not item:
            QMessageBox.information(self, "No channel selected", "Select a channel first.")
            return
        channel = item.data(Qt.ItemDataRole.UserRole)
        if isinstance(channel, Channel):
            self.play_channel(channel)

    def play_channel(self, channel: Channel, restarted: bool = False) -> None:
        if not self.player or not self.instance:
            QMessageBox.warning(self, "VLC/libVLC missing", get_vlc_status_message())
            return
        try:
            stream_url = self._resolve_channel_url(channel)
            self.current_channel = channel
            self._manual_stop = False
            self._last_playback_time = -1
            self._stall_ticks = 0
            if not restarted:
                self._restart_attempts = 0
            media = self.instance.media_new(stream_url)
            self.player.set_media(media)
            self._bind_video_output()
            self.player.play()
            self.now_playing.setText(f"Now playing: {channel.name}")
            self.set_status("Stream restarted." if restarted else "Playback started.")
        except Exception as exc:
            QMessageBox.warning(self, "Playback error", str(exc))
            self.set_status("Playback failed.")

    def _resolve_channel_url(self, channel: Channel) -> str:
        if self.current_subscription and self.current_subscription.type == "mac" and channel.raw_cmd:
            provider = MacProvider(
                self.current_subscription.portal_url or "",
                self.current_subscription.mac_address or "",
            )
            return provider.create_link(channel.raw_cmd)
        return channel.url

    def pause_resume(self) -> None:
        if self.player:
            self.player.pause()

    def stop(self) -> None:
        self._manual_stop = True
        if self.player:
            self.player.stop()
        self.current_channel = None
        self._last_playback_time = -1
        self._stall_ticks = 0
        self._restart_attempts = 0
        self.now_playing.setText("No channel playing.")
        self.set_status("Stopped.")

    def set_volume(self, value: int) -> None:
        if self.player:
            self.player.audio_set_volume(value)

    def toggle_fullscreen(self) -> None:
        if self._video_fullscreen_window:
            self._exit_video_fullscreen()
        else:
            self._enter_video_fullscreen()

    def _enter_video_fullscreen(self) -> None:
        fullscreen_window = FullscreenVideoWindow()
        fullscreen_window.exit_requested.connect(self._exit_video_fullscreen)

        self.video_frame.setParent(fullscreen_window)
        self.video_frame.setStyleSheet("background: #000000;")
        fullscreen_window.layout.addWidget(self.video_frame, 1)
        self._video_fullscreen_window = fullscreen_window
        self.fullscreen_btn.setText("Exit video fullscreen")
        fullscreen_window.showFullScreen()
        self._bind_video_output()

    def _exit_video_fullscreen(self) -> None:
        fullscreen_window = self._video_fullscreen_window
        if not fullscreen_window:
            return

        self._video_fullscreen_window = None
        self.video_frame.setParent(None)
        self.video_frame.setMinimumSize(640, 360)
        self.video_frame.setStyleSheet("background: #000000; border-radius: 8px;")
        self.right_layout.insertWidget(0, self.video_frame, 1)
        self.fullscreen_btn.setText("Video fullscreen")
        fullscreen_window.close()
        fullscreen_window.deleteLater()
        self._bind_video_output()

    def _watch_playback_health(self) -> None:
        if self._manual_stop or not self.player or not self.current_channel:
            return

        try:
            state = self.player.get_state() if vlc is not None else None
            current_time = int(self.player.get_time())
        except Exception:
            return

        if vlc is not None and state in (vlc.State.Ended, vlc.State.Error):
            self._restart_current_channel("Stream ended or failed. Restarting...")
            return

        if vlc is not None and state in (vlc.State.Paused, vlc.State.Stopped, vlc.State.NothingSpecial):
            return

        if current_time <= 0:
            return

        if current_time == self._last_playback_time:
            self._stall_ticks += 1
        else:
            self._stall_ticks = 0
            self._last_playback_time = current_time

        if self._stall_ticks >= 2:
            self._restart_current_channel("Stream stalled. Restarting...")

    def _restart_current_channel(self, message: str) -> None:
        if not self.current_channel or not self.player:
            return
        if self._restart_attempts >= 5:
            self.set_status("Stream could not be restarted after multiple attempts.")
            self._restart_attempts = 0
            self._stall_ticks = 0
            return

        channel = self.current_channel
        self._restart_attempts += 1
        self._stall_ticks = 0
        self._last_playback_time = -1
        self.set_status(message)
        try:
            self.player.stop()
        except Exception:
            pass
        QTimer.singleShot(1200, lambda: self.play_channel(channel, restarted=True))
