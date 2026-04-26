from __future__ import annotations

import platform
import sys

from PySide6.QtGui import QIcon
from PySide6.QtWidgets import QApplication, QMessageBox

from app.config import app_icon_path
from app.ui.main_window import MainWindow
from app.version import APP_NAME
from app.vlc_check import get_vlc_status_message, is_vlc_available


def set_windows_app_user_model_id() -> None:
    if platform.system().lower() != "windows":
        return
    try:
        import ctypes

        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("eoliann.TuxPlayerX")
    except Exception:
        pass


def main() -> int:
    set_windows_app_user_model_id()
    app = QApplication(sys.argv)
    app.setApplicationName(APP_NAME)

    icon = QIcon(str(app_icon_path()))
    if not icon.isNull():
        app.setWindowIcon(icon)

    window = MainWindow()
    if not icon.isNull():
        window.setWindowIcon(icon)
    window.show()

    if not is_vlc_available():
        QMessageBox.information(window, "VLC/libVLC status", get_vlc_status_message())

    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
