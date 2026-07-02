// =============================================================================
// Lab — views/sorting.js
// Screen 2 — Sorting Task
//
// 12 AI-generated situation cards. The expert drags them into groups they
// define, then answers two prompts per group: what these situations have
// in common, and what would make a similar-looking situation different.
//
// The grouping dimensions feed back into the cue library — a second
// classify() call merges any new discriminators the expert surfaced here
// into the cues proposed in Screen 1.
// =============================================================================

import { generate, classify } from '../../engine/ai.js';
import { extractJSON }        from '../../engine/utils.js';
import { saveSortingTask, saveCueLibrary } from '../db.js';

const NUM_SITUATIONS = 12;

// Module-scoped per render — reset each time render() is called
let _situations = [];   // [{ id, text }]
let _groups     = [];   // [{ groupId, situationIds: [], commonality: '', discriminator: '' }]
let _dragId     = null; // currently dragged situation id

export async function render(el, session, next) {
    _situations = [];
    _groups     = [{ groupId: _newGroupId(), situationIds: [], commonality: '', discriminator: '' }];

    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(2)}</div>
  <h1 class="lab-h1">Sort these situations</h1>
  <p class="lab-sub">
    Drag each card into a group with situations you'd treat the same way.
    Make as many or as few groups as you need — there's no right number.
  </p>
  <div id="sorting-body">
    <div class="lab-thinking">
      <div class="lab-dots"><div class="lab-dot"></div><div class="lab-dot"></div><div class="lab-dot"></div></div>
      Generating situations from your profile…
    </div>
  </div>
</div>`;

    const body = el.querySelector('#sorting-body');

    // ---- Generate situations from profile -------------------------------
    const p = session.profile ?? {};
    const cueNames = (session.cueLibrary ?? []).map(c => c.name).join(', ');

    const systemPrompt = `You write short, realistic situation descriptions for a professional skill-extraction exercise.
Each situation should be 1-2 sentences, concrete, and varied — covering a spread of difficulty and the kind of cues a skilled person in this field would notice.
Return a JSON array of exactly ${NUM_SITUATIONS} strings, nothing else — no markdown fences, no other text.`;

    const prompt = `Area of expertise: ${p.role}
What their work involves: ${p.whatYouDo}
Decision types: ${p.decisionTypes}
What makes situations hard: ${p.whatMakesItHard}
${cueNames ? `Cues already identified: ${cueNames}` : ''}

Write ${NUM_SITUATIONS} short, varied situation descriptions this person might encounter, as a JSON array of strings.`;

    const result = await generate(prompt, systemPrompt);

    let texts = result.ok ? extractJSON(result.text) : null;
    if (!texts || !Array.isArray(texts) || texts.length === 0) {
        body.innerHTML = `
<div class="lab-notice lab-err">
  Couldn't generate situations. Check your connection and try again.
</div>
<button class="btn btn-primary" id="retry-gen">Retry</button>`;
        body.querySelector('#retry-gen').addEventListener('click', () => render(el, session, next));
        return;
    }

    _situations = texts.slice(0, NUM_SITUATIONS).map((text, i) => ({ id: `sit-${i}`, text }));

    _renderBoard(body, el, session, next);
}

// ---------------------------------------------------------------------------
// _renderBoard — draws the pool + groups + submit button, wires drag/drop.
// ---------------------------------------------------------------------------
function _renderBoard(body, el, session, next) {
    const placedIds = new Set(_groups.flatMap(g => g.situationIds));
    const poolSituations = _situations.filter(s => !placedIds.has(s.id));

    body.innerHTML = `
  <div id="sorting-err" class="lab-notice lab-err" style="display:none"></div>

  <div class="sort-label">Unsorted situations</div>
  <div class="sort-pool" id="pool">
    ${poolSituations.map(s => _chipHTML(s)).join('') || '<span style="color:var(--warm-grey);font-size:var(--text-sm)">All situations sorted.</span>'}
  </div>

  <div id="groups-wrap">
    ${_groups.map((g, i) => _groupHTML(g, i)).join('')}
  </div>

  <button type="button" class="lab-add-btn" id="add-group">+ Add another group</button>

  <div class="lab-btn-row">
    <button type="button" class="btn btn-primary" id="sorting-submit">Continue</button>
  </div>`;

    // ---- Drag and drop wiring -------------------------------------------
    body.querySelectorAll('.sit-chip').forEach(chip => {
        chip.addEventListener('dragstart', (e) => {
            _dragId = chip.dataset.id;
            chip.classList.add('active');
            e.dataTransfer.effectAllowed = 'move';
        });
        chip.addEventListener('dragend', () => chip.classList.remove('active'));
    });

    const dropTargets = body.querySelectorAll('.sort-pool, .sort-drop');
    dropTargets.forEach(target => {
        target.addEventListener('dragover', (e) => {
            e.preventDefault();
            target.classList.add('over');
        });
        target.addEventListener('dragleave', () => target.classList.remove('over'));
        target.addEventListener('drop', (e) => {
            e.preventDefault();
            target.classList.remove('over');
            if (!_dragId) return;

            // Remove from whichever group currently holds it
            _groups.forEach(g => {
                g.situationIds = g.situationIds.filter(id => id !== _dragId);
            });

            const destGroupId = target.dataset.groupId;
            if (destGroupId) {
                const grp = _groups.find(g => g.groupId === destGroupId);
                if (grp && !grp.situationIds.includes(_dragId)) {
                    grp.situationIds.push(_dragId);
                }
            }
            // If dropped on pool (no destGroupId), it's already removed from groups above

            _dragId = null;
            _renderBoard(body, el, session, next);
        });
    });

    // ---- Group prompt inputs ---------------------------------------------
    body.querySelectorAll('[data-commonality]').forEach(ta => {
        ta.addEventListener('input', () => {
            const g = _groups.find(g => g.groupId === ta.dataset.commonality);
            if (g) g.commonality = ta.value;
        });
    });
    body.querySelectorAll('[data-discriminator]').forEach(ta => {
        ta.addEventListener('input', () => {
            const g = _groups.find(g => g.groupId === ta.dataset.discriminator);
            if (g) g.discriminator = ta.value;
        });
    });

    // ---- Remove group ------------------------------------------------------
    body.querySelectorAll('.remove-group').forEach(btn => {
        btn.addEventListener('click', () => {
            if (_groups.length <= 1) return; // always keep at least one group
            _groups = _groups.filter(g => g.groupId !== btn.dataset.groupId);
            _renderBoard(body, el, session, next);
        });
    });

    // ---- Add group ---------------------------------------------------------
    body.querySelector('#add-group').addEventListener('click', () => {
        _groups.push({ groupId: _newGroupId(), situationIds: [], commonality: '', discriminator: '' });
        _renderBoard(body, el, session, next);
    });

    // ---- Submit --------------------------------------------------------------
    body.querySelector('#sorting-submit').addEventListener('click', async () => {
        const errEl = body.querySelector('#sorting-err');
        errEl.style.display = 'none';

        const unsorted = _situations.length - _groups.flatMap(g => g.situationIds).length;
        if (unsorted > 0) {
            errEl.textContent = `${unsorted} situation${unsorted === 1 ? '' : 's'} still unsorted — drag every card into a group before continuing.`;
            errEl.style.display = '';
            return;
        }

        const nonEmptyGroups = _groups.filter(g => g.situationIds.length > 0);
        const missingPrompts = nonEmptyGroups.some(g => !g.commonality.trim() || !g.discriminator.trim());
        if (missingPrompts) {
            errEl.textContent = 'Answer both questions for every group before continuing.';
            errEl.style.display = '';
            return;
        }

        const btn = body.querySelector('#sorting-submit');
        btn.disabled    = true;
        btn.textContent = 'Saving…';

        const sortingTask = {
            situations: _situations.map(s => s.text),
            groups: nonEmptyGroups.map(g => ({
                situationIds: g.situationIds,
                commonality:  g.commonality.trim(),
                discriminator: g.discriminator.trim(),
            })),
        };

        const sortOk = await saveSortingTask(session.id, sortingTask);
        if (!sortOk) {
            errEl.textContent = "Couldn't save your groupings. Try again.";
            errEl.style.display = '';
            btn.disabled    = false;
            btn.textContent = 'Continue';
            return;
        }
        session.sortingTask = sortingTask;

        // ---- Merge grouping dimensions into the cue library --------------
        btn.textContent = 'Refining cue library…';

        const existing = session.cueLibrary ?? [];
        const systemPrompt = `You are refining a professional's cue library using new evidence from a sorting exercise.
The expert grouped situations and explained what makes each group distinct from situations that look similar but need a different response.
Decide whether these discriminators are already covered by the existing cues, or whether they reveal a genuinely new cue that should be added.

Return a JSON array only — no markdown fences, no other text — of the FULL updated cue list (existing cues you keep, plus any new ones). Each element must have exactly these fields:
{ "name": string, "definition": string, "scale": "binary" or "three-point", "layer": 1, 2, or 3, "options": array of 2 strings if binary, 3 if three-point }
Do not duplicate a cue that already captures the same distinction under a different name.`;

        const prompt = `Existing cue library:
${existing.map(c => `- ${c.name}: ${c.definition}`).join('\n') || '(none yet)'}

New evidence from sorting groups:
${nonEmptyGroups.map((g, i) => `Group ${i + 1} — what's common: ${g.commonality}\nWhat would make it different: ${g.discriminator}`).join('\n\n')}

Return the full updated cue list as a JSON array.`;

        const mergeResult = await classify(prompt, systemPrompt);
        const merged = mergeResult.ok ? extractJSON(mergeResult.text) : null;

        if (merged && Array.isArray(merged) && merged.length > 0) {
            const cueLibrary = merged.map((c, i) => ({
                id:         existing.find(e => e.name === c.name)?.id ?? `cue-${Date.now()}-${i}`,
                name:       c.name ?? `Cue ${i + 1}`,
                definition: c.definition ?? '',
                scale:      c.scale === 'three-point' ? 'three-point' : 'binary',
                layer:      [1, 2, 3].includes(c.layer) ? c.layer : 2,
                options:    Array.isArray(c.options) && c.options.length > 0
                    ? c.options
                    : (c.scale === 'three-point' ? ['Low', 'Medium', 'High'] : ['Yes', 'No']),
            }));
            await saveCueLibrary(session.id, cueLibrary);
            session.cueLibrary = cueLibrary;
        }
        // If the merge call fails, we simply proceed with the cue library
        // from Screen 1 — non-fatal, the expert reviews and can add cues
        // manually in the next screen anyway.

        next();
    });
}

// ---------------------------------------------------------------------------
// HTML builders
// ---------------------------------------------------------------------------
function _chipHTML(s) {
    return `<div class="sit-chip" draggable="true" data-id="${s.id}">${_esc(s.text)}</div>`;
}

function _groupHTML(g, index) {
    const members = g.situationIds
        .map(id => _situations.find(s => s.id === id))
        .filter(Boolean);

    return `
<div class="sort-group-wrap">
  <div class="sort-group-head">
    <span>Group ${index + 1}</span>
    <button type="button" class="btn btn-ghost btn-sm remove-group" data-group-id="${g.groupId}">Remove group</button>
  </div>
  <div class="sort-drop" data-group-id="${g.groupId}">
    ${members.map(s => _chipHTML(s)).join('') || ''}
  </div>
  <div class="group-prompt">
    <label>What do these situations have in common?</label>
    <textarea class="input" rows="2" data-commonality="${g.groupId}"
      placeholder="What links these together?">${_esc(g.commonality)}</textarea>
    <label style="margin-top:0.6rem">What would make a situation that looks like one of these actually need a different response?</label>
    <textarea class="input" rows="2" data-discriminator="${g.groupId}"
      placeholder="What would be different enough to change your approach?">${_esc(g.discriminator)}</textarea>
  </div>
</div>`;
}

function _newGroupId() {
    return `grp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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
