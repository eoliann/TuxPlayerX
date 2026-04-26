from __future__ import annotations

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QFormLayout,
    QFrame,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from app.database import Database
from app.vlc_check import get_vlc_status_message


class SettingsPage(QWidget):
    theme_changed = Signal(str)
    settings_saved = Signal()

    def __init__(self, db: Database, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.db = db
        self._build_ui()
        self.load_settings()

    def _build_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(12)

        title = QLabel("Settings")
        title.setStyleSheet("font-size: 22px; font-weight: 700;")
        layout.addWidget(title)

        card = QFrame()
        card.setProperty("card", True)
        card_layout = QVBoxLayout(card)
        card_layout.setContentsMargins(16, 16, 16, 16)
        form = QFormLayout()

        self.theme = QComboBox()
        self.theme.addItems(["dark", "light"])
        self.theme.currentTextChanged.connect(self.theme_changed.emit)
        self.check_updates = QCheckBox("Check for updates on startup")
        self.resume_last_channel = QCheckBox("Resume last channel")
        self.mask_sensitive_data = QCheckBox("Mask sensitive subscription data")
        self.network_cache = QSpinBox()
        self.network_cache.setRange(300, 30000)
        self.network_cache.setSingleStep(500)
        self.network_cache.setSuffix(" ms")

        form.addRow("Theme", self.theme)
        form.addRow("Playback cache", self.network_cache)
        form.addRow("Updates", self.check_updates)
        form.addRow("Playback", self.resume_last_channel)
        form.addRow("Privacy", self.mask_sensitive_data)
        card_layout.addLayout(form)

        self.vlc_status = QLabel(get_vlc_status_message())
        self.vlc_status.setWordWrap(True)
        self.vlc_status.setProperty("muted", True)
        card_layout.addWidget(self.vlc_status)

        buttons = QHBoxLayout()
        self.save_btn = QPushButton("Save settings")
        self.save_btn.setProperty("success", True)
        self.reload_vlc_btn = QPushButton("Refresh VLC status")
        buttons.addWidget(self.save_btn)
        buttons.addWidget(self.reload_vlc_btn)
        buttons.addStretch(1)
        card_layout.addLayout(buttons)
        layout.addWidget(card)
        layout.addStretch(1)

        self.save_btn.clicked.connect(self.save_settings)
        self.reload_vlc_btn.clicked.connect(lambda: self.vlc_status.setText(get_vlc_status_message()))

    def load_settings(self) -> None:
        settings = self.db.get_all_settings()
        self.theme.setCurrentText(settings.get("theme", "dark"))
        self.check_updates.setChecked(settings.get("check_updates_on_startup", "true") == "true")
        self.resume_last_channel.setChecked(settings.get("resume_last_channel", "true") == "true")
        self.mask_sensitive_data.setChecked(settings.get("mask_sensitive_data", "true") == "true")
        try:
            self.network_cache.setValue(int(settings.get("network_cache_ms", "3000")))
        except ValueError:
            self.network_cache.setValue(3000)

    def save_settings(self) -> None:
        self.db.set_setting("theme", self.theme.currentText())
        self.db.set_setting("check_updates_on_startup", "true" if self.check_updates.isChecked() else "false")
        self.db.set_setting("resume_last_channel", "true" if self.resume_last_channel.isChecked() else "false")
        self.db.set_setting("mask_sensitive_data", "true" if self.mask_sensitive_data.isChecked() else "false")
        self.db.set_setting("network_cache_ms", str(self.network_cache.value()))
        self.settings_saved.emit()
