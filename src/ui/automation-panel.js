console.log('[AutoPanel] FILE EXECUTING - TOP OF MODULE');
/**
 * src/ui/automation-panel.js
 */

function esc(str) {
    return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function makeId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

let _session = null;

function getAuto() {
    const auto = _session?.automation || null;
    console.log('[AutoPanel] getAuto:', auto ? 'found automation' : 'NO AUTOMATION', '_session:', _session ? _session.id : 'null');
    return auto;
}

function openModal(id) {
    console.log('[AutoPanel] openModal:', id);
    const el = document.getElementById('modal-' + id);
    console.log('[AutoPanel] modal element:', el ? 'found' : 'NOT FOUND - id=modal-' + id);
    el?.classList.add('active');
}

function closeModal(id) {
    console.log('[AutoPanel] closeModal:', id);
    document.getElementById('modal-' + id)?.classList.remove('active');
}

function renderList(listId, items, type) {
    console.log('[AutoPanel] renderList:', listId, 'items:', items ? items.length : 'null');
    const el = document.getElementById(listId);
    if (!el) { console.error('[AutoPanel] renderList: element NOT FOUND:', listId); return; }
    if (!items || !items.length) {
        el.innerHTML = '<div class="auto-empty">No ' + type + ' defined.</div>';
        return;
    }
    el.innerHTML = items.map(function(item) {
        let label = '', sub = '';
        if (type === 'aliases') {
            label = item.name || item.pattern || '(unnamed)';
            sub = item.pattern ? item.pattern + ' → ' + (item.replacement || item.action || '') : '';
        } else if (type === 'triggers') {
            label = item.name || item.pattern || '(unnamed)';
            sub = item.pattern || '';
        } else {
            label = item.name || '(unnamed)';
            sub = 'every ' + (item.interval || '?') + 's';
        }
        const on = item.enabled !== false;
        return '<div class="automation-item' + (on ? '' : ' disabled') + '" data-id="' + item.id + '" data-type="' + type + '">' +
            '<div class="item-toggle"><input type="checkbox"' + (on ? ' checked' : '') + ' data-toggle data-id="' + item.id + '" data-type="' + type + '"></div>' +
            '<div class="item-content"><div class="item-main"><span class="item-pattern">' + esc(label) + '</span></div>' +
            (sub ? '<div class="item-stats">' + esc(sub) + '</div>' : '') + '</div>' +
            '<button class="item-actions btn-icon" data-action="delete" data-id="' + item.id + '" data-type="' + type + '" title="Delete">✕</button>' +
        '</div>';
    }).join('');
    console.log('[AutoPanel] renderList done:', listId);
}

function refreshPanel() {
    console.log('[AutoPanel] refreshPanel called');
    const auto = getAuto();
    if (!auto) {
        console.warn('[AutoPanel] refreshPanel: no automation, clearing lists');
        ['aliases-list','triggers-list','timers-list'].forEach(function(id) {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '<div class="auto-empty">No active session.</div>';
            else console.error('[AutoPanel] refreshPanel: list element NOT FOUND:', id);
        });
        return;
    }
    const d = auto._storedData || { aliases: [], triggers: [], timers: [] };
    console.log('[AutoPanel] refreshPanel: _storedData aliases:', d.aliases?.length, 'triggers:', d.triggers?.length, 'timers:', d.timers?.length);
    renderList('aliases-list',  d.aliases,  'aliases');
    renderList('triggers-list', d.triggers, 'triggers');
    renderList('timers-list',   d.timers,   'timers');
    console.log('[AutoPanel] refreshPanel done');
}

function on(id, fn) {
    const el = document.getElementById(id);
    if (!el) { console.warn('[AutoPanel] on(): element NOT FOUND:', id); return; }
    const n = el.cloneNode(true);
    el.replaceWith(n);
    n.onclick = fn;
    console.log('[AutoPanel] wired:', id);
}

function wireAll() {
    console.log('[AutoPanel] wireAll called');
    on('btn-add-alias',      function() { console.log('[AutoPanel] btn-add-alias clicked'); openModal('add-alias'); });
    on('btn-add-trigger',    function() { console.log('[AutoPanel] btn-add-trigger clicked'); openModal('add-trigger'); });
    on('btn-add-timer',      function() { console.log('[AutoPanel] btn-add-timer clicked'); openModal('add-timer'); });
    on('cancel-add-alias',   function() { console.log('[AutoPanel] cancel-add-alias clicked'); closeModal('add-alias'); });
    on('cancel-add-trigger', function() { console.log('[AutoPanel] cancel-add-trigger clicked'); closeModal('add-trigger'); });
    on('cancel-add-timer',   function() { console.log('[AutoPanel] cancel-add-timer clicked'); closeModal('add-timer'); });

    on('save-alias', function() {
        console.log('[AutoPanel] save-alias clicked');
        const auto = getAuto();
        if (!auto) { console.error('[AutoPanel] save-alias: no active session'); return; }
        const pattern = (document.getElementById('alias-pattern')?.value || '').trim();
        if (!pattern) { console.warn('[AutoPanel] save-alias: no pattern'); return; }
        const item = {
            id: makeId(),
            name: (document.getElementById('alias-name')?.value || '').trim() || pattern,
            pattern,
            replacement: (document.getElementById('alias-command')?.value || '').trim(),
            action: (document.getElementById('alias-command')?.value || '').trim(),
            actionType: 'send', isRegex: false, enabled: true, group: 'default', priority: 0, _source: 'manual'
        };
        console.log('[AutoPanel] save-alias: saving item:', item);
        if (!auto._storedData.aliases) auto._storedData.aliases = [];
        auto._storedData.aliases.push(item);
        auto.aliases?.registerAlias?.(item);
        auto.save?.();
        closeModal('add-alias');
        ['alias-name','alias-pattern','alias-command'].forEach(function(fid) { const e = document.getElementById(fid); if (e) e.value = ''; });
        refreshPanel();
    });

    on('save-trigger', function() {
        console.log('[AutoPanel] save-trigger clicked');
        const auto = getAuto();
        if (!auto) { console.error('[AutoPanel] save-trigger: no active session'); return; }
        const pattern = (document.getElementById('trigger-pattern')?.value || '').trim();
        if (!pattern) { console.warn('[AutoPanel] save-trigger: no pattern'); return; }
        const item = {
            id: makeId(),
            name: (document.getElementById('trigger-name')?.value || '').trim() || pattern,
            pattern,
            action: (document.getElementById('trigger-action')?.value || '').trim(),
            actionType: 'send', isRegex: true, enabled: true, group: 'default', priority: 0, _source: 'manual'
        };
        console.log('[AutoPanel] save-trigger: saving item:', item);
        if (!auto._storedData.triggers) auto._storedData.triggers = [];
        auto._storedData.triggers.push(item);
        auto.triggers?.registerTrigger?.(item);
        auto.save?.();
        closeModal('add-trigger');
        ['trigger-name','trigger-pattern','trigger-action'].forEach(function(fid) { const e = document.getElementById(fid); if (e) e.value = ''; });
        refreshPanel();
    });

    on('save-timer', function() {
        console.log('[AutoPanel] save-timer clicked');
        const auto = getAuto();
        if (!auto) { console.error('[AutoPanel] save-timer: no active session'); return; }
        const interval = parseFloat(document.getElementById('timer-interval')?.value) || 0;
        if (!interval) { console.warn('[AutoPanel] save-timer: no interval'); return; }
        const item = {
            id: makeId(),
            name: (document.getElementById('timer-name')?.value || '').trim() || (interval + 's timer'),
            interval,
            action: (document.getElementById('timer-command')?.value || '').trim(),
            actionType: 'send', enabled: true, group: 'default', oneShot: false, _source: 'manual'
        };
        console.log('[AutoPanel] save-timer: saving item:', item);
        if (!auto._storedData.timers) auto._storedData.timers = [];
        auto._storedData.timers.push(item);
        auto.timers?.registerTimer?.(item);
        auto.save?.();
        closeModal('add-timer');
        ['timer-name','timer-interval','timer-command'].forEach(function(fid) { const e = document.getElementById(fid); if (e) e.value = ''; });
        refreshPanel();
    });

    ['aliases-list','triggers-list','timers-list'].forEach(function(listId) {
        const el = document.getElementById(listId);
        if (!el) { console.warn('[AutoPanel] wireAll: list NOT FOUND:', listId); return; }
        el.onclick = function(e) {
            const btn = e.target.closest('[data-action="delete"]');
            if (!btn) return;
            console.log('[AutoPanel] delete clicked:', btn.dataset.type, btn.dataset.id);
            const auto = getAuto();
            if (!auto) return;
            const id = btn.dataset.id, type = btn.dataset.type;
            if (auto._storedData?.[type]) auto._storedData[type] = auto._storedData[type].filter(i => i.id !== id);
            if (type === 'aliases')  auto.aliases?.unregisterAlias?.(id);
            if (type === 'triggers') auto.triggers?.unregisterTrigger?.(id);
            if (type === 'timers')   auto.timers?.removeTimer?.(id);
            auto.save?.();
            refreshPanel();
        };
        el.onchange = function(e) {
            if (e.target.dataset.toggle === undefined) return;
            console.log('[AutoPanel] toggle changed:', e.target.dataset.type, e.target.dataset.id, e.target.checked);
            const auto = getAuto();
            if (!auto) return;
            const id = e.target.dataset.id, type = e.target.dataset.type, enabled = e.target.checked;
            const item = auto._storedData?.[type]?.find(i => i.id === id);
            if (item) item.enabled = enabled;
            if (type === 'aliases')  auto.aliases?.setEnabled?.(id, enabled);
            if (type === 'triggers') auto.triggers?.setEnabled?.(id, enabled);
            if (type === 'timers')   auto.timers?.setEnabled?.(id, enabled);
            auto.save?.();
            refreshPanel();
        };
        console.log('[AutoPanel] wired list:', listId);
    });
    console.log('[AutoPanel] wireAll done');
}

function render(session) {
    console.log('[AutoPanel] render called, session:', session ? session.id : 'null');
    _session = session || null;
    wireAll();
    refreshPanel();
    console.log('[AutoPanel] render done');
}

function clear() {
    console.log('[AutoPanel] clear called');
    _session = null;
    ['aliases-list','triggers-list','timers-list'].forEach(function(id) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '<div class="auto-empty">No active session</div>';
    });
}

export const automationPanel = { render, clear, refresh: refreshPanel };
window.automationPanel = automationPanel;
console.log('[AutoPanel] module loaded, window.automationPanel set');

document.addEventListener('click', function(e) {
    if (e.target.closest('#btn-auto')) {
        console.log('[AutoPanel] btn-auto clicked - _session:', _session ? _session.id : 'null');
        console.log('[AutoPanel] automation:', _session?.automation ? 'exists' : 'MISSING');
        console.log('[AutoPanel] _storedData:', _session?.automation?._storedData);
    }
});
