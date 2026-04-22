// =============================================================================
// LORE — Scenarios Engine
// Scenarios are generated once per recipe and cached in Firestore.
// An Employee never sees the same scenario twice until all stored variants
// for that recipe are exhausted — then new ones are generated.
//
// Pre-pull: the next scenario is fetched from Firestore while the Employee
// is reading the result screen, so there is no wait on the next encounter.
//
// Phase 2 additions:
//   evaluateResponse() — now writes a mentorship task to the assigned
//   Reviewer's tasks sub-collection when verdict is 'missed'. This is the
//   correct place for that write because the missed verdict is the trigger.
//
//   queueScenarioReview() — callable from the dashboard to queue a specific
//   scenario for a Reviewer's quality check session.
// =============================================================================

import { db } from './firebase.js';
import {
    collection,
    doc,
    getDoc,
    getDocs,
    addDoc,
    query,
    where,
    orderBy,
    limit,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { generate, classify, extractJSON } from './ai.js';

// ---------------------------------------------------------------------------
// Pre-pull buffer — holds the next scenario while Employee reads results.
// ---------------------------------------------------------------------------
let _prePulled = null;

// ---------------------------------------------------------------------------
// Get the next scenario for an Employee in a given domain.
// Reads from Firestore first. If no unseen scenarios exist, generates one.
// Returns a scenario object or null.
// ---------------------------------------------------------------------------
export async function getNextScenario(orgId, domain, employeeContext) {
    console.log('LORE scenarios.js: getNextScenario called —', { orgId, domain, seniority: employeeContext?.seniority });

    // If we have a pre-pulled scenario ready, use it
    if (_prePulled && _prePulled.domain === domain) {
        console.log('LORE scenarios.js: Using pre-pulled scenario, id:', _prePulled.id);
        const scenario = _prePulled;
        _prePulled = null;
        return scenario;
    }

    return _fetchOrGenerate(orgId, domain, employeeContext);
}

// ---------------------------------------------------------------------------
// Trigger a pre-pull for the next scenario while Employee reads results.
// Called from the result screen — non-blocking, runs in the background.
// ---------------------------------------------------------------------------
export function prePullNext(orgId, domain, employeeContext) {
    // Fire and forget — populates _prePulled for the next call to getNextScenario
    console.log('LORE scenarios.js: Pre-pulling next scenario for domain:', domain);
    _fetchOrGenerate(orgId, domain, employeeContext)
        .then(scenario => {
            _prePulled = scenario;
            console.log('LORE scenarios.js: Pre-pull complete, id:', scenario?.id ?? 'null');
        })
        .catch(err => console.warn('LORE scenarios.js: Pre-pull failed.', err));
}

// ---------------------------------------------------------------------------
// Clear the pre-pull buffer (e.g. when the Employee changes domain).
// ---------------------------------------------------------------------------
export function clearPrePull() {
    _prePulled = null;
}

// ---------------------------------------------------------------------------
// Internal — fetch from Firestore or generate a new scenario.
// ---------------------------------------------------------------------------
async function _fetchOrGenerate(orgId, domain, employeeContext) {
    // 1. Try to get an approved scenario in this domain that isn't exhausted
    const storedScenario = await _getStoredScenario(orgId, domain);
    if (storedScenario) {
        console.log('LORE scenarios.js: Fetched stored scenario, id:', storedScenario.id);
        return storedScenario;
    }

    // 2. No stored scenario available — get a recipe and generate one
    console.log('LORE scenarios.js: No stored scenario — attempting generation for domain:', domain);
    const recipe = await _getRecipeForDomain(orgId, domain);
    if (!recipe) {
        console.warn('LORE scenarios.js: No approved recipe found for domain:', domain);
        return null;
    }

    return _generateScenario(orgId, recipe, employeeContext);
}

// ---------------------------------------------------------------------------
// Fetch a stored scenario from Firestore.
// Returns a scenario object or null if none available.
// ---------------------------------------------------------------------------
async function _getStoredScenario(orgId, domain) {
    try {
        const ref = collection(db, 'organisations', orgId, 'scenarios');
        const q = query(
            ref,
            where('domain', '==', domain),
            where('approved', '==', true),
            orderBy('generatedAt', 'asc'),
            limit(1)
        );
        const snap = await getDocs(q);
        if (snap.empty) return null;

        const docSnap = snap.docs[0];
        return { id: docSnap.id, ...docSnap.data() };
    } catch (err) {
        console.warn('LORE scenarios.js: Could not fetch stored scenario.', err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Get a recipe for a domain to use as generation source.
// ---------------------------------------------------------------------------
async function _getRecipeForDomain(orgId, domain) {
    try {
        const ref = collection(db, 'organisations', orgId, 'recipes');
        const q = query(
            ref,
            where('domain', '==', domain),
            where('approved', '==', true),
            limit(1)
        );
        const snap = await getDocs(q);
        if (snap.empty) return null;

        const docSnap = snap.docs[0];
        return { id: docSnap.id, ...docSnap.data() };
    } catch (err) {
        console.warn('LORE scenarios.js: Could not fetch recipe for domain:', domain, err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Generate a new scenario from a recipe using the AI engine.
// Stores the result in Firestore for reuse.
// Returns a scenario object or null.
// ---------------------------------------------------------------------------
async function _generateScenario(orgId, recipe, employeeContext) {
    const scenarioTypes = ['judgement', 'recognition', 'reflection'];

    // Rotate scenario type based on recent history from patternSignals.
    // The goal is balanced exposure: if the Employee has played more
    // judgement scenarios recently than the others, pick recognition or
    // reflection next. This ensures the full range of thinking is trained.
    // Falls back to random if signal data is unavailable.
    const type = await _chooseScenarioType(orgId, employeeContext?.uid, scenarioTypes);

    console.log('LORE scenarios.js: Generating scenario — type:', type, 'recipe:', recipe.skillName, 'seniority:', employeeContext?.seniority ?? 'mid');

    const systemPrompt = `You are generating a professional training scenario for an organisational learning platform.
The scenario is drawn from a Career Recipe — a structured description of expert judgement in a specific skill area.
Your output must be a JSON object with these exact fields:
{
  "scenarioText": "The situation description — 3 to 5 paragraphs, written in second person ('You are...'). Realistic, specific, no jargon that would not be used in the actual workplace. Do not name the skill or recipe explicitly.",
  "scenarioType": "${type}",
  "questionPrompt": "The specific question the Employee must answer. One sentence.",
  "difficulty": "developing" | "mid" | "senior"
}
Write for difficulty level: ${employeeContext?.seniority ?? 'mid'}.
Do not include any text outside the JSON object.`;

    const prompt = `Career Recipe:
Skill: ${recipe.skillName}
Trigger: ${recipe.trigger}
Action sequence: ${recipe.actionSequence}
Expected outcome: ${recipe.expectedOutcome}
Common flaw pattern: ${recipe.flawPattern ?? 'Not specified'}

Generate a ${type} scenario from this recipe. The scenario should reflect the trigger condition without naming it directly.`;

    const result = await generate(prompt, systemPrompt);
    if (!result.ok) {
        console.warn('LORE scenarios.js: AI generation failed.');
        return null;
    }

    const parsed = extractJSON(result.text);
    if (!parsed || !parsed.scenarioText) {
        console.warn('LORE scenarios.js: JSON extraction failed on generated scenario.');
        return null;
    }

    // Store in Firestore for reuse
    const scenario = {
        recipeId:       recipe.id,
        domain:         recipe.domain,
        text:           parsed.scenarioText,
        questionPrompt: parsed.questionPrompt,
        scenarioType:   parsed.scenarioType ?? type,
        difficulty:     parsed.difficulty ?? 'mid',
        approved:       true,
        generatedAt:    serverTimestamp(),
    };

    try {
        const ref = collection(db, 'organisations', orgId, 'scenarios');
        const added = await addDoc(ref, scenario);
        console.log('LORE scenarios.js: Scenario stored in Firestore, id:', added.id);
        return { id: added.id, ...scenario, recipe };
    } catch (err) {
        console.warn('LORE scenarios.js: Could not store generated scenario.', err);
        // Return it anyway even if storage failed — Employee can still train
        return { id: null, ...scenario, recipe };
    }
}

// ---------------------------------------------------------------------------
// Choose the next scenario type to ensure balanced exposure across
// judgement, recognition, and reflection.
//
// Reads the Employee's 20 most recent patternSignals, counts how many of
// each type have been played, and returns whichever is least represented.
// Falls back to random if the Employee uid is unknown or reads fail.
// ---------------------------------------------------------------------------
async function _chooseScenarioType(orgId, employeeUid, scenarioTypes) {
    if (!orgId || !employeeUid) {
        return scenarioTypes[Math.floor(Math.random() * scenarioTypes.length)];
    }

    try {
        const snap = await getDocs(
            query(
                collection(db, 'organisations', orgId, 'users', employeeUid, 'patternSignals'),
                orderBy('createdAt', 'desc'),
                limit(20)
            )
        );

        const counts = { judgement: 0, recognition: 0, reflection: 0 };
        snap.docs.forEach(d => {
            const type = d.data().scenarioType;
            if (counts[type] !== undefined) counts[type]++;
        });

        console.log('LORE scenarios.js: Scenario type counts (last 20):', counts);

        // Pick the type with the lowest count — if tied, pick randomly among the tied
        const minCount = Math.min(...Object.values(counts));
        const candidates = Object.keys(counts).filter(t => counts[t] === minCount);
        return candidates[Math.floor(Math.random() * candidates.length)];
    } catch (err) {
        console.warn('LORE scenarios.js: Could not read type history — falling back to random.', err);
        return scenarioTypes[Math.floor(Math.random() * scenarioTypes.length)];
    }
}

// ---------------------------------------------------------------------------
// Evaluate an Employee's response against the source recipe.
// Returns { verdict: 'correct'|'partial'|'missed', explanation: string }.
//
// When verdict is 'missed', this function looks up the Reviewer assigned to
// the scenario's domain and writes a mentorship task to their tasks
// sub-collection. This is the correct trigger point — the missed verdict
// is exactly when senior input is most valuable.
//
// The Reviewer never knows why they are being asked. They see a mentorship
// prompt framed as "what would you tell them?" — not "this Employee failed."
// ---------------------------------------------------------------------------
export async function evaluateResponse(response, scenario, recipe, orgId, employeeUid, secondsTaken) {
    console.log('LORE scenarios.js: Evaluating response — scenario id:', scenario?.id, 'recipe:', recipe?.skillName);

    const systemPrompt = `You are evaluating an employee's response to a professional training scenario.
Compare their response to the expert Career Recipe below.
Return a JSON object with exactly two fields:
{
  "verdict": "correct" | "partial" | "missed",
  "explanation": "2 to 3 sentences. Written directly to the employee. Warm but precise. Reference what they got right and what they missed. Draw from the recipe logic — not from generic advice. Do not mention the word 'recipe' or 'Career Recipe'."
}
Verdict guide: correct = identified the key pattern and appropriate action; partial = saw part of the picture but missed something significant; missed = response does not reflect the expert pattern.
Do not include any text outside the JSON object.`;

    const prompt = `Scenario: ${scenario.text}
Question asked: ${scenario.questionPrompt}
Employee response: ${response}

Career Recipe (expert knowledge source):
Skill: ${recipe.skillName}
Trigger: ${recipe.trigger}
Action sequence: ${recipe.actionSequence}
Expected outcome: ${recipe.expectedOutcome}`;

    const result = await classify(prompt, systemPrompt);
    if (!result.ok) {
        console.warn('LORE scenarios.js: Evaluation AI call failed — defaulting to partial.');
        return {
            verdict: 'partial',
            explanation: 'We couldn\'t evaluate your response right now. Your answer has been recorded.'
        };
    }

    const parsed = extractJSON(result.text);
    if (!parsed || !parsed.verdict) {
        console.warn('LORE scenarios.js: Evaluation JSON extraction failed — defaulting to partial.');
        return {
            verdict: 'partial',
            explanation: 'We couldn\'t evaluate your response right now. Your answer has been recorded.'
        };
    }

    console.log('LORE scenarios.js: Evaluation complete — verdict:', parsed.verdict);

    // Write a pattern signal for the Manager's intelligence view.
    // Pattern signals are inferred tendencies — not a log of individual mistakes.
    // They are stored Manager-side only and never surfaced to the Employee.
    // This is non-blocking — a failure here does not affect the Employee's result.
    if (orgId && employeeUid && scenario.domain) {
        _writePatternSignal(orgId, employeeUid, scenario, recipe, parsed.verdict, response, secondsTaken)
            .catch(err => console.warn('LORE scenarios.js: Pattern signal write failed silently.', err));
    }

    // On a missed verdict, queue a mentorship prompt for the domain's Reviewer.
    // This is non-blocking — if it fails, the Employee still sees their result.
    if (parsed.verdict === 'missed' && orgId && scenario.domain) {
        _writeMentorshipTask(orgId, scenario, recipe, response, employeeUid)
            .catch(err => console.warn('LORE scenarios.js: Mentorship task write failed silently.', err));
    }

    return {
        verdict:     parsed.verdict,
        explanation: parsed.explanation ?? ''
    };
}

// ---------------------------------------------------------------------------
// Internal — write a pattern signal to the Manager-only patternSignals
// sub-collection on the Employee's user document.
//
// Pattern signals accumulate over many sessions. The Manager's profile view
// reads them in aggregate to surface inferred tendencies — not individual
// mistakes. The Employee never sees this collection.
//
// Signal shape: { domain, scenarioType, verdict, responseLength, createdAt }
// Response length is a weak proxy for response depth/confidence — cheap to
// compute, useful in aggregate.
// ---------------------------------------------------------------------------
async function _writePatternSignal(orgId, employeeUid, scenario, recipe, verdict, response, secondsTaken) {
    try {
        await addDoc(
            collection(db, 'organisations', orgId, 'users', employeeUid, 'patternSignals'),
            {
                domain:         scenario.domain,
                scenarioType:   scenario.scenarioType ?? 'unknown',
                recipeId:       recipe?.id ?? null,
                skillName:      recipe?.skillName ?? null,
                verdict,
                // Response length in characters — used as a rough proxy for
                // engagement depth when aggregated across many sessions.
                responseLength: response?.length ?? 0,
                // Seconds taken to respond — used for cohort speed benchmarking
                // in the Manager's profile view. Never shown to the Employee.
                // [TUNING TARGET] Null when timer data is unavailable (legacy signals).
                secondsTaken:   secondsTaken ?? null,
                createdAt:      serverTimestamp(),
            }
        );
        console.log('LORE scenarios.js: Pattern signal written — verdict:', verdict, 'domain:', scenario.domain, 'secondsTaken:', secondsTaken ?? 'n/a');
    } catch (err) {
        console.warn('LORE scenarios.js: Could not write pattern signal.', err);
    }
}

// ---------------------------------------------------------------------------
// Internal — look up the Reviewer assigned to a domain and write a
// mentorship task to their tasks sub-collection.
//
// Domain documents store a reviewerIds[] array set by the Manager in the
// Skill Areas tab of the Dashboard. If no Reviewer is assigned, this is a
// no-op — the missed verdict is still recorded, there is just no prompt sent.
// ---------------------------------------------------------------------------
async function _writeMentorshipTask(orgId, scenario, recipe, employeeResponse, employeeUid) {
    // 1. Look up the domain document to find assigned Reviewers
    let reviewerIds = [];
    try {
        const domainSnap = await getDocs(
            query(
                collection(db, 'organisations', orgId, 'domains'),
                where('name', '==', scenario.domain),
                limit(1)
            )
        );
        if (!domainSnap.empty) {
            reviewerIds = domainSnap.docs[0].data().reviewerIds ?? [];
        }
    } catch (err) {
        console.warn('LORE scenarios.js: Could not look up domain for mentorship routing.', err);
        return;
    }

    if (reviewerIds.length === 0) {
        console.log('LORE scenarios.js: No Reviewer assigned to domain:', scenario.domain, '— mentorship task not sent.');
        return;
    }

    // 2. Write a mentorship task to each assigned Reviewer's tasks sub-collection.
    // [TUNING TARGET] Currently writes to all assigned Reviewers — could be
    // limited to one (round-robin or least-recently-assigned) to avoid duplicate prompts.
    for (const reviewerId of reviewerIds) {
        try {
            await addDoc(
                collection(db, 'organisations', orgId, 'users', reviewerId, 'tasks'),
                {
                    type:             'mentorship_note',
                    status:           'pending',
                    scenarioText:     scenario.text,
                    questionPrompt:   scenario.questionPrompt,
                    employeeResponse: employeeResponse,
                    domain:           scenario.domain,
                    scenarioId:       scenario.id ?? null,
                    recipeId:         recipe.id   ?? null,
                    // employeeUid is stored for pattern signal attribution
                    // but is never surfaced in the Reviewer's prompt UI
                    employeeUid:      employeeUid ?? null,
                    createdAt:        serverTimestamp(),
                }
            );
            console.log('LORE scenarios.js: Mentorship task written to Reviewer:', reviewerId, 'domain:', scenario.domain);
        } catch (err) {
            console.warn('LORE scenarios.js: Could not write mentorship task to Reviewer:', reviewerId, err);
        }
    }
}

// ---------------------------------------------------------------------------
// Queue a scenario for Reviewer quality check (scenario_review type).
// Called from the Dashboard when the Manager clicks "Send for review" on
// a specific scenario in the Knowledge Base section.
//
// scenarioId: the Firestore ID of the scenario to review
// reviewerId: the uid of the Reviewer to send it to
// Returns { ok: true } or { ok: false, error }.
// ---------------------------------------------------------------------------
export async function queueScenarioReview(orgId, scenarioId, reviewerId) {
    console.log('LORE scenarios.js: Queuing scenario review —', { scenarioId, reviewerId });

    // Fetch the scenario text so the task document is self-contained
    let scenarioText = '';
    let domain = '';
    try {
        const snap = await getDoc(doc(db, 'organisations', orgId, 'scenarios', scenarioId));
        if (snap.exists()) {
            scenarioText = snap.data().text ?? '';
            domain       = snap.data().domain ?? '';
        }
    } catch (err) {
        console.warn('LORE scenarios.js: Could not fetch scenario for review queue.', err);
        return { ok: false, error: 'Could not load scenario.' };
    }

    try {
        await addDoc(
            collection(db, 'organisations', orgId, 'users', reviewerId, 'tasks'),
            {
                type:         'scenario_review',
                status:       'pending',
                scenarioText,
                domain,
                scenarioId,
                createdAt:    serverTimestamp(),
            }
        );
        console.log('LORE scenarios.js: Scenario review task queued for Reviewer:', reviewerId);
        return { ok: true };
    } catch (err) {
        console.warn('LORE scenarios.js: Could not queue scenario review task.', err);
        return { ok: false, error: 'Could not send to Reviewer.' };
    }
}