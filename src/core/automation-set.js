/**
 * src/core/automation-set.js
 */

import { events, Events } from './events.js';
import { automationStore } from './automation-store.js';

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

class ScopedCommandProcessor {
    constructor(sessionId) {
        this.sessionId = sessionId;
        this.aliases = new Map();
        this.enabled = true;
    }

    registerAlias(alias) {
        const compiled = {
            id: alias.id || generateId(),
            name: alias.name || '',
            pattern: alias.pattern,
            regex: this._compilePattern(alias.pattern, alias.isRegex),
            replacement: alias.replacement || '',
            isRegex: alias.isRegex || false,
            enabled: alias.enabled !== false,
            group: alias.group || 'default',
            priority: alias.priority || 0,
            _source: alias._source || 'manual'
        };
        this.aliases.set(compiled.id, compiled);
        this._sort();
    }

    unregisterAlias(id) { this.aliases.delete(id); }

    process(input) {
        if (!this.enabled) return [input];
        const commands = this._split(input);
        const results = [];
        for (const cmd of commands) {
            const expanded = this._expand(cmd.trim());
            if (Array.isArray(expanded)) results.push(...expanded);
            else results.push(expanded);
        }
        return results;
    }

    _expand(command) {
        for (const [id, alias] of this.aliases) {
            if (!alias.enabled || !alias.regex) continue;
            const match = command.match(alias.regex);
            if (match) {
                const expanded = alias.replacement.replace(/\$(\d+)/g, (_, n) =>
                    match[parseInt(n)] !== undefined ? match[parseInt(n)] : _
                );
                events.emit(Events.ALIAS_EXPANDED, {
                    sessionId: this.sessionId, aliasId: id,
                    original: command, expanded
                });
                return expanded;
            }
        }
        return command;
    }

    _split(input) {
        return input.split(';').map(s => s.trim()).filter(Boolean);
    }

    _compilePattern(pattern, isRegex) {
        if (isRegex) {
            try { return new RegExp(pattern, 'i'); } catch (e) { return null; }
        }
        let r = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '(.*)').replace(/\?/g, '(.)');
        return new RegExp(`^${r}$`, 'i');
    }

    _sort() {
        const sorted = [...this.aliases.entries()].sort((a, b) => b[1].priority - a[1].priority);
        this.aliases = new Map(sorted);
    }

    setEnabled(id, enabled) {
        const a = this.aliases.get(id);
        if (a) a.enabled = enabled;
    }

    clear() { this.aliases.clear(); }

    exportAll() {
        return [...this.aliases.values()].map(a => ({
            id: a.id, name: a.name, pattern: a.pattern, replacement: a.replacement,
            isRegex: a.isRegex, enabled: a.enabled, group: a.group, priority: a.priority
        }));
    }
}

class AutomationSet {
    constructor(sessionId, connection, profile, sendFn, echoFn) {
        this.sessionId = sessionId;
        this.connectionId = connection.id;
        this.profileId = profile?.id || null;
        this._send = sendFn;
        this._echo = echoFn;
        this._unsubs = [];
        this.aliases = new ScopedCommandProcessor(sessionId);
        this._loadData();
    }

    _loadData() {
        const merged = automationStore.getMerged(this.connectionId, this.profileId);
        this._storedData = merged;
        for (const alias of merged.aliases) {
            this.aliases.registerAlias(alias);
        }
    }

    processInput(input) {
        return this.aliases.process(input);
    }

    save() {
        const data = { aliases: this.aliases.exportAll() };
        if (this.profileId) {
            automationStore.saveProfileData(this.connectionId, this.profileId, data);
        } else {
            automationStore.saveConnectionData(this.connectionId, data);
        }
    }

    destroy() {
        for (const unsub of this._unsubs) {
            if (typeof unsub === 'function') unsub();
        }
        this._unsubs = [];
        this.aliases.clear();
    }
}

export { AutomationSet, ScopedCommandProcessor };
export default AutomationSet;
