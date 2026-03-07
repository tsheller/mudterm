/**
 * MudTerm Screen Reader
 * =====================
 * Accessibility layer for MUD output. Two complementary modes:
 *
 * 1. ARIA Live Region (PRIMARY — for external screen readers)
 *    Creates a visually-hidden DOM element with aria-live="polite".
 *    All MUD output is piped into it as clean plain text.
 *    External screen readers (NVDA, JAWS, VoiceOver, TalkBack, Narrator)
 *    detect and announce this automatically — no configuration required.
 *
 * 2. Built-in TTS (SECONDARY — for mobile / users without a screen reader)
 *    Uses the browser's Web Speech API (speechSynthesis).
 *    Opt-in, off by default. Designed for mobile MUD players who don't
 *    have a desktop screen reader installed.
 *
 * Both modes share the same text cleaning pipeline:
 *  - Strips ANSI/VT100 escape codes
 *  - Strips MXP/HTML tags
 *  - Strips MUD color codes
 *  - Detects and skips ASCII art, maps, borders (symbol density heuristic)
 *  - Announces skipped graphic blocks as "Graphic content omitted"
 *
 * Controls: injected into the settings modal via injectScreenReaderSettings().
 * Storage:  persisted to localStorage under 'mudterm_screen_reader'.
 *
 * Browser support for ARIA live regions: all modern browsers.
 * Browser support for built-in TTS: Chrome, Edge, Firefox, Safari.
 *   Chrome: requires utterance chunking (handled automatically).
 *   Firefox: voices load async (handled via onvoiceschanged).
 *   Brave: may block TTS; degrades gracefully with warning.
 */

import { events, Events } from './events.js';

// ─── Storage ──────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'mudterm_screen_reader';

const DEFAULTS = {
    enabled:     false,  // Screen Reader Mode master switch
    builtinTts:  false,  // Built-in TTS (secondary, opt-in)
    rate:        1.0,
    pitch:       1.0,
    volume:      1.0,
    voiceURI:    null,
    punctuation: 'some'  // 'all' | 'some' | 'none'
};

// ─── Text cleaning ────────────────────────────────────────────────────────────

const RE_ANSI        = /\x1b\[[0-9;]*[mABCDEFGHJKLMnsuhrfil]/g;
const RE_OSC         = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const RE_MXP         = /<[^>]{0,200}>/g;
const RE_MUD_COLORS  = /[&^{|][a-zA-Z0-9]/g;
const RE_BLANK       = /^\s*$/;

const SYMBOL_CHARS              = /[|+\-=*/<>[\]{}()#@&%^~`\\]/g;
const SYMBOL_DENSITY_THRESHOLD  = 0.35;
const MIN_LINE_LEN_FOR_DENSITY  = 5;
const RE_REPEATED_SYMBOL        = /^(.)\1{4,}$/;
const RE_MAP_LINE               = /^[\s|+\-=*#@.oO0]{4,}$/;
const CONSECUTIVE_SKIP_ANNOUNCE = 3;

const SYMBOL_NAMES = {
    '|':'pipe', '+':'plus', '-':'dash', '_':'underscore', '=':'equals',
    '*':'star', '/':'slash', '\\':'backslash', '<':'less-than',
    '>':'greater-than', '[':'left bracket', ']':'right bracket',
    '{':'left brace', '}':'right brace', '(':'left paren', ')':'right paren',
    '#':'hash', '@':'at', '&':'and', '%':'percent', '^':'caret', '~':'tilde',
    '`':'backtick', '"':'quote', "'":"apostrophe", ',':'comma', '.':'period',
    ':':'colon', ';':'semicolon', '!':'exclamation', '?':'question mark',
    '$':'dollar'
};
const SILENT_SOME = new Set([',', ';', ':', '!', '?', '"', "'"]);

// ─── ScreenReader class ───────────────────────────────────────────────────────

class ScreenReader {
    constructor() {
        this._settings           = { ...DEFAULTS };
        this._unsubs             = [];
        this._voices             = [];
        this._voicesLoaded       = false;
        this._ttsQueue           = [];
        this._ttsSpeaking        = false;
        this._consecutiveSkipped = 0;
        this._liveRegion         = null;
        this._liveBuffer         = '';
        this._liveTimer          = null;

        this._loadSettings();
        this._initVoices();
        if (this._settings.enabled) this._activate();
    }

    // ── Settings ──────────────────────────────────────────────────────────────

    _loadSettings() {
        try {
            const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            Object.assign(this._settings, s);
        } catch (e) {}
    }

    _saveSettings() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this._settings)); } catch (e) {}
    }

    get enabled()    { return this._settings.enabled; }
    get builtinTts() { return this._settings.builtinTts; }
    getSettings()    { return { ...this._settings }; }

    // ── Enable / disable ──────────────────────────────────────────────────────

    enable() {
        if (this._settings.enabled) return;
        this._settings.enabled = true;
        this._saveSettings();
        this._activate();
        events.emit('screenreader:change', { enabled: true });
    }

    disable() {
        if (!this._settings.enabled) return;
        this._settings.enabled = false;
        this._saveSettings();
        this._deactivate();
        events.emit('screenreader:change', { enabled: false });
    }

    toggle() {
        this._settings.enabled ? this.disable() : this.enable();
        return this._settings.enabled;
    }

    enableBuiltinTts() {
        this._settings.builtinTts = true;
        this._saveSettings();
        this._initVoices();
        events.emit('screenreader:change', { builtinTts: true });
    }

    disableBuiltinTts() {
        this._settings.builtinTts = false;
        this._saveSettings();
        this.stopTts();
        events.emit('screenreader:change', { builtinTts: false });
    }

    toggleBuiltinTts() {
        this._settings.builtinTts ? this.disableBuiltinTts() : this.enableBuiltinTts();
        return this._settings.builtinTts;
    }

    // ── Activation ────────────────────────────────────────────────────────────

    _activate() {
        this._createLiveRegion();
        this._subscribe();
        this._pushToLiveRegion('Screen reader mode enabled. MUD output will be announced.');
    }

    _deactivate() {
        this._unsubscribe();
        this.stopTts();
        this._destroyLiveRegion();
    }

    _subscribe() {
        const unsub = events.on(Events.CONNECTION_DATA, ({ type, data }) => {
            if (type !== 'text') return;
            this._handleOutput(data);
        });
        this._unsubs.push(unsub);
    }

    _unsubscribe() {
        this._unsubs.forEach(fn => fn());
        this._unsubs = [];
    }

    // ── ARIA live region ──────────────────────────────────────────────────────
    //
    // The primary mechanism for external screen reader support.
    // role="log" + aria-live="polite" causes NVDA, JAWS, VoiceOver, TalkBack,
    // and Narrator to automatically announce DOM mutations to this element.
    // The element is visually hidden but present in the accessibility tree.

    _createLiveRegion() {
        if (this._liveRegion) return;
        const el = document.createElement('div');
        el.id = 'mudterm-sr-live';
        el.setAttribute('role', 'log');
        el.setAttribute('aria-live', 'polite');
        el.setAttribute('aria-relevant', 'additions');
        el.setAttribute('aria-label', 'MUD output');
        // Visually hidden via SR-only clip pattern (not display:none which removes from a11y tree)
        el.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);clip-path:inset(50%);white-space:nowrap;border:0;padding:0;margin:-1px;';
        document.body.appendChild(el);
        this._liveRegion = el;
    }

    _destroyLiveRegion() {
        if (this._liveTimer) clearTimeout(this._liveTimer);
        if (this._liveRegion) { this._liveRegion.remove(); this._liveRegion = null; }
        this._liveBuffer = '';
    }

    _pushToLiveRegion(text) {
        if (!this._liveRegion || !text) return;
        // Batch into 50ms windows to avoid SR spam on walls of text
        this._liveBuffer += (this._liveBuffer ? '\n' : '') + text;
        if (this._liveTimer) clearTimeout(this._liveTimer);
        this._liveTimer = setTimeout(() => {
            if (!this._liveRegion || !this._liveBuffer) return;
            const p = document.createElement('p');
            p.textContent = this._liveBuffer;
            this._liveRegion.appendChild(p);
            // Cap region at 50 paragraphs to prevent unbounded growth
            while (this._liveRegion.children.length > 50) {
                this._liveRegion.removeChild(this._liveRegion.firstChild);
            }
            this._liveBuffer = '';
            this._liveTimer = null;
        }, 50);
    }

    // ── Text processing pipeline ──────────────────────────────────────────────

    _handleOutput(raw) {
        const lines = raw.split('\n');
        for (const line of lines) {
            const clean = this._cleanLine(line);
            if (!clean) continue;
            if (this._isVisualNoise(clean)) {
                this._consecutiveSkipped++;
                if (this._consecutiveSkipped === CONSECUTIVE_SKIP_ANNOUNCE) {
                    this._deliver('Graphic content omitted.');
                }
                continue;
            }
            this._consecutiveSkipped = 0;
            const spoken = this._expandPunctuation(clean);
            if (spoken.trim()) this._deliver(spoken);
        }
    }

    _cleanLine(line) {
        return line
            .replace(RE_ANSI, '').replace(RE_OSC, '')
            .replace(RE_MXP, '').replace(RE_MUD_COLORS, '')
            .trim();
    }

    _isVisualNoise(line) {
        if (RE_BLANK.test(line)) return true;
        if (line.length < MIN_LINE_LEN_FOR_DENSITY) return false;
        if (RE_REPEATED_SYMBOL.test(line)) return true;
        if (RE_MAP_LINE.test(line)) return true;
        const symbols = (line.match(SYMBOL_CHARS) || []).length;
        return (symbols / line.length) >= SYMBOL_DENSITY_THRESHOLD;
    }

    _expandPunctuation(text) {
        const mode = this._settings.punctuation;
        if (mode === 'none') return text;
        let out = '';
        for (const ch of text) {
            if (mode === 'all' && SYMBOL_NAMES[ch]) out += ` ${SYMBOL_NAMES[ch]} `;
            else if (mode === 'some' && SILENT_SOME.has(ch)) out += ' ';
            else out += ch;
        }
        return out.replace(/  +/g, ' ').trim();
    }

    _deliver(text) {
        this._pushToLiveRegion(text);
        if (this._settings.builtinTts) this._ttsEnqueue(text);
    }

    // ── Built-in TTS (secondary) ──────────────────────────────────────────────

    _initVoices() {
        if (!window.speechSynthesis) return;
        const load = () => { this._voices = window.speechSynthesis.getVoices(); this._voicesLoaded = true; };
        load();
        if (window.speechSynthesis.onvoiceschanged !== undefined) window.speechSynthesis.onvoiceschanged = load;
    }

    getVoices() { return this._voices; }

    _ttsEnqueue(text) {
        if (!window.speechSynthesis) return;
        this._ttsQueue.push(text);
        if (!this._ttsSpeaking) this._ttsProcess();
    }

    _ttsProcess() {
        if (!this._ttsQueue.length) { this._ttsSpeaking = false; return; }
        this._ttsSpeaking = true;
        this._speakChunks(this._chunkText(this._ttsQueue.shift()), () => this._ttsProcess());
    }

    _chunkText(text) {
        const parts = text.split(/(?<=[.!?])\s+/);
        const chunks = []; let cur = '';
        for (const p of parts) {
            cur += (cur ? ' ' : '') + p;
            if (cur.length > 200) { chunks.push(cur); cur = ''; }
        }
        if (cur) chunks.push(cur);
        return chunks.length ? chunks : [text];
    }

    _speakChunks(chunks, onDone) {
        if (!chunks.length) { onDone(); return; }
        const utt = new SpeechSynthesisUtterance(chunks.shift());
        utt.rate = this._settings.rate;
        utt.pitch = this._settings.pitch;
        utt.volume = this._settings.volume;
        if (this._settings.voiceURI && this._voicesLoaded) {
            const v = this._voices.find(v => v.voiceURI === this._settings.voiceURI);
            if (v) utt.voice = v;
        }
        const next = () => this._speakChunks(chunks, onDone);
        utt.onend = next;
        utt.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') console.warn('[SR-TTS]', e.error); next(); };
        // Chrome 15s cutoff workaround
        if (/Chrome/.test(navigator.userAgent) && !/Edg|OPR/.test(navigator.userAgent)) {
            const ka = setInterval(() => {
                if (!window.speechSynthesis.speaking) { clearInterval(ka); return; }
                window.speechSynthesis.pause(); window.speechSynthesis.resume();
            }, 10000);
            const oe = utt.onend, oerr = utt.onerror;
            utt.onend = () => { clearInterval(ka); oe(); };
            utt.onerror = (e) => { clearInterval(ka); oerr(e); };
        }
        window.speechSynthesis.speak(utt);
    }

    stopTts() {
        this._ttsQueue = []; this._ttsSpeaking = false;
        if (window.speechSynthesis) window.speechSynthesis.cancel();
    }

    // ── Settings API ──────────────────────────────────────────────────────────

    setRate(v)        { this._settings.rate  = Math.max(0.1, Math.min(10, +v)); this._saveSettings(); }
    setPitch(v)       { this._settings.pitch = Math.max(0,   Math.min(2,  +v)); this._saveSettings(); }
    setVolume(v)      { this._settings.volume= Math.max(0,   Math.min(1,  +v)); this._saveSettings(); }
    setVoice(uri)     { this._settings.voiceURI = uri || null; this._saveSettings(); }
    setPunctuation(l) { if (['all','some','none'].includes(l)) { this._settings.punctuation = l; this._saveSettings(); } }

    // ── Static helpers ────────────────────────────────────────────────────────

    static isTtsSupported() {
        return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
    }

    static getTtsWarning() {
        if (!ScreenReader.isTtsSupported()) return 'Your browser does not support speech synthesis. Try Chrome, Edge, Firefox, or Safari.';
        if (navigator.brave || /Brave/.test(navigator.userAgent)) return 'Brave may block speech synthesis. If no audio plays, try Chrome or Firefox.';
        return null;
    }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const screenReader = new ScreenReader();

// ─── Settings modal UI ────────────────────────────────────────────────────────
// Call this from main.js when the settings modal opens (same pattern as
// the Connection Mode toggle). Wire it to the settings modal observer.

export function injectScreenReaderSettings() {
    if (document.getElementById('sr-settings-group')) return;

    const s            = screenReader.getSettings();
    const ttsSupported = ScreenReader.isTtsSupported();
    const ttsWarning   = ScreenReader.getTtsWarning();

    const group = document.createElement('div');
    group.className = 'form-group';
    group.id = 'sr-settings-group';

    const enabledStyle  = 'background:rgba(80,250,123,0.12);color:#50fa7b;border:1px solid rgba(80,250,123,0.3)';
    const disabledStyle = 'background:rgba(98,114,164,0.2);color:#6272a4;border:1px solid rgba(98,114,164,0.3)';

    group.innerHTML = `
        <label class="form-label" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <span>Screen Reader Mode</span>
            <span id="sr-mode-badge" style="font-size:0.65rem;padding:2px 7px;border-radius:10px;font-family:'JetBrains Mono',monospace;${s.enabled ? enabledStyle : disabledStyle}">
                ${s.enabled ? 'ON' : 'OFF'}
            </span>
        </label>
        <div style="font-size:0.72rem;color:var(--text-muted,#6272a4);line-height:1.5;margin-bottom:8px;">
            Pipes MUD text into an ARIA live region so your screen reader (NVDA, JAWS, VoiceOver, TalkBack) reads it automatically.
            ASCII art, maps, and borders are filtered out.
        </div>
        <button id="sr-toggle-btn" class="modal-btn${s.enabled ? ' primary' : ''}" style="width:100%;margin-bottom:10px;">
            ${s.enabled ? '♿ Screen Reader Mode: On' : '♿ Enable Screen Reader Mode'}
        </button>

        <div id="sr-tts-section" style="display:${s.enabled ? 'block' : 'none'};border-top:1px solid rgba(98,114,164,0.2);padding-top:10px;">
            <label class="form-label" style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;">
                <span style="font-size:0.8rem;">Built-in Text-to-Speech</span>
                <span style="font-size:0.65rem;color:var(--text-muted,#6272a4);">mobile / no screen reader</span>
            </label>
            <div style="font-size:0.7rem;color:var(--text-muted,#6272a4);margin-bottom:6px;line-height:1.4;">
                If you already use NVDA, JAWS, or VoiceOver, leave this off — your screen reader handles speech.
                Enable this on mobile or if you have no screen reader installed.
            </div>
            ${ttsWarning ? `<div style="font-size:0.7rem;color:#f1fa8c;margin-bottom:6px;">⚠ ${ttsWarning}</div>` : ''}
            <button id="sr-tts-toggle" class="modal-btn${s.builtinTts ? ' primary' : ''}" style="width:100%;margin-bottom:8px;${!ttsSupported ? 'opacity:0.5;cursor:not-allowed;' : ''}">
                ${s.builtinTts ? '🔊 Built-in TTS: On' : '🔇 Built-in TTS: Off'}
            </button>

            <div id="sr-tts-controls" style="display:${s.builtinTts ? 'grid' : 'none'};grid-template-columns:1fr 1fr;gap:8px;">
                <div style="margin:0;">
                    <label class="form-label" style="font-size:0.7rem;">Speed</label>
                    <input type="range" id="sr-rate" min="0.5" max="2.5" step="0.1" value="${s.rate}" style="width:100%;">
                    <div style="font-size:0.65rem;color:var(--text-muted);text-align:center;" id="sr-rate-val">${s.rate}×</div>
                </div>
                <div style="margin:0;">
                    <label class="form-label" style="font-size:0.7rem;">Pitch</label>
                    <input type="range" id="sr-pitch" min="0" max="2" step="0.1" value="${s.pitch}" style="width:100%;">
                    <div style="font-size:0.65rem;color:var(--text-muted);text-align:center;" id="sr-pitch-val">${s.pitch}</div>
                </div>
                <div style="grid-column:1/-1;">
                    <label class="form-label" style="font-size:0.7rem;">Punctuation</label>
                    <select id="sr-punct" class="form-input" style="font-size:0.75rem;padding:4px 6px;">
                        <option value="none"${s.punctuation==='none'?' selected':''}>None — skip all symbols</option>
                        <option value="some"${s.punctuation==='some'?' selected':''}>Some — natural reading</option>
                        <option value="all"${s.punctuation==='all'?' selected':''}>All — speak every symbol</option>
                    </select>
                </div>
                <div style="grid-column:1/-1;">
                    <label class="form-label" style="font-size:0.7rem;">Voice</label>
                    <select id="sr-voice" class="form-input" style="font-size:0.75rem;padding:4px 6px;">
                        <option value="">Browser default</option>
                        ${screenReader.getVoices().map(v =>
                            `<option value="${v.voiceURI}"${s.voiceURI === v.voiceURI ? ' selected' : ''}>${v.name} (${v.lang})</option>`
                        ).join('')}
                    </select>
                </div>
            </div>
        </div>`;

    // Insert before theme group, or append to modal body
    let placed = false;
    document.querySelectorAll('#modal-settings .form-group').forEach(el => {
        if (!placed && el.querySelector('#setting-theme')) {
            el.parentNode.insertBefore(group, el);
            placed = true;
        }
    });
    if (!placed) {
        const body = document.querySelector('#modal-settings .modal');
        if (body) {
            const footer = body.querySelector('.modal-actions, .modal-footer');
            footer ? body.insertBefore(group, footer) : body.appendChild(group);
        }
    }

    // Wire toggle buttons (re-inject to refresh state)
    const refresh = () => { document.getElementById('sr-settings-group')?.remove(); injectScreenReaderSettings(); };

    document.getElementById('sr-toggle-btn')?.addEventListener('click', () => {
        screenReader.toggle(); refresh();
    });

    document.getElementById('sr-tts-toggle')?.addEventListener('click', () => {
        if (!ttsSupported) return;
        screenReader.toggleBuiltinTts(); refresh();
    });

    document.getElementById('sr-rate')?.addEventListener('input', e => {
        screenReader.setRate(e.target.value);
        document.getElementById('sr-rate-val').textContent = (+e.target.value).toFixed(1) + '×';
    });

    document.getElementById('sr-pitch')?.addEventListener('input', e => {
        screenReader.setPitch(e.target.value);
        document.getElementById('sr-pitch-val').textContent = (+e.target.value).toFixed(1);
    });

    document.getElementById('sr-punct')?.addEventListener('change', e => screenReader.setPunctuation(e.target.value));
    document.getElementById('sr-voice')?.addEventListener('change', e => screenReader.setVoice(e.target.value));
}
