/**
 * MUDTERM.IO - Main Application Entry Point
 */

import 'xterm/css/xterm.css';
import './styles/main.css';
import './styles/widgets.css';

import { events, Events } from './core/events.js';
import { state } from './core/state.js';
import { storage } from './core/storage.js';
import { sessionManager } from './core/session-manager.js';
import { tabBar } from './ui/tab-bar.js';
import { statusBar } from './ui/status-bar.js';
import { automationStore } from './core/automation-store.js';
import { logPanel } from './ui/log-panel.js';
import { automationPanel } from './ui/automation-panel.js';
window.automationPanel = automationPanel;
import { logger } from './core/logger.js';
import { cloudSync } from './core/cloud-sync.js';

let activeMode = null;

// ═══════════════════════════════════════════════════════════════════════════════
// SCREENS
// ═══════════════════════════════════════════════════════════════════════════════

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const screen = document.getElementById(`screen-${screenId}`);
    if (screen) screen.classList.add('active');
    state.set('ui.currentScreen', screenId);
}

function showConnections() {
    const active = sessionManager.getActive();
    if (active) active.hide();
    showScreen('connections');
}

function showTerminal() {
    showScreen('terminal');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONNECTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function renderConnections() {
    const grid = document.getElementById('connection-grid');
    if (!grid) return;

    const allLocal = state.get('connections', []);
    const loggedIn = cloudSync.isLoggedIn();
    grid.innerHTML = '';

    if (loggedIn) {
        const cloudConns = cloudSync.getCloudConnections();
        const localOnly = allLocal.filter(c => !cloudSync.isCloudConnection(c.id));

        if (cloudConns.length > 0) {
            const hdr = document.createElement('div');
            hdr.className = 'connection-section-header';
            hdr.innerHTML = `<span class="section-label">☁ Cloud</span><span class="section-count">${cloudConns.length}</span><div class="section-line"></div>`;
            grid.appendChild(hdr);
            cloudConns.forEach(conn => grid.appendChild(buildConnectionCard(conn, { cloud: true })));
        }

        const localHdr = document.createElement('div');
        localHdr.className = 'connection-section-header';
        localHdr.innerHTML = `<span class="section-label">📱 Device</span><span class="section-count">${localOnly.length}</span><div class="section-line"></div>`;
        grid.appendChild(localHdr);
        localOnly.forEach(conn => grid.appendChild(buildConnectionCard(conn, { cloud: false, showSync: true })));
    } else {
        allLocal.forEach(conn => grid.appendChild(buildConnectionCard(conn, { cloud: false })));
    }
}

function buildConnectionCard(conn, opts = {}) {
    const card = document.createElement('div');
    card.className = `connection-card color-${conn.color || 'cyan'}`;

    let displayUrl = conn.url;
    if (conn.type === 'bridge') displayUrl = `${conn.mudHost}:${conn.mudPort} (via bridge)`;

    const badge = opts.cloud ? '<span class="cloud-badge">☁</span>' : '';
    const syncBtn = opts.showSync
        ? `<button class="sync-to-cloud-btn" data-action="sync-to-cloud" data-id="${conn.id}">☁ Sync to Cloud</button>`
        : '';

    card.innerHTML = `
        <div class="connection-card-header">
            <span class="connection-card-name">${escapeHtml(conn.name)}${badge}</span>
            <button class="connection-card-edit" data-action="edit-connection" data-id="${conn.id}">⚙</button>
        </div>
        <div class="connection-card-url">${escapeHtml(displayUrl)}</div>
        <div class="connection-card-profiles">
            ${(conn.profiles || []).map(p => `
                <div class="profile-chip" data-action="connect" data-conn="${conn.id}" data-profile="${p.id}">
                    <span>${escapeHtml(p.name)}</span>
                    <button class="profile-chip-edit" data-action="edit-profile" data-conn="${conn.id}" data-profile="${p.id}">✎</button>
                </div>
            `).join('')}
            <button class="add-profile-chip" data-action="add-profile" data-conn="${conn.id}">+ Add Profile</button>
        </div>
        ${syncBtn}
    `;

    card.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('.profile-chip')) return;
        connect(conn.id, null, opts.cloud ? conn : null);
    });

    return card;
}

function connect(connectionId, profileId = null, cloudConn = null) {
    let conn = cloudConn;
    if (!conn) {
        const connections = state.get('connections', []);
        conn = connections.find(c => c.id === connectionId);
    }
    if (!conn) return;
    const profile = profileId ? (conn.profiles || []).find(p => p.id === profileId) : null;
    showTerminal();
    sessionManager.createSession(conn, profile);
}

function updateConnectionStatus(connected, name = '') {
    const status = document.getElementById('connection-status');
    if (!status) return;
    if (connected) {
        status.classList.add('connected');
        status.querySelector('.status-text').textContent = name || 'Connected';
    } else {
        status.classList.remove('connected');
        status.querySelector('.status-text').textContent = 'Disconnected';
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODALS
// ═══════════════════════════════════════════════════════════════════════════════

function openModal(modalId) {
    const modal = document.getElementById(`modal-${modalId}`);
    if (modal) modal.classList.add('active');
}

function closeModal(modalId) {
    const modal = document.getElementById(`modal-${modalId}`);
    if (modal) modal.classList.remove('active');
}

function closeAllModals() {
    document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('active'));
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════════════════════════════════════════

function setup() {
    try { _setup(); } catch(e) { console.error('[setup] THREW:', e); }
}
function _setup() {
    function setupConnectionTypeToggle(typeSelector, directFields, bridgeFields) {
        const typeEl = document.getElementById(typeSelector);
        const directEl = document.getElementById(directFields);
        const bridgeEl = document.getElementById(bridgeFields);
        if (typeEl && directEl && bridgeEl) {
            typeEl.addEventListener('change', () => {
                if (typeEl.value === 'bridge') {
                    directEl.style.display = 'none';
                    bridgeEl.style.display = 'block';
                } else {
                    directEl.style.display = 'block';
                    bridgeEl.style.display = 'none';
                }
            });
        }
    }

    setupConnectionTypeToggle('conn-type', 'conn-direct-fields', 'conn-bridge-fields');
    setupConnectionTypeToggle('edit-conn-type', 'edit-conn-direct-fields', 'edit-conn-bridge-fields');

    document.getElementById('btn-add-connection')?.addEventListener('click', () => {
        document.getElementById('conn-name').value = '';
        document.getElementById('conn-type').value = 'direct';
        document.getElementById('conn-url').value = '';
        document.getElementById('conn-bridge-url').value = '';
        document.getElementById('conn-mud-host').value = '';
        document.getElementById('conn-mud-port').value = '';
        document.getElementById('conn-protocol').value = 'auto';
        document.getElementById('conn-color').value = 'cyan';
        const reconnectEl = document.getElementById('conn-auto-reconnect');
        if (reconnectEl) reconnectEl.checked = true;
        document.getElementById('conn-direct-fields').style.display = 'block';
        document.getElementById('conn-bridge-fields').style.display = 'none';
        openModal('add-connection');
    });

    document.getElementById('cancel-add-connection')?.addEventListener('click', () => closeModal('add-connection'));

    document.getElementById('save-add-connection')?.addEventListener('click', () => {
        const name = document.getElementById('conn-name').value.trim();
        const type = document.getElementById('conn-type').value;
        const protocol = document.getElementById('conn-protocol').value;
        const color = document.getElementById('conn-color').value;
        const autoReconnect = document.getElementById('conn-auto-reconnect')?.checked ?? true;
        let connData = { id: generateId(), name, type, protocol, color, autoReconnect, profiles: [] };
        if (type === 'bridge') {
            const bridgeUrl = document.getElementById('conn-bridge-url').value.trim();
            const mudHost = document.getElementById('conn-mud-host').value.trim();
            const mudPort = document.getElementById('conn-mud-port').value.trim();
            if (!name || !bridgeUrl || !mudHost || !mudPort) return;
            connData.bridgeUrl = bridgeUrl;
            connData.mudHost = mudHost;
            connData.mudPort = parseInt(mudPort, 10);
            connData.url = `${bridgeUrl}?host=${encodeURIComponent(mudHost)}&port=${mudPort}`;
        } else {
            const url = document.getElementById('conn-url').value.trim();
            if (!name || !url) return;
            connData.url = url;
        }
        const connections = state.get('connections', []);
        connections.push(connData);
        state.set('connections', connections);
        storage.save();
        renderConnections();
        closeModal('add-connection');
    });

    const connGrid = document.getElementById('connection-grid');
    if (connGrid) {
        connGrid.addEventListener('click', (e) => {
            const syncBtn = e.target.closest('[data-action="sync-to-cloud"]');
            if (syncBtn) {
                e.stopPropagation();
                const id = syncBtn.dataset.id;
                syncBtn.disabled = true;
                syncBtn.textContent = 'Syncing…';
                cloudSync.moveToCloud(id).then(() => renderConnections()).catch(err => {
                    syncBtn.disabled = false;
                    syncBtn.textContent = '☁ Sync to Cloud';
                    console.error('[Sync] Failed:', err.message);
                });
                return;
            }

            const editBtn = e.target.closest('[data-action="edit-connection"]');
            if (editBtn) {
                e.stopPropagation();
                const id = editBtn.dataset.id;
                const connections = state.get('connections', []);
                let conn = connections.find(c => c.id === id);
                if (!conn) conn = cloudSync.getCloudConnections().find(c => c.id === id);
                if (!conn) return;
                document.getElementById('edit-conn-id').value = id;
                document.getElementById('edit-conn-name').value = conn.name;
                document.getElementById('edit-conn-type').value = conn.type || 'direct';
                document.getElementById('edit-conn-url').value = conn.url || '';
                document.getElementById('edit-conn-bridge-url').value = conn.bridgeUrl || '';
                document.getElementById('edit-conn-mud-host').value = conn.mudHost || '';
                document.getElementById('edit-conn-mud-port').value = conn.mudPort || '';
                document.getElementById('edit-conn-protocol').value = conn.protocol || 'auto';
                document.getElementById('edit-conn-color').value = conn.color || 'cyan';
                const editReconnectEl = document.getElementById('edit-conn-auto-reconnect');
                if (editReconnectEl) editReconnectEl.checked = conn.autoReconnect !== false;
                const directFields = document.getElementById('edit-conn-direct-fields');
                const bridgeFields = document.getElementById('edit-conn-bridge-fields');
                if (conn.type === 'bridge') {
                    directFields.style.display = 'none';
                    bridgeFields.style.display = 'block';
                } else {
                    directFields.style.display = 'block';
                    bridgeFields.style.display = 'none';
                }
                openModal('edit-connection');
            }

            const addProfileBtn = e.target.closest('[data-action="add-profile"]');
            if (addProfileBtn) {
                e.stopPropagation();
                const connId = addProfileBtn.dataset.conn;
                document.getElementById('add-profile-connection-id').value = connId;
                document.getElementById('add-profile-name').value = '';
                document.getElementById('add-profile-autologin').value = '';
                const inheritSelect = document.getElementById('add-profile-inherit');
                if (inheritSelect) {
                    inheritSelect.innerHTML = `
                        <option value="">None (start empty)</option>
                        <option value="__connection__">This connection's automation</option>
                    `;
                    const connections = state.get('connections', []);
                    for (const c of connections) {
                        if (c.profiles && c.profiles.length > 0) {
                            const group = document.createElement('optgroup');
                            group.label = c.name;
                            for (const p of c.profiles) {
                                const opt = document.createElement('option');
                                opt.value = `${c.id}::${p.id}`;
                                opt.textContent = p.name;
                                group.appendChild(opt);
                            }
                            inheritSelect.appendChild(group);
                        }
                    }
                }
                openModal('add-profile');
            }

            const editProfileBtn = e.target.closest('[data-action="edit-profile"]');
            if (editProfileBtn) {
                e.stopPropagation();
                const connId = editProfileBtn.dataset.conn;
                const profId = editProfileBtn.dataset.profile;
                const connections = state.get('connections', []);
                const conn = connections.find(c => c.id === connId);
                const profile = conn?.profiles?.find(p => p.id === profId);
                if (!profile) return;
                document.getElementById('edit-profile-connection-id').value = connId;
                document.getElementById('edit-profile-id').value = profId;
                document.getElementById('edit-profile-name').value = profile.name;
                document.getElementById('edit-profile-autologin').value = profile.autoLogin || '';
                openModal('edit-profile');
            }

            const connectBtn = e.target.closest('[data-action="connect"]');
            if (connectBtn && !e.target.closest('.profile-chip-edit')) {
                e.stopPropagation();
                const connId = connectBtn.dataset.conn;
                const cloudConn = cloudSync.isCloudConnection(connId)
                    ? cloudSync.getCloudConnections().find(c => c.id === connId)
                    : null;
                connect(connId, connectBtn.dataset.profile, cloudConn);
            }
        });
    }

    document.getElementById('cancel-edit-connection')?.addEventListener('click', () => closeModal('edit-connection'));

    document.getElementById('save-edit-connection')?.addEventListener('click', () => {
        const id = document.getElementById('edit-conn-id').value;
        const name = document.getElementById('edit-conn-name').value.trim();
        const type = document.getElementById('edit-conn-type').value;
        const protocol = document.getElementById('edit-conn-protocol').value;
        const color = document.getElementById('edit-conn-color').value;
        const autoReconnect = document.getElementById('edit-conn-auto-reconnect')?.checked ?? true;
        if (!name) return;
        const connections = state.get('connections', []);
        const conn = connections.find(c => c.id === id);
        if (conn) {
            conn.name = name; conn.type = type; conn.protocol = protocol; conn.color = color; conn.autoReconnect = autoReconnect;
            if (type === 'bridge') {
                const bridgeUrl = document.getElementById('edit-conn-bridge-url').value.trim();
                const mudHost = document.getElementById('edit-conn-mud-host').value.trim();
                const mudPort = document.getElementById('edit-conn-mud-port').value.trim();
                if (!bridgeUrl || !mudHost || !mudPort) return;
                conn.bridgeUrl = bridgeUrl; conn.mudHost = mudHost;
                conn.mudPort = parseInt(mudPort, 10);
                conn.url = `${bridgeUrl}?host=${encodeURIComponent(mudHost)}&port=${mudPort}`;
            } else {
                const url = document.getElementById('edit-conn-url').value.trim();
                if (!url) return;
                conn.url = url;
                delete conn.bridgeUrl; delete conn.mudHost; delete conn.mudPort;
            }
            state.set('connections', connections);
            storage.save();
            renderConnections();
        }
        closeModal('edit-connection');
    });

    document.getElementById('delete-connection')?.addEventListener('click', () => {
        const id = document.getElementById('edit-conn-id').value;
        let connections = state.get('connections', []);
        connections = connections.filter(c => c.id !== id);
        state.set('connections', connections);
        storage.save();
        renderConnections();
        closeModal('edit-connection');
    });

    document.getElementById('cancel-add-profile')?.addEventListener('click', () => closeModal('add-profile'));

    document.getElementById('save-add-profile')?.addEventListener('click', () => {
        const connId = document.getElementById('add-profile-connection-id').value;
        const name = document.getElementById('add-profile-name').value.trim();
        const autoLogin = document.getElementById('add-profile-autologin').value;
        const inheritVal = document.getElementById('add-profile-inherit')?.value || '';
        if (!name) return;
        const newProfileId = generateId();
        const connections = state.get('connections', []);
        const conn = connections.find(c => c.id === connId);
        if (conn) {
            if (!conn.profiles) conn.profiles = [];
            conn.profiles.push({ id: newProfileId, name, autoLogin });
            state.set('connections', connections);
            storage.save();
            if (inheritVal === '__connection__') {
                automationStore.copyFrom({ connectionId: connId }, { connectionId: connId, profileId: newProfileId });
            } else if (inheritVal && inheritVal.includes('::')) {
                const [srcConnId, srcProfId] = inheritVal.split('::');
                automationStore.copyFrom({ connectionId: srcConnId, profileId: srcProfId }, { connectionId: connId, profileId: newProfileId });
            }
            renderConnections();
        }
        closeModal('add-profile');
    });

    document.getElementById('cancel-edit-profile')?.addEventListener('click', () => closeModal('edit-profile'));

    document.getElementById('save-edit-profile')?.addEventListener('click', () => {
        const connId = document.getElementById('edit-profile-connection-id').value;
        const profId = document.getElementById('edit-profile-id').value;
        const name = document.getElementById('edit-profile-name').value.trim();
        const autoLogin = document.getElementById('edit-profile-autologin').value;
        if (!name) return;
        const connections = state.get('connections', []);
        const conn = connections.find(c => c.id === connId);
        const profile = conn?.profiles?.find(p => p.id === profId);
        if (profile) {
            profile.name = name; profile.autoLogin = autoLogin;
            state.set('connections', connections);
            storage.save();
            renderConnections();
        }
        closeModal('edit-profile');
    });

    document.getElementById('delete-profile')?.addEventListener('click', () => {
        const connId = document.getElementById('edit-profile-connection-id').value;
        const profId = document.getElementById('edit-profile-id').value;
        const connections = state.get('connections', []);
        const conn = connections.find(c => c.id === connId);
        if (conn && conn.profiles) {
            conn.profiles = conn.profiles.filter(p => p.id !== profId);
            state.set('connections', connections);
            storage.save();
            renderConnections();
        }
        closeModal('edit-profile');
    });

    const headerActions = document.getElementById('header-actions');
    if (headerActions) {
        headerActions.innerHTML = `
            <button class="header-btn" id="btn-disconnect" title="Disconnect">🔌</button>
            <button class="header-btn" id="btn-auto" title="Automation">⚡</button>
            <button class="header-btn" id="btn-edit" title="Layout">✎</button>
            <button class="header-btn" id="btn-logs" title="Logs">🪵</button>
            <button class="header-btn" id="btn-settings" title="Settings">☰</button>
        `;
    }

    // ══════════════════════════════════════════════════════════════
    // PANEL CONTROLLER
    // ══════════════════════════════════════════════════════════════

    const panel = document.getElementById('side-panel');

    function activatePanel(mode) {
        console.log('[Panel] activatePanel', mode, 'activeMode=', activeMode);
        if (activeMode === mode) { deactivatePanel(); return; }

        if (activeMode === 'layout') {
            const session = sessionManager.getActive();
            if (session?.widgetGrid?.editMode) { session.widgetGrid.exitEditMode(); saveWidgetLayout(session); }
        }

        document.querySelectorAll('.header-btn').forEach(b => b.classList.remove('active'));
        activeMode = mode;

        document.querySelectorAll('.side-panel-tab').forEach(t => {
            if (t.dataset.panel === mode) { t.classList.remove('hidden'); t.classList.add('tab-active'); }
            else { t.classList.add('hidden'); t.classList.remove('tab-active'); }
        });

        document.querySelectorAll('.panel-mode').forEach(s => s.classList.remove('active'));
        const section = document.getElementById(`panel-${mode}`);
        if (section) section.classList.add('active');

        const titleEl = panel?.querySelector('.panel-title');
        if (titleEl) {
            const titles = { auto: 'Automation', layout: 'Layout Editor', logs: 'Session Logs' };
            titleEl.textContent = titles[mode] || '';
        }

        const btnMap = { auto: 'btn-auto', layout: 'btn-edit', logs: 'btn-logs' };
        document.getElementById(btnMap[mode])?.classList.add('active');

        panel?.classList.add('open');

        if (mode === 'layout') {
            const session = sessionManager.getActive();
            if (session?.widgetGrid) { session.widgetGrid.enterEditMode(); renderLayoutControls(session); }
        } else if (mode === 'logs') {
            logPanel.render();
        } else if (mode === 'auto') {
            const activeConnId = state.get('activeConnection');
            const session = (activeConnId
                ? sessionManager.getAllSessions().find(s => s.connectionConfig?.id === activeConnId)
                : null) || sessionManager.getActive() || sessionManager.getAllSessions()[0] || null;
            if (session?.automation) session.automation.reload();
            automationPanel.render(session);
        }
    }

    function deactivatePanel() {
        if (activeMode === 'layout') {
            const session = sessionManager.getActive();
            if (session?.widgetGrid?.editMode) { session.widgetGrid.exitEditMode(); saveWidgetLayout(session); }
        }
        activeMode = null;
        document.querySelectorAll('.side-panel-tab').forEach(t => { t.classList.add('hidden'); t.classList.remove('tab-active'); });
        document.querySelectorAll('.header-btn').forEach(b => b.classList.remove('active'));
        panel?.classList.remove('open');
    }

    // Use event delegation so clicks work even if buttons are recreated
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('#btn-auto, #btn-edit, #btn-logs, #btn-disconnect, #close-panel');
        if (!btn) return;
        if (btn.id === 'btn-auto')        { activatePanel('auto'); }
        else if (btn.id === 'btn-edit')   { activatePanel('layout'); }
        else if (btn.id === 'btn-logs')   { activatePanel('logs'); }
        else if (btn.id === 'btn-disconnect') {
            const activeSession = sessionManager.getActive();
            if (activeSession) sessionManager.closeSession(activeSession.id);
            updateConnectionStatus(false);
            deactivatePanel();
        }
        else if (btn.id === 'close-panel') { panel?.classList.remove('open'); }
    });

    window.activatePanel = activatePanel;

    document.querySelectorAll('.side-panel-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            if (panel?.classList.contains('open')) {
                panel.classList.remove('open');
            } else {
                panel?.classList.add('open');
                if (activeMode === 'logs') logPanel.render();
                if (activeMode === 'auto') {
                    const activeConnId = state.get('activeConnection');
                    const session = (activeConnId
                        ? sessionManager.getAllSessions().find(s => s.connectionConfig?.id === activeConnId)
                        : null) || sessionManager.getActive() || sessionManager.getAllSessions()[0] || null;
                    if (session?.automation) session.automation.reload();
                    automationPanel.render(session);
                }
            }
        });
    });

    document.querySelectorAll('.auto-subtab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.auto-subtab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            document.querySelectorAll('.auto-section').forEach(s => s.classList.remove('active'));
            const section = document.getElementById(`section-${tab.dataset.tab}`);
            if (section) section.classList.add('active');
        });
    });

    document.getElementById('btn-settings')?.addEventListener('click', () => openModal('settings'));

    // ══════════════════════════════════════════════════════════════
    // LAYOUT CONTROLS
    // ══════════════════════════════════════════════════════════════

    function renderLayoutControls(session) {
        const content = document.getElementById('layout-content');
        if (!content || !session?.widgetGrid) return;
        const grid = session.widgetGrid;
        content.innerHTML = `
            <div class="layout-controls">
                <div class="layout-section">
                    <div class="layout-section-title">Layout Presets</div>
                    <div class="layout-presets-grid">
                        <button class="preset-btn" data-preset="combat">⚔ Combat</button>
                        <button class="preset-btn" data-preset="social">💬 Social</button>
                        <button class="preset-btn" data-preset="exploration">🗺 Explore</button>
                        <button class="preset-btn" data-preset="minimal">▬ Minimal</button>
                    </div>
                </div>
                <div class="layout-section">
                    <div class="layout-section-title">Grid Size</div>
                    <div class="grid-size-row">
                        <label>Cols: <input type="number" id="grid-cols" value="${grid.gridCols}" min="4" max="24" class="grid-size-input"></label>
                        <label>Rows: <input type="number" id="grid-rows" value="${grid.gridRows}" min="4" max="16" class="grid-size-input"></label>
                        <button class="layout-btn" id="apply-grid-size">Apply</button>
                    </div>
                </div>
                <div class="layout-section">
                    <div class="layout-section-title">Input Area Height</div>
                    <input type="range" id="input-area-height" min="24" max="200" value="${session._inputWrap?.offsetHeight || 28}" class="layout-slider">
                    <span id="input-area-height-label">${session._inputWrap?.offsetHeight || 28}px</span>
                </div>
                <div class="layout-section">
                    <div class="layout-section-title">Actions</div>
                    <button class="layout-btn layout-btn-full" id="clear-all-widgets">Clear All Widgets</button>
                    <button class="layout-btn layout-btn-full layout-btn-primary" id="save-layout-done">✓ Done Editing</button>
                </div>
            </div>`;

        content.querySelectorAll('.preset-btn').forEach(btn => {
            btn.addEventListener('click', () => { if (confirm('Replace current widgets with this preset?')) grid.applyPreset(btn.dataset.preset); });
        });
        document.getElementById('apply-grid-size')?.addEventListener('click', () => {
            grid.setGridSize(parseInt(document.getElementById('grid-cols').value) || 12, parseInt(document.getElementById('grid-rows').value) || 8);
        });
        const slider = document.getElementById('input-area-height');
        const heightLabel = document.getElementById('input-area-height-label');
        if (slider) {
            slider.addEventListener('input', () => {
                const h = parseInt(slider.value);
                if (session._inputWrap) session._inputWrap.style.height = h + 'px';
                if (heightLabel) heightLabel.textContent = h + 'px';
                if (session.fitAddon && session.containerEl?.style.display !== 'none') session.fitAddon.fit();
            });
        }
        document.getElementById('clear-all-widgets')?.addEventListener('click', () => { if (confirm('Remove all widgets?')) for (const id of [...grid.widgets.keys()]) grid.removeWidget(id); });
        document.getElementById('save-layout-done')?.addEventListener('click', () => deactivatePanel());
    }

    function saveWidgetLayout(session) {
        if (!session?.widgetGrid || !session?.automation) return;
        const layout = session.widgetGrid.exportLayout();
        if (session.automation._storedData) session.automation._storedData.widgets = layout;
        session.automation.save();
    }

    // ══════════════════════════════════════════════════════════════
    // LOG TAB INDICATOR
    // ══════════════════════════════════════════════════════════════

    const updateLogsIndicator = () => {
        const logsTab = document.querySelector('.side-panel-tab[data-panel="logs"]');
        const logsBtn = document.getElementById('btn-logs');
        const active = sessionManager.getActive();
        const isLogging = active ? logger.isActive(active.id) : false;
        logsTab?.classList.toggle('has-active-logs', isLogging);
        logsBtn?.classList.toggle('has-active-logs', isLogging);
    };
    events.on(Events.LOG_START, updateLogsIndicator);
    events.on(Events.LOG_STOP, updateLogsIndicator);
    events.on(Events.SESSION_SWITCH, updateLogsIndicator);
    events.on(Events.SESSION_DESTROY, updateLogsIndicator);
    events.on(Events.SESSION_DESTROY, () => { automationPanel.clear(); });

    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('active'); });
    });

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllModals(); });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLOUD UI
// ═══════════════════════════════════════════════════════════════════════════════

function setupCloudUI() {
    const connScreen = document.getElementById('screen-connections');
    if (!connScreen) return;

    let cloudBar = document.getElementById('cloud-bar');
    if (!cloudBar) {
        cloudBar = document.createElement('div');
        cloudBar.id = 'cloud-bar';
        cloudBar.className = 'cloud-bar';
        const grid = document.getElementById('connection-grid');
        if (grid) {
            connScreen.insertBefore(cloudBar, grid);
        } else {
            connScreen.appendChild(cloudBar);
        }
    }

    function renderCloudBar() {
        if (cloudSync.isLoggedIn()) {
            const user = cloudSync.getUser();
            cloudBar.innerHTML = `
                <div class="cloud-bar-left">
                    <span class="cloud-user">
                        ${user?.avatar_url ? `<img class="cloud-avatar" src="${user.avatar_url}" alt="">` : ''}
                        <span class="cloud-name">${escapeHtml(user?.display_name || user?.email || 'Signed In')}</span>
                    </span>
                    <span class="cloud-sync-status" id="cloud-sync-indicator">☁ Synced</span>
                </div>
                <div class="cloud-bar-center">
                    <select id="device-set-select" class="device-set-select"><option value="" disabled>Loading sets...</option></select>
                    <button id="btn-add-device-set" class="cloud-btn cloud-btn-sm" title="New Device Set">+</button>
                    <button id="btn-clone-device-set" class="cloud-btn cloud-btn-sm" title="Clone Current Set">⧉</button>
                    <button id="btn-cloud-sync" class="cloud-btn cloud-btn-sm" title="Sync Now">↻</button>
                </div>
                <div class="cloud-bar-right">
                    <button id="btn-gdrive-backup" class="cloud-btn cloud-btn-sm" title="Backup to Google Drive">📁 Drive</button>
                    <button id="btn-cloud-signout" class="cloud-btn">Sign Out</button>
                </div>`;

            loadDeviceSetDropdown();
            document.getElementById('btn-cloud-signout')?.addEventListener('click', () => { cloudSync.signOut(); renderCloudBar(); });
            document.getElementById('btn-gdrive-backup')?.addEventListener('click', () => showGDriveModal());
            document.getElementById('btn-cloud-sync')?.addEventListener('click', async () => {
                const indicator = document.getElementById('cloud-sync-indicator');
                if (indicator) indicator.textContent = '☁ Syncing...';
                try { await cloudSync.fullSync(); if (indicator) indicator.textContent = '☁ Synced'; renderConnections(); }
                catch (e) { if (indicator) indicator.textContent = '⚠ Sync failed'; }
            });
            document.getElementById('btn-add-device-set')?.addEventListener('click', () => showDeviceSetModal());
            document.getElementById('btn-clone-device-set')?.addEventListener('click', () => showCloneSetModal());
            document.getElementById('device-set-select')?.addEventListener('change', async (e) => {
                const setId = e.target.value;
                if (!setId) return;
                const indicator = document.getElementById('cloud-sync-indicator');
                if (indicator) indicator.textContent = '☁ Switching...';
                try { sessionManager.closeAll(); await cloudSync.switchDeviceSet(setId); renderConnections(); if (indicator) indicator.textContent = '☁ Synced'; }
                catch (e) { if (indicator) indicator.textContent = '⚠ Switch failed'; console.error(e); }
            });
        } else {
            cloudBar.innerHTML = `
                <div class="cloud-bar-left"><span class="cloud-offline">Local Mode — Sign in to sync across devices</span></div>
                <div class="cloud-bar-right">
                    <button id="btn-google-signin" class="cloud-btn"><svg width="14" height="14" viewBox="0 0 24 24" style="vertical-align:middle;margin-right:4px"><path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>Google</button>
                    <button id="btn-github-signin" class="cloud-btn"><svg width="14" height="14" viewBox="0 0 24 24" style="vertical-align:middle;margin-right:4px"><path fill="currentColor" d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>GitHub</button>
                    <button id="btn-discord-signin" class="cloud-btn cloud-btn-discord"><svg width="14" height="14" viewBox="0 0 24 24" style="vertical-align:middle;margin-right:4px"><path fill="currentColor" d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03z"/></svg>Discord</button>
                </div>`;
            document.getElementById('btn-google-signin')?.addEventListener('click', () => cloudSync.signInWithGoogle());
            document.getElementById('btn-github-signin')?.addEventListener('click', () => cloudSync.signInWithGitHub());
            document.getElementById('btn-discord-signin')?.addEventListener('click', () => cloudSync.signInWithDiscord());
        }
    }

    async function loadDeviceSetDropdown() {
        try {
            const sets = await cloudSync.loadDeviceSets();
            const select = document.getElementById('device-set-select');
            if (!select) return;
            const activeSet = cloudSync.getActiveDeviceSet();
            select.innerHTML = sets.map(s => `<option value="${s.id}" ${s.id === activeSet?.id ? 'selected' : ''}>${escapeHtml(s.name)} (${s.device_type})</option>`).join('');
        } catch (e) { console.warn('Failed to load device sets:', e.message); }
    }

    function showDeviceSetModal() {
        closeAllModals();
        let modal = document.getElementById('modal-device-set');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'modal-device-set';
            modal.className = 'modal-overlay';
            modal.innerHTML = `<div class="modal"><div class="modal-header"><h3>New Device Set</h3></div><div class="modal-body"><div class="form-group"><label>Name</label><input type="text" id="ds-name" placeholder="e.g. Mobile, Tablet, Work PC"></div><div class="form-group"><label>Device Type</label><select id="ds-type"><option value="desktop">Desktop</option><option value="mobile">Mobile</option><option value="tablet">Tablet</option></select></div><div class="form-group"><label>Description</label><input type="text" id="ds-desc" placeholder="Optional"></div></div><div class="modal-footer"><button id="ds-cancel" class="modal-btn">Cancel</button><button id="ds-save" class="modal-btn modal-btn-primary">Create</button></div></div>`;
            document.body.appendChild(modal);
            modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('active'); });
        }
        modal.classList.add('active');
        document.getElementById('ds-name').value = '';
        document.getElementById('ds-desc').value = '';
        document.getElementById('ds-cancel').onclick = () => modal.classList.remove('active');
        document.getElementById('ds-save').onclick = async () => {
            const name = document.getElementById('ds-name').value.trim();
            if (!name) return;
            try { await cloudSync.createDeviceSet(name, document.getElementById('ds-type').value, document.getElementById('ds-desc').value.trim()); modal.classList.remove('active'); loadDeviceSetDropdown(); }
            catch (e) { alert('Failed to create device set: ' + e.message); }
        };
    }

    function showCloneSetModal() {
        const activeSet = cloudSync.getActiveDeviceSet();
        if (!activeSet) return alert('No active device set to clone');
        const name = prompt(`Clone "${activeSet.name}" as:`, `${activeSet.name} (Mobile)`);
        if (!name) return;
        const type = prompt('Device type (desktop/mobile/tablet):', 'mobile');
        if (!type) return;
        cloudSync.cloneDeviceSet(activeSet.id, name, type).then(() => loadDeviceSetDropdown()).catch(e => alert('Clone failed: ' + e.message));
    }

    function showGDriveModal() {
        const user = cloudSync.getUser();
        closeAllModals();
        let modal = document.getElementById('modal-gdrive');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'modal-gdrive';
            modal.className = 'modal-overlay';
            document.body.appendChild(modal);
            modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('active'); });
        }
        const isGoogle = user?.provider === 'google';
        modal.innerHTML = `<div class="modal" style="max-width:480px"><div class="modal-header"><h3>📁 Google Drive Backup</h3></div><div class="modal-body">${isGoogle ? `<p style="color:#8be9fd;font-size:0.85rem;margin-bottom:12px">Backup your MudTerm data to your Google Drive, or restore from a previous backup.</p><div style="display:flex;gap:8px;margin-bottom:16px"><button id="gdrive-backup-now" class="cloud-btn" style="flex:1;padding:8px">⬆ Backup Now</button><button id="gdrive-download" class="cloud-btn" style="flex:1;padding:8px">⬇ Download Backup</button></div><div id="gdrive-status" style="color:#50fa7b;font-size:0.8rem;margin-bottom:12px"></div><div id="gdrive-backups-list" style="font-size:0.8rem"><div style="color:#6272a4">Loading backups...</div></div>` : `<p style="color:#f1fa8c;font-size:0.85rem">Google Drive backup requires a Google-linked account.</p>`}</div><div class="modal-footer"><button id="gdrive-close" class="modal-btn">Close</button></div></div>`;
        modal.classList.add('active');
        document.getElementById('gdrive-close').onclick = () => modal.classList.remove('active');
        if (isGoogle) {
            document.getElementById('gdrive-backup-now').onclick = async () => {
                const status = document.getElementById('gdrive-status');
                status.textContent = 'Backing up...'; status.style.color = '#f1fa8c';
                try { const r = await cloudSync.backupToGoogleDrive(); status.textContent = '✓ Backup complete' + (r.fileName ? ` (${r.fileName})` : ''); status.style.color = '#50fa7b'; loadGDriveBackups(); }
                catch (e) { status.textContent = '✗ ' + e.message; status.style.color = '#ff5555'; }
            };
            document.getElementById('gdrive-download').onclick = async () => {
                const status = document.getElementById('gdrive-status');
                try { const backups = await cloudSync.listGoogleDriveBackups(); if (!backups.files?.length) { status.textContent = 'No backups to download'; status.style.color = '#f1fa8c'; return; } status.textContent = 'Downloading...'; await cloudSync.downloadGoogleDriveBackup(backups.files[0].id); status.textContent = '✓ Downloaded'; status.style.color = '#50fa7b'; }
                catch (e) { status.textContent = '✗ ' + e.message; status.style.color = '#ff5555'; }
            };
            async function loadGDriveBackups() {
                const listEl = document.getElementById('gdrive-backups-list');
                if (!listEl) return;
                try {
                    const data = await cloudSync.listGoogleDriveBackups();
                    if (!data.files?.length) { listEl.innerHTML = '<div style="color:#6272a4">No backups yet.</div>'; return; }
                    listEl.innerHTML = '<div style="color:#8be9fd;margin-bottom:6px">Previous Backups:</div>' + data.files.map(f => `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05)"><span style="color:#e8e8e8">${f.name||'Backup'}</span><span style="color:#6272a4">${new Date(f.modifiedTime||f.created_at).toLocaleDateString()}</span><button class="cloud-btn cloud-btn-sm gdrive-restore-btn" data-file-id="${f.id}">Restore</button></div>`).join('');
                    listEl.querySelectorAll('.gdrive-restore-btn').forEach(btn => {
                        btn.onclick = async () => {
                            if (!confirm('Restore from this backup? This will overwrite your current cloud data.')) return;
                            const status = document.getElementById('gdrive-status');
                            status.textContent = 'Restoring...'; status.style.color = '#f1fa8c';
                            try { await cloudSync.restoreFromGoogleDrive(btn.dataset.fileId); status.textContent = '✓ Restored! Reloading...'; status.style.color = '#50fa7b'; setTimeout(() => window.location.reload(), 1500); }
                            catch (e) { status.textContent = '✗ ' + e.message; status.style.color = '#ff5555'; }
                        };
                    });
                } catch (e) { listEl.innerHTML = `<div style="color:#ff5555">Failed to load: ${e.message}</div>`; }
            }
            loadGDriveBackups();
        }
    }

    events.on('cloud:signed-in', () => renderCloudBar());
    events.on('cloud:signed-out', () => renderCloudBar());
    events.on('cloud:sync-start', () => { const el = document.getElementById('cloud-sync-indicator'); if (el) el.textContent = '☁ Syncing...'; });
    events.on('cloud:sync-complete', () => {
        const el = document.getElementById('cloud-sync-indicator');
        if (el) el.textContent = '☁ Synced';
        cloudSync.fetchCloudConnections().then(() => renderConnections());
        sessionManager.getAllSessions().forEach(s => { if (s.automation) s.automation.reload(); });
        if (activeMode === 'auto') {
            const activeConnId = state.get('activeConnection');
            const session = (activeConnId
                ? sessionManager.getAllSessions().find(s => s.connectionConfig?.id === activeConnId)
                : null) || sessionManager.getActive() || sessionManager.getAllSessions()[0] || null;
            automationPanel.render(session);
        }
    });
    events.on('cloud:sync-error', ({ error }) => { const el = document.getElementById('cloud-sync-indicator'); if (el) el.textContent = '⚠ ' + (error || 'Sync error'); });
    events.on('cloud:device-set-changed', () => { renderConnections(); loadDeviceSetDropdown(); });
    events.on('cloud:device-sets-loaded', () => { loadDeviceSetDropdown(); renderConnections(); });
    events.on('cloud:connection-moved', () => renderConnections());

    renderCloudBar();
}

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION EVENTS
// ═══════════════════════════════════════════════════════════════════════════════

function setupSessionEvents() {
    events.on(Events.SESSION_SWITCH, ({ sessionId }) => {
        if (sessionId === null) { updateConnectionStatus(false); showConnections(); return; }
        const session = sessionManager.getSession(sessionId);
        if (session) { showTerminal(); updateConnectionStatus(session.connection.isConnected(), session.connectionConfig.name); automationPanel.render(session); }
    });
    events.on(Events.CONNECTION_OPEN, ({ sessionId }) => {
        const active = sessionManager.getActive();
        if (active && active.id === sessionId) updateConnectionStatus(true, active.connectionConfig.name);
    });
    events.on(Events.CONNECTION_CLOSE, ({ sessionId }) => {
        const active = sessionManager.getActive();
        if (active && active.id === sessionId) updateConnectionStatus(false, active.connectionConfig.name + ' (closed)');
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// THEME MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

const THEME_KEY = 'mudterm_theme';
const VALID_THEMES = ['dark', 'light', 'classic', 'claude'];

function applyTheme(theme) {
    if (!VALID_THEMES.includes(theme)) theme = 'dark';
    if (theme === 'dark') {
        document.documentElement.removeAttribute('data-theme');
    } else {
        document.documentElement.setAttribute('data-theme', theme);
    }
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
    const sel = document.getElementById('setting-theme');
    if (sel) sel.value = theme;
}

function setupTheme() {
    // Apply saved theme immediately
    const saved = (() => { try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) { return 'dark'; } })();
    applyTheme(saved);

    function wireThemeSelect() {
        const sel = document.getElementById('setting-theme');
        if (!sel || sel._themeWired) return;
        sel._themeWired = true;
        sel.value = (() => { try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) { return 'dark'; } })();
        sel.addEventListener('change', () => applyTheme(sel.value));
    }

    document.addEventListener('DOMContentLoaded', wireThemeSelect);
    // Also wire immediately in case DOM is already ready
    wireThemeSelect();
    // Re-sync value when settings modal opens (in case value got stale)
    document.addEventListener('click', (e) => {
        if (e.target.closest('#btn-settings')) {
            setTimeout(() => {
                const sel = document.getElementById('setting-theme');
                if (sel) {
                    sel.value = (() => { try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) { return 'dark'; } })();
                    if (!sel._themeWired) {
                        sel._themeWired = true;
                        sel.addEventListener('change', () => applyTheme(sel.value));
                    }
                }
            }, 0);
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// LIVE SETTINGS — Apply display/input changes to active terminal sessions
// ═══════════════════════════════════════════════════════════════════════════════

function applyDisplayToSession(session, cfg) {
    const t = session.terminal;
    if (!t || typeof t.options !== 'object') return;
    const patch = {};
    if (cfg.fontFamily    != null) patch.fontFamily    = cfg.fontFamily + ", 'Share Tech Mono', monospace";
    if (cfg.fontSize      != null) patch.fontSize      = parseFloat(cfg.fontSize);
    if (cfg.lineHeight    != null) patch.lineHeight    = parseFloat(cfg.lineHeight);
    if (cfg.letterSpacing != null) patch.letterSpacing = parseFloat(cfg.letterSpacing);
    if (cfg.scrollback    != null) patch.scrollback    = parseInt(cfg.scrollback, 10);
    if (Object.keys(patch).length) {
        t.options = patch;
        if (session.fitAddon && session.containerEl?.style.display !== 'none') session.fitAddon.fit();
    }
}

function applyInputToSession(session, cfg) {
    if (cfg.localEcho      != null) session.localEcho             = cfg.localEcho;
    if (cfg.commandHistory != null) session.commandHistoryEnabled = cfg.commandHistory;
    if (cfg.historySize    != null) {
        session.historySize = parseInt(cfg.historySize, 10);
        if (Array.isArray(session.commandHistory) && session.commandHistory.length > session.historySize)
            session.commandHistory = session.commandHistory.slice(0, session.historySize);
    }
    if (cfg.cmdSeparator != null) session.cmdSeparator = cfg.cmdSeparator;
}

function restoreDisplayForSession(session) {
    if (!session?.connectionConfig) return;
    try {
        const raw = localStorage.getItem('mudterm_display_' + session.connectionConfig.id);
        if (!raw) return;
        const cfg = JSON.parse(raw);
        applyDisplayToSession(session, cfg);
        applyInputToSession(session, { cmdSeparator: cfg.cmdSeparator });
    } catch (e) { console.warn('[live-settings] restoreDisplay error:', e); }
}

async function persistDisplaySettings(connId, cfg) {
    try {
        const raw = localStorage.getItem('mudterm_display_' + connId);
        const existing = raw ? JSON.parse(raw) : {};
        const snapshot = Object.assign(existing, {
            fontFamily:    cfg.fontFamily    ?? existing.fontFamily,
            fontSize:      cfg.fontSize      != null ? parseFloat(cfg.fontSize)      : existing.fontSize,
            lineHeight:    cfg.lineHeight    != null ? parseFloat(cfg.lineHeight)    : existing.lineHeight,
            letterSpacing: cfg.letterSpacing != null ? parseFloat(cfg.letterSpacing) : existing.letterSpacing,
            scrollback:    cfg.scrollback    != null ? parseInt(cfg.scrollback, 10)  : existing.scrollback,
            cmdSeparator:  cfg.cmdSeparator  ?? existing.cmdSeparator,
        });
        localStorage.setItem('mudterm_display_' + connId, JSON.stringify(snapshot));
    } catch (e) { console.warn('[live-settings] persist error:', e); }
    // Cloud sync if applicable
    if (cloudSync.isCloudConnection && cloudSync.isCloudConnection(connId)) {
        try { await cloudSync.fullSync(); } catch (e) {}
    }
}

function setupLiveSettings() {
    // Hook save button for edit connection modal
    function hookSaveBtn() {
        const btn = document.getElementById('save-edit-connection');
        if (!btn || btn._liveHooked) return;
        btn._liveHooked = true;
        btn.addEventListener('click', () => {
            setTimeout(async () => {
                const connId = document.getElementById('edit-conn-id')?.value;
                if (!connId) return;
                const cfg = {
                    fontFamily:     document.getElementById('edit-conn-font-family')?.value,
                    fontSize:       document.getElementById('edit-conn-font-size')?.value,
                    lineHeight:     document.getElementById('edit-conn-line-height')?.value,
                    letterSpacing:  document.getElementById('edit-conn-letter-spacing')?.value,
                    scrollback:     document.getElementById('edit-conn-scrollback')?.value,
                    localEcho:      document.getElementById('edit-conn-local-echo')?.checked,
                    commandHistory: document.getElementById('edit-conn-command-history')?.checked,
                    historySize:    document.getElementById('edit-conn-history-size')?.value,
                    cmdSeparator:   document.getElementById('edit-conn-cmd-separator')?.value,
                };
                // Apply to all open sessions for this connection
                sessionManager.getAllSessions().filter(s => s.connectionConfig?.id === connId).forEach(s => {
                    applyDisplayToSession(s, cfg);
                    applyInputToSession(s, cfg);
                });
                await persistDisplaySettings(connId, cfg);
            }, 30);
        });
    }

    // Populate display fields when edit modal opens
    function watchEditModal() {
        const modal = document.getElementById('modal-edit-connection');
        if (!modal) return;
        const observer = new MutationObserver(() => {
            if (modal.classList.contains('active')) {
                setTimeout(() => {
                    const connId = document.getElementById('edit-conn-id')?.value;
                    if (!connId) return;
                    const sessions = sessionManager.getAllSessions().filter(s => s.connectionConfig?.id === connId);
                    const cc = sessions[0]?.connectionConfig;
                    let stored = null;
                    try { const r = localStorage.getItem('mudterm_display_' + connId); if (r) stored = JSON.parse(r); } catch (e) {}
                    const src = cc || stored || {};
                    function fill(id, v, fb) { const el = document.getElementById(id); if (el) el.value = v ?? fb ?? ''; }
                    fill('edit-conn-font-family',    src.fontFamily,    'JetBrains Mono');
                    fill('edit-conn-font-size',      src.fontSize,      14);
                    fill('edit-conn-line-height',    src.lineHeight,    1.2);
                    fill('edit-conn-letter-spacing', src.letterSpacing, 0);
                    fill('edit-conn-scrollback',     src.scrollback,    10000);
                    fill('edit-conn-cmd-separator',  src.cmdSeparator,  ';');
                    hookSaveBtn();
                }, 60);
            }
        });
        observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
    }

    // Restore display settings when session is created or switched
    events.on(Events.SESSION_CREATE, ({ sessionId }) => {
        setTimeout(() => restoreDisplayForSession(sessionManager.getSession(sessionId)), 0);
    });
    events.on(Events.SESSION_SWITCH, ({ sessionId }) => {
        if (sessionId) setTimeout(() => restoreDisplayForSession(sessionManager.getSession(sessionId)), 0);
    });

    hookSaveBtn();
    watchEditModal();
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONNECTION MODE — Secure (wss://) vs Plain (ws://)
// Lets users switch between https://mudterm.com and http://plain.mudterm.com
// Browsers block ws:// from https:// pages (mixed content policy)
// ═══════════════════════════════════════════════════════════════════════════════

const SECURE_ORIGIN = 'https://mudterm.com';
const PLAIN_ORIGIN  = 'http://plain.mudterm.com';
const CONN_MODE_KEY = 'mudterm_connection_mode';

function getConnectionMode() {
    try {
        const stored = localStorage.getItem(CONN_MODE_KEY);
        if (stored) return stored;
        // No preference stored — infer from current origin so first-time plain.mudterm.com visitors aren't bounced
        return window.location.origin === PLAIN_ORIGIN ? 'plain' : 'secure';
    } catch (e) { return 'secure'; }
}

function setConnectionMode(mode) {
    try { localStorage.setItem(CONN_MODE_KEY, mode); } catch (e) {}
}

function redirectToOrigin(origin) {
    const dest = origin + window.location.pathname + window.location.search + window.location.hash;
    window.location.replace(dest);
}

function setupConnectionMode() {
    const origin = window.location.origin;
    const isDev  = origin.includes('localhost') || origin.includes('127.0.0.1');

    // On-load redirect: only redirect if there is an EXPLICIT stored preference that doesn't match
    // Never redirect first-time visitors — store their current origin as preference instead
    if (!isDev) {
        let stored = null;
        try { stored = localStorage.getItem(CONN_MODE_KEY); } catch (e) {}
        if (stored) {
            const expected = stored === 'plain' ? PLAIN_ORIGIN : SECURE_ORIGIN;
            if (origin !== expected) { redirectToOrigin(expected); return; }
        } else {
            // First visit — lock in the origin they actually arrived at
            setConnectionMode(origin === PLAIN_ORIGIN ? 'plain' : 'secure');
        }
    }

    // Inject toggle UI into settings modal
    function injectToggle() {
        if (document.getElementById('connection-mode-group')) return;

        const mode    = getConnectionMode();
        const isPlain = mode === 'plain';

        // Find theme group to insert before it
        let themeGroup = null;
        document.querySelectorAll('.form-group').forEach(el => {
            if (el.querySelector('#setting-theme')) themeGroup = el;
        });

        const wrapper = document.createElement('div');
        wrapper.className = 'form-group';
        wrapper.id = 'connection-mode-group';
        wrapper.innerHTML = `
            <label class="form-label" style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                <span>Connection Mode</span>
                <span id="conn-mode-badge" style="font-size:0.65rem;padding:2px 7px;border-radius:10px;font-family:'JetBrains Mono',monospace;background:${isPlain ? 'rgba(255,184,0,0.15);color:#ffb800;border:1px solid rgba(255,184,0,0.3)' : 'rgba(0,245,255,0.1);color:#00f5ff;border:1px solid rgba(0,245,255,0.2)'}">
                    ${isPlain ? 'Plain HTTP' : 'Secure HTTPS'}
                </span>
            </label>
            <div style="display:flex;gap:6px;margin-top:6px;">
                <button id="conn-mode-secure" class="modal-btn${!isPlain ? ' primary' : ''}" style="flex:1;font-size:0.75rem;" ${isDev ? 'disabled title="Redirect disabled in dev"' : ''}>🔒 Secure (wss://)</button>
                <button id="conn-mode-plain"  class="modal-btn${isPlain  ? ' primary' : ''}" style="flex:1;font-size:0.75rem;" ${isDev ? 'disabled title="Redirect disabled in dev"' : ''}>⚠ Plain (ws://)</button>
            </div>
            <div style="margin-top:6px;font-size:0.68rem;color:var(--text-muted,#556677);line-height:1.4;">
                ${isPlain
                    ? '⚠ Plain mode — ws:// connections allowed. Not suitable for sensitive data.'
                    : '✓ Secure mode — wss:// only. Switch to Plain if your server doesn\'t support SSL.'}
            </div>`;

        if (themeGroup?.parentNode) {
            themeGroup.parentNode.insertBefore(wrapper, themeGroup);
        } else {
            const modalBody = document.querySelector('#modal-settings .modal');
            if (modalBody) {
                const actions = modalBody.querySelector('.modal-actions');
                if (actions) modalBody.insertBefore(wrapper, actions);
                else modalBody.appendChild(wrapper);
            }
        }

        document.getElementById('conn-mode-secure')?.addEventListener('click', () => {
            if (isDev) return;
            setConnectionMode('secure');
            redirectToOrigin(SECURE_ORIGIN);
        });
        document.getElementById('conn-mode-plain')?.addEventListener('click', () => {
            if (isDev) return;
            setConnectionMode('plain');
            redirectToOrigin(PLAIN_ORIGIN);
        });
    }

    // Wire to settings modal open
    const settingsModal = document.getElementById('modal-settings');
    if (settingsModal) {
        new MutationObserver(() => {
            if (settingsModal.classList.contains('active')) injectToggle();
        }).observe(settingsModal, { attributes: true, attributeFilter: ['class'] });
    }
    document.addEventListener('click', e => {
        if (e.target.closest('#btn-settings')) setTimeout(injectToggle, 0);
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════════

async function init() {
    await storage.load();
    const termContainer = document.getElementById('terminal-container');
    if (termContainer) sessionManager.setTerminalParent(termContainer);
    const tabBarEl = document.getElementById('tab-bar');
    if (tabBarEl) tabBar.init(tabBarEl, showConnections);
    const statusBarEl = document.getElementById('status-bar');
    if (statusBarEl) statusBar.init(statusBarEl);
    const logsContent = document.getElementById('logs-content');
    if (logsContent) logPanel.init(logsContent);
    setup();
    setupSessionEvents();
    setupTheme();
    setupLiveSettings();
    setupConnectionMode();
    window.sessionManager = sessionManager;
    window.cloudSync = cloudSync;
    window.automationPanel = automationPanel;
    window.automationStore = automationStore;
    setupCloudUI();  // MUST be before cloudSync.init() so listeners are ready
    renderConnections();
    showScreen('connections');
    try { await cloudSync.init(); renderConnections(); setupCloudUI(); } catch (e) { console.warn('[INIT] Cloud sync init error:', e.message); }
    checkUrlConnect();
    console.log('MUDTERM.IO initialized');
}

// ═══════════════════════════════════════════════════════════════════════════════
// URL QUICK-CONNECT
// ═══════════════════════════════════════════════════════════════════════════════

function checkUrlConnect() {
    const params = new URLSearchParams(window.location.search);
    if (params.has('auth_token') || params.has('auth_error')) return;
    const host = params.get('host');
    const port = params.get('port');
    const directUrl = params.get('url');
    if (!directUrl && (!host || !port)) return;
    window.history.replaceState({}, '', window.location.pathname);
    const ssl = params.get('ssl') === '1';
    const name = params.get('name') || (directUrl ? 'Quick Connect' : `${host}:${port}`);
    const bridge = params.get('bridge');
    const type = bridge ? 'bridge' : (params.get('type') === 'telnet' ? 'bridge' : 'direct');
    const protocol = params.get('protocol') || 'auto';
    const shouldSave = params.get('save') === '1';
    let connData;
    if (type === 'bridge') {
        const bridgeUrl = bridge || state.get('settings.defaultBridge', '');
        if (!bridgeUrl) { console.warn('[QuickConnect] Bridge mode but no bridge URL'); return; }
        connData = { id: '_urlconnect_' + Date.now(), name, type: 'bridge', protocol, color: 'yellow', bridgeUrl, mudHost: host, mudPort: parseInt(port, 10), url: `${bridgeUrl}?host=${encodeURIComponent(host)}&port=${port}`, profiles: [] };
    } else {
        let wsUrl = directUrl;
        if (!wsUrl) wsUrl = `${ssl ? 'wss' : 'ws'}://${host}:${port}`;
        connData = { id: '_urlconnect_' + Date.now(), name, type: 'direct', protocol, color: 'cyan', url: wsUrl, profiles: [] };
    }
    if (shouldSave) {
        const connections = state.get('connections', []);
        const exists = connections.some(c => (c.url === connData.url) || (c.mudHost === connData.mudHost && c.mudPort === connData.mudPort));
        if (!exists) { connData.id = generateId(); connections.push(connData); state.set('connections', connections); storage.save(); renderConnections(); }
    }
    showTerminal();
    sessionManager.createSession(connData, null);
}

init().catch(console.error);
