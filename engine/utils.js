// =============================================================================
// LORE — Utils
// Pure functions with zero imports. No Firebase. No network. No side effects.
//
// These functions were previously split across state.js, ai.js, and auth.js.
// Extracting them here means:
//   1. They can be imported by any file without pulling in Firebase.
//   2. They can be tested directly in a browser test page without any mocks.
//   3. state.js, ai.js, and auth.js import from here rather than defining them.
//
// Rule: nothing in this file may ever import from firebase.js, gstatic.com,
// or any other network dependency. If a function needs a network call, it does
// not belong here.
// =============================================================================


// =============================================================================
// Rank ladder — 15 ranks, Intern to Oracle.
// Shared between state.js (XP recording), training.js (UI), profile.js,
// dashboard.js, and app.js (nav bar).
// [TUNING TARGET] XP thresholds — adjust if early ranks arrive too fast/slow.
// =============================================================================
export const RANKS = [
    { rank: 1,  name: 'Intern',       xpRequired: 0     },
    { rank: 2,  name: 'Associate',    xpRequired: 100   },
    { rank: 3,  name: 'Analyst',      xpRequired: 250   },
    { rank: 4,  name: 'Practitioner', xpRequired: 500   },
    { rank: 5,  name: 'Specialist',   xpRequired: 850   },
    { rank: 6,  name: 'Senior',       xpRequired: 1300  },
    { rank: 7,  name: 'Lead',         xpRequired: 1900  },
    { rank: 8,  name: 'Expert',       xpRequired: 2700  },
    { rank: 9,  name: 'Principal',    xpRequired: 3700  },
    { rank: 10, name: 'Strategist',   xpRequired: 5000  },
    { rank: 11, name: 'Director',     xpRequired: 6500  },
    { rank: 12, name: 'Architect',    xpRequired: 8500  },
    { rank: 13, name: 'Sage',         xpRequired: 11000 },
    { rank: 14, name: 'Master',       xpRequired: 14000 },
    { rank: 15, name: 'Oracle',       xpRequired: 18000 },
];

// ---------------------------------------------------------------------------
// Return the rank object for a given XP total.
// Pure — no I/O. Safe to call anywhere, including test pages.
// ---------------------------------------------------------------------------
export function getRankForXP(xp) {
    let rank = RANKS[0];
    for (const r of RANKS) {
        if (xp >= r.xpRequired) rank = r;
    }
    return rank;
}

// ---------------------------------------------------------------------------
// Return the XP needed to reach the next rank, and progress as a 0–1 fraction.
// Used to render the XP progress bar in training.js.
// ---------------------------------------------------------------------------
export function getXPProgress(xp) {
    const currentRank  = getRankForXP(xp);
    const currentIndex = RANKS.findIndex(r => r.rank === currentRank.rank);
    const nextRank     = RANKS[currentIndex + 1] ?? null;

    if (!nextRank) {
        // Oracle — max rank reached
        return { current: currentRank, next: null, progress: 1, xpToNext: 0 };
    }

    const base     = currentRank.xpRequired;
    const cap      = nextRank.xpRequired;
    const progress = (xp - base) / (cap - base);
    const xpToNext = cap - xp;

    return { current: currentRank, next: nextRank, progress, xpToNext };
}


// =============================================================================
// JSON extraction — five-pass recovery strategy.
// Moved from ai.js so it can be tested and imported without pulling in the
// Worker fetch dependency.
//
// Handles: markdown fences, partial JSON, truncated strings, missing brackets.
// Returns the parsed object/array, or null if all five passes fail.
// Callers handle null by falling back to stored content.
// =============================================================================
export function extractJSON(text) {
    if (!text) return null;

    // Pass 1: strip markdown fences and parse directly
    try {
        const stripped = text.replace(/```(?:json)?\n?/g, '').trim();
        return JSON.parse(stripped);
    } catch {}

    // Pass 2: find first {...} block
    try {
        const start = text.indexOf('{');
        const end   = text.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) {
            return JSON.parse(text.slice(start, end + 1));
        }
    } catch {}

    // Pass 3: find first [...] block
    try {
        const start = text.indexOf('[');
        const end   = text.lastIndexOf(']');
        if (start !== -1 && end !== -1 && end > start) {
            return JSON.parse(text.slice(start, end + 1));
        }
    } catch {}

    // Pass 4: repair truncated strings — truncate to last safe closing brace
    try {
        const lastBrace = text.lastIndexOf('}');
        if (lastBrace !== -1) {
            const truncated = text.slice(0, lastBrace + 1);
            return JSON.parse(truncated);
        }
    } catch {}

    // Pass 5: bracket-balancing walk
    // Walk the string counting opens vs closes, cut at the point they balance
    try {
        const start = text.indexOf('{');
        if (start !== -1) {
            let depth    = 0;
            let inString = false;
            let escaped  = false;
            for (let i = start; i < text.length; i++) {
                const ch = text[i];
                if (escaped)                    { escaped = false; continue; }
                if (ch === '\\' && inString)    { escaped = true;  continue; }
                if (ch === '"')                 { inString = !inString; continue; }
                if (inString)                   continue;
                if (ch === '{') depth++;
                if (ch === '}') {
                    depth--;
                    if (depth === 0) {
                        return JSON.parse(text.slice(start, i + 1));
                    }
                }
            }
        }
    } catch {}

    // All five passes failed
    console.warn('LORE utils.js: extractJSON failed after five passes. Raw text sample:', text.slice(0, 200));
    return null;
}


// =============================================================================
// Auth error mapping — Firebase Auth error codes → plain-language messages.
// Moved from auth.js so it can be tested without a Firebase dependency.
// The user should never see a raw Firebase error code.
// =============================================================================
export function friendlyAuthError(code) {
    const map = {
        'auth/invalid-email':          "That email address doesn't look right.",
        'auth/user-not-found':         "We couldn't find an account with that email.",
        'auth/wrong-password':         "That password isn't correct.",
        'auth/invalid-credential':     "Your email or password isn't correct.",
        'auth/too-many-requests':      'Too many attempts. Please wait a moment and try again.',
        'auth/email-already-in-use':   'An account with that email already exists.',
        'auth/weak-password':          'Your password needs to be at least 8 characters.',
        'auth/network-request-failed': 'Check your connection and try again.',
    };
    return map[code] || 'Something went wrong. Please try again.';
}
