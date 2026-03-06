/**
 * Storage Manager - Handles persistence to localStorage + cloud sync
 */

import { state } from './state.js';

const STORAGE_KEY = 'mudterm_state';

// Debounce cloud sync — don't push on every keystroke
let _cloudSyncTimer = null;
function scheduleCloudSync() {
    if (_cloudSyncTimer) clearTimeout(_cloudSyncTimer);
    _cloudSyncTimer = setTimeout(async () => {
        try {
            const { cloudSync } = await import('./cloud-sync.js');
            if (cloudSync.isLoggedIn() && cloudSync.getActiveDeviceSet()) {
                cloudSync.syncConnections().catch(() => {});
            }
        } catch (e) { /* cloud-sync not loaded yet, ignore */ }
    }, 5000);
}

export const storage = {
    save() {
        try {
            const data = {
                connections: state.get('connections', []),
                aliases: state.get('aliases', []),
                triggers: state.get('triggers', []),
                timers: state.get('timers', []),
                widgets: state.get('widgets', []),
                settings: state.get('settings', {})
            };

            // Stamp connections with updatedAt for sync conflict resolution
            const now = new Date().toISOString();
            if (data.connections) {
                for (const conn of data.connections) {
                    conn.updatedAt = now;
                }
            }

            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

            // Mark dirty for cloud sync (inline to avoid circular import)
            localStorage.setItem('mudterm_sync_dirty', '1');
            const v = parseInt(localStorage.getItem('mudterm_sync_version') || '0', 10);
            localStorage.setItem('mudterm_sync_version', String(v + 1));

            scheduleCloudSync();
        } catch (e) {
            console.error('Failed to save state:', e);
        }
    },

    async load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const data = JSON.parse(raw);
                if (data.connections) state.set('connections', data.connections);
                if (data.aliases) state.set('aliases', data.aliases);
                if (data.triggers) state.set('triggers', data.triggers);
                if (data.timers) state.set('timers', data.timers);
                if (data.widgets) state.set('widgets', data.widgets);
                if (data.settings) state.set('settings', data.settings);
            }
            
            // Add default test connections if none exist
            const connections = state.get('connections', []);
            if (connections.length === 0) {
                const defaults = [
		   {
                        id: 'demo-terminal',
                        name: 'Terminal Demo',
                        type: 'direct',
                        url: 'wss://mudterm.com/ws-terminal/',
                        protocol: 'terminal',
                        color: 'cyan',
                        profiles: [{ id: 'default', name: 'Default' }]
                    },
                    {
                        id: 'demo-gmcp',
                        name: 'GMCP Demo',
                        type: 'direct',
                        url: 'wss://mudterm.com/ws/',
                        protocol: 'gmcp',
                        color: 'green',
                        profiles: [{ id: 'default', name: 'Default' }]
                    },
                    {
                        id: 'demo-telnet',
                        name: 'Telnet Demo',
                        type: 'direct',
                        url: 'wss://mudterm.com/ws-telnet/',
                        protocol: 'telnet',
                        color: 'orange',
                        profiles: [{ id: 'default', name: 'Default' }]
                    },
                    {
                        id: 'demo-json',
                        name: 'JSON Demo',
                        type: 'direct',
                        url: 'wss://mudterm.com/ws-json/',
                        protocol: 'json',
                        color: 'magenta',
                        profiles: [{ id: 'default', name: 'Default' }]
                    }
                ];
                state.set('connections', defaults);
                this.save();
                console.log('[STORAGE] Added default test connections');
            }
        } catch (e) {
            console.error('Failed to load state:', e);
        }
    },

    clear() {
        localStorage.removeItem(STORAGE_KEY);
    },

    exportToFile() {
        const data = localStorage.getItem(STORAGE_KEY);
        const blob = new Blob([data || '{}'], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'mudterm-backup.json';
        a.click();
        URL.revokeObjectURL(url);
    },

    async importFromFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const data = JSON.parse(e.target.result);
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
                    this.load();
                    resolve();
                } catch (err) {
                    reject(err);
                }
            };
            reader.onerror = reject;
            reader.readAsText(file);
        });
    }
};

export default storage;
