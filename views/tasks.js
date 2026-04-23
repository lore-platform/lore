// =============================================================================
// LORE — Tasks View (Reviewer)
// The Reviewer's only surface in LORE. They receive focused prompts — never
// more than three to five at a time — framed as quality checks or coaching.
// They never see the knowledge base, the recipe format, or anything that
// signals their activity is being structured into training content.
//
// Two prompt types:
//   scenario_review  — "Does this feel like a real situation your team faces?"
//   mentorship_note  — "What did they miss here, and why does it matter?"
//
// When the Reviewer responds, their words are staged as a raw extraction
// in Firestore. The AI processes them into a recipe draft. The Manager
// reviews and approves. The Reviewer never sees any of this.
//
// Copy rule: never use extract, capture, knowledge base, recipe, training data.
// Frame everything as reviewing, helping, supporting the team.
//
// Import paths: views/ files import engine files using ../engine/[file].js.
// =============================================================================

import { createExtraction } from '../engine/recipes.js';
import { getState } from '../engine/state.js';

// ---------------------------------------------------------------------------
// Module-level state for this view.
// ---------------------------------------------------------------------------
let _orgId   = null;
let _uid     = null;
let _claims  = null;

// The active prompts for this session — pulled from Firestore on init.
let _prompts = [];
let _currentIndex = 0;

// ---------------------------------------------------------------------------
// Entry point — called by app.js after auth.
// claims includes: orgId, uid, email, role, and any Reviewer-specific
// profile fields stored on their user document.
// ---------------------------------------------------------------------------
export async function initTasks(orgId, uid, claims) {
    _orgId  = orgId;
    _uid    = uid;
    _claims = claims;

    console.log('LORE tasks.js: initTasks — orgId:', orgId, 'uid:', uid);

    const container = document.getElementById('tasks-content');
    if (!container) return;

    // Load any pending prompts for this Reviewer from Firestore
    _prompts = await _fetchPendingPrompts(orgId, uid);
    console.log('LORE tasks.js: Fetched', _prompts.length, 'pending prompts.');

    if (_prompts.length === 0) {
        renderAllClear(container);
        return;
    }

    _currentIndex = 0;
    renderPrompt(container, _prompts[_currentIndex]);
}

// ---------------------------------------------------------------------------
// Fetch pending prompts addressed to this Reviewer.
// Prompts are stored as tasks on the Reviewer's user document.
// Returns an array of prompt objects, capped at 5 per session.
// ---------------------------------------------------------------------------
async function _fetchPendingPrompts(orgId, uid) {
    // Import Firestore inline to avoid a top-level dependency
    const { db } = await import('../firebase.js');
    const {
        collection,
        query,
        where,
        orderBy,
        limit,
        getDocs
    } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

    try {
        const ref = collection(db, 'organisations', orgId, 'users', uid, 'tasks');
        const q = query(
            ref,
            where('status', '==', 'pending'),
            orderBy('createdAt', 'asc'),
            limit(5)   // [TUNING TARGET] Cap at 5 prompts per session — feels manageable
        );
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
        console.warn('LORE Tasks: Could not fetch prompts.', err);
        return [];
    }
}

// ---------------------------------------------------------------------------
// Mark a prompt as completed in Firestore once the Reviewer has responded.
// Called after the response is saved — non-blocking.
// ---------------------------------------------------------------------------
async function _markPromptComplete(orgId, uid, promptId) {
    const { db } = await import('../firebase.js');
    const {
        doc,
        updateDoc,
        serverTimestamp
    } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

    try {
        await updateDoc(
            doc(db, 'organisations', orgId, 'users', uid, 'tasks', promptId),
            { status: 'completed', completedAt: serverTimestamp() }
        );
    } catch (err) {
        // Non-fatal — the extraction is already saved
        console.warn('LORE Tasks: Could not mark prompt complete.', err);
    }
}

// ---------------------------------------------------------------------------
// SCREEN: All clear — no pending prompts.
// Framed as "you're up to date" rather than "no tasks".
// ---------------------------------------------------------------------------
function renderAllClear(container) {
    container.innerHTML = `
        <div class="empty-state">
            <h3>You're all caught up</h3>
            <p class="mt-2">When your team needs your input, you'll see it here.</p>
        </div>
    `;
}

// ---------------------------------------------------------------------------
// SCREEN: A single prompt.
// Renders differently based on prompt type — scenario_review vs mentorship_note.
// ---------------------------------------------------------------------------
function renderPrompt(container, prompt) {
    const progress = `${_currentIndex + 1} of ${_prompts.length}`;

    if (prompt.type === 'scenario_review') {
        renderScenarioReview(container, prompt, progress);
    } else if (prompt.type === 'mentorship_note') {
        renderMentorshipNote(container, prompt, progress);
    } else {
        // Unknown type — skip gracefully
        console.warn('LORE Tasks: Unknown prompt type:', prompt.type);
        advanceToNext(container);
    }
}

// ---------------------------------------------------------------------------
// SCREEN: Scenario review prompt.
// The Reviewer is shown a scenario and asked if it feels realistic.
// Their correction — if they flag something — is the extraction.
// They have no idea this is being captured.
// ---------------------------------------------------------------------------
function renderScenarioReview(container, prompt, progress) {
    container.innerHTML = `
        <div>
            <div class="flex-between mb-2">
                <p class="text-xs text-secondary" style="text-transform: uppercase; letter-spacing: 0.08em;">Quick review</p>
                <p class="text-xs text-secondary">${progress}</p>
            </div>

            <div class="card mt-4" style="border-left: 3px solid var(--ember);">
                <p style="line-height: 1.8;">${prompt.scenarioText ?? ''}</p>
            </div>

            <div class="card mt-4">
                <p class="label mb-4">Does this feel like a situation your team actually encounters?</p>

                <div style="display: flex; gap: var(--space-3); margin-bottom: var(--space-4);">
                    <button class="btn btn-secondary" id="flag-yes" style="flex: 1;">
                        Yes, this tracks
                    </button>
                    <button class="btn btn-secondary" id="flag-no" style="flex: 1;">
                        Something's off
                    </button>
                </div>

                <div id="correction-area" style="display: none; margin-top: var(--space-4);">
                    <p class="label mb-2">What would make this more accurate?</p>
                    <textarea
                        class="input"
                        id="correction-text"
                        rows="4"
                        placeholder="Describe what feels off, or what a more realistic version would look like…"
                        style="resize: vertical;"
                    ></textarea>
                    <button class="btn btn-primary btn-full mt-4" id="submit-correction">
                        Send feedback
                    </button>
                </div>
            </div>
        </div>
    `;

    // "Yes, this tracks" — no useful extraction, just advance
    document.getElementById('flag-yes')?.addEventListener('click', async () => {
        await _markPromptComplete(_orgId, _uid, prompt.id);
        advanceToNext(container);
    });

    // "Something's off" — show the correction input
    document.getElementById('flag-no')?.addEventListener('click', () => {
        document.getElementById('correction-area').style.display = 'block';
        document.getElementById('flag-yes').style.display = 'none';
        document.getElementById('flag-no').style.display = 'none';
        document.getElementById('correction-text').focus();
    });

    // Submit correction — this is where the extraction happens
    document.getElementById('submit-correction')?.addEventListener('click', async () => {
        const text = document.getElementById('correction-text')?.value?.trim();
        if (!text) {
            document.getElementById('correction-text').focus();
            return;
        }

        const btn = document.getElementById('submit-correction');
        btn.disabled = true;
        btn.textContent = 'Saving…';

        // Stage the Reviewer's correction as a raw extraction
        console.log('LORE tasks.js: Staging scenario review extraction.');
        await createExtraction(_orgId, {
            sourceType:  'scenario_review',
            rawContent:  text,
            reviewerId:  _uid,
            contextNote: `Scenario review. Original scenario text: ${(prompt.scenarioText ?? '').slice(0, 200)}`,
        });

        await _markPromptComplete(_orgId, _uid, prompt.id);
        renderThankYou(container, () => advanceToNext(container));
    });
}

// ---------------------------------------------------------------------------
// SCREEN: Mentorship note prompt.
// The Reviewer is shown an Employee's response to a scenario and asked
// what the Employee missed. Their answer is the extraction.
// Framed as coaching — "what would you tell them?"
// ---------------------------------------------------------------------------
function renderMentorshipNote(container, prompt, progress) {
    container.innerHTML = `
        <div>
            <div class="flex-between mb-2">
                <p class="text-xs text-secondary" style="text-transform: uppercase; letter-spacing: 0.08em;">A moment from training</p>
                <p class="text-xs text-secondary">${progress}</p>
            </div>

            <div class="card mt-4">
                <p class="label mb-2">The situation</p>
                <p style="line-height: 1.8;">${prompt.scenarioText ?? ''}</p>
            </div>

            <div class="card mt-4">
                <p class="label mb-2">How a team member responded</p>
                <p class="text-secondary" style="line-height: 1.8; font-style: italic;">"${prompt.employeeResponse ?? ''}"</p>
            </div>

            <div class="card mt-4">
                <p class="label mb-4">What would you tell them?</p>
                <p class="text-secondary text-sm mb-4">What did they miss, and why does it matter in practice?</p>
                <textarea
                    class="input"
                    id="mentorship-text"
                    rows="5"
                    placeholder="Share what a more experienced read of this situation looks like…"
                    style="resize: vertical;"
                ></textarea>
                <button class="btn btn-primary btn-full mt-4" id="submit-note">
                    Share your thinking
                </button>
                <button class="btn btn-secondary btn-full mt-2" id="skip-note">
                    Skip this one
                </button>
            </div>
        </div>
    `;

    document.getElementById('skip-note')?.addEventListener('click', async () => {
        await _markPromptComplete(_orgId, _uid, prompt.id);
        advanceToNext(container);
    });

    document.getElementById('submit-note')?.addEventListener('click', async () => {
        const text = document.getElementById('mentorship-text')?.value?.trim();
        if (!text) {
            document.getElementById('mentorship-text').focus();
            return;
        }

        const btn = document.getElementById('submit-note');
        btn.disabled = true;
        btn.textContent = 'Saving…';

        // Stage the mentorship note as a raw extraction
        await createExtraction(_orgId, {
            sourceType:  'mentorship_note',
            rawContent:  text,
            reviewerId:  _uid,
            contextNote: `Mentorship note. Scenario: ${(prompt.scenarioText ?? '').slice(0, 200)}. Employee response: ${(prompt.employeeResponse ?? '').slice(0, 200)}`,
        });

        await _markPromptComplete(_orgId, _uid, prompt.id);
        renderThankYou(container, () => advanceToNext(container));
    });
}

// ---------------------------------------------------------------------------
// SCREEN: Brief confirmation after submitting.
// Warm but quick — does not over-explain what just happened.
// Auto-advances after 1.5 seconds so it feels fluid, not transactional.
// ---------------------------------------------------------------------------
function renderThankYou(container, next) {
    container.innerHTML = `
        <div class="empty-state">
            <p style="color: var(--sage); font-size: var(--text-lg); font-weight: 500;">✓ Got it</p>
            <p class="text-secondary mt-2">Your feedback helps the team get better.</p>
        </div>
    `;
    setTimeout(next, 1500);
}

// ---------------------------------------------------------------------------
// Advance to the next prompt, or show the all-clear if done.
// ---------------------------------------------------------------------------
function advanceToNext(container) {
    _currentIndex++;
    if (_currentIndex < _prompts.length) {
        renderPrompt(container, _prompts[_currentIndex]);
    } else {
        renderSessionComplete(container);
    }
}

// ---------------------------------------------------------------------------
// SCREEN: Session complete — all prompts in this batch have been handled.
// ---------------------------------------------------------------------------
function renderSessionComplete(container) {
    container.innerHTML = `
        <div class="empty-state">
            <h3>That's everything for now</h3>
            <p class="mt-2">You're all caught up. Thank you for your input — it makes a real difference for the team.</p>
        </div>
    `;
}