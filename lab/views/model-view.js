// =============================================================================
// Lab — views/model-view.js
// Screen 6 — Policy Summary Review
//
// On first entry, fits the decision tree, builds the bootstrap forest,
// detects policy breaks, computes feature importance, and generates the
// plain-language summary — all via model-fit.js — then saves the full
// policyModel bundle in one write. On a return visit (summaryText already
// present), skips straight to the review form using the saved data.
//
// The full { tree, forest, breaks, featureImportance } bundle is stored
// under policyModel.decisionTree so elicitation.js can read the exact
// same breaks later without re-running bagging (which is randomised and
// would not reproduce the same result on a second run).
// =============================================================================

import { savePolicyModel } from '../db.js';
import {
    fitDecisionTree,
    buildForest,
    detectPolicyBreaks,
    computeFeatureImportance,
    generatePolicySummary,
} from '../model-fit.js';

export async function render(el, session, next) {
    if (session.policyModel?.summaryText) {
        _renderReview(el, session, next);
        return;
    }

    await _computeAndRender(el, session, next);
}

// ---------------------------------------------------------------------------
// _computeAndRender — runs the full model-fit pipeline once, saves it, then
// shows the review form.
// ---------------------------------------------------------------------------
async function _computeAndRender(el, session, next) {
    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(6)}</div>
  <h1 class="lab-h1">Reviewing your decision pattern</h1>
  <div class="lab-thinking">
    <div class="lab-dots"><div class="lab-dot"></div><div class="lab-dot"></div><div class="lab-dot"></div></div>
    Analysing your 30 responses…
  </div>
</div>`;

    const cueLibrary      = session.cueLibrary      ?? [];
    const decisionOptions = session.decisionOptions ?? [];
    const scenarios       = session.scenarios       ?? [];

    console.log('Lab model-view.js: fitting tree on', scenarios.length, 'scenarios');
    const tree              = fitDecisionTree(scenarios, cueLibrary);
    const forest            = buildForest(scenarios, cueLibrary);
    const breaks            = detectPolicyBreaks(scenarios, forest, cueLibrary, decisionOptions);
    const featureImportance = computeFeatureImportance(tree, cueLibrary);

    const summaryResult = await generatePolicySummary(session, tree, featureImportance);

    if (!summaryResult.ok) {
        el.querySelector('.lab-wrap').innerHTML += `
<div class="lab-notice lab-err">Couldn't generate your policy summary. Check your connection and try again.</div>
<button class="btn btn-primary" id="retry-model">Retry</button>`;
        el.querySelector('#retry-model').addEventListener('click', () => _computeAndRender(el, session, next));
        return;
    }

    const policyModel = {
        decisionTree:         { tree, forest, breaks, featureImportance },
        summaryText:          summaryResult.summaryText,
        expertAccuracyRating: '',
        expertAccuracyNote:   '',
        policyBreaks:         breaks.map(b => b.description),
    };

    const ok = await savePolicyModel(session.id, policyModel);
    if (!ok) {
        el.querySelector('.lab-wrap').innerHTML += `
<div class="lab-notice lab-err">Couldn't save your policy model. Try again.</div>
<button class="btn btn-primary" id="retry-save">Retry</button>`;
        el.querySelector('#retry-save').addEventListener('click', () => _computeAndRender(el, session, next));
        return;
    }

    session.policyModel = policyModel;
    _renderReview(el, session, next);
}

// ---------------------------------------------------------------------------
// _renderReview — shows the statements and captures the expert's rating.
// ---------------------------------------------------------------------------
function _renderReview(el, session, next) {
    const statements = (session.policyModel.summaryText ?? '')
        .split('\n\n')
        .map(s => s.trim())
        .filter(Boolean);

    let rating = session.policyModel.expertAccuracyRating || '';

    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(6)}</div>
  <h1 class="lab-h1">Here's what we picked up on</h1>
  <p class="lab-sub">
    These statements describe the pattern the system found in your 30 responses.
    They're a mirror, not a judgement — tell us if it's off.
  </p>

  <div id="statements-wrap">
    ${statements.map(s => `<div class="lab-card"><p style="margin:0;font-size:var(--text-base);line-height:1.6;color:var(--ink)">${_esc(s)}</p></div>`).join('')}
  </div>

  <div class="lab-card">
    <div class="lab-section-head">Is this accurate?</div>
    <div class="choice-row" id="rating-choices">
      ${_ratingBtn('accurate',   'Accurate',            rating)}
      ${_ratingBtn('partial',    'Partially accurate',  rating)}
      ${_ratingBtn('inaccurate', 'Inaccurate',          rating)}
    </div>

    <div id="rating-note-wrap" style="display:${rating && rating !== 'accurate' ? '' : 'none'};margin-top:var(--space-4)">
      <label class="label" for="rating-note">What's specifically wrong or missing?</label>
      <textarea class="input" id="rating-note" rows="3"
        placeholder="Be specific — this shapes the follow-up questions in the next step.">${_esc(session.policyModel.expertAccuracyNote ?? '')}</textarea>
    </div>
  </div>

  <div id="model-err" class="lab-notice lab-err" style="display:none"></div>

  <div class="lab-btn-row">
    <button type="button" class="btn btn-primary" id="model-submit">Continue</button>
  </div>
</div>`;

    el.querySelectorAll('.rating-pick').forEach(btn => {
        btn.addEventListener('click', () => {
            rating = btn.dataset.rating;
            el.querySelectorAll('.rating-pick').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            el.querySelector('#rating-note-wrap').style.display = rating !== 'accurate' ? '' : 'none';
        });
    });

    el.querySelector('#model-submit').addEventListener('click', async () => {
        const errEl = el.querySelector('#model-err');

        if (!rating) {
            errEl.textContent   = 'Please choose how accurate this is before continuing.';
            errEl.style.display = '';
            return;
        }

        const note = el.querySelector('#rating-note').value.trim();
        if (rating !== 'accurate' && !note) {
            errEl.textContent   = 'Please describe what\'s off — this helps the next step focus on the right cases.';
            errEl.style.display = '';
            return;
        }
        errEl.style.display = 'none';

        const btn = el.querySelector('#model-submit');
        btn.disabled    = true;
        btn.textContent = 'Saving…';

        const updated = {
            ...session.policyModel,
            expertAccuracyRating: rating,
            expertAccuracyNote:   rating === 'accurate' ? '' : note,
        };

        const ok = await savePolicyModel(session.id, updated);
        if (!ok) {
            errEl.textContent   = "Couldn't save your rating. Try again.";
            errEl.style.display = '';
            btn.disabled    = false;
            btn.textContent = 'Continue';
            return;
        }

        session.policyModel = updated;
        next();
    });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function _ratingBtn(value, label, current) {
    return `<button type="button" class="choice-btn rating-pick ${current === value ? 'selected' : ''}" data-rating="${value}">${label}</button>`;
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
