from __future__ import annotations

from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QMessageBox,
    QPushButton,
    QTextBrowser,
    QVBoxLayout,
    QWidget,
)

from app.github_update import check_for_updates
from app.version import APP_AUTHOR, APP_LICENSE, APP_NAME, APP_VERSION, AUTHOR_URL, DOWNLOAD_URL, GITHUB_REPO
from app.vlc_check import get_vlc_status_message


class AboutPage(QWidget):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._build_ui()

    def _build_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(12)

        title = QLabel("About")
        title.setStyleSheet("font-size: 22px; font-weight: 700;")
        layout.addWidget(title)

        card = QFrame()
        card.setProperty("card", True)
        card_layout = QVBoxLayout(card)
        card_layout.setContentsMargins(16, 16, 16, 16)

        info = QTextBrowser()
        info.setOpenExternalLinks(True)
        info.setHtml(
            f"""
            <h2>{APP_NAME}</h2>
            <p><b>Version:</b> {APP_VERSION}</p>
            <p><b>License:</b> {APP_LICENSE}</p>
            <p><b>Author:</b> <a href=\"{AUTHOR_URL}\">{APP_AUTHOR}</a></p>
            <p><b>GitHub repository:</b> {GITHUB_REPO}</p>
            <p><b>Downloads:</b> <a href=\"{DOWNLOAD_URL}\">{DOWNLOAD_URL}</a></p>
            <p><b>Playback engine:</b> VLC/libVLC via python-vlc.</p>
            <p><b>Legal notice:</b> This application is a player for user-provided streaming sources.
            Use only streams and subscriptions you are authorized to access.</p>
            """
        )
        card_layout.addWidget(info, 1)

        self.vlc_status = QLabel(get_vlc_status_message())
        self.vlc_status.setWordWrap(True)
        self.vlc_status.setProperty("muted", True)
        card_layout.addWidget(self.vlc_status)

        buttons = QHBoxLayout()
        self.update_btn = QPushButton("Check for updates")
        buttons.addWidget(self.update_btn)
        buttons.addStretch(1)
        card_layout.addLayout(buttons)
        layout.addWidget(card, 1)

        self.update_btn.clicked.connect(self.check_updates)

    def check_updates(self) -> None:
        result = check_for_updates()
        if result.ok:
            if result.update_available:
                message = f"Current version: {result.current_version}\nLatest version: {result.latest_version}\n\n{result.release_url or ''}"
            else:
                message = f"Current version: {result.current_version}\nLatest version: {result.latest_version}\n\n{result.message}"
        else:
            message = result.message
        QMessageBox.information(self, "Update check", message)
