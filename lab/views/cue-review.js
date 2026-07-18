// =============================================================================
// Lab — views/cue-review.js
// Screen 3 — Cue Library Review
//
// The expert reviews the AI-proposed cue library (built in Screens 1 and 2)
// before it is locked. Keep / Edit / Remove per cue, plus two reflection
// prompts that nudge the expert to spot gaps before confirming.
//
// "Suggest more cues" — a labelled classify() call, same expert-primary/
// AI-secondary house rule as the augmentation call in profile.js: proposes
// additional cues given what's already in the list, tagged source:
// 'ai-suggested' and appended (not saved to Firestore until Confirm, same as
// everything else on this screen). Purely additive — never replaces or edits
// an existing cue.
//
// The explainer card uses detectDomain()/DOMAIN_CONTENT from the shared
// domain-signals.js (originally built for Screen 1's adjacent-role examples)
// to show one concrete illustration of what "a cue" means drawn from the
// expert's own field, rather than leaving "cue" as an abstract definition —
// the same concrete-over-abstract principle behind the Screen 1 rework.
//
// NOTE on the two reflection prompts in the spec ("would these look
// identical but need a different response?" / "wouldn't actually change
// what you'd do?"): the data model has no dedicated field for the prompt
// answers themselves — only the resulting cueLibrary is persisted. So here
// they're rendered as guided actions: prompt 1 opens the "add a cue" form,
// prompt 2 points at the Remove action already on each row. Flagging this
// interpretation in case you want the raw reflection answers stored too.
// =============================================================================

import { saveCueLibrary }      from '../db.js';
import { classify }            from '../../engine/ai.js';
import { extractJSON }         from '../../engine/utils.js';
import { DOMAIN_CONTENT, detectDomain } from '../domain-signals.js';

let _cues       = [];   // working copy: [{ id, name, definition, scale, layer, options, source, _removed, _editing }]
let _addingCue  = false;
let _suggesting = false; // true while the "Suggest more cues" call is in flight

export function render(el, session, next) {
    _cues = (session.cueLibrary ?? []).map(c => ({ ...c, _removed: false, _editing: false }));
    _addingCue  = false;
    _suggesting = false;
    _draw(el, session, next);
}

function _draw(el, session, next) {
    const role   = session.profile?.role ?? '';
    const domain = detectDomain(role);
    const example = (DOMAIN_CONTENT[domain] ?? DOMAIN_CONTENT.general).cueExampleLine;

    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(3)}</div>
  <h1 class="lab-h1">Review your cue library</h1>
  <p class="lab-sub">
    These are the cues the system thinks drive your decisions. Correct anything
    that's off before they're used to build scenarios — this is the foundation
    everything else is built on.
  </p>

  <div id="cue-err" class="lab-notice lab-err" style="display:none"></div>

  <div class="lab-explain-card">
    <p>
      Simplest way to check if something's a real <strong>cue</strong>: <strong>if this one detail were
      different, would you actually do something different?</strong> If yes, it's a cue. If you'd do the
      same thing either way, it isn't — even if it sounds important.
    </p>
    <p style="color:var(--warm-grey);font-style:italic">
      ${_esc(example)}
    </p>
    <p>
      Not all cues are obvious — many are things experts notice instinctively without being aware
      they're doing it. The system has proposed these based on your profile and your sorting groups.
    </p>
    <div class="lab-explain-actions">
      <div class="lab-explain-action"><strong>Keep</strong><span>Yes — if this changed, I'd genuinely respond differently</span></div>
      <div class="lab-explain-action"><strong>Edit</strong><span>This is real, but the wording isn't how I'd actually think about it</span></div>
      <div class="lab-explain-action"><strong>Remove</strong><span>No — I'd do the same thing either way, this doesn't change my response</span></div>
      <div class="lab-explain-action"><strong>Add</strong><span>Something you know changes your response, that isn't listed</span></div>
    </div>
  </div>

  <div class="lab-card">
    <div id="cue-list">
      ${_cues.map(c => _rowHTML(c)).join('')}
    </div>

    ${_addingCue ? _addFormHTML() : `<button type="button" class="lab-add-btn" id="show-add">+ Add a cue I noticed is missing</button>`}

    <button type="button" class="lab-example-toggle" id="suggest-more" style="margin-top:var(--space-3)" ${_suggesting ? 'disabled' : ''}>
      ${_suggesting ? 'Asking AI for more…' : 'Suggest more cues'}
    </button>
  </div>

  <div class="lab-card">
    <div class="lab-section-head">Before you confirm</div>
    <p style="font-size:var(--text-sm);color:var(--warm-grey);line-height:1.6;margin-bottom:var(--space-2)">
      Are there situations in your work that would need a different response but would
      look identical using only these cues? If so, add the missing cue above.
    </p>
    <p style="font-size:var(--text-sm);color:var(--warm-grey);line-height:1.6;margin:0">
      Are there any cues below that wouldn't actually change what you'd do? Remove them.
    </p>
  </div>

  <div class="lab-btn-row">
    <button type="button" class="btn btn-primary" id="cue-confirm">Confirm cue library</button>
  </div>
</div>`;

    // ---- Per-row actions ---------------------------------------------------
    el.querySelectorAll('.cue-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const c = _cues.find(c => c.id === btn.dataset.id);
            if (c) c._editing = !c._editing;
            _draw(el, session, next);
        });
    });

    el.querySelectorAll('.cue-remove-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const c = _cues.find(c => c.id === btn.dataset.id);
            if (c) c._removed = !c._removed;
            _draw(el, session, next);
        });
    });

    el.querySelectorAll('.cue-save-edit').forEach(btn => {
        btn.addEventListener('click', () => {
            const c = _cues.find(c => c.id === btn.dataset.id);
            if (!c) return;
            const row = el.querySelector(`[data-row-id="${c.id}"]`);
            c.name       = row.querySelector('.edit-name').value.trim()       || c.name;
            c.definition = row.querySelector('.edit-def').value.trim()       || c.definition;
            c._editing   = false;
            _draw(el, session, next);
        });
    });

    // ---- Add-cue form --------------------------------------------------------
    const showAddBtn = el.querySelector('#show-add');
    if (showAddBtn) {
        showAddBtn.addEventListener('click', () => {
            _addingCue = true;
            _draw(el, session, next);
        });
    }

    // ---- Suggest more cues (AI, labelled, additive only) --------------------
    el.querySelector('#suggest-more').addEventListener('click', async () => {
        if (_suggesting) return;
        _suggesting = true;
        _draw(el, session, next);

        const suggested = await _suggestMoreCues(session, _cues.filter(c => !c._removed));

        _suggesting = false;
        if (suggested.length === 0) {
            const errEl = el.querySelector('#cue-err');
            errEl.textContent   = "Couldn't get more suggestions right now. Try again, or add one yourself below.";
            errEl.style.display = '';
        }
        _cues.push(...suggested);
        _draw(el, session, next);
    });

    const cancelAddBtn = el.querySelector('#cancel-add');
    if (cancelAddBtn) {
        cancelAddBtn.addEventListener('click', () => {
            _addingCue = false;
            _draw(el, session, next);
        });
    }

    const saveAddBtn = el.querySelector('#save-add');
    if (saveAddBtn) {
        saveAddBtn.addEventListener('click', () => {
            const name  = el.querySelector('#new-cue-name').value.trim();
            const def   = el.querySelector('#new-cue-def').value.trim();
            const scale = el.querySelector('#new-cue-scale').value;
            if (!name || !def) return;

            _cues.push({
                id: `cue-${Date.now()}`,
                name,
                definition: def,
                scale,
                layer: 2,
                options: scale === 'three-point' ? ['Low', 'Medium', 'High'] : ['Yes', 'No'],
                _removed: false,
                _editing: false,
            });
            _addingCue = false;
            _draw(el, session, next);
        });
    }

    // ---- Confirm -------------------------------------------------------------
    el.querySelector('#cue-confirm').addEventListener('click', async () => {
        const final = _cues.filter(c => !c._removed)
            .map(({ _removed, _editing, ...c }) => c);

        const errEl = el.querySelector('#cue-err');
        if (final.length === 0) {
            errEl.textContent   = 'You need at least one cue to continue.';
            errEl.style.display = '';
            return;
        }
        errEl.style.display = 'none';

        const btn = el.querySelector('#cue-confirm');
        btn.disabled    = true;
        btn.textContent = 'Saving…';

        const ok = await saveCueLibrary(session.id, final);
        if (!ok) {
            errEl.textContent   = "Couldn't save the cue library. Try again.";
            errEl.style.display = '';
            btn.disabled    = false;
            btn.textContent = 'Confirm cue library';
            return;
        }

        session.cueLibrary = final;
        next();
    });
}

// ---------------------------------------------------------------------------
// _suggestMoreCues(session, existingCues) — one classify() call. Expert-
// primary/AI-secondary house rule: proposes ADDITIONAL cues given what's
// already in the list, never edits or replaces an existing one. Returned
// cues are tagged source: 'ai-suggested' and shown with the same "Suggested"
// badge as the ones proposed on Screen 1 — reviewed with Keep/Edit/Remove
// exactly like every other cue, never silently trusted.
// Returns [] on failure — non-fatal, the expert can just try again or add
// one manually.
// ---------------------------------------------------------------------------
async function _suggestMoreCues(session, existingCues) {
    const p = session.profile ?? {};

    const system = `You are proposing ADDITIONAL cues for a professional's decision-capture cue library, on top of
cues already proposed. A cue is a single, specific piece of information that changes what a skilled person in
this field would actually do — not a competency, not a KPI, a detail that if it were different would produce a
different response. Only propose cues you are NOT certain the expert actually holds — this is a suggestion for
them to confirm or reject, not a confirmed extraction. Do not repeat or closely rephrase any cue already listed.

Return a JSON array only — no markdown fences, no other text. Each element must have exactly these fields:
{
  "name": "Short cue name, 2-5 words",
  "definition": "One sentence — what this cue means and how to recognise it",
  "scale": "binary" or "three-point",
  "layer": 1, 2, or 3 — 1 is a surface/obvious cue, 3 is a subtle expert-level cue,
  "options": an array of strings the cue can take — exactly 2 if scale is "binary", exactly 3 if "three-point"
}
Propose between 2 and 4 additional cues. It is fine to return fewer if you can't think of genuinely distinct ones.`;

    const prompt = `Area of expertise: ${p.role ?? ''}
What their work involves: ${p.whatYouDo ?? ''}
Kinds of decisions: ${p.decisionTypes ?? ''}

Cues already in the library:
${existingCues.map(c => `- ${c.name}: ${c.definition}`).join('\n') || '(none yet)'}

Return a JSON array of additional, clearly distinct cues.`;

    const result = await classify(prompt, system);
    if (!result.ok) return [];

    const parsed = extractJSON(result.text);
    if (!Array.isArray(parsed)) return [];

    return parsed.map((c, i) => ({
        id:         `cue-${Date.now()}-more-${i}`,
        name:       c.name ?? `Suggested cue ${i + 1}`,
        definition: c.definition ?? '',
        scale:      c.scale === 'three-point' ? 'three-point' : 'binary',
        layer:      [1, 2, 3].includes(c.layer) ? c.layer : 2,
        options:    Array.isArray(c.options) && c.options.length > 0
            ? c.options
            : (c.scale === 'three-point' ? ['Low', 'Medium', 'High'] : ['Yes', 'No']),
        source:     'ai-suggested',
        _removed:   false,
        _editing:   false,
    }));
}

// ---------------------------------------------------------------------------
// HTML builders
// ---------------------------------------------------------------------------
function _rowHTML(c) {
    if (c._editing) {
        return `
<div class="cue-row" data-row-id="${c.id}">
  <div class="cue-edit-area">
    <input class="lab-edit-input edit-name" value="${_esc(c.name)}" placeholder="Cue name">
    <textarea class="lab-edit-ta edit-def" placeholder="Definition">${_esc(c.definition)}</textarea>
    <button type="button" class="btn btn-primary btn-sm cue-save-edit" data-id="${c.id}">Save</button>
  </div>
</div>`;
    }

    return `
<div class="cue-row ${c._removed ? 'removed' : ''}">
  <div>
    ${c.source === 'ai-suggested' ? `<span class="cue-suggested-badge">Suggested</span>` : ''}
    <div class="cue-name">${_esc(c.name)}</div>
    <div class="cue-def">${_esc(c.definition)}</div>
    <span class="cue-scale-badge">${c.scale === 'three-point' ? '3-point' : 'binary'} · layer ${c.layer}</span>
  </div>
  <div class="cue-actions">
    <button type="button" class="btn btn-ghost btn-sm cue-edit-btn" data-id="${c.id}">Edit</button>
    <button type="button" class="btn btn-ghost btn-sm cue-remove-btn" data-id="${c.id}">
      ${c._removed ? 'Undo' : 'Remove'}
    </button>
  </div>
</div>`;
}

function _addFormHTML() {
    return `
<div class="group-prompt" style="margin-top:1rem">
  <label>Cue name</label>
  <input class="lab-edit-input" id="new-cue-name" placeholder="e.g. Time pressure on the decision">
  <label style="margin-top:0.5rem">Definition</label>
  <textarea class="lab-edit-ta" id="new-cue-def" placeholder="What this cue means and how you'd recognise it"></textarea>
  <label style="margin-top:0.5rem">Scale</label>
  <select class="input" id="new-cue-scale" style="margin-bottom:0.6rem">
    <option value="binary">Binary (yes/no)</option>
    <option value="three-point">Three-point (low/medium/high)</option>
  </select>
  <div style="display:flex;gap:0.5rem">
    <button type="button" class="btn btn-primary btn-sm" id="save-add">Add cue</button>
    <button type="button" class="btn btn-ghost btn-sm" id="cancel-add">Cancel</button>
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
