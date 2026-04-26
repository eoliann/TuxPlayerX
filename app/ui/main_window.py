from __future__ import annotations

from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QIcon
from PySide6.QtWidgets import (
    QApplication,
    QFrame,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QPushButton,
    QStackedWidget,
    QVBoxLayout,
    QWidget,
)

from app.config import app_icon_path
from app.database import Database
from app.ui.about_page import AboutPage
from app.ui.player_widget import PlayerWidget
from app.ui.settings_page import SettingsPage
from app.ui.subscriptions_page import SubscriptionsPage
from app.ui.theme import stylesheet_for
from app.version import APP_NAME, APP_VERSION


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.db = Database()
        self.nav_buttons: dict[str, QPushButton] = {}
        self._current_theme: str | None = None
        self.setWindowTitle(f"{APP_NAME} {APP_VERSION}")
        icon = QIcon(str(app_icon_path()))
        if not icon.isNull():
            self.setWindowIcon(icon)
        self.resize(1280, 760)
        self._build_ui()
        self.apply_theme(self.db.get_setting("theme", "dark"), persist=False)
        self.show_page("player")
        QTimer.singleShot(250, self.player_page.load_default_subscription_on_startup)

    def _build_ui(self) -> None:
        root = QWidget()
        root_layout = QHBoxLayout(root)
        root_layout.setContentsMargins(0, 0, 0, 0)
        root_layout.setSpacing(0)
        self.setCentralWidget(root)

        sidebar = QFrame()
        sidebar.setObjectName("Sidebar")
        sidebar.setFixedWidth(230)
        sidebar_layout = QVBoxLayout(sidebar)
        sidebar_layout.setContentsMargins(14, 16, 14, 16)
        sidebar_layout.setSpacing(10)

        app_title = QLabel(APP_NAME)
        app_title.setStyleSheet("font-size: 20px; font-weight: 800;")
        app_version = QLabel(f"Version {APP_VERSION}")
        app_version.setProperty("muted", True)
        sidebar_layout.addWidget(app_title)
        sidebar_layout.addWidget(app_version)
        sidebar_layout.addSpacing(18)

        self._add_nav_button(sidebar_layout, "player", "Player")
        self._add_nav_button(sidebar_layout, "subscriptions", "Subscriptions")
        self._add_nav_button(sidebar_layout, "settings", "Settings")
        self._add_nav_button(sidebar_layout, "about", "About")
        sidebar_layout.addStretch(1)

        self.theme_toggle = QPushButton("Toggle theme")
        self.theme_toggle.clicked.connect(self.toggle_theme)
        sidebar_layout.addWidget(self.theme_toggle)

        content = QWidget()
        content_layout = QVBoxLayout(content)
        content_layout.setContentsMargins(0, 0, 0, 0)
        content_layout.setSpacing(0)

        header = QFrame()
        header.setObjectName("Header")
        header_layout = QHBoxLayout(header)
        header_layout.setContentsMargins(16, 10, 16, 10)
        self.header_title = QLabel("Player")
        self.header_title.setStyleSheet("font-size: 16px; font-weight: 700;")
        self.global_status = QLabel("Ready.")
        self.global_status.setProperty("muted", True)
        header_layout.addWidget(self.header_title)
        header_layout.addStretch(1)
        header_layout.addWidget(self.global_status)
        content_layout.addWidget(header)

        self.stack = QStackedWidget()
        self.player_page = PlayerWidget(self.db)
        self.subscriptions_page = SubscriptionsPage(self.db)
        self.settings_page = SettingsPage(self.db)
        self.about_page = AboutPage()

        self.stack.addWidget(self.player_page)
        self.stack.addWidget(self.subscriptions_page)
        self.stack.addWidget(self.settings_page)
        self.stack.addWidget(self.about_page)
        content_layout.addWidget(self.stack, 1)

        root_layout.addWidget(sidebar)
        root_layout.addWidget(content, 1)

        self.player_page.status_changed.connect(self.global_status.setText)
        self.subscriptions_page.subscriptions_changed.connect(self.player_page.refresh_from_database)
        self.settings_page.theme_changed.connect(self.apply_theme)
        self.settings_page.settings_saved.connect(lambda: self.global_status.setText("Settings saved."))

    def _add_nav_button(self, layout: QVBoxLayout, key: str, label: str) -> None:
        button = QPushButton(label)
        button.setMinimumHeight(42)
        button.clicked.connect(lambda _checked=False, page=key: self.show_page(page))
        self.nav_buttons[key] = button
        layout.addWidget(button)

    def show_page(self, key: str) -> None:
        mapping = {
            "player": (0, "Player"),
            "subscriptions": (1, "Subscriptions"),
            "settings": (2, "Settings"),
            "about": (3, "About"),
        }
        index, title = mapping[key]
        self.stack.setCurrentIndex(index)
        self.header_title.setText(title)
        if key == "subscriptions":
            self.subscriptions_page.refresh()
        for nav_key, button in self.nav_buttons.items():
            button.setProperty("active", nav_key == key)
            button.style().unpolish(button)
            button.style().polish(button)

    def apply_theme(self, theme: str, persist: bool = True) -> None:
        theme = "light" if theme == "light" else "dark"
        if theme == self._current_theme:
            self.theme_toggle.setText("Switch to light" if theme == "dark" else "Switch to dark")
            return

        app = QApplication.instance()
        self.setUpdatesEnabled(False)
        try:
            if app:
                app.setStyleSheet(stylesheet_for(theme))
            self._current_theme = theme
        finally:
            self.setUpdatesEnabled(True)

        if persist:
            self.db.set_setting("theme", theme)
        self.theme_toggle.setText("Switch to light" if theme == "dark" else "Switch to dark")

    def toggle_theme(self) -> None:
        current = self._current_theme or self.db.get_setting("theme", "dark")
        new_theme = "light" if current == "dark" else "dark"
        self.settings_page.theme.blockSignals(True)
        self.settings_page.theme.setCurrentText(new_theme)
        self.settings_page.theme.blockSignals(False)
        self.apply_theme(new_theme)

    def closeEvent(self, event) -> None:  # type: ignore[override]
        try:
            self.player_page.stop()
        finally:
            super().closeEvent(event)
