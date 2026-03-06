/**
 * Base class for WebSocket protocol handlers
 * Implements mudstandards.org protocol specification
 */

import { events, Events } from '../../core/events.js';

export class BaseProtocol {
    /**
     * Protocol identifier as per mudstandards.org
     * @type {string}
     */
    static get protocolName() {
        throw new Error('Subclass must define protocolName');
    }
    
    /**
     * Human-readable name
     * @type {string}
     */
    static get displayName() {
        return this.protocolName;
    }
    
    constructor(connection) {
        this.connection = connection;
        this.enabled = true;
    }
    
    /**
     * Called when protocol is selected during handshake
     */
    onNegotiated() {
        console.log(`Protocol negotiated: ${this.constructor.protocolName}`);
    }
    
    /**
     * Handle incoming TEXT frame (opcode 0)
     * @param {string} data - Text data
     */
    handleTextFrame(data) {
        // Default: emit as terminal output
        events.emit(Events.TERMINAL_OUTPUT, data);
    }
    
    /**
     * Handle incoming BINARY frame (opcode 1)
     * @param {ArrayBuffer} data - Binary data
     */
    handleBinaryFrame(data) {
        // Override in subclass
        console.warn('Unhandled binary frame');
    }
    
    /**
     * Send text to server (user input)
     * @param {string} text - Text to send
     */
    sendText(text) {
        if (this.connection.ws?.readyState === WebSocket.OPEN) {
            this.connection.ws.send(text);
        }
    }
    
    /**
     * Send binary data to server
     * @param {ArrayBuffer|Uint8Array} data - Binary data
     */
    sendBinary(data) {
        if (this.connection.ws?.readyState === WebSocket.OPEN) {
            this.connection.ws.send(data);
        }
    }
    
    /**
     * Called when connection closes
     */
    onDisconnect() {
        // Override in subclass if needed
    }
}

/**
 * Protocol registry
 */
export const protocols = new Map();

/**
 * Register a protocol handler
 * @param {typeof BaseProtocol} ProtocolClass 
 */
export function registerProtocol(ProtocolClass) {
    protocols.set(ProtocolClass.protocolName, ProtocolClass);
}

/**
 * Get list of supported protocol names for WebSocket handshake
 * @returns {string[]}
 */
export function getSupportedProtocols() {
    return Array.from(protocols.keys());
}

/**
 * Create protocol handler instance
 * @param {string} protocolName 
 * @param {object} connection 
 * @returns {BaseProtocol|null}
 */
export function createProtocolHandler(protocolName, connection) {
    const ProtocolClass = protocols.get(protocolName);
    if (!ProtocolClass) {
        console.warn(`Unknown protocol: ${protocolName}`);
        return null;
    }
    return new ProtocolClass(connection);
}

export default {
    BaseProtocol,
    protocols,
    registerProtocol,
    getSupportedProtocols,
    createProtocolHandler,
};
