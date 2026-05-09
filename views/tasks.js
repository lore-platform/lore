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

// Whether this Reviewer has completed at least one task before this session.
// Used to skip the welcome gate on return visits — returning Reviewers go
// directly to the first prompt rather than the orientation screen.
let _isReturningReviewer = false;

// Cached reference to the tasks-content container — needed by the onSnapshot
// listener so it can re-render without re-running the full init path.
let _tasksContainer = null;

// Unsubscribe handle for the pending tasks onSnapshot listener.
// Stored so it can be torn down if the view is unmounted.
let _tasksSnapshotUnsub = null;

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
    _tasksContainer = container;

    // Determine whether this is a returning Reviewer by checking for any
    // previously completed task. If at least one completed task exists, we
    // skip the orientation welcome screen on subsequent visits.
    _isReturningReviewer = await _checkHasCompletedTask(orgId, uid);

    // Load any pending prompts for this Reviewer from Firestore
    _prompts = await _fetchPendingPrompts(orgId, uid);
    console.log('LORE tasks.js: Fetched', _prompts.length, 'pending prompts.');

    if (_prompts.length === 0) {
        renderAllClear(container);
        _startTasksSnapshot(orgId, uid);
        return;
    }

    _currentIndex = 0;
    // First-time Reviewers see the orientation welcome screen.
    // Returning Reviewers go straight to the first prompt.
    if (_isReturningReviewer) {
        renderPrompt(container, _prompts[_currentIndex]);
    } else {
        renderReviewerWelcome(container);
    }
    _startTasksSnapshot(orgId, uid);
}

// ---------------------------------------------------------------------------
// Check whether this Reviewer has ever completed a task.
// Returns true if at least one completed task document exists.
// Used to decide whether to show the orientation welcome screen.
// ---------------------------------------------------------------------------
async function _checkHasCompletedTask(orgId, uid) {
    const { db } = await import('../firebase.js');
    const { collection, query, where, limit, getDocs } =
        await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    try {
        const ref = collection(db, 'organisations', orgId, 'users', uid, 'tasks');
        const q   = query(ref, where('status', '==', 'completed'), limit(1));
        const snap = await getDocs(q);
        return !snap.empty;
    } catch (err) {
        console.warn('LORE tasks.js: Could not check completed tasks.', err);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Start an onSnapshot listener on this Reviewer's pending tasks.
// When new tasks arrive while they are on the session-complete or all-clear
// screen, the view re-initialises so they can act on them immediately
// without a page refresh.
// The listener is stored in _tasksSnapshotUnsub so it can be torn down
// if needed. It only triggers a re-render when the current screen is idle
// (session complete or all-clear) — it does not interrupt an active session.
// ---------------------------------------------------------------------------
async function _startTasksSnapshot(orgId, uid) {
    // Tear down any previous listener before starting a new one
    if (_tasksSnapshotUnsub) { _tasksSnapshotUnsub(); _tasksSnapshotUnsub = null; }

    const { db } = await import('../firebase.js');
    const { collection, query, where, orderBy, limit, onSnapshot } =
        await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

    const ref = collection(db, 'organisations', orgId, 'users', uid, 'tasks');
    const q   = query(ref, where('status', '==', 'pending'), orderBy('createdAt', 'asc'), limit(5));

    // Track whether this is the initial snapshot fire so we do not
    // re-render immediately on mount when we have already rendered.
    let isFirstFire = true;

    _tasksSnapshotUnsub = onSnapshot(q, snap => {
        if (isFirstFire) { isFirstFire = false; return; }

        // Only act if the Reviewer is currently on an idle screen.
        // If they are mid-session, do not interrupt — they will see the
        // new tasks in the next natural cycle after session complete.
        const container = _tasksContainer;
        if (!container) return;

        const newPrompts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        console.log('LORE tasks.js: onSnapshot fired — pending tasks now:', newPrompts.length);

        if (newPrompts.length > 0 && _currentIndex >= _prompts.length) {
            // We are on the idle screen — new tasks arrived. Restart.
            _prompts = newPrompts;
            _currentIndex = 0;
            _isReturningReviewer = true; // definitely returning at this point
            renderPrompt(container, _prompts[_currentIndex]);
        }
    }, err => {
        console.warn('LORE tasks.js: tasks onSnapshot error.', err);
    });
}
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
// SCREEN: Reviewer welcome — shown once per session before the first prompt,
// only for first-time Reviewers. Returning Reviewers skip this screen and
// go directly to the first prompt.
// Warm, brief, action-oriented. Not a tutorial.
// Copy rule: no mention of training, knowledge base, or capture.
// ---------------------------------------------------------------------------
function renderReviewerWelcome(container) {
    const count = _prompts.length;
    container.innerHTML = `
        <div style="max-width: 480px;">
            <div style="
                display: inline-flex;
                align-items: center;
                gap: var(--space-2);
                background: rgba(61,139,110,0.08);
                border: 1px solid rgba(61,139,110,0.18);
                border-radius: var(--radius-md);
                padding: var(--space-2) var(--space-3);
                margin-bottom: var(--space-5);
            ">
                <span style="color: var(--sage); font-size: var(--text-sm);">●</span>
                <span style="font-size: var(--text-xs); color: var(--sage); font-weight: 600; letter-spacing: 0.04em;">
                    Your input matters here
                </span>
            </div>

            <h2 style="margin-bottom: var(--space-4); line-height: 1.3;">
                You have
                <span style="color: var(--ember);">${count}</span>
                quick thing${count !== 1 ? 's' : ''} to review
            </h2>

            <p class="text-secondary" style="line-height: 1.7; margin-bottom: var(--space-4);">
                These are situations your team has been working through.
                Your perspective — what looks right, what feels off, what a more
                experienced read would look like — helps sharpen how the team handles these.
            </p>
            <p class="text-secondary text-sm" style="line-height: 1.7; margin-bottom: var(--space-6);">
                Each one takes about a minute. You can stop at any point and pick up where you left off.
            </p>

            <button class="btn btn-primary" id="reviewer-begin" style="width: 100%;">
                Get started
            </button>
        </div>
    `;
    document.getElementById('reviewer-begin')?.addEventListener('click', () => {
        renderPrompt(container, _prompts[_currentIndex]);
    });
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
    } else if (prompt.type === 'recipe_review') {
        renderRecipeReview(container, prompt, progress);
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

    // "Yes, this tracks" — no useful extraction, just advance.
    // Show minimum 600ms saving state so the click registers visually.
    document.getElementById('flag-yes')?.addEventListener('click', async () => {
        const btn = document.getElementById('flag-yes');
        btn.disabled = true;
        btn.textContent = 'Saving\u2026';
        await Promise.all([
            _markPromptComplete(_orgId, _uid, prompt.id),
            new Promise(r => setTimeout(r, 600)),
        ]);
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
            sourceType: 'scenario_review',
            rawContent: text,
            reviewerId: _uid,
            // rawPrompt stores the exact scenario text the Reviewer was reacting to.
            // This gives the extraction pipeline full question context — the Reviewer's
            // correction is only interpretable alongside what they were correcting.
            rawPrompt:  prompt.scenarioText ?? '',
        });

        await _markPromptComplete(_orgId, _uid, prompt.id);
        renderThankYou(container, () => advanceToNext(container), null);
    });
}

// ---------------------------------------------------------------------------
// SCREEN: Recipe accuracy check prompt.
// The Reviewer is shown the situation trigger and the action approach
// extracted from a recipe, and asked whether it reflects reality.
// Framed as a quality check on team knowledge — not as training material.
// Their response is staged as a raw extraction with sourceType 'recipe_review'.
//
// Three responses:
//   Confirm  — no useful correction, mark complete and advance.
//   Note     — mostly right but with a caveat; their note is the extraction.
//   Disagree — doesn't reflect reality; their correction is the extraction.
// ---------------------------------------------------------------------------
function renderRecipeReview(container, prompt, progress) {
    // Parse action steps from the stored actionSequence string.
    // Handles newline-separated steps (current format) and the legacy ., format.
    function parseSteps(raw) {
        const str = Array.isArray(raw) ? raw.join('\n') : String(raw ?? '');
        if (!str.trim()) return [];
        let lines = str.split('\n').map(s => s.trim()).filter(Boolean);
        if (lines.length === 1) lines = str.split('.,').map(s => s.trim()).filter(Boolean);
        return lines.map(l => l.replace(/^\d+\.\s*/, '').trim()).filter(Boolean);
    }
    const steps    = parseSteps(prompt.actionSequence);
    const stepsHtml = steps.length
        ? `<ol style="padding-left: var(--space-5); margin: 0;">${
            steps.map(s => `<li style="margin-bottom: var(--space-2); line-height: 1.7;">${s}</li>`).join('')
          }</ol>`
        : `<p style="line-height: 1.8;">${prompt.actionSequence ?? ''}</p>`;

    // The trigger becomes the active question the Reviewer is answering.
    // Format: "[trigger] — is this how we approach it?"
    const triggerQuestion = `${prompt.trigger ?? ''} — is this how we approach it?`;

    // Returning Reviewers see a compact progress header instead of the welcome screen.
    // This gives the count prominence without a full interstitial.
    const progressHeader = _isReturningReviewer ? `
        <div style="
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: var(--space-3) var(--space-4);
            background: rgba(44,36,22,0.03);
            border-radius: var(--radius-md);
            margin-bottom: var(--space-5);
            border: 1px solid rgba(44,36,22,0.07);
        ">
            <span style="font-size: var(--text-sm); font-weight: 600; color: var(--ink);">Your input today</span>
            <span style="
                font-size: var(--text-xs);
                font-weight: 700;
                color: var(--ember);
                background: rgba(180,80,30,0.08);
                border-radius: 100px;
                padding: 2px var(--space-3);
            ">${progress}</span>
        </div>
    ` : `
        <div class="flex-between mb-2">
            <p class="text-xs text-secondary" style="text-transform: uppercase; letter-spacing: 0.08em;">Quick check</p>
            <p class="text-xs text-secondary">${progress}</p>
        </div>
    `;

    container.innerHTML = `
        <div>
            ${progressHeader}

            <div class="card mt-4" style="border-left: 3px solid var(--ember);">
                <p style="font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.08em; color: var(--sage); font-weight: 600; margin-bottom: var(--space-1);">Skill</p>
                <h3 style="font-size: var(--text-base); font-weight: 700; margin-bottom: var(--space-3); line-height: 1.3;">${prompt.skillName ?? ''}</h3>
                <p style="font-size: var(--text-sm); line-height: 1.7; color: var(--ink);">${triggerQuestion}</p>
            </div>

            <div class="card mt-4">
                <p class="label mb-3">Here's what we have documented</p>
                <div style="font-size: var(--text-sm); color: var(--ink); line-height: 1.7;">
                    ${stepsHtml}
                </div>
            </div>

            <div class="card mt-4">
                <p class="label mb-4">Does this match how you'd actually approach it?</p>

                <div style="display: flex; gap: var(--space-3); flex-wrap: wrap; margin-bottom: var(--space-4);">
                    <button class="btn btn-secondary" id="recipe-confirm" style="flex: 1;">
                        Yes, this is right
                    </button>
                    <button class="btn btn-secondary" id="recipe-note" style="flex: 1;">
                        Mostly, with a note
                    </button>
                    <button class="btn btn-secondary" id="recipe-disagree" style="flex: 1;">
                        This doesn't reflect how we work
                    </button>
                </div>

                <div id="recipe-input-area" style="display: none; margin-top: var(--space-4);">
                    <p class="label mb-2" id="recipe-input-label"></p>
                    <textarea
                        class="input"
                        id="recipe-input-text"
                        rows="4"
                        style="resize: vertical;"
                    ></textarea>
                    <button class="btn btn-primary btn-full mt-4" id="recipe-submit">
                        Share your thinking
                    </button>
                </div>
            </div>
        </div>
    `;

    // Confirm — accurate as-is, no correction needed.
    // Show a minimum 600ms saving state so the click always registers visually.
    document.getElementById('recipe-confirm')?.addEventListener('click', async () => {
        const btn = document.getElementById('recipe-confirm');
        btn.disabled = true;
        btn.textContent = 'Saving\u2026';
        const [result] = await Promise.all([
            _markPromptComplete(_orgId, _uid, prompt.id),
            new Promise(r => setTimeout(r, 600)),
        ]);
        advanceToNext(container);
    });

    // Helper to reveal the text input with the right label and placeholder
    function showInput(label, placeholder) {
        document.getElementById('recipe-confirm').style.display   = 'none';
        document.getElementById('recipe-note').style.display      = 'none';
        document.getElementById('recipe-disagree').style.display  = 'none';
        document.getElementById('recipe-input-label').textContent = label;
        const textarea = document.getElementById('recipe-input-text');
        textarea.placeholder = placeholder;
        document.getElementById('recipe-input-area').style.display = 'block';
        textarea.focus();
    }

    document.getElementById('recipe-note')?.addEventListener('click', () => {
        showInput(
            'What would you add or adjust?',
            `Share what you'd do differently, or what context is missing\u2026`
        );
    });

    document.getElementById('recipe-disagree')?.addEventListener('click', () => {
        showInput(
            'What would make this more accurate?',
            `Describe how your team actually handles this situation\u2026`
        );
    });

    // Submit correction or note — this is where the extraction happens
    document.getElementById('recipe-submit')?.addEventListener('click', async () => {
        const text = document.getElementById('recipe-input-text')?.value?.trim();
        if (!text) {
            document.getElementById('recipe-input-text').focus();
            return;
        }

        const btn = document.getElementById('recipe-submit');
        btn.disabled = true;
        btn.textContent = 'Saving\u2026';

        // Stage the Reviewer's response as a raw extraction.
        // rawPrompt carries the full context — trigger and action sequence —
        // so the extraction pipeline can interpret the correction correctly.
        await createExtraction(_orgId, {
            sourceType: 'recipe_review',
            rawContent: text,
            reviewerId: _uid,
            rawPrompt:  `When this comes up: ${prompt.trigger ?? ''}\n\nOur current approach:\n${prompt.actionSequence ?? ''}`,
        });

        await _markPromptComplete(_orgId, _uid, prompt.id);
        renderThankYou(container, () => advanceToNext(container), prompt.skillName);
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
            sourceType: 'mentorship_note',
            rawContent: text,
            reviewerId: _uid,
            // rawPrompt combines the scenario and the employee response so the
            // extraction pipeline has the full context the Reviewer was coaching on.
            // Concatenated here because both together form the question that prompted
            // the Reviewer's expert answer.
            rawPrompt:  `Scenario: ${prompt.scenarioText ?? ''}\n\nEmployee response: ${prompt.employeeResponse ?? ''}`,
        });

        await _markPromptComplete(_orgId, _uid, prompt.id);
        renderThankYou(container, () => advanceToNext(container), null);
    });
}

// ---------------------------------------------------------------------------
// SCREEN: Brief confirmation after submitting.
// Warm and considered — the Reviewer just contributed expert knowledge and
// should feel that weight, even subtly. Not celebratory, but not a system
// notification either. Holds for 2.5 seconds so it cannot be blinked past.
// skillName is optional — shown as a contextual line when available.
// ---------------------------------------------------------------------------
function renderThankYou(container, next, skillName) {
    const contextLine = skillName
        ? `<p class="text-secondary text-sm mt-3" style="line-height: 1.6;">Your read on <strong>${skillName}</strong> has been noted.</p>`
        : `<p class="text-secondary mt-2">Your perspective helps the team handle these situations better.</p>`;

    container.innerHTML = `
        <div style="
            max-width: 400px;
            padding: var(--space-8) var(--space-6);
            background: rgba(61,139,110,0.05);
            border: 1px solid rgba(61,139,110,0.15);
            border-radius: var(--radius-lg);
            text-align: center;
        ">
            <div style="
                width: 48px; height: 48px;
                border-radius: 50%;
                background: rgba(61,139,110,0.12);
                display: flex; align-items: center; justify-content: center;
                margin: 0 auto var(--space-4);
                font-size: 22px;
            ">✓</div>
            <p style="font-size: var(--text-lg); font-weight: 600; color: var(--sage);">Noted — thank you</p>
            ${contextLine}
        </div>
    `;
    setTimeout(next, 2500);
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