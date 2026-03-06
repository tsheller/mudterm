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

function render(session) {
    _session = session || null;
    renderAliases();
    wireButtons();
}

function clear() {
    _session = null;
    const list = document.getElementById('aliases-list');
    if (list) list.innerHTML = '<div class="auto-empty">No active session</div>';
}

function renderAliases() {
    const list = document.getElementById('aliases-list');
    if (!list) return;
    if (!_session?.automation) {
        list.innerHTML = '<div class="auto-empty">No active session</div>';
        return;
    }
    const aliases = [..._session.automation.aliases.aliases.values()];
    if (!aliases.length) {
        list.innerHTML = '<div class="auto-empty">No aliases yet.</div>';
        return;
    }
    list.innerHTML = '';
    for (const a of aliases) {
        const row = document.createElement('div');
        row.className = 'auto-item' + (a.enabled ? '' : ' auto-item-disabled');
        row.innerHTML = `
            <button class="auto-toggle">${a.enabled ? '●' : '○'}</button>
            <div class="auto-item-info">
                <span class="auto-item-name">${esc(a.name || a.pattern)}</span>
                <span class="auto-item-sub">${esc(a.pattern)} → ${esc(a.replacement)}</span>
            </div>
            <div class="auto-item-btns">
                <button class="auto-edit-btn">✎</button>
                <button class="auto-del-btn">✕</button>
            </div>`;
        row.querySelector('.auto-toggle').onclick = () => {
            _session.automation.aliases.setEnabled(a.id, !a.enabled);
            _session.automation.save();
            renderAliases();
        };
        row.querySelector('.auto-edit-btn').onclick = () => showAliasForm(a);
        row.querySelector('.auto-del-btn').onclick = () => {
            _session.automation.aliases.unregisterAlias(a.id);
            _session.automation.save();
            renderAliases();
        };
        list.appendChild(row);
    }
}

function showAliasForm(existing) {
    const list = document.getElementById('aliases-list');
    if (!list) return;
    list.querySelector('.auto-form')?.remove();
    const form = document.createElement('div');
    form.className = 'auto-form';
    form.innerHTML = `
        <div class="auto-form-title">${existing ? 'Edit Alias' : 'New Alias'}</div>
        <div class="auto-form-row">
            <input class="auto-input" name="name" placeholder="Name (optional)" value="${esc(existing?.name || '')}">
        </div>
        <div class="auto-form-row">
            <input class="auto-input" name="pattern" placeholder="Pattern (e.g. n)" value="${esc(existing?.pattern || '')}">
        </div>
        <div class="auto-form-row">
            <input class="auto-input" name="replacement" placeholder="Send instead (e.g. go north)" value="${esc(existing?.replacement || '')}">
        </div>
        <div class="auto-form-checks">
            <label class="auto-check"><input type="checkbox" name="isRegex" ${existing?.isRegex ? 'checked' : ''}> Regex</label>
            <label class="auto-check"><input type="checkbox" name="enabled" ${!existing || existing.enabled ? 'checked' : ''}> Enabled</label>
        </div>
        <div class="auto-form-btns">
            <button class="auto-save-btn">Save</button>
            <button class="auto-cancel-btn">Cancel</button>
        </div>`;
    form.querySelector('.auto-cancel-btn').onclick = () => form.remove();
    form.querySelector('.auto-save-btn').onclick = () => {
        const pattern = form.querySelector('[name=pattern]').value.trim();
        if (!pattern) { form.querySelector('[name=pattern]').focus(); return; }
        const data = {
            id: existing?.id || makeId(),
            name: form.querySelector('[name=name]').value.trim(),
            pattern,
            replacement: form.querySelector('[name=replacement]').value,
            isRegex: form.querySelector('[name=isRegex]').checked,
            enabled: form.querySelector('[name=enabled]').checked,
            group: existing?.group || 'default',
            priority: existing?.priority || 0,
            _source: 'manual',
        };
        if (existing) _session.automation.aliases.unregisterAlias(existing.id);
        _session.automation.aliases.registerAlias(data);
        _session.automation.save();
        form.remove();
        renderAliases();
    };
    list.insertBefore(form, list.firstChild);
    form.querySelector('[name=pattern]').focus();
}

function wireButtons() {
    const btn = document.getElementById('btn-add-alias');
    if (!btn) return;
    const fresh = btn.cloneNode(true);
    btn.replaceWith(fresh);
    fresh.onclick = () => showAliasForm(null);
}

// Expose on window so HTML onclick can reach it regardless of module wiring
window.__showAliasForm = () => showAliasForm(null);

export const automationPanel = { render, clear };
