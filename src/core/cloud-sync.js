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
import { automationStore, LAYOUT_PREFIX } from './automation-store.js';
import { events, Events } from './events.js';

// ═══════════════════════════════════════════════════════════════════════
// AUTH STATE
// ═══════════════════════════════════════════════════════════════════════

let authToken = localStorage.getItem(API_CONFIG.STORAGE_KEYS.AUTH_TOKEN);
let authUser = null;
let syncInterval = null;
let activeDeviceSet = null;

// The "shared set" is the canonical device set for automations (aliases,
// triggers, scripts, timers).  All devices sync automations to/from this
// single set so they stay identical everywhere.  Widget layouts, by
// contrast, are synced per active device set so each device can have its
// own UI layout.
//
// sharedSetId is populated on init() from the stored SHARED_SET key, or
// falls back to the default/first device set.
let sharedSetId = localStorage.getItem(API_CONFIG.STORAGE_KEYS.SHARED_SET) || null;

const AUTO_PREFIX = 'mudterm_auto_';

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
    const token = authToken;
    if (token) h['Authorization'] = `Bearer ${token}`;
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
        // No local changes — pull cloud state and merge, preserving local-only connections.
        console.log('[CloudSync] Connections: pull-only (no local changes)');
        const data = await api('POST', API_CONFIG.MUDTERM.CONNECTIONS_SYNC(setId), {
            connections: [],
            pullOnly: true
        });

        if (data.connections && Array.isArray(data.connections)) {
            const cloudIds = new Set(data.connections.map(c => c.id));
            // Keep any connection not known to the cloud (truly local)
            const localOnly = state.get('connections', []).filter(c => !cloudIds.has(c.id));
            state.set('connections', [...localOnly, ...data.connections]);
            storage.save();
            // Update cloud caches so renderConnections can divide correctly
            _cloudConnections = data.connections;
            _cloudIds = cloudIds;
        }
        return data;
    }

    // Local changes exist — bidirectional sync with timestamps.
    // Only send cloud-tracked connections to the server; local-only stay untouched.
    console.log('[CloudSync] Connections: bidirectional (local changes detected)');
    const allConnections = state.get('connections', []);

    // Split: connections the server already knows about vs truly local-only
    const knownToCloud = allConnections.filter(c => _cloudIds.has(c.id) || _cloudIds.size === 0);
    const localOnly    = allConnections.filter(c => !_cloudIds.has(c.id) && _cloudIds.size > 0);

    // Stamp connections that don't have updatedAt
    const now = new Date().toISOString();
    for (const conn of knownToCloud) {
        if (!conn.updatedAt) conn.updatedAt = now;
    }

    const data = await api('POST', API_CONFIG.MUDTERM.CONNECTIONS_SYNC(setId), {
        connections: knownToCloud,
        lastSync: localStorage.getItem(API_CONFIG.STORAGE_KEYS.LAST_SYNC) || null
    });

    if (data.connections && Array.isArray(data.connections)) {
        // Merge: local-only connections stay, cloud connections come from server response
        state.set('connections', [...localOnly, ...data.connections]);
        storage.save();
        // Update cloud caches so renderConnections can divide correctly
        _cloudConnections = data.connections;
        _cloudIds = new Set(data.connections.map(c => c.id));
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
        // Only gather automation keys (mudterm_auto_*), NOT layout keys.
        // Layouts live in mudterm_layout_* and sync separately per device set.
        if (key && key.startsWith(AUTO_PREFIX)) {
            keys.push(key);
        }
    }
    return keys;
}

function gatherAllLayoutKeys() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(LAYOUT_PREFIX)) {
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

function gatherLayoutData() {
    const entries = {};
    const keys = gatherAllLayoutKeys();
    const now = new Date().toISOString();
    for (const key of keys) {
        try {
            const parsed = JSON.parse(localStorage.getItem(key));
            if (parsed && !parsed._updatedAt) {
                parsed._updatedAt = now;
            }
            entries[key] = parsed;
        } catch (e) { /* skip corrupt */ }
    }
    return entries;
}

// ═══════════════════════════════════════════════════════════════════════
// SYNC — AUTOMATIONS (shared across all device sets)
//
// Automations (aliases, triggers, scripts, timers) are the same on every
// device.  They always sync to/from sharedSetId regardless of which
// device set is currently active.  This means editing an alias on mobile
// is immediately available on desktop after the next sync.
// ═══════════════════════════════════════════════════════════════════════

async function syncAutomations(forcePull = false) {
    const sid = sharedSetId;
    if (!sid) {
        console.warn('[CloudSync] Automations: no shared set ID — skipping');
        return null;
    }

    const pullOnly = forcePull || !isDirty();

    if (pullOnly) {
        console.log('[CloudSync] Automations: pull-only from shared set', sid);
        const data = await api('POST', API_CONFIG.MUDTERM.AUTOMATIONS_SYNC(sid), {
            automations: {},
            pullOnly: true
        });

        if (data.automations && typeof data.automations === 'object') {
            const existingKeys = gatherAllAutomationKeys();
            // Only accept keys that belong to automations (not layouts)
            const cloudAutoKeys = new Set(
                Object.keys(data.automations).filter(k => k.startsWith(AUTO_PREFIX))
            );

            for (const [key, value] of Object.entries(data.automations)) {
                if (key.startsWith(AUTO_PREFIX)) {
                    localStorage.setItem(key, JSON.stringify(value));
                }
            }

            for (const key of existingKeys) {
                if (!cloudAutoKeys.has(key)) {
                    localStorage.removeItem(key);
                }
            }

            automationStore.clearCache();
        }

        return data;
    }

    console.log('[CloudSync] Automations: bidirectional with shared set', sid);
    const localData = gatherAutomationData();
    const data = await api('POST', API_CONFIG.MUDTERM.AUTOMATIONS_SYNC(sid), {
        automations: localData,
        lastSync: localStorage.getItem(API_CONFIG.STORAGE_KEYS.LAST_SYNC) || null
    });

    if (data.automations && typeof data.automations === 'object') {
        for (const [key, value] of Object.entries(data.automations)) {
            if (key.startsWith(AUTO_PREFIX)) {
                localStorage.setItem(key, JSON.stringify(value));
            }
        }
        automationStore.clearCache();
    }

    return data;
}

// ═══════════════════════════════════════════════════════════════════════
// SYNC — LAYOUTS (per device set)
//
// Widget layouts (mudterm_layout_*) are device-specific — each set can
// have completely different widget arrangements.  They sync to/from the
// active device set's endpoint, separate from automations.
// ═══════════════════════════════════════════════════════════════════════

async function syncLayouts(setId, forcePull = false) {
    if (!setId) return null;

    const pullOnly = forcePull || !isDirty();

    if (pullOnly) {
        console.log('[CloudSync] Layouts: pull-only from set', setId);
        const data = await api('POST', API_CONFIG.MUDTERM.AUTOMATIONS_SYNC(setId), {
            automations: {},
            pullOnly: true
        });

        if (data.automations && typeof data.automations === 'object') {
            const existingKeys = gatherAllLayoutKeys();
            const cloudLayoutKeys = new Set(
                Object.keys(data.automations).filter(k => k.startsWith(LAYOUT_PREFIX))
            );

            for (const [key, value] of Object.entries(data.automations)) {
                if (key.startsWith(LAYOUT_PREFIX)) {
                    localStorage.setItem(key, JSON.stringify(value));
                }
            }

            // Remove local layout keys that no longer exist in this device set
            for (const key of existingKeys) {
                if (!cloudLayoutKeys.has(key)) {
                    localStorage.removeItem(key);
                }
            }
        }

        return data;
    }

    console.log('[CloudSync] Layouts: bidirectional with set', setId);
    const localData = gatherLayoutData();
    const data = await api('POST', API_CONFIG.MUDTERM.AUTOMATIONS_SYNC(setId), {
        automations: localData,
        lastSync: localStorage.getItem(API_CONFIG.STORAGE_KEYS.LAST_SYNC) || null
    });

    if (data.automations && typeof data.automations === 'object') {
        for (const [key, value] of Object.entries(data.automations)) {
            if (key.startsWith(LAYOUT_PREFIX)) {
                localStorage.setItem(key, JSON.stringify(value));
            }
        }
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
    console.log(`[CloudSync] fullSync mode=${mode} layoutSet=${sid} sharedSet=${sharedSetId} dirty=${isDirty()} version=${getLocalVersion()}`);
    events.emit('cloud:sync-start', { mode });

    try {
        // Connections and layouts are device-set-specific.
        // Automations are shared — always sync to sharedSetId.
        const [connResult, autoResult, layoutResult] = await Promise.all([
            syncConnections(sid, forcePull),
            syncAutomations(forcePull),
            syncLayouts(sid, forcePull)
        ]);

        localStorage.setItem(API_CONFIG.STORAGE_KEYS.LAST_SYNC, new Date().toISOString());
        clearDirty();
        events.emit('cloud:sync-complete', { connections: connResult, automations: autoResult, mode });

        return { connections: connResult, automations: autoResult, layouts: layoutResult };
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

    // Pull connections for the new device set
    const connData = await api('POST', API_CONFIG.MUDTERM.CONNECTIONS_SYNC(setId), {
        connections: [],
        pullOnly: true
    });

    if (connData.connections && Array.isArray(connData.connections)) {
        state.set('connections', connData.connections);
        storage.save();
    }

    // Pull ONLY layouts from the new device set.
    // Automations (aliases/triggers/scripts) are shared and do NOT change
    // when switching sets — that is the whole point of this architecture.
    await syncLayouts(setId, true);

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
        localStorage.setItem('mudterm_auth_provider', 'google');
        window.location.href = `${API_CONFIG.API_URL}${API_CONFIG.AUTH.GOOGLE}?return_url=${getReturnUrl()}`;
    },
    signInWithGitHub() {
        localStorage.setItem('mudterm_auth_provider', 'github');
        window.location.href = `${API_CONFIG.API_URL}${API_CONFIG.AUTH.GITHUB}?return_url=${getReturnUrl()}`;
    },
    signInWithDiscord() {
        localStorage.setItem('mudterm_auth_provider', 'discord');
        window.location.href = `${API_CONFIG.API_URL}${API_CONFIG.AUTH.DISCORD}?return_url=${getReturnUrl()}`;
    },

    signOut() {
        // Push any pending local changes before signing out
        if (isDirty() && activeDeviceSet) {
            fullSync(activeDeviceSet.id).catch(() => {});
        }
        // Tell the server to invalidate the session
        if (authToken) {
            fetch(`${API_CONFIG.API_URL}${API_CONFIG.AUTH.LOGOUT}`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${authToken}` }
            }).catch(() => {});
        }
        authToken = null;
        authUser = null;
        activeDeviceSet = null;
        // Remove cloud-only connections from local state — locally-moved connections
        // were already written without a cloud ID so they'll be unaffected.
        const localOnly = state.get('connections', []).filter(c => !_cloudIds.has(c.id));
        state.set('connections', localOnly);
        storage.save();
        _cloudConnections = [];
        _cloudIds.clear();
        localStorage.removeItem(API_CONFIG.STORAGE_KEYS.AUTH_TOKEN);
        localStorage.removeItem(API_CONFIG.STORAGE_KEYS.AUTH_USER);
        localStorage.removeItem(API_CONFIG.STORAGE_KEYS.ACTIVE_DEVICE_SET);
        localStorage.removeItem('mudterm_auth_provider');
        clearDirty();
        stopAutoSync();
        events.emit('cloud:signed-out');
    },

    async fetchUser() {
        if (!authToken) return null;
        try {
            const data = await api('GET', API_CONFIG.AUTH.ME);

            // Determine which provider was used for this login.
            // The stamped value (set before OAuth redirect) is the most reliable signal.
            // Fall back to providers[0] only if nothing was stamped.
            const stampedProvider = localStorage.getItem('mudterm_auth_provider');
            const knownProviders = (data.providers || []).map(p => p.provider);
            let resolvedProvider = null;
            if (stampedProvider && knownProviders.includes(stampedProvider)) {
                resolvedProvider = stampedProvider;
            } else if (knownProviders.length > 0) {
                resolvedProvider = knownProviders[0];
            }
            // Clear the stamp now that we've consumed it
            localStorage.removeItem('mudterm_auth_provider');

            authUser = { ...data, provider: resolvedProvider };
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
    getSharedSetId() { return sharedSetId; },
    loadDeviceSets,
    createDeviceSet,
    updateDeviceSet,
    deleteDeviceSet,
    cloneDeviceSet,
    switchDeviceSet,

    // ── Sync ──
    fullSync,
    syncConnections: () => activeDeviceSet ? syncConnections(activeDeviceSet.id) : null,
    syncAutomations: () => syncAutomations(),
    syncLayouts: () => activeDeviceSet ? syncLayouts(activeDeviceSet.id) : null,

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
                sharedSetId = defaultSet.id;
                localStorage.setItem(API_CONFIG.STORAGE_KEYS.ACTIVE_DEVICE_SET, defaultSet.id);
                localStorage.setItem(API_CONFIG.STORAGE_KEYS.SHARED_SET, defaultSet.id);
                markDirty(); // Force push on first sync
                await fullSync(defaultSet.id);
            } else {
                const lastSetId = localStorage.getItem(API_CONFIG.STORAGE_KEYS.ACTIVE_DEVICE_SET);
                const lastSet = sets.find(s => s.id === lastSetId);
                const defaultSet = sets.find(s => s.is_default) || sets[0];
                activeDeviceSet = lastSet || defaultSet;
                localStorage.setItem(API_CONFIG.STORAGE_KEYS.ACTIVE_DEVICE_SET, activeDeviceSet.id);

                // Establish the shared set for automations.
                // Use the stored SHARED_SET if it still exists, otherwise fall back
                // to the default set.  The shared set never changes once set —
                // it is always the canonical home for alias/trigger/script data.
                const storedSharedId = localStorage.getItem(API_CONFIG.STORAGE_KEYS.SHARED_SET);
                const storedSharedSet = sets.find(s => s.id === storedSharedId);
                sharedSetId = (storedSharedSet || defaultSet).id;
                localStorage.setItem(API_CONFIG.STORAGE_KEYS.SHARED_SET, sharedSetId);

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
