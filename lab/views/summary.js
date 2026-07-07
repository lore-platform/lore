// =============================================================================
// Lab — views/summary.js
// Screen 10 — Summary
//
// Two distinct viewers can land here:
//   - 'expert' — signed in normally, app.js's _getResumeView() routes them
//     here once their recipe.status === 'confirmed'.
//   - 'learner' — arrives via the unauthenticated ?transfer= link, after
//     app.js's bootstrap sees transfer.postRecipeScenarios already populated.
//
// Two distinct STATES, independent of viewer:
//   - Not yet transferred (no learner has completed both parts yet)
//   - Transferred (results exist and can be shown in full)
//
// render()'s 4th argument, viewerRole, comes straight from app.js's
// _viewerRole and is never guessed at here — this file trusts whatever it's
// told, it doesn't re-derive role from auth state itself.
//
// Match-rate maths mirrors transfer.js exactly (same expertPrediction
// comparison), recomputed here from the saved records rather than trusting
// only the single stored shiftMagnitude number — this keeps the two
// percentages (pre% / post%) and the shift consistent with each other on
// screen, and means a bug in one place can't silently disagree with the
// other.
//
// NOTE ON "where transfer worked / where gaps remain": Part 1 and Part 2 use
// DIFFERENT generated situations, not the same situation asked twice — so
// there's no literal per-scenario "before vs after" pairing available. The
// two lists below are drawn only from the POST-Recipe set: situations where
// the learner's post-Recipe choice did/didn't match the expert's predicted
// choice. That's an honest framing of what the data actually supports.
// =============================================================================

const SHARE_BASE = window.location.origin + window.location.pathname;

export function render(el, session, next, viewerRole = 'expert') {
    const transferDone = (session.transfer?.postRecipeScenarios?.length ?? 0) > 0;

    if (!transferDone) {
        _renderWaiting(el, session, viewerRole);
        return;
    }

    _renderResults(el, session, viewerRole);
}

// ---------------------------------------------------------------------------
// _renderWaiting — no learner has finished the transfer test yet.
// ---------------------------------------------------------------------------
function _renderWaiting(el, session, viewerRole) {
    if (viewerRole === 'learner') {
        // Shouldn't normally be reachable — app.js's bootstrap only routes a
        // learner to 'summary' once postRecipeScenarios exists — but kept as
        // a safe fallback in case of a manual reload mid-test or similar.
        el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(10)}</div>
  <div class="lab-notice lab-err">This transfer test isn't finished yet — go back and complete both parts to see your results.</div>
</div>`;
        return;
    }

    const shareUrl = `${SHARE_BASE}?transfer=${session.id}`;

    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(10)}</div>
  <h1 class="lab-h1">Waiting on a learner</h1>
  <p class="lab-sub">
    Your Recipe is confirmed. Share the link below with a learner — once they finish both
    parts of the transfer test, their results will appear here automatically next time you
    open this page.
  </p>

  <div class="lab-recipe-card">${_recipeDisplayHTML(session.recipe ?? {})}</div>

  <div class="lab-card">
    <div class="lab-section-head">Shareable link</div>
    <div class="lab-share-box">
      <input class="input" id="share-link" readonly value="${_esc(shareUrl)}">
      <button type="button" class="btn btn-primary btn-sm" id="copy-link">Copy</button>
    </div>
  </div>
</div>`;

    el.querySelector('#copy-link').addEventListener('click', () => {
        const input = el.querySelector('#share-link');
        input.select();
        navigator.clipboard?.writeText(input.value).catch(() => {});
        const btn = el.querySelector('#copy-link');
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
}

// ---------------------------------------------------------------------------
// _renderResults — full results, once a learner has completed both parts.
// ---------------------------------------------------------------------------
function _renderResults(el, session, viewerRole) {
    const t                = session.transfer;
    const cueLibrary       = session.cueLibrary      ?? [];
    const decisionOptions  = session.decisionOptions ?? [];

    const pre  = t.preRecipeScenarios  ?? [];
    const post = t.postRecipeScenarios ?? [];

    const preScored  = pre.filter(r  => r.expertPrediction !== null && r.expertPrediction !== undefined);
    const postScored = post.filter(r => r.expertPrediction !== null && r.expertPrediction !== undefined);

    const preMatchPct  = preScored.length  ? Math.round(preScored.filter(r  => r.selection === r.expertPrediction).length / preScored.length  * 100) : null;
    const postMatchPct = postScored.length ? Math.round(postScored.filter(r => r.selection === r.expertPrediction).length / postScored.length * 100) : null;

    const shiftPts  = Math.round((t.shiftMagnitude ?? 0) * 100);
    const shiftSign = shiftPts > 0 ? '+' : '';

    const categories = _categorise(post);

    const heading = viewerRole === 'learner' ? 'How your decisions shifted' : "Your learner's results";
    const sub = viewerRole === 'learner'
        ? "Here's how your choices before and after reading the Recipe compared to the expert's actual pattern."
        : "Here's how the learner's choices before and after reading your Recipe compared to your own actual pattern.";

    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(10)}</div>
  <h1 class="lab-h1">${heading}</h1>
  <p class="lab-sub">${sub}</p>

  <div class="lab-card">
    <div class="lab-section-head">Match rate against the expert's pattern</div>
    <div class="choice-row" style="gap:var(--space-6)">
      <div><strong style="font-size:var(--text-lg)">${preMatchPct ?? '—'}%</strong><div style="color:var(--warm-grey);font-size:var(--text-sm)">Before the Recipe</div></div>
      <div><strong style="font-size:var(--text-lg)">${postMatchPct ?? '—'}%</strong><div style="color:var(--warm-grey);font-size:var(--text-sm)">After the Recipe</div></div>
      <div><strong style="font-size:var(--text-lg)">${shiftSign}${shiftPts} pts</strong><div style="color:var(--warm-grey);font-size:var(--text-sm)">Shift</div></div>
    </div>
  </div>

  <div class="lab-card">
    <div class="lab-section-head">Summary</div>
    <p style="margin:0;font-size:var(--text-base);line-height:1.6;color:var(--ink)">${_esc(t.comparisonResult || '(no narrative saved)')}</p>
  </div>

  ${viewerRole === 'expert' ? `
  <div class="lab-card">
    <div class="lab-section-head">Your own Recipe accuracy rating (from Screen 8)</div>
    <p style="margin:0;color:var(--warm-grey)">${_esc(_validationLabel(session.recipe?.expertValidation))}</p>
  </div>` : ''}

  <div class="lab-card">
    <div class="lab-section-head">Where transfer worked</div>
    ${categories.postMatches.length
        ? `<ul class="lab-recipe-steps">${categories.postMatches.slice(0, 5).map(r => `<li>${_esc(_formatCombo(r.cueCombination, cueLibrary))} — picked "${_esc(_optLabel(r.selection, decisionOptions))}", matching the expert's pattern</li>`).join('')}</ul>`
        : `<p style="margin:0;color:var(--warm-grey)">No post-Recipe situations matched the expert's predicted pattern.</p>`}
  </div>

  <div class="lab-card">
    <div class="lab-section-head">Where gaps remain</div>
    ${categories.postMismatches.length
        ? `<ul class="lab-recipe-steps">${categories.postMismatches.slice(0, 5).map(r => `<li>${_esc(_formatCombo(r.cueCombination, cueLibrary))} — picked "${_esc(_optLabel(r.selection, decisionOptions))}"; the expert's pattern predicted "${_esc(_optLabel(r.expertPrediction, decisionOptions))}"</li>`).join('')}</ul>`
        : `<p style="margin:0;color:var(--warm-grey)">No mismatches remained after the Recipe.</p>`}
  </div>

  <div class="lab-card">
    <div class="lab-section-head">Research log</div>
    <p style="margin:0 0 var(--space-2) 0;color:var(--warm-grey);font-size:var(--text-sm)">Recipe accuracy rating: ${_esc(_validationLabel(session.recipe?.expertValidation))}</p>
    <p style="margin:0 0 var(--space-2) 0;color:var(--warm-grey);font-size:var(--text-sm)">Transfer shift magnitude: ${shiftSign}${shiftPts} percentage points</p>
    <p style="margin:0;color:var(--warm-grey);font-size:var(--text-sm)">Cue combinations scored: ${pre.length} pre-Recipe, ${post.length} post-Recipe</p>
  </div>
</div>`;
}

// ---------------------------------------------------------------------------
// _categorise — splits the POST-Recipe records only, into matches vs
// mismatches against the expert's predicted choice. See the file header
// note on why this can't be a literal pre/post "improved" pairing.
// ---------------------------------------------------------------------------
function _categorise(post) {
    const scored = post.filter(r => r.expertPrediction !== null && r.expertPrediction !== undefined);
    return {
        postMatches:    scored.filter(r => r.selection === r.expertPrediction),
        postMismatches: scored.filter(r => r.selection !== r.expertPrediction),
    };
}

function _validationLabel(v) {
    if (v === 'accurate')      return 'Accurate — confirmed as-is';
    if (v === 'needs-editing') return 'Needs editing — expert made corrections before confirming';
    if (v === 'send-back')     return 'Sent back for more elicitation';
    return '(not rated)';
}

// ---------------------------------------------------------------------------
// Shared helpers — same duplication pattern used across every view file.
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
