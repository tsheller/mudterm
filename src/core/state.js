/**
 * State Manager - Central application state
 */

const stateStore = {
    connections: [
        {
            id: 'universal-server',
            name: 'Universal Server (8765)',
            url: 'wss://mudterm.com/ws/',
            protocol: 'auto',  // Auto-negotiate best protocol
            color: 'magenta',
            profiles: []
        },
        {
            id: 'terminal-server',
            name: 'Terminal Only (8766)',
            url: 'wss://mudterm.com/ws-terminal/',
            protocol: 'terminal',
            color: 'cyan',
            profiles: []
        },
        {
            id: 'json-server',
            name: 'JSON Only (8767)',
            url: 'wss://mudterm.com/ws-json/',
            protocol: 'json',
            color: 'green',
            profiles: []
        },
        {
            id: 'telnet-server',
            name: 'Telnet Only (8768)',
            url: 'wss://mudterm.com/ws-telnet/',
            protocol: 'telnet',
            color: 'orange',
            profiles: []
        }
    ],
    aliases: [],
    triggers: [],
    timers: [],
    widgets: [],
    settings: {
        localEcho: true,
        commandHistory: true
    },
    activeConnection: null,
    activeProfile: null,
    ui: {
        currentScreen: 'connections'
    }
};

export const state = {
    get(path, defaultValue = null) {
        const keys = path.split('.');
        let value = stateStore;
        for (const key of keys) {
            if (value && typeof value === 'object' && key in value) {
                value = value[key];
            } else {
                return defaultValue;
            }
        }
        return value ?? defaultValue;
    },

    set(path, value) {
        const keys = path.split('.');
        let obj = stateStore;
        for (let i = 0; i < keys.length - 1; i++) {
            const key = keys[i];
            if (!(key in obj)) {
                obj[key] = {};
            }
            obj = obj[key];
        }
        obj[keys[keys.length - 1]] = value;
    },

    getAll() {
        return { ...stateStore };
    }
};

export { stateStore };
export default state;
