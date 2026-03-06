/**
 * src/core/automation-store.js
 */

const STORAGE_PREFIX = 'mudterm_auto_';

function emptySet() {
    return { aliases: [] };
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

    _load(key) {
        if (this._cache.has(key)) return this._cache.get(key);
        try {
            const raw = localStorage.getItem(key);
            const data = raw ? JSON.parse(raw) : emptySet();
            if (!data.aliases) data.aliases = [];
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

    getMerged(connectionId, profileId = null) {
        const connData = this.getConnectionData(connectionId);
        if (!profileId) {
            return { aliases: connData.aliases.map(a => ({ ...a, _source: 'connection' })) };
        }
        const profData = this.getProfileData(connectionId, profileId);
        const profById = new Map(profData.aliases.map(i => [i.id, i]));
        const result = [];
        for (const item of connData.aliases) {
            if (profById.has(item.id)) {
                result.push({ ...profById.get(item.id), _source: 'profile-override' });
                profById.delete(item.id);
            } else {
                result.push({ ...item, _source: 'connection' });
            }
        }
        for (const [, item] of profById) {
            result.push({ ...item, _source: 'profile' });
        }
        return { aliases: result };
    }

    copyFrom(source, target) {
        const sourceData = source.profileId
            ? this.getProfileData(source.connectionId, source.profileId)
            : this.getConnectionData(source.connectionId);
        const targetData = target.profileId
            ? this.getProfileData(target.connectionId, target.profileId)
            : this.getConnectionData(target.connectionId);
        const copied = (sourceData.aliases || []).map(item => ({
            ...JSON.parse(JSON.stringify(item)),
            id: generateId(),
            _copiedFrom: item.id
        }));
        targetData.aliases.push(...copied);
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
