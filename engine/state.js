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

import { db } from './firebase.js';
import {
    doc,
    getDoc,
    setDoc,
    updateDoc,
    increment,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ---------------------------------------------------------------------------
// Rank ladder — 15 ranks, Intern to Oracle.
// [TUNING TARGET] XP thresholds — adjust if early ranks arrive too fast/slow.
// ---------------------------------------------------------------------------
export const RANKS = [
    { rank: 1,  name: 'Intern',       xpRequired: 0    },
    { rank: 2,  name: 'Associate',    xpRequired: 100  },
    { rank: 3,  name: 'Analyst',      xpRequired: 250  },
    { rank: 4,  name: 'Practitioner', xpRequired: 500  },
    { rank: 5,  name: 'Specialist',   xpRequired: 850  },
    { rank: 6,  name: 'Senior',       xpRequired: 1300 },
    { rank: 7,  name: 'Lead',         xpRequired: 1900 },
    { rank: 8,  name: 'Expert',       xpRequired: 2700 },
    { rank: 9,  name: 'Principal',    xpRequired: 3700 },
    { rank: 10, name: 'Strategist',   xpRequired: 5000 },
    { rank: 11, name: 'Director',     xpRequired: 6500 },
    { rank: 12, name: 'Architect',    xpRequired: 8500 },
    { rank: 13, name: 'Sage',         xpRequired: 11000 },
    { rank: 14, name: 'Master',       xpRequired: 14000 },
    { rank: 15, name: 'Oracle',       xpRequired: 18000 },
];

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
export async function recordResponse(verdict, domain) {
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
// Return the rank object for a given XP total.
// ---------------------------------------------------------------------------
export function getRankForXP(xp) {
    let rank = RANKS[0];
    for (const r of RANKS) {
        if (xp >= r.xpRequired) rank = r;
    }
    return rank;
}

// ---------------------------------------------------------------------------
// Return the XP needed to reach the next rank, and progress as a 0-1 fraction.
// Used to render the XP progress bar.
// ---------------------------------------------------------------------------
export function getXPProgress(xp) {
    const currentRank = getRankForXP(xp);
    const currentIndex = RANKS.findIndex(r => r.rank === currentRank.rank);
    const nextRank = RANKS[currentIndex + 1] ?? null;

    if (!nextRank) {
        // Oracle — max rank
        return { current: currentRank, next: null, progress: 1, xpToNext: 0 };
    }

    const base = currentRank.xpRequired;
    const cap  = nextRank.xpRequired;
    const progress = (xp - base) / (cap - base);
    const xpToNext = cap - xp;

    return { current: currentRank, next: nextRank, progress, xpToNext };
}