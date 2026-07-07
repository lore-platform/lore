// =============================================================================
// Lab — views/transfer.js
// Screen 9 — Transfer Test (Learner)
//
// Reached ONLY via app.js's unauthenticated ?transfer=<sessionId> path — see
// the header comment in app.js for how a learner gets here with no sign-in.
// render() is called with a 4th argument, viewerRole, which will always be
// 'learner' in practice (app.js only routes here for the link flow), but the
// param is accepted for signature parity with summary.js.
//
// Flow: intro -> 15 pre-Recipe scenarios -> read the Recipe -> 15 post-Recipe
// scenarios -> compare -> next() (advances to Screen 10 / summary.js).
//
// FLAGGED DATA MODEL EXTENSION (confirmed with the expert building this):
// the spec's transfer.preRecipeScenarios/postRecipeScenarios items are
// documented as just { scenarioId, selection }. That shape can't support
// Screen 10's requirement to show "cue combinations where transfer succeeded
// or failed," so each record here also carries cueCombination, text, and
// expertPrediction (see below). Additive only — nothing removed or renamed.
//
// SCORING METHOD: rather than asking a classify() call to judge the shift
// (the spec's literal wording), this uses predictWithForest() from
// model-fit.js — the SAME forest already fit on the expert's own 30
// scenarios in model-view.js — to get an objective, reproducible prediction
// per transfer scenario. shiftMagnitude is (post match rate - pre match
// rate), a plain decimal fraction. One generate() call still produces a
// short plain-language narrative for people to read; the number itself
// never depends on that call succeeding.
//
// No free-text elaboration field here (unlike session.js) — the spec only
// asks for "structured selection required" on this screen. No realism
// checks either — those are a Screen 5 (expert capture) concept.
//
// Combo generation duplicates session.js's private _generateCombos /
// _dedupeCombos / _shuffle helpers verbatim. They're not exported from
// session.js, so this is deliberate duplication, consistent with how every
// other view file in this app keeps its own private _pips/_esc copies.
// =============================================================================

import { generate }        from '../../engine/ai.js';
import { extractJSON }     from '../../engine/utils.js';
import { saveTransfer }    from '../db.js';
import { predictWithForest } from '../model-fit.js';

const SCENARIOS_PER_PHASE = 15;

// ---------------------------------------------------------------------------
// Module-level state — reset at the top of render().
// ---------------------------------------------------------------------------
let _phase       = 'pre';   // 'pre' | 'post'
let _items       = [];      // [{ cueCombination, text }] for the current phase
let _idx         = 0;
let _preRecords  = [];
let _postRecords = [];
let _selectedOpt = null;

export async function render(el, session, next, viewerRole = 'learner') {
    const t = session.transfer ?? {};

    if (t.postRecipeScenarios?.length) {
        // Both phases already saved (e.g. a stale re-render) — nothing left
        // to do on this screen; app.js's bootstrap should already have sent
        // this case to 'summary', but this guard keeps it safe either way.
        next();
        return;
    }

    if (t.preRecipeScenarios?.length) {
        // Resuming after a reload mid-way through — Part 1 is already saved,
        // so don't regenerate or re-ask it. Go straight to the interstitial.
        _preRecords = t.preRecipeScenarios.map(r => ({ ...r }));
        _renderInterstitial(el, session, next);
        return;
    }

    _phase       = 'pre';
    _preRecords  = [];
    _postRecords = [];
    _renderIntro(el, session, next);
}

// ---------------------------------------------------------------------------
// _renderIntro — a short explanation before Part 1 begins. Worth having
// since a learner arrives here cold, with zero other context on the page.
// ---------------------------------------------------------------------------
function _renderIntro(el, session, next) {
    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(9)}</div>
  <h1 class="lab-h1">Transfer test</h1>
  <p class="lab-sub">
    No account needed. You'll see 15 short situations and pick what you'd do for each —
    then you'll read the expert's Recipe, and see 15 more.
  </p>

  <div class="lab-explain-card">
    <p>
      There's no scoring shown to you during this test, and no right or wrong answers
      displayed at any point — just pick whatever you'd genuinely do in each situation.
    </p>
  </div>

  <div class="lab-btn-row">
    <button type="button" class="btn btn-primary" id="begin-transfer">Begin Part 1</button>
  </div>
</div>`;

    el.querySelector('#begin-transfer').addEventListener('click', () => _loadPhase('pre', el, session, next));
}

// ---------------------------------------------------------------------------
// _loadPhase — generates SCENARIOS_PER_PHASE vignette texts in one generate()
// call (no per-set splitting needed here — 15 short vignettes fit comfortably
// under the 4096-token cap), then renders the first scenario of the phase.
// ---------------------------------------------------------------------------
async function _loadPhase(phase, el, session, next) {
    _phase = phase;
    _idx   = 0;

    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(9)}</div>
  <div class="lab-thinking">
    <div class="lab-dots"><div class="lab-dot"></div><div class="lab-dot"></div><div class="lab-dot"></div></div>
    Preparing ${phase === 'pre' ? 'Part 1' : 'Part 2'}…
  </div>
</div>`;

    const cueLibrary = session.cueLibrary ?? [];
    const combos     = _generateCombos(cueLibrary, SCENARIOS_PER_PHASE);
    const p          = session.profile ?? {};

    const systemPrompt = `You write short, realistic professional situations for a decision-making exercise, used to
test whether someone has picked up a specific professional's judgement.
Each situation must be written in second person ("You are...", "You receive...") and be 2-4 sentences long.
You will be given a specific combination of underlying factors for each situation — the situation you write
must be consistent with EVERY factor given, but must NOT name the factor or its label directly. Show it
naturally through the details of the situation.
Do not mention any decision options, right answers, or scoring — you are only describing the situation.

Return a JSON array of exactly ${combos.length} strings, in the same order as the factor combinations given
below — nothing else, no markdown fences, no other text.`;

    const comboLines = combos.map((combo, i) => {
        const parts = Object.entries(combo).map(([cueId, value]) => {
            const cue = cueLibrary.find(c => c.id === cueId);
            return cue ? `${cue.name}: ${value}` : `${cueId}: ${value}`;
        });
        return `Situation ${i + 1} — ${parts.join(', ')}`;
    }).join('\n');

    const prompt = `Area of expertise: ${p.role}
What the work involves: ${p.whatYouDo}

Write ${combos.length} situations, one per line below, each consistent with its listed factors:
${comboLines}

Return a JSON array of ${combos.length} situation strings, in order.`;

    const result = await generate(prompt, systemPrompt);
    const texts  = result.ok ? extractJSON(result.text) : null;

    if (!texts || !Array.isArray(texts) || texts.length < combos.length) {
        el.querySelector('.lab-wrap').innerHTML += `
<div class="lab-notice lab-err">Couldn't generate this part of the test. Check your connection and try again.</div>
<button class="btn btn-primary" id="retry-phase">Retry</button>`;
        el.querySelector('#retry-phase').addEventListener('click', () => _loadPhase(phase, el, session, next));
        return;
    }

    _items = combos.map((combo, i) => ({ cueCombination: combo, text: texts[i] }));
    _renderScenario(el, session, next);
}

// ---------------------------------------------------------------------------
// _renderScenario — one scenario card: text, decision option buttons, Next.
// ---------------------------------------------------------------------------
function _renderScenario(el, session, next) {
    const item          = _items[_idx];
    const options       = session.decisionOptions ?? [];
    const totalInPhase  = _items.length;
    const phaseLabel    = _phase === 'pre' ? 'Part 1 of 2' : 'Part 2 of 2';
    _selectedOpt        = null;

    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(9)}</div>
  <div class="lab-prog"><div class="lab-prog-fill" style="width:${Math.round((_idx / totalInPhase) * 100)}%"></div></div>
  <p class="lab-sub" style="margin-bottom:var(--space-4)">${phaseLabel} · Situation ${_idx + 1} of ${totalInPhase}</p>

  <div class="lab-scenario-card">${_esc(item.text)}</div>

  <div class="lab-card">
    <div class="lab-section-head">What would you do?</div>
    <div class="choice-row" id="opt-choices">
      ${options.map(o => `
        <button type="button" class="choice-btn" data-id="${o.id}" title="${_esc(o.description ?? '')}">
          ${_esc(o.label)}
        </button>`).join('')}
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

        const forest    = session.policyModel?.decisionTree?.forest ?? [];
        const predicted = predictWithForest(forest, item.cueCombination).label;

        const record = {
            scenarioId:       `xfer-${_phase}-${Date.now()}-${_idx}`,
            cueCombination:   item.cueCombination,
            text:             item.text,
            selection:        _selectedOpt,
            expertPrediction: predicted,
        };

        if (_phase === 'pre') _preRecords.push(record);
        else _postRecords.push(record);

        _idx++;
        if (_idx < totalInPhase) {
            _renderScenario(el, session, next);
        } else if (_phase === 'pre') {
            _finishPrePhase(el, session, next);
        } else {
            _finishPostPhase(el, session, next);
        }
    });
}

// ---------------------------------------------------------------------------
// _finishPrePhase — saves Part 1's records immediately (protects against
// losing them if the learner closes the tab during the Recipe interstitial),
// then shows the Recipe.
// ---------------------------------------------------------------------------
async function _finishPrePhase(el, session, next) {
    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(9)}</div>
  <div class="lab-thinking">
    <div class="lab-dots"><div class="lab-dot"></div><div class="lab-dot"></div><div class="lab-dot"></div></div>
    Saving Part 1…
  </div>
</div>`;

    const partial = {
        learnerUid:          '',
        preRecipeScenarios:  _preRecords,
        postRecipeScenarios: [],
        comparisonResult:    '',
        shiftMagnitude:      0,
    };

    const ok = await saveTransfer(session.id, partial);
    if (!ok) {
        el.querySelector('.lab-wrap').innerHTML += `
<div class="lab-notice lab-err">Couldn't save Part 1. Check your connection and try again.</div>
<button class="btn btn-primary" id="retry-save-pre">Retry</button>`;
        el.querySelector('#retry-save-pre').addEventListener('click', () => _finishPrePhase(el, session, next));
        return;
    }

    session.transfer = partial;
    _renderInterstitial(el, session, next);
}

// ---------------------------------------------------------------------------
// _renderInterstitial — the Recipe, plus a confirmation tap before Part 2.
// ---------------------------------------------------------------------------
function _renderInterstitial(el, session, next) {
    const r = session.recipe ?? {};

    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(9)}</div>
  <h1 class="lab-h1">Part 1 complete — here's the Recipe</h1>
  <p class="lab-sub">
    Read it carefully. Part 2 will show you 15 new situations and ask what you'd do,
    now that you have this to work from.
  </p>

  <div class="lab-recipe-card">${_recipeDisplayHTML(r)}</div>

  <div class="lab-btn-row">
    <button type="button" class="btn btn-primary" id="start-part-two">I've read this — start Part 2</button>
  </div>
</div>`;

    el.querySelector('#start-part-two').addEventListener('click', () => {
        _loadPhase('post', el, session, next);
    });
}

// ---------------------------------------------------------------------------
// _finishPostPhase — deterministic scoring, one narrative generate() call,
// full save, then advance to Screen 10.
// ---------------------------------------------------------------------------
async function _finishPostPhase(el, session, next) {
    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(9)}</div>
  <div class="lab-thinking">
    <div class="lab-dots"><div class="lab-dot"></div><div class="lab-dot"></div><div class="lab-dot"></div></div>
    Comparing your decisions to the expert's pattern…
  </div>
</div>`;

    const cueLibrary      = session.cueLibrary      ?? [];
    const decisionOptions = session.decisionOptions ?? [];

    const preScored  = _preRecords.filter(r  => r.expertPrediction !== null);
    const postScored = _postRecords.filter(r => r.expertPrediction !== null);

    const preMatchRate  = preScored.length  ? preScored.filter(r  => r.selection === r.expertPrediction).length / preScored.length  : null;
    const postMatchRate = postScored.length ? postScored.filter(r => r.selection === r.expertPrediction).length / postScored.length : null;

    const shiftMagnitude = (preMatchRate !== null && postMatchRate !== null) ? (postMatchRate - preMatchRate) : 0;

    const narrative = await _generateNarrative(session, preMatchRate, postMatchRate, cueLibrary, decisionOptions);

    const full = {
        learnerUid:          '',
        preRecipeScenarios:  _preRecords,
        postRecipeScenarios: _postRecords,
        comparisonResult:    narrative,
        shiftMagnitude,
    };

    const ok = await saveTransfer(session.id, full);
    if (!ok) {
        el.querySelector('.lab-wrap').innerHTML += `
<div class="lab-notice lab-err">Couldn't save your results. Check your connection and try again.</div>
<button class="btn btn-primary" id="retry-save-post">Retry</button>`;
        el.querySelector('#retry-save-post').addEventListener('click', () => _finishPostPhase(el, session, next));
        return;
    }

    session.transfer = full;
    next();
}

// ---------------------------------------------------------------------------
// _generateNarrative — one generate() call for a short, honest summary.
// Falls back to a numbers-only sentence if the call fails, so the result
// screen is never left blank just because the AI service hiccuped.
// ---------------------------------------------------------------------------
async function _generateNarrative(session, preMatchRate, postMatchRate, cueLibrary, decisionOptions) {
    if (preMatchRate === null || postMatchRate === null) {
        return "The expert's decision pattern wasn't clear enough from their scenario session to score this comparison precisely — the pre- and post-Recipe responses are saved, but no shift percentage could be computed.";
    }

    const examples = _postRecords.slice(0, 5).map((r, i) => {
        const comboText = _formatCombo(r.cueCombination, cueLibrary);
        const picked     = _optLabel(r.selection, decisionOptions);
        const expertPick = _optLabel(r.expertPrediction, decisionOptions);
        return `Example ${i + 1} — ${comboText}. Learner picked "${picked}"; expert pattern predicted "${expertPick}".`;
    }).join('\n');

    const p = session.profile ?? {};
    const systemPrompt = `You are summarising a knowledge-transfer test result for both the expert and the learner to read.
A learner answered 15 situations before reading the expert's Recipe, then 15 new situations after reading it.
Their answers are scored against the expert's actual decision pattern from an earlier session.

Return a JSON object with exactly this field:
{ "narrative": "3-4 plain-language sentences describing whether and where the learner's decisions shifted toward the expert's pattern, and where gaps remain. Neutral, third-person, no jargon." }
Return the JSON object only — no other text.`;

    const prompt = `Area of expertise: ${p.role}
Before reading the Recipe, the learner matched the expert's pattern ${Math.round(preMatchRate * 100)}% of the time.
After reading the Recipe, they matched it ${Math.round(postMatchRate * 100)}% of the time.

A few specific post-Recipe examples:
${examples || '(none)'}

Write the narrative. Return the JSON object.`;

    const result = await generate(prompt, systemPrompt);
    const parsed = result.ok ? extractJSON(result.text) : null;

    if (parsed?.narrative) return parsed.narrative;

    const direction = postMatchRate > preMatchRate
        ? 'moved toward'
        : postMatchRate < preMatchRate
            ? 'moved away from'
            : 'stayed at the same distance from';

    return `The learner's decisions ${direction} the expert's pattern after reading the Recipe — matching ${Math.round(preMatchRate * 100)}% of scenarios before, and ${Math.round(postMatchRate * 100)}% after.`;
}

// =============================================================================
// _generateCombos / _dedupeCombos / _shuffle
// Duplicated verbatim from session.js's private helpers — not exported there,
// so not importable. Same balanced-shuffle-per-cue approach, same
// best-effort de-duplication pass.
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

function _dedupeCombos(combos, cueLibrary) {
    const seen = new Map();

    for (let i = 0; i < combos.length; i++) {
        const sig = JSON.stringify(combos[i]);
        if (!seen.has(sig)) { seen.set(sig, i); continue; }

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
function _formatCombo(combo, cueLibrary) {
    const parts = Object.entries(combo ?? {}).map(([cueId, value]) => {
        const cue = cueLibrary.find(c => c.id === cueId);
        return `${cue ? cue.name : cueId}: ${value}`;
    });
    return parts.join(', ') || '(no cues)';
}

function _optLabel(id, decisionOptions) {
    if (!id) return '(none)';
    const o = decisionOptions.find(o => o.id === id);
    return o ? o.label : id;
}

function _recipeDisplayHTML(r) {
    return `
<div class="lab-recipe-section">
  <div class="lab-recipe-label">Trigger</div>
  <div class="lab-recipe-value">${_esc(r.trigger)}</div>
</div>
<div class="lab-recipe-section">
  <div class="lab-recipe-label">Action sequence</div>
  <ol class="lab-recipe-steps">
    ${(r.actionSequence ?? []).map(s => `<li>${_esc(s)}</li>`).join('')}
  </ol>
</div>
<div class="lab-recipe-section">
  <div class="lab-recipe-label">Expected outcome</div>
  <div class="lab-recipe-value">${_esc(r.expectedOutcome)}</div>
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
