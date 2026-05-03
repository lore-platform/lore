// =============================================================================
// LORE — Training View (Employee)
// The Employee's primary experience. Covers the full core loop:
//   ASSIGNED QUEUE → DUE TODAY → ENCOUNTER → RESPOND → RESULT → RECIPE UNLOCK → CONTINUE
//
// Domain selection has been removed entirely. The Manager assigns skill areas
// to each Employee via the dashboard track assignment. The Employee trains
// within those assigned areas only.
//
// Due Today queue (spaced retrieval): recipes with a dueAt in the past are
// surfaced first, up to five items, ordered by dueAt ascending.
//
// Calibration: first-time employees see a calibration intro — not framed as
// a test, framed as helping LORE understand their starting point.
//
// Scenario types: Judgement, Recognition, Reflection.
// Each scenario is AI-generated from a Career Recipe and cached in Firestore.
// Responses are AI-evaluated against the source recipe.
//
// The visible countdown timer has been removed entirely. Response start time
// is recorded invisibly when the scenario renders and secondsTaken is computed
// on submission. No timer UI, no warning states, no auto-submit.
//
// Import paths: views/ files import engine files using ../engine/[file].js.
// =============================================================================

import { getRecipe, saveToLibrary } from '../engine/recipes.js';
import {
    fetchOrGenerateScenario,
    prePullNextScenario,
    clearPrePull,
    evaluateResponse,
} from '../engine/scenarios.js';
import { recordResponse } from '../engine/state.js';
import { getXPProgress, getRankForXP } from '../engine/utils.js';

// ---------------------------------------------------------------------------
// Module-level state for this view.
// ---------------------------------------------------------------------------
let _orgId   = null;
let _uid     = null;
let _state   = null;

// The assigned domains for this Employee — populated from their user document.
// Empty means the Manager has not yet assigned a track.
let _assignedDomains = [];

// Current session
let _activeDomain   = null;
let _activeScenario = null;
let _activeRecipe   = null;

// Recorded when the scenario renders — used to compute secondsTaken on submit.
// The timer is invisible to the Employee.
let _startedAt = null;

// Whether we are currently working through the Due Today queue.
// When true, the queue is iterated in order before moving to new material.
let _dueTodayQueue    = [];
let _dueTodayIndex    = 0;
let _inDueTodayQueue  = false;

// ---------------------------------------------------------------------------
// Entry point — called by app.js after auth.
// state: the loaded state object from loadState() in state.js.
// ---------------------------------------------------------------------------
export async function initTraining(orgId, uid, state) {
    _orgId = orgId;
    _uid   = uid;
    _state = state;

    const container = document.getElementById('training-content');
    if (!container) return;

    console.log('LORE training.js: initTraining — orgId:', orgId, 'uid:', uid, 'seniority:', state.seniority);

    // IA-02 (Employee side): Read assignedDomains from the user document.
    // The Manager sets these via the dashboard track assignment panel.
    // We need to re-read from Firestore rather than state, because state.js
    // does not currently cache assignedDomains in localStorage.
    const userDoc = await _loadUserDoc(orgId, uid);
    _assignedDomains = userDoc?.assignedDomains ?? [];

    // Update local state with seniority and roleTitle from the user document.
    // These may have been set at invite time and are needed for evaluateResponse().
    _state = {
        ..._state,
        seniority: userDoc?.seniority ?? state.seniority ?? 'mid',
        roleTitle: userDoc?.roleTitle ?? state.roleTitle ?? '',
    };

    // If no domains are assigned, show a holding screen.
    // The Manager must assign the track before training can begin.
    if (_assignedDomains.length === 0) {
        renderHoldingScreen(container);
        return;
    }

    // Calibration intro for first-time employees (sessionsTotal === 0).
    if (_state.sessionsTotal === 0) {
        renderCalibrationIntro(container);
        return;
    }

    // ENG-01: Load the Due Today queue before rendering anything else.
    // Up to 5 items with dueAt in the past, ordered by dueAt ascending.
    _dueTodayQueue   = await _loadDueTodayQueue(orgId, uid);
    _dueTodayIndex   = 0;
    _inDueTodayQueue = _dueTodayQueue.length > 0;

    renderQueue(container);
}

// ---------------------------------------------------------------------------
// Load the full user document from Firestore.
// Needed for assignedDomains, seniority, roleTitle — which are not all
// stored in the localStorage state layer.
// Returns the document data object or null.
// ---------------------------------------------------------------------------
async function _loadUserDoc(orgId, uid) {
    const { db } = await import('../firebase.js');
    const { doc, getDoc } = await import(
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );
    try {
        const snap = await getDoc(doc(db, 'organisations', orgId, 'users', uid));
        return snap.exists() ? snap.data() : null;
    } catch (err) {
        console.warn('LORE training.js: Could not load user document.', err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// ENG-01 — Load the Due Today queue.
// Queries recipeProgress/ for items where dueAt is in the past, limit 5.
// Returns an array of recipeProgress objects sorted by dueAt ascending.
// ---------------------------------------------------------------------------
async function _loadDueTodayQueue(orgId, uid) {
    const { db } = await import('../firebase.js');
    const {
        collection, query, where, orderBy, limit, getDocs, Timestamp,
    } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

    try {
        const now = Timestamp.now();
        const ref = collection(db, 'organisations', orgId, 'users', uid, 'recipeProgress');
        const q   = query(
            ref,
            where('dueAt', '<=', now),
            orderBy('dueAt', 'asc'),
            limit(5)   // [TUNING TARGET] Cap at 5 due items per session
        );
        const snap = await getDocs(q);
        const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        console.log('LORE training.js: Due Today queue —', items.length, 'item(s).');
        return items;
    } catch (err) {
        console.warn('LORE training.js: Could not load Due Today queue.', err);
        return [];
    }
}

// ---------------------------------------------------------------------------
// SCREEN: Holding screen — no track assigned yet.
// Shown when assignedDomains is empty.
// Does not mention "domains" or "track" — framed as the manager getting things ready.
// ---------------------------------------------------------------------------
function renderHoldingScreen(container) {
    container.innerHTML = `
        <div class="empty-state">
            <h3>Your training is being set up</h3>
            <p class="mt-2" style="max-width: 380px; line-height: 1.6;">
                Your manager is putting together your learning path. You'll get a notification when it's ready — usually within a day or two.
            </p>
        </div>
    `;
}

// ---------------------------------------------------------------------------
// SCREEN: Calibration intro — first-time employee.
// Framed as understanding their starting point, not as a test.
// ---------------------------------------------------------------------------
function renderCalibrationIntro(container) {
    container.innerHTML = `
        <div style="max-width: 520px;">
            <p class="text-xs text-secondary" style="text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: var(--space-3);">Welcome to LORE</p>
            <h1 style="line-height: 1.2; margin-bottom: var(--space-4);">Training built around how your team actually works</h1>
            <p class="text-secondary" style="line-height: 1.7; margin-bottom: var(--space-6);">
                LORE trains you through real situations from your field — the kinds of calls your most experienced colleagues make without thinking twice. You respond the way you'd actually handle it, and LORE tells you what a more experienced read of that situation looks like.
            </p>

            <div class="card" style="margin-bottom: var(--space-4);">
                <p style="font-weight: 500; margin-bottom: var(--space-3);">What to expect</p>
                <div style="display: flex; flex-direction: column; gap: var(--space-3);">
                    <div style="display: flex; gap: var(--space-3); align-items: flex-start;">
                        <span style="color: var(--ember); font-weight: 600; flex-shrink: 0; margin-top: 1px;">1</span>
                        <p class="text-secondary text-sm" style="line-height: 1.6;">Read a workplace situation and write how you'd respond. There are no trick questions — just respond honestly.</p>
                    </div>
                    <div style="display: flex; gap: var(--space-3); align-items: flex-start;">
                        <span style="color: var(--ember); font-weight: 600; flex-shrink: 0; margin-top: 1px;">2</span>
                        <p class="text-secondary text-sm" style="line-height: 1.6;">Get immediate feedback on what you got right, what you missed, and what a senior person would have done differently.</p>
                    </div>
                    <div style="display: flex; gap: var(--space-3); align-items: flex-start;">
                        <span style="color: var(--ember); font-weight: 600; flex-shrink: 0; margin-top: 1px;">3</span>
                        <p class="text-secondary text-sm" style="line-height: 1.6;">LORE adapts to your level over time — surfacing harder scenarios as your accuracy improves.</p>
                    </div>
                </div>
            </div>

            <p class="text-xs text-secondary" style="margin-bottom: var(--space-6);">Your first session helps LORE calibrate to your current level. It takes about 10 to 15 minutes.</p>

            <button class="btn btn-primary" id="start-calibration" style="width: 100%;">
                Start training
            </button>
        </div>
    `;

    document.getElementById('start-calibration')?.addEventListener('click', () => {
        renderQueue(container);
    });
}

// ---------------------------------------------------------------------------
// SCREEN: Queue — the main landing screen after calibration.
// Shows the Due Today section first if any items are due, then the full
// list of assigned skill areas the Employee can choose from.
// ---------------------------------------------------------------------------
function renderQueue(container) {
    clearPrePull();

    const xpData = getXPProgress(_state.xp ?? 0);

    // Build domain stats for display
    const domainCards = _assignedDomains.map(domainName => {
        const mastery  = _state.domainMastery?.[domainName] ?? { played: 0, correct: 0 };
        const accuracy = mastery.played > 0
            ? Math.round((mastery.correct / mastery.played) * 100)
            : null;
        return { name: domainName, accuracy, played: mastery.played };
    });

    const hasDueToday = _dueTodayQueue.length > 0;

    container.innerHTML = `
        <div>
            <div class="flex-between mb-6">
                <div>
                    <h1>Training</h1>
                </div>
                <div style="text-align: right;">
                    <p class="text-xs text-secondary">Your rank</p>
                    <p style="font-weight: 600; color: var(--ember); margin-top: 2px;">
                        ${getRankForXP(_state.xp ?? 0).name}
                    </p>
                </div>
            </div>

            ${_renderXPBar(_state.xp ?? 0, xpData)}

            <!-- ENG-01: Due Today section — shown when spaced retrieval items are due -->
            ${hasDueToday ? `
                <div style="margin-top: var(--space-8); margin-bottom: var(--space-6);">
                    <div style="display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-4);">
                        <h3>Due today</h3>
                        <span style="
                            background: var(--ember);
                            color: white;
                            font-size: 10px;
                            font-weight: 600;
                            border-radius: 999px;
                            padding: 2px 8px;
                            line-height: 1.6;
                        ">${_dueTodayQueue.length}</span>
                    </div>
                    <p class="text-secondary text-sm mb-4" style="line-height: 1.6;">
                        These are recipes you've seen before — it's time to revisit them. Working through them first keeps the knowledge fresh.
                    </p>
                    <button class="btn btn-primary" id="start-due-today">
                        Start due items
                    </button>
                </div>

                <div style="border-top: 1px solid rgba(44,36,22,0.08); margin-bottom: var(--space-6);"></div>
            ` : ''}

            <!-- Assigned skill areas -->
            <div ${hasDueToday ? `style="margin-top: var(--space-4);"` : `style="margin-top: var(--space-8);"`}>
                <h3 style="margin-bottom: var(--space-4);">Your skill areas</h3>
                ${domainCards.map((d, i) => `
                    <div class="card" id="domain-card-${i}"
                        style="cursor: pointer; margin-bottom: var(--space-4);">
                        <div class="flex-between">
                            <div>
                                <h3>${d.name}</h3>
                            </div>
                            <div style="text-align: right; flex-shrink: 0; margin-left: var(--space-4);">
                                ${d.accuracy !== null
                                    ? `<p style="font-size: var(--text-xl); font-weight: 600;">${d.accuracy}%</p>
                                       <p class="text-xs text-secondary">accuracy</p>`
                                    : `<p class="text-xs text-secondary">Not started</p>`
                                }
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;

    // Due Today button — start the spaced retrieval queue
    document.getElementById('start-due-today')?.addEventListener('click', () => {
        _inDueTodayQueue = true;
        _dueTodayIndex   = 0;
        _startNextDueItem(container);
    });

    // Skill area cards — start a free session in that domain
    domainCards.forEach((d, i) => {
        document.getElementById(`domain-card-${i}`)?.addEventListener('click', () => {
            _inDueTodayQueue = false;
            _activeDomain    = { name: d.name };
            startSession(container);
        });
    });
}

// ---------------------------------------------------------------------------
// ENG-01 — Start the next item in the Due Today queue.
// Each due item is a recipeProgress record — we use its recipeId to fetch
// the recipe, then fetch or generate a scenario for the associated domain.
// ---------------------------------------------------------------------------
async function _startNextDueItem(container) {
    if (_dueTodayIndex >= _dueTodayQueue.length) {
        // Due Today queue exhausted — return to the main queue screen
        _inDueTodayQueue = false;
        _dueTodayQueue   = [];
        _dueTodayIndex   = 0;
        renderQueue(container);
        return;
    }

    const dueItem = _dueTodayQueue[_dueTodayIndex];
    console.log('LORE training.js: Starting due item', _dueTodayIndex + 1, 'of', _dueTodayQueue.length, '— recipeId:', dueItem.recipeId);

    renderLoading(container, 'Loading your next review…');

    // Set the active domain from the recipeProgress record
    _activeDomain = { name: dueItem.domain ?? _assignedDomains[0] };

    // Fetch the recipe directly — due items target a specific recipe
    _activeRecipe = await getRecipe(_orgId, dueItem.recipeId);

    if (!_activeRecipe) {
        // Recipe not found — skip this due item and continue
        console.warn('LORE training.js: Could not load recipe for due item:', dueItem.recipeId, '— skipping.');
        _dueTodayIndex++;
        _startNextDueItem(container);
        return;
    }

    // Fetch or generate a scenario for this specific recipe
    const scenario = await fetchOrGenerateScenario(
        _orgId,
        _activeDomain.name,
        { seniority: _state.seniority ?? 'mid', uid: _uid, recipeId: dueItem.recipeId }
    );

    if (!scenario) {
        console.warn('LORE training.js: No scenario available for due item — skipping.');
        _dueTodayIndex++;
        _startNextDueItem(container);
        return;
    }

    _activeScenario = scenario;
    renderEncounter(container, scenario, {
        isDueItem: true,
        dueIndex:  _dueTodayIndex,
        dueTotal:  _dueTodayQueue.length,
    });
}

// ---------------------------------------------------------------------------
// Start a free session in the selected skill area.
// ---------------------------------------------------------------------------
async function startSession(container) {
    renderLoading(container, 'Getting your next scenario…');

    const scenario = await fetchOrGenerateScenario(
        _orgId,
        _activeDomain.name,
        { seniority: _state.seniority ?? 'mid', uid: _uid }
    );

    if (!scenario) {
        container.innerHTML = `
            <div class="empty-state">
                <h3>Nothing available right now</h3>
                <p class="mt-2">This skill area doesn't have training scenarios ready yet. Try another area or check back later.</p>
                <button class="btn btn-secondary mt-6" id="back-to-queue">Back to training</button>
            </div>
        `;
        document.getElementById('back-to-queue')?.addEventListener('click', () => renderQueue(container));
        return;
    }

    _activeScenario = scenario;

    // Fetch the source recipe if one is associated with the scenario
    if (scenario.recipeId) {
        _activeRecipe = await getRecipe(_orgId, scenario.recipeId);
    } else if (scenario.recipe) {
        _activeRecipe = scenario.recipe;
    } else {
        _activeRecipe = null;
    }

    renderEncounter(container, scenario, { isDueItem: false });
}

// ---------------------------------------------------------------------------
// SCREEN: Encounter — the scenario and response input.
//
// COG-01: The visible countdown timer is removed entirely.
// _startedAt is recorded here invisibly. secondsTaken is computed on submit.
// No timer DOM element, no warning/urgent CSS classes, no auto-submit.
// ---------------------------------------------------------------------------
function renderEncounter(container, scenario, { isDueItem = false, dueIndex = 0, dueTotal = 0 } = {}) {
    // Record start time invisibly — secondsTaken computed on submit
    _startedAt = Date.now();

    const typeLabel = {
        judgement:   'Judgement',
        recognition: 'Recognition',
        reflection:  'Reflection',
    }[scenario.scenarioType] ?? 'Scenario';

    // Context line — Due Today items get a "revisiting" header
    const contextLine = isDueItem
        ? `<p class="text-xs text-secondary" style="text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: var(--space-2);">Revisiting · ${dueIndex + 1} of ${dueTotal}</p>`
        : '';

    container.innerHTML = `
        <div>
            <div style="margin-bottom: var(--space-4);">
                ${contextLine}
                <span class="scenario-type">${typeLabel} · ${_activeDomain?.name ?? ''}</span>
            </div>

            <div class="card">
                <p style="white-space: pre-wrap; line-height: 1.8;">${scenario.text ?? ''}</p>
            </div>

            <div class="card mt-4">
                <label class="label" for="response-input">
                    ${scenario.questionPrompt ?? 'What do you notice, and what would you do?'}
                </label>
                <textarea
                    class="input"
                    id="response-input"
                    rows="6"
                    placeholder="Write your response here. Be specific — what are you noticing, and what would you actually do?"
                    style="margin-top: var(--space-3);"
                ></textarea>
            </div>

            <div class="flex-between mt-4">
                <button class="btn btn-secondary" id="back-from-encounter">Back</button>
                <button class="btn btn-primary" id="submit-response">Submit response</button>
            </div>
        </div>
    `;

    document.getElementById('back-from-encounter')?.addEventListener('click', () => {
        renderQueue(container);
    });

    document.getElementById('submit-response')?.addEventListener('click', () => {
        const response = document.getElementById('response-input')?.value?.trim();
        if (!response) {
            document.getElementById('response-input')?.focus();
            return;
        }
        handleSubmit(container, response, scenario, isDueItem);
    });
}

// ---------------------------------------------------------------------------
// Handle response submission — evaluate and show result.
// ---------------------------------------------------------------------------
async function handleSubmit(container, response, scenario, isDueItem) {
    renderLoading(container, 'Reading your response…');

    // Compute secondsTaken from the invisible start time recorded in renderEncounter().
    // This is stored in patternSignals for the Manager — not shown to the Employee.
    const secondsTaken = _startedAt ? Math.round((Date.now() - _startedAt) / 1000) : null;

    // CORP-01: seniority and roleTitle are now passed to evaluateResponse()
    // so the response corpus entry has the correct seniority for analysis.
    const evaluation = await evaluateResponse(
        response,
        scenario,
        _activeRecipe,
        _orgId,
        _uid,
        secondsTaken,
        _state.seniority  ?? 'mid',
        _state.roleTitle  ?? ''
    );

    // Record XP, streak, and (ENG-01) recipeProgress for spaced retrieval.
    // recipeId is passed so state.js can write the recipeProgress document.
    const recipeId = _activeRecipe?.id ?? scenario.recipeId ?? null;
    const xpResult = await recordResponse(
        evaluation.verdict,
        _activeDomain?.name ?? 'general',
        recipeId
    );

    // Update local state reference
    _state = { ..._state, xp: xpResult.newTotal, streak: xpResult.newRank ? _state.streak : _state.streak };

    // Refresh nav bar — avoids circular import with app.js
    const xpEl   = document.getElementById('nav-xp-value');
    const strEl  = document.getElementById('nav-streak-value');
    const rankEl = document.getElementById('nav-rank');
    if (xpEl)   xpEl.textContent  = (xpResult.newTotal ?? 0).toLocaleString();
    if (strEl)  strEl.textContent = _state.streak ?? 0;
    if (rankEl) rankEl.textContent = getRankForXP(xpResult.newTotal ?? 0).name;

    // Pre-pull the next scenario while the Employee reads the result screen.
    // This runs in the background — the result renders immediately.
    prePullNextScenario(_orgId, _activeDomain?.name, {
        seniority: _state.seniority ?? 'mid',
        uid: _uid,
    });

    renderResult(container, evaluation, xpResult, isDueItem);
}

// ---------------------------------------------------------------------------
// SCREEN: Result — verdict, explanation, XP gained.
//
// LEARN-01: Missed verdicts are rebuilt as a three-step progressive sequence.
// LEARN-02: Recipe unlock card varies by verdict.
// ---------------------------------------------------------------------------
function renderResult(container, evaluation, xpResult, isDueItem) {
    const verdict   = evaluation.verdict;
    const isCorrect = verdict === 'correct';
    const isPartial = verdict === 'partial';
    const isMissed  = verdict === 'missed';

    if (isMissed && _activeRecipe) {
        // LEARN-01: Missed verdict — three-step progressive sequence.
        renderMissedStep1(container, evaluation, xpResult, isDueItem);
        return;
    }

    const verdictLabel = isCorrect ? 'Correct' : 'Close';
    const chipClass    = isCorrect ? 'chip-correct' : 'chip-pending';

    const xpLine = xpResult.xpGained > 0
        ? `<p class="text-sm text-secondary mt-2">+${xpResult.xpGained} XP</p>`
        : '';

    const rankUpLine = xpResult.rankUp
        ? `<div class="card mt-4" style="border: 1px solid var(--ember); text-align: center;">
               <p style="color: var(--ember); font-weight: 600;">You reached ${xpResult.newRank.name}</p>
           </div>`
        : '';

    container.innerHTML = `
        <div>
            <div class="flex-between mb-4">
                <span class="chip ${chipClass}">${verdictLabel}</span>
                ${xpLine}
            </div>

            ${rankUpLine}

            <div class="card mt-4">
                <p style="line-height: 1.8;">${evaluation.explanation}</p>
            </div>

            ${_activeRecipe ? _renderRecipeUnlock(verdict) : ''}

            <div class="flex-between mt-6">
                <button class="btn btn-secondary" id="result-back">Back to training</button>
                <button class="btn btn-primary" id="result-next">Next scenario</button>
            </div>
        </div>
    `;

    // LEARN-02: Save to library — only on correct and partial
    if (_activeRecipe && (isCorrect || isPartial)) {
        document.getElementById('save-recipe')?.addEventListener('click', async (e) => {
            e.target.disabled    = true;
            e.target.textContent = 'Saved';
            await saveToLibrary(_orgId, _uid, _activeRecipe);
        });
    }

    document.getElementById('result-back')?.addEventListener('click', () => {
        clearPrePull();
        renderQueue(container);
    });

    document.getElementById('result-next')?.addEventListener('click', () => {
        if (isDueItem && _inDueTodayQueue) {
            _dueTodayIndex++;
            _startNextDueItem(container);
        } else {
            startSession(container);
        }
    });
}

// ---------------------------------------------------------------------------
// LEARN-01 — Missed verdict: Step 1.
// Names the principle — what skill was being tested and when it applies.
// Derived from the recipe's skillName and trigger, reframed as a named principle.
// ---------------------------------------------------------------------------
function renderMissedStep1(container, evaluation, xpResult, isDueItem) {
    const r = _activeRecipe;

    container.innerHTML = `
        <div>
            <div class="flex-between mb-4">
                <span class="chip chip-missed">Missed</span>
            </div>

            <div class="card mt-4">
                <p style="line-height: 1.8;">${evaluation.explanation}</p>
            </div>

            <!-- Named principle card -->
            <div class="card mt-4" style="border-left: 3px solid var(--ember);">
                <p class="text-xs text-secondary" style="text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: var(--space-3);">
                    The principle at work
                </p>
                <p style="font-weight: 600; margin-bottom: var(--space-2);">${r.skillName}</p>
                <p class="text-secondary text-sm" style="line-height: 1.6;">${r.trigger}</p>
            </div>

            <div class="flex-between mt-6">
                <button class="btn btn-secondary" id="missed-step1-back">Back to training</button>
                <button class="btn btn-primary" id="missed-step1-next">See what experienced looks like</button>
            </div>
        </div>
    `;

    document.getElementById('missed-step1-back')?.addEventListener('click', () => {
        clearPrePull();
        renderQueue(container);
    });

    document.getElementById('missed-step1-next')?.addEventListener('click', () => {
        renderMissedStep2(container, evaluation, xpResult, isDueItem);
    });
}

// ---------------------------------------------------------------------------
// LEARN-01 — Missed verdict: Step 2.
// LEARN-02: Shows the recipe card headed "What an experienced read looks like".
// No save button — missed verdicts do not unlock save.
// flawPattern is shown as "What less experienced people tend to do."
// ---------------------------------------------------------------------------
function renderMissedStep2(container, evaluation, xpResult, isDueItem) {
    const r = _activeRecipe;

    container.innerHTML = `
        <div>
            <!-- LEARN-02: Missed verdict recipe card — no save button -->
            <div class="card" style="border-left: 3px solid var(--ember);">
                <p class="text-xs text-secondary" style="text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: var(--space-3);">
                    What an experienced read looks like
                </p>

                <h3 style="margin-bottom: var(--space-4);">${r.skillName}</h3>

                <div style="margin-bottom: var(--space-4);">
                    <p class="label mb-1">When this applies</p>
                    <p class="text-sm text-secondary" style="line-height: 1.6;">${r.trigger}</p>
                </div>

                <div style="margin-bottom: var(--space-4);">
                    <p class="label mb-1">What to do</p>
                    <p class="text-sm text-secondary" style="line-height: 1.6;">${r.actionSequence}</p>
                </div>

                <div style="margin-bottom: var(--space-4);">
                    <p class="label mb-1">What it produces</p>
                    <p class="text-sm text-secondary" style="line-height: 1.6;">${r.expectedOutcome}</p>
                </div>

                ${r.flawPattern ? `
                    <div style="background: rgba(184,50,50,0.05); border-radius: var(--radius-md); padding: var(--space-3) var(--space-4);">
                        <p class="label mb-1">What less experienced people tend to do</p>
                        <p class="text-sm text-secondary" style="line-height: 1.6;">${r.flawPattern}</p>
                    </div>
                ` : ''}
            </div>

            <div class="flex-between mt-6">
                <button class="btn btn-secondary" id="missed-step2-back">Back to training</button>
                <button class="btn btn-primary" id="missed-step2-next">Try a recovery scenario</button>
            </div>
        </div>
    `;

    document.getElementById('missed-step2-back')?.addEventListener('click', () => {
        clearPrePull();
        renderQueue(container);
    });

    document.getElementById('missed-step2-next')?.addEventListener('click', () => {
        renderMissedStep3(container, evaluation, xpResult, isDueItem);
    });
}

// ---------------------------------------------------------------------------
// LEARN-01 — Missed verdict: Step 3.
// Recovery micro-scenario — pre-generated during result screen render
// alongside the next main scenario pre-pull. Not scored for XP.
// Submit button reads "Try it". One-line AI acknowledgement only, then
// standard next-scenario controls.
// ---------------------------------------------------------------------------
async function renderMissedStep3(container, evaluation, xpResult, isDueItem) {
    renderLoading(container, 'Preparing a recovery scenario…');

    // Generate a targeted recovery micro-scenario from the recipe.
    // This is a shorter, more direct scenario that gives the Employee
    // an immediate chance to apply the principle they just missed.
    const { generate } = await import('../engine/ai.js');
    const r = _activeRecipe;

    const systemPrompt = `You are generating a short recovery scenario for a professional training platform.
The learner just missed a scenario testing the skill: "${r.skillName}".
Your job is to generate one focused scenario — shorter and more direct than usual — that gives them an immediate opportunity to apply the principle they missed.
Return a JSON object with exactly two fields:
{
  "scenarioText": "The scenario — 2 to 4 sentences, workplace context, specific and realistic",
  "questionPrompt": "One direct question — 10 words or fewer"
}
Return the JSON object only — no other text, no markdown.`;

    const prompt = `Skill: ${r.skillName}
Trigger: ${r.trigger}
Action: ${r.actionSequence}
Generate the recovery scenario.`;

    const { extractJSON } = await import('../engine/utils.js');
    const aiResult = await generate(prompt, systemPrompt);
    let microScenario = null;

    if (aiResult.ok) {
        microScenario = extractJSON(aiResult.text);
    }

    if (!microScenario || !microScenario.scenarioText) {
        // If generation fails, skip to standard next-scenario controls
        _renderMissedStep3Fallback(container, isDueItem);
        return;
    }

    container.innerHTML = `
        <div>
            <p class="text-xs text-secondary" style="text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: var(--space-3);">
                Try it now
            </p>

            <div class="card">
                <p style="white-space: pre-wrap; line-height: 1.8;">${microScenario.scenarioText}</p>
            </div>

            <div class="card mt-4">
                <label class="label" for="recovery-input">
                    ${microScenario.questionPrompt ?? 'What would you do?'}
                </label>
                <textarea
                    class="input"
                    id="recovery-input"
                    rows="4"
                    placeholder="Apply the principle — write your response."
                    style="margin-top: var(--space-3);"
                ></textarea>
            </div>

            <div class="flex-between mt-4">
                <button class="btn btn-secondary" id="recovery-skip">Skip</button>
                <button class="btn btn-primary" id="recovery-submit">Try it</button>
            </div>

            <div id="recovery-acknowledgement" style="display: none; margin-top: var(--space-4);"></div>
        </div>
    `;

    document.getElementById('recovery-skip')?.addEventListener('click', () => {
        _afterMissedRecovery(container, isDueItem);
    });

    document.getElementById('recovery-submit')?.addEventListener('click', async () => {
        const response = document.getElementById('recovery-input')?.value?.trim();
        if (!response) {
            document.getElementById('recovery-input')?.focus();
            return;
        }

        const submitBtn = document.getElementById('recovery-submit');
        const skipBtn   = document.getElementById('recovery-skip');
        submitBtn.disabled    = true;
        submitBtn.textContent = 'Reading…';

        // One-line AI acknowledgement — no verdict, no XP, not scored.
        const ackSystemPrompt = `You are giving a one-line acknowledgement of a learner's response to a recovery scenario.
Be brief, warm, and specific to what they wrote. One sentence only. No score. No verdict. No mention of LORE.`;
        const ackPrompt = `Recovery scenario: ${microScenario.scenarioText}
Learner's response: ${response}
Acknowledge their response in one sentence.`;

        const ackResult = await generate(ackPrompt, ackSystemPrompt);
        const ackEl     = document.getElementById('recovery-acknowledgement');

        if (ackEl) {
            ackEl.style.display = 'block';
            ackEl.innerHTML = `
                <div class="card" style="border-left: 3px solid var(--sage);">
                    <p class="text-sm" style="line-height: 1.6;">${ackResult.ok ? ackResult.text : 'Good effort — keep applying this as situations come up.'}</p>
                </div>
                <div class="flex-between mt-6">
                    <button class="btn btn-secondary" id="recovery-back">Back to training</button>
                    <button class="btn btn-primary" id="recovery-continue">Continue</button>
                </div>
            `;
            document.getElementById('recovery-back')?.addEventListener('click', () => {
                clearPrePull();
                renderQueue(container);
            });
            document.getElementById('recovery-continue')?.addEventListener('click', () => {
                _afterMissedRecovery(container, isDueItem);
            });
        }

        submitBtn.style.display = 'none';
        skipBtn.style.display   = 'none';
    });
}

// Called when the recovery micro-scenario is complete or skipped.
function _afterMissedRecovery(container, isDueItem) {
    if (isDueItem && _inDueTodayQueue) {
        _dueTodayIndex++;
        _startNextDueItem(container);
    } else {
        startSession(container);
    }
}

// Fallback if the recovery scenario generation fails — show standard controls.
function _renderMissedStep3Fallback(container, isDueItem) {
    container.innerHTML = `
        <div class="empty-state">
            <p class="text-secondary">Keep that principle in mind — you'll see it again soon.</p>
            <div class="flex-between mt-6" style="width: 100%; max-width: 360px;">
                <button class="btn btn-secondary" id="fallback-back">Back to training</button>
                <button class="btn btn-primary" id="fallback-next">Next scenario</button>
            </div>
        </div>
    `;
    document.getElementById('fallback-back')?.addEventListener('click', () => {
        clearPrePull();
        renderQueue(container);
    });
    document.getElementById('fallback-next')?.addEventListener('click', () => {
        _afterMissedRecovery(container, isDueItem);
    });
}

// ---------------------------------------------------------------------------
// LEARN-02 — Recipe unlock card, varied by verdict.
//
// correct → "The expert's approach" + save button
// partial → "What you were close to" + save button
// missed  → handled by LEARN-01 three-step flow — this function is not called
// ---------------------------------------------------------------------------
function _renderRecipeUnlock(verdict) {
    const r = _activeRecipe;
    if (!r) return '';

    const isCorrect = verdict === 'correct';
    const isPartial = verdict === 'partial';

    const heading = isCorrect ? "The expert's approach" : "What you were close to";

    return `
        <div class="card mt-4" style="border-left: 3px solid var(--ember);">
            <p class="text-xs text-secondary" style="text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: var(--space-3);">
                ${heading}
            </p>

            <h3>${r.skillName}</h3>

            <div class="mt-4">
                <p class="label">When to use it</p>
                <p class="text-sm">${r.trigger}</p>
            </div>

            <div class="mt-4">
                <p class="label">What to do</p>
                <p class="text-sm">${r.actionSequence}</p>
            </div>

            <div class="mt-4">
                <p class="label">What it produces</p>
                <p class="text-sm">${r.expectedOutcome}</p>
            </div>

            ${isPartial && r.flawPattern ? `
                <div class="mt-4" style="background: rgba(184,50,50,0.05); border-radius: var(--radius-md); padding: var(--space-3) var(--space-4);">
                    <p class="label">The gap</p>
                    <p class="text-sm" style="line-height: 1.6;">${r.flawPattern}</p>
                </div>
            ` : ''}

            <!-- LEARN-02: Save button shown on correct and partial only -->
            <button class="btn btn-secondary mt-6" id="save-recipe" style="font-size: var(--text-sm);">
                Save to my library
            </button>
        </div>
    `;
}

// ---------------------------------------------------------------------------
// XP progress bar — shared between queue screen and anywhere else XP is shown.
// ---------------------------------------------------------------------------
function _renderXPBar(xp, xpData) {
    const pct = Math.round((xpData.progress ?? 0) * 100);
    return `
        <div>
            <div class="flex-between mb-2">
                <span class="text-xs text-secondary">${(xp ?? 0).toLocaleString()} XP</span>
                ${xpData.next
                    ? `<span class="text-xs text-secondary">${xpData.xpToNext} to ${xpData.next.name}</span>`
                    : `<span class="text-xs text-secondary" style="color: var(--ember);">Oracle</span>`
                }
            </div>
            <div class="xp-bar-track">
                <div class="xp-bar-fill" style="width: ${pct}%;"></div>
            </div>
        </div>
    `;
}

// ---------------------------------------------------------------------------
// Loading state — shown while AI calls are in flight.
// ---------------------------------------------------------------------------
function renderLoading(container, message) {
    container.innerHTML = `
        <div class="empty-state">
            <div class="spinner"></div>
            <p class="text-secondary mt-4">${message}</p>
        </div>
    `;
}