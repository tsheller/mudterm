/**
 * Log Panel
 * =========
 * Renders the Logs tab in the right-side panel.
 * Shows per-session log viewer with live updates.
 */

import { events, Events } from '../core/events.js';
import { sessionManager } from '../core/session-manager.js';
import { logger } from '../core/logger.js';

class LogPanel {
    constructor() {
        this.containerEl = null;
        this.viewingSessionId = null;
        this._liveUnsub = null;
        this._scrollLocked = true;
    }

    init(container) {
        this.containerEl = container;

        // Re-render when log state changes
        events.on(Events.LOG_START, () => this.render());
        events.on(Events.LOG_STOP, () => this.render());
        events.on(Events.SESSION_DESTROY, () => this.render());
    }

    render() {
        if (!this.containerEl) return;

        const activeSession = sessionManager.getActive();
        const activeId = activeSession?.id;

        // Default to viewing active session if it has a log
        if (!this.viewingSessionId && activeId) {
            this.viewingSessionId = activeId;
        }

        // Get all sessions that have logs
        const sessions = sessionManager.getAllSessions();
        const loggedIds = logger.getLoggedSessions();

        // Build session list
        const sessionItems = sessions.map(s => {
            const hasLog = loggedIds.includes(s.id);
            const isActive = logger.isActive(s.id);
            const isViewing = s.id === this.viewingSessionId;
            const count = logger.getEntryCount(s.id);
            return `<div class="log-session-item ${isViewing ? 'viewing' : ''} ${isActive ? 'active-log' : ''}" data-sid="${s.id}">
                <span class="log-session-icon">${isActive ? '🟢' : (hasLog ? '🪵' : '⚫')}</span>
                <span class="log-session-name">${this._esc(s.connectionConfig.name)}</span>
                ${count > 0 ? `<span class="log-session-count">${count}</span>` : ''}
            </div>`;
        }).join('');

        // Build log viewer for selected session
        let viewerHtml = '';
        const logState = this.viewingSessionId ? logger.getLog(this.viewingSessionId) : null;

        if (logState && logState.entries.length > 0) {
            const viewSession = sessionManager.getSession(this.viewingSessionId);
            const name = viewSession?.connectionConfig?.name || logState.serverName || this.viewingSessionId;

            viewerHtml = `
                <div class="log-viewer-header">
                    <span class="log-viewer-title">${this._esc(name)}</span>
                    <span class="log-viewer-status">${logState.active ? '● Recording' : 'Stopped'}</span>
                </div>
                <div class="log-viewer-actions">
                    <button class="log-action-btn" id="log-export-btn">⬇ Export</button>
                    <button class="log-action-btn" id="log-clear-btn">✕ Clear</button>
                </div>
                <div class="log-viewer-content" id="log-viewer-content">
                    ${this._renderEntries(logState.entries)}
                </div>`;
        } else if (this.viewingSessionId) {
            viewerHtml = `<div class="log-empty">No log entries yet. Click 🪵 on a session tab to start logging.</div>`;
        } else {
            viewerHtml = `<div class="log-empty">Select a session to view its log.</div>`;
        }

        this.containerEl.innerHTML = `
            <div class="log-panel">
                <div class="log-session-list">${sessionItems || '<div class="log-empty">No sessions open.</div>'}</div>
                <div class="log-viewer">${viewerHtml}</div>
            </div>`;

        // Bind session list clicks
        this.containerEl.querySelectorAll('.log-session-item').forEach(el => {
            el.addEventListener('click', () => {
                this.viewingSessionId = el.dataset.sid;
                this.render();
            });
        });

        // Bind actions
        const exportBtn = this.containerEl.querySelector('#log-export-btn');
        if (exportBtn) {
            exportBtn.addEventListener('click', () => {
                if (this.viewingSessionId) logger.download(this.viewingSessionId);
            });
        }

        const clearBtn = this.containerEl.querySelector('#log-clear-btn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                if (this.viewingSessionId && confirm('Clear this log?')) {
                    logger.clearLog(this.viewingSessionId);
                    this.render();
                }
            });
        }

        // Auto-scroll to bottom
        const content = this.containerEl.querySelector('#log-viewer-content');
        if (content) content.scrollTop = content.scrollHeight;

        // Wire live updates
        this._setupLiveUpdates();
    }

    _renderEntries(entries) {
        // Show last 500 entries max for performance
        const slice = entries.length > 500 ? entries.slice(-500) : entries;
        return slice.map(e => {
            const time = new Date(e.timestamp).toLocaleTimeString();
            switch (e.type) {
                case 'input':
                    return `<div class="log-entry log-input"><span class="log-ts">[${time}]</span> &gt; ${this._esc(e.text)}</div>`;
                case 'output':
                    return `<div class="log-entry log-output">${this._esc(e.text.replace(/\x1b\[[0-9;]*m/g, ''))}</div>`;
                case 'system':
                    return `<div class="log-entry log-system"><span class="log-ts">[${time}]</span> ${this._esc(e.text)}</div>`;
                default:
                    return '';
            }
        }).join('');
    }

    _setupLiveUpdates() {
        // Unsub previous
        if (this._liveUnsub) { this._liveUnsub(); this._liveUnsub = null; }

        if (!this.viewingSessionId) return;
        const sid = this.viewingSessionId;

        this._liveUnsub = events.on(Events.LOG_ENTRY, ({ sessionId }) => {
            if (sessionId !== sid) return;
            // Append live instead of full re-render
            const content = this.containerEl?.querySelector('#log-viewer-content');
            if (!content) return;

            const logState = logger.getLog(sid);
            if (!logState || logState.entries.length === 0) return;

            const last = logState.entries[logState.entries.length - 1];
            const time = new Date(last.timestamp).toLocaleTimeString();
            const div = document.createElement('div');
            div.className = `log-entry log-${last.type}`;

            switch (last.type) {
                case 'input':
                    div.innerHTML = `<span class="log-ts">[${time}]</span> &gt; ${this._esc(last.text)}`;
                    break;
                case 'output':
                    div.textContent = last.text.replace(/\x1b\[[0-9;]*m/g, '');
                    break;
                case 'system':
                    div.innerHTML = `<span class="log-ts">[${time}]</span> ${this._esc(last.text)}`;
                    break;
            }

            content.appendChild(div);

            // Auto-scroll if near bottom
            const nearBottom = content.scrollHeight - content.scrollTop - content.clientHeight < 60;
            if (nearBottom) content.scrollTop = content.scrollHeight;
        });
    }

    _esc(s) {
        return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
}

export const logPanel = new LogPanel();
export default logPanel;
