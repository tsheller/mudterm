/**
 * Profile Manager
 * Handles connection profiles (saved servers, settings, automation)
 */

import storage, { StorageKeys } from '../core/storage.js';
import { events, Events } from '../core/events.js';

/**
 * Generate a unique ID
 */
function generateId() {
    return 'profile_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

/**
 * Create a default profile structure
 */
function createDefaultProfile(overrides = {}) {
    return {
        id: generateId(),
        name: 'New Connection',
        host: '',
        port: 23,
        ssl: false,
        autoConnect: false,
        
        // User's customizations
        user: {
            layout: null,       // Widget layout
            widgets: [],        // Custom widgets
            aliases: [],        // Aliases
            triggers: [],       // Triggers  
            timers: [],         // Timers
            variables: {},      // Variables
        },
        
        // Server-provided package (cached)
        server: {
            packageId: null,
            packageVersion: null,
            packageName: null,
            layout: null,
            widgets: [],
            aliases: [],
            triggers: [],
            timers: [],
        },
        
        // Merge strategy
        mergeStrategy: 'merge', // 'user' | 'server' | 'merge'
        
        // Connection options
        options: {
            encoding: 'utf-8',
            localEcho: true,
            keepAlive: true,
            reconnect: true,
        },
        
        // Metadata
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastConnected: null,
        
        ...overrides,
    };
}

class ProfileManager {
    constructor() {
        this.profiles = new Map();
        this.activeProfileId = null;
        this.load();
    }
    
    /**
     * Load profiles from storage
     */
    load() {
        const data = storage.get(StorageKeys.PROFILES, {});
        this.profiles = new Map(Object.entries(data));
        this.activeProfileId = storage.get(StorageKeys.ACTIVE_PROFILE, null);
    }
    
    /**
     * Save profiles to storage
     */
    save() {
        const data = Object.fromEntries(this.profiles);
        storage.set(StorageKeys.PROFILES, data);
        storage.set(StorageKeys.ACTIVE_PROFILE, this.activeProfileId);
    }
    
    /**
     * Get all profiles
     * @returns {object[]}
     */
    getAll() {
        return Array.from(this.profiles.values());
    }
    
    /**
     * Get profile by ID
     * @param {string} id 
     * @returns {object|null}
     */
    get(id) {
        return this.profiles.get(id) || null;
    }
    
    /**
     * Get active profile
     * @returns {object|null}
     */
    getActive() {
        return this.activeProfileId ? this.get(this.activeProfileId) : null;
    }
    
    /**
     * Set active profile
     * @param {string} id 
     */
    setActive(id) {
        if (id && !this.profiles.has(id)) {
            console.warn('Profile not found:', id);
            return;
        }
        this.activeProfileId = id;
        this.save();
        events.emit(Events.PROFILE_SELECT, this.get(id));
    }
    
    /**
     * Create a new profile
     * @param {object} data - Profile data
     * @returns {object} Created profile
     */
    create(data = {}) {
        const profile = createDefaultProfile(data);
        this.profiles.set(profile.id, profile);
        this.save();
        return profile;
    }
    
    /**
     * Update a profile
     * @param {string} id - Profile ID
     * @param {object} updates - Fields to update
     * @returns {object|null} Updated profile
     */
    update(id, updates) {
        const profile = this.profiles.get(id);
        if (!profile) return null;
        
        // Deep merge for nested objects
        const updated = {
            ...profile,
            ...updates,
            user: { ...profile.user, ...(updates.user || {}) },
            server: { ...profile.server, ...(updates.server || {}) },
            options: { ...profile.options, ...(updates.options || {}) },
            updatedAt: Date.now(),
        };
        
        this.profiles.set(id, updated);
        this.save();
        events.emit(Events.PROFILE_UPDATE, updated);
        return updated;
    }
    
    /**
     * Delete a profile
     * @param {string} id 
     */
    delete(id) {
        this.profiles.delete(id);
        if (this.activeProfileId === id) {
            this.activeProfileId = null;
        }
        this.save();
    }
    
    /**
     * Duplicate a profile
     * @param {string} id 
     * @returns {object|null} New profile
     */
    duplicate(id) {
        const original = this.get(id);
        if (!original) return null;
        
        const copy = createDefaultProfile({
            ...original,
            id: generateId(),
            name: original.name + ' (Copy)',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            lastConnected: null,
        });
        
        this.profiles.set(copy.id, copy);
        this.save();
        return copy;
    }
    
    /**
     * Mark profile as connected
     * @param {string} id 
     */
    markConnected(id) {
        this.update(id, { lastConnected: Date.now() });
    }
    
    // ==================== Automation Management ====================
    
    /**
     * Add an alias to a profile
     */
    addAlias(profileId, alias) {
        const profile = this.get(profileId);
        if (!profile) return null;
        
        const newAlias = {
            id: 'alias_' + Date.now(),
            pattern: alias.pattern || '',
            replacement: alias.replacement || '',
            enabled: alias.enabled ?? true,
            ...alias,
        };
        
        profile.user.aliases.push(newAlias);
        this.save();
        return newAlias;
    }
    
    /**
     * Update an alias
     */
    updateAlias(profileId, aliasId, updates) {
        const profile = this.get(profileId);
        if (!profile) return null;
        
        const alias = profile.user.aliases.find(a => a.id === aliasId);
        if (!alias) return null;
        
        Object.assign(alias, updates);
        this.save();
        return alias;
    }
    
    /**
     * Remove an alias
     */
    removeAlias(profileId, aliasId) {
        const profile = this.get(profileId);
        if (!profile) return;
        
        profile.user.aliases = profile.user.aliases.filter(a => a.id !== aliasId);
        this.save();
    }
    
    /**
     * Add a trigger to a profile
     */
    addTrigger(profileId, trigger) {
        const profile = this.get(profileId);
        if (!profile) return null;
        
        const newTrigger = {
            id: 'trigger_' + Date.now(),
            pattern: trigger.pattern || '',
            action: trigger.action || '',
            enabled: trigger.enabled ?? true,
            isRegex: trigger.isRegex ?? false,
            caseSensitive: trigger.caseSensitive ?? false,
            ...trigger,
        };
        
        profile.user.triggers.push(newTrigger);
        this.save();
        return newTrigger;
    }
    
    /**
     * Update a trigger
     */
    updateTrigger(profileId, triggerId, updates) {
        const profile = this.get(profileId);
        if (!profile) return null;
        
        const trigger = profile.user.triggers.find(t => t.id === triggerId);
        if (!trigger) return null;
        
        Object.assign(trigger, updates);
        this.save();
        return trigger;
    }
    
    /**
     * Remove a trigger
     */
    removeTrigger(profileId, triggerId) {
        const profile = this.get(profileId);
        if (!profile) return;
        
        profile.user.triggers = profile.user.triggers.filter(t => t.id !== triggerId);
        this.save();
    }
    
    /**
     * Add a timer to a profile
     */
    addTimer(profileId, timer) {
        const profile = this.get(profileId);
        if (!profile) return null;
        
        const newTimer = {
            id: 'timer_' + Date.now(),
            name: timer.name || 'Timer',
            interval: timer.interval || 60000,
            command: timer.command || '',
            enabled: timer.enabled ?? false,
            ...timer,
        };
        
        profile.user.timers.push(newTimer);
        this.save();
        return newTimer;
    }
    
    /**
     * Update a timer
     */
    updateTimer(profileId, timerId, updates) {
        const profile = this.get(profileId);
        if (!profile) return null;
        
        const timer = profile.user.timers.find(t => t.id === timerId);
        if (!timer) return null;
        
        Object.assign(timer, updates);
        this.save();
        return timer;
    }
    
    /**
     * Remove a timer
     */
    removeTimer(profileId, timerId) {
        const profile = this.get(profileId);
        if (!profile) return;
        
        profile.user.timers = profile.user.timers.filter(t => t.id !== timerId);
        this.save();
    }
    
    // ==================== Import/Export ====================
    
    /**
     * Export a profile to JSON
     * @param {string} id 
     * @returns {string} JSON string
     */
    exportProfile(id) {
        const profile = this.get(id);
        if (!profile) return null;
        return JSON.stringify(profile, null, 2);
    }
    
    /**
     * Import a profile from JSON
     * @param {string} json 
     * @returns {object|null} Imported profile
     */
    importProfile(json) {
        try {
            const data = JSON.parse(json);
            // Create new ID to avoid conflicts
            data.id = generateId();
            data.name = data.name + ' (Imported)';
            data.createdAt = Date.now();
            data.updatedAt = Date.now();
            
            const profile = createDefaultProfile(data);
            this.profiles.set(profile.id, profile);
            this.save();
            return profile;
        } catch (err) {
            console.error('Profile import error:', err);
            return null;
        }
    }
    
    /**
     * Export all profiles
     * @returns {string} JSON string
     */
    exportAll() {
        return JSON.stringify(this.getAll(), null, 2);
    }
    
    /**
     * Import profiles from JSON (merge)
     * @param {string} json 
     * @returns {number} Number of imported profiles
     */
    importAll(json) {
        try {
            const profiles = JSON.parse(json);
            let count = 0;
            
            for (const data of profiles) {
                data.id = generateId();
                const profile = createDefaultProfile(data);
                this.profiles.set(profile.id, profile);
                count++;
            }
            
            this.save();
            return count;
        } catch (err) {
            console.error('Profiles import error:', err);
            return 0;
        }
    }
}

// Singleton instance
export const profileManager = new ProfileManager();

export default profileManager;
