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

// Plain JSON deep clone — safe here since every blank shape below is pure
// JSON-serialisable data (no functions, Dates, or undefined values). A
// shallow `{ ...obj }` spread would still share obj's nested arrays/objects
// across every session that reuses it — this avoids that.
function _clone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Blank shapes for each resettable field — the single source of truth for
// both createSession() (a session's initial state) and resetSessionFrom()
// (invalidating a field back to that same initial state when an earlier
// screen is re-confirmed after a rewind). Keeping these in one place means
// the two can never drift apart from each other. Always read through
// _clone() — see above for why.
// ---------------------------------------------------------------------------
const _BLANK_SORTING_TASK = { situations: [], groups: [] };

const _BLANK_POLICY_MODEL = {
    decisionTree: null,
    summaryText: '',
    expertAccuracyRating: '',
    expertAccuracyNote: '',
    policyBreaks: [],
};

const _BLANK_ELICITATION = {
    cases: [],
    triad: {
        scenarioIds: [],
        discriminationAnswer: '',
    },
};

const _BLANK_RECIPE = {
    extractedKnowledge: '',
    trigger: {
        appliesWhen:          '',
        notWhen:              '',
        distinguishingSignal: '',
    },
    actionSequence: [],
    expectedOutcome: '',
    expertValidation: '',
    expertValidationNote: '',
    status: 'draft',
    formattingCheck: {
        droppedTerms:       [],
        expertAcknowledged: false,
    },
};

const _BLANK_TRANSFER = {
    learnerUid: '',
    preRecipeScenarios: [],
    postRecipeScenarios: [],
    comparisonResult: '',
    shiftMagnitude: 0,
};

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

        // currentView — tracks which screen the expert is actually on, updated
        // by saveCurrentView() every time next() advances them to a new
        // screen. Resume-on-reload reads this directly rather than inferring
        // position from whether various data fields happen to be populated —
        // inference broke down at the cue-review->options boundary
        // specifically because cueLibrary and sortingTask.groups both get
        // written by earlier screens, before cue-review is ever confirmed.
        // See app.js's _getResumeView / _legacyResumeView.
        currentView: 'profile',

        // furthestReached — separate from currentView. Only ever moves
        // forward, EXCEPT when the expert re-confirms an earlier screen after
        // going back (a "rewind"), at which point it gets pulled back down to
        // just past that screen. This is the stable reference
        // resetSessionFrom() needs — currentView alone isn't enough, because
        // it mutates as the expert walks forward again after a rewind, which
        // would erase the memory of how much invalidating there is to do
        // partway through a multi-screen rewind. See app.js's _makeAdvance.
        furthestReached: 'profile',

        profile: {
            role: '',
            whatYouDo: '',
            decisionTypes: '',
            whatMakesItHard: '',
            documentsText: '',
        },

        cueLibrary: [],
        decisionOptions: [],

        sortingTask: _clone(_BLANK_SORTING_TASK),

        scenarios: [],
        scenarioCombos: [],  // 30 precomputed cue combinations, written once at the
                              // start of Screen 5 so a session split across sittings
                              // resumes into the same combinations rather than fresh ones

        policyModel: _clone(_BLANK_POLICY_MODEL),

        elicitation: _clone(_BLANK_ELICITATION),

        recipe: _clone(_BLANK_RECIPE),

        transfer: _clone(_BLANK_TRANSFER),
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
// saveCurrentView(sessionId, view)
// Called by app.js's _makeAdvance every time the expert advances to a new
// screen. This is the single source of truth resume-on-reload reads from —
// see the comment on `currentView` in createSession's blank object above.
// ---------------------------------------------------------------------------
export async function saveCurrentView(sessionId, view) {
    return _update(sessionId, { currentView: view });
}

// ---------------------------------------------------------------------------
// saveFurthestReached(sessionId, view)
// See the comment on `furthestReached` in createSession's blank object above
// — the stable high-water-mark app.js's rewind detection compares against.
// ---------------------------------------------------------------------------
export async function saveFurthestReached(sessionId, view) {
    return _update(sessionId, { furthestReached: view });
}

// ---------------------------------------------------------------------------
// resetSessionFrom(sessionId, screenName)
//
// Called by app.js when it detects the expert has re-confirmed a screen
// after going back to it — i.e. they'd already reached further than
// screenName before, and are now re-confirming it with (potentially)
// different data. Clears every field that would otherwise go stale relative
// to that change, so screens further along show a genuine blank/fresh state
// rather than old data that no longer matches what it was built from.
//
// Deliberately NOT a generic "every screen after this one in sequence"
// sweep — cueLibrary is written by profile.js, sorting.js, AND
// cue-review.js, so whichever of those three is the one actually being
// re-confirmed has ALREADY rewritten it fresh, moments before this runs.
// Blanking it here would destroy data that was just correctly saved.
// cueLibrary is therefore never included in any entry below — it self-heals
// via the natural profile -> sorting -> cue-review order rewriting it each
// time. sortingTask is the one exception worth noting the other way:
// it's only ever written by sorting.js, but IS included under 'profile',
// because a changed profile genuinely makes the existing situations/groups
// stale (they were generated from the old profile text).
// ---------------------------------------------------------------------------
const _DOWNSTREAM_FIELDS = {
    'profile':     ['sortingTask', 'decisionOptions', 'scenarios', 'scenarioCombos', 'policyModel', 'elicitation', 'recipe', 'transfer'],
    'sorting':     ['decisionOptions', 'scenarios', 'scenarioCombos', 'policyModel', 'elicitation', 'recipe', 'transfer'],
    'cue-review':  ['decisionOptions', 'scenarios', 'scenarioCombos', 'policyModel', 'elicitation', 'recipe', 'transfer'],
    'options':     ['scenarios', 'scenarioCombos', 'policyModel', 'elicitation', 'recipe', 'transfer'],
    'session':     ['policyModel', 'elicitation', 'recipe', 'transfer'],
    'model-view':  ['elicitation', 'recipe', 'transfer'],
    'elicitation': ['recipe', 'transfer'],
    'recipe':      ['transfer'],
    'transfer':    [],
    'summary':     [],
};

function _blankValueFor(field) {
    switch (field) {
        case 'sortingTask':     return _clone(_BLANK_SORTING_TASK);
        case 'decisionOptions': return [];
        case 'scenarios':       return [];
        case 'scenarioCombos':  return [];
        case 'policyModel':     return _clone(_BLANK_POLICY_MODEL);
        case 'elicitation':     return _clone(_BLANK_ELICITATION);
        case 'recipe':          return _clone(_BLANK_RECIPE);
        case 'transfer':        return _clone(_BLANK_TRANSFER);
        default:                return null;
    }
}

export async function resetSessionFrom(sessionId, screenName) {
    const fields = _DOWNSTREAM_FIELDS[screenName];
    if (!fields || fields.length === 0) return true;

    const updates = {};
    fields.forEach(field => { updates[field] = _blankValueFor(field); });

    console.log('Lab db.js: Rewind detected — invalidating downstream fields for session', sessionId, '— fields:', fields);
    return _update(sessionId, updates);
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
// Screen 2. sortingTask: { situations: [{id, text, source: 'expert'|'ai-suggested'}],
// groups: [{situationIds, commonality, discriminator}] }
// ---------------------------------------------------------------------------
export async function saveSortingTask(sessionId, sortingTask) {
    console.log('Lab db.js: Saving sorting task for session', sessionId);
    return _update(sessionId, { sortingTask });
}

// ---------------------------------------------------------------------------
// saveCueLibrary(sessionId, cueLibrary)
// Screens 1 (AI-proposed) and 3 (expert-reviewed, locked). cueLibrary: array
// of { id, name, definition, scale, layer, options, source: 'expert'|'ai-suggested' }
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
// Screen 5. Full overwrite of the scenarios array. Called incrementally —
// after each completed set of 6 — rather than once at the very end, so an
// expert who closes the app mid-session doesn't lose confirmed responses.
// scenarios: array per the data model (may be a partial array, < 30 records).
// ---------------------------------------------------------------------------
export async function saveScenarios(sessionId, scenarios) {
    console.log('Lab db.js: Saving scenarios for session', sessionId, '— count:', scenarios.length);
    return _update(sessionId, { scenarios });
}

// ---------------------------------------------------------------------------
// saveScenarioCombos(sessionId, combos)
// Screen 5. Writes the full set of 30 precomputed cue combinations once, at
// the start of the session, before any scenario text is generated. Read back
// on a later visit so a session resumed after closing the app uses the exact
// same combinations (and therefore the same scenarios) rather than a freshly
// generated set.
// ---------------------------------------------------------------------------
export async function saveScenarioCombos(sessionId, combos) {
    console.log('Lab db.js: Saving scenario combos for session', sessionId, '— count:', combos.length);
    return _update(sessionId, { scenarioCombos: combos });
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
// Screen 8. recipe: { extractedKnowledge,
// trigger: {appliesWhen, notWhen, distinguishingSignal},
// actionSequence: [{step, condition}], expectedOutcome, expertValidation,
// expertValidationNote, status, formattingCheck: {droppedTerms, expertAcknowledged} }
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
