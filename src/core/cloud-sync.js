/**
 * MudTerm Cloud Sync
 * ==================
 * Handles authentication and cloud synchronization with api.illogical.com.
 *
 * STALE SESSION FIX:
 *   The core problem: Desktop left open → Mobile makes changes → Desktop refreshes
 *   → Desktop's stale localStorage overwrites Mobile's newer cloud data.
 *
 *   Solution: Dirty tracking (client) + per-item timestamp merge (server).
 *   - Every local change increments a version counter and sets a dirty flag
 *   - On sync: if NOT dirty (no local edits), do pullOnly — cloud wins entirely
 *   - On sync: if dirty, push local data; server merges per-item by updatedAt
 *     so only genuinely newer items overwrite — stale items are rejected
 *   - On fresh login / re-auth: ALWAYS pull-only (cloud wins)
 *   - Auto-sync pulls if clean, pushes only if dirty
 *
 * AUTH FLOW:
 *   mudterm.com is on a different domain than the API (api.illogical.com)
 *   so we use Bearer tokens, not cookies.
 *   1. User clicks sign-in → redirect to API_URL/auth/:provider?return_url=mudterm.com
 *   2. Server does OAuth dance, creates/links user (same email = same account)
 *   3. Server redirects back to mudterm.com?auth_token=JWT&auth_success=true
 *   4. We store JWT in localStorage, send as Authorization: Bearer on every request
 */

import { API_CONFIG } from './api-config.js';
import { state } from './state.js';
import { storage } from './storage.js';
import { automationStore } from './automation-store.js';
import { events, Events } from './events.js';

// ═══════════════════════════════════════════════════════════════════════
// AUTH STATE
// ═══════════════════════════════════════════════════════════════════════

let authToken = localStorage.getItem(API_CONFIG.STORAGE_KEYS.AUTH_TOKEN);
let authUser = null;
let syncInterval = null;
let activeDeviceSet = null;

// Cloud-only connection cache — connections that live on the server,
// separate from local state.  Populated by fetchCloudConnections().
let _cloudConnections = [];
let _cloudIds = new Set();

// ═══════════════════════════════════════════════════════════════════════
// DIRTY TRACKING — prevents stale sessions from overwriting cloud data
//
// How it works:
//   markDirty() is called whenever the user makes a local change
//   (saving connections, editing automations, etc.)
//   If dirty=false when sync fires, we know nothing changed locally
//   and can safely pull cloud state without pushing stale data.
//
//   Even when dirty IS true and we push, the server does a per-item
//   timestamp merge — it only accepts items whose updatedAt is newer
//   than what the server already has. So a stale desktop with an old
//   connection can never overwrite a connection edited on mobile.
// ═══════════════════════════════════════════════════════════════════════

const DIRTY_KEY = 'mudterm_sync_dirty';
const LOCAL_VERSION_KEY = 'mudterm_sync_version';

function markDirty() {
    localStorage.setItem(DIRTY_KEY, '1');
    // Bump version so server can compare
    const v = parseInt(localStorage.getItem(LOCAL_VERSION_KEY) || '0', 10);
    localStorage.setItem(LOCAL_VERSION_KEY, String(v + 1));
}

function clearDirty() {
    localStorage.removeItem(DIRTY_KEY);
}

function isDirty() {
    return localStorage.getItem(DIRTY_KEY) === '1';
}

function getLocalVersion() {
    return parseInt(localStorage.getItem(LOCAL_VERSION_KEY) || '0', 10);
}

// ═══════════════════════════════════════════════════════════════════════
// HTTP HELPERS
// ═══════════════════════════════════════════════════════════════════════

function getHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (authToken) h['Authorization'] = `Bearer ${authToken}`;
    return h;
}

async function api(method, path, body = null) {
    const opts = { method, headers: getHeaders() };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${API_CONFIG.API_URL}${path}`, opts);

    if (res.status === 401) {
        cloudSync.signOut();
        events.emit('cloud:auth-expired');
        throw new Error('Session expired — please sign in again');
    }

    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `API ${res.status}`);
    }

    return res.json();
}

// ═══════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════

function checkAuthRedirect() {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('auth_token');
    const error = params.get('auth_error');

    if (token) {
        authToken = token;
        localStorage.setItem(API_CONFIG.STORAGE_KEYS.AUTH_TOKEN, token);
        window.history.replaceState({}, '', window.location.pathname);
        return true;
    }
    if (error) {
        console.error('[CloudSync] Auth error:', error);
        events.emit('cloud:auth-error', { error });
        window.history.replaceState({}, '', window.location.pathname);
    }
    return false;
}

/**
 * Build the return URL that the API server will redirect back to
 * after OAuth completes. This must be the current origin so we
 * land back on mudterm.com (or localhost during dev).
 */
function getReturnUrl() {
    return encodeURIComponent(window.location.origin + window.location.pathname);
}

// ═══════════════════════════════════════════════════════════════════════
// DEVICE SETS
// ═══════════════════════════════════════════════════════════════════════

async function loadDeviceSets() {
    const data = await api('GET', API_CONFIG.MUDTERM.DEVICE_SETS);
    return data.sets || [];
}

async function createDeviceSet(name, deviceType = 'desktop', description = '') {
    const data = await api('POST', API_CONFIG.MUDTERM.DEVICE_SETS, { name, device_type: deviceType, description });
    return data.set;
}

async function updateDeviceSet(setId, updates) {
    const data = await api('PUT', `${API_CONFIG.MUDTERM.DEVICE_SETS}/${setId}`, updates);
    return data.set;
}

async function deleteDeviceSet(setId) {
    return api('DELETE', `${API_CONFIG.MUDTERM.DEVICE_SETS}/${setId}`);
}

async function cloneDeviceSet(sourceSetId, newName, newDeviceType) {
    const data = await api('POST', API_CONFIG.MUDTERM.CLONE_SET(sourceSetId), { name: newName, device_type: newDeviceType });
    return data.set;
}

// ═══════════════════════════════════════════════════════════════════════
// SYNC — CONNECTIONS
// ═══════════════════════════════════════════════════════════════════════

async function syncConnections(setId, forcePull = false) {
    const pullOnly = forcePull || !isDirty();

    if (pullOnly) {
        // No local changes — just pull cloud state, don't risk overwriting
        console.log('[CloudSync] Connections: pull-only (no local changes)');
        const data = await api('POST', API_CONFIG.MUDTERM.CONNECTIONS_SYNC(setId), {
            connections: [],
            pullOnly: true
        });

        if (data.connections && Array.isArray(data.connections) && data.connections.length > 0) {
            state.set('connections', data.connections);
            storage.save();
        }
        return data;
    }

    // Local changes exist — bidirectional sync with timestamps
    // The server will merge per-item by updatedAt so stale items
    // from this client cannot overwrite newer server items.
    console.log('[CloudSync] Connections: bidirectional (local changes detected)');
    const localConnections = state.get('connections', []);

    // Stamp connections that don't have updatedAt
    const now = new Date().toISOString();
    for (const conn of localConnections) {
        if (!conn.updatedAt) conn.updatedAt = now;
    }

    const data = await api('POST', API_CONFIG.MUDTERM.CONNECTIONS_SYNC(setId), {
        connections: localConnections,
        lastSync: localStorage.getItem(API_CONFIG.STORAGE_KEYS.LAST_SYNC) || null
    });

    if (data.connections && Array.isArray(data.connections)) {
        state.set('connections', data.connections);
        storage.save();
    }

    return data;
}

// ═══════════════════════════════════════════════════════════════════════
// SYNC — AUTOMATIONS
// ═══════════════════════════════════════════════════════════════════════

function gatherAllAutomationKeys() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('mudterm_auto_')) {
            keys.push(key);
        }
    }
    return keys;
}

function gatherAutomationData() {
    const entries = {};
    const keys = gatherAllAutomationKeys();
    const now = new Date().toISOString();
    for (const key of keys) {
        try {
            const parsed = JSON.parse(localStorage.getItem(key));
            // Stamp with _updatedAt so server can compare
            if (parsed && !parsed._updatedAt) {
                parsed._updatedAt = now;
            }
            entries[key] = parsed;
        } catch (e) { /* skip corrupt */ }
    }
    return entries;
}

async function syncAutomations(setId, forcePull = false) {
    const pullOnly = forcePull || !isDirty();

    if (pullOnly) {
        // No local changes — pull cloud state only
        console.log('[CloudSync] Automations: pull-only (no local changes)');
        const data = await api('POST', API_CONFIG.MUDTERM.AUTOMATIONS_SYNC(setId), {
            automations: {},
            pullOnly: true
        });

        if (data.automations && typeof data.automations === 'object') {
            const existingKeys = gatherAllAutomationKeys();
            const cloudKeys = new Set(Object.keys(data.automations));

            // Write cloud data locally
            for (const [key, value] of Object.entries(data.automations)) {
                localStorage.setItem(key, JSON.stringify(value));
            }

            // Remove local keys missing from cloud (deleted on another device)
            for (const key of existingKeys) {
                if (!cloudKeys.has(key)) {
                    localStorage.removeItem(key);
                }
            }

            automationStore.clearCache();
        }

        return data;
    }

    // Local changes — bidirectional sync
    // Server merges per-key by _updatedAt timestamp
    console.log('[CloudSync] Automations: bidirectional (local changes detected)');
    const localData = gatherAutomationData();
    const data = await api('POST', API_CONFIG.MUDTERM.AUTOMATIONS_SYNC(setId), {
        automations: localData,
        lastSync: localStorage.getItem(API_CONFIG.STORAGE_KEYS.LAST_SYNC) || null
    });

    if (data.automations && typeof data.automations === 'object') {
        for (const [key, value] of Object.entries(data.automations)) {
            localStorage.setItem(key, JSON.stringify(value));
        }
        automationStore.clearCache();
    }

    return data;
}

// ═══════════════════════════════════════════════════════════════════════
// FULL SYNC
// ═══════════════════════════════════════════════════════════════════════

async function fullSync(setId = null, forcePull = false) {
    if (!authToken) return null;

    const sid = setId || activeDeviceSet?.id;
    if (!sid) {
        console.warn('[CloudSync] No active device set for sync');
        return null;
    }

    const mode = forcePull ? 'pull-only' : (isDirty() ? 'bidirectional' : 'pull-only');
    console.log(`[CloudSync] fullSync mode=${mode} dirty=${isDirty()} version=${getLocalVersion()}`);
    events.emit('cloud:sync-start', { mode });

    try {
        const [connResult, autoResult] = await Promise.all([
            syncConnections(sid, forcePull),
            syncAutomations(sid, forcePull)
        ]);

        localStorage.setItem(API_CONFIG.STORAGE_KEYS.LAST_SYNC, new Date().toISOString());
        clearDirty();
        events.emit('cloud:sync-complete', { connections: connResult, automations: autoResult, mode });

        return { connections: connResult, automations: autoResult };
    } catch (e) {
        console.error('[CloudSync] Sync failed:', e.message);
        events.emit('cloud:sync-error', { error: e.message });
        throw e;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// SWITCH DEVICE SET
// ═══════════════════════════════════════════════════════════════════════

async function switchDeviceSet(setId) {
    if (!authToken) return;

    // Save current state first — only if dirty
    if (activeDeviceSet && isDirty()) {
        try { await fullSync(activeDeviceSet.id); } catch (e) { /* best effort */ }
    }

    const sets = await loadDeviceSets();
    const set = sets.find(s => s.id === setId);
    if (!set) throw new Error('Device set not found');

    activeDeviceSet = set;
    localStorage.setItem(API_CONFIG.STORAGE_KEYS.ACTIVE_DEVICE_SET, setId);

    // Always pull-only when switching sets
    const connData = await api('POST', API_CONFIG.MUDTERM.CONNECTIONS_SYNC(setId), {
        connections: [],
        pullOnly: true
    });

    if (connData.connections && Array.isArray(connData.connections)) {
        state.set('connections', connData.connections);
        storage.save();
    }

    const autoData = await api('POST', API_CONFIG.MUDTERM.AUTOMATIONS_SYNC(setId), {
        automations: {},
        pullOnly: true
    });

    if (autoData.automations) {
        const existingKeys = gatherAllAutomationKeys();
        for (const key of existingKeys) {
            localStorage.removeItem(key);
        }
        for (const [key, value] of Object.entries(autoData.automations)) {
            localStorage.setItem(key, JSON.stringify(value));
        }
        automationStore.clearCache();
    }

    clearDirty();
    events.emit('cloud:device-set-changed', { set });
    return set;
}

// ═══════════════════════════════════════════════════════════════════════
// EXPORT / IMPORT
// ═══════════════════════════════════════════════════════════════════════

async function exportAll() {
    return api('POST', API_CONFIG.MUDTERM.EXPORT);
}

async function importAll(packageData) {
    return api('POST', API_CONFIG.MUDTERM.IMPORT, packageData);
}

// ═══════════════════════════════════════════════════════════════════════
// AUTO-SYNC TIMER
// ═══════════════════════════════════════════════════════════════════════

function startAutoSync(intervalMs = 60000) {
    stopAutoSync();
    syncInterval = setInterval(() => {
        if (authToken && activeDeviceSet) {
            fullSync().catch(e => console.warn('[CloudSync] Auto-sync failed:', e.message));
        }
    }, intervalMs);
}

function stopAutoSync() {
    if (syncInterval) {
        clearInterval(syncInterval);
        syncInterval = null;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════

export const cloudSync = {
    isLoggedIn() { return !!authToken; },
    getUser() { return authUser; },
    getToken() { return authToken; },

    signInWithGoogle() {
        window.location.href = `${API_CONFIG.API_URL}${API_CONFIG.AUTH.GOOGLE}?return_url=${getReturnUrl()}`;
    },
    signInWithGitHub() {
        window.location.href = `${API_CONFIG.API_URL}${API_CONFIG.AUTH.GITHUB}?return_url=${getReturnUrl()}`;
    },
    signInWithDiscord() {
        window.location.href = `${API_CONFIG.API_URL}${API_CONFIG.AUTH.DISCORD}?return_url=${getReturnUrl()}`;
    },

    signOut() {
        // Push any pending local changes before signing out
        if (isDirty() && activeDeviceSet) {
            fullSync(activeDeviceSet.id).catch(() => {});
        }
        authToken = null;
        authUser = null;
        activeDeviceSet = null;
        localStorage.removeItem(API_CONFIG.STORAGE_KEYS.AUTH_TOKEN);
        localStorage.removeItem(API_CONFIG.STORAGE_KEYS.AUTH_USER);
        localStorage.removeItem(API_CONFIG.STORAGE_KEYS.ACTIVE_DEVICE_SET);
        clearDirty();
        stopAutoSync();
        events.emit('cloud:signed-out');
    },

    async fetchUser() {
        if (!authToken) return null;
        try {
            const data = await api('GET', API_CONFIG.AUTH.ME);
            authUser = data;
            localStorage.setItem(API_CONFIG.STORAGE_KEYS.AUTH_USER, JSON.stringify(authUser));
            return authUser;
        } catch (e) {
            console.warn('[CloudSync] Failed to fetch user:', e.message);
            return null;
        }
    },

    // ── Dirty tracking (call from UI/storage when user makes changes) ──
    markDirty,
    isDirty,
    getLocalVersion,

    // ── Device Sets ──
    getActiveDeviceSet() { return activeDeviceSet; },
    loadDeviceSets,
    createDeviceSet,
    updateDeviceSet,
    deleteDeviceSet,
    cloneDeviceSet,
    switchDeviceSet,

    // ── Sync ──
    fullSync,
    syncConnections: () => activeDeviceSet ? syncConnections(activeDeviceSet.id) : null,
    syncAutomations: () => activeDeviceSet ? syncAutomations(activeDeviceSet.id) : null,

    // ── Cloud Connections (separate from local state) ──
    getCloudConnections() { return _cloudConnections; },
    isCloudConnection(id) { return _cloudIds.has(id); },

    async fetchCloudConnections() {
        if (!authToken || !activeDeviceSet) { _cloudConnections = []; _cloudIds.clear(); return []; }
        try {
            const data = await api('POST', API_CONFIG.MUDTERM.CONNECTIONS_SYNC(activeDeviceSet.id), {
                connections: [],
                pullOnly: true
            });
            _cloudConnections = (data.connections && Array.isArray(data.connections)) ? data.connections : [];
            _cloudIds = new Set(_cloudConnections.map(c => c.id));
            return _cloudConnections;
        } catch (e) {
            console.error('[CloudSync] fetchCloudConnections failed:', e.message);
            return _cloudConnections;
        }
    },

    async moveToCloud(connId) {
        if (!authToken || !activeDeviceSet) throw new Error('Not logged in');
        const localConns = state.get('connections', []);
        const conn = localConns.find(c => c.id === connId);
        if (!conn) throw new Error('Connection not found in local state');

        // Stamp updatedAt so server merge accepts it
        const now = new Date().toISOString();
        if (!conn.updatedAt) conn.updatedAt = now;

        // Push just this connection to server — server merges with existing
        await api('POST', API_CONFIG.MUDTERM.CONNECTIONS_SYNC(activeDeviceSet.id), {
            connections: [..._cloudConnections, conn]
        });

        // Remove from local state
        const updated = localConns.filter(c => c.id !== connId);
        state.set('connections', updated);
        storage.save();

        // Refresh cloud cache
        await this.fetchCloudConnections();
        events.emit('cloud:connection-moved', { connId });
        return conn;
    },

    // ── Export / Import ──
    exportAll,
    importAll,

    // ── Google Drive Backup ──
    async backupToGoogleDrive() {
        if (!authToken) throw new Error('Not logged in');
        const data = await api('POST', API_CONFIG.MUDTERM.GDRIVE_BACKUP);
        events.emit('cloud:gdrive-backup-complete', data);
        return data;
    },

    async listGoogleDriveBackups() {
        if (!authToken) throw new Error('Not logged in');
        return api('GET', API_CONFIG.MUDTERM.GDRIVE_LIST);
    },

    async restoreFromGoogleDrive(fileId) {
        if (!authToken) throw new Error('Not logged in');
        const data = await api('POST', API_CONFIG.MUDTERM.GDRIVE_RESTORE, { fileId });
        if (data.restored) {
            await storage.load();
            automationStore.clearCache();
            events.emit('cloud:gdrive-restore-complete', data);
        }
        return data;
    },

    async downloadGoogleDriveBackup(fileId) {
        const backups = await this.listGoogleDriveBackups();
        const file = backups.files?.find(f => f.id === fileId);
        if (!file) throw new Error('Backup not found');
        const data = await api('POST', API_CONFIG.MUDTERM.GDRIVE_RESTORE, { fileId, downloadOnly: true });
        const blob = new Blob([JSON.stringify(data.data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mudterm-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        return data;
    },

    // ── Initialization ──
    async init() {
        const justLoggedIn = checkAuthRedirect();

        if (!authToken) {
            console.log('[CloudSync] Not logged in — local-only mode');
            return;
        }

        const user = await this.fetchUser();
        if (!user) {
            console.log('[CloudSync] Token invalid — clearing');
            this.signOut();
            return;
        }

        console.log(`[CloudSync] Logged in as ${user.display_name || user.email}`);
        events.emit('cloud:signed-in', { user });

        try {
            const sets = await loadDeviceSets();

            if (sets.length === 0) {
                // First time — create default set and push local data
                const defaultSet = await createDeviceSet('Default', 'desktop', 'Default configuration');
                activeDeviceSet = defaultSet;
                localStorage.setItem(API_CONFIG.STORAGE_KEYS.ACTIVE_DEVICE_SET, defaultSet.id);
                markDirty(); // Force push on first sync
                await fullSync(defaultSet.id);
            } else {
                const lastSetId = localStorage.getItem(API_CONFIG.STORAGE_KEYS.ACTIVE_DEVICE_SET);
                const lastSet = sets.find(s => s.id === lastSetId);
                const defaultSet = sets.find(s => s.is_default) || sets[0];
                activeDeviceSet = lastSet || defaultSet;
                localStorage.setItem(API_CONFIG.STORAGE_KEYS.ACTIVE_DEVICE_SET, activeDeviceSet.id);

                if (justLoggedIn) {
                    // Fresh login — ALWAYS pull cloud data (cloud wins)
                    console.log('[CloudSync] Fresh login — forcing pull-only');
                    await fullSync(activeDeviceSet.id, true);
                } else {
                    // Returning session — smart sync based on dirty flag
                    await fullSync(activeDeviceSet.id);
                }
            }

            events.emit('cloud:device-sets-loaded', { sets, active: activeDeviceSet });
        } catch (e) {
            console.error('[CloudSync] Init sync failed:', e.message);
            events.emit('cloud:sync-error', { error: e.message });
        }

        // Populate cloud connection cache for grid display
        await this.fetchCloudConnections();

        startAutoSync();
    }
};

export default cloudSync;
