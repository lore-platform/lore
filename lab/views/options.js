/**
 * lab/views/options.js
 * Screen 4 — Decision Option Set Review
 * ─────────────────────────────────────────────────────────────────────
 * Flow:
 *  1. Load session from Firestore (needs profile for the classify call)
 *  2. If decisionOptions are already set (resume), display them directly
 *  3. Otherwise call classify() to generate 4–6 proposed options from profile
 *  4. Render each option as an editable card
 *  5. Expert can edit labels/descriptions, add an option, or remove one
 *  6. On confirm: save decisionOptions to Firestore, navigate to Screen 5
 */

import { classify } from '../../engine/ai.js';
import { extractJSON } from '../../engine/utils.js';
import { getSession, updateDecisionOptions } from '../db.js';
import { showView } from '../app.js';

// ── Classify prompt for option generation ─────────────────────────────

const OPTIONS_SYSTEM_PROMPT = `
You are a knowledge engineer extracting the decision response options for an expert.
A response option is a distinct type of action or decision the expert can make in their domain.

These options will be used as the answer choices in a 30-scenario decision capture session,
so they must cover the full range of what the expert could legitimately do, be mutually exclusive
at the level of the primary decision, and be specific to this domain (not generic like "do nothing").

Respond ONLY with a valid JSON array. No markdown, no explanation, no preamble, no code fences.
Each object must have exactly these fields:
  id:          string  — unique key, format "opt_001", "opt_002", etc.
  label:       string  — short name for the option, 2–5 words
  description: string  — 1–2 sentences explaining what this option means in practice
`.trim();

function buildOptionsPrompt(profile) {
    return `
Here is an expert's profile. Extract 4–6 response options that represent the
main distinct decisions this expert can make.

These should be the primary choices — the branching points — not sub-steps or tactics.
Think about what someone would write in the "Decision" column of a decision log.

PROFILE:
Role: ${profile.role}
What they do: ${profile.whatYouDo}
Types of decisions they make: ${profile.decisionTypes}
What makes it hard: ${profile.whatMakesItHard}

Return a JSON array of 4–6 option objects. Nothing else.
  `.trim();
}

// ── Entry point ───────────────────────────────────────────────────────

export async function init(container, sessionId) {
    if (!sessionId) {
        container.innerHTML = `<div class="lab-page"><div class="lab-error">No active session. Please start from Screen 1.</div></div>`;
        return;
    }

    container.innerHTML = `
    <div class="lab-page">
      <div class="lab-header">
        <span class="lab-step-label">Step 4 of 10</span>
        <h2 class="lab-title">Decision Option Set</h2>
        <p class="lab-subtitle">
          These are the possible responses you can give in a scenario. Review and edit them
          so they accurately represent the choices you actually make. This set will be used
          for every scenario in your session.
        </p>
      </div>
      <div id="options-loading" class="lab-loading"><p>Generating response options…</p></div>
      <div id="options-body" class="hidden"></div>
    </div>
  `;

    try {
        const session = await getSession(sessionId);
        if (!session) throw new Error('Session not found.');

        let options;

        if (session.decisionOptions && session.decisionOptions.length > 0) {
            // Resuming — show existing options
            options = session.decisionOptions;
        } else {
            // Generate from profile
            const raw = await classify(
                buildOptionsPrompt(session.profile),
                OPTIONS_SYSTEM_PROMPT
            );

            if (!raw.ok) {
                throw new Error(
                    raw.quota
                        ? 'AI quota exceeded. Please wait a few minutes and try again.'
                        : 'Option generation failed. Please try again.'
                );
            }
            options = extractJSON(raw.text);

            if (!Array.isArray(options) || options.length < 2) {
                throw new Error(
                    'Option generation returned an unexpected result. Please go back to Screen 1 ' +
                    'and add more detail to your profile, then return here.'
                );
            }
        }

        document.getElementById('options-loading').classList.add('hidden');
        renderOptions(options, sessionId);

    } catch (err) {
        console.error('[options] init error:', err);
        document.getElementById('options-loading').classList.add('hidden');
        document.getElementById('options-body').innerHTML = `
      <div class="lab-error">${err.message}</div>
      <div class="lab-actions">
        <button class="btn btn-ghost" onclick="window.location.reload()">Try Again</button>
      </div>
    `;
        document.getElementById('options-body').classList.remove('hidden');
    }
}

// ── Render ────────────────────────────────────────────────────────────

function renderOptions(initialOptions, sessionId) {
    // Deep-copy so edits don't mutate the source
    let options = initialOptions.map(o => ({ ...o }));

    const body = document.getElementById('options-body');
    body.classList.remove('hidden');

    function redraw() {
        body.innerHTML = '';

        // ── Option cards ───────────────────────────────────────────────────
        const listEl = document.createElement('div');
        listEl.id = 'option-list';

        options.forEach((opt, idx) => {
            const card = document.createElement('div');
            card.className = 'option-card';
            card.innerHTML = `
        <div class="option-label-row">
          <span class="option-label" id="display-label-${idx}">${escHtml(opt.label)}</span>
          <button class="btn btn-ghost btn-sm" data-action="edit" data-idx="${idx}">Edit</button>
          <button class="btn btn-ghost btn-sm" data-action="remove" data-idx="${idx}">Remove</button>
        </div>
        <p class="option-desc" id="display-desc-${idx}">${escHtml(opt.description)}</p>

        <div class="cue-edit-area hidden" id="opt-edit-${idx}">
          <div class="form-group">
            <label class="form-label">Label (2–5 words)</label>
            <input class="input" type="text" id="opt-edit-label-${idx}"
                   value="${escHtml(opt.label)}" maxlength="60" />
          </div>
          <div class="form-group">
            <label class="form-label">Description</label>
            <textarea class="input textarea" id="opt-edit-desc-${idx}" rows="2">${escHtml(opt.description)}</textarea>
          </div>
          <button class="btn btn-primary btn-sm" data-action="save-edit" data-idx="${idx}">Save</button>
          <button class="btn btn-ghost btn-sm"   data-action="cancel-edit" data-idx="${idx}">Cancel</button>
        </div>
      `;
            listEl.appendChild(card);
        });

        body.appendChild(listEl);

        // Wire card action buttons
        listEl.addEventListener('click', e => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const idx = parseInt(btn.dataset.idx, 10);
            const action = btn.dataset.action;

            if (action === 'edit') {
                document.getElementById(`opt-edit-${idx}`)?.classList.toggle('hidden');
            }

            if (action === 'cancel-edit') {
                document.getElementById(`opt-edit-${idx}`)?.classList.add('hidden');
            }

            if (action === 'save-edit') {
                const label = document.getElementById(`opt-edit-label-${idx}`)?.value.trim();
                const desc = document.getElementById(`opt-edit-desc-${idx}`)?.value.trim();
                if (!label || !desc) { alert('Both label and description are required.'); return; }
                options[idx] = { ...options[idx], label, description: desc };
                redraw();
            }

            if (action === 'remove') {
                if (options.length <= 2) {
                    alert('You must keep at least 2 options.');
                    return;
                }
                options.splice(idx, 1);
                // Re-sequence IDs
                options = options.map((o, i) => ({
                    ...o,
                    id: `opt_${String(i + 1).padStart(3, '0')}`,
                }));
                redraw();
            }
        });

        // ── Add option form ────────────────────────────────────────────────
        const addSection = document.createElement('div');
        addSection.style.cssText = 'margin-top:1.5rem; padding:1rem 1.25rem; border:1px dashed rgba(0,0,0,0.15); border-radius:10px;';
        addSection.innerHTML = `
      <p class="form-label" style="margin-bottom:0.75rem">Add a missing option</p>
      <div class="form-group">
        <label class="form-label" for="new-opt-label">Label</label>
        <input class="input" type="text" id="new-opt-label" placeholder="e.g. Escalate immediately" maxlength="60" />
      </div>
      <div class="form-group">
        <label class="form-label" for="new-opt-desc">Description</label>
        <textarea class="input textarea" id="new-opt-desc" rows="2"
                  placeholder="What does choosing this option mean in practice?"></textarea>
      </div>
      <button class="btn btn-ghost btn-sm" id="btn-add-option">Add Option</button>
    `;
        body.appendChild(addSection);

        document.getElementById('btn-add-option').addEventListener('click', () => {
            const label = document.getElementById('new-opt-label').value.trim();
            const desc = document.getElementById('new-opt-desc').value.trim();
            if (!label || !desc) { alert('Please enter a label and description.'); return; }
            if (options.length >= 8) { alert('Maximum 8 options allowed.'); return; }

            options.push({
                id: `opt_${String(options.length + 1).padStart(3, '0')}`,
                label,
                description: desc,
            });
            redraw();
        });

        // ── Footer ─────────────────────────────────────────────────────────
        const footer = document.createElement('div');
        footer.innerHTML = `
      <div id="options-error" class="lab-error hidden"></div>
      <div class="lab-actions" style="margin-top:2rem">
        <button class="btn btn-primary" id="btn-options-confirm">
          Lock Option Set and Continue →
        </button>
        <span class="form-hint">${options.length} options</span>
      </div>
      <div id="options-save-loading" class="lab-loading hidden"><p>Saving…</p></div>
    `;
        body.appendChild(footer);

        document.getElementById('btn-options-confirm').addEventListener('click', () => {
            handleConfirm(options, sessionId);
        });
    }

    redraw();
}

// ── Save and navigate ─────────────────────────────────────────────────

async function handleConfirm(options, sessionId) {
    const errorEl = document.getElementById('options-error');
    const loadingEl = document.getElementById('options-save-loading');
    const confirmBtn = document.getElementById('btn-options-confirm');
    errorEl.classList.add('hidden');

    if (options.length < 2) {
        errorEl.textContent = 'You need at least 2 decision options to run the scenario session.';
        errorEl.classList.remove('hidden');
        return;
    }

    confirmBtn.disabled = true;
    loadingEl.classList.remove('hidden');

    try {
        await updateDecisionOptions(sessionId, options);
        showView('session');
    } catch (err) {
        console.error('[options] save error:', err);
        errorEl.textContent = err.message || 'Save failed. Please try again.';
        errorEl.classList.remove('hidden');
        confirmBtn.disabled = false;
    } finally {
        loadingEl.classList.add('hidden');
    }
}

// ── HTML escape helper ────────────────────────────────────────────────

function escHtml(str) {
    return (str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}