from __future__ import annotations

DARK_STYLESHEET = """
QWidget {
    background: #111827;
    color: #f9fafb;
    font-family: Segoe UI, Inter, Arial, sans-serif;
    font-size: 13px;
}
QMainWindow, QDialog {
    background: #111827;
}
#Sidebar {
    background: #0b1220;
    border-right: 1px solid #1f2937;
}
#Header {
    background: #111827;
    border-bottom: 1px solid #1f2937;
}
QPushButton {
    background: #1f2937;
    border: 1px solid #374151;
    border-radius: 8px;
    padding: 8px 12px;
    color: #f9fafb;
}
QPushButton:hover {
    background: #374151;
}
QPushButton:pressed {
    background: #4b5563;
}
QPushButton[active="true"] {
    background: #2563eb;
    border-color: #3b82f6;
    color: white;
}
QPushButton[danger="true"] {
    background: #7f1d1d;
    border-color: #991b1b;
}
QPushButton[success="true"] {
    background: #065f46;
    border-color: #047857;
}
QLineEdit, QTextEdit, QPlainTextEdit, QComboBox, QSpinBox {
    background: #0f172a;
    color: #f9fafb;
    border: 1px solid #334155;
    border-radius: 7px;
    padding: 7px;
}
QTableWidget, QListWidget {
    background: #0f172a;
    color: #f9fafb;
    border: 1px solid #334155;
    border-radius: 8px;
    gridline-color: #334155;
}
QHeaderView::section {
    background: #1f2937;
    color: #f9fafb;
    padding: 7px;
    border: none;
}
QLabel[muted="true"] {
    color: #9ca3af;
}
QFrame[card="true"] {
    background: #0f172a;
    border: 1px solid #273449;
    border-radius: 12px;
}
QCheckBox {
    spacing: 8px;
}
"""

LIGHT_STYLESHEET = """
QWidget {
    background: #f8fafc;
    color: #0f172a;
    font-family: Segoe UI, Inter, Arial, sans-serif;
    font-size: 13px;
}
QMainWindow, QDialog {
    background: #f8fafc;
}
#Sidebar {
    background: #ffffff;
    border-right: 1px solid #e2e8f0;
}
#Header {
    background: #f8fafc;
    border-bottom: 1px solid #e2e8f0;
}
QPushButton {
    background: #ffffff;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    padding: 8px 12px;
    color: #0f172a;
}
QPushButton:hover {
    background: #e2e8f0;
}
QPushButton:pressed {
    background: #cbd5e1;
}
QPushButton[active="true"] {
    background: #2563eb;
    border-color: #2563eb;
    color: white;
}
QPushButton[danger="true"] {
    background: #fee2e2;
    border-color: #fca5a5;
    color: #7f1d1d;
}
QPushButton[success="true"] {
    background: #dcfce7;
    border-color: #86efac;
    color: #166534;
}
QLineEdit, QTextEdit, QPlainTextEdit, QComboBox, QSpinBox {
    background: #ffffff;
    color: #0f172a;
    border: 1px solid #cbd5e1;
    border-radius: 7px;
    padding: 7px;
}
QTableWidget, QListWidget {
    background: #ffffff;
    color: #0f172a;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    gridline-color: #e2e8f0;
}
QHeaderView::section {
    background: #e2e8f0;
    color: #0f172a;
    padding: 7px;
    border: none;
}
QLabel[muted="true"] {
    color: #64748b;
}
QFrame[card="true"] {
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 12px;
}
QCheckBox {
    spacing: 8px;
}
"""


def stylesheet_for(theme: str) -> str:
    return LIGHT_STYLESHEET if theme == "light" else DARK_STYLESHEET
