// =============================================================================
// Lab — views/options.js
// Screen 4 — Decision Option Set Review
//
// Proposes 4-6 response options the expert will choose between during the
// 30-scenario session (Screen 5). One classify() call on entry if the set
// doesn't already exist; the expert can edit, add, or remove options before
// locking the set.
// =============================================================================

import { classify }            from '../../engine/ai.js';
import { extractJSON }         from '../../engine/utils.js';
import { saveDecisionOptions } from '../db.js';

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 8;

let _options = []; // [{ id, label, description, _removed, _editing }]

export async function render(el, session, next) {
    if (session.decisionOptions && session.decisionOptions.length > 0) {
        _options = session.decisionOptions.map(o => ({ ...o, _removed: false, _editing: false }));
        _draw(el, session, next);
        return;
    }

    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(4)}</div>
  <h1 class="lab-h1">Confirm your decision options</h1>
  <div class="lab-thinking">
    <div class="lab-dots"><div class="lab-dot"></div><div class="lab-dot"></div><div class="lab-dot"></div></div>
    Drafting the response options you'll choose between…
  </div>
</div>`;

    const p = session.profile ?? {};
    const cueSummary = (session.cueLibrary ?? []).map(c => `${c.name} (${c.definition})`).join('; ');

    const systemPrompt = `You are proposing the set of response options a professional will choose between when facing decisions in their field.
These are not yes/no on a single cue — they are the actual range of actions or judgements this person makes day to day.

Return a JSON array only — no markdown fences, no other text — of 4 to 6 objects, each with exactly these fields:
{ "label": "Short option name, 2-5 words", "description": "One sentence describing what choosing this option means in practice" }
The options should be mutually distinct and together cover the realistic range of responses, from most cautious to most assertive where that applies.`;

    const prompt = `Area of expertise: ${p.role}
What their work involves: ${p.whatYouDo}
Kinds of decisions: ${p.decisionTypes}
${cueSummary ? `Cues that drive their decisions: ${cueSummary}` : ''}

Return a JSON array of 4-6 proposed decision options.`;

    const result = await classify(prompt, systemPrompt);
    const parsed = result.ok ? extractJSON(result.text) : null;

    if (!parsed || !Array.isArray(parsed) || parsed.length === 0) {
        el.querySelector('.lab-wrap').innerHTML += `
<div class="lab-notice lab-err">Couldn't generate decision options. Check your connection and try again.</div>
<button class="btn btn-primary" id="retry-opts">Retry</button>`;
        el.querySelector('#retry-opts').addEventListener('click', () => render(el, session, next));
        return;
    }

    _options = parsed.slice(0, MAX_OPTIONS).map((o, i) => ({
        id:          `opt-${Date.now()}-${i}`,
        label:       o.label ?? `Option ${i + 1}`,
        description: o.description ?? '',
        _removed:    false,
        _editing:    false,
    }));

    _draw(el, session, next);
}

function _draw(el, session, next) {
    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(4)}</div>
  <h1 class="lab-h1">Confirm your decision options</h1>
  <p class="lab-sub">
    These are the choices you'll select between during the scenario session.
    Edit anything that doesn't sound like a real option in your field.
  </p>

  <div id="opts-err" class="lab-notice lab-err" style="display:none"></div>

  <div class="lab-explain-card">
    <p>
      Decision options are the actual choices you make — not the factors you
      consider when deciding (those are your cues), but the actions you take
      as a result. In the scenario session coming up, you'll be shown 30 situations
      and asked to pick one of these options for each.
    </p>
    <p>
      It's important they represent the real range of decisions you make at the
      right level of specificity — broad enough to apply across different
      situations, specific enough that each one means something distinct.
    </p>
    <div class="lab-explain-actions">
      <div class="lab-explain-action"><strong>Edit</strong><span>The option is real but the label or description doesn't match how you'd describe it</span></div>
      <div class="lab-explain-action"><strong>Remove</strong><span>This isn't a real choice you face in your work</span></div>
      <div class="lab-explain-action"><strong>Add</strong><span>A genuine option that's missing from this list</span></div>
    </div>
  </div>

  <div class="lab-card">
    <div id="opts-list">
      ${_options.map(o => _rowHTML(o)).join('')}
    </div>
    ${_options.filter(o => !o._removed).length < MAX_OPTIONS
      ? `<button type="button" class="lab-add-btn" id="add-opt">+ Add another option</button>`
      : ''}
  </div>

  <div class="lab-btn-row">
    <button type="button" class="btn btn-primary" id="opts-confirm">Confirm options</button>
  </div>
</div>`;

    el.querySelectorAll('.opt-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const o = _options.find(o => o.id === btn.dataset.id);
            if (o) o._editing = !o._editing;
            _draw(el, session, next);
        });
    });

    el.querySelectorAll('.opt-remove-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const remaining = _options.filter(o => !o._removed).length;
            const o = _options.find(o => o.id === btn.dataset.id);
            if (!o) return;
            if (!o._removed && remaining <= MIN_OPTIONS) return; // keep a minimum
            o._removed = !o._removed;
            _draw(el, session, next);
        });
    });

    el.querySelectorAll('.opt-save-edit').forEach(btn => {
        btn.addEventListener('click', () => {
            const o = _options.find(o => o.id === btn.dataset.id);
            if (!o) return;
            const row = el.querySelector(`[data-row-id="${o.id}"]`);
            o.label       = row.querySelector('.edit-label').value.trim()       || o.label;
            o.description = row.querySelector('.edit-opt-def').value.trim()    || o.description;
            o._editing    = false;
            _draw(el, session, next);
        });
    });

    const addBtn = el.querySelector('#add-opt');
    if (addBtn) {
        addBtn.addEventListener('click', () => {
            _options.push({
                id: `opt-${Date.now()}`,
                label: '',
                description: '',
                _removed: false,
                _editing: true,
            });
            _draw(el, session, next);
        });
    }

    el.querySelector('#opts-confirm').addEventListener('click', async () => {
        const final = _options.filter(o => !o._removed && o.label.trim())
            .map(({ _removed, _editing, ...o }) => o);

        const errEl = el.querySelector('#opts-err');
        if (final.length < MIN_OPTIONS) {
            errEl.textContent   = `You need at least ${MIN_OPTIONS} options to continue.`;
            errEl.style.display = '';
            return;
        }
        errEl.style.display = 'none';

        const btn = el.querySelector('#opts-confirm');
        btn.disabled    = true;
        btn.textContent = 'Saving…';

        const ok = await saveDecisionOptions(session.id, final);
        if (!ok) {
            errEl.textContent   = "Couldn't save the option set. Try again.";
            errEl.style.display = '';
            btn.disabled    = false;
            btn.textContent = 'Confirm options';
            return;
        }

        session.decisionOptions = final;
        next();
    });
}

// ---------------------------------------------------------------------------
// HTML builders
// ---------------------------------------------------------------------------
function _rowHTML(o) {
    if (o._editing) {
        return `
<div class="opt-row" data-row-id="${o.id}">
  <div class="cue-edit-area" style="grid-column:1/-1">
    <input class="lab-edit-input edit-label" value="${_esc(o.label)}" placeholder="Option label">
    <textarea class="lab-edit-ta edit-opt-def" placeholder="What choosing this means in practice">${_esc(o.description)}</textarea>
    <button type="button" class="btn btn-primary btn-sm opt-save-edit" data-id="${o.id}">Save</button>
  </div>
</div>`;
    }

    return `
<div class="opt-row ${o._removed ? 'removed' : ''}">
  <div>
    <div class="opt-label">${_esc(o.label)}</div>
    <div class="opt-desc">${_esc(o.description)}</div>
  </div>
  <div class="opt-actions" style="display:flex;gap:0.4rem">
    <button type="button" class="btn btn-ghost btn-sm opt-edit-btn" data-id="${o.id}">Edit</button>
    <button type="button" class="btn btn-ghost btn-sm opt-remove-btn" data-id="${o.id}">
      ${o._removed ? 'Undo' : 'Remove'}
    </button>
  </div>
</div>`;
}

function _pips(active) {
    return Array.from({ length: 10 }, (_, i) => {
        const n   = i + 1;
        const cls = n === active ? 'active' : n < active ? 'done' : '';
        return `<div class="lab-pip ${cls}" title="Screen ${n}"></div>`;
    }).join('');
}

function _esc(s) {
    if (!s) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
