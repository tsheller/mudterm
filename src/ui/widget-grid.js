/**
 * Widget Grid — Zone-Based Layout Engine
 * =======================================
 * Manages widgets across 5 zones:
 *   - overlay: CSS Grid positioned over the terminal (floating panels)
 *   - top/bottom: Flex rows docked above/below the terminal+input
 *   - left/right: Flex columns docked beside the terminal+input
 *
 * Features:
 *   - Edit mode with grid overlay, drag-to-place, resize handles
 *   - Widget palette drawer with zone selector
 *   - Each widget stores zone + placement
 *   - Per-session: each session owns a WidgetGrid instance
 *   - Saves/loads layout to/from AutomationStore
 */

import { getWidgetDef, getAllWidgetDefs } from './widget-registry.js';
import { events } from '../core/events.js';

function uid() {
    return 'w_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

const ZONES = ['overlay', 'top', 'bottom', 'left', 'right'];

export class WidgetGrid {
    /**
     * @param {string} sessionId
     * @param {Object} zones - { overlay, top, bottom, left, right } DOM elements
     * @param {Function} sendFn - send command to MUD
     * @param {Function} getVarFn - get variable value
     */
    constructor(sessionId, zones, sendFn, getVarFn) {
        this.sessionId = sessionId;
        this.zones = zones;
        this._send = sendFn;
        this._getVar = getVarFn;

        this.widgets = new Map();
        this.gridCols = 12;
        this.gridRows = 8;
        this.editMode = false;
        this._dragState = null;
        this._resizeState = null;
        this._refreshInterval = null;
        this._pendingPlace = null;

        // Setup overlay as CSS Grid
        if (zones.overlay) {
            zones.overlay.classList.add('widget-grid-overlay');
            this._updateOverlayCSS();
        }

        // Event routing for text panels
        this._unsubRoute = events.on('widget:route', ({ sessionId: sid, panelName, text }) => {
            if (sid && sid !== this.sessionId) return;
            this._routeText(panelName, text);
        });

        // Periodic refresh for variable-bound widgets
        this._refreshInterval = setInterval(() => this._refreshAll(), 2000);
    }

    // ═══════════════════════════════════════════════════════════════
    // GRID CONFIG
    // ═══════════════════════════════════════════════════════════════

    setGridSize(cols, rows) {
        this.gridCols = cols;
        this.gridRows = rows;
        this._updateOverlayCSS();
        this.renderAll();
    }

    _updateOverlayCSS() {
        const el = this.zones.overlay;
        if (!el) return;
        el.style.display = 'grid';
        el.style.gridTemplateColumns = `repeat(${this.gridCols}, 1fr)`;
        el.style.gridTemplateRows = `repeat(${this.gridRows}, 1fr)`;
        el.style.gap = '2px';
    }

    _getZoneEl(zone) {
        return this.zones[zone] || this.zones.overlay;
    }

    // ═══════════════════════════════════════════════════════════════
    // WIDGET MANAGEMENT
    // ═══════════════════════════════════════════════════════════════

    addWidget(type, zone = 'overlay', placement = null, config = null) {
        const def = getWidgetDef(type);
        if (!def) { console.warn(`Unknown widget type: ${type}`); return null; }
        if (!ZONES.includes(zone)) zone = 'overlay';

        const id = uid();
        const p = zone === 'overlay'
            ? (placement || { col: 1, row: 1, colSpan: def.defaultSize.cols, rowSpan: def.defaultSize.rows })
            : (placement || { order: 0 });

        const widget = {
            id, type, zone,
            name: def.name,
            config: { ...def.defaultConfig, ...(config || {}) },
            placement: { ...p },
            enabled: true,
            _lines: null,
            _cdState: null
        };

        this.widgets.set(id, widget);
        this._createWidgetEl(widget);
        this._renderWidget(widget);
        return id;
    }

    removeWidget(id) {
        const w = this.widgets.get(id);
        if (!w) return;
        if (w._el) w._el.remove();
        this.widgets.delete(id);
    }

    updateWidgetConfig(id, updates) {
        const w = this.widgets.get(id);
        if (!w) return;
        Object.assign(w.config, updates);
        this._renderWidget(w);
    }

    // ═══════════════════════════════════════════════════════════════
    // RENDERING
    // ═══════════════════════════════════════════════════════════════

    _createWidgetEl(widget) {
        const el = document.createElement('div');
        el.className = `widget-cell widget-zone-${widget.zone}`;
        el.dataset.widgetId = widget.id;
        el.dataset.widgetType = widget.type;

        if (widget.zone === 'overlay') {
            this._applyOverlayPlacement(el, widget.placement);
        } else {
            el.style.order = widget.placement.order || 0;
        }

        const content = document.createElement('div');
        content.className = 'widget-content';
        el.appendChild(content);

        widget._el = el;
        widget._contentEl = content;

        const zoneEl = this._getZoneEl(widget.zone);
        if (zoneEl) zoneEl.appendChild(el);
    }

    _applyOverlayPlacement(el, p) {
        el.style.gridColumn = `${p.col} / span ${p.colSpan}`;
        el.style.gridRow = `${p.row} / span ${p.rowSpan}`;
    }

    _renderWidget(widget) {
        if (!widget._contentEl || !widget.enabled) return;
        const def = getWidgetDef(widget.type);
        if (!def?.render) return;

        try {
            def.render.call(def, widget, widget._contentEl, this._getVar, this._send);
        } catch (e) {
            widget._contentEl.innerHTML = `<div class="widget-error">Error: ${e.message}</div>`;
        }

        if (this.editMode) this._addEditChrome(widget);
    }

    renderAll() {
        for (const w of this.widgets.values()) {
            if (w._el && w.zone === 'overlay') {
                this._applyOverlayPlacement(w._el, w.placement);
            }
            this._renderWidget(w);
        }
    }

    _refreshAll() {
        const refreshTypes = ['gauge-bar', 'status-display', 'var-display', 'mini-map'];
        for (const w of this.widgets.values()) {
            if (refreshTypes.includes(w.type)) this._renderWidget(w);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // TEXT ROUTING
    // ═══════════════════════════════════════════════════════════════

    _routeText(panelName, text) {
        for (const w of this.widgets.values()) {
            if (w.type === 'text-panel' && w.config.panelName === panelName) {
                if (!w._lines) w._lines = [];
                w._lines.push({ text, time: Date.now() });
                const max = w.config.maxLines || 200;
                if (w._lines.length > max * 1.5) w._lines = w._lines.slice(-max);
                this._renderWidget(w);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // EDIT MODE
    // ═══════════════════════════════════════════════════════════════

    enterEditMode() {
        this.editMode = true;

        if (this.zones.overlay) {
            this.zones.overlay.classList.add('widget-grid-editing');
            this._addGridOverlay();
        }

        for (const zone of ['top', 'bottom', 'left', 'right']) {
            if (this.zones[zone]) this.zones[zone].classList.add('dock-zone-editing');
        }

        for (const w of this.widgets.values()) this._addEditChrome(w);
        this._addPaletteButton();
    }

    exitEditMode() {
        this.editMode = false;

        if (this.zones.overlay) this.zones.overlay.classList.remove('widget-grid-editing');

        for (const zone of ['top', 'bottom', 'left', 'right']) {
            if (this.zones[zone]) this.zones[zone].classList.remove('dock-zone-editing');
        }

        this.zones.overlay?.querySelector('.grid-overlay')?.remove();

        for (const zoneEl of Object.values(this.zones)) {
            if (!zoneEl) continue;
            zoneEl.querySelectorAll('.widget-edit-chrome, .widget-resize-handle').forEach(e => e.remove());
        }

        this.zones.overlay?.querySelector('.widget-palette-btn')?.remove();
        document.querySelector('.widget-palette-drawer')?.remove();
        this.renderAll();
    }

    _addGridOverlay() {
        const overlay = this.zones.overlay;
        if (!overlay) return;
        overlay.querySelector('.grid-overlay')?.remove();

        const grid = document.createElement('div');
        grid.className = 'grid-overlay';
        grid.style.cssText = `display:grid;grid-template-columns:repeat(${this.gridCols},1fr);grid-template-rows:repeat(${this.gridRows},1fr);position:absolute;inset:0;pointer-events:none;z-index:1;gap:2px`;

        for (let i = 0; i < this.gridCols * this.gridRows; i++) {
            const cell = document.createElement('div');
            cell.className = 'grid-overlay-cell';
            cell.style.pointerEvents = 'auto';
            cell.dataset.col = (i % this.gridCols) + 1;
            cell.dataset.row = Math.floor(i / this.gridCols) + 1;
            grid.appendChild(cell);
        }

        grid.addEventListener('click', (e) => {
            const cell = e.target.closest('.grid-overlay-cell');
            if (!cell || !this._pendingPlace) return;
            const col = parseInt(cell.dataset.col);
            const row = parseInt(cell.dataset.row);
            const def = getWidgetDef(this._pendingPlace);
            if (def) {
                this.addWidget(this._pendingPlace, 'overlay', {
                    col, row,
                    colSpan: def.defaultSize.cols,
                    rowSpan: def.defaultSize.rows
                });
            }
            this._pendingPlace = null;
            grid.classList.remove('grid-overlay-placing');
            this._closePalette();
        });

        overlay.appendChild(grid);
    }

    _addEditChrome(widget) {
        if (!widget._el) return;
        widget._el.querySelectorAll('.widget-edit-chrome, .widget-resize-handle').forEach(e => e.remove());

        const def = getWidgetDef(widget.type);
        const chrome = document.createElement('div');
        chrome.className = 'widget-edit-chrome';
        chrome.innerHTML = `
            <span class="wec-drag" title="Drag to move">≡</span>
            <span class="wec-name">${def?.icon || ''} ${widget.name}</span>
            <button class="wec-btn wec-config" title="Configure">⚙</button>
            <button class="wec-btn wec-delete" title="Remove">×</button>`;
        widget._el.appendChild(chrome);

        if (widget.zone === 'overlay') {
            const dragHandle = chrome.querySelector('.wec-drag');
            dragHandle.addEventListener('mousedown', (e) => this._startDrag(e, widget));
            dragHandle.addEventListener('touchstart', (e) => this._startDrag(e, widget), { passive: false });
        }

        chrome.querySelector('.wec-config').onclick = () => this._showWidgetConfig(widget);
        chrome.querySelector('.wec-delete').onclick = () => {
            if (confirm(`Remove ${widget.name}?`)) this.removeWidget(widget.id);
        };

        if (widget.zone === 'overlay') {
            const resize = document.createElement('div');
            resize.className = 'widget-resize-handle';
            resize.addEventListener('mousedown', (e) => this._startResize(e, widget));
            resize.addEventListener('touchstart', (e) => this._startResize(e, widget), { passive: false });
            widget._el.appendChild(resize);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // DRAG TO MOVE (overlay only)
    // ═══════════════════════════════════════════════════════════════

    _startDrag(e, widget) {
        e.preventDefault();
        const overlayEl = this.zones.overlay;
        if (!overlayEl) return;
        const rect = overlayEl.getBoundingClientRect();
        const cellW = rect.width / this.gridCols;
        const cellH = rect.height / this.gridRows;
        const pt = e.touches ? e.touches[0] : e;

        this._dragState = { widget, startX: pt.clientX, startY: pt.clientY, origCol: widget.placement.col, origRow: widget.placement.row, cellW, cellH };
        widget._el.classList.add('widget-dragging');

        const move = (ev) => {
            const p = ev.touches ? ev.touches[0] : ev;
            const dc = Math.round((p.clientX - this._dragState.startX) / cellW);
            const dr = Math.round((p.clientY - this._dragState.startY) / cellH);
            widget.placement.col = Math.max(1, Math.min(this.gridCols - widget.placement.colSpan + 1, this._dragState.origCol + dc));
            widget.placement.row = Math.max(1, Math.min(this.gridRows - widget.placement.rowSpan + 1, this._dragState.origRow + dr));
            this._applyOverlayPlacement(widget._el, widget.placement);
        };

        const end = () => {
            widget._el.classList.remove('widget-dragging');
            this._dragState = null;
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', end);
            document.removeEventListener('touchmove', move);
            document.removeEventListener('touchend', end);
        };

        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', end);
        document.addEventListener('touchmove', move, { passive: false });
        document.addEventListener('touchend', end);
    }

    // ═══════════════════════════════════════════════════════════════
    // RESIZE (overlay only)
    // ═══════════════════════════════════════════════════════════════

    _startResize(e, widget) {
        e.preventDefault();
        e.stopPropagation();
        const overlayEl = this.zones.overlay;
        if (!overlayEl) return;
        const rect = overlayEl.getBoundingClientRect();
        const cellW = rect.width / this.gridCols;
        const cellH = rect.height / this.gridRows;
        const pt = e.touches ? e.touches[0] : e;
        const def = getWidgetDef(widget.type);

        this._resizeState = {
            widget, startX: pt.clientX, startY: pt.clientY,
            origColSpan: widget.placement.colSpan, origRowSpan: widget.placement.rowSpan,
            minCols: def?.minSize?.cols || 1, minRows: def?.minSize?.rows || 1,
            cellW, cellH
        };
        widget._el.classList.add('widget-resizing');

        const move = (ev) => {
            const p = ev.touches ? ev.touches[0] : ev;
            const dcs = Math.round((p.clientX - this._resizeState.startX) / cellW);
            const drs = Math.round((p.clientY - this._resizeState.startY) / cellH);
            widget.placement.colSpan = Math.max(this._resizeState.minCols, Math.min(this.gridCols - widget.placement.col + 1, this._resizeState.origColSpan + dcs));
            widget.placement.rowSpan = Math.max(this._resizeState.minRows, Math.min(this.gridRows - widget.placement.row + 1, this._resizeState.origRowSpan + drs));
            this._applyOverlayPlacement(widget._el, widget.placement);
        };

        const end = () => {
            widget._el.classList.remove('widget-resizing');
            this._resizeState = null;
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', end);
            document.removeEventListener('touchmove', move);
            document.removeEventListener('touchend', end);
            this._renderWidget(widget);
        };

        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', end);
        document.addEventListener('touchmove', move, { passive: false });
        document.addEventListener('touchend', end);
    }

    // ═══════════════════════════════════════════════════════════════
    // WIDGET PALETTE
    // ═══════════════════════════════════════════════════════════════

    _addPaletteButton() {
        const overlay = this.zones.overlay;
        if (!overlay) return;
        overlay.querySelector('.widget-palette-btn')?.remove();
        const btn = document.createElement('button');
        btn.className = 'widget-palette-btn';
        btn.innerHTML = '+ Add Widget';
        btn.onclick = () => this._togglePalette();
        overlay.appendChild(btn);
    }

    _togglePalette() {
        if (document.querySelector('.widget-palette-drawer')) { this._closePalette(); return; }

        const drawer = document.createElement('div');
        drawer.className = 'widget-palette-drawer';

        const header = document.createElement('div');
        header.className = 'palette-header';
        header.innerHTML = '<span>Widget Palette</span><button class="palette-close">×</button>';
        header.querySelector('.palette-close').onclick = () => this._closePalette();
        drawer.appendChild(header);

        // Zone selector
        const zoneSel = document.createElement('div');
        zoneSel.className = 'palette-zone-select';
        zoneSel.innerHTML = `<label>Place in:</label><select class="palette-zone-dropdown">
            <option value="overlay">Overlay (on terminal)</option>
            <option value="top">Dock Top</option>
            <option value="bottom" selected>Dock Bottom</option>
            <option value="left">Dock Left</option>
            <option value="right">Dock Right</option></select>`;
        drawer.appendChild(zoneSel);
        const zoneDropdown = zoneSel.querySelector('select');

        const list = document.createElement('div');
        list.className = 'palette-list';

        for (const def of getAllWidgetDefs()) {
            const item = document.createElement('div');
            item.className = 'palette-item';
            item.innerHTML = `<span class="palette-icon">${def.icon}</span><div class="palette-info"><div class="palette-name">${def.name}</div><div class="palette-desc">${def.description}</div></div>`;
            item.onclick = () => {
                const zone = zoneDropdown.value;
                if (zone === 'overlay') {
                    this._pendingPlace = def.type;
                    const gridOvl = this.zones.overlay?.querySelector('.grid-overlay');
                    if (gridOvl) gridOvl.classList.add('grid-overlay-placing');
                    drawer.classList.add('palette-placing');
                    const status = drawer.querySelector('.palette-status');
                    if (status) status.textContent = `Click a grid cell to place ${def.name}`;
                } else {
                    this.addWidget(def.type, zone, { order: this._nextDockOrder(zone) });
                    this._closePalette();
                }
            };
            list.appendChild(item);
        }
        drawer.appendChild(list);

        const status = document.createElement('div');
        status.className = 'palette-status';
        status.textContent = 'Select a widget type';
        drawer.appendChild(status);

        document.body.appendChild(drawer);
    }

    _closePalette() {
        this._pendingPlace = null;
        const gridOvl = this.zones.overlay?.querySelector('.grid-overlay');
        if (gridOvl) gridOvl.classList.remove('grid-overlay-placing');
        document.querySelector('.widget-palette-drawer')?.remove();
    }

    _nextDockOrder(zone) {
        let max = 0;
        for (const w of this.widgets.values()) {
            if (w.zone === zone && (w.placement.order || 0) >= max) max = (w.placement.order || 0) + 1;
        }
        return max;
    }

    // ═══════════════════════════════════════════════════════════════
    // WIDGET CONFIG DIALOG
    // ═══════════════════════════════════════════════════════════════

    _showWidgetConfig(widget) {
        const def = getWidgetDef(widget.type);
        if (!def) return;
        document.querySelector('.widget-config-overlay')?.remove();

        const overlay = document.createElement('div');
        overlay.className = 'widget-config-overlay';
        const dialog = document.createElement('div');
        dialog.className = 'widget-config-dialog';

        const zoneOptions = ZONES.map(z =>
            `<option value="${z}" ${widget.zone === z ? 'selected' : ''}>${z === 'overlay' ? 'Overlay (on terminal)' : 'Dock ' + z.charAt(0).toUpperCase() + z.slice(1)}</option>`
        ).join('');

        dialog.innerHTML = `
            <div class="wcd-header"><h3>${def.icon} Configure ${def.name}</h3><button class="wcd-close">×</button></div>
            <div class="wcd-body">
                <div class="wcd-field"><label>Widget Name</label><input type="text" name="_name" value="${widget.name || def.name}"></div>
                <div class="wcd-field"><label>Zone</label><select name="_zone">${zoneOptions}</select></div>
                ${def.configFields.map(f => this._renderConfigField(f, widget.config)).join('')}
            </div>
            <div class="wcd-footer"><button class="wcd-btn wcd-cancel">Cancel</button><button class="wcd-btn wcd-save">Save</button></div>`;

        dialog.querySelector('.wcd-close').onclick = () => overlay.remove();
        dialog.querySelector('.wcd-cancel').onclick = () => overlay.remove();
        dialog.querySelector('.wcd-save').onclick = () => {
            widget.name = dialog.querySelector('[name="_name"]').value || def.name;
            const newZone = dialog.querySelector('[name="_zone"]').value;

            if (newZone !== widget.zone && ZONES.includes(newZone)) {
                if (widget._el) widget._el.remove();
                widget.zone = newZone;
                if (newZone === 'overlay') {
                    widget.placement = { col: 1, row: 1, colSpan: def.defaultSize.cols, rowSpan: def.defaultSize.rows };
                } else {
                    widget.placement = { order: this._nextDockOrder(newZone) };
                }
                this._createWidgetEl(widget);
            }

            for (const f of def.configFields) {
                const input = dialog.querySelector(`[name="${f.name}"]`);
                if (!input) continue;
                if (f.type === 'checkbox') widget.config[f.name] = input.checked;
                else if (f.type === 'number') widget.config[f.name] = parseFloat(input.value) || 0;
                else widget.config[f.name] = input.value;
            }
            this._renderWidget(widget);
            overlay.remove();
        };

        overlay.appendChild(dialog);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        document.body.appendChild(overlay);
    }

    _renderConfigField(field, config) {
        const val = config[field.name];
        switch (field.type) {
            case 'text':
                return `<div class="wcd-field"><label>${field.label}</label><input type="text" name="${field.name}" value="${val || ''}"></div>`;
            case 'number':
                return `<div class="wcd-field"><label>${field.label}</label><input type="number" name="${field.name}" value="${val || 0}" min="${field.min||0}" max="${field.max||9999}"></div>`;
            case 'checkbox':
                return `<div class="wcd-field wcd-check"><label><input type="checkbox" name="${field.name}" ${val ? 'checked' : ''}> ${field.label}</label></div>`;
            case 'select':
                return `<div class="wcd-field"><label>${field.label}</label><select name="${field.name}">${(field.options||[]).map(o =>
                    `<option value="${o}" ${val===o?'selected':''}>${o}</option>`).join('')}</select></div>`;
            case 'color':
                return `<div class="wcd-field"><label>${field.label}</label><input type="color" name="${field.name}" value="${val || '#ffffff'}"></div>`;
            default: return '';
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // LAYOUT PRESETS
    // ═══════════════════════════════════════════════════════════════

    applyPreset(presetName) {
        for (const id of [...this.widgets.keys()]) this.removeWidget(id);

        const presets = {
            combat: [
                { type: 'gauge-bar', zone: 'overlay', placement: { col: 1, row: 1, colSpan: 8, rowSpan: 1 } },
                { type: 'text-panel', zone: 'overlay', placement: { col: 9, row: 1, colSpan: 4, rowSpan: 5 }, config: { panelName: 'combat_log', tabs: [{ name: 'Combat', filter: '' }] } },
                { type: 'hotbar', zone: 'bottom' },
                { type: 'compass', zone: 'right' },
                { type: 'cooldown-btn', zone: 'bottom', config: { label: 'Heal', icon: '💚', command: 'cast heal', cooldownMs: 5000, color: '#2ecc71' } },
                { type: 'cooldown-btn', zone: 'bottom', config: { label: 'Bash', icon: '🛡', command: 'bash', cooldownMs: 8000, color: '#e67e22' } }
            ],
            social: [
                { type: 'gauge-bar', zone: 'overlay', placement: { col: 1, row: 1, colSpan: 6, rowSpan: 1 } },
                { type: 'text-panel', zone: 'overlay', placement: { col: 7, row: 1, colSpan: 6, rowSpan: 6 }, config: { panelName: 'chat', tabs: [{ name: 'All', filter: '' }, { name: 'Tells', filter: 'tell' }, { name: 'OOC', filter: 'ooc' }] } },
                { type: 'hotbar', zone: 'bottom' }
            ],
            exploration: [
                { type: 'gauge-bar', zone: 'overlay', placement: { col: 1, row: 1, colSpan: 6, rowSpan: 1 } },
                { type: 'mini-map', zone: 'right' },
                { type: 'compass', zone: 'right' },
                { type: 'hotbar', zone: 'bottom' },
                { type: 'status-display', zone: 'overlay', placement: { col: 7, row: 1, colSpan: 3, rowSpan: 1 } }
            ],
            minimal: [
                { type: 'gauge-bar', zone: 'top', config: { orientation: 'horizontal', showPercent: true, showNumbers: false } }
            ]
        };

        const preset = presets[presetName];
        if (!preset) return;

        for (const w of preset) {
            const zone = w.zone || 'overlay';
            const placement = w.placement || (zone === 'overlay' ? undefined : { order: this._nextDockOrder(zone) });
            this.addWidget(w.type, zone, placement, w.config);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // SAVE / LOAD
    // ═══════════════════════════════════════════════════════════════

    exportLayout() {
        return [...this.widgets.values()].map(w => ({
            id: w.id, type: w.type, name: w.name, zone: w.zone,
            config: JSON.parse(JSON.stringify(w.config)),
            placement: { ...w.placement },
            enabled: w.enabled
        }));
    }

    loadLayout(widgetDataArray) {
        for (const id of [...this.widgets.keys()]) this.removeWidget(id);
        if (!widgetDataArray || !Array.isArray(widgetDataArray)) return;

        for (const data of widgetDataArray) {
            const zone = data.zone || 'overlay';
            const id = this.addWidget(data.type, zone, data.placement, data.config);
            if (id && data.name) {
                const w = this.widgets.get(id);
                if (w) w.name = data.name;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // CLEANUP
    // ═══════════════════════════════════════════════════════════════

    destroy() {
        if (this._refreshInterval) clearInterval(this._refreshInterval);
        if (typeof this._unsubRoute === 'function') this._unsubRoute();
        for (const w of this.widgets.values()) { if (w._el) w._el.remove(); }
        this.widgets.clear();
        if (this.zones.overlay) {
            this.zones.overlay.classList.remove('widget-grid-overlay', 'widget-grid-editing');
            this.zones.overlay.style.display = '';
            this.zones.overlay.style.gridTemplateColumns = '';
            this.zones.overlay.style.gridTemplateRows = '';
        }
    }
}

export default WidgetGrid;
