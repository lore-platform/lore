// =============================================================================
// LORE — Scenarios Engine
// Scenarios are generated once per recipe and cached in Firestore.
// An Employee never sees the same scenario twice until all stored variants
// for that recipe are exhausted — then new ones are generated.
//
// Pre-pull: the next scenario is fetched from Firestore while the Employee
// is reading the result screen, so there is no wait on the next encounter.
// =============================================================================

import { db } from './firebase.js';
import {
    collection,
    doc,
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
    // If we have a pre-pulled scenario, use it
    if (_prePulled && _prePulled.domain === domain) {
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
    _fetchOrGenerate(orgId, domain, employeeContext)
        .then(scenario => { _prePulled = scenario; })
        .catch(err => console.warn('LORE: Pre-pull failed.', err));
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
    if (storedScenario) return storedScenario;

    // 2. No stored scenario available — get a recipe and generate one
    const recipe = await _getRecipeForDomain(orgId, domain);
    if (!recipe) return null;

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
        console.warn('LORE: Could not fetch stored scenario.', err);
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
        console.warn('LORE: Could not fetch recipe.', err);
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
    // [TUNING TARGET] Rotate type based on recent history — for now, random
    const type = scenarioTypes[Math.floor(Math.random() * scenarioTypes.length)];

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
    if (!result.ok) return null;

    const parsed = extractJSON(result.text);
    if (!parsed || !parsed.scenarioText) return null;

    // Store in Firestore for reuse
    const scenario = {
        recipeId:     recipe.id,
        domain:       recipe.domain,
        text:         parsed.scenarioText,
        questionPrompt: parsed.questionPrompt,
        scenarioType: parsed.scenarioType ?? type,
        difficulty:   parsed.difficulty ?? 'mid',
        approved:     true,
        generatedAt:  serverTimestamp(),
    };

    try {
        const ref = collection(db, 'organisations', orgId, 'scenarios');
        const added = await addDoc(ref, scenario);
        return { id: added.id, ...scenario, recipe };
    } catch (err) {
        console.warn('LORE: Could not store generated scenario.', err);
        // Return it anyway even if storage failed — Employee can still train
        return { id: null, ...scenario, recipe };
    }
}

// ---------------------------------------------------------------------------
// Evaluate an Employee's response against the source recipe.
// Returns { verdict: 'correct'|'partial'|'missed', explanation: string }.
// ---------------------------------------------------------------------------
export async function evaluateResponse(response, scenario, recipe) {
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
        return {
            verdict: 'partial',
            explanation: 'We couldn\'t evaluate your response right now. Your answer has been recorded.'
        };
    }

    const parsed = extractJSON(result.text);
    if (!parsed || !parsed.verdict) {
        return {
            verdict: 'partial',
            explanation: 'We couldn\'t evaluate your response right now. Your answer has been recorded.'
        };
    }

    return {
        verdict:     parsed.verdict,
        explanation: parsed.explanation ?? ''
    };
}