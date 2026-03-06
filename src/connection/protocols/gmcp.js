/**
 * GMCP Protocol Handler
 * Implements gmcp.mudstandards.org WebSocket subprotocol
 * 
 * TEXT frames (opcode 0): Regular ANSI game output
 * BINARY frames (opcode 1): UTF-8 encoded GMCP commands
 *   Format: "Package.Command {json_data}"
 */

import { BaseProtocol, registerProtocol } from './base.js';
import { events, Events } from '../../core/events.js';
import state, { game, connection } from '../../core/state.js';

// GMCP package handlers
const packageHandlers = new Map();

export class GMCPProtocol extends BaseProtocol {
    static get protocolName() {
        return 'gmcp.mudstandards.org';
    }
    
    static get displayName() {
        return 'GMCP (mudstandards.org)';
    }
    
    constructor(conn) {
        super(conn);
        this.supportedPackages = new Set();
        this.enabledPackages = new Set();
    }
    
    onNegotiated() {
        super.onNegotiated();
        // Send Core.Hello after connection
        setTimeout(() => this.sendHello(), 100);
    }
    
    /**
     * Handle TEXT frame - regular game output
     */
    handleTextFrame(data) {
        events.emit(Events.TERMINAL_OUTPUT, data);
    }
    
    /**
     * Handle BINARY frame - GMCP message
     */
    handleBinaryFrame(data) {
        try {
            // Convert ArrayBuffer to string
            const text = new TextDecoder('utf-8').decode(data);
            this.parseGMCP(text);
        } catch (err) {
            console.error('GMCP parse error:', err);
        }
    }
    
    /**
     * Parse GMCP message
     * Format: "Package.Command {json}" or "Package.Command"
     * @param {string} text 
     */
    parseGMCP(text) {
        // Find first space (separates command from data)
        const spaceIndex = text.indexOf(' ');
        
        let command, jsonData;
        if (spaceIndex === -1) {
            command = text.trim();
            jsonData = null;
        } else {
            command = text.substring(0, spaceIndex).trim();
            const jsonStr = text.substring(spaceIndex + 1).trim();
            try {
                jsonData = jsonStr ? JSON.parse(jsonStr) : null;
            } catch (err) {
                console.warn(`GMCP JSON parse error for ${command}:`, err);
                jsonData = jsonStr; // Pass raw string if not valid JSON
            }
        }
        
        console.log('GMCP received:', command, jsonData);
        
        // Emit generic event
        events.emit(Events.GMCP_RECEIVED, { command, data: jsonData });
        
        // Call specific handler
        this.handleGMCPCommand(command, jsonData);
    }
    
    /**
     * Handle specific GMCP command
     */
    handleGMCPCommand(command, data) {
        // Check for registered handler
        const handler = packageHandlers.get(command);
        if (handler) {
            handler(data, this);
            return;
        }
        
        // Built-in handlers by prefix
        const [namespace, ...rest] = command.split('.');
        const subCommand = rest.join('.');
        
        switch (namespace) {
            case 'Core':
                this.handleCore(subCommand, data);
                break;
            case 'Char':
                this.handleChar(subCommand, data);
                break;
            case 'Room':
                this.handleRoom(subCommand, data);
                break;
            case 'Comm':
                this.handleComm(subCommand, data);
                break;
            case 'Group':
                this.handleGroup(subCommand, data);
                break;
            case 'IRE':
                this.handleIRE(subCommand, data);
                break;
            case 'Client':
                this.handleClient(subCommand, data);
                break;
            default:
                // Unknown package - might be server-specific
                console.log(`Unhandled GMCP: ${command}`);
        }
    }
    
    // ==================== Core Package ====================
    
    handleCore(command, data) {
        switch (command) {
            case 'Hello':
                // Server greeting
                console.log('Server hello:', data);
                break;
                
            case 'Supports.Set':
            case 'Supports.Add':
                // Server tells us what packages it supports
                if (Array.isArray(data)) {
                    data.forEach(pkg => this.supportedPackages.add(pkg));
                }
                // Auto-enable common packages
                this.enableDefaultPackages();
                break;
                
            case 'Supports.Remove':
                if (Array.isArray(data)) {
                    data.forEach(pkg => this.supportedPackages.delete(pkg));
                }
                break;
                
            case 'Ping':
                // Respond to keepalive
                this.sendGMCP('Core.Ping');
                break;
                
            case 'Goodbye':
                console.log('Server goodbye:', data);
                break;
        }
    }
    
    // ==================== Char Package ====================
    
    handleChar(command, data) {
        switch (command) {
            case 'Vitals':
                game.setVitals(this.normalizeVitals(data));
                events.emit(Events.VITALS_UPDATE, data);
                break;
                
            case 'Status':
            case 'Info':
                game.setChar(data);
                break;
                
            case 'Stats':
            case 'MaxStats':
                // Merge with existing char data
                game.setChar(data);
                break;
                
            case 'Items.List':
            case 'Items.Add':
            case 'Items.Remove':
            case 'Items.Update':
                this.handleInventory(command, data);
                break;
        }
    }
    
    normalizeVitals(data) {
        // Normalize various MUD vitals formats to our standard
        return {
            hp: data.hp ?? data.health ?? data.HP,
            maxHp: data.maxhp ?? data.max_hp ?? data.maxHP ?? data.MaxHP,
            mana: data.mana ?? data.mp ?? data.MP ?? data.Mana,
            maxMana: data.maxmana ?? data.max_mana ?? data.maxMP ?? data.MaxMana,
            moves: data.moves ?? data.mv ?? data.MV ?? data.movement,
            maxMoves: data.maxmoves ?? data.max_moves ?? data.maxMV ?? data.MaxMoves,
            energy: data.energy ?? data.endurance ?? data.end,
            maxEnergy: data.maxenergy ?? data.max_energy ?? data.maxEnd,
            willpower: data.willpower ?? data.wp ?? data.will,
            maxWillpower: data.maxwillpower ?? data.max_willpower ?? data.maxWP,
        };
    }
    
    handleInventory(command, data) {
        const currentState = state.getState();
        const inventory = [...(currentState.game.inventory || [])];
        
        switch (command) {
            case 'Items.List':
                state.setState('game.inventory', data.items || data);
                break;
            case 'Items.Add':
                inventory.push(data);
                state.setState('game.inventory', inventory);
                break;
            case 'Items.Remove':
                const idx = inventory.findIndex(i => i.id === data.id);
                if (idx !== -1) inventory.splice(idx, 1);
                state.setState('game.inventory', inventory);
                break;
        }
    }
    
    // ==================== Room Package ====================
    
    handleRoom(command, data) {
        switch (command) {
            case 'Info':
                game.setRoom({
                    name: data.name,
                    area: data.area || data.zone,
                    terrain: data.terrain || data.environment,
                    exits: Object.keys(data.exits || {}),
                    coords: data.coords,
                    details: data,
                });
                events.emit(Events.ROOM_UPDATE, data);
                break;
                
            case 'Map':
                game.setMap(data);
                events.emit(Events.MAP_UPDATE, data);
                break;
                
            case 'WrongDir':
                // Player tried invalid exit
                break;
        }
    }
    
    // ==================== Comm Package ====================
    
    handleComm(command, data) {
        switch (command) {
            case 'Channel.Text':
            case 'Channel.List':
                // Add to channels array
                const channels = state.getState().game.channels.slice(-99); // Keep last 100
                channels.push({
                    channel: data.channel,
                    talker: data.talker,
                    text: data.text,
                    timestamp: Date.now(),
                });
                state.setState('game.channels', channels);
                break;
        }
    }
    
    // ==================== Group Package ====================
    
    handleGroup(command, data) {
        if (data && data.members) {
            state.setState('game.group', data.members);
        } else if (Array.isArray(data)) {
            state.setState('game.group', data);
        }
    }
    
    // ==================== IRE Package ====================
    
    handleIRE(command, data) {
        switch (command) {
            case 'Time.Update':
                state.setState('game.time', data);
                break;
            case 'Target.Set':
                state.setState('game.combat.target', data);
                break;
        }
    }
    
    // ==================== Client Package ====================
    
    handleClient(command, data) {
        switch (command) {
            case 'GUI':
                // Server wants to configure our UI
                events.emit(Events.PACKAGE_RECEIVED, {
                    type: 'layout',
                    data: data
                });
                break;
                
            case 'Map':
                events.emit(Events.MAP_UPDATE, data);
                break;
                
            case 'Media.Play':
            case 'Media.Stop':
                // Media control
                break;
        }
    }
    
    // ==================== Sending GMCP ====================
    
    /**
     * Send GMCP command to server
     * @param {string} command - GMCP command (e.g., "Core.Hello")
     * @param {object|null} data - Optional JSON data
     */
    sendGMCP(command, data = null) {
        let message = command;
        if (data !== null) {
            message += ' ' + JSON.stringify(data);
        }
        
        // Convert to binary for BINARY frame
        const encoder = new TextEncoder();
        const binary = encoder.encode(message);
        
        this.sendBinary(binary);
        
        events.emit(Events.GMCP_SEND, { command, data });
    }
    
    /**
     * Send Core.Hello handshake
     */
    sendHello() {
        this.sendGMCP('Core.Hello', {
            client: 'MudTerm',
            version: '2.0.0'
        });
    }
    
    /**
     * Enable default GMCP packages
     */
    enableDefaultPackages() {
        const defaultPackages = [
            'Char 1',
            'Char.Vitals 1',
            'Char.Status 1',
            'Char.Items 1',
            'Room 1',
            'Room.Info 1',
            'Comm 1',
            'Comm.Channel 1',
            'Group 1',
        ];
        
        // Filter to only packages server supports
        const toEnable = defaultPackages.filter(pkg => {
            const baseName = pkg.split(' ')[0];
            return this.supportedPackages.has(baseName) || 
                   this.supportedPackages.has(pkg);
        });
        
        if (toEnable.length > 0) {
            this.sendGMCP('Core.Supports.Set', toEnable);
            toEnable.forEach(pkg => this.enabledPackages.add(pkg.split(' ')[0]));
        }
    }
    
    /**
     * Enable a specific package
     * @param {string} packageName 
     * @param {number} version 
     */
    enablePackage(packageName, version = 1) {
        this.sendGMCP('Core.Supports.Add', [`${packageName} ${version}`]);
        this.enabledPackages.add(packageName);
    }
    
    /**
     * Disable a package
     * @param {string} packageName 
     */
    disablePackage(packageName) {
        this.sendGMCP('Core.Supports.Remove', [packageName]);
        this.enabledPackages.delete(packageName);
    }
}

/**
 * Register a custom GMCP handler
 * @param {string} command - Full command (e.g., "Char.Vitals")
 * @param {Function} handler - Handler function(data, protocol)
 */
export function onGMCP(command, handler) {
    packageHandlers.set(command, handler);
}

// Register the protocol
registerProtocol(GMCPProtocol);

export default GMCPProtocol;
