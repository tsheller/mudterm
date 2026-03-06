/**
 * Automation Importer
 * ===================
 * Parses Mudlet (.xml) and MUSHclient (.xml/.mcl) automation packages
 * into MudTerm's internal format.
 * 
 * Mudlet format: <MudletPackage> with TriggerPackage, AliasPackage, etc.
 * MUSHclient format: <muclient> with <triggers>, <aliases>, <timers>
 * 
 * This is basic/foundational — covers the core trigger/alias/timer
 * structures. Advanced features (nested groups, Mudlet Lua modules,
 * MUSHclient send_to targets) are mapped to closest equivalents.
 */

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Parse XML string to DOM
 */
function parseXML(xmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'text/xml');
    const error = doc.querySelector('parsererror');
    if (error) {
        throw new Error(`XML parse error: ${error.textContent.slice(0, 200)}`);
    }
    return doc;
}

/**
 * Get text content of a child element
 */
function childText(el, tagName, defaultVal = '') {
    const child = el.querySelector(tagName);
    return child ? child.textContent.trim() : defaultVal;
}

/**
 * Get attribute with default
 */
function attr(el, name, defaultVal = '') {
    return el.getAttribute(name) || defaultVal;
}

// ═══════════════════════════════════════════════════════════════════════
// MUDLET IMPORTER
// ═══════════════════════════════════════════════════════════════════════

/**
 * Mudlet pattern types (from regexCodePropertyList):
 *   0 = substring match
 *   1 = perl regex
 *   2 = begin of line substring
 *   3 = exact match
 *   4 = Lua function
 *   5 = line spacer (N lines)
 *   6 = colour trigger
 */

function parseMudletTrigger(triggerEl, group = 'default') {
    const name = childText(triggerEl, 'name') || 'Imported Trigger';
    const isActive = attr(triggerEl, 'isActive') === 'yes';
    const script = childText(triggerEl, 'script');
    
    // Get patterns
    const patterns = [];
    const patternList = triggerEl.querySelector('regexCodeList');
    const typeList = triggerEl.querySelector('regexCodePropertyList');
    
    if (patternList) {
        const strings = patternList.querySelectorAll('string');
        const types = typeList ? typeList.querySelectorAll('integer') : [];
        
        strings.forEach((strEl, i) => {
            const pattern = strEl.textContent.trim();
            const type = types[i] ? parseInt(types[i].textContent) : 0;
            if (pattern) {
                patterns.push({ pattern, type });
            }
        });
    }

    // Convert to mudterm triggers (one per pattern, since mudterm is 1:1)
    const results = [];
    for (const { pattern, type } of patterns) {
        const trigger = {
            id: generateId(),
            name: name + (patterns.length > 1 ? ` [${results.length + 1}]` : ''),
            pattern: pattern,
            isRegex: type === 1,
            action: script || '',
            actionType: script ? 'script' : 'send',
            enabled: isActive,
            group: group,
            priority: 0,
            keepEvaluating: attr(triggerEl, 'isFilterChain') === 'yes',
            caseSensitive: false,
            multiline: false,
            _imported: 'mudlet'
        };

        // Mudlet type 0 = substring: wrap in regex with .*
        if (type === 0) {
            trigger.pattern = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
            trigger.isRegex = true;
        }
        // Type 2 = begin of line substring
        if (type === 2) {
            trigger.pattern = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
            trigger.isRegex = true;
        }
        // Type 3 = exact match
        if (type === 3) {
            trigger.pattern = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&') + '$';
            trigger.isRegex = true;
        }

        // Mudlet scripts use Lua — tag for conversion
        if (script && trigger.actionType === 'script') {
            trigger._luaScript = true;
        }

        results.push(trigger);
    }

    // If no patterns but has script, still import as empty trigger
    if (results.length === 0 && script) {
        results.push({
            id: generateId(),
            name,
            pattern: '.*',
            isRegex: true,
            action: script,
            actionType: 'script',
            enabled: isActive,
            group,
            _imported: 'mudlet',
            _luaScript: true
        });
    }

    return results;
}

function parseMudletAlias(aliasEl, group = 'default') {
    const name = childText(aliasEl, 'name') || 'Imported Alias';
    const isActive = attr(aliasEl, 'isActive') === 'yes';
    const regex = childText(aliasEl, 'regex');
    const script = childText(aliasEl, 'script');
    const command = childText(aliasEl, 'command');

    return {
        id: generateId(),
        name,
        pattern: regex || name,
        isRegex: !!regex,
        replacement: command || '',
        enabled: isActive,
        group,
        priority: 0,
        _imported: 'mudlet',
        _luaScript: script ? true : false,
        _originalScript: script || null
    };
}

function parseMudletTimer(timerEl, group = 'default') {
    const name = childText(timerEl, 'name') || 'Imported Timer';
    const isActive = attr(timerEl, 'isActive') === 'yes';
    const script = childText(timerEl, 'script');
    const command = childText(timerEl, 'command');

    // Mudlet timers use hour/minute/second/millisecond fields
    const hours = parseInt(childText(timerEl, 'hour', '0')) || 0;
    const minutes = parseInt(childText(timerEl, 'minute', '0')) || 0;
    const seconds = parseInt(childText(timerEl, 'second', '0')) || 0;
    const ms = parseInt(childText(timerEl, 'millisecond', '0')) || 0;

    const interval = ((hours * 3600) + (minutes * 60) + seconds) * 1000 + ms;

    return {
        id: generateId(),
        name,
        interval: interval || 1000,
        action: command || script || '',
        actionType: script ? 'script' : 'send',
        enabled: isActive,
        group,
        oneShot: false,
        _imported: 'mudlet',
        _luaScript: script ? true : false
    };
}

/**
 * Parse a complete Mudlet package XML
 * @param {string} xmlString - Raw XML content
 * @returns {Object} { aliases, triggers, timers, scripts, meta }
 */
export function parseMudletPackage(xmlString) {
    const doc = parseXML(xmlString);
    const result = { aliases: [], triggers: [], timers: [], scripts: [], meta: {} };

    // Package metadata
    const root = doc.querySelector('MudletPackage');
    if (!root) {
        throw new Error('Not a valid Mudlet package (missing <MudletPackage> root)');
    }

    // Triggers
    const triggerPkg = doc.querySelector('TriggerPackage');
    if (triggerPkg) {
        const triggerEls = triggerPkg.querySelectorAll(':scope > Trigger, :scope > TriggerGroup > Trigger');
        triggerEls.forEach(el => {
            // Get group from parent TriggerGroup if present
            const parentGroup = el.parentElement?.tagName === 'TriggerGroup'
                ? childText(el.parentElement, 'name', 'default')
                : 'default';
            result.triggers.push(...parseMudletTrigger(el, parentGroup));
        });
        // Handle TriggerGroups as folders
        const groups = triggerPkg.querySelectorAll(':scope > TriggerGroup');
        groups.forEach(groupEl => {
            const groupName = childText(groupEl, 'name', 'imported');
            groupEl.querySelectorAll(':scope > Trigger').forEach(el => {
                result.triggers.push(...parseMudletTrigger(el, groupName));
            });
        });
    }

    // Aliases
    const aliasPkg = doc.querySelector('AliasPackage');
    if (aliasPkg) {
        aliasPkg.querySelectorAll('Alias').forEach(el => {
            const parentGroup = el.parentElement?.tagName === 'AliasGroup'
                ? childText(el.parentElement, 'name', 'default')
                : 'default';
            result.aliases.push(parseMudletAlias(el, parentGroup));
        });
    }

    // Timers
    const timerPkg = doc.querySelector('TimerPackage');
    if (timerPkg) {
        timerPkg.querySelectorAll('Timer').forEach(el => {
            const parentGroup = el.parentElement?.tagName === 'TimerGroup'
                ? childText(el.parentElement, 'name', 'default')
                : 'default';
            result.timers.push(parseMudletTimer(el, parentGroup));
        });
    }

    // Scripts (Mudlet ScriptPackage = named Lua modules)
    const scriptPkg = doc.querySelector('ScriptPackage');
    if (scriptPkg) {
        scriptPkg.querySelectorAll('Script').forEach(el => {
            const name = childText(el, 'name') || 'Imported Script';
            const code = childText(el, 'script');
            if (code) {
                result.scripts.push({
                    id: generateId(),
                    name,
                    code,
                    enabled: attr(el, 'isActive') === 'yes',
                    group: 'imported',
                    autoRun: false,
                    _imported: 'mudlet',
                    _luaScript: true
                });
            }
        });
    }

    result.meta = {
        source: 'mudlet',
        triggerCount: result.triggers.length,
        aliasCount: result.aliases.length,
        timerCount: result.timers.length,
        scriptCount: result.scripts.length,
        hasLuaScripts: [...result.triggers, ...result.aliases, ...result.timers, ...result.scripts]
            .some(i => i._luaScript)
    };

    return result;
}

// ═══════════════════════════════════════════════════════════════════════
// MUSHCLIENT IMPORTER
// ═══════════════════════════════════════════════════════════════════════

/**
 * MUSHclient send_to targets:
 *   0  = world (send command)
 *   1  = command window
 *   2  = output window
 *   3-5 = notepad windows
 *   12 = script (execute)
 *   13 = speedwalk
 *   14 = variable
 */

function parseMushclientTrigger(triggerEl) {
    const match = attr(triggerEl, 'match');
    const name = attr(triggerEl, 'name') || match || 'Imported Trigger';
    const isRegex = attr(triggerEl, 'regexp') === 'y';
    const enabled = attr(triggerEl, 'enabled') !== 'n';
    const group = attr(triggerEl, 'group', 'default');
    const sendTo = parseInt(attr(triggerEl, 'send_to', '0'));
    const script = attr(triggerEl, 'script');
    const sequence = parseInt(attr(triggerEl, 'sequence', '100'));

    // Get send content
    const sendEl = triggerEl.querySelector('send');
    const sendText = sendEl ? sendEl.textContent.trim() : '';

    let action = sendText;
    let actionType = 'send';

    if (sendTo === 12 || script) {
        actionType = 'script';
        action = sendText || script || '';
    }

    const keepEval = attr(triggerEl, 'keep_evaluating') === 'y';
    const ignoreCase = attr(triggerEl, 'ignore_case') !== 'n';

    return {
        id: generateId(),
        name,
        pattern: match || '.*',
        isRegex,
        action,
        actionType,
        enabled,
        group: group || 'default',
        priority: 1000 - sequence, // MUSHclient: lower sequence = higher priority
        keepEvaluating: keepEval,
        caseSensitive: !ignoreCase,
        multiline: attr(triggerEl, 'multi_line') === 'y',
        lineCount: parseInt(attr(triggerEl, 'lines_to_match', '1')),
        _imported: 'mushclient'
    };
}

function parseMushclientAlias(aliasEl) {
    const match = attr(aliasEl, 'match');
    const name = attr(aliasEl, 'name') || match || 'Imported Alias';
    const isRegex = attr(aliasEl, 'regexp') === 'y';
    const enabled = attr(aliasEl, 'enabled') !== 'n';
    const group = attr(aliasEl, 'group', 'default');
    const sequence = parseInt(attr(aliasEl, 'sequence', '100'));

    const sendEl = aliasEl.querySelector('send');
    const sendText = sendEl ? sendEl.textContent.trim() : '';

    return {
        id: generateId(),
        name,
        pattern: match || name,
        isRegex,
        replacement: sendText,
        enabled,
        group: group || 'default',
        priority: 1000 - sequence,
        _imported: 'mushclient'
    };
}

function parseMushclientTimer(timerEl) {
    const name = attr(timerEl, 'name') || 'Imported Timer';
    const enabled = attr(timerEl, 'enabled') !== 'n';
    const group = attr(timerEl, 'group', 'default');

    const hour = parseInt(attr(timerEl, 'hour', '0')) || 0;
    const minute = parseInt(attr(timerEl, 'minute', '0')) || 0;
    const second = parseFloat(attr(timerEl, 'second', '0')) || 0;
    const interval = ((hour * 3600) + (minute * 60) + second) * 1000;

    const sendEl = timerEl.querySelector('send');
    const sendText = sendEl ? sendEl.textContent.trim() : '';
    const sendTo = parseInt(attr(timerEl, 'send_to', '0'));
    const script = attr(timerEl, 'script');

    let action = sendText;
    let actionType = 'send';
    if (sendTo === 12 || script) {
        actionType = 'script';
        action = sendText || script || '';
    }

    return {
        id: generateId(),
        name,
        interval: interval || 1000,
        action,
        actionType,
        enabled,
        group: group || 'default',
        oneShot: attr(timerEl, 'one_shot') === 'y',
        _imported: 'mushclient'
    };
}

/**
 * Parse a MUSHclient XML file
 * @param {string} xmlString - Raw XML content
 * @returns {Object} { aliases, triggers, timers, scripts, meta }
 */
export function parseMushclientPackage(xmlString) {
    const doc = parseXML(xmlString);
    const result = { aliases: [], triggers: [], timers: [], scripts: [], meta: {} };

    // MUSHclient can have <muclient> or <world> as root
    const root = doc.querySelector('muclient') || doc.querySelector('world') || doc.documentElement;

    // Triggers
    const triggersEl = root.querySelector('triggers');
    if (triggersEl) {
        triggersEl.querySelectorAll('trigger').forEach(el => {
            result.triggers.push(parseMushclientTrigger(el));
        });
    }

    // Aliases
    const aliasesEl = root.querySelector('aliases');
    if (aliasesEl) {
        aliasesEl.querySelectorAll('alias').forEach(el => {
            result.aliases.push(parseMushclientAlias(el));
        });
    }

    // Timers
    const timersEl = root.querySelector('timers');
    if (timersEl) {
        timersEl.querySelectorAll('timer').forEach(el => {
            result.timers.push(parseMushclientTimer(el));
        });
    }

    // Scripts (MUSHclient embeds script blocks)
    const scriptEl = root.querySelector('script');
    if (scriptEl) {
        const code = scriptEl.textContent.trim();
        if (code) {
            result.scripts.push({
                id: generateId(),
                name: 'Imported Script',
                code,
                enabled: true,
                group: 'imported',
                autoRun: true,
                _imported: 'mushclient',
                _language: attr(scriptEl, 'language', 'vbscript')
            });
        }
    }

    result.meta = {
        source: 'mushclient',
        triggerCount: result.triggers.length,
        aliasCount: result.aliases.length,
        timerCount: result.timers.length,
        scriptCount: result.scripts.length
    };

    return result;
}

// ═══════════════════════════════════════════════════════════════════════
// AUTO-DETECT AND PARSE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Auto-detect format and parse
 * @param {string} xmlString - Raw file content
 * @returns {Object} Parsed automation data
 */
export function autoImport(xmlString) {
    const trimmed = xmlString.trim();

    if (trimmed.includes('<MudletPackage') || trimmed.includes('<!DOCTYPE MudletPackage')) {
        return parseMudletPackage(trimmed);
    }

    if (trimmed.includes('<muclient') || trimmed.includes('<world')) {
        return parseMushclientPackage(trimmed);
    }

    // Try JSON (mudterm native format)
    try {
        const data = JSON.parse(trimmed);
        if (data.format === 'mudterm-automation') {
            return {
                ...data.connection,
                meta: { source: 'mudterm', ...data }
            };
        }
        // Plain array of items?
        if (Array.isArray(data)) {
            return {
                aliases: data.filter(i => i.replacement !== undefined),
                triggers: data.filter(i => i.pattern && i.action !== undefined && i.replacement === undefined),
                timers: data.filter(i => i.interval !== undefined),
                scripts: data.filter(i => i.code !== undefined),
                meta: { source: 'json' }
            };
        }
    } catch (e) { /* not JSON */ }

    throw new Error('Unrecognized automation file format. Supports: Mudlet XML, MUSHclient XML, MudTerm JSON.');
}

export default { parseMudletPackage, parseMushclientPackage, autoImport };
