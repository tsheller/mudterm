/**
 * Logger — Per-Session Recording
 * ===============================
 * Each session has its own log. Event handlers filter by sessionId.
 * Toggle logging per-session from the tab bar icon.
 */

import { events, Events } from './events.js';

class Logger {
    constructor() {
        this.sessions = new Map(); // sessionId -> { active, startTime, endTime, entries[], serverName, autoSaveTimer }

        // Per-session event handlers with sessionId filtering
        events.on(Events.CONNECTION_DATA, ({ sessionId, type, data }) => {
            if (type !== 'text') return;
            this._addEntry(sessionId, 'output', data);
        });

        events.on(Events.COMMAND_SENT, ({ sessionId, command }) => {
            this._addEntry(sessionId, 'input', command);
        });

        events.on(Events.CONNECTION_OPEN, ({ sessionId }) => {
            this._addEntry(sessionId, 'system', '--- Connected ---');
        });

        events.on(Events.CONNECTION_CLOSE, ({ sessionId }) => {
            this._addEntry(sessionId, 'system', '--- Disconnected ---');
        });

        events.on(Events.SESSION_DESTROY, ({ sessionId }) => {
            this.stop(sessionId);
            // Keep the log data for export even after session closes
        });
    }

    /**
     * Is logging active for a session?
     */
    isActive(sessionId) {
        return this.sessions.get(sessionId)?.active || false;
    }

    /**
     * Toggle logging for a session
     * @returns {boolean} new active state
     */
    toggle(sessionId, serverName = '') {
        if (this.isActive(sessionId)) {
            this.stop(sessionId);
            return false;
        } else {
            this.start(sessionId, serverName);
            return true;
        }
    }

    /**
     * Start logging for a session
     */
    start(sessionId, serverName = '') {
        let logState = this.sessions.get(sessionId);

        if (!logState) {
            logState = {
                active: false,
                startTime: null,
                endTime: null,
                entries: [],
                serverName: serverName || sessionId,
                _autoSaveTimer: null
            };
            this.sessions.set(sessionId, logState);
        }

        logState.active = true;
        logState.startTime = logState.startTime || Date.now();
        logState.endTime = null;

        logState.entries.push({
            timestamp: Date.now(),
            type: 'system',
            text: '--- Logging started ---'
        });

        // Auto-save every 10s
        if (logState._autoSaveTimer) clearInterval(logState._autoSaveTimer);
        logState._autoSaveTimer = setInterval(() => this._saveToStorage(sessionId), 10000);

        events.emit(Events.LOG_START, { sessionId });
    }

    /**
     * Stop logging for a session
     */
    stop(sessionId) {
        const logState = this.sessions.get(sessionId);
        if (!logState || !logState.active) return;

        logState.active = false;
        logState.endTime = Date.now();

        logState.entries.push({
            timestamp: Date.now(),
            type: 'system',
            text: '--- Logging stopped ---'
        });

        if (logState._autoSaveTimer) {
            clearInterval(logState._autoSaveTimer);
            logState._autoSaveTimer = null;
        }

        this._saveToStorage(sessionId);
        events.emit(Events.LOG_STOP, { sessionId });
    }

    /**
     * Add an entry (only if logging is active for this session)
     */
    _addEntry(sessionId, type, text) {
        const logState = this.sessions.get(sessionId);
        if (!logState?.active) return;

        logState.entries.push({
            timestamp: Date.now(),
            type,
            text: text || ''
        });

        // Emit for live log viewer
        events.emit(Events.LOG_ENTRY, { sessionId, type, text });
    }

    /**
     * Get log state for a session
     */
    getLog(sessionId) {
        return this.sessions.get(sessionId) || null;
    }

    /**
     * Get all session IDs that have logs
     */
    getLoggedSessions() {
        return [...this.sessions.keys()];
    }

    /**
     * Get entry count for a session
     */
    getEntryCount(sessionId) {
        return this.sessions.get(sessionId)?.entries?.length || 0;
    }

    /**
     * Clear log for a session
     */
    clearLog(sessionId) {
        const logState = this.sessions.get(sessionId);
        if (logState) {
            logState.entries = [];
            logState.startTime = logState.active ? Date.now() : null;
        }
    }

    /**
     * Export log as text
     */
    exportText(sessionId) {
        const log = this.sessions.get(sessionId);
        if (!log || log.entries.length === 0) return null;

        const lines = [];
        lines.push('MUDTERM.IO Session Log');
        lines.push(`Server: ${log.serverName}`);
        lines.push(`Started: ${new Date(log.startTime).toLocaleString()}`);
        if (log.endTime) lines.push(`Ended: ${new Date(log.endTime).toLocaleString()}`);
        lines.push('='.repeat(60));
        lines.push('');

        for (const entry of log.entries) {
            const time = new Date(entry.timestamp).toLocaleTimeString();
            switch (entry.type) {
                case 'input':
                    lines.push(`[${time}] > ${entry.text}`);
                    break;
                case 'output':
                    lines.push(entry.text.replace(/\x1b\[[0-9;]*m/g, ''));
                    break;
                case 'system':
                    lines.push(`[${time}] ${entry.text}`);
                    break;
            }
        }
        return lines.join('\n');
    }

    /**
     * Download log as a file
     */
    download(sessionId, format = 'text') {
        const content = this.exportText(sessionId);
        if (!content) return;

        const log = this.sessions.get(sessionId);
        const date = new Date().toISOString().slice(0, 10);
        const safeName = (log?.serverName || 'session').replace(/[^a-zA-Z0-9]/g, '_');
        const filename = `mudterm_${safeName}_${date}.txt`;

        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    /**
     * Save log metadata to localStorage
     */
    _saveToStorage(sessionId) {
        const log = this.sessions.get(sessionId);
        if (!log) return;

        try {
            const key = `mudterm_log_${sessionId}`;
            localStorage.setItem(key, JSON.stringify({
                serverName: log.serverName,
                startTime: log.startTime,
                endTime: log.endTime,
                entryCount: log.entries.length
            }));
            localStorage.setItem(`${key}_entries`, JSON.stringify(log.entries));
        } catch (e) {
            console.warn('[LOG] Storage save failed:', e.message);
        }
    }
}

export const logger = new Logger();
export default logger;
