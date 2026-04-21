// =============================================================================
// LORE — Recipes Engine
// Reads Career Recipes from Firestore for display (after unlock) and for
// use in scenario generation and evaluation.
//
// Write operations here cover Phase 2:
//   createExtraction()   — stages raw Reviewer contributions for processing
//   processExtraction()  — AI parses a raw contribution into a recipe draft
//   approveRecipe()      — Manager marks a draft as approved, enters knowledge base
//   rejectExtraction()   — Manager dismisses a pending extraction
//   processDocument()    — AI extracts recipe drafts from an uploaded document text
//
// Read operations are used in Training and Dashboard views.
//
// Import paths: engine/ files import firebase.js using ./firebase.js (repo root).
// =============================================================================

import { db } from './firebase.js';
import {
    doc,
    getDoc,
    collection,
    getDocs,
    addDoc,
    updateDoc,
    query,
    where,
    orderBy,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { classify, generate, extractJSON } from './ai.js';

// ---------------------------------------------------------------------------
// Get a single recipe by ID.
// Returns the recipe object or null.
// ---------------------------------------------------------------------------
export async function getRecipe(orgId, recipeId) {
    try {
        const snap = await getDoc(doc(db, 'organisations', orgId, 'recipes', recipeId));
        if (!snap.exists()) return null;
        return { id: snap.id, ...snap.data() };
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Get all approved recipes for a domain.
// Used to check if a domain has enough recipes for calibration (needs >= 5).
// Returns an array.
// ---------------------------------------------------------------------------
export async function getRecipesForDomain(orgId, domain) {
    try {
        const ref = collection(db, 'organisations', orgId, 'recipes');
        const q = query(
            ref,
            where('domain', '==', domain),
            where('approved', '==', true)
        );
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Get all approved recipes for an org — used by domain clustering and the
// Manager dashboard knowledge base overview.
// Returns an array of recipe objects.
// ---------------------------------------------------------------------------
export async function getAllApprovedRecipes(orgId) {
    try {
        const ref = collection(db, 'organisations', orgId, 'recipes');
        const q = query(ref, where('approved', '==', true));
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Get all approved domains (skill areas) for an org.
// Used by the Training view to render the domain selection screen.
// Returns an array of domain objects: { id, name, recipeCount }.
// ---------------------------------------------------------------------------
export async function getDomains(orgId) {
    try {
        const ref = collection(db, 'organisations', orgId, 'domains');
        const snap = await getDocs(ref);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Save a recipe to the Employee's personal recipe library (after unlock).
// Idempotent — saving the same recipe twice is harmless.
// ---------------------------------------------------------------------------
export async function saveToLibrary(orgId, uid, recipe) {
    try {
        const ref = collection(
            db, 'organisations', orgId, 'users', uid, 'recipeLibrary'
        );
        await addDoc(ref, {
            recipeId:  recipe.id,
            skillName: recipe.skillName,
            domain:    recipe.domain,
            savedAt:   serverTimestamp(),
        });
        return true;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Get all pending extractions awaiting Manager review.
// These are raw contributions from Reviewers or document processing jobs,
// before they have been shaped into approved recipes.
// Returns an array of extraction objects, newest first.
// ---------------------------------------------------------------------------
export async function getPendingExtractions(orgId) {
    try {
        const ref = collection(db, 'organisations', orgId, 'extractions');
        const q = query(
            ref,
            where('status', '==', 'pending'),
            orderBy('createdAt', 'desc')
        );
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Create a raw extraction — stages a Reviewer's contribution for processing.
// This is called when a Reviewer submits a scenario review or mentorship note.
//
// extraction: {
//   sourceType: 'scenario_review' | 'mentorship_note' | 'document',
//   rawContent: string,   — the Reviewer's actual words
//   reviewerId: string,   — uid of the Reviewer (for pattern signals)
//   contextNote: string,  — optional: what scenario prompted this, or document name
// }
// Returns the extraction ID or null.
// ---------------------------------------------------------------------------
export async function createExtraction(orgId, extraction) {
    try {
        const ref = collection(db, 'organisations', orgId, 'extractions');
        const added = await addDoc(ref, {
            sourceType:  extraction.sourceType,
            rawContent:  extraction.rawContent,
            reviewerId:  extraction.reviewerId  ?? null,
            contextNote: extraction.contextNote ?? '',
            status:      'pending',       // pending → processed → approved / rejected
            createdAt:   serverTimestamp(),
        });
        return added.id;
    } catch (err) {
        console.warn('LORE Recipes: Could not create extraction.', err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Process a pending extraction using AI — parse the raw Reviewer contribution
// into a structured recipe draft. Called when the Manager opens the queue.
//
// The processing runs in the background. The Manager sees the draft as soon
// as it is ready. If processing fails, the extraction stays pending.
//
// Returns { ok: true, draft } or { ok: false, reason }.
// ---------------------------------------------------------------------------
export async function processExtraction(orgId, extractionId, extraction) {
    const systemPrompt = `You are extracting professional decision knowledge from a practitioner's response.
The practitioner has reviewed a training scenario or provided mentorship feedback.
Your job is to identify whether their response contains expert decision logic — a specific pattern of judgement that a less experienced person would not automatically apply.
If it does, extract it into a structured recipe draft.
Return a JSON object with these exact fields:
{
  "hasRecipe": true | false,
  "skillName": "Short name for the skill being described — 3 to 6 words",
  "trigger": "What situation causes a skilled person to apply this — one sentence, specific and observable",
  "actionSequence": "What the skilled person does when they spot the trigger — 2 to 4 steps, concrete and sequential",
  "expectedOutcome": "What a successful application produces — one sentence",
  "flawPattern": "What a less skilled person typically does instead — one sentence, or null if not evident",
  "confidence": "high" | "medium" | "low"
}
If hasRecipe is false, all other fields can be null.
Return the JSON object only — no other text.`;

    const prompt = `Source type: ${extraction.sourceType}
Context: ${extraction.contextNote ?? 'No additional context'}
Practitioner's contribution:
${extraction.rawContent}

Extract any expert decision logic present. Return the JSON object.`;

    const result = await classify(prompt, systemPrompt);
    if (!result.ok) {
        return { ok: false, reason: 'AI_UNAVAILABLE' };
    }

    const draft = extractJSON(result.text);
    if (!draft) {
        return { ok: false, reason: 'PARSE_FAILED' };
    }

    // Update the extraction document with the processed draft
    try {
        await updateDoc(doc(db, 'organisations', orgId, 'extractions', extractionId), {
            status:      'processed',
            draft,
            processedAt: serverTimestamp(),
        });
    } catch (err) {
        console.warn('LORE Recipes: Could not update extraction with draft.', err);
    }

    return { ok: true, draft };
}

// ---------------------------------------------------------------------------
// Approve a recipe draft — moves it from the extraction queue into the
// live knowledge base. The Manager may have edited the draft before approving.
//
// draft: the recipe fields (skillName, trigger, actionSequence, etc.)
// extractionId: the source extraction to mark as approved
// domain: the skill area to assign this recipe to
// Returns the new recipe ID or null.
// ---------------------------------------------------------------------------
export async function approveRecipe(orgId, draft, extractionId, domain) {
    try {
        // Write to the recipes collection — this is now live knowledge
        const recipesRef = collection(db, 'organisations', orgId, 'recipes');
        const added = await addDoc(recipesRef, {
            skillName:      draft.skillName,
            trigger:        draft.trigger,
            actionSequence: draft.actionSequence,
            expectedOutcome: draft.expectedOutcome,
            flawPattern:    draft.flawPattern    ?? null,
            domain:         domain,
            sourceType:     draft.sourceType     ?? 'extraction',
            approved:       true,
            approvedAt:     serverTimestamp(),
            extractionId:   extractionId          ?? null,
        });

        // Mark the source extraction as approved
        if (extractionId) {
            await updateDoc(doc(db, 'organisations', orgId, 'extractions', extractionId), {
                status:     'approved',
                recipeId:   added.id,
                approvedAt: serverTimestamp(),
            });
        }

        return added.id;
    } catch (err) {
        console.warn('LORE Recipes: Could not approve recipe.', err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Reject an extraction — the Manager has reviewed it and decided it does not
// contain useful recipe content. Marks it dismissed in Firestore.
// Returns true on success.
// ---------------------------------------------------------------------------
export async function rejectExtraction(orgId, extractionId) {
    try {
        await updateDoc(doc(db, 'organisations', orgId, 'extractions', extractionId), {
            status:     'rejected',
            rejectedAt: serverTimestamp(),
        });
        return true;
    } catch (err) {
        console.warn('LORE Recipes: Could not reject extraction.', err);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Process a document the Manager has uploaded — extract recipe drafts from
// the document text. A document may contain multiple distinct decision patterns.
//
// This is AI-assisted extraction from organisational materials: retrospectives,
// post-mortems, project archives, playbooks, performance reviews, etc.
// The Manager uploads the text; this function finds the knowledge inside it.
//
// documentText: the plain text content of the uploaded document
// documentName: friendly name for provenance tracking (e.g. "Q3 Retrospective")
// Returns { ok: true, extractions[] } or { ok: false, reason }.
// Each extraction in the array is a draft recipe with confidence and context.
// ---------------------------------------------------------------------------
export async function processDocument(orgId, documentText, documentName) {
    const systemPrompt = `You are reading an organisational document — a retrospective, post-mortem, playbook, or similar internal material.
Your job is to identify expert decision logic embedded in this document — specific patterns of professional judgement that a less experienced person would not automatically apply.
Each pattern you find should be extractable as a distinct skill.
Return a JSON array of recipe drafts. Each draft must have exactly these fields:
{
  "skillName": "Short name for the skill — 3 to 6 words",
  "trigger": "The situation that calls for this skill — one sentence, specific and observable",
  "actionSequence": "What a skilled person does — 2 to 4 steps, concrete and sequential",
  "expectedOutcome": "What successful application produces — one sentence",
  "flawPattern": "What less experienced people typically do instead — one sentence, or null if not evident",
  "confidence": "high" | "medium" | "low",
  "contextQuote": "The sentence or phrase from the document that most clearly evidences this pattern"
}
Return only patterns that reflect genuine expert judgement — not general advice, not process descriptions, not outcomes. The trigger condition must be specific enough that someone could recognise it happening.
Return the JSON array only. If you find no qualifying patterns, return an empty array.`;

    const prompt = `Document name: ${documentName}

Document content:
${documentText.slice(0, 6000)}

Extract professional decision knowledge from this document. Return the JSON array.`;

    // Document processing uses generate() — larger output, higher token ceiling
    const result = await generate(prompt, systemPrompt);
    if (!result.ok) {
        return { ok: false, reason: 'AI_UNAVAILABLE' };
    }

    const drafts = extractJSON(result.text);
    if (!drafts || !Array.isArray(drafts)) {
        return { ok: false, reason: 'PARSE_FAILED' };
    }

    if (drafts.length === 0) {
        return { ok: true, extractions: [] };
    }

    // Stage each draft as a pending extraction for Manager review
    const staged = [];
    for (const draft of drafts) {
        try {
            const ref = collection(db, 'organisations', orgId, 'extractions');
            const added = await addDoc(ref, {
                sourceType:  'document',
                rawContent:  draft.contextQuote ?? '',
                contextNote: documentName,
                draft,
                status:      'processed',   // Already AI-processed — goes straight to review
                createdAt:   serverTimestamp(),
                processedAt: serverTimestamp(),
            });
            staged.push({ id: added.id, ...draft });
        } catch (err) {
            console.warn('LORE Recipes: Could not stage document extraction.', err);
        }
    }

    return { ok: true, extractions: staged };
}