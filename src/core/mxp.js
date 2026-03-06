/**
 * MXP (MUD eXtension Protocol) Parser
 * ====================================
 * Reference: https://www.zuggsoft.com/zmud/mxp.htm (v1.0 spec)
 *
 * Converts MXP tags in server text into ANSI escape sequences and
 * OSC 8 hyperlinks that xterm.js renders natively.
 *
 * Line mode escapes — ESC[Nz where N is:
 *   0 = open line          (formatting tags only, resets on newline)
 *   1 = secure line        (all tags allowed, resets on newline)
 *   2 = locked line        (no MXP parsing at all, resets on newline)
 *   3 = reset              (close all tags, revert to open default)
 *   4 = temp secure        (secure for next tag only)
 *   5 = lock open          (permanent open mode)
 *   6 = lock secure        (permanent secure — all tags always allowed)
 *   7 = lock locked        (permanent locked — no parsing ever)
 *
 * xterm.js link handling:
 *   OSC 8 ; params ; URI BEL  visible text  OSC 8 ; ; BEL
 *   For MXP <SEND>, we use scheme: http://mudcmd/<encoded-command>
 *   The terminal's linkHandler intercepts this and sends to server.
 *   For MXP <A>, we pass the href directly for browser opening.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let active = false;           // MXP negotiated and enabled
let defaultMode = 'open';     // The persistent default mode (changed by lock modes 5/6/7)
let lineMode = null;          // Per-line override (modes 0/1/2), null = use default
let tempSecure = false;       // Mode 4: secure for next tag only
let noBreak = false;

const vars = {};              // Server-defined entities/variables
const elements = {};          // Custom <!ELEMENT> definitions
const entities = {};          // Custom <!ENTITY> definitions

const cfg = {
    enabled: true,
    links: true,
    colors: true,
    formatting: true,
    images: true,
    sounds: true,
    music: true
};

// ═══════════════════════════════════════════════════════════════════════════════
// ANSI COLOR TABLES
// ═══════════════════════════════════════════════════════════════════════════════

const FG = {
    black: '30', red: '31', green: '32', yellow: '33',
    blue: '34', magenta: '35', cyan: '36', white: '37',
    gray: '90', grey: '90',
    brightred: '91', brightgreen: '92', brightyellow: '93',
    brightblue: '94', brightmagenta: '95', brightcyan: '96',
    brightwhite: '97',
    orange: '38;5;208', pink: '38;5;205', purple: '38;5;129',
    brown: '38;5;94', lime: '38;5;118', aqua: '38;5;51',
    navy: '38;5;17', teal: '38;5;30', olive: '38;5;58',
    maroon: '38;5;52', silver: '38;5;7', gold: '38;5;220'
};

const BG = {
    black: '40', red: '41', green: '42', yellow: '43',
    blue: '44', magenta: '45', cyan: '46', white: '47',
    gray: '100', grey: '100',
    brightred: '101', brightgreen: '102', brightyellow: '103',
    brightblue: '104', brightmagenta: '105', brightcyan: '106',
    brightwhite: '107'
};

// Per MXP spec: SEND, A, IMAGE, SOUND, MUSIC, DEST, VAR and definition
// tags are "secure" — only allowed on secure lines.
// B, I, U, S, H, COLOR, FONT, NOBR, P, BR, SBR are "open" — allowed on any line.
const SECURE_TAGS = new Set([
    'SEND', 'A', 'IMAGE', 'SOUND', 'MUSIC', 'DEST', 'VAR',
    'EXPIRE', 'RELOCATE', 'USER', 'PASSWORD', 'FRAME', 'GAUGE', 'STAT',
    '!ELEMENT', '!EL', '!ATTLIST', '!AT', '!ENTITY', '!EN'
]);

const VOID_TAGS = new Set([
    'BR', 'SBR', 'HR', 'IMAGE', 'SOUND', 'MUSIC', 'VAR',
    'EXPIRE', 'VERSION', 'SUPPORT', 'GAUGE', 'STAT'
]);

// ═══════════════════════════════════════════════════════════════════════════════
// LINE MODE CONTROL (per MXP spec section "MXP Line Tags")
// ═══════════════════════════════════════════════════════════════════════════════

function applyMode(code) {
    tempSecure = false;
    switch (code) {
        case 0:  // Open line — resets on newline
            lineMode = 'open';
            break;
        case 1:  // Secure line — resets on newline
            active = true;
            lineMode = 'secure';
            break;
        case 2:  // Locked line — resets on newline
            lineMode = 'locked';
            break;
        case 3:  // Reset — close all, revert to open default
            defaultMode = 'open';
            lineMode = null;
            break;
        case 4:  // Temp secure — next tag only
            tempSecure = true;
            break;
        case 5:  // Lock open — permanent default
            active = true;
            defaultMode = 'open';
            lineMode = null;
            break;
        case 6:  // Lock secure — permanent default (most servers use this after activation)
            active = true;
            defaultMode = 'secure';
            lineMode = null;
            break;
        case 7:  // Lock locked — permanent default (no parsing)
            defaultMode = 'locked';
            lineMode = null;
            break;
    }
}

function effectiveMode() {
    if (tempSecure) return 'secure';
    return lineMode !== null ? lineMode : defaultMode;
}

function tagAllowed(tagName) {
    if (!active || !cfg.enabled) return false;
    const m = effectiveMode();
    if (m === 'locked') return false;
    if (m === 'secure') return true;
    // Open mode: only non-secure (formatting) tags
    return !SECURE_TAGS.has(tagName.toUpperCase());
}

// ═══════════════════════════════════════════════════════════════════════════════
// ATTRIBUTE PARSING
// ═══════════════════════════════════════════════════════════════════════════════

function parseAttrs(str) {
    if (!str) return {};
    const out = {};
    const re = /(\w+)(?:=(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
    let m;
    while ((m = re.exec(str))) {
        out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? true;
    }
    return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COLOR → ANSI HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function colorToFg(c) {
    if (!c) return null;
    const lc = typeof c === 'string' ? c.toLowerCase() : '';
    if (FG[lc]) return FG[lc];
    if (lc.startsWith('#') && lc.length === 7) {
        const r = parseInt(lc.slice(1, 3), 16);
        const g = parseInt(lc.slice(3, 5), 16);
        const b = parseInt(lc.slice(5, 7), 16);
        return `38;2;${r};${g};${b}`;
    }
    return null;
}

function colorToBg(c) {
    if (!c) return null;
    const lc = typeof c === 'string' ? c.toLowerCase() : '';
    if (BG[lc]) return BG[lc];
    if (lc.startsWith('#') && lc.length === 7) {
        const r = parseInt(lc.slice(1, 3), 16);
        const g = parseInt(lc.slice(3, 5), 16);
        const b = parseInt(lc.slice(5, 7), 16);
        return `48;2;${r};${g};${b}`;
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAG → ANSI/OSC8 RENDERING
// ═══════════════════════════════════════════════════════════════════════════════

function renderOpen(tag, attrs, innerText) {
    switch (tag) {
        // ── Open formatting tags (allowed on any line) ──
        case 'B': case 'BOLD': case 'STRONG':
            return cfg.formatting ? '\x1b[1m' : '';
        case 'I': case 'ITALIC': case 'EM':
            return cfg.formatting ? '\x1b[3m' : '';
        case 'U': case 'UNDERLINE':
            return cfg.formatting ? '\x1b[4m' : '';
        case 'S': case 'STRIKEOUT':
            return cfg.formatting ? '\x1b[9m' : '';
        case 'H': case 'HIGH':
            return cfg.formatting ? '\x1b[1m' : '';  // Bright/bold as "highlight"

        case 'C': case 'COLOR': {
            if (!cfg.colors) return '';
            let fg = attrs.fore || attrs.foreground || attrs.fg || '';
            const bg = attrs.back || attrs.background || attrs.bg || '';
            // Per spec: <C red> — bare word becomes foreground color
            if (!fg) {
                for (const k of Object.keys(attrs)) {
                    if (attrs[k] === true && FG[k.toLowerCase()]) { fg = k; break; }
                }
            }
            const codes = [];
            const f = colorToFg(fg); if (f) codes.push(f);
            const b = colorToBg(bg); if (b) codes.push(b);
            return codes.length ? `\x1b[${codes.join(';')}m` : '';
        }

        case 'FONT': {
            if (!cfg.colors) return '';
            const codes = [];
            const f = colorToFg(attrs.color || attrs.fore || attrs.fgcolor || '');
            const b = colorToBg(attrs.back || attrs.bgcolor || '');
            if (f) codes.push(f);
            if (b) codes.push(b);
            return codes.length ? `\x1b[${codes.join(';')}m` : '';
        }

        // ── Secure tags (require secure line) ──
        case 'SEND': {
            if (!cfg.links) return '';
            // Per spec: href can contain pipe-separated commands for popup menus
            const cmd = attrs.href || attrs.command || innerText || '';
            // xterm.js OSC 8 hyperlink: ESC ] 8 ; ; URI BEL
            return `\x1b]8;;http://mudcmd/${encodeURIComponent(cmd)}\x07`;
        }

        case 'A': {
            if (!cfg.links) return '';
            const href = attrs.href || '#';
            return `\x1b]8;;${href}\x07`;
        }

        // ── Line spacing ──
        case 'BR':    return noBreak ? '' : '\r\n';
        case 'SBR':   return ' ';  // Soft break = space, preferred wrap point
        case 'HR':    return '\r\n' + '─'.repeat(40) + '\r\n';
        case 'P':     return noBreak ? ' ' : '\r\n\r\n';
        case 'NOBR':  noBreak = true; return '';

        // ── Media (per MSP compatibility in spec) ──
        case 'IMAGE': {
            if (!cfg.images) return '';
            const url = attrs.fname || attrs.url || attrs.src || '';
            return url ? `[IMG:${url}]` : '';
        }

        case 'SOUND': {
            if (!cfg.sounds) return '';
            const url = attrs.fname || attrs.src || attrs.url || attrs.u || '';
            if (url && typeof Audio !== 'undefined') {
                try {
                    const a = new Audio(url);
                    a.volume = Math.min(100, Math.max(0, parseInt(attrs.v || attrs.volume || '100'))) / 100;
                    const loops = parseInt(attrs.l || attrs.loops || '1');
                    if (loops === -1) { a.loop = true; }
                    else {
                        let n = 0;
                        a.addEventListener('ended', () => { if (++n < loops) { a.currentTime = 0; a.play(); } });
                    }
                    a.play().catch(() => {});
                } catch (_) {}
            }
            return '';
        }

        case 'MUSIC': {
            if (!cfg.music) return '';
            if ((attrs.c === '0' || attrs.continue === '0') && window._mxpMusic) {
                window._mxpMusic.pause();
                window._mxpMusic = null;
            }
            const url = attrs.fname || attrs.src || attrs.url || attrs.u || '';
            if (url && typeof Audio !== 'undefined') {
                try {
                    const a = new Audio(url);
                    a.volume = Math.min(100, Math.max(0, parseInt(attrs.v || '100'))) / 100;
                    a.loop = parseInt(attrs.l || attrs.loops || '-1') === -1;
                    a.play().catch(() => {});
                    window._mxpMusic = a;
                } catch (_) {}
            }
            return '';
        }

        // ── Variables/Entities ──
        case 'VAR': case 'V': {
            const name = attrs.name || innerText || '';
            if (name) vars[name] = attrs.value || attrs.val || '';
            return '';
        }

        case 'EXPIRE':   return '';
        case 'DEST':     return '';
        case 'VERSION':  return '';
        case 'SUPPORT':  return '';
        case 'GAUGE':    return '';
        case 'STAT':     return '';
        case 'FRAME':    return '';

        default: {
            // Check custom elements defined by server via <!ELEMENT>
            const def = elements[tag];
            if (def && def.definition) return def.definition;
            return '';
        }
    }
}

function renderClose(tag) {
    switch (tag) {
        case 'B': case 'BOLD': case 'STRONG':     return '\x1b[22m';
        case 'I': case 'ITALIC': case 'EM':        return '\x1b[23m';
        case 'U': case 'UNDERLINE':                return '\x1b[24m';
        case 'S': case 'STRIKEOUT':                return '\x1b[29m';
        case 'H': case 'HIGH':                     return '\x1b[22m';
        case 'C': case 'COLOR': case 'FONT':       return '\x1b[39;49m';
        case 'SEND': case 'A':                     return '\x1b]8;;\x07';
        case 'NOBR':  noBreak = false; return '';
        case 'P':     return '';
        default:      return '';
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFINITION TAGS (<!ELEMENT>, <!ATTLIST>, <!ENTITY>)
// ═══════════════════════════════════════════════════════════════════════════════

function handleDefinition(raw) {
    const parts = raw.trim().split(/\s+/);
    const cmd = parts[0].toUpperCase();

    if ((cmd === '!ELEMENT' || cmd === '!EL') && parts[1]) {
        const name = parts[1].toUpperCase();
        const rest = parts.slice(2).join(' ');
        const attrs = parseAttrs(rest);
        // Extract definition string (quoted)
        const defMatch = rest.match(/['"]([^'"]*)['"]/);
        elements[name] = {
            definition: defMatch ? defMatch[1] : (attrs.definition || ''),
            tag: attrs.tag || '',
            flag: attrs.flag || '',
            empty: rest.toUpperCase().includes('EMPTY'),
            open: rest.toUpperCase().includes('OPEN')
        };
    } else if ((cmd === '!ATTLIST' || cmd === '!AT') && parts[1]) {
        const name = parts[1].toUpperCase();
        if (elements[name]) {
            elements[name].attributes = parts.slice(2);
        }
    } else if ((cmd === '!ENTITY' || cmd === '!EN') && parts[1]) {
        const name = parts[1];
        const rest = parts.slice(2).join(' ');
        const valMatch = rest.match(/["']([^"']*)["']/);
        entities[name.toLowerCase()] = valMatch ? valMatch[1] : rest;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTITY EXPANSION (per spec: &name; syntax)
// ═══════════════════════════════════════════════════════════════════════════════

function expandEntity(name) {
    const lc = name.toLowerCase();
    // Standard HTML entities
    if (lc === 'lt') return '<';
    if (lc === 'gt') return '>';
    if (lc === 'amp') return '&';
    if (lc === 'quot') return '"';
    if (lc === 'apos') return "'";
    if (lc === 'nbsp') return ' ';
    // Custom entities from <!ENTITY>
    if (entities[lc] !== undefined) return entities[lc];
    // Server variables from <VAR>
    if (vars[lc] !== undefined) return vars[lc];
    // Numeric character references: &#nnn; or &#xHH;
    if (lc.startsWith('#')) {
        const num = lc.startsWith('#x')
            ? parseInt(lc.slice(2), 16)
            : parseInt(lc.slice(1));
        if (!isNaN(num) && num >= 32) return String.fromCharCode(num);
    }
    return `&${name};`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PARSER
// ═══════════════════════════════════════════════════════════════════════════════

export function parseMXP(text) {
    if (!text || !cfg.enabled) return text;

    let out = '';
    let i = 0;
    const len = text.length;

    while (i < len) {
        // ── ESC [ N z — MXP line mode control ──
        if (text.charCodeAt(i) === 0x1B && i + 1 < len && text[i + 1] === '[') {
            let j = i + 2;
            while (j < len && text[j] >= '0' && text[j] <= '9') j++;
            if (j < len && text[j] === 'z' && j > i + 2) {
                applyMode(parseInt(text.slice(i + 2, j)));
                i = j + 1;
                continue;
            }
            // Not an MXP escape — pass through (could be ANSI)
            out += text[i];
            i++;
            continue;
        }

        const canParse = active && effectiveMode() !== 'locked';

        // ── MXP Tag: <...> ──
        if (canParse && text[i] === '<') {
            const gt = text.indexOf('>', i);
            if (gt === -1) { out += text[i]; i++; continue; }

            const content = text.slice(i + 1, gt);

            // Definition tags: <!ELEMENT ...>, <!ENTITY ...>, etc
            if (content[0] === '!') {
                if (tagAllowed('!ELEMENT')) handleDefinition(content);
                i = gt + 1;
                if (tempSecure) tempSecure = false;
                continue;
            }

            // Closing tag: </TAG>
            if (content[0] === '/') {
                const tag = content.slice(1).trim().split(/\s+/)[0].toUpperCase();
                if (tagAllowed(tag)) {
                    out += renderClose(tag);
                } else {
                    out += text.slice(i, gt + 1);
                }
                i = gt + 1;
                if (tempSecure) tempSecure = false;
                continue;
            }

            // Opening tag
            const selfClose = content.endsWith('/');
            const clean = selfClose ? content.slice(0, -1).trim() : content;
            const sp = clean.indexOf(' ');
            const tag = (sp !== -1 ? clean.slice(0, sp) : clean).toUpperCase();
            const attrStr = sp !== -1 ? clean.slice(sp + 1) : '';
            const attrs = parseAttrs(attrStr);

            if (!tagAllowed(tag)) {
                out += text.slice(i, gt + 1);
                i = gt + 1;
                if (tempSecure) tempSecure = false;
                continue;
            }

            // SEND and A — capture inner content up to closing tag for link text
            if ((tag === 'SEND' || tag === 'A') && !selfClose) {
                // Case-insensitive search for closing tag
                const lowerText = text.toLowerCase();
                const closePat = `</${tag.toLowerCase()}>`;
                let end = lowerText.indexOf(closePat, gt + 1);

                if (end !== -1) {
                    const inner = text.slice(gt + 1, end);
                    if (!attrs.href && !attrs.command) attrs.href = inner.trim();
                    out += renderOpen(tag, attrs, inner);
                    out += inner;
                    out += renderClose(tag);
                    i = end + closePat.length;
                    if (tempSecure) tempSecure = false;
                    continue;
                }
                // No closing tag found — render as self-closing
            }

            out += renderOpen(tag, attrs, '');
            i = gt + 1;
            if (tempSecure) tempSecure = false;
            continue;
        }

        // ── Entity: &name; ──
        if (canParse && text[i] === '&') {
            const semi = text.indexOf(';', i + 1);
            if (semi !== -1 && semi - i < 20) {
                const ent = text.slice(i + 1, semi);
                if (/^[#\w]+$/.test(ent)) {
                    out += expandEntity(ent);
                    i = semi + 1;
                    continue;
                }
            }
        }

        // ── Newline resets per-line mode (modes 0/1/2 revert to default) ──
        if (text[i] === '\n') {
            lineMode = null;
            tempSecure = false;
        }

        out += text[i];
        i++;
    }

    return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API (matches imports expected by session-manager.js)
// ═══════════════════════════════════════════════════════════════════════════════

export function enableMXP() {
    active = true;
    defaultMode = 'open';
}

export function disableMXP() {
    active = false;
    defaultMode = 'open';
    lineMode = null;
    tempSecure = false;
}

export function isMXPEnabled() {
    return active && cfg.enabled;
}

export function getMXPVersion() {
    return '\x1b[1z<VERSION MXP="1.0" CLIENT="MudTerm" VERSION="2.0">\r\n';
}

export function getMXPSupport() {
    const tags = [
        'SEND', 'A', 'B', 'I', 'U', 'S', 'C', 'COLOR', 'FONT',
        'H', 'HIGH', 'BR', 'HR', 'P', 'SBR', 'NOBR',
        'IMAGE', 'SOUND', 'MUSIC', 'VAR', 'EXPIRE',
        'VERSION', 'SUPPORT',
        '!ELEMENT', '!ATTLIST', '!ENTITY'
    ];
    return `\x1b[1z<SUPPORTS ${tags.map(t => '+' + t).join(' ')}>\r\n`;
}

export function setSetting(name, value) {
    if (cfg.hasOwnProperty(name)) cfg[name] = Boolean(value);
}

export function getSetting(name) { return cfg[name]; }
export function getSettings() { return { ...cfg }; }
export function setVariable(name, value) { vars[name] = value; }
export function getVariable(name) { return vars[name]; }
export function getVariables() { return { ...vars }; }

export function stopMusic() {
    if (typeof window !== 'undefined' && window._mxpMusic) {
        window._mxpMusic.pause();
        window._mxpMusic = null;
    }
}

export function reset() {
    active = false;
    defaultMode = 'open';
    lineMode = null;
    tempSecure = false;
    noBreak = false;
    for (const k of Object.keys(elements)) delete elements[k];
    for (const k of Object.keys(entities)) delete entities[k];
    for (const k of Object.keys(vars)) delete vars[k];
    stopMusic();
}

export default {
    parseMXP, enableMXP, disableMXP, isMXPEnabled,
    getMXPVersion, getMXPSupport,
    setSetting, getSetting, getSettings,
    setVariable, getVariable, getVariables,
    stopMusic, reset
};
