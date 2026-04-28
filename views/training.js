// =============================================================================
// LORE — Training View
// The Employee's primary experience. Covers the full core loop:
//   SELECT SKILL AREA → ENCOUNTER → RESPOND → RESULT → RECIPE UNLOCK → CONTINUE
//
// Calibration: first-time employees see a calibration set framed as
// "help us understand where you are starting from" — not as a test.
//
// Scenario types: Judgement, Recognition, Reflection.
// Each scenario is AI-generated from a Career Recipe and cached in Firestore.
// Responses are AI-evaluated against the source recipe.
// =============================================================================

import { getDomains, getRecipe, saveToLibrary } from '../engine/recipes.js';
import {
    getNextScenario,
    prePullNext,
    clearPrePull,
    evaluateResponse
} from '../engine/scenarios.js';
import { recordResponse, getXPProgress, getRankForXP } from '../engine/state.js';

// ---------------------------------------------------------------------------
// Module-level state for this view.
// ---------------------------------------------------------------------------
let _orgId   = null;
let _uid     = null;
let _state   = null;
let _domains = [];

// Current session state
let _activeDomain   = null;
let _activeScenario = null;
let _activeRecipe   = null;
let _timerInterval  = null;
let _secondsLeft    = 0;

// [TUNING TARGET] Response timer — 4 minutes per scenario
const RESPONSE_TIME_SECONDS = 240;

// ---------------------------------------------------------------------------
// Entry point — called by app.js after auth.
// ---------------------------------------------------------------------------
export async function initTraining(orgId, uid, state) {
    _orgId = orgId;
    _uid   = uid;
    _state = state;

    const container = document.getElementById('training-content');
    if (!container) return;

    // Load available skill areas
    _domains = await getDomains(orgId);

    if (_domains.length === 0) {
        renderEmptyKnowledgeBase(container);
        return;
    }

    // Check if this is a first-time Employee who needs calibration
    // Calibration is needed when sessionsTotal === 0
    if (state.sessionsTotal === 0) {
        renderCalibrationIntro(container);
        return;
    }

    renderDomainSelect(container);
}

// ---------------------------------------------------------------------------
// SCREEN: Empty knowledge base
// Shown when the org has no skill areas yet.
// ---------------------------------------------------------------------------
function renderEmptyKnowledgeBase(container) {
    container.innerHTML = `
        <div class="empty-state">
            <h3>Nothing to train on yet</h3>
            <p class="mt-2">Your organisation is still building its knowledge base. Check back soon — your manager will let you know when training is ready.</p>
        </div>
    `;
}

// ---------------------------------------------------------------------------
// SCREEN: Calibration intro
// Framed as helping LORE understand the Employee's starting point.
// Not framed as a test.
// ---------------------------------------------------------------------------
function renderCalibrationIntro(container) {
    container.innerHTML = `
        <div style="max-width: 520px;">
            <p class="text-xs text-secondary" style="text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: var(--space-3);">Welcome to LORE</p>
            <h1 style="line-height: 1.2; margin-bottom: var(--space-4);">Training built around how your team actually works</h1>
            <p class="text-secondary" style="line-height: 1.7; margin-bottom: var(--space-6);">
                LORE trains you through real situations from your field — the kinds of calls your most experienced colleagues make without thinking twice. You respond the way you’d actually handle it, and LORE tells you what a more experienced read of that situation looks like.
            </p>

            <div class="card" style="margin-bottom: var(--space-4);">
                <p style="font-weight: 500; margin-bottom: var(--space-3);">What to expect</p>
                <div style="display: flex; flex-direction: column; gap: var(--space-3);">
                    <div style="display: flex; gap: var(--space-3); align-items: flex-start;">
                        <span style="color: var(--ember); font-weight: 600; flex-shrink: 0; margin-top: 1px;">1</span>
                        <p class="text-secondary text-sm" style="line-height: 1.6;">Pick a skill area to work on. Each one covers a specific part of your role.</p>
                    </div>
                    <div style="display: flex; gap: var(--space-3); align-items: flex-start;">
                        <span style="color: var(--ember); font-weight: 600; flex-shrink: 0; margin-top: 1px;">2</span>
                        <p class="text-secondary text-sm" style="line-height: 1.6;">Read a workplace situation and write how you’d respond. There are no trick questions — just respond honestly.</p>
                    </div>
                    <div style="display: flex; gap: var(--space-3); align-items: flex-start;">
                        <span style="color: var(--ember); font-weight: 600; flex-shrink: 0; margin-top: 1px;">3</span>
                        <p class="text-secondary text-sm" style="line-height: 1.6;">Get immediate feedback on what you got right, what you missed, and what a senior person would have done differently.</p>
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
        renderDomainSelect(container);
    });
}

// ---------------------------------------------------------------------------
// SCREEN: Domain (skill area) selection
// ---------------------------------------------------------------------------
function renderDomainSelect(container) {
    clearTimer();
    clearPrePull();

    const state  = _state;
    const xpData = getXPProgress(state.xp);

    container.innerHTML = `
        <div>
            <div class="flex-between mb-6">
                <div>
                    <h1>Training</h1>
                    <p class="text-secondary text-sm mt-2" style="max-width: 340px; line-height: 1.6;">Choose a skill area below to start a session. Each one is a different part of your role — pick whichever feels most relevant to what you’re working on right now.</p>
                </div>
                <div style="text-align: right;">
                    <p class="text-xs text-secondary">Your rank</p>
                    <p style="font-weight: 600; color: var(--ember); margin-top: 2px;">
                        ${xpData.current.name}
                    </p>
                </div>
            </div>

            ${renderXPBar(state.xp, xpData)}

            <div class="mt-8" id="domain-list">
                ${_domains.map(domain => renderDomainCard(domain, state)).join('')}
            </div>
        </div>
    `;

    // Attach click handlers for each domain
    _domains.forEach(domain => {
        document.getElementById(`domain-${domain.id}`)?.addEventListener('click', () => {
            startSession(domain, container);
        });
    });
}

function renderXPBar(xp, xpData) {
    const pct = Math.round(xpData.progress * 100);
    return `
        <div>
            <div class="flex-between mb-2">
                <span class="text-xs text-secondary">${xp.toLocaleString()} XP</span>
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

function renderDomainCard(domain, state) {
    const mastery = state.domainMastery?.[domain.name] ?? { played: 0, correct: 0 };
    const accuracy = mastery.played > 0
        ? Math.round((mastery.correct / mastery.played) * 100)
        : null;

    return `
        <div class="card" id="domain-${domain.id}" style="cursor: pointer; margin-bottom: var(--space-4);">
            <div class="flex-between">
                <div>
                    <h3>${domain.name}</h3>
                    <p class="text-secondary text-sm mt-2">
                        ${domain.description ?? ''}
                    </p>
                </div>
                <div style="text-align: right; flex-shrink: 0; margin-left: var(--space-4);">
                    ${accuracy !== null
                        ? `<p style="font-size: var(--text-xl); font-weight: 600; color: var(--ink);">${accuracy}%</p>
                           <p class="text-xs text-secondary">accuracy</p>`
                        : `<p class="text-xs text-secondary">Not started</p>`
                    }
                </div>
            </div>
        </div>
    `;
}

// ---------------------------------------------------------------------------
// Start a training session in a selected domain.
// ---------------------------------------------------------------------------
async function startSession(domain, container) {
    _activeDomain = domain;
    renderLoading(container, 'Getting your next scenario…');

    const scenario = await getNextScenario(
        _orgId,
        domain.name,
        // uid is passed so scenarios.js can read recent type history
        // to ensure balanced exposure across judgement/recognition/reflection.
        { seniority: _state?.seniority ?? 'mid', uid: _uid }
    );

    if (!scenario) {
        container.innerHTML = `
            <div class="empty-state">
                <h3>Nothing available right now</h3>
                <p class="mt-2">This skill area doesn't have training scenarios ready yet. Try another area or check back later.</p>
                <button class="btn btn-secondary mt-6" id="back-to-domains">Back to skill areas</button>
            </div>
        `;
        document.getElementById('back-to-domains')?.addEventListener('click', () => {
            renderDomainSelect(container);
        });
        return;
    }

    _activeScenario = scenario;

    // Fetch the source recipe for evaluation and unlock
    if (scenario.recipeId) {
        _activeRecipe = await getRecipe(_orgId, scenario.recipeId);
    } else if (scenario.recipe) {
        _activeRecipe = scenario.recipe;
    }

    renderEncounter(container, scenario);
}

// ---------------------------------------------------------------------------
// SCREEN: Encounter — the scenario and response input.
// ---------------------------------------------------------------------------
function renderEncounter(container, scenario) {
    const typeLabel = {
        judgement:  'Judgement',
        recognition: 'Recognition',
        reflection:  'Reflection',
    }[scenario.scenarioType] ?? 'Scenario';

    container.innerHTML = `
        <div>
            <div class="flex-between mb-4">
                <span class="scenario-type">${typeLabel} · ${_activeDomain?.name ?? ''}</span>
                <div class="timer" id="encounter-timer">
                    <span id="timer-display">${formatTime(RESPONSE_TIME_SECONDS)}</span>
                </div>
            </div>

            <div class="card">
                <p style="white-space: pre-wrap; line-height: 1.8;">${scenario.text}</p>
            </div>

            <div class="card mt-4">
                <label class="label" for="response-input">${scenario.questionPrompt ?? 'What do you notice, and what would you do?'}</label>
                <textarea
                    class="input"
                    id="response-input"
                    rows="6"
                    placeholder="Write your response here. Be specific — what are you noticing, and what would you actually do?"
                ></textarea>
            </div>

            <div class="flex-between mt-4">
                <button class="btn btn-secondary" id="back-from-encounter">Back</button>
                <button class="btn btn-primary" id="submit-response">Submit response</button>
            </div>
        </div>
    `;

    startTimer(container);

    document.getElementById('back-from-encounter')?.addEventListener('click', () => {
        clearTimer();
        renderDomainSelect(container);
    });

    document.getElementById('submit-response')?.addEventListener('click', () => {
        const response = document.getElementById('response-input')?.value?.trim();
        if (!response) {
            document.getElementById('response-input')?.focus();
            return;
        }
        clearTimer();
        handleSubmit(container, response, scenario);
    });
}

// ---------------------------------------------------------------------------
// Handle response submission — evaluate and show result.
// ---------------------------------------------------------------------------
async function handleSubmit(container, response, scenario) {
    renderLoading(container, 'Reading your response…');

    // Capture seconds taken — RESPONSE_TIME_SECONDS minus what was left on the clock.
    // Used as a proxy for response speed under time pressure, stored in patternSignals
    // for the Manager's cohort comparison view. Not shown to the Employee.
    const secondsTaken = RESPONSE_TIME_SECONDS - _secondsLeft;

    // orgId and _uid are passed so evaluateResponse can write a mentorship
    // task to the domain's Reviewer when the verdict is 'missed'.
    const evaluation = await evaluateResponse(response, scenario, _activeRecipe, _orgId, _uid, secondsTaken);

    // Record XP and streak
    const xpResult = await recordResponse(evaluation.verdict, _activeDomain?.name ?? 'general');

    // Update local state reference
    const newState = { ..._state, xp: xpResult.newTotal };
    _state = newState;

    // Refresh nav bar directly — avoids circular import with app.js
    const xpEl   = document.getElementById('nav-xp-value');
    const strEl  = document.getElementById('nav-streak-value');
    const rankEl = document.getElementById('nav-rank');
    if (xpEl)   xpEl.textContent   = _state.xp.toLocaleString();
    if (strEl)  strEl.textContent  = _state.streak;
    if (rankEl) rankEl.textContent = getRankForXP(_state.xp).name;

    // Pre-pull the next scenario while Employee reads the result
    prePullNext(_orgId, _activeDomain?.name, { seniority: _state?.seniority ?? 'mid', uid: _uid });

    renderResult(container, evaluation, xpResult);
}

// ---------------------------------------------------------------------------
// SCREEN: Result — verdict, explanation, XP gained.
// ---------------------------------------------------------------------------
function renderResult(container, evaluation, xpResult) {
    const isCorrect = evaluation.verdict === 'correct';
    const isPartial = evaluation.verdict === 'partial';

    const verdictLabel = isCorrect ? 'Correct' : isPartial ? 'Partial' : 'Missed';
    const chipClass    = isCorrect ? 'chip-correct' : isPartial ? 'chip-pending' : 'chip-missed';

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

            ${isCorrect && _activeRecipe ? renderRecipeUnlock() : ''}

            <div class="flex-between mt-6">
                <button class="btn btn-secondary" id="back-to-areas">Change skill area</button>
                <button class="btn btn-primary" id="next-scenario">Next scenario</button>
            </div>
        </div>
    `;

    // Recipe unlock save button
    if (isCorrect && _activeRecipe) {
        document.getElementById('save-recipe')?.addEventListener('click', async (e) => {
            e.target.disabled = true;
            e.target.textContent = 'Saved';
            await saveToLibrary(_orgId, _uid, _activeRecipe);
        });
    }

    document.getElementById('back-to-areas')?.addEventListener('click', () => {
        clearPrePull();
        renderDomainSelect(container);
    });

    document.getElementById('next-scenario')?.addEventListener('click', () => {
        startSession(_activeDomain, container);
    });
}

// ---------------------------------------------------------------------------
// Recipe unlock panel — shown on correct verdict.
// The pattern was activated first. The recipe arrives as confirmation.
// ---------------------------------------------------------------------------
function renderRecipeUnlock() {
    const r = _activeRecipe;
    if (!r) return '';

    return `
        <div class="card mt-4" style="border-left: 3px solid var(--ember);">
            <p class="text-xs text-secondary" style="text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: var(--space-3);">
                The expert's approach
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

            <button class="btn btn-secondary mt-6" id="save-recipe" style="font-size: var(--text-sm);">
                Save to my library
            </button>
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

// ---------------------------------------------------------------------------
// Timer — runs during the response phase.
// [TUNING TARGET] Warning at 60s, urgent at 30s.
// ---------------------------------------------------------------------------
function startTimer(container) {
    _secondsLeft = RESPONSE_TIME_SECONDS;
    const display = document.getElementById('timer-display');
    const timerEl = document.getElementById('encounter-timer');

    _timerInterval = setInterval(() => {
        _secondsLeft--;
        if (display) display.textContent = formatTime(_secondsLeft);

        // Visual state changes
        if (timerEl) {
            timerEl.classList.toggle('warning', _secondsLeft <= 60 && _secondsLeft > 30);
            timerEl.classList.toggle('urgent',  _secondsLeft <= 30);
        }

        // Time's up — auto-submit whatever is in the box
        if (_secondsLeft <= 0) {
            clearTimer();
            const response = document.getElementById('response-input')?.value?.trim()
                ?? 'No response submitted within the time limit.';
            handleSubmit(container, response, _activeScenario);
        }
    }, 1000);
}

function clearTimer() {
    if (_timerInterval) {
        clearInterval(_timerInterval);
        _timerInterval = null;
    }
}

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}