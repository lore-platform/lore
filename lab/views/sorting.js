// =============================================================================
// Lab — views/sorting.js
// Screen 2 — Sorting Task
//
// 12 AI-generated situation cards displayed in a two-column layout:
//   Left (sticky): unsorted pool
//   Right (scrollable): groups the expert builds
//
// The expert sorts every card into a group, then answers two questions per
// group — what the situations share, and what would make a similar-looking
// situation need a DIFFERENT response. Those answers surface the discriminating
// cues that drive real expert decisions.
//
// A second classify() call merges any new cue dimensions the sorting revealed
// into the cue library from Screen 1 before advancing.
//
// Situations shown in the pool are 12 profile-derived (source: 'expert') plus
// 4 ai-suggested (source: 'ai-suggested') — 16 total, mixed together in the
// UI since the expert sorts all of them the same way, but tagged underneath
// per the expert-primary/AI-secondary house rule so the merge step and any
// later review can tell them apart.
// =============================================================================

import { generate, classify } from '../../engine/ai.js';
import { extractJSON }        from '../../engine/utils.js';
import { saveSortingTask, saveCueLibrary } from '../db.js';

const NUM_EXPERT_SITUATIONS    = 12;
const NUM_SUGGESTED_SITUATIONS = 4;
const NUM_SITUATIONS = NUM_EXPERT_SITUATIONS + NUM_SUGGESTED_SITUATIONS;

let _situations = [];
let _groups     = [];
let _dragId     = null;

export async function render(el, session, next) {
    _situations = [];
    // Start with two groups — one is not enough to reveal discriminating factors
    _groups = [
        { groupId: _newGroupId(), situationIds: [], commonality: '', discriminator: '' },
        { groupId: _newGroupId(), situationIds: [], commonality: '', discriminator: '' },
    ];

    el.innerHTML = `
<div class="lab-wrap-wide">
  <div class="lab-steps">${_pips(2)}</div>
  <h1 class="lab-h1">Sort these situations</h1>
  <p class="lab-sub">
    You'll see ${NUM_SITUATIONS} situations from your field below. Drag each one into a group
    with situations you'd <strong>handle the same way</strong> — not because
    they're the same topic, but because your response would be the same type
    of call. Two completely different situations might belong in the same group
    if you'd approach both of them the same way.
  </p>
  <div class="lab-notice lab-info" style="margin-bottom:var(--space-5)">
    Once you've sorted them, you'll answer two quick questions per group.
    Those answers — not the sorting itself — are where the real value comes
    from. They reveal the factors that actually drive your decisions.
  </div>
  <div id="sorting-body">
    <div class="lab-thinking">
      <div class="lab-dots">
        <div class="lab-dot"></div>
        <div class="lab-dot"></div>
        <div class="lab-dot"></div>
      </div>
      Generating situations from your profile…
    </div>
  </div>
</div>`;

    const body = el.querySelector('#sorting-body');

    const p        = session.profile ?? {};
    const cueNames = (session.cueLibrary ?? []).map(c => c.name).join(', ');

    // ── Primary call — expert-derived, from the expert's own profile text ──
    const systemPrompt = `You write short, realistic situation descriptions for a professional skill-extraction exercise.
Each situation should be 1-2 sentences, concrete, and varied — covering a spread of difficulty and the kind of cues a skilled person in this field would notice.
Return a JSON array of exactly ${NUM_EXPERT_SITUATIONS} strings, nothing else — no markdown fences, no other text.`;

    const prompt = `Area of expertise: ${p.role}
What their work involves: ${p.whatYouDo}
Decision types: ${p.decisionTypes}
What makes situations hard: ${p.whatMakesItHard}
${cueNames ? `Cues already identified: ${cueNames}` : ''}

Write ${NUM_EXPERT_SITUATIONS} short, varied situation descriptions this person might encounter, as a JSON array of strings.`;

    const result = await generate(prompt, systemPrompt);
    const texts  = result.ok ? extractJSON(result.text) : null;

    if (!texts || !Array.isArray(texts) || texts.length === 0) {
        body.innerHTML = `
<div class="lab-notice lab-err">Couldn't generate situations. Check your connection and try again.</div>
<button class="btn btn-primary" id="retry-gen">Retry</button>`;
        body.querySelector('#retry-gen').addEventListener('click', () => render(el, session, next));
        return;
    }

    const expertSituations = texts.slice(0, NUM_EXPERT_SITUATIONS)
        .map((text, i) => ({ id: `sit-${i}`, text, source: 'expert' }));

    // ── Secondary call — labelled ai-suggested, from general role knowledge ──
    // Expert-primary/AI-secondary house rule: these supplement the primary
    // set with situation types a practitioner in this field would likely
    // recognise as distinct, drawn from general knowledge rather than the
    // expert's own words — kept distinguishable via source, not silently blended.
    const augmentSystem = `You write short, realistic situation descriptions for a professional skill-extraction exercise, drawing on
general knowledge of what distinct situation types a practitioner in this field would likely recognise —
not from anything the expert has written themselves.
Each situation should be 1-2 sentences, concrete, and should cover a distinct type of situation from the ones already listed below.
Return a JSON array of exactly ${NUM_SUGGESTED_SITUATIONS} strings, nothing else — no markdown fences, no other text.`;

    const augmentPrompt = `Area of expertise: ${p.role}
What their work involves: ${p.whatYouDo}
Decision types: ${p.decisionTypes}

Situations already written from the expert's own description:
${expertSituations.map(s => `- ${s.text}`).join('\n')}

Write ${NUM_SUGGESTED_SITUATIONS} additional, clearly distinct situation descriptions, as a JSON array of strings.`;

    const augmentResult = await generate(augmentPrompt, augmentSystem);
    const augmentTexts  = augmentResult.ok ? extractJSON(augmentResult.text) : null;

    const suggestedSituations = (Array.isArray(augmentTexts) ? augmentTexts : [])
        .slice(0, NUM_SUGGESTED_SITUATIONS)
        .map((text, i) => ({ id: `sit-sug-${i}`, text, source: 'ai-suggested' }));
    // Non-fatal if this call fails or returns nothing — the 12 expert-derived
    // situations from the primary call are sufficient to continue on their own.

    _situations = [...expertSituations, ...suggestedSituations];
    _renderBoard(body, el, session, next);
}

// ---------------------------------------------------------------------------
// _renderBoard — two-column layout, re-rendered on every drag action.
// Left panel: unsorted pool (sticky). Right panel: groups.
// ---------------------------------------------------------------------------
function _renderBoard(body, el, session, next) {
    const placedIds      = new Set(_groups.flatMap(g => g.situationIds));
    const poolSituations = _situations.filter(s => !placedIds.has(s.id));
    const remaining      = poolSituations.length;

    body.innerHTML = `
<div id="sorting-err" class="lab-notice lab-err" style="display:none"></div>

<div class="sort-layout">

  <!-- ── Left: unsorted pool (sticky) ─────────────────────────────── -->
  <div class="sort-left-panel">
    <div class="sort-label">
      Unsorted situations
      <span class="sort-remaining">${remaining > 0 ? `(${remaining} remaining)` : '(all sorted ✓)'}</span>
    </div>
    <div class="sort-pool" id="pool">
      ${poolSituations.map(s => _chipHTML(s)).join('')
        || `<span style="color:var(--warm-grey);font-size:var(--text-sm)">
              All situations have been sorted.
            </span>`}
    </div>
    <p class="sort-hint">Drag cards across to a group on the right. You can drag them back too.</p>
  </div>

  <!-- ── Right: groups ─────────────────────────────────────────────── -->
  <div class="sort-right-panel">
    <div class="sort-label">Your groups</div>
    <div id="groups-wrap">
      ${_groups.map((g, i) => _groupHTML(g, i)).join('')}
    </div>

    <button type="button" class="lab-add-btn" id="add-group">
      + Add another group
    </button>
    <p class="sort-hint">
      Most experts end up with 3–5 groups. If everything feels the same,
      ask yourself: what would make me respond differently to one of these?
    </p>

    <div class="lab-btn-row">
      <button type="button" class="btn btn-primary" id="sorting-submit">Continue</button>
    </div>
  </div>

</div>`;

    // ── Drag-and-drop wiring ────────────────────────────────────────────
    body.querySelectorAll('.sit-chip').forEach(chip => {
        chip.addEventListener('dragstart', (e) => {
            _dragId = chip.dataset.id;
            chip.classList.add('active');
            e.dataTransfer.effectAllowed = 'move';
        });
        chip.addEventListener('dragend', () => chip.classList.remove('active'));
    });

    body.querySelectorAll('.sort-pool, .sort-drop').forEach(target => {
        target.addEventListener('dragover',  (e) => { e.preventDefault(); target.classList.add('over'); });
        target.addEventListener('dragleave', ()  => target.classList.remove('over'));
        target.addEventListener('drop', (e) => {
            e.preventDefault();
            target.classList.remove('over');
            if (!_dragId) return;

            // Remove from all groups (covers pool → group and group → group)
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

            _dragId = null;
            _renderBoard(body, el, session, next);
        });
    });

    // ── Group text inputs — kept in _groups state on every keystroke ─────
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

    // ── Remove group ────────────────────────────────────────────────────
    body.querySelectorAll('.remove-group').forEach(btn => {
        btn.addEventListener('click', () => {
            if (_groups.length <= 1) return;
            _groups = _groups.filter(g => g.groupId !== btn.dataset.groupId);
            _renderBoard(body, el, session, next);
        });
    });

    // ── Add group ───────────────────────────────────────────────────────
    body.querySelector('#add-group').addEventListener('click', () => {
        _groups.push({ groupId: _newGroupId(), situationIds: [], commonality: '', discriminator: '' });
        _renderBoard(body, el, session, next);
    });

    // ── Submit ──────────────────────────────────────────────────────────
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
        if (nonEmptyGroups.some(g => !g.commonality.trim() || !g.discriminator.trim())) {
            errEl.textContent = 'Please answer both questions for every group before continuing.';
            errEl.style.display = '';
            return;
        }

        const btn = body.querySelector('#sorting-submit');
        btn.disabled    = true;
        btn.textContent = 'Saving…';

        const sortingTask = {
            situations: _situations.map(s => ({ id: s.id, text: s.text, source: s.source })),
            groups: nonEmptyGroups.map(g => ({
                situationIds:  g.situationIds,
                commonality:   g.commonality.trim(),
                discriminator: g.discriminator.trim(),
            })),
        };

        const sortOk = await saveSortingTask(session.id, sortingTask);
        if (!sortOk) {
            errEl.textContent   = "Couldn't save your groupings. Try again.";
            errEl.style.display = '';
            btn.disabled    = false;
            btn.textContent = 'Continue';
            return;
        }
        session.sortingTask = sortingTask;

        // ── Merge new discriminators into the cue library ───────────────
        btn.textContent = 'Updating cue library…';

        const existing     = session.cueLibrary ?? [];
        const mergeSystem  = `You are refining a professional's cue library using new evidence from a sorting exercise.
The expert grouped situations and explained what makes each group distinct from situations that look similar but need a different response.
Decide whether these discriminators are already covered by the existing cues, or whether they reveal a genuinely new cue that should be added.

Return a JSON array only — no markdown fences, no other text — of the FULL updated cue list (existing cues you keep, plus any new ones). Each element must have exactly these fields:
{ "name": string, "definition": string, "scale": "binary" or "three-point", "layer": 1, 2, or 3, "options": array of 2 strings if binary, 3 if three-point }
Do not duplicate a cue that already captures the same distinction under a different name.`;

        const mergePrompt = `Existing cue library:
${existing.map(c => `- ${c.name}: ${c.definition}`).join('\n') || '(none yet)'}

New evidence from sorting groups:
${nonEmptyGroups.map((g, i) => `Group ${i + 1}\nWhy the same: ${g.commonality}\nWhat would make it different: ${g.discriminator}`).join('\n\n')}

Return the full updated cue list as a JSON array.`;

        const mergeResult = await classify(mergePrompt, mergeSystem);
        const merged      = mergeResult.ok ? extractJSON(mergeResult.text) : null;

        if (merged && Array.isArray(merged) && merged.length > 0) {
            const cueLibrary = merged.map((c, i) => {
                const matchedExisting = existing.find(e => e.name === c.name);
                return {
                    id:         matchedExisting?.id ?? `cue-${Date.now()}-${i}`,
                    name:       c.name ?? `Cue ${i + 1}`,
                    definition: c.definition ?? '',
                    scale:      c.scale === 'three-point' ? 'three-point' : 'binary',
                    layer:      [1, 2, 3].includes(c.layer) ? c.layer : 2,
                    options:    Array.isArray(c.options) && c.options.length > 0
                        ? c.options
                        : (c.scale === 'three-point' ? ['Low', 'Medium', 'High'] : ['Yes', 'No']),
                    // Preserve an existing cue's source (expert or ai-suggested)
                    // rather than overwriting it. A genuinely new cue created by
                    // this step is tagged 'expert' — it comes directly from the
                    // expert's own discriminator answers, not a model suggestion.
                    source:     matchedExisting?.source ?? 'expert',
                };
            });
            await saveCueLibrary(session.id, cueLibrary);
            session.cueLibrary = cueLibrary;
        }
        // Non-fatal if merge fails — cue library from Screen 1 is preserved

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
    <span style="font-size:var(--text-xs);font-weight:700;color:var(--warm-grey);text-transform:uppercase;letter-spacing:0.06em">
      Group ${index + 1}
    </span>
    <button type="button" class="btn-ghost btn-sm remove-group"
      data-group-id="${g.groupId}">Remove</button>
  </div>
  <div class="sort-drop" data-group-id="${g.groupId}">
    ${members.map(s => _chipHTML(s)).join('') || ''}
  </div>
  <div class="group-prompt">
    <label>Why would you handle these the same way?</label>
    <textarea class="input" rows="2" data-commonality="${g.groupId}"
      placeholder="What do these situations have in common for you?">${_esc(g.commonality)}</textarea>
    <label style="margin-top:var(--space-3)">
      What would make a situation that <em>looks</em> like these actually need a
      <strong>different</strong> response from you?
    </label>
    <textarea class="input" rows="2" data-discriminator="${g.groupId}"
      placeholder="What would change enough to make you respond differently?">${_esc(g.discriminator)}</textarea>
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
