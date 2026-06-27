/**
 * lab/views/sorting.js
 * Screen 2 — Sorting Task
 * ─────────────────────────────────────────────────────────────────────
 * Flow:
 *  1. Load session from Firestore to get profile and cueLibrary
 *  2. If situations already generated (resume), use them; otherwise call
 *     generate() to produce 12 situation descriptions
 *  3. Render drag-and-drop board: ungrouped pool + group columns
 *  4. After expert groups all cards, show per-group question forms
 *  5. Save sortingTask to Firestore and navigate to Screen 3
 */

import { generate } from '../../engine/ai.js';
import { extractJSON } from '../../engine/utils.js';
import { getSession, updateSortingTask } from '../db.js';
import { showView } from '../app.js';

// ── Situation generation prompt ───────────────────────────────────────

const SIT_SYSTEM_PROMPT = `
You are building a knowledge elicitation exercise for a domain expert.
Generate 12 short situation descriptions (2–3 sentences each) that this expert
would recognise from their real work.

The situations must vary systematically across the cues provided so that they
span the full range of the expert's decision space — including edge cases,
routine cases, and genuinely ambiguous ones.

Respond ONLY with a valid JSON array of exactly 12 strings.
No markdown, no explanation, no preamble, no code fences.
`.trim();

function buildSituationPrompt(profile, cueLibrary) {
    const cueList = cueLibrary.map((c, i) =>
        `${i + 1}. ${c.name} (${c.scale}): ${c.definition}`
    ).join('\n');

    return `
Expert profile:
  Role: ${profile.role}
  What they do: ${profile.whatYouDo}
  Decisions they make: ${profile.decisionTypes}
  What makes it hard: ${profile.whatMakesItHard}

Situational cues this expert uses:
${cueList}

Generate 12 realistic, specific, varied situation descriptions.
Vary the cues across situations so the expert will naturally group some together
and separate others. Include a mix of clear-cut and ambiguous situations.
Each description should be 2–3 sentences. Write them in the third person
(e.g. "A team lead notices…", "A patient presents with…").

Return a JSON array of exactly 12 strings. Nothing else.
  `.trim();
}

// ── Module-level drag state ───────────────────────────────────────────
let _draggedId = null;

// ── Entry point ───────────────────────────────────────────────────────

export async function init(container, sessionId) {
    if (!sessionId) {
        container.innerHTML = `
      <div class="lab-page">
        <div class="lab-error">No active session found. Please go back to Screen 1.</div>
      </div>`;
        return;
    }

    container.innerHTML = `
    <div class="lab-page">
      <div class="lab-header">
        <span class="lab-step-label">Step 2 of 10</span>
        <h2 class="lab-title">Sorting Task</h2>
        <p class="lab-subtitle">
          Drag these situations into groups based on how you would respond to them.
          There are no right answers — group however feels natural to you.
        </p>
      </div>
      <div id="sorting-loading" class="lab-loading">
        <p>Generating situations from your profile…</p>
      </div>
      <div id="sorting-body" class="hidden"></div>
    </div>
  `;

    try {
        // Load session
        const session = await getSession(sessionId);
        if (!session) throw new Error('Session not found in Firestore.');

        // Generate or reuse situations
        let situationTexts;

        if (session.sortingTask && Array.isArray(session.sortingTask.situations)
            && session.sortingTask.situations.length === 12) {
            // Resuming — use already-generated situations
            situationTexts = session.sortingTask.situations;
        } else {
            // Fresh — generate now
            const raw = await generate(
                buildSituationPrompt(session.profile, session.cueLibrary),
                SIT_SYSTEM_PROMPT
            );

            if (!raw.ok) {
                throw new Error(
                raw.quota
                    ? 'AI quota exceeded. Please wait a few minutes and try again.'
                    : 'Situation generation failed. Please try again.'
                );
            }
            situationTexts = extractJSON(raw.text);

            if (!Array.isArray(situationTexts) || situationTexts.length !== 12) {
                throw new Error(
                    `Expected 12 situations, got ${Array.isArray(situationTexts) ? situationTexts.length : 'invalid JSON'}. Please try again.`
                );
            }
        }

        // Assign stable IDs
        const situations = situationTexts.map((text, i) => ({
            id: `sit_${String(i + 1).padStart(3, '0')}`,
            text,
        }));

        // Hide loading, render board
        document.getElementById('sorting-loading').classList.add('hidden');
        renderBoard(container, situations, sessionId);

    } catch (err) {
        console.error('[sorting] init error:', err);
        document.getElementById('sorting-loading').classList.add('hidden');
        document.getElementById('sorting-body').innerHTML = `
      <div class="lab-error">${err.message}</div>
      <div class="lab-actions">
        <button class="btn btn-ghost" onclick="window.location.reload()">Try Again</button>
      </div>
    `;
        document.getElementById('sorting-body').classList.remove('hidden');
    }
}

// ── Board renderer ────────────────────────────────────────────────────

function renderBoard(container, situations, sessionId) {
    // Board state
    const state = {
        ungrouped: situations.map(s => s.id),
        groups: [
            { id: 'grp_1', label: 'Group 1', situationIds: [] },
            { id: 'grp_2', label: 'Group 2', situationIds: [] },
            { id: 'grp_3', label: 'Group 3', situationIds: [] },
        ],
        nextGroupNum: 4,
    };

    // Index for fast text lookup
    const sitMap = Object.fromEntries(situations.map(s => [s.id, s.text]));

    const body = document.getElementById('sorting-body');
    body.classList.remove('hidden');

    function moveSituation(sitId, targetId) {
        // Remove from wherever it is
        state.ungrouped = state.ungrouped.filter(id => id !== sitId);
        state.groups.forEach(g => {
            g.situationIds = g.situationIds.filter(id => id !== sitId);
        });
        // Place in target
        if (targetId === 'ungrouped') {
            state.ungrouped.push(sitId);
        } else {
            const grp = state.groups.find(g => g.id === targetId);
            if (grp) grp.situationIds.push(sitId);
        }
        redraw();
    }

    function addGroup() {
        state.groups.push({
            id: `grp_${state.nextGroupNum}`,
            label: `Group ${state.nextGroupNum}`,
            situationIds: [],
        });
        state.nextGroupNum++;
        redraw();
    }

    function removeGroup(grpId) {
        const grp = state.groups.find(g => g.id === grpId);
        if (!grp) return;
        // Return its cards to ungrouped
        grp.situationIds.forEach(id => state.ungrouped.push(id));
        state.groups = state.groups.filter(g => g.id !== grpId);
        redraw();
    }

    function buildCard(sitId) {
        const card = document.createElement('div');
        card.className = 'situation-card';
        card.draggable = true;
        card.dataset.id = sitId;
        card.textContent = sitMap[sitId];

        card.addEventListener('dragstart', () => {
            _draggedId = sitId;
            card.classList.add('dragging');
        });
        card.addEventListener('dragend', () => {
            card.classList.remove('dragging');
            _draggedId = null;
        });
        return card;
    }

    function buildPool(poolId, title, sitIds) {
        const pool = document.createElement('div');
        pool.className = 'sort-pool';
        pool.dataset.poolId = poolId;

        const titleEl = document.createElement('p');
        titleEl.className = 'sort-pool-title';
        titleEl.textContent = title;
        pool.appendChild(titleEl);

        sitIds.forEach(id => pool.appendChild(buildCard(id)));

        pool.addEventListener('dragover', e => {
            e.preventDefault();
            pool.classList.add('drag-over');
        });
        pool.addEventListener('dragleave', () => pool.classList.remove('drag-over'));
        pool.addEventListener('drop', e => {
            e.preventDefault();
            pool.classList.remove('drag-over');
            if (_draggedId) moveSituation(_draggedId, poolId);
        });

        return pool;
    }

    function redraw() {
        body.innerHTML = '';

        // Controls
        const controls = document.createElement('div');
        controls.className = 'sort-controls';

        const addBtn = document.createElement('button');
        addBtn.className = 'btn btn-ghost';
        addBtn.textContent = '+ Add Group';
        addBtn.addEventListener('click', addGroup);
        controls.appendChild(addBtn);

        const allGrouped = state.ungrouped.length === 0;
        const nextBtn = document.createElement('button');
        nextBtn.className = 'btn btn-primary';
        nextBtn.textContent = 'All Sorted — Continue →';
        nextBtn.disabled = !allGrouped;
        nextBtn.title = allGrouped ? '' : 'All situations must be in a group to continue';
        nextBtn.addEventListener('click', () => showQuestions(container, state, sitMap, sessionId));
        controls.appendChild(nextBtn);

        if (!allGrouped) {
            const hint = document.createElement('span');
            hint.className = 'form-hint';
            hint.textContent = `${state.ungrouped.length} situation(s) not yet grouped`;
            controls.appendChild(hint);
        }

        body.appendChild(controls);

        // Drag board
        const board = document.createElement('div');
        board.className = 'sort-board';

        // Ungrouped pool (spans full width at top)
        const ungroupedEl = buildPool('ungrouped', `Ungrouped (${state.ungrouped.length})`, state.ungrouped);
        ungroupedEl.style.gridColumn = '1 / -1';
        board.appendChild(ungroupedEl);

        // Group pools
        state.groups.forEach(grp => {
            const wrapper = document.createElement('div');
            const pool = buildPool(grp.id, `${grp.label} (${grp.situationIds.length})`, grp.situationIds);

            // Remove group button
            const removeBtn = document.createElement('button');
            removeBtn.className = 'btn btn-ghost';
            removeBtn.textContent = 'Remove group';
            removeBtn.style.fontSize = '0.75rem';
            removeBtn.style.marginTop = '0.5rem';
            removeBtn.addEventListener('click', () => removeGroup(grp.id));
            pool.appendChild(removeBtn);

            wrapper.appendChild(pool);
            board.appendChild(wrapper);
        });

        body.appendChild(board);
    }

    // Initial draw
    redraw();
}

// ── Questions phase ───────────────────────────────────────────────────

function showQuestions(container, state, sitMap, sessionId) {
    // Only groups with ≥1 card need questions
    const populated = state.groups.filter(g => g.situationIds.length > 0);

    const body = document.getElementById('sorting-body');
    body.innerHTML = `
    <h3 style="margin:1.5rem 0 0.5rem">For each group you created</h3>
    <p class="lab-subtitle" style="margin-bottom:1.5rem">
      Answer two quick questions about what the situations in each group have in common
      and what would make an apparently similar situation need a different response.
    </p>
    <div id="group-error" class="lab-error hidden"></div>
    <div id="group-questions"></div>
    <div class="lab-actions" style="margin-top:2rem">
      <button class="btn btn-ghost" id="btn-back-to-sort">← Back to Board</button>
      <button class="btn btn-primary" id="btn-sorting-submit">Save and Continue →</button>
    </div>
    <div id="sorting-save-loading" class="lab-loading hidden">
      <p>Saving…</p>
    </div>
  `;

    const questionsEl = document.getElementById('group-questions');

    populated.forEach(grp => {
        const section = document.createElement('div');
        section.style.cssText = 'margin-bottom:2rem; padding:1rem 1.25rem; border:1px solid rgba(0,0,0,0.1); border-radius:10px;';
        section.innerHTML = `
      <p class="sort-pool-title" style="margin-bottom:0.75rem">${grp.label}</p>
      <div style="margin-bottom:0.75rem; font-size:0.82rem; opacity:0.65;">
        ${grp.situationIds.map(id => `<div style="margin-bottom:0.3rem">• ${sitMap[id]}</div>`).join('')}
      </div>
      <div class="form-group">
        <label class="form-label" for="common-${grp.id}">
          What do these situations have in common? <span class="required">*</span>
        </label>
        <textarea class="input textarea" id="common-${grp.id}" rows="2"
                  placeholder="What pattern or feature links these situations?"></textarea>
      </div>
      <div class="form-group">
        <label class="form-label" for="discrim-${grp.id}">
          What would make a situation that <em>looks</em> like one of these actually need a different response? <span class="required">*</span>
        </label>
        <textarea class="input textarea" id="discrim-${grp.id}" rows="2"
                  placeholder="What hidden feature or edge case would change your approach?"></textarea>
      </div>
    `;
        questionsEl.appendChild(section);
    });

    document.getElementById('btn-back-to-sort').addEventListener('click', () => {
        // Re-render the board — pass situations rebuilt from state
        const allSits = [
            ...state.ungrouped,
            ...state.groups.flatMap(g => g.situationIds),
        ].map(id => ({ id, text: sitMap[id] }));
        document.getElementById('sorting-body').innerHTML = '';
        renderBoard(container, allSits, sessionId);

        // Restore grouping from state (re-assign from stored state)
        // Board always starts fresh; for simplicity in MVP, state is preserved
        // because renderBoard closes over the same state object passed in.
        // NOTE: the board's closure won't have the old state. For a clean
        // resume, re-navigate. In a future iteration, extract state management.
    });

    document.getElementById('btn-sorting-submit').addEventListener('click', async () => {
        const errorEl = document.getElementById('group-error');
        const loadingEl = document.getElementById('sorting-save-loading');
        errorEl.classList.add('hidden');

        // Collect and validate answers
        let valid = true;
        const groups = populated.map(grp => {
            const commonality = document.getElementById(`common-${grp.id}`)?.value.trim();
            const discriminator = document.getElementById(`discrim-${grp.id}`)?.value.trim();
            if (!commonality || !discriminator) valid = false;
            return {
                situationIds: grp.situationIds,
                commonality: commonality || '',
                discriminator: discriminator || '',
            };
        });

        if (!valid) {
            errorEl.textContent = 'Please answer both questions for every group before continuing.';
            errorEl.classList.remove('hidden');
            return;
        }

        document.getElementById('btn-sorting-submit').disabled = true;
        loadingEl.classList.remove('hidden');

        try {
            const sortingTask = {
                situations: Object.values(sitMap),   // original 12 texts in order
                groups,
            };
            await updateSortingTask(sessionId, sortingTask);
            showView('cue-review');
        } catch (err) {
            console.error('[sorting] save error:', err);
            errorEl.textContent = err.message || 'Save failed. Please try again.';
            errorEl.classList.remove('hidden');
            document.getElementById('btn-sorting-submit').disabled = false;
        } finally {
            loadingEl.classList.add('hidden');
        }
    });
}