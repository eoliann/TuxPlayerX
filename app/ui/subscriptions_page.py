from __future__ import annotations

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QFrame,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPushButton,
    QStackedWidget,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from app.database import Database, Subscription
from app.providers.mac_provider import MacProvider, MacProviderError
from app.providers.m3u_provider import M3UInfoError, get_m3u_subscription_info


class SubscriptionDialog(QDialog):
    def __init__(self, parent: QWidget | None = None, subscription: Subscription | None = None) -> None:
        super().__init__(parent)
        self.subscription = subscription
        self.selected_type = (subscription.type if subscription else 'm3u').lower()
        self.setWindowTitle('Subscription')
        self.setMinimumWidth(560)
        self._build_ui()
        if subscription:
            self._load_subscription(subscription)
        self._set_type(self.selected_type)

    def _build_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setSpacing(12)

        top_label = QLabel('Choose the subscription type and complete only the relevant form.')
        top_label.setProperty('muted', True)
        top_label.setWordWrap(True)
        layout.addWidget(top_label)

        type_row = QHBoxLayout()
        self.m3u_btn = QPushButton('M3U')
        self.mac_btn = QPushButton('MAC')
        for btn in (self.m3u_btn, self.mac_btn):
            btn.setCheckable(True)
            btn.setMinimumHeight(40)
            type_row.addWidget(btn)
        type_row.addStretch(1)
        layout.addLayout(type_row)

        self.name = QLineEdit()
        self.name.setPlaceholderText('Example: Home IPTV')
        self.is_default = QCheckBox('Use as default subscription')

        common_frame = QFrame()
        common_frame.setProperty('card', True)
        common_layout = QFormLayout(common_frame)
        common_layout.setContentsMargins(14, 14, 14, 14)
        common_layout.addRow('Name', self.name)
        common_layout.addRow('', self.is_default)
        layout.addWidget(common_frame)

        self.stack = QStackedWidget()

        # M3U form
        m3u_page = QFrame()
        m3u_page.setProperty('card', True)
        m3u_layout = QVBoxLayout(m3u_page)
        m3u_layout.setContentsMargins(14, 14, 14, 14)
        m3u_form = QFormLayout()
        self.url = QLineEdit()
        self.url.setPlaceholderText('https://example.com/playlist.m3u or /path/to/list.m3u')
        self.username = QLineEdit()
        self.username.setPlaceholderText('Optional username')
        self.password = QLineEdit()
        self.password.setPlaceholderText('Optional password')
        self.password.setEchoMode(QLineEdit.EchoMode.Password)
        m3u_form.addRow('M3U URL/file', self.url)
        m3u_form.addRow('Username', self.username)
        m3u_form.addRow('Password', self.password)
        m3u_layout.addLayout(m3u_form)
        m3u_note = QLabel('Use this form for remote M3U links or local playlist files.')
        m3u_note.setProperty('muted', True)
        m3u_note.setWordWrap(True)
        m3u_layout.addWidget(m3u_note)
        self.stack.addWidget(m3u_page)

        # MAC form
        mac_page = QFrame()
        mac_page.setProperty('card', True)
        mac_layout = QVBoxLayout(mac_page)
        mac_layout.setContentsMargins(14, 14, 14, 14)
        mac_form = QFormLayout()
        self.portal_url = QLineEdit()
        self.portal_url.setPlaceholderText('https://provider.example.com/c/')
        self.mac_address = QLineEdit()
        self.mac_address.setPlaceholderText('00:1A:79:XX:XX:XX')
        mac_form.addRow('Portal URL', self.portal_url)
        mac_form.addRow('MAC address', self.mac_address)
        mac_layout.addLayout(mac_form)
        mac_note = QLabel('Use only portal credentials you are authorized to access. Some providers may still require custom compatibility adjustments.')
        mac_note.setProperty('muted', True)
        mac_note.setWordWrap(True)
        mac_layout.addWidget(mac_note)
        self.stack.addWidget(mac_page)

        layout.addWidget(self.stack)

        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

        self.m3u_btn.clicked.connect(lambda: self._set_type('m3u'))
        self.mac_btn.clicked.connect(lambda: self._set_type('mac'))

    def _set_type(self, sub_type: str) -> None:
        self.selected_type = 'mac' if sub_type == 'mac' else 'm3u'
        self.m3u_btn.setChecked(self.selected_type == 'm3u')
        self.mac_btn.setChecked(self.selected_type == 'mac')
        self.stack.setCurrentIndex(0 if self.selected_type == 'm3u' else 1)
        for btn, active in ((self.m3u_btn, self.selected_type == 'm3u'), (self.mac_btn, self.selected_type == 'mac')):
            btn.setProperty('active', active)
            btn.style().unpolish(btn)
            btn.style().polish(btn)

    def _load_subscription(self, subscription: Subscription) -> None:
        self.name.setText(subscription.name)
        self.url.setText(subscription.url or '')
        self.portal_url.setText(subscription.portal_url or '')
        self.mac_address.setText(subscription.mac_address or '')
        self.username.setText(subscription.username or '')
        self.password.setText(subscription.password or '')
        self.is_default.setChecked(subscription.is_default)

    def get_subscription(self) -> Subscription:
        sub_type = self.selected_type
        return Subscription(
            id=self.subscription.id if self.subscription else None,
            name=self.name.text().strip(),
            type=sub_type,
            url=self.url.text().strip() if sub_type == 'm3u' else None,
            portal_url=self.portal_url.text().strip() if sub_type == 'mac' else None,
            mac_address=self.mac_address.text().strip() if sub_type == 'mac' else None,
            username=self.username.text().strip() or None if sub_type == 'm3u' else None,
            password=self.password.text().strip() or None if sub_type == 'm3u' else None,
            is_default=self.is_default.isChecked(),
            expires_at=self.subscription.expires_at if self.subscription else None,
            active_connections=self.subscription.active_connections if self.subscription else None,
            max_connections=self.subscription.max_connections if self.subscription else None,
        )

    def accept(self) -> None:
        subscription = self.get_subscription()
        if not subscription.name:
            QMessageBox.warning(self, 'Validation error', 'Name is required.')
            return
        if subscription.type == 'm3u' and not subscription.url:
            QMessageBox.warning(self, 'Validation error', 'M3U URL/file is required.')
            return
        if subscription.type == 'mac' and (not subscription.portal_url or not subscription.mac_address):
            QMessageBox.warning(self, 'Validation error', 'Portal URL and MAC address are required.')
            return
        super().accept()


class SubscriptionsPage(QWidget):
    subscriptions_changed = Signal()

    def __init__(self, db: Database, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.db = db
        self._build_ui()
        self.refresh()

    def _build_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(12)

        header = QHBoxLayout()
        title_box = QVBoxLayout()
        title = QLabel('Subscriptions')
        title.setStyleSheet('font-size: 22px; font-weight: 700;')
        subtitle = QLabel('Manage M3U and MAC subscriptions. The default subscription can auto-load in the player.')
        subtitle.setProperty('muted', True)
        title_box.addWidget(title)
        title_box.addWidget(subtitle)
        header.addLayout(title_box)
        header.addStretch(1)

        self.add_btn = QPushButton('Add')
        self.add_btn.setProperty('success', True)
        self.edit_btn = QPushButton('Edit')
        self.default_btn = QPushButton('Set default')
        self.info_btn = QPushButton('Info')
        self.refresh_info_btn = QPushButton('Refresh info')
        self.delete_btn = QPushButton('Delete')
        self.delete_btn.setProperty('danger', True)
        for button in [self.add_btn, self.edit_btn, self.default_btn, self.info_btn, self.refresh_info_btn, self.delete_btn]:
            header.addWidget(button)
        layout.addLayout(header)

        self.table = QTableWidget(0, 7)
        self.table.setHorizontalHeaderLabels(['Default', 'Name', 'Type', 'Source', 'Expires', 'Connections', 'ID'])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QTableWidget.SelectionMode.SingleSelection)
        self.table.setColumnHidden(6, True)
        layout.addWidget(self.table, 1)

        self.add_btn.clicked.connect(self.add_subscription)
        self.edit_btn.clicked.connect(self.edit_subscription)
        self.default_btn.clicked.connect(self.set_default)
        self.info_btn.clicked.connect(self.show_info)
        self.refresh_info_btn.clicked.connect(self.refresh_selected_info)
        self.delete_btn.clicked.connect(self.delete_subscription)
        self.table.itemDoubleClicked.connect(lambda _item: self.edit_subscription())

    def refresh(self) -> None:
        subscriptions = self.db.list_subscriptions()
        self.table.setRowCount(0)
        for subscription in subscriptions:
            row = self.table.rowCount()
            self.table.insertRow(row)
            source = subscription.url if subscription.type == 'm3u' else subscription.portal_url
            connections = self._connections_text(subscription.active_connections, subscription.max_connections)

            values = [
                'Yes' if subscription.is_default else 'No',
                subscription.name,
                subscription.type.upper(),
                source or '',
                subscription.expires_at or 'Unknown',
                connections,
                str(subscription.id or ''),
            ]
            for col, value in enumerate(values):
                item = QTableWidgetItem(value)
                if col in {0, 2, 4, 5, 6}:
                    item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
                self.table.setItem(row, col, item)

    def selected_subscription_id(self) -> int | None:
        row = self.table.currentRow()
        if row < 0:
            return None
        item = self.table.item(row, 6)
        if not item:
            return None
        try:
            return int(item.text())
        except ValueError:
            return None

    def selected_subscription(self) -> Subscription | None:
        sub_id = self.selected_subscription_id()
        return self.db.get_subscription(sub_id) if sub_id else None

    def add_subscription(self) -> None:
        dialog = SubscriptionDialog(self)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            sub_id = self.db.save_subscription(dialog.get_subscription())
            subscription = self.db.get_subscription(sub_id)
            if subscription:
                self._refresh_subscription_info(subscription, show_errors=False)
            self.refresh()
            self.subscriptions_changed.emit()

    def edit_subscription(self) -> None:
        subscription = self.selected_subscription()
        if not subscription:
            QMessageBox.information(self, 'No selection', 'Select a subscription first.')
            return
        dialog = SubscriptionDialog(self, subscription)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            sub_id = self.db.save_subscription(dialog.get_subscription())
            updated_subscription = self.db.get_subscription(sub_id)
            if updated_subscription:
                self._refresh_subscription_info(updated_subscription, show_errors=False)
            self.refresh()
            self.subscriptions_changed.emit()

    def set_default(self) -> None:
        sub_id = self.selected_subscription_id()
        if not sub_id:
            QMessageBox.information(self, 'No selection', 'Select a subscription first.')
            return
        self.db.set_default_subscription(sub_id)
        self.refresh()
        self.subscriptions_changed.emit()

    def delete_subscription(self) -> None:
        subscription = self.selected_subscription()
        if not subscription:
            QMessageBox.information(self, 'No selection', 'Select a subscription first.')
            return
        answer = QMessageBox.question(
            self,
            'Delete subscription',
            f"Delete subscription '{subscription.name}'?",
        )
        if answer == QMessageBox.StandardButton.Yes:
            self.db.delete_subscription(subscription.id or 0)
            self.refresh()
            self.subscriptions_changed.emit()

    def _connections_text(self, active_connections: int | None, max_connections: int | None) -> str:
        active = str(active_connections) if active_connections is not None else 'Unknown'
        maximum = str(max_connections) if max_connections is not None else 'Unknown'
        return f'{active} / {maximum}'

    def _subscription_info_message(self, subscription: Subscription, status: str = 'Unknown', note: str | None = None) -> str:
        message = (
            f"Name: {subscription.name}\n"
            f"Type: {subscription.type.upper()}\n"
            f"Status: {status}\n"
            f"Expires: {subscription.expires_at or 'Unknown'}\n"
            f"Connections: {self._connections_text(subscription.active_connections, subscription.max_connections)}"
        )
        if note:
            message += f"\n\n{note}"
        return message

    def _refresh_subscription_info(self, subscription: Subscription, show_errors: bool = True) -> tuple[Subscription, str, str | None]:
        status = 'Unknown'
        note: str | None = None
        try:
            if subscription.type == 'm3u':
                if not subscription.url:
                    raise M3UInfoError('This M3U subscription has no URL/file path.')
                info = get_m3u_subscription_info(subscription.url, subscription.username, subscription.password)
                status = info.status
                note = info.message
                self.db.update_subscription_info(
                    subscription.id or 0,
                    expires_at=info.expires_at,
                    active_connections=info.active_connections,
                    max_connections=info.max_connections,
                )
            elif subscription.type == 'mac':
                info = MacProvider(subscription.portal_url or '', subscription.mac_address or '').get_info()
                status = info.status
                note = info.message
                self.db.update_subscription_info(
                    subscription.id or 0,
                    expires_at=info.expires_at,
                    active_connections=info.active_connections,
                    max_connections=info.max_connections,
                )
        except (M3UInfoError, MacProviderError) as exc:
            note = str(exc)
            if show_errors:
                QMessageBox.warning(self, 'Subscription info', note)

        fresh = self.db.get_subscription(subscription.id or 0) or subscription
        return fresh, status, note

    def refresh_selected_info(self) -> None:
        subscription = self.selected_subscription()
        if not subscription:
            QMessageBox.information(self, 'No selection', 'Select a subscription first.')
            return
        fresh, _status, note = self._refresh_subscription_info(subscription, show_errors=True)
        self.refresh()
        QMessageBox.information(self, 'Subscription info', self._subscription_info_message(fresh, status=_status, note=note))

    def show_info(self) -> None:
        subscription = self.selected_subscription()
        if not subscription:
            QMessageBox.information(self, 'No selection', 'Select a subscription first.')
            return
        fresh, status, note = self._refresh_subscription_info(subscription, show_errors=False)
        self.refresh()
        QMessageBox.information(self, 'Subscription info', self._subscription_info_message(fresh, status=status, note=note))
