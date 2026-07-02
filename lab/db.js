// =============================================================================
// Lab — db.js
// All Firestore reads and writes for the `sessions` collection live here.
// No view file ever calls Firestore directly — they all go through this file.
//
// Data model — see mvp-spec.md "Data Model" section. This file is the only
// place that shape is written to, so if the model ever changes, this is the
// only file that needs to change with it.
// =============================================================================

import { db } from '../firebase.js';
import {
    collection,
    doc,
    getDoc,
    addDoc,
    updateDoc,
    query,
    where,
    orderBy,
    limit,
    getDocs,
    serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const SESSIONS = 'sessions';

// ---------------------------------------------------------------------------
// createSession(expertUid)
// Creates a new session document with the full data model shape, all stage
// objects present but empty. Returns { id, ...data } or null on failure.
// ---------------------------------------------------------------------------
export async function createSession(expertUid) {
    console.log('Lab db.js: Creating new session for expertUid:', expertUid);

    const blank = {
        expertUid,
        createdAt: serverTimestamp(),

        profile: {
            role: '',
            whatYouDo: '',
            decisionTypes: '',
            whatMakesItHard: '',
            documentsText: '',
        },

        cueLibrary: [],
        decisionOptions: [],

        sortingTask: {
            situations: [],
            groups: [],
        },

        scenarios: [],

        policyModel: {
            decisionTree: null,
            summaryText: '',
            expertAccuracyRating: '',
            expertAccuracyNote: '',
            policyBreaks: [],
        },

        elicitation: {
            cases: [],
            triad: {
                scenarioIds: [],
                discriminationAnswer: '',
            },
        },

        recipe: {
            extractedKnowledge: '',
            trigger: '',
            actionSequence: [],
            expectedOutcome: '',
            expertValidation: '',
            expertValidationNote: '',
            status: 'draft',
        },

        transfer: {
            learnerUid: '',
            preRecipeScenarios: [],
            postRecipeScenarios: [],
            comparisonResult: '',
            shiftMagnitude: 0,
        },
    };

    try {
        const ref   = collection(db, SESSIONS);
        const added = await addDoc(ref, blank);
        console.log('Lab db.js: Session created, id:', added.id);
        return { id: added.id, ...blank };
    } catch (err) {
        console.warn('Lab db.js: Could not create session.', err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// getSession(sessionId)
// Returns { id, ...data } or null if not found / on failure.
// ---------------------------------------------------------------------------
export async function getSession(sessionId) {
    try {
        const snap = await getDoc(doc(db, SESSIONS, sessionId));
        if (!snap.exists()) return null;
        return { id: snap.id, ...snap.data() };
    } catch (err) {
        console.warn('Lab db.js: Could not fetch session.', sessionId, err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// getLatestSession(expertUid)
// Returns the most recently created session for this expert, or null if
// they have none yet. Used on sign-in to resume an in-progress session.
//
// NOTE: this returns the latest session regardless of completion status.
// If their latest session already has a confirmed Recipe, app.js's
// _getResumeView() will correctly route them to the Summary screen rather
// than re-opening a finished session for editing.
// ---------------------------------------------------------------------------
export async function getLatestSession(expertUid) {
    try {
        const q = query(
            collection(db, SESSIONS),
            where('expertUid', '==', expertUid),
            orderBy('createdAt', 'desc'),
            limit(1)
        );
        const snap = await getDocs(q);
        if (snap.empty) return null;
        const d = snap.docs[0];
        return { id: d.id, ...d.data() };
    } catch (err) {
        console.warn('Lab db.js: Could not fetch latest session for', expertUid, err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Generic updater — merges `updates` into the session document.
// Internal helper; prefer the named functions below from view files so
// intent stays clear at the call site.
// ---------------------------------------------------------------------------
async function _update(sessionId, updates) {
    try {
        await updateDoc(doc(db, SESSIONS, sessionId), updates);
        return true;
    } catch (err) {
        console.warn('Lab db.js: Update failed for session', sessionId, 'fields:', Object.keys(updates), err);
        return false;
    }
}

// ---------------------------------------------------------------------------
// saveProfile(sessionId, profile)
// Screen 1. profile: { role, whatYouDo, decisionTypes, whatMakesItHard, documentsText }
// ---------------------------------------------------------------------------
export async function saveProfile(sessionId, profile) {
    console.log('Lab db.js: Saving profile for session', sessionId);
    return _update(sessionId, { profile });
}

// ---------------------------------------------------------------------------
// saveSortingTask(sessionId, sortingTask)
// Screen 2. sortingTask: { situations: string[], groups: [{situationIds, commonality, discriminator}] }
// ---------------------------------------------------------------------------
export async function saveSortingTask(sessionId, sortingTask) {
    console.log('Lab db.js: Saving sorting task for session', sessionId);
    return _update(sessionId, { sortingTask });
}

// ---------------------------------------------------------------------------
// saveCueLibrary(sessionId, cueLibrary)
// Screens 1 (AI-proposed) and 3 (expert-reviewed, locked). cueLibrary: array
// of { id, name, definition, scale, layer, options }
// ---------------------------------------------------------------------------
export async function saveCueLibrary(sessionId, cueLibrary) {
    console.log('Lab db.js: Saving cue library for session', sessionId, '— count:', cueLibrary.length);
    return _update(sessionId, { cueLibrary });
}

// ---------------------------------------------------------------------------
// saveDecisionOptions(sessionId, decisionOptions)
// Screen 4. decisionOptions: array of { id, label, description }
// ---------------------------------------------------------------------------
export async function saveDecisionOptions(sessionId, decisionOptions) {
    console.log('Lab db.js: Saving decision options for session', sessionId, '— count:', decisionOptions.length);
    return _update(sessionId, { decisionOptions });
}

// ---------------------------------------------------------------------------
// saveScenarios(sessionId, scenarios)
// Screen 5. Full overwrite of the scenarios array — called once the
// 30-scenario session completes. scenarios: array per the data model.
// ---------------------------------------------------------------------------
export async function saveScenarios(sessionId, scenarios) {
    console.log('Lab db.js: Saving scenarios for session', sessionId, '— count:', scenarios.length);
    return _update(sessionId, { scenarios });
}

// ---------------------------------------------------------------------------
// savePolicyModel(sessionId, policyModel)
// Screen 6. policyModel: { decisionTree, summaryText, expertAccuracyRating,
// expertAccuracyNote, policyBreaks }
// ---------------------------------------------------------------------------
export async function savePolicyModel(sessionId, policyModel) {
    console.log('Lab db.js: Saving policy model for session', sessionId);
    return _update(sessionId, { policyModel });
}

// ---------------------------------------------------------------------------
// saveElicitation(sessionId, elicitation)
// Screen 7. elicitation: { cases: [...], triad: { scenarioIds, discriminationAnswer } }
// ---------------------------------------------------------------------------
export async function saveElicitation(sessionId, elicitation) {
    console.log('Lab db.js: Saving elicitation for session', sessionId);
    return _update(sessionId, { elicitation });
}

// ---------------------------------------------------------------------------
// saveRecipe(sessionId, recipe)
// Screen 8. recipe: { extractedKnowledge, trigger, actionSequence,
// expectedOutcome, expertValidation, expertValidationNote, status }
// ---------------------------------------------------------------------------
export async function saveRecipe(sessionId, recipe) {
    console.log('Lab db.js: Saving recipe for session', sessionId, '— status:', recipe.status);
    return _update(sessionId, { recipe });
}

// ---------------------------------------------------------------------------
// saveTransfer(sessionId, transfer)
// Screen 9. transfer: { learnerUid, preRecipeScenarios, postRecipeScenarios,
// comparisonResult, shiftMagnitude }
// ---------------------------------------------------------------------------
export async function saveTransfer(sessionId, transfer) {
    console.log('Lab db.js: Saving transfer data for session', sessionId);
    return _update(sessionId, { transfer });
}
