/**
 * lab/views/cue-review.js
 * Screen 3 — Cue Library Review
 * ─────────────────────────────────────────────────────────────────────
 * Flow:
 *  1. Load session from Firestore to get the current cueLibrary
 *  2. Render each cue as a card with Keep / Edit / Remove actions
 *  3. Show two diagnostic prompts for adding or flagging cues
 *  4. On confirm: save updated cueLibrary to Firestore, navigate to Screen 4
 */

import { getSession, updateCueLibrary } from '../db.js';
import { showView } from '../app.js';

export async function init(container, sessionId) {
    if (!sessionId) {
        container.innerHTML = `<div class="lab-page"><div class="lab-error">No active session. Please start from Screen 1.</div></div>`;
        return;
    }

    container.innerHTML = `
    <div class="lab-page">
      <div class="lab-header">
        <span class="lab-step-label">Step 3 of 10</span>
        <h2 class="lab-title">Your Cue Library</h2>
        <p class="lab-subtitle">
          These are the features of a situation the system thinks you pay attention to
          when deciding what to do. Review each one — keep it, edit it, or remove it.
        </p>
      </div>
      <div id="cue-review-loading" class="lab-loading"><p>Loading cue library…</p></div>
      <div id="cue-review-body" class="hidden"></div>
    </div>
  `;

    try {
        const session = await getSession(sessionId);
        if (!session) throw new Error('Session not found.');
        if (!session.cueLibrary || session.cueLibrary.length === 0) {
            throw new Error('No cue library found. Please go back to Screen 1 and resubmit your profile.');
        }

        document.getElementById('cue-review-loading').classList.add('hidden');
        renderCueReview(session.cueLibrary, sessionId);

    } catch (err) {
        console.error('[cue-review] init error:', err);
        document.getElementById('cue-review-loading').classList.add('hidden');
        document.getElementById('cue-review-body').innerHTML = `<div class="lab-error">${err.message}</div>`;
        document.getElementById('cue-review-body').classList.remove('hidden');
    }
}

// ── Render ────────────────────────────────────────────────────────────

function renderCueReview(initialCues, sessionId) {
    // Deep-copy so we can edit without mutating the original
    let cues = initialCues.map(c => ({ ...c, _status: 'keep' }));

    const body = document.getElementById('cue-review-body');
    body.classList.remove('hidden');

    function redraw() {
        body.innerHTML = '';

        // ── Cue cards ─────────────────────────────────────────────────────
        const listEl = document.createElement('div');
        listEl.id = 'cue-list';

        cues.forEach((cue, idx) => {
            const card = document.createElement('div');
            card.className = `cue-card${cue._status === 'remove' ? ' removed' : ''}`;
            card.innerHTML = `
        <p class="cue-name">${cue.name}</p>
        <p class="cue-def">${cue.definition}</p>
        <p class="cue-meta">
          Scale: <strong>${cue.scale}</strong> &nbsp;·&nbsp;
          Layer: <strong>${cue.layer}</strong> &nbsp;·&nbsp;
          Options: <strong>${(cue.options || []).join(' / ')}</strong>
        </p>
        <div class="cue-actions">
          <button class="btn btn-ghost btn-sm" data-action="keep"   data-idx="${idx}">✓ Keep</button>
          <button class="btn btn-ghost btn-sm" data-action="edit"   data-idx="${idx}">Edit</button>
          <button class="btn btn-ghost btn-sm" data-action="remove" data-idx="${idx}">Remove</button>
        </div>
        <div class="cue-edit-area hidden" id="edit-area-${idx}">
          <div class="form-group">
            <label class="form-label">Name</label>
            <input class="input" type="text" id="edit-name-${idx}" value="${escHtml(cue.name)}" />
          </div>
          <div class="form-group">
            <label class="form-label">Definition</label>
            <textarea class="input textarea" id="edit-def-${idx}" rows="2">${escHtml(cue.definition)}</textarea>
          </div>
          <div class="form-group">
            <label class="form-label">Scale</label>
            <select class="input" id="edit-scale-${idx}">
              <option value="binary"      ${cue.scale === 'binary' ? 'selected' : ''}>Binary (2 options)</option>
              <option value="three-point" ${cue.scale === 'three-point' ? 'selected' : ''}>Three-point (3 options)</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Options (comma-separated)</label>
            <input class="input" type="text" id="edit-options-${idx}"
                   value="${escHtml((cue.options || []).join(', '))}" />
          </div>
          <button class="btn btn-primary btn-sm" data-action="save-edit" data-idx="${idx}">Save Changes</button>
        </div>
      `;
            listEl.appendChild(card);
        });

        body.appendChild(listEl);

        // Wire action buttons
        listEl.addEventListener('click', e => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const idx = parseInt(btn.dataset.idx, 10);
            const action = btn.dataset.action;

            if (action === 'keep') {
                cues[idx]._status = 'keep';
                redraw();
            }

            if (action === 'remove') {
                cues[idx]._status = 'remove';
                redraw();
            }

            if (action === 'edit') {
                const editArea = document.getElementById(`edit-area-${idx}`);
                if (editArea) editArea.classList.toggle('hidden');
            }

            if (action === 'save-edit') {
                const name = document.getElementById(`edit-name-${idx}`)?.value.trim();
                const def = document.getElementById(`edit-def-${idx}`)?.value.trim();
                const scale = document.getElementById(`edit-scale-${idx}`)?.value;
                const optStr = document.getElementById(`edit-options-${idx}`)?.value;
                const options = optStr ? optStr.split(',').map(s => s.trim()).filter(Boolean) : [];

                if (!name || !def) { alert('Name and definition are required.'); return; }

                cues[idx] = { ...cues[idx], name, definition: def, scale, options, _status: 'keep' };
                redraw();
            }
        });

        // ── Add-cue form ───────────────────────────────────────────────────
        const addSection = document.createElement('div');
        addSection.style.marginTop = '2rem';
        addSection.innerHTML = `
      <h4 style="margin:0 0 0.5rem">Diagnostic questions</h4>
      <p class="form-hint" style="margin-bottom:1.25rem">
        Use these to spot missing cues before the session is locked.
      </p>

      <div style="padding:1rem 1.25rem; border:1px solid rgba(0,0,0,0.1); border-radius:10px; margin-bottom:1rem;">
        <label class="form-label">
          Are there situations in your work that would need a different response
          but would look identical using only these cues?
        </label>
        <p class="form-hint">If yes, describe the missing cue below and add it.</p>
        <div class="form-group" style="margin-top:0.75rem">
          <label class="form-label" for="new-cue-name">New cue name <span class="optional">(optional)</span></label>
          <input class="input" type="text" id="new-cue-name" placeholder="e.g. Time available before deadline" />
        </div>
        <div class="form-group">
          <label class="form-label" for="new-cue-def">Definition</label>
          <textarea class="input textarea" id="new-cue-def" rows="2"
                    placeholder="What does this cue mean in practice?"></textarea>
        </div>
        <div class="form-group">
          <label class="form-label" for="new-cue-scale">Scale</label>
          <select class="input" id="new-cue-scale">
            <option value="binary">Binary (2 options)</option>
            <option value="three-point">Three-point (3 options)</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="new-cue-options">Options (comma-separated)</label>
          <input class="input" type="text" id="new-cue-options" placeholder="e.g. Short, Adequate, Plenty" />
        </div>
        <button class="btn btn-ghost btn-sm" id="btn-add-cue">Add This Cue</button>
      </div>

      <div style="padding:1rem 1.25rem; border:1px solid rgba(0,0,0,0.1); border-radius:10px;">
        <label class="form-label">
          Are there any cues above that would not actually change what you do?
        </label>
        <p class="form-hint">
          If so, use the Remove button on those cards above. Cues that don't change
          your decision add noise to the model.
        </p>
      </div>
    `;
        body.appendChild(addSection);

        // Add cue handler
        document.getElementById('btn-add-cue').addEventListener('click', () => {
            const name = document.getElementById('new-cue-name').value.trim();
            const def = document.getElementById('new-cue-def').value.trim();
            const scale = document.getElementById('new-cue-scale').value;
            const optStr = document.getElementById('new-cue-options').value;
            const options = optStr ? optStr.split(',').map(s => s.trim()).filter(Boolean) : [];

            if (!name || !def) {
                alert('Please enter at least a name and definition for the new cue.');
                return;
            }

            const newCue = {
                id: `cue_${String(cues.length + 1).padStart(3, '0')}`,
                name,
                definition: def,
                scale,
                layer: 1,   // default — expert can edit after redraw
                options,
                _status: 'keep',
            };
            cues.push(newCue);
            redraw();
        });

        // ── Confirm / error ────────────────────────────────────────────────
        const footer = document.createElement('div');
        footer.innerHTML = `
      <div id="cue-review-error" class="lab-error hidden"></div>
      <div class="lab-actions" style="margin-top:2rem">
        <button class="btn btn-primary" id="btn-cue-confirm">Confirm Cue Library →</button>
        <span class="form-hint">${cues.filter(c => c._status === 'keep').length} cues will be kept</span>
      </div>
      <div id="cue-confirm-loading" class="lab-loading hidden"><p>Saving…</p></div>
    `;
        body.appendChild(footer);

        document.getElementById('btn-cue-confirm').addEventListener('click', () => {
            handleConfirm(cues, sessionId);
        });
    }

    redraw();
}

// ── Save and navigate ─────────────────────────────────────────────────

async function handleConfirm(cues, sessionId) {
    const errorEl = document.getElementById('cue-review-error');
    const loadingEl = document.getElementById('cue-confirm-loading');
    const confirmBtn = document.getElementById('btn-cue-confirm');
    errorEl.classList.add('hidden');

    // Filter out removed cues and strip the internal _status field
    const finalLibrary = cues
        .filter(c => c._status !== 'remove')
        .map(({ _status, ...cue }) => cue);

    if (finalLibrary.length < 3) {
        errorEl.textContent = 'Please keep at least 3 cues. The model needs sufficient variation to fit a pattern.';
        errorEl.classList.remove('hidden');
        return;
    }

    confirmBtn.disabled = true;
    loadingEl.classList.remove('hidden');

    try {
        await updateCueLibrary(sessionId, finalLibrary);
        showView('options');
    } catch (err) {
        console.error('[cue-review] save error:', err);
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