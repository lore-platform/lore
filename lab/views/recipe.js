// =============================================================================
// Lab — views/recipe.js
// Screen 8 — Recipe Review
//
// Three sequential classify() calls, directly modelled on the main Lore
// app's recipes.js -> processExtraction() staged pipeline:
//   Stage 1 — Quality check: is there a non-obvious expert-specific skill here?
//   Stage 2 — Extraction: what is the actual knowledge, independent of format?
//   Stage 3 — Formatting: Trigger / Action Sequence / Expected Outcome as JSON.
// Stage 3 reads ONLY the Stage 2 output — never the raw session data directly
// — same separation principle as the main app: the Recipe is derived from
// understood knowledge, not pattern-matched from raw transcripts.
//
// FLAGGED DECISION 1 — Stage 1 "no knowledge found" handling: the main app
// stops extraction entirely in that case. Here, the expert has already been
// through structured elicitation by the time they reach this screen, so a
// weak Stage 1 result is treated as a caution banner, not a hard stop — we
// still produce a best-effort draft, since "Send back" already gives the
// expert a way to add more material if the draft doesn't hold up.
//
// FLAGGED DECISION 2 — Share link format: transfer.js/summary.js don't exist
// yet (Step 3). The link below assumes `?transfer=<sessionId>` as the query
// param transfer.js will read — same pattern as the main app's invite links
// in auth.js (`?invite=<id>`). Confirm/adjust this when we build Step 3.
//
// "Send back" navigates BACKWARD to Screen 7 by importing showView directly
// from app.js — the forward-only next() callback can't do this. This creates
// a circular import (app.js <-> recipe.js), which is safe here because
// showView is only ever called from inside an event handler, long after
// both modules have finished loading.
// =============================================================================

import { classify }    from '../../engine/ai.js';
import { extractJSON } from '../../engine/utils.js';
import { saveRecipe }  from '../db.js';
import { showView }    from '../app.js';

const SHARE_BASE = 'https://lore-platform.github.io/lore/lab/index.html';

export async function render(el, session, next) {
    if (session.recipe?.status === 'confirmed') {
        _renderConfirmed(el, session);
        return;
    }

    const needsRecompute = !session.recipe?.trigger
        || session.recipe?.expertValidation === 'send-back';

    if (needsRecompute) {
        await _computeRecipe(el, session, next);
    } else {
        _renderReview(el, session, next, false);
    }
}

// =============================================================================
// _computeRecipe — the three-stage classify pipeline.
// =============================================================================
async function _computeRecipe(el, session, next) {
    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(8)}</div>
  <h1 class="lab-h1">Building your Recipe</h1>
  <div class="lab-thinking">
    <div class="lab-dots"><div class="lab-dot"></div><div class="lab-dot"></div><div class="lab-dot"></div></div>
    Checking for a genuine pattern…
  </div>
</div>`;

    const context = _buildContext(session);

    // ---- Stage 1 — Quality check -------------------------------------------
    const stage1System = `You are a knowledge-quality classifier. Your only job is to decide whether the material below
demonstrates genuine expert decision logic — a specific pattern of professional judgement a less
experienced person would not automatically apply.
Genuine expert decision logic: (1) triggered by a specific, recognisable situation, (2) involves a
non-obvious response experience teaches, (3) produces a meaningfully better outcome when applied.
General advice, vague preferences, and obvious statements do not qualify.

Return a JSON object with exactly these fields:
{ "hasKnowledge": true | false, "confidence": "high" | "medium" | "low" }
Return the JSON object only — no other text.`;

    const stage1Result = await classify(`${context}\n\nDoes this contain genuine expert decision logic? Return the JSON object.`, stage1System);
    const stage1 = stage1Result.ok ? extractJSON(stage1Result.text) : null;

    if (!stage1Result.ok) {
        _showComputeError(el, session, next, "The AI service didn't respond. Try again.");
        return;
    }

    const weakSignal = !stage1 || stage1.hasKnowledge === false;
    if (weakSignal) {
        console.warn('Lab recipe.js: Stage 1 found no clear expert-specific pattern — proceeding with a best-effort draft anyway.');
    }

    _setStage(el, 'Extracting the underlying knowledge…');

    // ---- Stage 2 — Extraction -----------------------------------------------
    const stage2System = `You are extracting a structured knowledge representation from a professional's decision-capture session.
Your job is to articulate the specific expertise demonstrated — not yet format it as a training recipe.

Return a JSON object with exactly these fields:
{
  "extractedKnowledge": "2-3 sentences describing the actual expertise, independent of any particular format — what this person specifically knows or notices that others in their field would miss"
}
Return the JSON object only — no other text.`;

    const stage2Result = await classify(`${context}\n\nExtract the knowledge representation. Return the JSON object.`, stage2System);
    if (!stage2Result.ok) {
        _showComputeError(el, session, next, "The AI service didn't respond during extraction. Try again.");
        return;
    }
    const stage2 = extractJSON(stage2Result.text);
    if (!stage2 || !stage2.extractedKnowledge) {
        _showComputeError(el, session, next, "Couldn't make sense of the extracted knowledge. Try again.");
        return;
    }

    _setStage(el, 'Formatting the Recipe…');

    // ---- Stage 3 — Formatting -------------------------------------------------
    // Reads ONLY stage2's output — never the raw session context directly.
    const stage3System = `You are producing a Recipe from a structured knowledge representation.
A Recipe is a concise, actionable description of a professional skill, precise enough to teach to someone else.
Work only from the knowledge representation given — do not invent details beyond it.

Return a JSON object with exactly these fields:
{
  "trigger": "The specific situation that calls for this skill — one sentence, concrete and recognisable",
  "actionSequence": ["First step", "Second step", "Third step"] — an array of 2 to 5 short imperative steps,
  "expectedOutcome": "What successful application of this produces — one sentence"
}
Return the JSON object only — no other text.`;

    const stage3Prompt = `Knowledge representation:\n${stage2.extractedKnowledge}\n\nDerive a Recipe from this. Return the JSON object.`;
    const stage3Result = await classify(stage3Prompt, stage3System);
    if (!stage3Result.ok) {
        _showComputeError(el, session, next, "The AI service didn't respond while formatting the Recipe. Try again.");
        return;
    }
    const stage3 = extractJSON(stage3Result.text);
    if (!stage3 || !stage3.trigger) {
        _showComputeError(el, session, next, "Couldn't format the Recipe. Try again.");
        return;
    }

    const recipe = {
        extractedKnowledge:   stage2.extractedKnowledge,
        trigger:              stage3.trigger,
        actionSequence:       Array.isArray(stage3.actionSequence) ? stage3.actionSequence : [],
        expectedOutcome:      stage3.expectedOutcome ?? '',
        expertValidation:     '',
        expertValidationNote: '',
        status:               'draft',
    };

    const ok = await saveRecipe(session.id, recipe);
    if (!ok) {
        _showComputeError(el, session, next, "Couldn't save your Recipe draft. Try again.");
        return;
    }

    session.recipe = recipe;
    _renderReview(el, session, next, weakSignal);
}

function _setStage(el, label) {
    const thinking = el.querySelector('.lab-thinking');
    if (thinking) thinking.lastChild.textContent = label;
}

function _showComputeError(el, session, next, message) {
    el.querySelector('.lab-wrap').innerHTML += `
<div class="lab-notice lab-err">${_esc(message)}</div>
<button class="btn btn-primary" id="retry-recipe">Retry</button>`;
    el.querySelector('#retry-recipe').addEventListener('click', () => _computeRecipe(el, session, next));
}

// ---------------------------------------------------------------------------
// _buildContext — assembles everything the classify pipeline needs from the
// session: profile, cue library, decision options, policy summary and
// breaks, and the full elicitation transcript (including the triad).
// ---------------------------------------------------------------------------
function _buildContext(session) {
    const p               = session.profile         ?? {};
    const cueLibrary      = session.cueLibrary      ?? [];
    const decisionOptions = session.decisionOptions ?? [];
    const policyModel     = session.policyModel     ?? {};
    const elicitation     = session.elicitation     ?? { cases: [], triad: {} };

    const transcripts = (elicitation.cases ?? []).map((c, i) =>
        `Case ${i + 1}:\n` + c.exchange.map(t => `${t.role === 'system' ? 'Interviewer' : 'Expert'}: ${t.content}`).join('\n')
    ).join('\n\n');

    return `Area of expertise: ${p.role}
What their work involves: ${p.whatYouDo}
Decision types: ${p.decisionTypes}

Cue library: ${cueLibrary.map(c => `${c.name} (${c.definition})`).join('; ')}
Decision options: ${decisionOptions.map(o => o.label).join(', ')}

Policy summary from the scenario session:
${policyModel.summaryText ?? '(none)'}

Policy breaks explored in the elicitation session:
${(policyModel.policyBreaks ?? []).join('\n') || '(none)'}

Elicitation transcripts:
${transcripts || '(no cases explored)'}

Repertory grid triad answer: ${elicitation.triad?.discriminationAnswer || '(not answered)'}`;
}

// =============================================================================
// _renderReview — the main Recipe display and the three-way expert response.
// =============================================================================
function _renderReview(el, session, next, weakSignal) {
    const r = session.recipe;

    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(8)}</div>
  <h1 class="lab-h1">Your Recipe</h1>
  <p class="lab-sub">Review the draft below. Does it accurately represent how you actually make these decisions?</p>

  ${weakSignal ? `<div class="lab-notice lab-info">
    The system found this pattern harder to pin down than usual — take extra care reviewing it, and use
    "Send back" if it doesn't feel right.
  </div>` : ''}

  <div class="lab-recipe-card" id="recipe-display">
    ${_recipeDisplayHTML(r)}
  </div>

  <div class="lab-card">
    <div class="lab-section-head">Does this accurately represent what you do?</div>
    <div class="choice-row">
      <button type="button" class="choice-btn" id="btn-accurate">Accurate</button>
      <button type="button" class="choice-btn" id="btn-editing">Needs editing</button>
      <button type="button" class="choice-btn" id="btn-sendback">Send back</button>
    </div>
  </div>

  <div id="recipe-action-wrap"></div>
  <div id="recipe-err" class="lab-notice lab-err" style="display:none"></div>
</div>`;

    el.querySelector('#btn-accurate').addEventListener('click', () => _confirmAccurate(el, session, next));
    el.querySelector('#btn-editing').addEventListener('click', () => _showEditForm(el, session, next));
    el.querySelector('#btn-sendback').addEventListener('click', () => _showSendBackForm(el, session));
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
</div>
<div class="lab-recipe-section">
  <div class="lab-recipe-label">Extracted knowledge</div>
  <div class="lab-recipe-value" style="color:var(--warm-grey);font-style:italic">${_esc(r.extractedKnowledge)}</div>
</div>`;
}

// ---------------------------------------------------------------------------
// _confirmAccurate — locks the Recipe in and shows the share link.
// ---------------------------------------------------------------------------
async function _confirmAccurate(el, session, next) {
    const updated = { ...session.recipe, expertValidation: 'accurate', expertValidationNote: '', status: 'confirmed' };

    const actionWrap = el.querySelector('#recipe-action-wrap');
    actionWrap.innerHTML = `<div class="lab-thinking"><div class="lab-dots"><div class="lab-dot"></div><div class="lab-dot"></div><div class="lab-dot"></div></div>Saving…</div>`;

    const ok = await saveRecipe(session.id, updated);
    if (!ok) {
        actionWrap.innerHTML = '';
        const errEl = el.querySelector('#recipe-err');
        errEl.textContent   = "Couldn't save. Try again.";
        errEl.style.display = '';
        return;
    }

    session.recipe = updated;
    _renderConfirmed(el, session);
}

// ---------------------------------------------------------------------------
// _showEditForm — inline edit fields. Action sequence is edited as one step
// per line (simplest editor for MVP scope — a per-step add/remove list like
// options.js's could replace this later if that's worth the extra UI).
// ---------------------------------------------------------------------------
function _showEditForm(el, session, next) {
    const r = session.recipe;
    const actionWrap = el.querySelector('#recipe-action-wrap');

    actionWrap.innerHTML = `
<div class="lab-card">
  <div class="form-group">
    <label class="label" for="edit-trigger">Trigger</label>
    <textarea class="lab-edit-ta" id="edit-trigger" rows="2">${_esc(r.trigger)}</textarea>
  </div>
  <div class="form-group">
    <label class="label" for="edit-steps">Action sequence — one step per line</label>
    <textarea class="lab-edit-ta" id="edit-steps" rows="4">${_esc((r.actionSequence ?? []).join('\n'))}</textarea>
  </div>
  <div class="form-group" style="margin-bottom:0">
    <label class="label" for="edit-outcome">Expected outcome</label>
    <textarea class="lab-edit-ta" id="edit-outcome" rows="2">${_esc(r.expectedOutcome)}</textarea>
  </div>
  <div class="lab-btn-row" style="border-top:none;padding-top:0">
    <button type="button" class="btn btn-primary" id="save-edit">Save &amp; confirm</button>
  </div>
</div>`;

    el.querySelector('#save-edit').addEventListener('click', async () => {
        const trigger        = el.querySelector('#edit-trigger').value.trim();
        const actionSequence = el.querySelector('#edit-steps').value.split('\n').map(s => s.trim()).filter(Boolean);
        const expectedOutcome = el.querySelector('#edit-outcome').value.trim();

        const errEl = el.querySelector('#recipe-err');
        if (!trigger || actionSequence.length === 0 || !expectedOutcome) {
            errEl.textContent   = 'Please fill in all three fields before saving.';
            errEl.style.display = '';
            return;
        }
        errEl.style.display = 'none';

        const updated = {
            ...r,
            trigger, actionSequence, expectedOutcome,
            expertValidation: 'needs-editing',
            status: 'confirmed',
        };

        const btn = el.querySelector('#save-edit');
        btn.disabled = true;
        btn.textContent = 'Saving…';

        const ok = await saveRecipe(session.id, updated);
        if (!ok) {
            errEl.textContent   = "Couldn't save. Try again.";
            errEl.style.display = '';
            btn.disabled = false;
            btn.textContent = 'Save & confirm';
            return;
        }

        session.recipe = updated;
        _renderConfirmed(el, session);
    });
}

// ---------------------------------------------------------------------------
// _showSendBackForm — captures what's missing, then routes back to Screen 7.
// ---------------------------------------------------------------------------
function _showSendBackForm(el, session) {
    const actionWrap = el.querySelector('#recipe-action-wrap');

    actionWrap.innerHTML = `
<div class="lab-card">
  <label class="label" for="sendback-note">What's missing or off about this Recipe?</label>
  <textarea class="input" id="sendback-note" rows="3" placeholder="Be specific — this shapes the next round of questions."></textarea>
  <div class="lab-btn-row" style="border-top:none;padding-top:0">
    <button type="button" class="btn btn-primary" id="confirm-sendback">Send back to review</button>
  </div>
</div>`;

    el.querySelector('#confirm-sendback').addEventListener('click', async () => {
        const note = el.querySelector('#sendback-note').value.trim();
        const errEl = el.querySelector('#recipe-err');
        if (!note) {
            errEl.textContent   = 'Please describe what was missing before sending back.';
            errEl.style.display = '';
            return;
        }
        errEl.style.display = 'none';

        const updated = {
            ...session.recipe,
            expertValidation:     'send-back',
            expertValidationNote: note,
            status:               'draft',
        };

        const ok = await saveRecipe(session.id, updated);
        if (!ok) {
            errEl.textContent   = "Couldn't save. Try again.";
            errEl.style.display = '';
            return;
        }

        session.recipe = updated;
        showView('elicitation');
    });
}

// ---------------------------------------------------------------------------
// _renderConfirmed — final state: Recipe locked, shareable link shown.
// ---------------------------------------------------------------------------
function _renderConfirmed(el, session) {
    const shareUrl = `${SHARE_BASE}?transfer=${session.id}`;

    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(8)}</div>
  <h1 class="lab-h1">Recipe confirmed</h1>
  <div class="lab-notice lab-ok">Your Recipe is locked in. Share the link below with a learner to test transfer.</div>

  <div class="lab-recipe-card">${_recipeDisplayHTML(session.recipe)}</div>

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
// Shared helpers
// ---------------------------------------------------------------------------
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
