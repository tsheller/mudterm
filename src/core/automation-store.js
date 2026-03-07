/**
 * src/core/automation-store.js
 */

const STORAGE_PREFIX = 'mudterm_auto_';

// Widget layouts are stored separately from automations so they can be
// synced per device-set while automations stay shared across all sets.
export const LAYOUT_PREFIX = 'mudterm_layout_';

function emptySet() {
    return { aliases: [], triggers: [], timers: [], scripts: [] };
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

class AutomationStore {
    constructor() {
        this._cache = new Map();
    }

    _connKey(connectionId) { return `${STORAGE_PREFIX}${connectionId}`; }
    _profKey(connectionId, profileId) { return `${STORAGE_PREFIX}${connectionId}_${profileId}`; }
    _layoutKey(connectionId, profileId = null) {
        return profileId
            ? `${LAYOUT_PREFIX}${connectionId}_${profileId}`
            : `${LAYOUT_PREFIX}${connectionId}`;
    }

    _load(key) {
        if (this._cache.has(key)) return this._cache.get(key);
        try {
            const raw = localStorage.getItem(key);
            const data = raw ? JSON.parse(raw) : emptySet();
            if (!data.aliases)  data.aliases  = [];
            if (!data.triggers) data.triggers = [];
            if (!data.timers)   data.timers   = [];
            if (!data.scripts)  data.scripts  = [];
            this._cache.set(key, data);
            return data;
        } catch (e) {
            const data = emptySet();
            this._cache.set(key, data);
            return data;
        }
    }

    _save(key, data) {
        this._cache.set(key, data);
        try {
            localStorage.setItem(key, JSON.stringify(data));
        } catch (e) {
            console.warn(`[AutoStore] Failed to save ${key}:`, e.message);
        }
    }

    getConnectionData(connectionId) { return this._load(this._connKey(connectionId)); }
    saveConnectionData(connectionId, data) { this._save(this._connKey(connectionId), data); }
    getProfileData(connectionId, profileId) { return this._load(this._profKey(connectionId, profileId)); }
    saveProfileData(connectionId, profileId, data) { this._save(this._profKey(connectionId, profileId), data); }

    // ── Widget Layout (stored separately from automations) ──

    getWidgetLayout(connectionId, profileId = null) {
        const key = this._layoutKey(connectionId, profileId);
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            const data = JSON.parse(raw);
            return Array.isArray(data) ? data : (data.layout ?? null);
        } catch (e) { return null; }
    }

    saveWidgetLayout(connectionId, profileId = null, layout) {
        const key = this._layoutKey(connectionId, profileId);
        try {
            localStorage.setItem(key, JSON.stringify({
                layout,
                _updatedAt: new Date().toISOString()
            }));
        } catch (e) {
            console.warn(`[AutoStore] Failed to save layout ${key}:`, e.message);
        }
    }

    getMerged(connectionId, profileId = null) {
        const connData = this.getConnectionData(connectionId);
        if (!profileId) {
            return {
                aliases:  connData.aliases.map(a  => ({ ...a,  _source: 'connection' })),
                triggers: connData.triggers.map(t => ({ ...t, _source: 'connection' })),
                timers:   connData.timers.map(t   => ({ ...t, _source: 'connection' })),
                scripts:  connData.scripts.map(s  => ({ ...s, _source: 'connection' })),
            };
        }
        const profData = this.getProfileData(connectionId, profileId);
        const result = {};
        for (const type of ['aliases', 'triggers', 'timers', 'scripts']) {
            const profById = new Map((profData[type] || []).map(i => [i.id, i]));
            const merged = [];
            for (const item of (connData[type] || [])) {
                if (profById.has(item.id)) {
                    merged.push({ ...profById.get(item.id), _source: 'profile-override' });
                    profById.delete(item.id);
                } else {
                    merged.push({ ...item, _source: 'connection' });
                }
            }
            for (const [, item] of profById) {
                merged.push({ ...item, _source: 'profile' });
            }
            result[type] = merged;
        }
        return result;
    }

    addItem(type, item, connectionId, profileId = null) {
        const data = profileId
            ? this.getProfileData(connectionId, profileId)
            : this.getConnectionData(connectionId);
        if (!data[type]) data[type] = [];
        const withId = { ...item, id: item.id || generateId() };
        data[type].push(withId);
        if (profileId) {
            this.saveProfileData(connectionId, profileId, data);
        } else {
            this.saveConnectionData(connectionId, data);
        }
        return withId;
    }

    deleteItem(type, id, connectionId, profileId = null) {
        const data = profileId
            ? this.getProfileData(connectionId, profileId)
            : this.getConnectionData(connectionId);
        if (!data[type]) return;
        data[type] = data[type].filter(item => item.id !== id);
        if (profileId) {
            this.saveProfileData(connectionId, profileId, data);
        } else {
            this.saveConnectionData(connectionId, data);
        }
    }

    updateItem(type, id, patch, connectionId, profileId = null) {
        const data = profileId
            ? this.getProfileData(connectionId, profileId)
            : this.getConnectionData(connectionId);
        if (!data[type]) return;
        const item = data[type].find(i => i.id === id);
        if (item) Object.assign(item, patch);
        if (profileId) {
            this.saveProfileData(connectionId, profileId, data);
        } else {
            this.saveConnectionData(connectionId, data);
        }
    }

    deleteItem(type, id, connectionId, profileId = null) {
        const data = profileId
            ? this.getProfileData(connectionId, profileId)
            : this.getConnectionData(connectionId);
        if (!data[type]) return;
        data[type] = data[type].filter(item => item.id !== id);
        if (profileId) {
            this.saveProfileData(connectionId, profileId, data);
        } else {
            this.saveConnectionData(connectionId, data);
        }
    }

    updateItem(type, id, updates, connectionId, profileId = null) {
        const data = profileId
            ? this.getProfileData(connectionId, profileId)
            : this.getConnectionData(connectionId);
        if (!data[type]) return;
        const idx = data[type].findIndex(item => item.id === id);
        if (idx === -1) return;
        data[type][idx] = { ...data[type][idx], ...updates };
        if (profileId) {
            this.saveProfileData(connectionId, profileId, data);
        } else {
            this.saveConnectionData(connectionId, data);
        }
    }

    copyFrom(source, target) {
        const sourceData = source.profileId
            ? this.getProfileData(source.connectionId, source.profileId)
            : this.getConnectionData(source.connectionId);
        const targetData = target.profileId
            ? this.getProfileData(target.connectionId, target.profileId)
            : this.getConnectionData(target.connectionId);
        for (const type of ['aliases', 'triggers', 'timers', 'scripts']) {
            const copied = (sourceData[type] || []).map(item => ({
                ...JSON.parse(JSON.stringify(item)),
                id: generateId(),
                _copiedFrom: item.id
            }));
            if (!targetData[type]) targetData[type] = [];
            targetData[type].push(...copied);
        }
        if (target.profileId) {
            this.saveProfileData(target.connectionId, target.profileId, targetData);
        } else {
            this.saveConnectionData(target.connectionId, targetData);
        }
    }

    clearCache() { this._cache.clear(); }
}

export const automationStore = new AutomationStore();
export default automationStore;
