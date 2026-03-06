/**
 * Terminal Protocol Handler
 * Implements terminal.mudstandards.org WebSocket subprotocol
 * 
 * Simple protocol: TEXT frames only, UTF-8 encoded ANSI
 * No out-of-band data support
 */

import { BaseProtocol, registerProtocol } from './base.js';
import { events, Events } from '../../core/events.js';

export class TerminalProtocol extends BaseProtocol {
    static get protocolName() {
        return 'terminal.mudstandards.org';
    }
    
    static get displayName() {
        return 'Terminal (ANSI only)';
    }
    
    /**
     * Handle TEXT frame - just game output
     */
    handleTextFrame(data) {
        events.emit(Events.TERMINAL_OUTPUT, data);
    }
    
    /**
     * Handle BINARY frame - not expected for this protocol
     */
    handleBinaryFrame(data) {
        console.warn('Unexpected binary frame in terminal protocol');
        // Try to decode as text anyway
        try {
            const text = new TextDecoder('utf-8').decode(data);
            events.emit(Events.TERMINAL_OUTPUT, text);
        } catch (err) {
            // Ignore
        }
    }
}

// Register the protocol
registerProtocol(TerminalProtocol);

export default TerminalProtocol;
