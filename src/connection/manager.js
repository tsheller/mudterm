/**
 * MudTerm Connection Manager
 * ==========================
 * Per-session WebSocket connection handler.
 * Each Session creates its own ConnectionManager instance.
 * Instances are fully isolated — no shared state, no globals.
 *
 * Implements mudstandards.org WebSocket subprotocol specification.
 *
 * SUBPROTOCOLS:
 *   telnet.mudstandards.org   - BINARY: full telnet byte stream
 *   terminal.mudstandards.org - TEXT: UTF-8 ANSI output only
 *   gmcp.mudstandards.org     - TEXT=ANSI, BINARY=GMCP messages
 *   extended.mudstandards.org - TEXT=ANSI, BINARY=telnet subneg
 *   json.mudstandards.org     - TEXT=ANSI, BINARY=JSON envelope
 *
 * TELNET OPTIONS:
 *   1=ECHO, 3=SGA, 24=TTYPE, 25=EOR, 31=NAWS,
 *   69=MSDP, 70=MSSP, 86=MCCP2, 87=MCCP3, 201=GMCP
 */

import { events, Events } from '../core/events.js';
import pako from 'pako';

// ═══════════════════════════════════════════════════════════════════════════════
// TELNET CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const IAC  = 255;
const DONT = 254;
const DO   = 253;
const WONT = 252;
const WILL = 251;
const SB   = 250;
const GA   = 249;
const EL   = 248;
const EC   = 247;
const AYT  = 246;
const AO   = 245;
const IP   = 244;
const BRK  = 243;
const DM   = 242;
const NOP  = 241;
const SE   = 240;
const EOR  = 239;

const TELOPT_ECHO     = 1;
const TELOPT_SGA      = 3;
const TELOPT_TTYPE    = 24;
const TELOPT_EOR      = 25;
const TELOPT_NAWS     = 31;
const TELOPT_LINEMODE = 34;
const TELOPT_NEWENVIRON = 39;  // NEW-ENVIRON (RFC 1572)
const TELOPT_CHARSET  = 42;    // CHARSET (RFC 2066)
const TELOPT_MSDP     = 69;
const TELOPT_MSSP     = 70;
const TELOPT_MCCP2    = 86;
const TELOPT_MCCP3    = 87;
const TELOPT_MXP      = 91;    // MUD eXtension Protocol
const TELOPT_GMCP     = 201;

const TTYPE_IS   = 0;
const TTYPE_SEND = 1;

const MSDP_VAR         = 1;
const MSDP_VAL         = 2;
const MSDP_TABLE_OPEN  = 3;
const MSDP_TABLE_CLOSE = 4;
const MSDP_ARRAY_OPEN  = 5;
const MSDP_ARRAY_CLOSE = 6;

// NEW-ENVIRON constants (RFC 1572)
const NEWENV_IS      = 0;
const NEWENV_SEND    = 1;
const NEWENV_INFO    = 2;
const NEWENV_VAR     = 0;
const NEWENV_VALUE   = 1;
const NEWENV_ESC     = 2;
const NEWENV_USERVAR = 3;

// CHARSET constants (RFC 2066)
const CHARSET_REQUEST = 1;
const CHARSET_ACCEPTED = 2;
const CHARSET_REJECTED = 3;

// ═══════════════════════════════════════════════════════════════════════════════
// PROTOCOL CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const SUBPROTOCOLS = {
    TELNET:   'telnet.mudstandards.org',
    TERMINAL: 'terminal.mudstandards.org',
    GMCP:     'gmcp.mudstandards.org',
    EXTENDED: 'extended.mudstandards.org',
    JSON:     'json.mudstandards.org'
};

const PROTOCOL_PREFERENCE = [
    SUBPROTOCOLS.GMCP,
    SUBPROTOCOLS.EXTENDED,
    SUBPROTOCOLS.TELNET,
    SUBPROTOCOLS.TERMINAL
];

const PROTOCOL_MAP = {
    'telnet':   SUBPROTOCOLS.TELNET,
    'terminal': SUBPROTOCOLS.TERMINAL,
    'raw':      SUBPROTOCOLS.TERMINAL,
    'gmcp':     SUBPROTOCOLS.GMCP,
    'extended': SUBPROTOCOLS.EXTENDED,
    'json':     SUBPROTOCOLS.JSON,
    'auto':     'auto'
};

// ═══════════════════════════════════════════════════════════════════════════════
// CONNECTION MANAGER
// ═══════════════════════════════════════════════════════════════════════════════

class ConnectionManager {
    constructor(sessionId = null) {
        this.sessionId = sessionId;

        // Connection
        this.socket = null;
        this.connected = false;
        this.protocol = null;
        this.requestedProtocol = null;
        this.options = {};

        // Telnet parsing
        this.inputBuffer = new Uint8Array(0);
        this.terminalWidth = 80;
        this.terminalHeight = 24;

        // TTYPE/MTTS cycling
        // MTTS 397 = ANSI(1) + UTF-8(4) + 256_COLORS(8) + PROXY(128) + TRUECOLOR(256)
        this.ttypeIndex = 0;
        this.ttypeList = ['MUDTERM', 'XTERM-256COLOR', 'MTTS 397'];

        // GMCP
        this.gmcpPackages = new Set();
        this.gmcpSupported = [
            'Char 1', 'Char.Vitals 1', 'Char.Status 1', 'Char.Items 1',
            'Room 1', 'Room.Info 1', 'Comm 1', 'Comm.Channel 1'
        ];

        // Telnet option state (prevents negotiation loops)
        this.telnetOptions = { local: {}, remote: {} };

        // Telnet parser state machine
        this._telnetState = 'NORMAL';
        this._telnetCmd   = 0;
        this._sbOption    = 0;
        this._sbBuffer    = [];

        // MCCP compression
        this.mccp2Active = false;
        this.mccpVersion = 0;
        this.mccp2Inflater = null;
        this.mccp2Chunks = [];
        this.mxpEnabled = false;

        // MXP

        // Reusable codec instances
        this._decoder = new TextDecoder('utf-8');
        this._encoder = new TextEncoder();

        // Keepalive
        this._keepaliveTimer = null;

        // Reconnect — fully instance-scoped, no globals
        this._reconnectAttempts = 0;
        this._reconnectTimer = null;
        this._reconnectMaxDelay = 30000;
        this._lastUrl = null;
        this._lastOptions = null;
        this._wasEverConnected = false; // Only reconnect if we connected at least once
        this._intentionalDisconnect = false; // Set when user sends quit/logout
        this._autoReconnect = true; // Per-connection setting, overridden by config

        // Network resilience — detect wifi↔cellular switches
        this._onlineHandler = () => this._handleNetworkOnline();
        this._visibilityHandler = () => this._handleVisibilityChange();
        window.addEventListener('online', this._onlineHandler);
        document.addEventListener('visibilitychange', this._visibilityHandler);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // EVENT EMITTER (scoped to this session)
    // ═══════════════════════════════════════════════════════════════════════

    _emit(event, data = {}) {
        events.emit(event, { sessionId: this.sessionId, ...data });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TERMINAL SIZE
    // ═══════════════════════════════════════════════════════════════════════

    setTerminalSize(width, height) {
        const changed = this.terminalWidth !== width || this.terminalHeight !== height;
        this.terminalWidth = width;
        this.terminalHeight = height;
        if (changed && this.connected && this.telnetOptions.local[TELOPT_NAWS]) {
            this.sendNAWS();
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CONNECTION LIFECYCLE
    // ═══════════════════════════════════════════════════════════════════════

    connect(url, options = {}) {
        // Kill existing socket silently (no events)
        this._killSocket();

        // Reset state
        this.options = options;
        this._lastUrl = url;
        this._lastOptions = { ...options };
        this._intentionalDisconnect = false;
        this._autoReconnect = options.autoReconnect !== false; // Default true
        this.inputBuffer = new Uint8Array(0);
        this.telnetOptions = { local: {}, remote: {} };
        this._telnetState = 'NORMAL';
        this._telnetCmd   = 0;
        this._sbOption    = 0;
        this._sbBuffer    = [];
        this.ttypeIndex = 0;
        this.gmcpPackages.clear();
        this.mccp2Active = false;
        this.mccpVersion = 0;
        this.mccp2Inflater = null;
        this.mccp2Chunks = [];
        this.mxpEnabled = false;

        const requestedProto = PROTOCOL_MAP[options.protocol] || 'auto';
        this.requestedProtocol = requestedProto;

        this._openSocket(url, requestedProto);
    }

    disconnect() {
        // Cancel reconnect
        this._cancelReconnect();
        this._wasEverConnected = false;
        this._intentionalDisconnect = true;

        // Kill socket silently
        this._killSocket();

        // Reset
        this.connected = false;
        this.protocol = null;
        this.gmcpPackages.clear();
        this.telnetOptions = { local: {}, remote: {} };
        this.inputBuffer = new Uint8Array(0);
        this._telnetState = 'NORMAL';
        this._telnetCmd   = 0;
        this._sbOption    = 0;
        this._sbBuffer    = [];
        this.mccp2Active = false;
        this.mccpVersion = 0;
        this.mccp2Inflater = null;
        this.mccp2Chunks = [];
        this.mxpEnabled = false;

        // Emit close AFTER cleanup
        this._emit(Events.CONNECTION_CLOSE, {});
    }

    /**
     * Full cleanup — call when session is destroyed
     */
    dispose() {
        this.disconnect();
        window.removeEventListener('online', this._onlineHandler);
        document.removeEventListener('visibilitychange', this._visibilityHandler);
    }

    isConnected() {
        return this.connected && this.socket?.readyState === WebSocket.OPEN;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SOCKET MANAGEMENT (private)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Kill the socket without emitting any events.
     * Detaches all handlers first to prevent async callbacks.
     */
    _killSocket() {
        this._stopKeepalive();
        if (this.socket) {
            this.socket.onopen = null;
            this.socket.onclose = null;
            this.socket.onerror = null;
            this.socket.onmessage = null;
            try { this.socket.close(); } catch (e) {}
            this.socket = null;
        }
    }

    /**
     * Create and open a new WebSocket.
     */
    _openSocket(url, requestedProto) {
        try {
            let protocols;
            if (requestedProto === 'auto') {
                protocols = [...PROTOCOL_PREFERENCE];
            } else {
                protocols = [requestedProto];
                if (requestedProto !== SUBPROTOCOLS.TERMINAL) {
                    protocols.push(SUBPROTOCOLS.TERMINAL);
                }
            }

            this.socket = new WebSocket(url, protocols);
            this.socket.binaryType = 'arraybuffer';

            // Bind handlers with arrow functions to preserve `this`
            this.socket.onopen = () => this._onOpen();
            this.socket.onclose = (e) => this._onClose(e);
            this.socket.onerror = () => this._onError();
            this.socket.onmessage = (e) => this._onMessage(e);
        } catch (error) {
            this._emit(Events.CONNECTION_ERROR, { error: error.message });
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // WEBSOCKET EVENT HANDLERS (private)
    // ═══════════════════════════════════════════════════════════════════════

    _onOpen() {
        this.connected = true;
        this._wasEverConnected = true;
        this.protocol = this.socket.protocol || SUBPROTOCOLS.TERMINAL;

        // Clear reconnect state
        this._reconnectAttempts = 0;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }

        // Start keepalive
        this._startKeepalive();

        this._emit(Events.CONNECTION_OPEN, {
            protocol: this.protocol,
            requested: this.requestedProtocol
        });

        // Protocol-specific init
        if (this.protocol === SUBPROTOCOLS.GMCP || this.protocol === SUBPROTOCOLS.EXTENDED) {
            this._sendGMCPHandshake();
        }
        // Telnet: GMCP handshake happens in handleWILL when server offers 201
    }

    _onClose(event) {
        const wasConnected = this.connected;
        this.connected = false;
        this._stopKeepalive();

        this._emit(Events.CONNECTION_CLOSE, {
            code: event.code,
            reason: event.reason,
            intentional: this._intentionalDisconnect
        });

        // Only attempt reconnect if:
        // 1. We successfully connected at least once
        // 2. This wasn't a user-initiated quit (intentional disconnect)
        // 3. autoReconnect is enabled for this connection
        // 4. We have a URL to reconnect to
        if (this._wasEverConnected && this._lastUrl &&
            !this._intentionalDisconnect && this._autoReconnect) {
            this._scheduleReconnect();
        }
    }

    _onError() {
        this._emit(Events.CONNECTION_ERROR, { error: 'Connection error' });
    }

    _onMessage(event) {
        const isBinary = event.data instanceof ArrayBuffer;

        switch (this.protocol) {
            case SUBPROTOCOLS.TELNET:
                this._handleTelnetFrame(event.data);
                break;
            case SUBPROTOCOLS.TERMINAL:
                // If the relay sends binary frames despite not negotiating a
                // mudstandards subprotocol, the data contains raw telnet bytes —
                // run through the state machine rather than dumping as raw text.
                isBinary ? this._handleTelnetFrame(event.data) : this._handleTextFrame(event.data);
                break;
            case SUBPROTOCOLS.GMCP:
                // Per mudstandards.org spec: BINARY frames = ANSI terminal text, TEXT frames = GMCP data
                isBinary ? this._handleTextFrame(event.data) : this._handleGMCPBinaryFrame(event.data);
                break;
            case SUBPROTOCOLS.EXTENDED:
                isBinary ? this._handleExtendedBinaryFrame(event.data) : this._handleTextFrame(event.data);
                break;
            case SUBPROTOCOLS.JSON:
                isBinary ? this._handleJSONBinaryFrame(event.data) : this._handleTextFrame(event.data);
                break;
            default:
                // Unknown/custom subprotocol (e.g. "binary", server-specific strings).
                // Binary frames are a raw telnet tunnel — parse them. Text frames pass through.
                isBinary ? this._handleTelnetFrame(event.data) : this._handleTextFrame(event.data);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // RECONNECT (fully instance-scoped)
    // ═══════════════════════════════════════════════════════════════════════

    _scheduleReconnect() {
        if (this._reconnectAttempts >= 5) {
            this._emit(Events.CONNECTION_DATA, {
                type: 'text',
                data: `\r\n\x1b[31m[Reconnect failed after 5 attempts.]\x1b[0m\r\n`
            });
            this._reconnectAttempts = 0;
            this._wasEverConnected = false;
            return;
        }

        const delay = Math.min(
            1000 * Math.pow(2, this._reconnectAttempts),
            this._reconnectMaxDelay
        );
        this._reconnectAttempts++;

        this._emit(Events.CONNECTION_DATA, {
            type: 'text',
            data: `\r\n\x1b[33m[Reconnecting in ${Math.round(delay / 1000)}s... (${this._reconnectAttempts}/5)]\x1b[0m\r\n`
        });

        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            if (!this.connected && this._lastUrl && this._wasEverConnected) {
                this._doReconnect();
            }
        }, delay);
    }

    /**
     * Perform reconnect. Does NOT call connect() or disconnect().
     * Silently replaces the dead socket with a fresh one.
     */
    _doReconnect() {
        const savedAttempts = this._reconnectAttempts;

        // Kill dead socket silently
        this._killSocket();

        // Reset telnet/protocol state
        this.inputBuffer = new Uint8Array(0);
        this.telnetOptions = { local: {}, remote: {} };
        this._telnetState = 'NORMAL';
        this._telnetCmd   = 0;
        this._sbOption    = 0;
        this._sbBuffer    = [];
        this.ttypeIndex = 0;
        this.gmcpPackages.clear();
        this.mccp2Active = false;
        this.mccpVersion = 0;
        this.mccp2Inflater = null;
        this.mccp2Chunks = [];
        this.mxpEnabled = false;

        const requestedProto = PROTOCOL_MAP[this._lastOptions?.protocol] || 'auto';
        this.requestedProtocol = requestedProto;

        // Open fresh socket
        this._openSocket(this._lastUrl, requestedProto);

        // Preserve attempt counter
        this._reconnectAttempts = savedAttempts;
    }

    _cancelReconnect() {
        this._reconnectAttempts = 0;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }

    cancelReconnect() {
        this._wasEverConnected = false;
        this._cancelReconnect();
    }

    /**
     * Mark the next disconnect as intentional (user sent quit/logout).
     * Prevents auto-reconnect.
     */
    markIntentionalDisconnect() {
        this._intentionalDisconnect = true;
    }

    /**
     * Set autoReconnect at runtime (e.g. from settings change)
     */
    setAutoReconnect(enabled) {
        this._autoReconnect = enabled;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // NETWORK RESILIENCE — wifi↔cellular, sleep/wake
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Browser came back online (wifi↔cellular switch, network restored).
     * If we had an active connection that dropped, attempt immediate reconnect.
     */
    _handleNetworkOnline() {
        if (!this._wasEverConnected || !this._lastUrl) return;
        if (this._intentionalDisconnect) return;
        if (!this._autoReconnect) return;
        if (this.connected) return;

        // Cancel any pending scheduled reconnect — we can try now
        this._cancelReconnect();
        this._reconnectAttempts = 0;

        this._emit(Events.CONNECTION_DATA, {
            type: 'text',
            data: `\r\n\x1b[36m[Network restored — reconnecting...]\x1b[0m\r\n`
        });

        this._doReconnect();
    }

    /**
     * Tab became visible again (phone unlocked, tab switched back).
     * Check if our socket is dead and reconnect if needed.
     */
    _handleVisibilityChange() {
        if (document.hidden) return; // Only act when becoming visible
        if (!this._wasEverConnected || !this._lastUrl) return;
        if (this._intentionalDisconnect) return;
        if (!this._autoReconnect) return;

        // Check if socket is actually dead
        if (this.socket && this.socket.readyState === WebSocket.OPEN) return;
        if (this.connected) return; // State says connected, trust it for now

        // Socket is gone — reconnect
        this._cancelReconnect();
        this._reconnectAttempts = 0;

        this._emit(Events.CONNECTION_DATA, {
            type: 'text',
            data: `\r\n\x1b[36m[Connection lost while away — reconnecting...]\x1b[0m\r\n`
        });

        this._doReconnect();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // KEEPALIVE
    // ═══════════════════════════════════════════════════════════════════════

    _startKeepalive() {
        this._stopKeepalive();
        if (this.protocol === SUBPROTOCOLS.TELNET) {
            this._keepaliveTimer = setInterval(() => {
                if (this.connected && this.socket?.readyState === WebSocket.OPEN) {
                    this.socket.send(new Uint8Array([IAC, NOP]).buffer);
                }
            }, 30000);
        }
    }

    _stopKeepalive() {
        if (this._keepaliveTimer) {
            clearInterval(this._keepaliveTimer);
            this._keepaliveTimer = null;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SEND FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    // Patterns that indicate user-initiated disconnect
    // These prevent auto-reconnect after the server closes the connection
    static QUIT_PATTERNS = /^\s*(quit|logout|log\s*out|exit|bye|disconnect|@quit|@shutdown|QUIT)\s*$/i;

    send(cmd) {
        if (!this.socket || !this.connected) return;

        // Detect quit/logout commands — mark as intentional so we don't reconnect
        if (ConnectionManager.QUIT_PATTERNS.test(cmd)) {
            this._intentionalDisconnect = true;
        }

        if (this.protocol === SUBPROTOCOLS.TELNET || this.protocol === SUBPROTOCOLS.GMCP) {
            // TELNET and GMCP both send player commands as binary frames
            this.socket.send(this._encoder.encode(cmd + '\r\n').buffer);
        } else {
            this.socket.send(cmd + '\r\n');
        }

        this._emit(Events.COMMAND_SENT, { command: cmd });
    }

    sendRaw(data) {
        if (!this.socket || !this.connected) return;
        if (this.protocol === SUBPROTOCOLS.TELNET && typeof data === 'string') {
            this.socket.send(this._encoder.encode(data));
        } else {
            this.socket.send(data);
        }
    }

    sendBinary(bytes) {
        if (!this.socket || !this.connected) return;
        this.socket.send(bytes.buffer);
    }

    sendGMCP(pkg, data) {
        if (!this.socket || !this.connected) return;

        const payload = data !== undefined ? pkg + ' ' + JSON.stringify(data) : pkg;
        const payloadBytes = this._encoder.encode(payload);

        switch (this.protocol) {
            case SUBPROTOCOLS.GMCP:
                // Per mudstandards.org spec: GMCP messages sent as TEXT frames (string)
                this.socket.send(payload);
                break;
            case SUBPROTOCOLS.EXTENDED: {
                const p = new Uint8Array(1 + payloadBytes.length);
                p[0] = TELOPT_GMCP;
                p.set(payloadBytes, 1);
                this.socket.send(p.buffer);
                break;
            }
            case SUBPROTOCOLS.JSON: {
                const j = JSON.stringify({ proto: 'gmcp', id: pkg, data: JSON.stringify(data) });
                this.socket.send(this._encoder.encode(j).buffer);
                break;
            }
            case SUBPROTOCOLS.TELNET:
                this._sendTelnetSubneg(TELOPT_GMCP, payloadBytes);
                break;
        }
    }

    sendMSDP(varName) {
        if (!this.socket || !this.connected) return;
        if (!this.telnetOptions.remote[TELOPT_MSDP]) return;

        const nameBytes = this._encoder.encode(varName);
        const data = new Uint8Array(1 + nameBytes.length);
        data[0] = MSDP_VAR;
        data.set(nameBytes, 1);

        if (this.protocol === SUBPROTOCOLS.TELNET) {
            this._sendTelnetSubneg(TELOPT_MSDP, data);
        } else if (this.protocol === SUBPROTOCOLS.EXTENDED) {
            const p = new Uint8Array(2 + nameBytes.length);
            p[0] = TELOPT_MSDP;
            p[1] = MSDP_VAR;
            p.set(nameBytes, 2);
            this.socket.send(p.buffer);
        }
    }

    sendMSDPVar(varName, varValue) {
        if (!this.socket || !this.connected) return;
        if (!this.telnetOptions.remote[TELOPT_MSDP]) return;

        const nameBytes = this._encoder.encode(varName);
        const valBytes = this._encoder.encode(varValue);
        const data = new Uint8Array(2 + nameBytes.length + valBytes.length);
        data[0] = MSDP_VAR;
        data.set(nameBytes, 1);
        data[1 + nameBytes.length] = MSDP_VAL;
        data.set(valBytes, 2 + nameBytes.length);

        if (this.protocol === SUBPROTOCOLS.TELNET) {
            this._sendTelnetSubneg(TELOPT_MSDP, data);
        } else if (this.protocol === SUBPROTOCOLS.EXTENDED) {
            const p = new Uint8Array(1 + data.length);
            p[0] = TELOPT_MSDP;
            p.set(data, 1);
            this.socket.send(p.buffer);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TELNET NEGOTIATION
    // ═══════════════════════════════════════════════════════════════════════

    _sendTelnetNeg(cmd, option) {
        if (!this.socket || !this.connected) return;
        if (this.protocol !== SUBPROTOCOLS.TELNET) return;
        this.socket.send(new Uint8Array([IAC, cmd, option]).buffer);
    }

    _sendTelnetSubneg(option, data) {
        if (!this.socket || !this.connected) return;
        if (this.protocol !== SUBPROTOCOLS.TELNET) return;

        // Escape IAC bytes
        let escaped = [];
        for (let i = 0; i < data.length; i++) {
            escaped.push(data[i]);
            if (data[i] === IAC) escaped.push(IAC);
        }

        const packet = new Uint8Array(5 + escaped.length);
        packet[0] = IAC;
        packet[1] = SB;
        packet[2] = option;
        packet.set(new Uint8Array(escaped), 3);
        packet[3 + escaped.length] = IAC;
        packet[4 + escaped.length] = SE;
        this.socket.send(packet.buffer);
    }

    _handleNegotiation(cmd, option) {
        switch (cmd) {
            case DO:   this._handleDO(option);   break;
            case DONT: this._handleDONT(option); break;
            case WILL: this._handleWILL(option); break;
            case WONT: this._handleWONT(option); break;
        }
    }

    _handleDO(option) {
        const supported = [
            TELOPT_TTYPE, TELOPT_NAWS, TELOPT_SGA,
            TELOPT_LINEMODE, TELOPT_NEWENVIRON, TELOPT_CHARSET
        ];
        if (supported.includes(option)) {
            if (!this.telnetOptions.local[option]) {
                this.telnetOptions.local[option] = true;
                this._sendTelnetNeg(WILL, option);
                if (option === TELOPT_NAWS) this.sendNAWS();
                if (option === TELOPT_LINEMODE) this._sendLinemodeMode();
            }
        } else {
            this._sendTelnetNeg(WONT, option);
        }
    }

    _handleDONT(option) {
        if (this.telnetOptions.local[option]) {
            this.telnetOptions.local[option] = false;
            this._sendTelnetNeg(WONT, option);
        }
    }

    _handleWILL(option) {
        const wanted = [
            TELOPT_GMCP, TELOPT_MSDP, TELOPT_MSSP, TELOPT_SGA,
            TELOPT_ECHO, TELOPT_EOR, TELOPT_MCCP2, TELOPT_MCCP3,
            TELOPT_MXP, TELOPT_CHARSET
        ];
        if (wanted.includes(option)) {
            if (!this.telnetOptions.remote[option]) {
                this.telnetOptions.remote[option] = true;
                this._sendTelnetNeg(DO, option);
                if (option === TELOPT_GMCP) this._sendGMCPHandshake();
                if (option === TELOPT_ECHO) {
                    this._emit(Events.TELNET_SUBNEG, { option: 'ECHO', enabled: true });
                }
                if (option === TELOPT_MXP) {
                    this._emit(Events.TELNET_SUBNEG, { option: 'MXP', enabled: true });
                }
            }
        } else {
            this._sendTelnetNeg(DONT, option);
        }
    }

    _handleWONT(option) {
        if (this.telnetOptions.remote[option]) {
            this.telnetOptions.remote[option] = false;
            this._sendTelnetNeg(DONT, option);
            if (option === TELOPT_ECHO) {
                this._emit(Events.TELNET_SUBNEG, { option: 'ECHO', enabled: false });
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TELNET SUBNEGOTIATION SENDERS
    // ═══════════════════════════════════════════════════════════════════════

    sendNAWS() {
        const w = this.terminalWidth;
        const h = this.terminalHeight;

        if (this.protocol === SUBPROTOCOLS.TELNET) {
            const data = new Uint8Array(4);
            data[0] = (w >> 8) & 0xFF;
            data[1] = w & 0xFF;
            data[2] = (h >> 8) & 0xFF;
            data[3] = h & 0xFF;
            this._sendTelnetSubneg(TELOPT_NAWS, data);
        } else if (this.protocol === SUBPROTOCOLS.EXTENDED) {
            const p = new Uint8Array(5);
            p[0] = TELOPT_NAWS;
            p[1] = (w >> 8) & 0xFF;
            p[2] = w & 0xFF;
            p[3] = (h >> 8) & 0xFF;
            p[4] = h & 0xFF;
            this.socket.send(p.buffer);
        }

        this._emit(Events.TELNET_NAWS, { width: w, height: h, sent: true });
    }

    _sendTTYPE() {
        const type = this.ttypeList[this.ttypeIndex];
        this.ttypeIndex = (this.ttypeIndex + 1) % this.ttypeList.length;
        const typeBytes = this._encoder.encode(type);

        if (this.protocol === SUBPROTOCOLS.TELNET) {
            const data = new Uint8Array(1 + typeBytes.length);
            data[0] = TTYPE_IS;
            data.set(typeBytes, 1);
            this._sendTelnetSubneg(TELOPT_TTYPE, data);
        } else if (this.protocol === SUBPROTOCOLS.EXTENDED) {
            const p = new Uint8Array(2 + typeBytes.length);
            p[0] = TELOPT_TTYPE;
            p[1] = TTYPE_IS;
            p.set(typeBytes, 2);
            this.socket.send(p.buffer);
        }

        this._emit(Events.TELNET_TTYPE, { type, sent: true });
    }

    _sendGMCPHandshake() {
        this.sendGMCP('Core.Hello', { client: 'MudTerm', version: '2.0.0' });
        this.sendGMCP('Core.Supports.Set', this.gmcpSupported);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FRAME HANDLERS
    // ═══════════════════════════════════════════════════════════════════════

    _handleTextFrame(data) {
        const text = (data instanceof ArrayBuffer) ? this._decoder.decode(data) : data;
        this._emit(Events.CONNECTION_DATA, { type: 'text', data: text });
    }

    _handleTelnetFrame(data) {
        let bytes = new Uint8Array(data);

        if (this.mccp2Active && this.mccp2Inflater) {
            bytes = this._inflateMCCP(bytes);
            if (bytes === null) return;
        }

        // Append to buffer
        const newBuf = new Uint8Array(this.inputBuffer.length + bytes.length);
        newBuf.set(this.inputBuffer);
        newBuf.set(bytes, this.inputBuffer.length);
        this.inputBuffer = newBuf;

        this._processTelnetBuffer();
    }

    _handleGMCPBinaryFrame(data) {
        this._parseGMCPPayload(new Uint8Array(data));
    }

    _handleExtendedBinaryFrame(data) {
        const bytes = new Uint8Array(data);
        if (bytes.length < 1) return;
        const option = bytes[0];
        const content = bytes.slice(1);

        switch (option) {
            case TELOPT_GMCP:  this._parseGMCPPayload(content); break;
            case TELOPT_NAWS:  this.sendNAWS(); break;
            case TELOPT_TTYPE:
                if (content.length > 0 && content[0] === TTYPE_SEND) this._sendTTYPE();
                break;
            case TELOPT_MSDP:  this._parseMSDPPayload(content, 'MSDP'); break;
            case TELOPT_MSSP:  this._parseMSDPPayload(content, 'MSSP'); break;
            default: this._emit(Events.TELNET_SUBNEG, { option, data: content });
        }
    }

    _handleJSONBinaryFrame(data) {
        try {
            const text = this._decoder.decode(data);
            const json = JSON.parse(text);
            if (json.proto === 'gmcp' && json.id) {
                const gmcpData = json.data ? JSON.parse(json.data) : {};
                this._emit(Events.GMCP_RECEIVED, { package: json.id, data: gmcpData });
                this._handleGMCPData(json.id, gmcpData);
            } else {
                this._emit(Events.CONNECTION_DATA, { type: 'json', data: json });
            }
        } catch (e) {
            console.error('[JSON] Parse error:', e);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // MCCP COMPRESSION
    // ═══════════════════════════════════════════════════════════════════════

    _inflateMCCP(compressed) {
        if (!this.mccp2Inflater) return null;
        const ver = this.mccpVersion || 2;

        try {
            this.mccp2Chunks = [];

            this.mccp2Inflater.push(compressed, false);

            const parts = [...this.mccp2Chunks];
            const strmOut = this.mccp2Inflater.strm ? this.mccp2Inflater.strm.next_out : 0;
            if (strmOut > 0 && this.mccp2Inflater.strm) {
                const strmStart = (this.mccp2Chunks.length > 0) ? 0 : prevOut;
                if (strmOut > strmStart) {
                    parts.push(new Uint8Array(
                        this.mccp2Inflater.strm.output.subarray(strmStart, strmOut)
                    ));
                }
            }

            let decompressed;
            if (parts.length === 0) decompressed = new Uint8Array(0);
            else if (parts.length === 1) decompressed = parts[0];
            else {
                const total = parts.reduce((s, c) => s + c.length, 0);
                decompressed = new Uint8Array(total);
                let off = 0;
                for (const p of parts) { decompressed.set(p, off); off += p.length; }
            }

            if (this.mccp2Inflater.err === 1 || this.mccp2Inflater.ended) {
                const unconsumed = (this.mccp2Inflater.strm?.avail_in > 0)
                    ? compressed.slice(compressed.length - this.mccp2Inflater.strm.avail_in)
                    : new Uint8Array(0);

                this._deactivateMCCP(ver);

                if (unconsumed.length > 0) {
                    const combined = new Uint8Array(decompressed.length + unconsumed.length);
                    combined.set(decompressed);
                    combined.set(unconsumed, decompressed.length);
                    return combined;
                }
                return decompressed;
            }

            if (this.mccp2Inflater.err < 0 && this.mccp2Inflater.err !== -5) {
                this._deactivateMCCP(ver);
                return null;
            }

            return decompressed;
        } catch (e) {
            this._deactivateMCCP(ver);
            return null;
        }
    }

    _activateMCCP(version) {
        if (this.mccp2Inflater) this.mccp2Inflater = null;
        this.mccp2Active = true;
        this.mccpVersion = version;
        this.mccp2Chunks = [];
        this.mccp2Inflater = new pako.Inflate({ raw: true });
        this.mccp2Inflater.onData = (chunk) => {
            this.mccp2Chunks.push(new Uint8Array(chunk));
        };
        this._emit(Events.TELNET_SUBNEG, { option: `MCCP${version}`, enabled: true });
    }

    _deactivateMCCP(version) {
        this.mccp2Active = false;
        this.mccpVersion = 0;
        this.mccp2Inflater = null;
        this.mccp2Chunks = [];
        this._emit(Events.TELNET_SUBNEG, { option: `MCCP${version}`, enabled: false });
    }
    // ═══════════════════════════════════════════════════════════════════════
    // TELNET BUFFER PROCESSING
    // ═══════════════════════════════════════════════════════════════════════

    _processTelnetBuffer() {
        const buf = this.inputBuffer;
        this.inputBuffer = new Uint8Array(0);

        let textChunks = [];

        const flushText = () => {
            if (textChunks.length > 0) {
                this._emit(Events.CONNECTION_DATA, {
                    type: 'text',
                    data: this._decoder.decode(new Uint8Array(textChunks))
                });
                textChunks = [];
            }
        };

        for (let i = 0; i < buf.length; i++) {
            const byte = buf[i];

            switch (this._telnetState) {

                case 'NORMAL':
                    if (byte === IAC) {
                        this._telnetState = 'IAC';
                    } else {
                        textChunks.push(byte);
                    }
                    break;

                case 'IAC':
                    if (byte === IAC) {
                        // IAC IAC → literal 0xFF in data stream
                        textChunks.push(IAC);
                        this._telnetState = 'NORMAL';
                    } else if (byte === SB) {
                        flushText();
                        this._telnetState = 'SB_OPTION';
                    } else if (byte === WILL || byte === WONT || byte === DO || byte === DONT) {
                        flushText();
                        this._telnetCmd = byte;
                        this._telnetState = 'NEGOTIATION';
                    } else if (byte === GA || byte === EOR) {
                        flushText();
                        this._emit(Events.CONNECTION_DATA, { type: 'prompt-marker' });
                        this._telnetState = 'NORMAL';
                    } else if (byte === AYT) {
                        this.send('[Yes]');
                        this._telnetState = 'NORMAL';
                    } else {
                        // NOP and other single-byte commands
                        this._telnetState = 'NORMAL';
                    }
                    break;

                case 'NEGOTIATION':
                    this._handleNegotiation(this._telnetCmd, byte);
                    this._telnetCmd = 0;
                    this._telnetState = 'NORMAL';
                    break;

                case 'SB_OPTION':
                    this._sbOption = byte;
                    this._sbBuffer = [];
                    this._telnetState = 'SB_DATA';
                    break;

                case 'SB_DATA':
                    if (byte === IAC) {
                        this._telnetState = 'SB_IAC';
                    } else {
                        this._sbBuffer.push(byte);
                    }
                    break;

                case 'SB_IAC':
                    if (byte === SE) {
                        // Complete subnegotiation
                        this._handleSubnegotiation(this._sbOption, new Uint8Array(this._sbBuffer));
                        this._sbBuffer = [];
                        this._telnetState = 'NORMAL';

                        // MCCP mid-buffer activation: remaining bytes are compressed
                        if (this.mccp2Active && i + 1 < buf.length) {
                            const inflated = this._inflateMCCP(buf.slice(i + 1));
                            if (inflated && inflated.length > 0) {
                                this.inputBuffer = inflated;
                                this._processTelnetBuffer();
                            }
                            return;
                        }
                    } else if (byte === IAC) {
                        // IAC IAC inside subneg → escaped 0xFF
                        this._sbBuffer.push(IAC);
                        this._telnetState = 'SB_DATA';
                    } else {
                        // Malformed — treat IAC + byte as raw data and continue
                        this._sbBuffer.push(IAC);
                        this._sbBuffer.push(byte);
                        this._telnetState = 'SB_DATA';
                    }
                    break;
            }
        }

        flushText();
    }

    _handleSubnegotiation(option, data) {
        switch (option) {
            case TELOPT_GMCP:
                this._parseGMCPPayload(data);
                break;
            case TELOPT_TTYPE:
                if (data.length > 0 && data[0] === TTYPE_SEND) this._sendTTYPE();
                break;
            case TELOPT_MSDP:
                this._parseMSDPPayload(data, 'MSDP');
                break;
            case TELOPT_MSSP:
                this._parseMSDPPayload(data, 'MSSP');
                break;
            case TELOPT_MCCP2:
                this._activateMCCP(2);
                break;
            case TELOPT_MCCP3:
                this._activateMCCP(3);
                break;
            case TELOPT_LINEMODE:
                this._handleLinemodeSubneg(data);
                break;
            case TELOPT_NEWENVIRON:
                this._handleNewEnvironSubneg(data);
                break;
            case TELOPT_CHARSET:
                this._handleCharsetSubneg(data);
                break;
            case TELOPT_MXP:
                this._handleMXPSubneg(data);
                break;
            default:
                this._emit(Events.TELNET_SUBNEG, { option, data });
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // LINEMODE (RFC 1184)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Send initial LINEMODE mode.
     * Mode 0 = character-at-a-time (server handles editing).
     * We prefer this since we have our own input field.
     */
    _sendLinemodeMode() {
        // SB LINEMODE MODE 0 (character mode, no local editing)
        const data = new Uint8Array([1, 0]); // 1=MODE, 0=no flags
        this._sendTelnetSubneg(TELOPT_LINEMODE, data);
        this._emit(Events.TELNET_SUBNEG, { option: 'LINEMODE', mode: 'character' });
    }

    _handleLinemodeSubneg(data) {
        if (data.length < 1) return;
        const cmd = data[0];

        if (cmd === 1) {
            // MODE — server requesting mode change
            const mode = data.length > 1 ? data[1] : 0;
            const edit = !!(mode & 1);    // EDIT bit
            const trapsig = !!(mode & 2); // TRAPSIG bit
            const ack = !!(mode & 4);     // MODE_ACK bit

            if (!ack) {
                // Acknowledge with ACK bit set, keep character mode
                const response = new Uint8Array([1, mode | 4]);
                this._sendTelnetSubneg(TELOPT_LINEMODE, response);
            }

            this._emit(Events.TELNET_SUBNEG, {
                option: 'LINEMODE', mode: edit ? 'line' : 'character',
                edit, trapsig
            });
        } else if (cmd === 3) {
            // SLC (Set Local Characters) — server defining special chars
            // Parse and acknowledge
            if (data.length > 1) {
                this._sendTelnetSubneg(TELOPT_LINEMODE, data);
            }
            this._emit(Events.TELNET_SUBNEG, { option: 'LINEMODE-SLC', data });
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // NEW-ENVIRON (RFC 1572)
    // ═══════════════════════════════════════════════════════════════════════

    _handleNewEnvironSubneg(data) {
        if (data.length < 1) return;

        if (data[0] === NEWENV_SEND) {
            // Server requesting environment variables
            const requested = this._parseNewEnvironRequest(data.slice(1));
            this._sendNewEnvironResponse(requested);
        }
    }

    _parseNewEnvironRequest(data) {
        // Parse which variables the server wants
        const vars = [];
        let i = 0;
        while (i < data.length) {
            const type = data[i]; // VAR or USERVAR
            i++;
            let name = '';
            while (i < data.length && data[i] !== NEWENV_VAR && data[i] !== NEWENV_USERVAR) {
                if (data[i] === NEWENV_ESC && i + 1 < data.length) {
                    name += String.fromCharCode(data[i + 1]);
                    i += 2;
                } else {
                    name += String.fromCharCode(data[i]);
                    i++;
                }
            }
            vars.push({ type: type === NEWENV_USERVAR ? 'USERVAR' : 'VAR', name });
        }
        // If empty, server wants all
        if (vars.length === 0) vars.push({ type: 'VAR', name: '' });
        return vars;
    }

    _sendNewEnvironResponse(requested) {
        // Standard environment variables we provide
        const envVars = {
            'SYSTEMTYPE': 'WebSocket',
            'TERM': 'xterm-256color',
            'LANG': 'en_US.UTF-8',
            'CLIENT_NAME': 'MudTerm',
            'CLIENT_VERSION': '2.0.0'
        };

        const parts = [NEWENV_IS];

        const addVar = (type, name, value) => {
            parts.push(type === 'USERVAR' ? NEWENV_USERVAR : NEWENV_VAR);
            for (const ch of this._encoder.encode(name)) parts.push(ch);
            parts.push(NEWENV_VALUE);
            for (const ch of this._encoder.encode(value)) parts.push(ch);
        };

        if (requested.length === 1 && requested[0].name === '') {
            // Send all
            for (const [name, value] of Object.entries(envVars)) {
                addVar('VAR', name, value);
            }
        } else {
            for (const req of requested) {
                const val = envVars[req.name];
                if (val !== undefined) {
                    addVar(req.type, req.name, val);
                }
            }
        }

        this._sendTelnetSubneg(TELOPT_NEWENVIRON, new Uint8Array(parts));
        this._emit(Events.TELNET_SUBNEG, { option: 'NEW-ENVIRON', sent: true });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CHARSET (RFC 2066)
    // ═══════════════════════════════════════════════════════════════════════

    _handleCharsetSubneg(data) {
        if (data.length < 2) return;

        if (data[0] === CHARSET_REQUEST) {
            // data[1] = separator byte, followed by charset names separated by that byte
            const sep = data[1];
            const charsetStr = this._decoder.decode(data.slice(2));
            const charsets = charsetStr.split(String.fromCharCode(sep))
                .map(s => s.trim().toUpperCase())
                .filter(s => s.length > 0);

            // We support UTF-8 preferentially, then ASCII
            const preferred = ['UTF-8', 'US-ASCII', 'ASCII'];
            let accepted = null;
            for (const pref of preferred) {
                if (charsets.includes(pref)) { accepted = pref; break; }
            }

            if (accepted) {
                const accBytes = this._encoder.encode(accepted);
                const response = new Uint8Array(1 + accBytes.length);
                response[0] = CHARSET_ACCEPTED;
                response.set(accBytes, 1);
                this._sendTelnetSubneg(TELOPT_CHARSET, response);
                this._emit(Events.TELNET_SUBNEG, { option: 'CHARSET', accepted });
            } else {
                this._sendTelnetSubneg(TELOPT_CHARSET, new Uint8Array([CHARSET_REJECTED]));
                this._emit(Events.TELNET_SUBNEG, { option: 'CHARSET', rejected: true, offered: charsets });
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // MXP (MUD eXtension Protocol, option 91)
    // ═══════════════════════════════════════════════════════════════════════

    _handleMXPSubneg(data) {
        // MXP subneg is typically empty (just SB 91 SE) to signal mode switch
        // Some servers send version/feature data
        this.mxpEnabled = true;
        this._emit(Events.TELNET_SUBNEG, { option: 'MXP', enabled: true });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // GMCP PARSING
    // ═══════════════════════════════════════════════════════════════════════

    _parseGMCPPayload(bytes) {
        const text = this._decoder.decode(bytes);
        const spaceIndex = text.indexOf(' ');
        let pkg, data;

        if (spaceIndex === -1) {
            pkg = text;
            data = {};
        } else {
            pkg = text.substring(0, spaceIndex);
            try { data = JSON.parse(text.substring(spaceIndex + 1)); }
            catch (e) { data = text.substring(spaceIndex + 1); }
        }

        this._emit(Events.GMCP_RECEIVED, { package: pkg, data });
        this._handleGMCPData(pkg, data);
    }

    _handleGMCPData(pkg, data) {
        const pkgBase = pkg.split('.')[0];
        this.gmcpPackages.add(pkgBase);

        const eventMap = {
            'Core.Hello': Events.GMCP_HELLO,
            'Core.Supports.Set': Events.GMCP_SUPPORTS,
            'Core.Supports.Add': Events.GMCP_SUPPORTS,
            'Core.Supports.Remove': Events.GMCP_SUPPORTS,
            'Char.Vitals': Events.CHAR_VITALS,
            'Char.Status': Events.CHAR_STATUS,
            'Char.Info': Events.CHAR_INFO,
            'Room.Info': Events.ROOM_INFO,
            'Comm.Channel': Events.COMM_CHANNEL
        };

        if (eventMap[pkg]) {
            this._emit(eventMap[pkg], data);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // MSDP PARSING
    // ═══════════════════════════════════════════════════════════════════════

    _parseMSDPPayload(bytes, type = 'MSDP') {
        const result = this._parseMSDP(bytes);
        if (type === 'MSSP') this._emit(Events.MSSP_DATA, result);
        else this._emit(Events.MSDP_DATA, result);
    }

    _parseMSDP(bytes) {
        const result = {};
        let i = 0;
        let currentVar = null;

        while (i < bytes.length) {
            if (bytes[i] === MSDP_VAR) {
                i++;
                let end = i;
                while (end < bytes.length && bytes[end] !== MSDP_VAL && bytes[end] !== MSDP_VAR) end++;
                currentVar = this._decoder.decode(bytes.slice(i, end));
                i = end;
            } else if (bytes[i] === MSDP_VAL && currentVar) {
                i++;
                if (i < bytes.length && bytes[i] === MSDP_TABLE_OPEN) {
                    const r = this._parseMSDPTable(bytes, i);
                    result[currentVar] = r.value;
                    i = r.endIndex;
                } else if (i < bytes.length && bytes[i] === MSDP_ARRAY_OPEN) {
                    const r = this._parseMSDPArray(bytes, i);
                    result[currentVar] = r.value;
                    i = r.endIndex;
                } else {
                    let end = i;
                    while (end < bytes.length && bytes[end] !== MSDP_VAR && bytes[end] !== MSDP_VAL) end++;
                    result[currentVar] = this._decoder.decode(bytes.slice(i, end));
                    i = end;
                }
                currentVar = null;
            } else {
                i++;
            }
        }
        return result;
    }

    _parseMSDPTable(bytes, startIndex) {
        const result = {};
        let i = startIndex + 1;
        let currentVar = null;

        while (i < bytes.length) {
            if (bytes[i] === MSDP_TABLE_CLOSE) return { value: result, endIndex: i + 1 };
            else if (bytes[i] === MSDP_VAR) {
                i++;
                let end = i;
                while (end < bytes.length && bytes[end] !== MSDP_VAL && bytes[end] !== MSDP_VAR && bytes[end] !== MSDP_TABLE_CLOSE) end++;
                currentVar = this._decoder.decode(bytes.slice(i, end));
                i = end;
            } else if (bytes[i] === MSDP_VAL && currentVar) {
                i++;
                if (i < bytes.length && bytes[i] === MSDP_TABLE_OPEN) {
                    const r = this._parseMSDPTable(bytes, i);
                    result[currentVar] = r.value; i = r.endIndex;
                } else if (i < bytes.length && bytes[i] === MSDP_ARRAY_OPEN) {
                    const r = this._parseMSDPArray(bytes, i);
                    result[currentVar] = r.value; i = r.endIndex;
                } else {
                    let end = i;
                    while (end < bytes.length && bytes[end] !== MSDP_VAR && bytes[end] !== MSDP_TABLE_CLOSE) end++;
                    result[currentVar] = this._decoder.decode(bytes.slice(i, end));
                    i = end;
                }
                currentVar = null;
            } else { i++; }
        }
        return { value: result, endIndex: i };
    }

    _parseMSDPArray(bytes, startIndex) {
        const result = [];
        let i = startIndex + 1;

        while (i < bytes.length) {
            if (bytes[i] === MSDP_ARRAY_CLOSE) return { value: result, endIndex: i + 1 };
            else if (bytes[i] === MSDP_VAL) {
                i++;
                if (i < bytes.length && bytes[i] === MSDP_TABLE_OPEN) {
                    const r = this._parseMSDPTable(bytes, i);
                    result.push(r.value); i = r.endIndex;
                } else if (i < bytes.length && bytes[i] === MSDP_ARRAY_OPEN) {
                    const r = this._parseMSDPArray(bytes, i);
                    result.push(r.value); i = r.endIndex;
                } else {
                    let end = i;
                    while (end < bytes.length && bytes[end] !== MSDP_VAL && bytes[end] !== MSDP_ARRAY_CLOSE) end++;
                    result.push(this._decoder.decode(bytes.slice(i, end)));
                    i = end;
                }
            } else { i++; }
        }
        return { value: result, endIndex: i };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // UTILITY
    // ═══════════════════════════════════════════════════════════════════════

    getProtocol() { return this.protocol; }

    hasGMCP() {
        return this.protocol === SUBPROTOCOLS.GMCP ||
               this.protocol === SUBPROTOCOLS.EXTENDED ||
               this.protocol === SUBPROTOCOLS.JSON ||
               this.telnetOptions.remote[TELOPT_GMCP];
    }

    hasMSDP() { return this.telnetOptions.remote[TELOPT_MSDP]; }
    hasMXP() { return this.mxpEnabled || this.telnetOptions.remote[TELOPT_MXP]; }
    hasCharset() { return this.telnetOptions.local[TELOPT_CHARSET] || this.telnetOptions.remote[TELOPT_CHARSET]; }
    hasNewEnviron() { return this.telnetOptions.local[TELOPT_NEWENVIRON]; }
    hasLinemode() { return this.telnetOptions.local[TELOPT_LINEMODE]; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export const connectionManager = new ConnectionManager();
export { ConnectionManager, SUBPROTOCOLS };
export default connectionManager;
