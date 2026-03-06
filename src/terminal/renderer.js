/**
 * Terminal Renderer
 * Wrapper around xterm.js with custom configuration and event handling
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';

import { events, Events } from '../core/events.js';
import state from '../core/state.js';
import connectionManager from '../connection/manager.js';

class TerminalRenderer {
    constructor() {
        this.terminal = null;
        this.fitAddon = null;
        this.webglAddon = null;
        this.container = null;
        this.inputBuffer = '';
        this.cursorPosition = 0;
        
        // Bind event handlers
        this.handleOutput = this.handleOutput.bind(this);
        this.handleResize = this.handleResize.bind(this);
    }
    
    /**
     * Initialize the terminal in a container
     * @param {HTMLElement} container 
     */
    init(container) {
        this.container = container;
        
        // Get settings
        const settings = state.getState().settings;
        
        // Create terminal
        this.terminal = new Terminal({
            cursorBlink: true,
            cursorStyle: 'block',
            fontSize: settings.fontSize || 14,
            fontFamily: settings.fontFamily || '"Fira Code", "Cascadia Code", Consolas, monospace',
            theme: this.getTheme(),
            scrollback: settings.scrollbackLines || 5000,
            convertEol: true,
            allowProposedApi: true,
        });
        
        // Add addons
        this.fitAddon = new FitAddon();
        this.terminal.loadAddon(this.fitAddon);
        
        // Web links (clickable URLs)
        const webLinksAddon = new WebLinksAddon();
        this.terminal.loadAddon(webLinksAddon);
        
        // Open terminal
        this.terminal.open(container);
        
        // Try WebGL renderer for performance
        try {
            this.webglAddon = new WebglAddon();
            this.terminal.loadAddon(this.webglAddon);
            console.log('WebGL renderer enabled');
        } catch (err) {
            console.log('WebGL not available, using canvas renderer');
        }
        
        // Fit to container
        this.fit();
        
        // Handle keyboard input
        this.terminal.onKey(({ key, domEvent }) => {
            this.handleKeyPress(key, domEvent);
        });
        
        // Handle paste
        this.terminal.onData((data) => {
            // Only handle paste (multi-character input)
            if (data.length > 1 && !data.startsWith('\x1b')) {
                this.handlePaste(data);
            }
        });
        
        // Subscribe to output events
        events.on(Events.TERMINAL_OUTPUT, this.handleOutput);
        events.on(Events.TERMINAL_CLEAR, () => this.clear());
        
        // Handle window resize
        window.addEventListener('resize', this.handleResize);
        
        // Write welcome message
        this.writeWelcome();
        
        // Show prompt
        this.showPrompt();
    }
    
    /**
     * Get terminal theme based on settings
     */
    getTheme() {
        // Dark theme
        return {
            background: '#1a1a2e',
            foreground: '#e0e0e0',
            cursor: '#7c3aed',
            cursorAccent: '#1a1a2e',
            selection: 'rgba(124, 58, 237, 0.3)',
            black: '#1a1a2e',
            red: '#ff6b6b',
            green: '#4ade80',
            yellow: '#fbbf24',
            blue: '#60a5fa',
            magenta: '#a78bfa',
            cyan: '#22d3d3',
            white: '#e0e0e0',
            brightBlack: '#4a4a5e',
            brightRed: '#ff8a8a',
            brightGreen: '#6ee7a0',
            brightYellow: '#fcd34d',
            brightBlue: '#93c5fd',
            brightMagenta: '#c4b5fd',
            brightCyan: '#5eead4',
            brightWhite: '#ffffff',
        };
    }
    
    /**
     * Write welcome message
     */
    writeWelcome() {
        this.terminal.writeln('\x1b[1;35m╔══════════════════════════════════════╗\x1b[0m');
        this.terminal.writeln('\x1b[1;35m║\x1b[0m     \x1b[1;36mMudTerm v2.0\x1b[0m                     \x1b[1;35m║\x1b[0m');
        this.terminal.writeln('\x1b[1;35m║\x1b[0m  \x1b[33mmudstandards.org WebSocket Client\x1b[0m  \x1b[1;35m║\x1b[0m');
        this.terminal.writeln('\x1b[1;35m╚══════════════════════════════════════╝\x1b[0m');
        this.terminal.writeln('');
        this.terminal.writeln('\x1b[90mType /help for commands, or connect to a server.\x1b[0m');
        this.terminal.writeln('');
    }
    
    /**
     * Show input prompt
     */
    showPrompt() {
        this.terminal.write('\x1b[32m>\x1b[0m ');
    }
    
    /**
     * Handle keyboard input
     */
    handleKeyPress(key, domEvent) {
        const code = domEvent.keyCode;
        
        // Enter - send command
        if (code === 13) {
            this.terminal.writeln('');
            this.sendInput();
            return;
        }
        
        // Backspace
        if (code === 8) {
            if (this.cursorPosition > 0) {
                this.inputBuffer = 
                    this.inputBuffer.slice(0, this.cursorPosition - 1) + 
                    this.inputBuffer.slice(this.cursorPosition);
                this.cursorPosition--;
                this.terminal.write('\b \b');
                this.redrawInput();
            }
            return;
        }
        
        // Delete
        if (code === 46) {
            if (this.cursorPosition < this.inputBuffer.length) {
                this.inputBuffer = 
                    this.inputBuffer.slice(0, this.cursorPosition) + 
                    this.inputBuffer.slice(this.cursorPosition + 1);
                this.redrawInput();
            }
            return;
        }
        
        // Arrow up - history
        if (code === 38) {
            const cmd = connectionManager.navigateHistory(-1);
            if (cmd !== null) {
                this.clearInput();
                this.inputBuffer = cmd;
                this.cursorPosition = cmd.length;
                this.terminal.write(cmd);
            }
            return;
        }
        
        // Arrow down - history
        if (code === 40) {
            const cmd = connectionManager.navigateHistory(1);
            if (cmd !== null) {
                this.clearInput();
                this.inputBuffer = cmd;
                this.cursorPosition = cmd.length;
                this.terminal.write(cmd);
            }
            return;
        }
        
        // Arrow left
        if (code === 37) {
            if (this.cursorPosition > 0) {
                this.cursorPosition--;
                this.terminal.write('\x1b[D');
            }
            return;
        }
        
        // Arrow right
        if (code === 39) {
            if (this.cursorPosition < this.inputBuffer.length) {
                this.cursorPosition++;
                this.terminal.write('\x1b[C');
            }
            return;
        }
        
        // Home
        if (code === 36) {
            this.terminal.write(`\x1b[${this.cursorPosition}D`);
            this.cursorPosition = 0;
            return;
        }
        
        // End
        if (code === 35) {
            const move = this.inputBuffer.length - this.cursorPosition;
            if (move > 0) {
                this.terminal.write(`\x1b[${move}C`);
                this.cursorPosition = this.inputBuffer.length;
            }
            return;
        }
        
        // Ctrl+C - cancel
        if (code === 67 && domEvent.ctrlKey) {
            this.terminal.writeln('^C');
            this.inputBuffer = '';
            this.cursorPosition = 0;
            this.showPrompt();
            return;
        }
        
        // Ctrl+L - clear
        if (code === 76 && domEvent.ctrlKey) {
            this.clear();
            return;
        }
        
        // Regular character
        if (key.length === 1 && !domEvent.ctrlKey && !domEvent.altKey) {
            // Insert at cursor position
            this.inputBuffer = 
                this.inputBuffer.slice(0, this.cursorPosition) + 
                key + 
                this.inputBuffer.slice(this.cursorPosition);
            this.cursorPosition++;
            
            // Write character and redraw rest
            this.terminal.write(key);
            if (this.cursorPosition < this.inputBuffer.length) {
                this.redrawInput();
            }
        }
    }
    
    /**
     * Handle paste
     */
    handlePaste(text) {
        // Clean text (remove control chars except newlines)
        const cleaned = text.replace(/[\x00-\x09\x0B-\x1F]/g, '');
        
        // Insert at cursor
        this.inputBuffer = 
            this.inputBuffer.slice(0, this.cursorPosition) + 
            cleaned + 
            this.inputBuffer.slice(this.cursorPosition);
        this.cursorPosition += cleaned.length;
        
        this.terminal.write(cleaned);
        this.redrawInput();
    }
    
    /**
     * Clear current input line
     */
    clearInput() {
        // Move to start and clear line
        if (this.cursorPosition > 0) {
            this.terminal.write(`\x1b[${this.cursorPosition}D`);
        }
        this.terminal.write('\x1b[K');
        this.inputBuffer = '';
        this.cursorPosition = 0;
    }
    
    /**
     * Redraw input from cursor position
     */
    redrawInput() {
        const remaining = this.inputBuffer.slice(this.cursorPosition);
        // Write remaining, clear to end, move back
        this.terminal.write(remaining + '\x1b[K');
        if (remaining.length > 0) {
            this.terminal.write(`\x1b[${remaining.length}D`);
        }
    }
    
    /**
     * Send current input
     */
    sendInput() {
        const input = this.inputBuffer.trim();
        this.inputBuffer = '';
        this.cursorPosition = 0;
        
        if (!input) {
            this.showPrompt();
            return;
        }
        
        // Check for client commands
        if (input.startsWith('/')) {
            this.handleClientCommand(input);
            this.showPrompt();
            return;
        }
        
        // Emit input event (triggers/aliases may intercept)
        events.emit(Events.TERMINAL_INPUT, input);
        
        // Echo locally if not connected
        if (!connectionManager.isConnected()) {
            this.terminal.writeln('\x1b[90mNot connected\x1b[0m');
        }
        
        this.showPrompt();
    }
    
    /**
     * Handle client commands (starting with /)
     */
    handleClientCommand(input) {
        const [cmd, ...args] = input.slice(1).split(' ');
        
        switch (cmd.toLowerCase()) {
            case 'help':
                this.terminal.writeln('\x1b[1;33mClient Commands:\x1b[0m');
                this.terminal.writeln('  /help         - Show this help');
                this.terminal.writeln('  /clear        - Clear terminal');
                this.terminal.writeln('  /connect      - Open connection manager');
                this.terminal.writeln('  /disconnect   - Disconnect from server');
                this.terminal.writeln('  /reconnect    - Reconnect to last server');
                this.terminal.writeln('  /echo <text>  - Echo text locally');
                break;
                
            case 'clear':
                this.clear();
                break;
                
            case 'connect':
                events.emit(Events.MODAL_OPEN, { name: 'connections' });
                break;
                
            case 'disconnect':
                connectionManager.disconnect();
                break;
                
            case 'reconnect':
                const profile = state.getState().profile;
                if (profile) {
                    connectionManager.connect(profile);
                } else {
                    this.terminal.writeln('\x1b[31mNo previous connection\x1b[0m');
                }
                break;
                
            case 'echo':
                this.terminal.writeln(args.join(' '));
                break;
                
            default:
                this.terminal.writeln(`\x1b[31mUnknown command: ${cmd}\x1b[0m`);
        }
    }
    
    /**
     * Handle output from server/events
     */
    handleOutput(data) {
        if (typeof data === 'string') {
            // Clear current input line, write data, redraw input
            const hadInput = this.inputBuffer.length > 0;
            
            if (hadInput) {
                // Save cursor, clear line
                this.terminal.write('\r\x1b[K');
            }
            
            // Write the data
            this.terminal.write(data);
            
            // Ensure we're on a new line
            if (!data.endsWith('\n') && !data.endsWith('\r\n')) {
                this.terminal.writeln('');
            }
            
            // Redraw prompt and input
            this.showPrompt();
            if (hadInput) {
                this.terminal.write(this.inputBuffer);
            }
        }
    }
    
    /**
     * Write data to terminal
     */
    write(data) {
        this.terminal.write(data);
    }
    
    /**
     * Write line to terminal
     */
    writeln(data) {
        this.terminal.writeln(data);
    }
    
    /**
     * Clear terminal
     */
    clear() {
        this.terminal.clear();
        this.writeWelcome();
        this.showPrompt();
    }
    
    /**
     * Fit terminal to container
     */
    fit() {
        if (this.fitAddon && this.container) {
            try {
                this.fitAddon.fit();
            } catch (err) {
                // Ignore fit errors (can happen during init)
            }
        }
    }
    
    /**
     * Handle window resize
     */
    handleResize() {
        // Debounce
        clearTimeout(this.resizeTimeout);
        this.resizeTimeout = setTimeout(() => this.fit(), 100);
    }
    
    /**
     * Focus the terminal
     */
    focus() {
        this.terminal?.focus();
    }
    
    /**
     * Dispose terminal
     */
    dispose() {
        events.off(Events.TERMINAL_OUTPUT, this.handleOutput);
        window.removeEventListener('resize', this.handleResize);
        
        if (this.webglAddon) {
            this.webglAddon.dispose();
        }
        if (this.terminal) {
            this.terminal.dispose();
        }
    }
}

// Singleton
export const terminalRenderer = new TerminalRenderer();

export default terminalRenderer;
