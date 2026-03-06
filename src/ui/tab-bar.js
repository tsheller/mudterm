/**
 * Tab Bar
 * =======
 * Browser-style tab bar for managing multiple sessions.
 * First tab is always "Connections" (non-closeable).
 * Each session tab has a 🪵 log toggle (brown=off, green=on).
 */

import { events, Events } from '../core/events.js';
import { sessionManager } from '../core/session-manager.js';
import { logger } from '../core/logger.js';

class TabBar {
    constructor() {
        this.el = null;
        this._showConnections = null;
    }

    init(container, showConnections) {
        this.el = container;
        this._showConnections = showConnections;

        events.on(Events.SESSION_CREATE, () => this.render());
        events.on(Events.SESSION_DESTROY, () => this.render());
        events.on(Events.SESSION_SWITCH, () => this.render());
        events.on(Events.SESSION_UPDATE, () => this.render());
        events.on(Events.CONNECTION_OPEN, () => this.render());
        events.on(Events.CONNECTION_CLOSE, () => this.render());
        events.on(Events.LOG_START, () => this.render());
        events.on(Events.LOG_STOP, () => this.render());

        this.render();
    }

    render() {
        if (!this.el) return;

        const sessions = sessionManager.getAllSessions();
        const activeId = sessionManager.activeSessionId;
        const connectionsActive = activeId === null;

        let html = '';

        // Connections tab
        html += `<div class="tab-item tab-connections ${connectionsActive ? 'active' : ''}" data-tab="connections">
            <span class="tab-icon">⌂</span>
            <span class="tab-label">Connections</span>
        </div>`;

        // Session tabs
        for (const session of sessions) {
            const isActive = session.id === activeId;
            const colorClass = session.color || 'cyan';
            const connected = session.connection.isConnected();
            const profileLabel = session.profileName ? ` (${session.profileName})` : '';
            const isLogging = logger.isActive(session.id);

            html += `<div class="tab-item tab-session color-${colorClass} ${isActive ? 'active' : ''} ${!connected ? 'disconnected' : ''}" data-session="${session.id}">
                <span class="tab-status-dot ${connected ? 'connected' : ''}"></span>
                <span class="tab-label">${this._esc(session.connectionConfig.name)}${this._esc(profileLabel)}</span>
                <button class="tab-log-btn ${isLogging ? 'logging' : ''}" data-log="${session.id}" title="${isLogging ? 'Stop logging' : 'Start logging'}">📜</button>
                <button class="tab-close" data-close="${session.id}" title="Close tab">&times;</button>
            </div>`;
        }

        this.el.innerHTML = html;
        this._bind();
    }

    _bind() {
        // Tab click → switch session
        this.el.querySelectorAll('.tab-item').forEach(tab => {
            tab.addEventListener('click', (e) => {
                if (e.target.closest('.tab-close') || e.target.closest('.tab-log-btn')) return;

                if (tab.dataset.tab === 'connections') {
                    if (sessionManager.activeSessionId) {
                        const current = sessionManager.getActive();
                        if (current) current.hide();
                        sessionManager.activeSessionId = null;
                    }
                    if (this._showConnections) this._showConnections();
                    this.render();
                } else if (tab.dataset.session) {
                    this._hideConnectionsScreen();
                    sessionManager.switchTo(tab.dataset.session);
                }
            });
        });

        // Close button — prompt to save log if logging or has data
        this.el.querySelectorAll('.tab-close').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const sessionId = btn.dataset.close;
                const hasLogData = logger.isActive(sessionId) || logger.getEntryCount(sessionId) > 0;

                if (hasLogData) {
                    const action = confirm(
                        'This session has log data. Save before closing?\n\nOK = Save & Close\nCancel = Close without saving'
                    );
                    if (action) {
                        logger.download(sessionId);
                    }
                }
                logger.stop(sessionId);
                sessionManager.closeSession(sessionId);
            });
        });

        // Log toggle button
        this.el.querySelectorAll('.tab-log-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const sessionId = btn.dataset.log;
                const session = sessionManager.getSession(sessionId);
                const serverName = session?.connectionConfig?.name || sessionId;
                logger.toggle(sessionId, serverName);
                // render() will be called by LOG_START/LOG_STOP event
            });
        });
    }

    _hideConnectionsScreen() {
        const connScreen = document.getElementById('screen-connections');
        if (connScreen) connScreen.classList.remove('active');
        const termScreen = document.getElementById('screen-terminal');
        if (termScreen) termScreen.classList.add('active');
    }

    _esc(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}

export const tabBar = new TabBar();
export default tabBar;
