// =============================================================================
// Lab — views/session.js
// Screen 5 — 30-Scenario Session
//
// Generates 30 scenarios in 5 sets of 6. Cue combinations are produced
// locally (no AI) using a balanced-shuffle so each cue's values appear
// roughly evenly across the session, without correlating cues to each
// other. Only the scenario TEXT for each set (the vignette a human reads)
// is AI-generated — one generate() call per set of 6, called lazily when
// the expert reaches that set.
//
// No score or right/wrong is ever shown — this screen only captures
// responses. The 30 combinations are precomputed and written to Firestore
// once, at the very start of the session (saveScenarioCombos), and the
// scenarios array is saved incrementally after each completed set of 6
// (saveScenarios) — not only at the very end — so an expert who closes the
// app mid-session can resume later into the next unfinished set using the
// same combinations, rather than losing progress or seeing a different set
// of scenarios than they otherwise would have.
//
// Layer-aware generation: layer-one/two cues are passed to the scenario
// generator as named factors; layer-three cues are passed as texture
// instructions instead — an embedded quality the scenario should have
// without ever naming it as a stated variable, per Stage 0.2 of the
// methodology and the layer-flattening bug fixed here.
//
// DECISION FLAGGED IN CHAT: structuredSelection stores the chosen decision
// option's `id` (not its label text) — model-fit.js's break descriptions
// and the eventual policy model depend on this.
// =============================================================================

import { generate, classify }              from '../../engine/ai.js';
import { extractJSON }                     from '../../engine/utils.js';
import { saveScenarios, saveScenarioCombos } from '../db.js';

const TOTAL_SCENARIOS = 30;
const NUM_SETS         = 5;
const SET_SIZE         = 6;

// Quick-select nuance chips — replace typed free text as the default action
// on every one of 30 screens. "Something else" is the only chip that reveals
// the free-text field, so typing effort is concentrated only where it earns
// its keep, per the fatigue-reduction principle.
const _NUANCE_CHIPS = {
    'wrinkle':      "There's a wrinkle here",
    'check-first':  "I'd normally check something else first",
    'someone-else': "This depends on someone else's input",
};

// ---------------------------------------------------------------------------
// Module-level state — reset at the top of render().
// ---------------------------------------------------------------------------
let _combos       = [];   // 30 cue-combination objects, precomputed
let _scenarios    = [];   // finished scenario records, accumulated across sets
let _setIndex     = 0;    // 0-4
let _setItems     = [];   // [{ cueCombination, text }] for the current set — 6 items
let _setRecords   = [];   // finished records for the CURRENT set, before the realism check
let _idxInSet     = 0;    // 0-5
let _selectedOpt  = null; // currently selected decision option id, for the visible scenario
let _scenarioStart = 0;   // Date.now() when the current scenario was rendered

export async function render(el, session, next) {
    const savedCombos    = session.scenarioCombos ?? [];
    const savedScenarios = session.scenarios       ?? [];

    if (savedCombos.length === TOTAL_SCENARIOS) {
        // Resuming (or a page reload mid-session) — reuse the exact combos
        // already on record so the expert sees the same scenarios they would
        // have seen if they'd never left.
        _combos = savedCombos;
    } else {
        _combos = _generateCombos(session.cueLibrary ?? [], TOTAL_SCENARIOS);
        const combosOk = await saveScenarioCombos(session.id, _combos);
        if (combosOk) session.scenarioCombos = _combos;
        // Non-fatal if this write fails — the session can still proceed with
        // the in-memory combos, it just won't survive a resume from scratch.
    }

    if (savedScenarios.length > 0 && savedScenarios.length < TOTAL_SCENARIOS) {
        // Partial capture from an earlier sitting — resume into the next
        // unfinished set rather than starting over.
        _scenarios = [...savedScenarios];
        _setIndex  = Math.floor(savedScenarios.length / SET_SIZE);
    } else {
        _scenarios = [];
        _setIndex  = 0;
    }

    await _loadSet(el, session, next);
}

// ---------------------------------------------------------------------------
// _loadSet — generates the AI vignette text for the current set's 6 cue
// combinations, then renders the first scenario in that set.
// ---------------------------------------------------------------------------
async function _loadSet(el, session, next) {
    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(5)}</div>
  <div class="lab-prog"><div class="lab-prog-fill" style="width:${_progressPct()}%"></div></div>
  <div class="lab-thinking">
    <div class="lab-dots"><div class="lab-dot"></div><div class="lab-dot"></div><div class="lab-dot"></div></div>
    Preparing set ${_setIndex + 1} of ${NUM_SETS}…
  </div>
</div>`;

    const setCombos = _combos.slice(_setIndex * SET_SIZE, (_setIndex + 1) * SET_SIZE);
    const p          = session.profile    ?? {};
    const cueLibrary = session.cueLibrary ?? [];

    const systemPrompt = `You write short, realistic professional situations for a decision-capture exercise.
Each situation must be written in second person ("You are...", "You receive...") and be 2-4 sentences long.
You will be given a specific combination of underlying factors for each situation, in two kinds:

STATED FACTORS — the situation must be consistent with these, but must NOT name the factor or its label
directly. Show it naturally through the details of the situation, the way it would actually appear in
someone's day.

TEXTURE INSTRUCTIONS — subtle qualities the situation should embody, given as guidance rather than a
named variable. These must NEVER be stated as a fact, labelled, or made obvious — they should only be
detectable the way an expert would notice something a less experienced person would miss. Weave them into
incidental detail, tone, or phrasing rather than calling them out.

Do not mention any decision options, right answers, or scoring — you are only describing the situation.

Return a JSON array of exactly ${setCombos.length} strings, in the same order as the situations given
below — nothing else, no markdown fences, no other text.`;

    const comboLines = setCombos.map((combo, i) => {
        const statedParts  = [];
        const textureParts = [];

        Object.entries(combo).forEach(([cueId, value]) => {
            const cue = cueLibrary.find(c => c.id === cueId);
            if (!cue) { statedParts.push(`${cueId}: ${value}`); return; }

            if (cue.layer === 3) {
                // Layer-three cues are implicit signals — they cannot be cleanly
                // logged as a named variable without collapsing the very subtlety
                // that makes them layer three. Passed as texture guidance instead.
                textureParts.push(`embed a subtle quality consistent with "${cue.definition}", currently at "${value}" — without ever naming this as a factor`);
            } else {
                statedParts.push(`${cue.name}: ${value}`);
            }
        });

        let line = `Situation ${i + 1}`;
        if (statedParts.length)  line += ` — stated factors: ${statedParts.join(', ')}`;
        if (textureParts.length) line += `${statedParts.length ? ';' : ' —'} texture instructions: ${textureParts.join('; ')}`;
        return line;
    }).join('\n');

    const prompt = `Area of expertise: ${p.role}
What their work involves: ${p.whatYouDo}

Write ${setCombos.length} situations, one per line below, each consistent with its listed factors:
${comboLines}

Return a JSON array of ${setCombos.length} situation strings, in order.`;

    const result = await generate(prompt, systemPrompt);
    const texts  = result.ok ? extractJSON(result.text) : null;

    if (!texts || !Array.isArray(texts) || texts.length < setCombos.length) {
        el.querySelector('.lab-wrap').innerHTML += `
<div class="lab-notice lab-err">Couldn't generate this set of situations. Check your connection and try again.</div>
<button class="btn btn-primary" id="retry-set">Retry</button>`;
        el.querySelector('#retry-set').addEventListener('click', () => _loadSet(el, session, next));
        return;
    }

    _setItems   = setCombos.map((combo, i) => ({ cueCombination: combo, text: texts[i] }));
    _setRecords = [];
    _idxInSet   = 0;

    _renderScenario(el, session, next);
}

// ---------------------------------------------------------------------------
// _renderScenario — shows one scenario card: text, decision option buttons,
// optional free-text field, and a Next button.
// ---------------------------------------------------------------------------
function _renderScenario(el, session, next) {
    const item     = _setItems[_idxInSet];
    const options  = session.decisionOptions ?? [];
    _selectedOpt   = null;
    _scenarioStart = Date.now();

    const overallIdx = _setIndex * SET_SIZE + _idxInSet;

    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(5)}</div>
  <div class="lab-prog"><div class="lab-prog-fill" style="width:${_progressPct()}%"></div></div>
  <p class="lab-sub" style="margin-bottom:var(--space-4)">
    Situation ${overallIdx + 1} of ${TOTAL_SCENARIOS} · Set ${_setIndex + 1} of ${NUM_SETS}
  </p>

  <div class="lab-scenario-card">${_esc(item.text)}</div>

  <div class="lab-card">
    <div class="lab-section-head">What would you do?</div>
    <div class="choice-row" id="opt-choices">
      ${options.map(o => `
        <button type="button" class="choice-btn" data-id="${o.id}" title="${_esc(o.description ?? '')}">
          ${_esc(o.label)}
        </button>`).join('')}
    </div>

    <div class="form-group" style="margin-top:var(--space-5);margin-bottom:0">
      <label class="label">Anything you'd add? (optional)</label>
      <div class="choice-row" id="nuance-chips">
        ${Object.entries(_NUANCE_CHIPS).map(([key, label]) => `
          <button type="button" class="choice-btn nuance-chip" data-chip="${key}">${_esc(label)}</button>`).join('')}
        <button type="button" class="choice-btn nuance-chip" data-chip="other">Something else…</button>
      </div>
      <textarea class="input" id="free-elaborate" rows="2" style="display:none;margin-top:var(--space-3)"
        placeholder="What's the nuance?"></textarea>
    </div>
  </div>

  <div id="scenario-err" class="lab-notice lab-err" style="display:none"></div>

  <div class="lab-btn-row">
    <button type="button" class="btn btn-primary" id="scenario-next" disabled>Next</button>
  </div>
</div>`;

    el.querySelectorAll('#opt-choices .choice-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            _selectedOpt = btn.dataset.id;
            el.querySelectorAll('#opt-choices .choice-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            el.querySelector('#scenario-next').disabled = false;
            el.querySelector('#scenario-err').style.display = 'none';
        });
    });

    el.querySelectorAll('.nuance-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const key = chip.dataset.chip;
            if (key === 'other') {
                const ta = el.querySelector('#free-elaborate');
                const willShow = ta.style.display === 'none';
                ta.style.display = willShow ? '' : 'none';
                chip.classList.toggle('selected', willShow);
                if (!willShow) ta.value = '';
                return;
            }
            chip.classList.toggle('selected');
        });
    });

    el.querySelector('#scenario-next').addEventListener('click', async () => {
        if (!_selectedOpt) {
            const errEl = el.querySelector('#scenario-err');
            errEl.textContent   = 'Please choose an option before continuing.';
            errEl.style.display = '';
            return;
        }

        const chipText = Array.from(el.querySelectorAll('.nuance-chip.selected'))
            .map(c => c.dataset.chip)
            .filter(key => key !== 'other')
            .map(key => _NUANCE_CHIPS[key]);
        const otherText = el.querySelector('#free-elaborate').value.trim();
        const freeText  = [...chipText, otherText].filter(Boolean).join(' — ');

        const timeTaken = Date.now() - _scenarioStart;

        _setRecords.push({
            scenarioId:          `scn-${Date.now()}-${overallIdx}`,
            cueCombination:      item.cueCombination,
            text:                item.text,
            structuredSelection: _selectedOpt, // decision option id
            freeText,
            timeTaken,
            realismFlag: false,
            realismNote: '',
        });

        _idxInSet++;
        if (_idxInSet < SET_SIZE) {
            _renderScenario(el, session, next);
        } else {
            await _renderRealismCheck(el, session, next);
        }
    });
}

// ---------------------------------------------------------------------------
// _renderRealismCheck — shown after every set of 6. Asks whether any of
// the 6 situations just seen felt unrealistic, and if so, which one and why.
// Also generates and shows a one-line reflection on the pattern forming so
// far — a small return partway through, rather than deferring everything to
// the final Recipe.
// ---------------------------------------------------------------------------
async function _renderRealismCheck(el, session, next) {
    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(5)}</div>
  <div class="lab-prog"><div class="lab-prog-fill" style="width:${_progressPct()}%"></div></div>
  <div class="lab-thinking">
    <div class="lab-dots"><div class="lab-dot"></div><div class="lab-dot"></div><div class="lab-dot"></div></div>
    Noticing a pattern so far…
  </div>
</div>`;

    const reflection = await _generateReflection(session);
    _renderRealismCheckForm(el, session, next, reflection);
}

// ---------------------------------------------------------------------------
// _generateReflection — a small classify() call producing one plain-language
// line on the pattern in the set just completed. Ephemeral — not persisted,
// purely a mid-process return for the expert. Non-fatal on failure: returns
// null and the realism check simply skips the reflection line.
// ---------------------------------------------------------------------------
async function _generateReflection(session) {
    const p               = session.profile         ?? {};
    const decisionOptions = session.decisionOptions ?? [];
    const cueLibrary      = session.cueLibrary      ?? [];

    const system = `You are giving a professional a brief, plain-language reflection on the pattern in their most
recent set of decisions during a decision-capture exercise.
Return a JSON object with exactly this field:
{ "reflection": "One plain sentence describing a pattern you're noticing so far — specific to their actual choices below, not generic praise" }
Return the JSON object only — no other text.`;

    const prompt = `Area of expertise: ${p.role}

This set's responses:
${_setRecords.map((r, i) => `${i + 1}. Chose "${_optLabel(r.structuredSelection, decisionOptions)}" — ${_formatCombo(r.cueCombination, cueLibrary)}`).join('\n')}

Return the JSON object with one reflection sentence.`;

    const result = await classify(prompt, system);
    if (!result.ok) return null;

    const parsed = extractJSON(result.text);
    return parsed?.reflection || null;
}

function _renderRealismCheckForm(el, session, next, reflection) {
    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(5)}</div>
  <div class="lab-prog"><div class="lab-prog-fill" style="width:${_progressPct()}%"></div></div>

  ${reflection ? `<div class="lab-notice lab-ok">${_esc(reflection)}</div>` : ''}

  <h1 class="lab-h1">Quick check before you continue</h1>
  <p class="lab-sub">Did any of the last ${SET_SIZE} situations feel unrealistic for your field?</p>

  <div class="lab-card">
    <div class="choice-row" id="realism-pick" style="flex-direction:column;align-items:stretch">
      <button type="button" class="choice-btn realism-btn selected" data-idx="-1" style="text-align:left">
        No — all of them felt realistic
      </button>
      ${_setRecords.map((r, i) => `
        <button type="button" class="choice-btn realism-btn" data-idx="${i}" style="text-align:left">
          "${_esc(_truncate(r.text, 90))}"
        </button>`).join('')}
    </div>

    <div id="realism-note-wrap" style="display:none;margin-top:var(--space-4)">
      <label class="label" for="realism-note">What felt off about it?</label>
      <textarea class="input" id="realism-note" rows="2"
        placeholder="What specifically didn't ring true for your field?"></textarea>
    </div>
  </div>

  <div id="realism-err" class="lab-notice lab-err" style="display:none"></div>

  <div class="lab-btn-row">
    <button type="button" class="btn btn-primary" id="realism-continue">Continue</button>
  </div>
</div>`;

    let pickedIdx = -1;

    el.querySelectorAll('.realism-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            pickedIdx = parseInt(btn.dataset.idx, 10);
            el.querySelectorAll('.realism-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            el.querySelector('#realism-note-wrap').style.display = pickedIdx >= 0 ? '' : 'none';
        });
    });

    el.querySelector('#realism-continue').addEventListener('click', async () => {
        const errEl = el.querySelector('#realism-err');

        if (pickedIdx >= 0) {
            const note = el.querySelector('#realism-note').value.trim();
            if (!note) {
                errEl.textContent   = 'Please describe what felt off, or select "No" above.';
                errEl.style.display = '';
                return;
            }
            _setRecords[pickedIdx].realismFlag = true;
            _setRecords[pickedIdx].realismNote = note;
        }
        errEl.style.display = 'none';

        const btn = el.querySelector('#realism-continue');
        btn.disabled    = true;
        btn.textContent = 'Saving…';

        _scenarios.push(..._setRecords);

        // Incremental save — after every completed set of 6, not only at the
        // very end, so progress survives the expert closing the app mid-session.
        const savedOk = await saveScenarios(session.id, _scenarios);
        if (!savedOk) {
            _scenarios.splice(_scenarios.length - _setRecords.length, _setRecords.length);
            errEl.textContent   = "Couldn't save your responses. Check your connection and try again.";
            errEl.style.display = '';
            btn.disabled    = false;
            btn.textContent = 'Continue';
            return;
        }
        session.scenarios = _scenarios;

        if (_setIndex + 1 < NUM_SETS) {
            _setIndex++;
            await _loadSet(el, session, next);
        } else {
            await _finish(el, session, next);
        }
    });
}

// ---------------------------------------------------------------------------
// _finish — the final set's records were already saved incrementally by
// _renderRealismCheckForm. This is a defensive final write of the same full
// array (idempotent) before advancing, kept as a visible transition screen
// and a safety net if anything about the incremental save path changes later.
// ---------------------------------------------------------------------------
async function _finish(el, session, next) {
    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(5)}</div>
  <div class="lab-thinking">
    <div class="lab-dots"><div class="lab-dot"></div><div class="lab-dot"></div><div class="lab-dot"></div></div>
    Saving your responses…
  </div>
</div>`;

    const ok = await saveScenarios(session.id, _scenarios);
    if (!ok) {
        el.querySelector('.lab-wrap').innerHTML += `
<div class="lab-notice lab-err">Couldn't save your responses. Check your connection and try again.</div>
<button class="btn btn-primary" id="retry-save">Retry</button>`;
        el.querySelector('#retry-save').addEventListener('click', () => _finish(el, session, next));
        return;
    }

    session.scenarios = _scenarios;
    next();
}

// =============================================================================
// _generateCombos(cueLibrary, n)
// Produces n cue-combination objects with each cue's values balanced as
// evenly as possible and shuffled INDEPENDENTLY per cue, so cues don't
// correlate with each other by construction. Then does a light de-duplication
// pass so the same exact combination doesn't appear twice where avoidable.
// =============================================================================
function _generateCombos(cueLibrary, n) {
    if (cueLibrary.length === 0) return Array.from({ length: n }, () => ({}));

    const perCue = {};
    cueLibrary.forEach(cue => {
        const options = cue.options?.length ? cue.options : ['Yes', 'No'];
        const values  = [];
        while (values.length < n) values.push(...options);
        perCue[cue.id] = _shuffle(values.slice(0, n));
    });

    let combos = Array.from({ length: n }, (_, i) => {
        const combo = {};
        cueLibrary.forEach(cue => { combo[cue.id] = perCue[cue.id][i]; });
        return combo;
    });

    combos = _dedupeCombos(combos, cueLibrary);
    return combos;
}

// ---------------------------------------------------------------------------
// _dedupeCombos — swaps values between duplicate combinations where possible.
// With few cues/options a handful of natural repeats may be unavoidable —
// this is a best-effort pass, not a guarantee of uniqueness.
// ---------------------------------------------------------------------------
function _dedupeCombos(combos, cueLibrary) {
    const seen = new Map(); // signature -> first index

    for (let i = 0; i < combos.length; i++) {
        const sig = JSON.stringify(combos[i]);
        if (!seen.has(sig)) { seen.set(sig, i); continue; }

        // Duplicate found — try swapping one cue's value with a later index.
        for (const cue of cueLibrary) {
            for (let j = i + 1; j < combos.length; j++) {
                if (combos[j][cue.id] !== combos[i][cue.id]) {
                    const tmp = combos[i][cue.id];
                    combos[i][cue.id] = combos[j][cue.id];
                    combos[j][cue.id] = tmp;
                    break;
                }
            }
            if (JSON.stringify(combos[i]) !== sig) break;
        }
    }

    return combos;
}

// ---------------------------------------------------------------------------
// _shuffle — Fisher-Yates, in place, returns the same array for convenience.
// ---------------------------------------------------------------------------
function _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function _progressPct() {
    return Math.round(((_setIndex * SET_SIZE + _idxInSet) / TOTAL_SCENARIOS) * 100);
}

function _pips(active) {
    return Array.from({ length: 10 }, (_, i) => {
        const n   = i + 1;
        const cls = n === active ? 'active' : n < active ? 'done' : '';
        return `<div class="lab-pip ${cls}" title="Screen ${n}"></div>`;
    }).join('');
}

function _truncate(s, n) {
    if (!s) return '';
    return s.length > n ? s.slice(0, n).trim() + '…' : s;
}

function _optLabel(id, decisionOptions) {
    if (!id) return '(none)';
    const o = decisionOptions.find(o => o.id === id);
    return o ? o.label : id;
}

function _formatCombo(combo, cueLibrary) {
    const parts = Object.entries(combo ?? {}).map(([cueId, value]) => {
        const cue = cueLibrary.find(c => c.id === cueId);
        return `${cue ? cue.name : cueId}: ${value}`;
    });
    return parts.join(', ') || '(no cues)';
}

function _esc(s) {
    if (!s) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
