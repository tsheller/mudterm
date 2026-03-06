/**
 * MudTerm Event System
 * ====================
 * Central pub/sub event bus for decoupled module communication
 */

export const Events = {
  // Connection events
  CONNECTION_OPEN: 'connection:open',
  CONNECTION_CLOSE: 'connection:close',
  CONNECTION_ERROR: 'connection:error',
  CONNECTION_DATA: 'connection:data',
  
  // System events
  SYSTEM_MESSAGE: 'system:message',
  COMMAND_SENT: 'command:sent',
  
  // Terminal events
  TERMINAL_OUTPUT: 'terminal:output',
  TERMINAL_INPUT: 'terminal:input',
  TERMINAL_CLEAR: 'terminal:clear',
  TERMINAL_RESIZE: 'terminal:resize',
  
  // GMCP events
  GMCP_RECEIVED: 'gmcp:received',
  GMCP_SEND: 'gmcp:send',
  GMCP_HELLO: 'gmcp:hello',
  GMCP_SUPPORTS: 'gmcp:supports',
  
  // MSDP events (MUD Server Data Protocol)
  MSDP_DATA: 'msdp:data',
  
  // MSSP events (MUD Server Status Protocol)
  MSSP_DATA: 'mssp:data',
  
  // Telnet negotiation events
  TELNET_NAWS: 'telnet:naws',
  TELNET_TTYPE: 'telnet:ttype',
  TELNET_SUBNEG: 'telnet:subneg',
  
  // Character events
  CHAR_VITALS: 'char:vitals',
  CHAR_INFO: 'char:info',
  CHAR_STATUS: 'char:status',
  CHAR_STATS: 'char:stats',
  CHAR_WORTH: 'char:worth',
  CHAR_ITEMS: 'char:items',
  CHAR_SKILLS: 'char:skills',
  
  // Room events
  ROOM_INFO: 'room:info',
  ROOM_MAP: 'room:map',
  ROOM_PLAYERS: 'room:players',
  
  // Communication events
  COMM_CHANNEL: 'comm:channel',
  COMM_TELL: 'comm:tell',
  
  // Automation events
  TRIGGER_FIRED: 'trigger:fired',
  ALIAS_EXPANDED: 'alias:expanded',
  TIMER_FIRED: 'timer:fired',
  SCRIPT_OUTPUT: 'script:output',
  
  // UI events
  WIDGET_UPDATE: 'widget:update',
  WIDGET_ADD: 'widget:add',
  WIDGET_REMOVE: 'widget:remove',
  LAYOUT_CHANGE: 'layout:change',
  THEME_CHANGE: 'theme:change',
  CLIENT_GUI: 'client:gui',
  
  // Profile events
  PROFILE_LOAD: 'profile:load',
  PROFILE_SAVE: 'profile:save',
  PROFILE_SWITCH: 'profile:switch',
  
  // Session events
  SESSION_CREATE: 'session:create',
  SESSION_DESTROY: 'session:destroy',
  SESSION_SWITCH: 'session:switch',
  SESSION_UPDATE: 'session:update',
  
  // Logging events
  LOG_ENTRY: 'log:entry',
  LOG_START: 'log:start',
  LOG_STOP: 'log:stop'
};

class EventBus {
  constructor() {
    this.listeners = new Map();
    this.onceListeners = new Map();
    this.history = [];
    this.maxHistory = 100;
  }

  /**
   * Subscribe to an event
   * @param {string} event - Event name
   * @param {Function} callback - Handler function
   * @returns {Function} Unsubscribe function
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    
    return () => this.off(event, callback);
  }

  /**
   * Subscribe to an event once
   * @param {string} event - Event name
   * @param {Function} callback - Handler function
   */
  once(event, callback) {
    if (!this.onceListeners.has(event)) {
      this.onceListeners.set(event, new Set());
    }
    this.onceListeners.get(event).add(callback);
  }

  /**
   * Unsubscribe from an event
   * @param {string} event - Event name
   * @param {Function} callback - Handler function
   */
  off(event, callback) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(callback);
    }
    if (this.onceListeners.has(event)) {
      this.onceListeners.get(event).delete(callback);
    }
  }

  /**
   * Emit an event
   * @param {string} event - Event name
   * @param {*} data - Event data
   */
  emit(event, data) {
    // Store in history
    this.history.push({ event, data, timestamp: Date.now() });
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    // Call regular listeners
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(callback => {
        try {
          callback(data);
        } catch (err) {
          console.error(`Event handler error for ${event}:`, err);
        }
      });
    }

    // Call once listeners and remove them
    if (this.onceListeners.has(event)) {
      this.onceListeners.get(event).forEach(callback => {
        try {
          callback(data);
        } catch (err) {
          console.error(`Once handler error for ${event}:`, err);
        }
      });
      this.onceListeners.delete(event);
    }
  }

  /**
   * Get event history
   * @param {string} [event] - Optional filter by event name
   * @returns {Array} Event history
   */
  getHistory(event = null) {
    if (event) {
      return this.history.filter(h => h.event === event);
    }
    return [...this.history];
  }

  /**
   * Clear all listeners
   */
  clear() {
    this.listeners.clear();
    this.onceListeners.clear();
  }

  /**
   * Get listener count for debugging
   * @param {string} [event] - Optional specific event
   * @returns {number|Object} Count or counts by event
   */
  listenerCount(event = null) {
    if (event) {
      return (this.listeners.get(event)?.size || 0) + 
             (this.onceListeners.get(event)?.size || 0);
    }
    
    const counts = {};
    for (const [evt, set] of this.listeners) {
      counts[evt] = (counts[evt] || 0) + set.size;
    }
    for (const [evt, set] of this.onceListeners) {
      counts[evt] = (counts[evt] || 0) + set.size;
    }
    return counts;
  }
}

// Singleton instance
export const events = new EventBus();

export default events;
