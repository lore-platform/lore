// =============================================================================
// LORE — Recipes Engine
// Reads Career Recipes from Firestore for display (after unlock) and for
// use in scenario generation and evaluation.
//
// Write operations:
//   createExtraction()   — stages raw content for processing, with deduplication
//   processExtraction()  — three-stage AI pipeline: classify → extract → derive
//   approveRecipe()      — Manager marks a draft as approved, enters knowledge base
//   rejectExtraction()   — Manager dismisses a pending extraction
//   processDocument()    — writes parent doc record, chunks, processes each chunk
//   deriveFromCorpus()   — CORP-03: derives extractions from flagged response corpus
//
// Read operations: getRecipe, getRecipesForDomain, getAllApprovedRecipes,
//   getDomains, saveToLibrary, getPendingExtractions.
//   All read functions are unchanged from their previous form.
//
// Auto-approval logic has been permanently removed. The Manager approves
// every extraction. Nothing bypasses the Manager's gate.
//
// Import paths: engine/ files import firebase.js from the repo root using ../firebase.js.
// =============================================================================

import { db } from '../firebase.js';
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
    limit,
    serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { classify, generate, extractJSON } from './ai.js';
import {
    cleanText,
    detectLanguage,
    hashContent,
    countWords,
    chunkDocument,
    shouldChunk,
    deduplicateCheck,
} from './ingest.js';


// =============================================================================
// READ FUNCTIONS
// These are unchanged — they do not touch the pipeline logic above.
// =============================================================================

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
// Get all confirmed domains (skill areas) for an org.
// Used by the Training view and Manager dashboard.
// Returns an array of domain objects: { id, name, recipeIds[] }.
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
// Returns only 'pending' and 'processed' status documents — newest first.
// Auto-approval logic has been removed. Manager approves everything.
// ---------------------------------------------------------------------------
export async function getPendingExtractions(orgId) {
    try {
        const ref = collection(db, 'organisations', orgId, 'extractions');
        const q = query(
            ref,
            where('status', 'in', ['pending', 'processed']),
            orderBy('createdAt', 'desc')
        );
        const snap = await getDocs(q);
        const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        console.log('LORE recipes.js: getPendingExtractions — found', docs.length, 'items for review.');
        return docs;
    } catch (err) {
        console.warn('LORE recipes.js: Could not fetch pending extractions.', err);
        return [];
    }
}


// =============================================================================
// PIPELINE WRITE FUNCTIONS
// =============================================================================

// ---------------------------------------------------------------------------
// Create a raw extraction — stages content for the three-stage AI pipeline.
//
// Called by:
//   tasks.js         — when a Reviewer submits a scenario review or mentorship note
//   processDocument() — for each chunk of an uploaded document
//   deriveFromCorpus() — for grouped flagged response corpus entries
//
// extraction: {
//   sourceType:  'scenario_review' | 'mentorship_note' | 'document_chunk'
//                | 'scenario_review' | 'employee_response'
//   rawContent:  string — the contributor's actual words. Written once, never overwritten.
//   rawPrompt:   string — the exact prompt shown to the contributor, or for
//                employee_response: the scenario text they responded to.
//   reviewerId:  string (optional) — uid of the contributing Reviewer
//   uploadedBy:  string (optional) — uid of the Manager who uploaded a document
// }
//
// Before writing, this function:
//   1. Cleans the raw content (strips HTML, normalises whitespace).
//   2. Computes the SHA-256 content hash for deduplication.
//   3. Checks for an existing extraction with the same hash for this org.
//      If one exists, logs a warning and returns the existing ID — no new write.
//   4. Computes word count and detects language.
//   5. Writes the extraction document with all PIPE-01 schema fields.
//
// Returns the extraction ID (new or existing) or null on failure.
// ---------------------------------------------------------------------------
export async function createExtraction(orgId, extraction) {
    console.log('LORE recipes.js: createExtraction — sourceType:', extraction.sourceType, 'reviewerId:', extraction.reviewerId ?? 'none');

    const rawContent = extraction.rawContent ?? '';
    const rawPrompt  = extraction.rawPrompt  ?? '';

    // Step 1: Clean the content for hashing and metadata computation.
    // The raw content itself is stored verbatim — cleanText() output is only
    // used for hashing and word/language analysis, not to overwrite rawContent.
    const cleanedContent = cleanText(rawContent);

    // Step 2: Compute SHA-256 hash of the cleaned content for deduplication.
    // We hash the cleaned content rather than raw to avoid hash mismatches
    // caused by inconsequential whitespace or encoding differences.
    const contentHash = await hashContent(cleanedContent);

    // Step 3: Deduplication check — has this content been submitted before?
    if (contentHash) {
        const existingId = await deduplicateCheck(orgId, contentHash);
        if (existingId) {
            console.warn('LORE recipes.js: Duplicate content detected — returning existing extraction id:', existingId);
            return existingId;
        }
    }

    // Step 4: Compute word count and detect language.
    const wordCount = countWords(cleanedContent);
    const language  = detectLanguage(cleanedContent);

    // Step 5: Write the extraction document.
    // rawContent is permanent — it is written once here and never overwritten.
    // rawPrompt is the question or scenario that produced this response.
    try {
        const ref = collection(db, 'organisations', orgId, 'extractions');
        const added = await addDoc(ref, {
            orgId,
            sourceType:  extraction.sourceType,
            sourceRef:   extraction.sourceRef  ?? null,  // e.g. document ID for chunks
            reviewerId:  extraction.reviewerId ?? null,
            uploadedBy:  extraction.uploadedBy ?? null,
            createdAt:   serverTimestamp(),

            // Permanent raw record — never overwritten
            rawContent,
            rawPrompt,

            // Computed by ingest.js
            wordCount,
            language,
            contentHash: contentHash ?? null,

            // Pipeline state
            status:      'pending',   // pending → processing → processed → approved / rejected
            cleanedAt:   null,
            processedAt: null,

            // AI pipeline outputs — populated by processExtraction()
            knowledge:   null,
            draft:       null,

            // Set when Manager approves
            recipeId:    null,
            approvedAt:  null,
            rejectedAt:  null,
        });

        console.log('LORE recipes.js: Extraction created, id:', added.id);
        return added.id;
    } catch (err) {
        console.warn('LORE recipes.js: Could not create extraction.', err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Process a pending extraction through the three-stage AI pipeline.
//
// Stage 1 — Classify: does this content contain expert decision logic?
//   Single AI call. Returns { hasKnowledge, confidence }.
//   If hasKnowledge is false, marks the extraction processed and stops.
//   This gate prevents worthless content from using Stage 2 and 3 tokens.
//
// Stage 2 — Extract: pull out the intermediate knowledge representation.
//   Single AI call. Returns { summary, situation, insight, evidenceQuote,
//   domain, confidence }. Stored in the extraction's `knowledge` field.
//   This is the permanent intermediate representation — it is never discarded.
//
// Stage 3 — Derive: derive a recipe draft from the knowledge representation.
//   Single AI call operating on the knowledge field (not raw content).
//   Returns { skillName, trigger, actionSequence, expectedOutcome, flawPattern,
//   confidence }. Stored in the extraction's `draft` field.
//
// Each stage is a separate AI call with a bounded single job. No stage reads
// the raw content directly except Stage 1's classifier. Stage 3 never sees
// rawContent — it derives from `knowledge` only.
//
// Returns { ok: true, draft } or { ok: false, reason }.
// ---------------------------------------------------------------------------
export async function processExtraction(orgId, extractionId, extraction) {
    console.log('LORE recipes.js: processExtraction — id:', extractionId, 'sourceType:', extraction.sourceType);

    // -------------------------------------------------------------------------
    // STAGE 1 — Classify: does this content contain expert decision logic?
    // -------------------------------------------------------------------------
    const stage1SystemPrompt = `You are a knowledge quality classifier for a professional learning platform.
Your only job is to decide whether a piece of contributed content contains genuine expert decision logic —
a specific pattern of professional judgement that a less experienced person would not automatically apply.

Expert decision logic has three characteristics:
  1. It is triggered by a specific, recognisable situation — not just "work hard" or "communicate clearly."
  2. It involves a non-obvious response that experience teaches — a novice would miss or mishandle it.
  3. It produces a meaningfully better outcome when applied correctly.

General advice, process descriptions, emotional reactions, and obvious statements do not qualify.

Return a JSON object with exactly these two fields:
{
  "hasKnowledge": true | false,
  "confidence": "high" | "medium" | "low"
}
Return the JSON object only — no other text.`;

    const stage1Prompt = `Source type: ${extraction.sourceType}
Raw prompt shown to contributor: ${extraction.rawPrompt || 'Not recorded'}
Contributor's words:
${extraction.rawContent}

Does this content contain genuine expert decision logic? Return the JSON object.`;

    const stage1Result = await classify(stage1Prompt, stage1SystemPrompt);
    if (!stage1Result.ok) {
        console.warn('LORE recipes.js: Stage 1 classify call failed — id:', extractionId);
        return { ok: false, reason: 'AI_UNAVAILABLE' };
    }

    const stage1 = extractJSON(stage1Result.text);
    if (!stage1) {
        console.warn('LORE recipes.js: Stage 1 JSON extraction failed — id:', extractionId);
        return { ok: false, reason: 'PARSE_FAILED' };
    }

    // If no expert knowledge present, mark processed and stop.
    // The extraction is preserved permanently — just not worth deriving a recipe from.
    if (!stage1.hasKnowledge) {
        console.log('LORE recipes.js: Stage 1 — no expert knowledge found, marking processed. id:', extractionId);
        try {
            await updateDoc(doc(db, 'organisations', orgId, 'extractions', extractionId), {
                status:      'processed',
                processedAt: serverTimestamp(),
                knowledge:   { hasKnowledge: false, confidence: stage1.confidence ?? 'low' },
                draft:       null,
            });
        } catch (err) {
            console.warn('LORE recipes.js: Could not mark extraction as processed (no knowledge).', err);
        }
        return { ok: false, reason: 'NO_KNOWLEDGE' };
    }

    console.log('LORE recipes.js: Stage 1 — expert knowledge detected. Confidence:', stage1.confidence, '. Proceeding to Stage 2.');

    // -------------------------------------------------------------------------
    // STAGE 2 — Extract: pull out the intermediate knowledge representation.
    // -------------------------------------------------------------------------
    const stage2SystemPrompt = `You are extracting a structured knowledge representation from a professional practitioner's contribution.
The content has already been confirmed to contain expert decision logic.

Your job is to identify and articulate the specific knowledge embedded in the text.
You are not yet producing a training recipe — you are capturing what the expert knows.

Return a JSON object with exactly these fields:
{
  "hasKnowledge": true,
  "summary": "One sentence describing what expertise is demonstrated here",
  "situation": "The specific professional situation where this expertise applies — one sentence, concrete and observable",
  "insight": "The non-obvious thing the expert knows or does that a less experienced person would miss — two to three sentences",
  "evidenceQuote": "The most telling phrase or sentence from the original text that demonstrates the expertise",
  "domain": "The professional skill area this belongs to — two to five words",
  "confidence": "high" | "medium" | "low"
}
Return the JSON object only — no other text.`;

    const stage2Prompt = `Source type: ${extraction.sourceType}
Context (original prompt shown to contributor): ${extraction.rawPrompt || 'Not recorded'}
Contributor's words:
${extraction.rawContent}

Extract the intermediate knowledge representation. Return the JSON object.`;

    const stage2Result = await classify(stage2Prompt, stage2SystemPrompt);
    if (!stage2Result.ok) {
        console.warn('LORE recipes.js: Stage 2 classify call failed — id:', extractionId);
        return { ok: false, reason: 'AI_UNAVAILABLE' };
    }

    const knowledge = extractJSON(stage2Result.text);
    if (!knowledge || !knowledge.summary) {
        console.warn('LORE recipes.js: Stage 2 JSON extraction failed — id:', extractionId);
        return { ok: false, reason: 'PARSE_FAILED' };
    }

    console.log('LORE recipes.js: Stage 2 complete — domain:', knowledge.domain, '. Proceeding to Stage 3.');

    // -------------------------------------------------------------------------
    // STAGE 3 — Derive: produce the recipe draft from the knowledge representation.
    // Stage 3 reads from `knowledge` only — never from rawContent directly.
    // This separation means the recipe is derived from understood knowledge,
    // not pattern-matched directly from the contributor's words.
    // -------------------------------------------------------------------------
    const stage3SystemPrompt = `You are producing a Career Recipe from a structured knowledge representation.
A Career Recipe is a concise, actionable description of a professional skill that can be used to train others.
You are working from the knowledge representation — not from the original raw text.

Return a JSON object with exactly these fields:
{
  "skillName": "Short name for this skill — three to six words, plain language",
  "trigger": "The specific situation that calls for this skill — one sentence, concrete and recognisable",
  "actionSequence": "What a skilled person does when the trigger fires — two to four numbered steps, specific and sequential",
  "expectedOutcome": "What successful application of this skill produces — one sentence",
  "flawPattern": "What a less experienced person typically does instead — one sentence, or null if not clear",
  "confidence": "high" | "medium" | "low"
}
Return the JSON object only — no other text.`;

    const stage3Prompt = `Knowledge representation:
Summary: ${knowledge.summary}
Situation: ${knowledge.situation}
Insight: ${knowledge.insight}
Evidence quote: ${knowledge.evidenceQuote}
Domain: ${knowledge.domain}

Derive a Career Recipe from this knowledge. Return the JSON object.`;

    const stage3Result = await classify(stage3Prompt, stage3SystemPrompt);
    if (!stage3Result.ok) {
        console.warn('LORE recipes.js: Stage 3 classify call failed — id:', extractionId);
        // We still have the knowledge representation — partial success.
        // Write what we have and return failure so the caller knows the draft is missing.
        try {
            await updateDoc(doc(db, 'organisations', orgId, 'extractions', extractionId), {
                status:      'processed',
                processedAt: serverTimestamp(),
                knowledge,
                draft:       null,
            });
        } catch (err) {
            console.warn('LORE recipes.js: Could not write partial extraction (Stage 3 failed).', err);
        }
        return { ok: false, reason: 'AI_UNAVAILABLE' };
    }

    const draft = extractJSON(stage3Result.text);
    if (!draft || !draft.skillName) {
        console.warn('LORE recipes.js: Stage 3 JSON extraction failed — id:', extractionId);
        try {
            await updateDoc(doc(db, 'organisations', orgId, 'extractions', extractionId), {
                status:      'processed',
                processedAt: serverTimestamp(),
                knowledge,
                draft:       null,
            });
        } catch (err) {
            console.warn('LORE recipes.js: Could not write partial extraction (Stage 3 parse failed).', err);
        }
        return { ok: false, reason: 'PARSE_FAILED' };
    }

    console.log('LORE recipes.js: Stage 3 complete — skill:', draft.skillName);

    // Write the completed extraction with both knowledge and draft.
    try {
        await updateDoc(doc(db, 'organisations', orgId, 'extractions', extractionId), {
            status:      'processed',
            processedAt: serverTimestamp(),
            knowledge,
            draft,
        });
    } catch (err) {
        console.warn('LORE recipes.js: Could not update extraction after Stage 3.', err);
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
    console.log('LORE recipes.js: Approving recipe — skill:', draft.skillName, 'domain:', domain);
    try {
        // Write to the recipes collection — this is now live knowledge
        const recipesRef = collection(db, 'organisations', orgId, 'recipes');
        const added = await addDoc(recipesRef, {
            skillName:       draft.skillName,
            trigger:         draft.trigger,
            actionSequence:  draft.actionSequence,
            expectedOutcome: draft.expectedOutcome,
            flawPattern:     draft.flawPattern ?? null,
            domain,
            approved:        true,
            approvedAt:      serverTimestamp(),
            extractionId:    extractionId ?? null,
        });

        // Mark the source extraction as approved
        if (extractionId) {
            await updateDoc(doc(db, 'organisations', orgId, 'extractions', extractionId), {
                status:     'approved',
                recipeId:   added.id,
                approvedAt: serverTimestamp(),
            });
        }

        console.log('LORE recipes.js: Recipe approved — id:', added.id);
        return added.id;
    } catch (err) {
        console.warn('LORE recipes.js: Could not approve recipe.', err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Reject an extraction — the Manager has reviewed it and decided it does not
// contain useful recipe content. Marks it dismissed in Firestore.
// Returns true on success.
// ---------------------------------------------------------------------------
export async function rejectExtraction(orgId, extractionId) {
    console.log('LORE recipes.js: Rejecting extraction:', extractionId);
    try {
        await updateDoc(doc(db, 'organisations', orgId, 'extractions', extractionId), {
            status:     'rejected',
            rejectedAt: serverTimestamp(),
        });
        console.log('LORE recipes.js: Extraction rejected.');
        return true;
    } catch (err) {
        console.warn('LORE recipes.js: Could not reject extraction.', err);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Process a document uploaded by the Manager.
//
// This function:
//   1. Writes a parent documents/{documentId} record with the full original
//      text — never truncated, never summarised. This is the permanent archive.
//   2. Determines whether chunking is needed (documents > 800 words are chunked).
//   3. Calls chunkDocument() to split into 800-word paragraphs with 150-word overlap.
//   4. Processes each chunk sequentially through createExtraction() and then
//      processExtraction() — each chunk that contains knowledge becomes an
//      extraction document awaiting Manager review.
//
// onProgress (optional): called with (chunkIndex, chunkTotal) after each chunk
//   is processed — used by the dashboard UI to show "Processing chunk N of N."
//
// Returns { ok: true, documentId, chunksProcessed, extractionsCreated }
//   or { ok: false, reason }.
// ---------------------------------------------------------------------------
export async function processDocument(orgId, uploadedBy, documentText, documentName, onProgress) {
    console.log('LORE recipes.js: processDocument — name:', documentName, 'length:', documentText?.length ?? 0, 'chars');

    if (!documentText || documentText.trim().length === 0) {
        return { ok: false, reason: 'EMPTY_DOCUMENT' };
    }

    // Step 1: Clean the document text for processing.
    // The full original text is stored verbatim — cleanedText is only used
    // for chunking and metadata computation.
    const cleanedText = cleanText(documentText);
    const wordCount   = countWords(cleanedText);
    const charCount   = documentText.length;

    // Step 2: Determine chunks.
    // Short documents (≤ 800 words) are treated as a single chunk.
    const chunks = shouldChunk(wordCount)
        ? chunkDocument(cleanedText)
        : [cleanedText];

    const chunkCount = chunks.length;

    // Step 3: Write the parent document record.
    // fullText stores the complete, untruncated original text.
    // This is the authoritative archive — the source of truth for provenance.
    let documentId;
    try {
        const docRef = collection(db, 'organisations', orgId, 'documents');
        const added  = await addDoc(docRef, {
            orgId,
            uploadedBy,
            documentName,
            fullText:   documentText,   // complete, never truncated
            charCount,
            wordCount,
            chunkCount,
            createdAt:  serverTimestamp(),
            status:     'processing',
        });
        documentId = added.id;
        console.log('LORE recipes.js: Parent document record written, id:', documentId, 'chunks:', chunkCount);
    } catch (err) {
        console.warn('LORE recipes.js: Could not write parent document record.', err);
        return { ok: false, reason: 'FIRESTORE_ERROR' };
    }

    // Step 4: Process each chunk sequentially.
    // Sequential (not parallel) to avoid Firestore write rate pressure and to
    // keep the AI call rate manageable. onProgress is called after each chunk
    // so the UI can show live progress.
    let extractionsCreated = 0;
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        console.log(`LORE recipes.js: Processing chunk ${i + 1} of ${chunkCount} for document:`, documentId);

        // createExtraction handles deduplication — if this chunk has been
        // seen before (e.g. document re-uploaded), it returns the existing ID.
        const extractionId = await createExtraction(orgId, {
            sourceType: 'document_chunk',
            rawContent: chunk,
            rawPrompt:  `Chunk ${i + 1} of ${chunkCount} from document: ${documentName}`,
            uploadedBy,
            sourceRef:  documentId,   // links back to the parent documents/{documentId}
        });

        if (extractionId) {
            // Fetch the extraction we just created to pass to processExtraction.
            // This is a lightweight read — we need the rawContent and sourceType.
            let extractionData = { sourceType: 'document_chunk', rawContent: chunk, rawPrompt: `Chunk ${i + 1} of ${chunkCount} from document: ${documentName}` };
            try {
                const snap = await getDoc(doc(db, 'organisations', orgId, 'extractions', extractionId));
                if (snap.exists()) extractionData = snap.data();
            } catch { /* use the inline object above if read fails */ }

            await processExtraction(orgId, extractionId, extractionData);
            extractionsCreated++;
        }

        // Report progress to caller
        if (typeof onProgress === 'function') {
            onProgress(i + 1, chunkCount);
        }
    }

    // Update the parent document record to reflect completion.
    try {
        await updateDoc(doc(db, 'organisations', orgId, 'documents', documentId), {
            status: 'processed',
        });
    } catch (err) {
        // Non-fatal — the extractions were created, the document record is just missing its status update
        console.warn('LORE recipes.js: Could not update document status to processed.', err);
    }

    console.log('LORE recipes.js: processDocument complete — document:', documentId, 'chunks:', chunkCount, 'extractions created:', extractionsCreated);
    return { ok: true, documentId, chunksProcessed: chunkCount, extractionsCreated };
}

// ---------------------------------------------------------------------------
// CORP-03 — Derive extractions from the response corpus.
//
// Reads all responses in the `responses/` corpus for this org and domain where
// flaggedForExtraction is true. Groups them by scenarioId (or by scenarioType
// if grouping by scenarioId does not yield enough content). For each group,
// runs the three-stage pipeline treating the concatenated response texts as
// rawContent and the shared scenario text as rawPrompt.
//
// Produces extraction documents with sourceType 'employee_response' that
// enter the normal Manager review queue — nothing is approved automatically.
//
// After processing, sets flaggedForExtraction: false on all source response
// documents so they are not re-processed on the next call.
//
// orgId:  the org to process for
// domain: the skill area to scope the derivation to. Pass null to process all.
//
// Returns { ok: true, groupsProcessed, extractionsCreated }
//   or { ok: false, reason }.
// ---------------------------------------------------------------------------
export async function deriveFromCorpus(orgId, domain) {
    console.log('LORE recipes.js: deriveFromCorpus — orgId:', orgId, 'domain:', domain ?? 'all');

    if (!orgId) return { ok: false, reason: 'MISSING_ORG' };

    // Step 1: Fetch all flagged responses for this org (and domain if specified).
    let flaggedQuery;
    try {
        const responsesRef = collection(db, 'organisations', orgId, 'responses');
        const constraints = [where('flaggedForExtraction', '==', true)];
        if (domain) constraints.push(where('domain', '==', domain));
        flaggedQuery = query(responsesRef, ...constraints);
    } catch (err) {
        console.warn('LORE recipes.js: Could not build flagged responses query.', err);
        return { ok: false, reason: 'QUERY_ERROR' };
    }

    let flaggedDocs;
    try {
        const snap = await getDocs(flaggedQuery);
        flaggedDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        console.log('LORE recipes.js: deriveFromCorpus — found', flaggedDocs.length, 'flagged responses.');
    } catch (err) {
        console.warn('LORE recipes.js: Could not fetch flagged responses.', err);
        return { ok: false, reason: 'FETCH_ERROR' };
    }

    if (flaggedDocs.length === 0) {
        return { ok: true, groupsProcessed: 0, extractionsCreated: 0 };
    }

    // Step 2: Group flagged responses by scenarioId.
    // Each scenarioId group represents multiple senior employees responding
    // to the same scenario — a rich signal for extracting consensus patterns.
    // Responses without a scenarioId are grouped by scenarioType as a fallback.
    const groups = {};
    for (const response of flaggedDocs) {
        // Prefer grouping by specific scenarioId for richer context.
        // Fall back to scenarioType to avoid losing responses with no scenarioId.
        const groupKey = response.scenarioId
            ? `scenario:${response.scenarioId}`
            : `type:${response.scenarioType ?? 'unknown'}`;

        if (!groups[groupKey]) {
            groups[groupKey] = {
                scenarioId:   response.scenarioId   ?? null,
                scenarioType: response.scenarioType ?? null,
                domain:       response.domain       ?? domain ?? 'General',
                // scenarioText is the question the employees were responding to.
                // All responses in a group share the same scenario so we can
                // use any one of them — we take the first one we encounter.
                scenarioText: null,
                responses:    [],
                responseIds:  [],
            };
        }

        // Capture the scenario text from whichever response first provides it.
        if (!groups[groupKey].scenarioText && response.rawPrompt) {
            groups[groupKey].scenarioText = response.rawPrompt;
        }

        groups[groupKey].responses.push(response.responseText ?? '');
        groups[groupKey].responseIds.push(response.id);
    }

    const groupKeys          = Object.keys(groups);
    let   groupsProcessed    = 0;
    let   extractionsCreated = 0;

    // Step 3: For each group, run the three-stage pipeline.
    for (const key of groupKeys) {
        const group = groups[key];
        if (group.responses.length === 0) continue;

        console.log('LORE recipes.js: deriveFromCorpus — processing group:', key, '— responses:', group.responses.length);

        // Concatenate the response texts from all senior employees in this group.
        // Each response is separated by a clear delimiter so the AI understands
        // these are multiple perspectives on the same situation.
        const concatenatedResponses = group.responses
            .filter(Boolean)
            .map((r, i) => `--- Response ${i + 1} ---\n${r}`)
            .join('\n\n');

        const rawPrompt = group.scenarioText
            ? `Scenario: ${group.scenarioText}`
            : `Scenario type: ${group.scenarioType ?? 'unknown'}`;

        // Create an extraction document for this group.
        const extractionId = await createExtraction(orgId, {
            sourceType: 'employee_response',
            rawContent: concatenatedResponses,
            rawPrompt,
            sourceRef:  group.scenarioId ?? null,
        });

        if (extractionId) {
            // processExtraction runs the three-stage AI pipeline on this group.
            const result = await processExtraction(orgId, extractionId, {
                sourceType: 'employee_response',
                rawContent: concatenatedResponses,
                rawPrompt,
            });

            if (result.ok) {
                extractionsCreated++;
                console.log('LORE recipes.js: deriveFromCorpus — extraction created for group:', key, '— skill:', result.draft?.skillName);
            } else {
                console.warn('LORE recipes.js: deriveFromCorpus — pipeline returned', result.reason, 'for group:', key);
            }
        }

        groupsProcessed++;

        // Step 4: Clear the flaggedForExtraction flag on all processed responses
        // in this group so they are not re-processed on the next call.
        for (const responseId of group.responseIds) {
            try {
                await updateDoc(doc(db, 'organisations', orgId, 'responses', responseId), {
                    flaggedForExtraction: false,
                });
            } catch (err) {
                // Non-fatal — a failed unflag means it may get re-processed next time,
                // but deduplication will catch it via the content hash.
                console.warn('LORE recipes.js: Could not clear flaggedForExtraction on response:', responseId, err);
            }
        }
    }

    console.log('LORE recipes.js: deriveFromCorpus complete — groups processed:', groupsProcessed, 'extractions created:', extractionsCreated);
    return { ok: true, groupsProcessed, extractionsCreated };
}