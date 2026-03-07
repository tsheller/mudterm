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
        this._timerHandles = new Map(); // id → intervalId

        this.aliases = new ScopedCommandProcessor(sessionId);
        this.triggers = new Map(); // id → trigger obj
        this.timers   = new Map(); // id → timer obj

        this._loadData();
    }

    _loadData() {
        const merged = automationStore.getMerged(this.connectionId, this.profileId);
        this._storedData = merged;

        for (const alias of (merged.aliases || [])) {
            this.aliases.registerAlias(alias);
        }
        for (const trigger of (merged.triggers || [])) {
            this._registerTrigger(trigger);
        }
        for (const timer of (merged.timers || [])) {
            this._registerTimer(timer);
        }

        console.log(`[AutomationSet] loaded: ${merged.aliases.length} aliases, ${(merged.triggers||[]).length} triggers, ${(merged.timers||[]).length} timers`);
    }

    // ── Triggers ────────────────────────────────────────────────────

    _compilePattern(pattern, isRegex) {
        if (isRegex) {
            try { return new RegExp(pattern, 'i'); } catch (e) { return null; }
        }
        const r = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '(.*)').replace(/\?/g, '(.)');
        return new RegExp(r, 'i');
    }

    _registerTrigger(trigger) {
        const compiled = {
            id: trigger.id || generateId(),
            name: trigger.name || '',
            pattern: trigger.pattern || '',
            regex: this._compilePattern(trigger.pattern || '', trigger.isRegex),
            isRegex: trigger.isRegex || false,
            action: trigger.action || '',
            actionType: trigger.actionType || 'send',
            enabled: trigger.enabled !== false,
            group: trigger.group || 'default',
            priority: trigger.priority || 0,
            keepEvaluating: trigger.keepEvaluating || false,
            caseSensitive: trigger.caseSensitive || false,
            _source: trigger._source || 'manual'
        };
        this.triggers.set(compiled.id, compiled);
    }

    registerTrigger(trigger) {
        this._registerTrigger(trigger);
    }

    unregisterTrigger(id) {
        this.triggers.delete(id);
    }

    setTriggerEnabled(id, enabled) {
        const t = this.triggers.get(id);
        if (t) t.enabled = enabled;
    }

    exportTriggers() {
        return [...this.triggers.values()].map(t => ({
            id: t.id, name: t.name, pattern: t.pattern, isRegex: t.isRegex,
            action: t.action, actionType: t.actionType, enabled: t.enabled,
            group: t.group, priority: t.priority, keepEvaluating: t.keepEvaluating,
            caseSensitive: t.caseSensitive
        }));
    }

    // Called with each line of incoming server text
    processLine(line) {
        const stripped = line.replace(/\x1b\[[0-9;]*m/g, ''); // strip ANSI
        const sorted = [...this.triggers.values()].sort((a, b) => b.priority - a.priority);
        for (const t of sorted) {
            if (!t.enabled || !t.regex) continue;
            const match = stripped.match(t.regex);
            if (match) {
                if (t.actionType === 'send' && t.action) {
                    const cmd = t.action.replace(/\$(\d+)/g, (_, n) =>
                        match[parseInt(n)] !== undefined ? match[parseInt(n)] : _
                    );
                    if (this._send) this._send(cmd);
                }
                if (!t.keepEvaluating) break;
            }
        }
    }

    // ── Timers ──────────────────────────────────────────────────────

    _registerTimer(timer) {
        const compiled = {
            id: timer.id || generateId(),
            name: timer.name || '',
            interval: timer.interval || 1000,
            action: timer.action || '',
            actionType: timer.actionType || 'send',
            enabled: timer.enabled !== false,
            group: timer.group || 'default',
            oneShot: timer.oneShot || false,
            _source: timer._source || 'manual'
        };
        this.timers.set(compiled.id, compiled);
        if (compiled.enabled) this._startTimer(compiled);
    }

    _startTimer(timer) {
        this._stopTimer(timer.id);
        if (!timer.enabled || !timer.action) return;
        const fn = () => {
            if (timer.actionType === 'send' && this._send) {
                this._send(timer.action);
            }
            if (timer.oneShot) {
                this._stopTimer(timer.id);
                timer.enabled = false;
            }
        };
        const handle = timer.oneShot
            ? setTimeout(fn, timer.interval)
            : setInterval(fn, timer.interval);
        this._timerHandles.set(timer.id, handle);
    }

    _stopTimer(id) {
        const handle = this._timerHandles.get(id);
        if (handle != null) {
            clearInterval(handle);
            clearTimeout(handle);
            this._timerHandles.delete(id);
        }
    }

    registerTimer(timer) {
        this._registerTimer(timer);
    }

    unregisterTimer(id) {
        this._stopTimer(id);
        this.timers.delete(id);
    }

    setTimerEnabled(id, enabled) {
        const t = this.timers.get(id);
        if (!t) return;
        t.enabled = enabled;
        if (enabled) {
            this._startTimer(t);
        } else {
            this._stopTimer(id);
        }
    }

    exportTimers() {
        return [...this.timers.values()].map(t => ({
            id: t.id, name: t.name, interval: t.interval,
            action: t.action, actionType: t.actionType, enabled: t.enabled,
            group: t.group, oneShot: t.oneShot
        }));
    }

    // ── Core ────────────────────────────────────────────────────────

    reload() {
        this.aliases.clear();
        this.triggers.clear();
        for (const id of [...this._timerHandles.keys()]) this._stopTimer(id);
        this.timers.clear();
        automationStore.clearCache();
        this._loadData();
    }

    processInput(input) {
        return this.aliases.process(input);
    }

    save() {
        const data = {
            aliases:  this.aliases.exportAll(),
            triggers: this.exportTriggers(),
            timers:   this.exportTimers(),
            scripts:  this._storedData?.scripts || []
        };
        if (this._storedData?.widgets) data.widgets = this._storedData.widgets;
        if (this.profileId) {
            automationStore.saveProfileData(this.connectionId, this.profileId, data);
        } else {
            automationStore.saveConnectionData(this.connectionId, data);
        }
        this._storedData = data;
    }

    destroy() {
        for (const unsub of this._unsubs) {
            if (typeof unsub === 'function') unsub();
        }
        this._unsubs = [];
        this.aliases.clear();
        this.triggers.clear();
        for (const id of this._timerHandles.keys()) {
            this._stopTimer(id);
        }
        this.timers.clear();
    }
}

export { AutomationSet, ScopedCommandProcessor };
export default AutomationSet;
