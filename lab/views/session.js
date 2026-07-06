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
// responses. All 30 records are saved in a single write at the very end
// (matches db.js's saveScenarios comment: "called once the 30-scenario
// session completes").
//
// DECISION FLAGGED IN CHAT: structuredSelection stores the chosen decision
// option's `id` (not its label text) — model-fit.js's break descriptions
// and the eventual policy model depend on this.
// =============================================================================

import { generate }        from '../../engine/ai.js';
import { extractJSON }     from '../../engine/utils.js';
import { saveScenarios }   from '../db.js';

const TOTAL_SCENARIOS = 30;
const NUM_SETS         = 5;
const SET_SIZE         = 6;

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
    _combos     = _generateCombos(session.cueLibrary ?? [], TOTAL_SCENARIOS);
    _scenarios  = [];
    _setIndex   = 0;

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
You will be given a specific combination of underlying factors for each situation — the situation you write
must be consistent with EVERY factor given, but must NOT name the factor or its label directly. Show it
naturally through the details of the situation, the way it would actually appear in someone's day.
Do not mention any decision options, right answers, or scoring — you are only describing the situation.

Return a JSON array of exactly ${setCombos.length} strings, in the same order as the factor combinations given
below — nothing else, no markdown fences, no other text.`;

    const comboLines = setCombos.map((combo, i) => {
        const parts = Object.entries(combo).map(([cueId, value]) => {
            const cue = cueLibrary.find(c => c.id === cueId);
            return cue ? `${cue.name}: ${value}` : `${cueId}: ${value}`;
        });
        return `Situation ${i + 1} — ${parts.join(', ')}`;
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
      <label class="label" for="free-elaborate">Anything you'd add? (optional)</label>
      <textarea class="input" id="free-elaborate" rows="2"
        placeholder="Any nuance worth noting — no need to explain your reasoning fully"></textarea>
    </div>
  </div>

  <div id="scenario-err" class="lab-notice lab-err" style="display:none"></div>

  <div class="lab-btn-row">
    <button type="button" class="btn btn-primary" id="scenario-next" disabled>Next</button>
  </div>
</div>`;

    el.querySelectorAll('.choice-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            _selectedOpt = btn.dataset.id;
            el.querySelectorAll('.choice-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            el.querySelector('#scenario-next').disabled = false;
            el.querySelector('#scenario-err').style.display = 'none';
        });
    });

    el.querySelector('#scenario-next').addEventListener('click', () => {
        if (!_selectedOpt) {
            const errEl = el.querySelector('#scenario-err');
            errEl.textContent   = 'Please choose an option before continuing.';
            errEl.style.display = '';
            return;
        }

        const freeText = el.querySelector('#free-elaborate').value.trim();
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
            _renderRealismCheck(el, session, next);
        }
    });
}

// ---------------------------------------------------------------------------
// _renderRealismCheck — shown after every set of 6. Asks whether any of
// the 6 situations just seen felt unrealistic, and if so, which one and why.
// ---------------------------------------------------------------------------
function _renderRealismCheck(el, session, next) {
    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(5)}</div>
  <div class="lab-prog"><div class="lab-prog-fill" style="width:${_progressPct()}%"></div></div>

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

        _scenarios.push(..._setRecords);

        if (_setIndex + 1 < NUM_SETS) {
            _setIndex++;
            await _loadSet(el, session, next);
        } else {
            await _finish(el, session, next);
        }
    });
}

// ---------------------------------------------------------------------------
// _finish — saves the full 30-scenario array in one write, then advances.
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

function _esc(s) {
    if (!s) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
