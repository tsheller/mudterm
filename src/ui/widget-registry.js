/**
 * Widget Registry
 * ===============
 * Defines all widget types and their render/config functions.
 * Stateless — shared across sessions. Instances are per-session.
 */

import { events, Events } from '../core/events.js';

// ═══════════════════════════════════════════════════════════════════════
// WIDGET TYPES
// ═══════════════════════════════════════════════════════════════════════

export const WidgetTypes = {
    GAUGE_BAR:      'gauge-bar',
    HOTBAR:         'hotbar',
    COOLDOWN_BTN:   'cooldown-btn',
    TEXT_PANEL:     'text-panel',
    COMPASS:        'compass',
    BUTTON_GRID:    'button-grid',
    STATUS_DISPLAY: 'status-display',
    MINI_MAP:       'mini-map',
    VAR_DISPLAY:    'var-display'
};

// ═══════════════════════════════════════════════════════════════════════
// REGISTRY
// ═══════════════════════════════════════════════════════════════════════

const registry = new Map();

function reg(type, def) {
    registry.set(type, {
        type,
        name: def.name,
        icon: def.icon || '▦',
        description: def.description || '',
        minSize: def.minSize || { cols: 2, rows: 1 },
        defaultSize: def.defaultSize || { cols: 3, rows: 2 },
        defaultConfig: def.defaultConfig || {},
        render: def.render,
        configFields: def.configFields || []
    });
}

export function getWidgetDef(type) { return registry.get(type); }
export function getAllWidgetDefs() { return [...registry.values()]; }

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// ═══════════════════════════════════════════════════════════════════════
// GAUGE BAR — HP/Mana/Moves with thresholds
// ═══════════════════════════════════════════════════════════════════════

reg(WidgetTypes.GAUGE_BAR, {
    name: 'Gauge Bar',
    icon: '█',
    description: 'HP/Mana/Move bars with customizable colors and thresholds',
    minSize: { cols: 2, rows: 1 },
    defaultSize: { cols: 4, rows: 2 },
    defaultConfig: {
        orientation: 'horizontal', // horizontal | vertical
        bars: [
            { label: 'HP',   varCur: 'char.hp',   varMax: 'char.hp_max',   color: '#e74c3c', lowThreshold: 25 },
            { label: 'Mana', varCur: 'char.mana', varMax: 'char.mana_max', color: '#3498db', lowThreshold: 20 },
            { label: 'Move', varCur: 'char.move', varMax: 'char.move_max', color: '#2ecc71', lowThreshold: 15 }
        ],
        showNumbers: true,
        showPercent: true,
        flashOnLow: true
    },
    configFields: [
        { name: 'orientation', type: 'select', options: ['horizontal','vertical'], label: 'Orientation' },
        { name: 'showNumbers', type: 'checkbox', label: 'Show Numbers' },
        { name: 'showPercent', type: 'checkbox', label: 'Show Percent' },
        { name: 'flashOnLow', type: 'checkbox', label: 'Flash on Low' }
    ],
    render(widget, el, getVar) {
        const cfg = widget.config;
        const isVert = cfg.orientation === 'vertical';
        el.className = `wgt-gauge ${isVert ? 'wgt-gauge-vert' : 'wgt-gauge-horiz'}`;
        el.innerHTML = '';

        for (const bar of cfg.bars) {
            const cur = parseFloat(getVar(bar.varCur)) || 0;
            const max = parseFloat(getVar(bar.varMax)) || 100;
            const pct = max > 0 ? clamp((cur / max) * 100, 0, 100) : 0;
            const isLow = pct <= (bar.lowThreshold || 0);

            const barEl = document.createElement('div');
            barEl.className = `gauge-bar-item${isLow && cfg.flashOnLow ? ' gauge-low' : ''}`;

            const label = cfg.showNumbers
                ? `${bar.label}: ${Math.round(cur)}/${Math.round(max)}${cfg.showPercent ? ` (${Math.round(pct)}%)` : ''}`
                : `${bar.label}${cfg.showPercent ? `: ${Math.round(pct)}%` : ''}`;

            barEl.innerHTML = `
                <div class="gauge-label">${esc(label)}</div>
                <div class="gauge-track">
                    <div class="gauge-fill" style="
                        ${isVert ? 'height' : 'width'}: ${pct}%;
                        background: ${bar.color};
                    "></div>
                </div>`;
            el.appendChild(barEl);
        }
    }
});

// ═══════════════════════════════════════════════════════════════════════
// HOTBAR — horizontal/vertical button strip with pages
// ═══════════════════════════════════════════════════════════════════════

reg(WidgetTypes.HOTBAR, {
    name: 'Hotbar',
    icon: '⌨',
    description: 'Paginated button strip with keybinds',
    minSize: { cols: 3, rows: 1 },
    defaultSize: { cols: 6, rows: 1 },
    defaultConfig: {
        orientation: 'horizontal',
        buttonsPerPage: 10,
        currentPage: 0,
        pages: [
            // page 0: array of { label, command, icon?, color? }
            [
                { label: '1', command: '' },
                { label: '2', command: '' },
                { label: '3', command: '' },
                { label: '4', command: '' },
                { label: '5', command: '' },
                { label: '6', command: '' },
                { label: '7', command: '' },
                { label: '8', command: '' },
                { label: '9', command: '' },
                { label: '0', command: '' }
            ]
        ],
        showPageArrows: true,
        showKeybinds: true
    },
    configFields: [
        { name: 'orientation', type: 'select', options: ['horizontal','vertical'], label: 'Orientation' },
        { name: 'buttonsPerPage', type: 'number', label: 'Buttons per Page', min: 1, max: 20 },
        { name: 'showPageArrows', type: 'checkbox', label: 'Show Page Arrows' },
        { name: 'showKeybinds', type: 'checkbox', label: 'Show Keybinds' }
    ],
    render(widget, el, getVar, sendFn) {
        const cfg = widget.config;
        const isVert = cfg.orientation === 'vertical';
        el.className = `wgt-hotbar ${isVert ? 'wgt-hotbar-vert' : 'wgt-hotbar-horiz'}`;
        el.innerHTML = '';

        const page = cfg.pages[cfg.currentPage] || [];

        if (cfg.showPageArrows && cfg.pages.length > 1) {
            const prev = document.createElement('button');
            prev.className = 'hotbar-arrow';
            prev.textContent = isVert ? '▲' : '◀';
            prev.onclick = () => {
                cfg.currentPage = (cfg.currentPage - 1 + cfg.pages.length) % cfg.pages.length;
                this.render(widget, el, getVar, sendFn);
            };
            el.appendChild(prev);
        }

        const strip = document.createElement('div');
        strip.className = 'hotbar-strip';

        for (let i = 0; i < page.length; i++) {
            const btn = page[i];
            const btnEl = document.createElement('button');
            btnEl.className = `hotbar-btn${btn.command ? '' : ' hotbar-btn-empty'}`;
            if (btn.color) btnEl.style.borderColor = btn.color;

            let label = btn.icon || btn.label || '';
            if (cfg.showKeybinds) {
                const kb = i < 9 ? String(i + 1) : i === 9 ? '0' : '';
                if (kb) label = `<span class="hotbar-kb">${kb}</span>${label}`;
            }
            btnEl.innerHTML = label;
            btnEl.title = btn.command || '(empty)';

            if (btn.command) {
                btnEl.onclick = () => sendFn(btn.command);
            }
            strip.appendChild(btnEl);
        }
        el.appendChild(strip);

        if (cfg.showPageArrows && cfg.pages.length > 1) {
            const next = document.createElement('button');
            next.className = 'hotbar-arrow';
            next.textContent = isVert ? '▼' : '▶';
            next.onclick = () => {
                cfg.currentPage = (cfg.currentPage + 1) % cfg.pages.length;
                this.render(widget, el, getVar, sendFn);
            };
            el.appendChild(next);

            const indicator = document.createElement('div');
            indicator.className = 'hotbar-page-indicator';
            indicator.textContent = `${cfg.currentPage + 1}/${cfg.pages.length}`;
            el.appendChild(indicator);
        }
    }
});

// ═══════════════════════════════════════════════════════════════════════
// COOLDOWN BUTTON — single button with radial sweep animation
// ═══════════════════════════════════════════════════════════════════════

reg(WidgetTypes.COOLDOWN_BTN, {
    name: 'Cooldown Button',
    icon: '⏱',
    description: 'Button with visual cooldown timer',
    minSize: { cols: 1, rows: 1 },
    defaultSize: { cols: 1, rows: 1 },
    defaultConfig: {
        label: 'Ability',
        icon: '⚔',
        command: '',
        cooldownMs: 3000,
        color: '#e74c3c',
        triggerName: '' // trigger that resets cooldown
    },
    configFields: [
        { name: 'label', type: 'text', label: 'Label' },
        { name: 'icon', type: 'text', label: 'Icon (emoji)' },
        { name: 'command', type: 'text', label: 'Command' },
        { name: 'cooldownMs', type: 'number', label: 'Cooldown (ms)', min: 100 },
        { name: 'color', type: 'color', label: 'Color' }
    ],
    render(widget, el, getVar, sendFn) {
        const cfg = widget.config;
        el.className = 'wgt-cooldown-btn';

        // State stored on widget instance
        if (!widget._cdState) widget._cdState = { onCooldown: false, startTime: 0 };
        const cdState = widget._cdState;

        el.innerHTML = `
            <button class="cd-btn${cdState.onCooldown ? ' on-cooldown' : ''}" style="--cd-color: ${cfg.color}">
                <svg class="cd-overlay" viewBox="0 0 100 100">
                    <circle class="cd-circle" cx="50" cy="50" r="45" />
                </svg>
                <span class="cd-icon">${esc(cfg.icon || cfg.label)}</span>
                <span class="cd-label">${esc(cfg.label)}</span>
            </button>`;

        const btn = el.querySelector('.cd-btn');
        const circle = el.querySelector('.cd-circle');

        if (cdState.onCooldown) {
            const elapsed = Date.now() - cdState.startTime;
            const remaining = cfg.cooldownMs - elapsed;
            if (remaining > 0) {
                const circumference = 2 * Math.PI * 45;
                circle.style.strokeDasharray = `${circumference}`;
                circle.style.strokeDashoffset = `${circumference * (1 - remaining / cfg.cooldownMs)}`;
                circle.style.transition = `stroke-dashoffset ${remaining}ms linear`;
                requestAnimationFrame(() => {
                    circle.style.strokeDashoffset = `${circumference}`;
                });
                setTimeout(() => {
                    cdState.onCooldown = false;
                    this.render(widget, el, getVar, sendFn);
                }, remaining);
            } else {
                cdState.onCooldown = false;
            }
        }

        btn.onclick = () => {
            if (cdState.onCooldown) return;
            if (cfg.command) sendFn(cfg.command);
            cdState.onCooldown = true;
            cdState.startTime = Date.now();
            this.render(widget, el, getVar, sendFn);
        };
    }
});

// ═══════════════════════════════════════════════════════════════════════
// TEXT PANEL — tabbed mini-console for routed output
// ═══════════════════════════════════════════════════════════════════════

reg(WidgetTypes.TEXT_PANEL, {
    name: 'Text Panel',
    icon: '☰',
    description: 'Mini-console for routed text (chat, combat log, etc.)',
    minSize: { cols: 3, rows: 2 },
    defaultSize: { cols: 4, rows: 4 },
    defaultConfig: {
        panelName: 'panel1', // triggers route text here via this name
        tabs: [{ name: 'Main', filter: '' }],
        maxLines: 200,
        showTimestamps: true,
        fontSize: 12,
        activeTab: 0
    },
    configFields: [
        { name: 'panelName', type: 'text', label: 'Panel Name (for trigger routing)' },
        { name: 'maxLines', type: 'number', label: 'Max Lines', min: 50, max: 5000 },
        { name: 'showTimestamps', type: 'checkbox', label: 'Show Timestamps' },
        { name: 'fontSize', type: 'number', label: 'Font Size (px)', min: 8, max: 24 }
    ],
    render(widget, el) {
        const cfg = widget.config;
        el.className = 'wgt-text-panel';

        // Initialize line buffer on widget instance
        if (!widget._lines) widget._lines = [];
        const lines = widget._lines;

        el.innerHTML = `
            <div class="tp-tabs">${cfg.tabs.map((t, i) =>
                `<button class="tp-tab${i === cfg.activeTab ? ' active' : ''}" data-idx="${i}">${esc(t.name)}</button>`
            ).join('')}</div>
            <div class="tp-content" style="font-size: ${cfg.fontSize}px"></div>`;

        const content = el.querySelector('.tp-content');
        const filtered = cfg.tabs[cfg.activeTab]?.filter
            ? lines.filter(l => l.text.includes(cfg.tabs[cfg.activeTab].filter))
            : lines;

        for (const line of filtered.slice(-cfg.maxLines)) {
            const div = document.createElement('div');
            div.className = 'tp-line';
            const ts = cfg.showTimestamps ? `<span class="tp-ts">[${new Date(line.time).toLocaleTimeString()}]</span> ` : '';
            div.innerHTML = ts + esc(line.text);
            content.appendChild(div);
        }

        content.scrollTop = content.scrollHeight;

        // Tab switching
        el.querySelectorAll('.tp-tab').forEach(tab => {
            tab.onclick = () => {
                cfg.activeTab = parseInt(tab.dataset.idx);
                this.render(widget, el);
            };
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════
// COMPASS — directional movement
// ═══════════════════════════════════════════════════════════════════════

reg(WidgetTypes.COMPASS, {
    name: 'Compass',
    icon: '✦',
    description: 'Directional movement buttons',
    minSize: { cols: 2, rows: 2 },
    defaultSize: { cols: 2, rows: 2 },
    defaultConfig: {
        showDiagonals: true,
        showUpDown: true,
        style: 'classic'
    },
    configFields: [
        { name: 'showDiagonals', type: 'checkbox', label: 'Show Diagonals' },
        { name: 'showUpDown', type: 'checkbox', label: 'Show Up/Down' },
        { name: 'style', type: 'select', options: ['classic','modern','minimal'], label: 'Style' }
    ],
    render(widget, el, getVar, sendFn) {
        const cfg = widget.config;
        el.className = `wgt-compass wgt-compass-${cfg.style}`;

        const dirs = [
            cfg.showDiagonals ? ['nw','northwest'] : null, ['n','north'], cfg.showDiagonals ? ['ne','northeast'] : null,
            ['w','west'], null, ['e','east'],
            cfg.showDiagonals ? ['sw','southwest'] : null, ['s','south'], cfg.showDiagonals ? ['se','southeast'] : null
        ];

        let html = '<div class="compass-grid">';
        for (const d of dirs) {
            if (d === null) {
                html += '<div class="compass-cell compass-center"></div>';
            } else if (d) {
                html += `<button class="compass-cell compass-dir" data-cmd="${d[1]}">${d[0].toUpperCase()}</button>`;
            } else {
                html += '<div class="compass-cell"></div>';
            }
        }
        html += '</div>';

        if (cfg.showUpDown) {
            html += `<div class="compass-ud">
                <button class="compass-dir" data-cmd="up">U</button>
                <button class="compass-dir" data-cmd="down">D</button>
            </div>`;
        }

        el.innerHTML = html;
        el.querySelectorAll('.compass-dir').forEach(btn => {
            btn.onclick = () => sendFn(btn.dataset.cmd);
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════
// BUTTON GRID — NxM configurable command buttons
// ═══════════════════════════════════════════════════════════════════════

reg(WidgetTypes.BUTTON_GRID, {
    name: 'Button Grid',
    icon: '⊞',
    description: 'Configurable grid of command buttons',
    minSize: { cols: 2, rows: 1 },
    defaultSize: { cols: 3, rows: 2 },
    defaultConfig: {
        columns: 3,
        rows: 3,
        buttons: [],
        showLabels: true,
        buttonSize: 'medium'
    },
    configFields: [
        { name: 'columns', type: 'number', label: 'Columns', min: 1, max: 10 },
        { name: 'rows', type: 'number', label: 'Rows', min: 1, max: 10 },
        { name: 'showLabels', type: 'checkbox', label: 'Show Labels' },
        { name: 'buttonSize', type: 'select', options: ['small','medium','large'], label: 'Button Size' }
    ],
    render(widget, el, getVar, sendFn) {
        const cfg = widget.config;
        el.className = `wgt-btn-grid wgt-btn-${cfg.buttonSize}`;
        el.style.gridTemplateColumns = `repeat(${cfg.columns}, 1fr)`;

        el.innerHTML = '';
        const total = cfg.columns * cfg.rows;
        for (let i = 0; i < total; i++) {
            const btn = cfg.buttons[i] || {};
            const btnEl = document.createElement('button');
            btnEl.className = `grid-btn${btn.command ? '' : ' grid-btn-empty'}`;
            if (btn.color) btnEl.style.background = btn.color;
            btnEl.innerHTML = cfg.showLabels ? esc(btn.label || '') : (btn.icon || '');
            btnEl.title = btn.command || '';
            if (btn.command) btnEl.onclick = () => sendFn(btn.command);
            el.appendChild(btnEl);
        }
    }
});

// ═══════════════════════════════════════════════════════════════════════
// STATUS DISPLAY — character info fields
// ═══════════════════════════════════════════════════════════════════════

reg(WidgetTypes.STATUS_DISPLAY, {
    name: 'Status Display',
    icon: '📋',
    description: 'Character status info',
    minSize: { cols: 2, rows: 1 },
    defaultSize: { cols: 3, rows: 2 },
    defaultConfig: {
        fields: [
            { label: 'Name', var: 'char.name' },
            { label: 'Level', var: 'char.level' },
            { label: 'Class', var: 'char.class' }
        ],
        compact: false
    },
    configFields: [
        { name: 'compact', type: 'checkbox', label: 'Compact Mode' }
    ],
    render(widget, el, getVar) {
        const cfg = widget.config;
        el.className = `wgt-status${cfg.compact ? ' wgt-status-compact' : ''}`;
        el.innerHTML = '';
        for (const f of cfg.fields) {
            const val = getVar(f.var) || '—';
            const row = document.createElement('div');
            row.className = 'status-row';
            row.innerHTML = `<span class="status-label">${esc(f.label)}</span><span class="status-value">${esc(String(val))}</span>`;
            el.appendChild(row);
        }
    }
});

// ═══════════════════════════════════════════════════════════════════════
// MINI MAP — room display
// ═══════════════════════════════════════════════════════════════════════

reg(WidgetTypes.MINI_MAP, {
    name: 'Mini Map',
    icon: '🗺',
    description: 'Room/area map display',
    minSize: { cols: 2, rows: 2 },
    defaultSize: { cols: 3, rows: 3 },
    defaultConfig: {
        showExits: true,
        showCoords: true,
        roomVar: 'room.name',
        areaVar: 'room.area',
        exitsVar: 'room.exits',
        mapVar: 'room.map'
    },
    configFields: [
        { name: 'showExits', type: 'checkbox', label: 'Show Exits' },
        { name: 'showCoords', type: 'checkbox', label: 'Show Coordinates' }
    ],
    render(widget, el, getVar) {
        const cfg = widget.config;
        el.className = 'wgt-minimap';
        const mapText = getVar(cfg.mapVar);
        const roomName = getVar(cfg.roomVar) || 'Unknown';
        const area = getVar(cfg.areaVar) || '';
        const exits = getVar(cfg.exitsVar);

        if (mapText) {
            el.innerHTML = `<pre class="minimap-ascii">${esc(mapText)}</pre>`;
        } else {
            el.innerHTML = `
                <div class="minimap-room">${esc(roomName)}</div>
                ${area ? `<div class="minimap-area">${esc(area)}</div>` : ''}
                ${cfg.showExits && exits ? `<div class="minimap-exits">Exits: ${esc(Array.isArray(exits) ? exits.join(', ') : String(exits))}</div>` : ''}`;
        }
    }
});

// ═══════════════════════════════════════════════════════════════════════
// VARIABLE DISPLAY — shows script variables in real-time
// ═══════════════════════════════════════════════════════════════════════

reg(WidgetTypes.VAR_DISPLAY, {
    name: 'Variable Display',
    icon: '{x}',
    description: 'Shows script/state variables in real-time',
    minSize: { cols: 2, rows: 1 },
    defaultSize: { cols: 3, rows: 2 },
    defaultConfig: {
        variables: [
            { label: 'Target', var: 'combat.target' },
            { label: 'Gold', var: 'char.gold' }
        ],
        refreshMs: 1000
    },
    configFields: [],
    render(widget, el, getVar) {
        el.className = 'wgt-var-display';
        el.innerHTML = '';
        for (const v of widget.config.variables) {
            const val = getVar(v.var);
            const row = document.createElement('div');
            row.className = 'var-row';
            row.innerHTML = `<span class="var-label">${esc(v.label)}</span><span class="var-value">${val !== undefined ? esc(String(val)) : '<span class="var-undef">—</span>'}</span>`;
            el.appendChild(row);
        }
    }
});

export default registry;
