/**
 * MudTerm Cloud — API Configuration
 * ==================================
 * Points to the existing API at api.illogical.com
 * Same server that runs MPMPT, CardVault, etc.
 * 
 * Server details (from prior setup):
 *   - Fastify + PostgreSQL
 *   - JWT auth (30-day expiry, Bearer tokens in Authorization header)
 *   - Google OAuth + GitHub OAuth + Discord OAuth (redirect flow)
 *   - Nginx reverse proxy on illogical-ai.com
 *   - PM2 managed process
 *   - Server IP: 23.95.67.109
 * 
 * Auth flow:
 *   1. Frontend redirects to API_URL/auth/google (or /auth/github, /auth/discord)
 *      with return_url pointing back to mudterm.com
 *   2. Server handles OAuth dance, creates/updates user in PostgreSQL
 *      If email matches an existing account, links the provider automatically
 *   3. Server redirects back to FRONTEND_URL with ?auth_token=JWT&auth_success=true
 *   4. Frontend stores JWT in localStorage, sends as Bearer token
 *
 * MudTerm-specific endpoints (on server in routes/mudterm.js):
 *   GET    /api/mudterm/device-sets
 *   POST   /api/mudterm/device-sets
 *   PUT    /api/mudterm/device-sets/:id
 *   DELETE /api/mudterm/device-sets/:id
 *   POST   /api/mudterm/sets/:setId/connections/sync
 *   POST   /api/mudterm/sets/:setId/automations/sync
 *   POST   /api/mudterm/sets/:setId/clone
 *   POST   /api/mudterm/export
 *   POST   /api/mudterm/import
 */

export const API_CONFIG = {
    // Base URL — the existing API
    API_URL: 'https://api.illogical-ai.com',

    // Where the MudTerm PWA is hosted
    FRONTEND_URL: 'https://mudterm.com',

    // Auth endpoints (on the server)
    AUTH: {
        GOOGLE: '/auth/google',
        GITHUB: '/auth/github',
        DISCORD: '/auth/discord',
        ME: '/me'
    },

    // MudTerm-specific endpoints
    MUDTERM: {
        DEVICE_SETS: '/api/mudterm/device-sets',
        CONNECTIONS_SYNC: (setId) => `/api/mudterm/sets/${setId}/connections/sync`,
        AUTOMATIONS_SYNC: (setId) => `/api/mudterm/sets/${setId}/automations/sync`,
        CLONE_SET: (setId) => `/api/mudterm/sets/${setId}/clone`,
        EXPORT: '/api/mudterm/export',
        IMPORT: '/api/mudterm/import',
        GDRIVE_BACKUP: '/api/mudterm/gdrive/backup',
        GDRIVE_RESTORE: '/api/mudterm/gdrive/restore',
        GDRIVE_LIST: '/api/mudterm/gdrive/list'
    },

    // localStorage keys
    STORAGE_KEYS: {
        AUTH_TOKEN: 'mudterm_auth_token',
        AUTH_USER: 'mudterm_auth_user',
        ACTIVE_DEVICE_SET: 'mudterm_active_device_set',
        // The "shared" set is the canonical home for automations (aliases/triggers/scripts).
        // It is always the default/first set created, and all devices sync automations
        // to/from it regardless of which device set is currently active.
        // Layout data (widgets) syncs to the active device set instead.
        SHARED_SET: 'mudterm_shared_set_id',
        LAST_SYNC: 'mudterm_last_sync'
    }
};

export default API_CONFIG;
