/**
 * Status Bar
 * ==========
 * Bottom bar: connection status, protocol, MCCP, lines, uptime, log indicator.
 * Tracks its own per-session counters to avoid event ordering races.
 */

import { events, Events } from '../core/events.js';
import { sessionManager } from '../core/session-manager.js';
import { logger } from '../core/logger.js';

class StatusBar {
    constructor() {
        this.el = null;
        this._tickTimer = null;

        // Per-session tracking — keyed by sessionId
        this._sessions = new Map();
    }

    init(container) {
        this.el = container;

        // ── Track connection open: start timer ──
        events.on(Events.CONNECTION_OPEN, ({ sessionId }) => {
            const s = this._getOrCreate(sessionId);
            s.connectedAt = Date.now();
            s.connected = true;
            this._updateProtocol(sessionId);
            this.render();
        });

        // ── Track connection close: stop timer ──
        events.on(Events.CONNECTION_CLOSE, ({ sessionId }) => {
            const s = this._sessions.get(sessionId);
            if (s) {
                s.connected = false;
                s.connectedAt = null;
            }
            this.render();
        });

        // ── Track incoming data: count lines ──
        events.on(Events.CONNECTION_DATA, ({ sessionId, type, data }) => {
            if (type !== 'text' || !data) return;
            const s = this._getOrCreate(sessionId);
            // Count newlines in the text
            const newlines = (data.match(/\n/g) || []).length;
            s.lines += Math.max(newlines, 1);
        });

        // ── Track protocol/MCCP changes ──
        events.on(Events.TELNET_SUBNEG, ({ sessionId }) => {
            this._updateProtocol(sessionId);
            this.render();
        });

        // ── Track logging state ──
        events.on(Events.LOG_START, ({ sessionId }) => {
            const s = this._getOrCreate(sessionId);
            s.logging = true;
            this.render();
        });

        events.on(Events.LOG_STOP, ({ sessionId }) => {
            const s = this._sessions.get(sessionId);
            if (s) s.logging = false;
            this.render();
        });

        // ── Session lifecycle ──
        events.on(Events.SESSION_SWITCH, () => this.render());
        events.on(Events.SESSION_CREATE, ({ sessionId, connectionConfig }) => {
            const s = this._getOrCreate(sessionId);
            s.name = connectionConfig?.name || 'Unknown';
            this.render();
        });
        events.on(Events.SESSION_DESTROY, ({ sessionId }) => {
            this._sessions.delete(sessionId);
            this.render();
        });

        // ── Tick every second: update uptime + line count display ──
        this._tickTimer = setInterval(() => this._tick(), 1000);

        // ── Prompt on window close if any session has log data ──
        window.addEventListener('beforeunload', (e) => {
            const hasLogData = logger.getLoggedSessions().some(sid => {
                return logger.isActive(sid) || logger.getEntryCount(sid) > 0;
            });
            if (hasLogData) {
                e.preventDefault();
                e.returnValue = 'You have unsaved log data. Are you sure you want to leave?';
                return e.returnValue;
            }
        });

        this.render();
    }

    _getOrCreate(sessionId) {
        if (!this._sessions.has(sessionId)) {
            const session = sessionManager.getSession(sessionId);
            this._sessions.set(sessionId, {
                name: session?.connectionConfig?.name || 'Unknown',
                connected: false,
                connectedAt: null,
                lines: 0,
                logging: false,
                protocol: '',
                mccpVer: 0
            });
        }
        return this._sessions.get(sessionId);
    }

    _updateProtocol(sessionId) {
        const session = sessionManager.getSession(sessionId);
        if (!session) return;
        const s = this._getOrCreate(sessionId);
        s.protocol = session.connection?.protocol || '';
        s.mccpVer = session.connection?.mccpVersion || 0;
    }

    render() {
        if (!this.el) return;

        const active = sessionManager.getActive();
        if (!active) {
            this.el.innerHTML = `
                <div class="statusbar-left">
                    <span class="statusbar-item statusbar-muted">No active session</span>
                </div>
                <div class="statusbar-right"></div>
            `;
            return;
        }

        const s = this._getOrCreate(active.id);
        const protoShort = s.protocol.replace('.mudstandards.org', '').toUpperCase();

        // ── Left ──
        let left = `<span class="statusbar-item">${s.connected ? '🟢' : '🔴'} ${this._esc(s.name)}</span>`;
        if (protoShort) {
            left += `<span class="statusbar-item statusbar-protocol">${protoShort}</span>`;
        }
        if (s.mccpVer > 0) {
            left += `<span class="statusbar-item statusbar-mccp">MCCP${s.mccpVer}</span>`;
        }

        // ── Right ──
        let right = '';
        right += `<span class="statusbar-item statusbar-lines" title="Lines received">⇣ ${s.lines.toLocaleString()}</span>`;
        right += `<span class="statusbar-item statusbar-uptime" title="Connection uptime">⏱ ${this._formatUptime(s.connectedAt)}</span>`;

        this.el.innerHTML = `
            <div class="statusbar-left">${left}</div>
            <div class="statusbar-right">${right}</div>
        `;
    }

    _tick() {
        if (!this.el) return;
        const active = sessionManager.getActive();
        if (!active) return;
        const s = this._sessions.get(active.id);
        if (!s) return;

        const uptimeEl = this.el.querySelector('.statusbar-uptime');
        if (uptimeEl) {
            uptimeEl.textContent = `⏱ ${this._formatUptime(s.connectedAt)}`;
        }

        const linesEl = this.el.querySelector('.statusbar-lines');
        if (linesEl) {
            linesEl.textContent = `⇣ ${s.lines.toLocaleString()}`;
        }
    }

    _formatUptime(connectedAt) {
        if (!connectedAt) return '--:--';
        const elapsed = Math.floor((Date.now() - connectedAt) / 1000);
        const h = Math.floor(elapsed / 3600);
        const m = Math.floor((elapsed % 3600) / 60);
        const s = elapsed % 60;
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    _esc(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    destroy() {
        if (this._tickTimer) clearInterval(this._tickTimer);
    }
}

export const statusBar = new StatusBar();
export default statusBar;
