/**
 * Session Manager
 * ===============
 * Manages multiple simultaneous MUD connections.
 * Each session bundles a ConnectionManager + xterm Terminal + input state.
 */

import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { events, Events } from './events.js';
import { state } from './state.js';
import { ConnectionManager } from '../connection/manager.js';
import { parseMXP, enableMXP, getMXPVersion, getMXPSupport, reset as resetMXP } from './mxp.js';
import { AutomationSet } from './automation-set.js';
import { WidgetGrid } from '../ui/widget-grid.js';

let imageAddonModule = null;

async function loadImageAddonModule() {
    if (imageAddonModule !== null) return imageAddonModule;
    try {
        const mod = await import('@xterm/addon-image');
        imageAddonModule = mod;
        return mod;
    } catch (e) {
        console.warn('[TERM] ImageAddon not available:', e.message);
        imageAddonModule = false;
        return false;
    }
}

// Preload
loadImageAddonModule();

/**
 * A single session: one connection + one terminal
 */
class Session {
    constructor(id, connectionConfig, profileConfig = null) {
        this.id = id;
        this.connectionConfig = connectionConfig;
        this.profileConfig = profileConfig;

        // Connection
        this.connection = new ConnectionManager(id);

        // Terminal
        this.terminal = null;
        this.fitAddon = null;
        this.containerEl = null;

        // Input state
        this.inputBuffer = '';
        this.commandHistory = [];
        this.historyIndex = -1;
        this.localEcho = true;

        // Tab display
        this.title = connectionConfig.name || 'Connection';
        this.color = connectionConfig.color || 'cyan';
        this.profileName = profileConfig?.name || null;

        // State
        this.active = false;
        this.created = Date.now();

        // Session stats
        this.linesReceived = 0;
        this.connectedAt = null;

        // Automation (per-session)
        this.automation = null;

        // Widget grid (per-session)
        this.widgetGrid = null;

        // Event unsub functions
        this._unsubs = [];
    }

    /**
     * Initialize terminal and mount it (hidden) in the workspace
     */
    init(parentEl, terminalOpts = {}) {
        // ══════════════════════════════════════════════════════════════
        // DOM STRUCTURE:
        //   session-container (grid: rows = dock-top, middle, dock-bottom)
        //   ├── dock-top
        //   ├── session-middle (grid: cols = dock-left, center, dock-right)
        //   │   ├── dock-left
        //   │   ├── session-center (flex column)
        //   │   │   ├── session-term-wrap (flex:1, position:relative)
        //   │   │   │   ├── xterm terminal
        //   │   │   │   └── overlay-layer (absolute, CSS grid for floating widgets)
        //   │   │   ├── session-splitter (drag to resize input)
        //   │   │   └── session-input-wrap (flex-shrink:0, resizable height)
        //   │   │       └── textarea.session-input
        //   │   └── dock-right
        //   └── dock-bottom
        // ══════════════════════════════════════════════════════════════

        this.containerEl = document.createElement('div');
        this.containerEl.className = 'session-container';
        this.containerEl.id = `session-${this.id}`;
        this.containerEl.style.display = 'none';
        parentEl.appendChild(this.containerEl);

        // ── Dock top ──
        this._dockTop = document.createElement('div');
        this._dockTop.className = 'session-dock dock-zone-top';
        this.containerEl.appendChild(this._dockTop);

        // ── Middle row ──
        this._middleRow = document.createElement('div');
        this._middleRow.className = 'session-middle';
        this.containerEl.appendChild(this._middleRow);

        // Dock left
        this._dockLeft = document.createElement('div');
        this._dockLeft.className = 'session-dock dock-zone-left';
        this._middleRow.appendChild(this._dockLeft);

        // Center column
        this._centerCol = document.createElement('div');
        this._centerCol.className = 'session-center';
        this._middleRow.appendChild(this._centerCol);

        // Terminal wrapper (relative positioned, for overlay layer)
        this._terminalWrap = document.createElement('div');
        this._terminalWrap.className = 'session-term-wrap';
        this._centerCol.appendChild(this._terminalWrap);

        // Overlay layer for floating widgets (absolute over terminal)
        this._overlayLayer = document.createElement('div');
        this._overlayLayer.className = 'session-overlay-layer';
        this._terminalWrap.appendChild(this._overlayLayer);

        // Splitter (resizes input area)
        this._splitter = document.createElement('div');
        this._splitter.className = 'session-splitter';
        this._splitter.title = 'Drag to resize input area';
        this._centerCol.appendChild(this._splitter);
        this._setupSplitter();

        // Input area
        this._inputWrap = document.createElement('div');
        this._inputWrap.className = 'session-input-wrap';
        this._inputWrap.style.height = '28px';
        this._centerCol.appendChild(this._inputWrap);

        this._inputEl = document.createElement('textarea');
        this._inputEl.className = 'session-input';
        this._inputEl.placeholder = 'Type command...';
        this._inputEl.rows = 1;
        this._inputEl.spellcheck = false;
        this._inputEl.autocomplete = 'off';
        this._inputWrap.appendChild(this._inputEl);

        // Dock right
        this._dockRight = document.createElement('div');
        this._dockRight.className = 'session-dock dock-zone-right';
        this._middleRow.appendChild(this._dockRight);

        // ── Dock bottom ──
        this._dockBottom = document.createElement('div');
        this._dockBottom.className = 'session-dock dock-zone-bottom';
        this.containerEl.appendChild(this._dockBottom);

        // ── Create xterm (output only) ──
        this.terminal = new Terminal({
            theme: {
                background: '#0a0a0f',
                foreground: '#e8e8e8',
                cursor: '#00d4ff',
                cursorAccent: '#0a0a0f',
                selection: 'rgba(0, 212, 255, 0.3)',
                black: '#000000',
                red: '#ff5555',
                green: '#50fa7b',
                yellow: '#f1fa8c',
                blue: '#6272a4',
                magenta: '#ff79c6',
                cyan: '#8be9fd',
                white: '#f8f8f2',
                brightBlack: '#6272a4',
                brightRed: '#ff6e6e',
                brightGreen: '#69ff94',
                brightYellow: '#ffffa5',
                brightBlue: '#d6acff',
                brightMagenta: '#ff92df',
                brightCyan: '#a4ffff',
                brightWhite: '#ffffff'
            },
            fontFamily: "'JetBrains Mono', 'Share Tech Mono', 'Consolas', monospace",
            fontSize: 14,
            lineHeight: 1.2,
            cursorBlink: false,
            cursorStyle: 'block',
            scrollback: 10000,
            convertEol: true,
            allowProposedApi: true,
            disableStdin: true,
            linkHandler: {
                activate: (event, uri) => {
                    if (uri.startsWith('http://mudcmd/')) {
                        const cmd = decodeURIComponent(uri.slice(14));
                        this.connection.send(cmd);
                    } else if (uri.startsWith('http://') || uri.startsWith('https://')) {
                        window.open(uri, '_blank');
                    }
                }
            },
            ...terminalOpts
        });

        this.fitAddon = new FitAddon();
        this.terminal.loadAddon(this.fitAddon);
        this.terminal.loadAddon(new WebLinksAddon());

        // Load image addon (async)
        loadImageAddonModule().then(mod => {
            if (mod && mod.ImageAddon) {
                try {
                    const imageAddon = new mod.ImageAddon({
                        enableSizeReports: true,
                        pixelLimit: 16777216,
                        sixelSupport: true,
                        sixelScrolling: true,
                        sixelPaletteLimit: 256,
                        storageLimit: 128,
                        showPlaceholder: true
                    });
                    this.terminal.loadAddon(imageAddon);
                } catch (e) { /* ignore */ }
            }
        });

        // Open terminal into wrapper
        this.terminal.open(this._terminalWrap);

        // Click terminal → refocus input (so user can always type)
        this._terminalWrap.addEventListener('mouseup', () => {
            // Only refocus if no text selection in terminal
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed) {
                this._inputEl.focus();
            }
        });

        // Resize observer for terminal
        this._resizeObserver = new ResizeObserver(() => {
            if (this.fitAddon && this.containerEl.style.display !== 'none') {
                this.fitAddon.fit();
                this.connection.setTerminalSize(this.terminal.cols, this.terminal.rows);
            }
        });
        this._resizeObserver.observe(this._terminalWrap);

        // Wire input (textarea-based)
        this._setupInput();

        // Wire connection events
        this._setupConnectionEvents();

        // Create per-session automation
        this.automation = new AutomationSet(
            this.id,
            this.connectionConfig,
            this.profileConfig,
            (cmd) => this.connection.send(cmd),
            (text) => { if (this.terminal) this.terminal.write(text); }
        );

        // Create widget grid with zone references
        this.widgetGrid = new WidgetGrid(
            this.id,
            {
                overlay: this._overlayLayer,
                top: this._dockTop,
                bottom: this._dockBottom,
                left: this._dockLeft,
                right: this._dockRight
            },
            (cmd) => this.connection.send(cmd),
            (varName) => this.automation?.scripts?.getVariable?.(varName) ?? state.get(varName)
        );

        // Load saved widget layout from automation store
        if (this.automation?._storedData?.widgets) {
            this.widgetGrid.loadLayout(this.automation._storedData.widgets);
        }

        // Wire widget export so automation.save() captures live widget state
        this.automation._widgetExportFn = () => this.widgetGrid?.exportLayout() || [];
    }

    /**
     * Splitter drag to resize input area
     */
    _setupSplitter() {
        let startY, startH;

        const onMove = (e) => {
            const y = e.touches ? e.touches[0].clientY : e.clientY;
            const delta = startY - y; // drag up = taller input
            const newH = Math.max(24, Math.min(window.innerHeight * 0.4, startH + delta));
            this._inputWrap.style.height = newH + 'px';
        };

        const onEnd = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
            this._splitter.classList.remove('dragging');
            // Refit terminal after resize
            if (this.fitAddon && this.containerEl.style.display !== 'none') {
                this.fitAddon.fit();
            }
        };

        this._splitter.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startY = e.clientY;
            startH = this._inputWrap.offsetHeight;
            this._splitter.classList.add('dragging');
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onEnd);
        });

        this._splitter.addEventListener('touchstart', (e) => {
            startY = e.touches[0].clientY;
            startH = this._inputWrap.offsetHeight;
            this._splitter.classList.add('dragging');
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onEnd);
        }, { passive: false });
    }

    /**
     * Setup textarea input with command history
     */
    _setupInput() {
        const input = this._inputEl;
        const unsub = [];

        // ECHO option from telnet
        unsub.push(events.on(Events.TELNET_SUBNEG, ({ sessionId, option, enabled }) => {
            if (sessionId !== this.id) return;
            if (option === 'ECHO') {
                this.localEcho = !enabled;
            }
            if (option === 'MXP' && enabled) {
                enableMXP();
            }
        }));

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const text = input.value;

                // Echo to terminal
                if (this.localEcho && text) {
                    this.terminal.write(text + '\r\n');
                } else if (text) {
                    this.terminal.write('\r\n');
                }

                // Add to history
                if (text.trim()) {
                    this.commandHistory.unshift(text);
                    if (this.commandHistory.length > 100) this.commandHistory.pop();
                }
                this.historyIndex = -1;

                // Process through aliases, then send
                if (this.automation && text.trim()) {
                    const commands = this.automation.processInput(text);
                    for (const cmd of commands) {
                        this.connection.send(cmd);
                    }
                } else {
                    this.connection.send(text);
                }

                input.value = '';
                this._autoResizeInput();
            } else if (e.key === 'ArrowUp' && input.selectionStart === 0 && !e.shiftKey) {
                // History up (only when cursor at start)
                if (this.historyIndex < this.commandHistory.length - 1) {
                    e.preventDefault();
                    this.historyIndex++;
                    input.value = this.commandHistory[this.historyIndex];
                    input.setSelectionRange(input.value.length, input.value.length);
                }
            } else if (e.key === 'ArrowDown' && input.selectionEnd === input.value.length && !e.shiftKey) {
                // History down (only when cursor at end)
                e.preventDefault();
                if (this.historyIndex > 0) {
                    this.historyIndex--;
                    input.value = this.commandHistory[this.historyIndex];
                } else if (this.historyIndex === 0) {
                    this.historyIndex = -1;
                    input.value = '';
                }
                input.setSelectionRange(input.value.length, input.value.length);
            } else if (e.key === 'Escape') {
                input.value = '';
                this.historyIndex = -1;
                this._autoResizeInput();
            }
        });

        // Auto-resize textarea to content
        input.addEventListener('input', () => this._autoResizeInput());

        this._unsubs.push(...unsub);
    }

    /**
     * Auto-resize input textarea to fit content (respects splitter height)
     */
    _autoResizeInput() {
        const input = this._inputEl;
        // Reset to measure scroll height
        input.style.height = 'auto';
        const scrollH = input.scrollHeight;
        const wrapH = this._inputWrap.offsetHeight;
        // Textarea fills the wrap (which is controlled by splitter)
        input.style.height = Math.min(scrollH, wrapH) + 'px';
    }

    _setupConnectionEvents() {
        // Listen for data from THIS session's connection
        const unsubData = events.on(Events.CONNECTION_DATA, ({ sessionId, type, data }) => {
            if (sessionId !== this.id) return;

            if (type === 'text') {
                // Count received lines
                const newlines = data.split('\n').length - 1;
                this.linesReceived += Math.max(newlines, 1);

                // Handle MXP VERSION/SUPPORT requests
                if (data.includes('<VERSION') || data.includes('<version')) {
                    this.connection.send(getMXPVersion());
                }
                if (data.includes('<SUPPORT') || data.includes('<support')) {
                    this.connection.send(getMXPSupport());
                }

                // Parse MXP tags before writing
                const output = parseMXP(data);
                this.terminal.write(output);

                // Fire triggers against each line
                if (this.automation) {
                    const lines = data.split('\n');
                    for (const line of lines) {
                        if (line.trim()) this.automation.processLine(line);
                    }
                }
            }
        });
        this._unsubs.push(unsubData);

        // System messages
        const unsubSys = events.on(Events.SYSTEM_MESSAGE, ({ sessionId: sid, message, type }) => {
            if (sid && sid !== this.id) return;
            const colors = {
                info: '\x1b[1;36m', success: '\x1b[1;32m',
                warning: '\x1b[1;33m', error: '\x1b[1;31m'
            };
            this.terminal.writeln(`${colors[type] || colors.info}[${type.toUpperCase()}] ${message}\x1b[0m`);
        });
        this._unsubs.push(unsubSys);

        // Connection open
        const unsubOpen = events.on(Events.CONNECTION_OPEN, ({ sessionId }) => {
            if (sessionId !== this.id) return;
            resetMXP();
            this.localEcho = true;
            this.connectedAt = Date.now();
        });
        this._unsubs.push(unsubOpen);

        // Connection close
        const unsubClose = events.on(Events.CONNECTION_CLOSE, ({ sessionId }) => {
            if (sessionId !== this.id) return;
            resetMXP();
            this.localEcho = true;
            this.connectedAt = null;
            this.title = `${this.connectionConfig.name} (closed)`;
            events.emit(Events.SESSION_UPDATE, { sessionId: this.id });
        });
        this._unsubs.push(unsubClose);

        // Terminal output from plugins/scripts
        const unsubOutput = events.on(Events.TERMINAL_OUTPUT, ({ sessionId: sid, text }) => {
            if (sid && sid !== this.id) return;
            if (text) this.terminal.write(text);
        });
        this._unsubs.push(unsubOutput);
    }

    /**
     * Show this session's terminal
     */
    show() {
        if (this.containerEl) {
            this.containerEl.style.display = '';
            this.active = true;
            if (this.fitAddon) {
                setTimeout(() => {
                    this.fitAddon.fit();
                    this.connection.setTerminalSize(this.terminal.cols, this.terminal.rows);
                    this._inputEl?.focus();
                }, 50);
            }
        }
    }

    /**
     * Hide this session's terminal
     */
    hide() {
        if (this.containerEl) {
            this.containerEl.style.display = 'none';
            this.active = false;
        }
    }

    /**
     * Destroy session, cleanup everything
     */
    destroy() {
        // Unsubscribe events
        for (const unsub of this._unsubs) {
            if (typeof unsub === 'function') unsub();
        }
        this._unsubs = [];

        // Stop resize observer
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }

        // Save and destroy automation (include widgets)
        if (this.automation) {
            // Save widget layout into automation store
            if (this.widgetGrid) {
                this.automation._storedData = this.automation._storedData || {};
                this.automation._storedData.widgets = this.widgetGrid.exportLayout();
            }
            this.automation.save();
            this.automation.destroy();
            this.automation = null;
        }

        // Destroy widget grid
        if (this.widgetGrid) {
            this.widgetGrid.destroy();
            this.widgetGrid = null;
        }

        // Disconnect and remove network listeners
        this.connection.dispose();

        // Dispose terminal
        if (this.terminal) {
            this.terminal.dispose();
            this.terminal = null;
        }

        // Remove DOM
        if (this.containerEl) {
            this.containerEl.remove();
            this.containerEl = null;
        }
    }
}


/**
 * SessionManager — coordinates all sessions
 */
class SessionManager {
    constructor() {
        /** @type {Map<string, Session>} */
        this.sessions = new Map();
        this.activeSessionId = null;
        this._terminalParent = null;
    }

    /**
     * Set the DOM element that holds all terminal containers
     */
    setTerminalParent(el) {
        this._terminalParent = el;
    }

    /**
     * Open a new session for a connection + optional profile
     * @returns {string} sessionId
     */
    createSession(connectionConfig, profileConfig = null) {
        const sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

        const session = new Session(sessionId, connectionConfig, profileConfig);
        session.init(this._terminalParent);

        this.sessions.set(sessionId, session);

        // Connect
        let connectUrl = connectionConfig.url;
        if (connectionConfig.type === 'bridge' && connectionConfig.bridgeUrl && connectionConfig.mudHost && connectionConfig.mudPort) {
            connectUrl = `${connectionConfig.bridgeUrl}?host=${encodeURIComponent(connectionConfig.mudHost)}&port=${connectionConfig.mudPort}`;
        }

        session.connection.connect(connectUrl, {
            protocol: connectionConfig.protocol || 'auto',
            connectionId: connectionConfig.id,
            profileId: profileConfig?.id,
            autoReconnect: profileConfig?.autoReconnect ?? connectionConfig.autoReconnect ?? true
        });

        // Auto-login
        if (profileConfig?.autoLogin) {
            const commands = profileConfig.autoLogin.split('\n').filter(c => c.trim());
            commands.forEach((cmd, i) => {
                setTimeout(() => session.connection.send(cmd), (i + 1) * 500);
            });
        }

        // Switch to this session
        this.switchTo(sessionId);

        events.emit(Events.SESSION_CREATE, { sessionId, connectionConfig, profileConfig });

        return sessionId;
    }

    /**
     * Switch active session
     */
    switchTo(sessionId) {
        if (sessionId === this.activeSessionId) return;

        // Hide current (save widget state first)
        if (this.activeSessionId) {
            const current = this.sessions.get(this.activeSessionId);
            if (current) {
                // Persist widget layout before switching away
                if (current.widgetGrid && current.automation) {
                    current.automation.save();
                }
                current.hide();
            }
        }

        // Show new
        const session = this.sessions.get(sessionId);
        if (session) {
            session.show();
            this.activeSessionId = sessionId;

            // Update global state for UI components that read it
            state.set('activeConnection', session.connectionConfig.id);
            state.set('activeProfile', session.profileConfig?.id || null);
            state.set('connection.status', session.connection.isConnected() ? 'connected' : 'disconnected');

            events.emit(Events.SESSION_SWITCH, { sessionId });
        }
    }

    /**
     * Close a session
     */
    closeSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        session.destroy();
        this.sessions.delete(sessionId);

        events.emit(Events.SESSION_DESTROY, { sessionId });

        // If we closed the active session, switch to another or show connections
        if (sessionId === this.activeSessionId) {
            this.activeSessionId = null;
            const remaining = [...this.sessions.keys()];
            if (remaining.length > 0) {
                this.switchTo(remaining[remaining.length - 1]);
            } else {
                // No sessions left — show connections screen
                events.emit(Events.SESSION_SWITCH, { sessionId: null });
            }
        }
    }

    /**
     * Get active session
     * @returns {Session|null}
     */
    getActive() {
        return this.sessions.get(this.activeSessionId) || null;
    }

    /**
     * Get session by ID
     * @returns {Session|null}
     */
    getSession(sessionId) {
        return this.sessions.get(sessionId) || null;
    }

    /**
     * Get all sessions as array (for tab rendering)
     */
    getAllSessions() {
        return [...this.sessions.values()];
    }

    /**
     * Close all sessions
     */
    closeAll() {
        for (const [id] of this.sessions) {
            this.closeSession(id);
        }
    }
}

export const sessionManager = new SessionManager();
export { Session };
export default sessionManager;
