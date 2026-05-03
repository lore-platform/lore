// =============================================================================
// LORE — State Engine
// Manages session state: XP, streak, rank, domain mastery.
// localStorage is the fast layer. Firestore is the durable layer.
// On sign-in, Firestore is loaded into localStorage.
// On updates, localStorage is written first (instant UI), Firestore second.
//
// Rank ladder: 15 ranks. XP thresholds set so early ranks come quickly.
// Rank is per-skill-area — a Director can be an Intern in a new domain.
// =============================================================================

import { db } from '../firebase.js';
import { RANKS, getRankForXP, getXPProgress } from './utils.js';
// Re-export so callers that import from state.js continue to work unchanged.
export { RANKS, getRankForXP, getXPProgress };
import {
    doc,
    getDoc,
    setDoc,
    updateDoc,
    increment,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// [TUNING TARGET] XP awarded per verdict type.
const XP_CORRECT = 40;
const XP_PARTIAL = 15;
const XP_MISSED  = 0;

// ---------------------------------------------------------------------------
// In-memory session state.
// Populated on sign-in by loadState(). Cleared on sign-out by clearState().
// ---------------------------------------------------------------------------
let _state = null;

// ---------------------------------------------------------------------------
// Load state from Firestore into memory and localStorage.
// Called once on sign-in. Returns the loaded state object.
// ---------------------------------------------------------------------------
export async function loadState(uid, orgId) {
    const ref = doc(db, 'organisations', orgId, 'users', uid);
    console.log('LORE state.js: Loading state for uid:', uid, 'orgId:', orgId);

    try {
        const snap = await getDoc(ref);

        if (snap.exists()) {
            const data = snap.data();
            _state = {
                uid,
                orgId,
                xp:            data.xp            ?? 0,
                streak:        data.streak         ?? 0,
                lastTrainedAt: data.lastTrainedAt  ?? null,
                domainMastery: data.domainMastery  ?? {},
                sessionsTotal: data.sessionsTotal  ?? 0,
                // isCalibrated: true once 20 real sessions are recorded
                isCalibrated:  (data.sessionsTotal ?? 0) >= 20,
                // Seniority and role title come from the user profile document —
                // set at invite time and used to calibrate scenario difficulty.
                // Without this, all Employees get mid-level scenarios regardless
                // of their actual experience level.
                seniority:     data.seniority  ?? 'mid',
                roleTitle:     data.roleTitle   ?? '',
            };
            console.log('LORE state.js: State loaded from Firestore.', {
                xp: _state.xp,
                streak: _state.streak,
                sessionsTotal: _state.sessionsTotal,
                seniority: _state.seniority,
                isCalibrated: _state.isCalibrated,
            });
        } else {
            // First ever sign-in — create the user document
            console.log('LORE state.js: No existing user document — creating fresh state.');
            _state = {
                uid,
                orgId,
                xp: 0,
                streak: 0,
                lastTrainedAt: null,
                domainMastery: {},
                sessionsTotal: 0,
                isCalibrated: false,
                seniority: 'mid',
                roleTitle: '',
            };
            await setDoc(ref, {
                xp: 0,
                streak: 0,
                lastTrainedAt: null,
                domainMastery: {},
                sessionsTotal: 0,
                createdAt: serverTimestamp(),
            });
        }

        // Mirror to localStorage for fast reads
        localStorage.setItem('lore_state', JSON.stringify(_state));
        return _state;

    } catch (err) {
        console.warn('LORE state.js: Could not load state from Firestore.', err);
        // Fall back to localStorage if Firestore fails
        const cached = localStorage.getItem('lore_state');
        if (cached) {
            _state = JSON.parse(cached);
            console.log('LORE state.js: Fell back to localStorage state.');
            return _state;
        }
        // Return a zeroed state as last resort
        console.warn('LORE state.js: No localStorage fallback — returning zeroed state.');
        _state = { uid, orgId, xp: 0, streak: 0, domainMastery: {}, sessionsTotal: 0, isCalibrated: false, seniority: 'mid', roleTitle: '' };
        return _state;
    }
}

// ---------------------------------------------------------------------------
// Get the current in-memory state. Returns null if not loaded.
// ---------------------------------------------------------------------------
export function getState() {
    if (_state) return _state;
    const cached = localStorage.getItem('lore_state');
    return cached ? JSON.parse(cached) : null;
}

// ---------------------------------------------------------------------------
// Clear state on sign-out.
// ---------------------------------------------------------------------------
export function clearState() {
    console.log('LORE state.js: State cleared on sign-out.');
    _state = null;
    localStorage.removeItem('lore_state');
}

// ---------------------------------------------------------------------------
// Record a completed scenario response and update XP, streak, mastery.
// verdict: 'correct' | 'partial' | 'missed'
// domain: the skill area string the scenario belongs to
// Returns { xpGained, newTotal, rankUp, newRank }.
// ---------------------------------------------------------------------------
export async function recordResponse(verdict, domain, recipeId = null) {
    const state = getState();
    if (!state) return { xpGained: 0, newTotal: 0, rankUp: false, newRank: null };

    const xpGained = verdict === 'correct' ? XP_CORRECT
                   : verdict === 'partial'  ? XP_PARTIAL
                   : XP_MISSED;

    const prevRank = getRankForXP(state.xp);
    const newXP    = state.xp + xpGained;
    const newRank  = getRankForXP(newXP);
    const rankUp   = newRank.rank > prevRank.rank;

    // Update streak — resets if last session was more than 32 hours ago
    // [TUNING TARGET] 32-hour window allows for slight daily drift
    const now = new Date();
    const lastTrained = state.lastTrainedAt ? new Date(state.lastTrainedAt) : null;
    const hoursSinceLast = lastTrained
        ? (now - lastTrained) / (1000 * 60 * 60)
        : Infinity;

    let newStreak = state.streak;
    if (hoursSinceLast > 32) {
        newStreak = 1; // streak broken — start fresh
    } else if (hoursSinceLast > 8) {
        newStreak = state.streak + 1; // new day, streak continues
    }
    // If < 8 hours, same training session — streak count unchanged

    // Update domain mastery
    const mastery = { ...state.domainMastery };
    if (!mastery[domain]) mastery[domain] = { played: 0, correct: 0 };
    mastery[domain].played  += 1;
    mastery[domain].correct += verdict === 'correct' ? 1 : 0;

    const newSessions = (state.sessionsTotal ?? 0) + 1;

    // Update local state immediately
    _state = {
        ...state,
        xp:            newXP,
        streak:        newStreak,
        lastTrainedAt: now.toISOString(),
        domainMastery: mastery,
        sessionsTotal: newSessions,
        isCalibrated:  newSessions >= 20,
    };
    localStorage.setItem('lore_state', JSON.stringify(_state));

    // Persist to Firestore asynchronously — non-blocking
    const ref = doc(db, 'organisations', state.orgId, 'users', state.uid);
    updateDoc(ref, {
        xp:            increment(xpGained),
        streak:        newStreak,
        lastTrainedAt: serverTimestamp(),
        [`domainMastery.${domain}.played`]:  increment(1),
        [`domainMastery.${domain}.correct`]: increment(verdict === 'correct' ? 1 : 0),
        sessionsTotal: increment(1),
    }).catch(err => console.warn('LORE: State sync to Firestore failed.', err));

    // ENG-01 — Spaced retrieval tracking per recipe.
    // When a recipeId is provided, write or update the recipeProgress document
    // for this Employee. Due date is calculated from the verdict:
    //   correct → exponential backoff: 3 days × consecutiveCorrect (capped at 21 days)
    //   partial → fixed 2-day interval
    //   missed  → fixed 1-day interval (review soon)
    // consecutiveCorrect increments on correct, resets to 0 on missed, unchanged on partial.
    // Non-breaking — callers without recipeId continue to work unchanged.
    if (recipeId) {
        _writeRecipeProgress(state.orgId, state.uid, recipeId, domain, verdict)
            .catch(err => console.warn('LORE state.js: recipeProgress write failed silently.', err));
    }

    // COG-01 — Domain consistency signal.
    // After each verdict, read the last 10 pattern signals for this domain,
    // compute the standard deviation of numeric verdict values
    // (correct = 1, partial = 0.5, missed = 0), and write as domainConsistency[domain]
    // on the user document. Gives the Manager a stability signal per skill area.
    // Also writes a trend field to the recipeProgress document when verdict is
    // partial or missed and a recipeId is present.
    // Non-blocking — failure does not affect the Employee's result.
    _writeDomainConsistency(state.orgId, state.uid, domain, recipeId, verdict)
        .catch(err => console.warn('LORE state.js: domainConsistency write failed silently.', err));

    console.log('LORE state.js: Response recorded.', {
        verdict,
        domain,
        xpGained,
        newTotal: newXP,
        rankUp,
        newRank: newRank.name,
        newStreak,
        sessionsTotal: newSessions,
    });

    return { xpGained, newTotal: newXP, rankUp, newRank };
}

// ---------------------------------------------------------------------------
// Internal — write or update the recipeProgress document for spaced retrieval.
//
// Due-date calculation:
//   correct → now + (3 days × consecutiveCorrect), minimum 3 days, max 21 days
//   partial → now + 2 days
//   missed  → now + 1 day
//
// consecutiveCorrect is the core of the spaced retrieval algorithm:
//   it grows on correct verdicts (making the next interval longer) and
//   resets to zero on missed (pulling the recipe back into frequent review).
//   Partial leaves it unchanged — close but not confident enough to extend.
//
// trend is computed from the last 5 verdicts in the verdicts[] array:
//   'improving'  — more recent verdicts are better than earlier ones
//   'declining'  — more recent verdicts are worse than earlier ones
//   'flat'       — no clear direction
// Written back when verdict is partial or missed and recipeId is present.
// ---------------------------------------------------------------------------
async function _writeRecipeProgress(orgId, uid, recipeId, domain, verdict) {
    const { getDoc, setDoc, updateDoc, doc, arrayUnion, serverTimestamp: sts } =
        await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    const { db: _db } = await import('../firebase.js');

    const progressRef = doc(_db, 'organisations', orgId, 'users', uid, 'recipeProgress', recipeId);

    let existing = null;
    try {
        const snap = await getDoc(progressRef);
        if (snap.exists()) existing = snap.data();
    } catch { /* treat as new if read fails */ }

    const now = new Date();

    // Compute new consecutiveCorrect
    const prevConsecutive = existing?.consecutiveCorrect ?? 0;
    const newConsecutive  = verdict === 'correct' ? prevConsecutive + 1
                          : verdict === 'missed'  ? 0
                          : prevConsecutive;   // partial — unchanged

    // Compute dueAt
    const daysUntilDue = verdict === 'correct' ? Math.min(3 * Math.max(newConsecutive, 1), 21)
                       : verdict === 'partial'  ? 2
                       : 1;   // missed
    const dueAt = new Date(now.getTime() + daysUntilDue * 24 * 60 * 60 * 1000);

    // Compute trend from the last 5 verdicts (including this one)
    const verdictValue = (v) => v === 'correct' ? 1 : v === 'partial' ? 0.5 : 0;
    const prevVerdicts = existing?.verdicts ?? [];
    const recentVerdicts = [...prevVerdicts.slice(-4), verdict];   // last 4 + current = up to 5
    let trend = 'flat';
    if (recentVerdicts.length >= 3) {
        const firstHalf  = recentVerdicts.slice(0, Math.floor(recentVerdicts.length / 2));
        const secondHalf = recentVerdicts.slice(Math.ceil(recentVerdicts.length / 2));
        const avgFirst   = firstHalf.reduce((s, v) => s + verdictValue(v), 0)  / firstHalf.length;
        const avgSecond  = secondHalf.reduce((s, v) => s + verdictValue(v), 0) / secondHalf.length;
        if (avgSecond > avgFirst + 0.15)      trend = 'improving';
        else if (avgSecond < avgFirst - 0.15) trend = 'declining';
    }

    const progressData = {
        recipeId,
        domain,
        lastSeen:          now,
        dueAt,
        verdicts:          arrayUnion(verdict),
        consecutiveCorrect: newConsecutive,
        // trend is only written when verdict is partial or missed — correct verdicts
        // are already the target state; trend is most useful as a warning signal.
        ...(verdict !== 'correct' ? { trend } : {}),
    };

    try {
        if (existing) {
            await updateDoc(progressRef, progressData);
        } else {
            await setDoc(progressRef, progressData);
        }
        console.log('LORE state.js: recipeProgress updated — recipeId:', recipeId, 'daysUntilDue:', daysUntilDue, 'consecutiveCorrect:', newConsecutive);
    } catch (err) {
        console.warn('LORE state.js: Could not write recipeProgress.', err);
    }
}

// ---------------------------------------------------------------------------
// Internal — compute and write domainConsistency for a domain after a verdict.
//
// Reads the last 10 patternSignals for this domain, converts verdicts to
// numeric values (correct=1, partial=0.5, missed=0), computes standard
// deviation, and writes the result to domainConsistency[domain] on the user
// document. A higher standard deviation means more variable performance —
// the Manager uses this to identify domains where an Employee is inconsistent
// even if their average score looks reasonable.
// ---------------------------------------------------------------------------
async function _writeDomainConsistency(orgId, uid, domain, recipeId, verdict) {
    const {
        collection, query, where, orderBy, limit, getDocs,
        doc, updateDoc, serverTimestamp: sts,
    } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    const { db: _db } = await import('../firebase.js');

    try {
        // Read the last 10 pattern signals for this domain
        const signalsRef = collection(_db, 'organisations', orgId, 'users', uid, 'patternSignals');
        const q = query(
            signalsRef,
            where('domain', '==', domain),
            orderBy('createdAt', 'desc'),
            limit(10)
        );
        const snap = await getDocs(q);

        if (snap.empty) return;

        // Convert verdicts to numeric values
        const verdictValue = (v) => v === 'correct' ? 1 : v === 'partial' ? 0.5 : 0;
        const values = snap.docs.map(d => verdictValue(d.data().verdict ?? 'missed'));

        // Compute standard deviation
        const mean   = values.reduce((s, v) => s + v, 0) / values.length;
        const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length;
        const stdDev = parseFloat(Math.sqrt(variance).toFixed(3));

        // Write domainConsistency[domain] to the user document
        const userRef = doc(_db, 'organisations', orgId, 'users', uid);
        await updateDoc(userRef, {
            [`domainConsistency.${domain}`]: stdDev,
        });

        console.log('LORE state.js: domainConsistency written — domain:', domain, 'stdDev:', stdDev);
    } catch (err) {
        console.warn('LORE state.js: Could not write domainConsistency.', err);
    }
}