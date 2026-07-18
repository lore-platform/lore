import { onAuthChange, signIn, signOut } from '../engine/auth.js';
import { friendlyAuthError }             from '../engine/utils.js';
import { auth }                          from '../firebase.js';
import {
    createUserWithEmailAndPassword,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

import { createSession, getLatestSession, getSession, saveCurrentView } from './db.js';

import { render as renderProfile   } from './views/profile.js';
import { render as renderSorting   } from './views/sorting.js';
import { render as renderCueReview } from './views/cue-review.js';
import { render as renderOptions   } from './views/options.js';

import { render as renderSession     } from './views/session.js';
import { render as renderModelView   } from './views/model-view.js';
import { render as renderElicitation } from './views/elicitation.js';
import { render as renderRecipe      } from './views/recipe.js';

import { render as renderTransfer } from './views/transfer.js';
import { render as renderSummary  } from './views/summary.js';

fetch('https://lore-worker.slop-runner.workers.dev', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ mode: 'ping' }),
}).catch(() => {});

const _urlParams        = new URLSearchParams(window.location.search);
const _transferSessionId = _urlParams.get('transfer');

const ALL_VIEWS = [
    'auth',
    'profile', 'sorting', 'cue-review', 'options',
    'session', 'model-view', 'elicitation', 'recipe',
    'transfer', 'summary',
];

const SCREEN_NUM = {
    'profile': 1, 'sorting': 2, 'cue-review': 3, 'options': 4,
    'session': 5, 'model-view': 6, 'elicitation': 7, 'recipe': 8,
    'transfer': 9, 'summary': 10,
};

const SCREEN_SEQ = [
    'profile', 'sorting', 'cue-review', 'options',
    'session', 'model-view', 'elicitation', 'recipe',
    'transfer', 'summary',
];

let _currentUser    = null;
let _currentSession = null;
let _viewerRole      = 'expert';
let _activeView      = null;  // the screen actually on-screen right now — drives the Back button

export async function showView(name) {
    ALL_VIEWS.forEach(v => {
        const el = document.getElementById(`view-${v}`);
        if (el) el.style.display = 'none';
    });

    const el = document.getElementById(`view-${name}`);
    if (!el) {
        console.warn('Lab app.js: no container for view:', name);
        return;
    }
    el.style.display = 'block';
    _activeView = name;
    _updateBackButton();

    if (name === 'auth') return;

    if (!_currentSession) {
        console.warn('Lab app.js: showView called with no session — returning to auth');
        showView('auth');
        return;
    }

    const next = _makeAdvance(name);

    switch (name) {
        case 'profile':
            renderProfile(el, _currentSession, next);
            break;
        case 'sorting':
            renderSorting(el, _currentSession, next);
            break;
        case 'cue-review':
            renderCueReview(el, _currentSession, next);
            break;
        case 'options':
            renderOptions(el, _currentSession, next);
            break;

        case 'session':
            renderSession(el, _currentSession, next);
            break;
        case 'model-view':
            renderModelView(el, _currentSession, next);
            break;
        case 'elicitation':
            renderElicitation(el, _currentSession, next);
            break;
        case 'recipe':
            renderRecipe(el, _currentSession, next);
            break;

        case 'transfer':
            renderTransfer(el, _currentSession, next, _viewerRole);
            break;
        case 'summary':
            renderSummary(el, _currentSession, next, _viewerRole);
            break;

        default:
            console.warn('Lab app.js: unknown view:', name);
    }
}

function _makeAdvance(currentView) {
    const idx      = SCREEN_SEQ.indexOf(currentView);
    const nextView = idx >= 0 && idx < SCREEN_SEQ.length - 1
        ? SCREEN_SEQ[idx + 1]
        : 'summary';

    return async () => {
        if (_currentSession?.id) {
            await saveCurrentView(_currentSession.id, nextView);
            const fresh = await getSession(_currentSession.id);
            if (fresh) _currentSession = fresh;
        }
        showView(nextView);
    };
}

// ---------------------------------------------------------------------------
// _getResumeView(s) — where to land a returning expert. Trusts s.currentView
// directly when present: it's written by saveCurrentView every time next()
// fires, so it always reflects the actual screen the expert was last on —
// no guessing from which data fields happen to be populated.
//
// Falls back to _legacyResumeView only for sessions created before
// currentView existed. That inference function is kept, not deleted, purely
// for those old sessions — it should never run for anything created from
// here on, since createSession's blank object now sets currentView: 'profile'
// from the start.
// ---------------------------------------------------------------------------
function _getResumeView(s) {
    if (!s) return 'profile';
    if (s.recipe?.status === 'confirmed') return 'summary';

    if (s.currentView && ALL_VIEWS.includes(s.currentView)) {
        return s.currentView;
    }

    console.warn('Lab app.js: session has no currentView (pre-dates this field) — using legacy inference');
    return _legacyResumeView(s);
}

// ---------------------------------------------------------------------------
// _legacyResumeView(s) — the original data-presence heuristic. Kept as a
// fallback for sessions that predate currentView tracking, NOT used for
// anything created after that field was added. Known to be unreliable at the
// cue-review -> options boundary specifically (cueLibrary and
// sortingTask.groups are both written by earlier screens, before cue-review
// is ever confirmed) — this is exactly the bug that motivated currentView.
// ---------------------------------------------------------------------------
function _legacyResumeView(s) {
    if (s.recipe?.trigger?.appliesWhen)             return 'recipe';
    if (s.elicitation?.triad?.discriminationAnswer) return 'recipe';
    if (s.elicitation?.cases?.length)               return 'elicitation';
    if (s.policyModel?.expertAccuracyRating)        return 'elicitation';
    if (s.policyModel?.summaryText)                 return 'model-view';
    if ((s.scenarios?.length ?? 0) >= 30)           return 'model-view';
    if ((s.scenarios?.length ?? 0) > 0)             return 'session';
    if (s.decisionOptions?.length)                  return 'session';
    if (s.cueLibrary?.length && s.sortingTask?.groups?.length) return 'options';
    if (s.cueLibrary?.length)                       return 'cue-review';
    if (s.sortingTask?.situations?.length)          return 'sorting';
    if (s.profile?.role)                            return 'sorting';
    return 'profile';
}

function _makePips(active) {
    return Array.from({ length: 10 }, (_, i) => {
        const n   = i + 1;
        const cls = n === active ? 'active' : n < active ? 'done' : '';
        return `<div class="lab-pip ${cls}" title="Screen ${n}"></div>`;
    }).join('');
}

// ---------------------------------------------------------------------------
// Back button — lets the expert re-look at (and re-edit, if the screen
// allows it) an earlier step. Deliberately does NOT persist currentView —
// going back is a "let me check something" action, not a rewind of actual
// progress, so a reload while looking at an earlier screen still returns to
// the furthest point actually reached, not the screen being peeked at.
//
// If the expert edits and re-confirms an earlier screen (e.g. removes a cue
// after scenarios already exist), that screen's own next() naturally moves
// currentView to just past it again — which nudges a re-walk through the
// screens after it, since their data may no longer match. This doesn't
// automatically invalidate or regenerate anything downstream — flagging
// that as a real open question, not something quietly decided here.
// ---------------------------------------------------------------------------
function _updateBackButton() {
    const btn = document.getElementById('nav-back');
    if (!btn) return;

    const idx = SCREEN_SEQ.indexOf(_activeView);
    const canGoBack = _viewerRole === 'expert' && idx > 0;
    btn.style.display = canGoBack ? '' : 'none';
}

document.getElementById('nav-back')?.addEventListener('click', () => {
    const idx = SCREEN_SEQ.indexOf(_activeView);
    if (idx <= 0) return;
    showView(SCREEN_SEQ[idx - 1]);
});

async function _bootstrapTransferLink(sessionId) {
    _viewerRole = 'learner';
    document.getElementById('lab-nav').style.display = 'none';

    const session = await getSession(sessionId);

    if (!session) {
        _showLinkError("This link doesn't point to a valid session. Double-check the URL with the expert who sent it.");
        return;
    }

    if (session.recipe?.status !== 'confirmed') {
        _showLinkError("This Recipe hasn't been confirmed by the expert yet. Check back once they've finished reviewing it.");
        return;
    }

    _currentSession = session;

    const hasCompleted = (session.transfer?.postRecipeScenarios?.length ?? 0) > 0;
    showView(hasCompleted ? 'summary' : 'transfer');
}

function _showLinkError(message) {
    ALL_VIEWS.forEach(v => {
        const el = document.getElementById(`view-${v}`);
        if (el) el.style.display = 'none';
    });
    const el = document.getElementById('view-transfer');
    el.style.display = 'block';
    el.innerHTML = `<div class="lab-wrap"><div class="lab-notice lab-err">${message}</div></div>`;
}

onAuthChange(async (user) => {
    if (_transferSessionId) return;

    _currentUser = user;

    if (!user) {
        _currentSession = null;
        document.getElementById('lab-nav').style.display = 'none';
        showView('auth');
        return;
    }

    document.getElementById('lab-nav').style.display  = '';
    document.getElementById('nav-email').textContent   = user.email;

    let session = await getLatestSession(user.uid);
    if (!session) {
        session = await createSession(user.uid);
    }
    if (!session) {
        console.error('Lab app.js: could not load or create a session');
        showView('auth');
        return;
    }

    _currentSession = session;
    showView(_getResumeView(session));
});

function _switchTab(tab) {
    const isSignin = tab === 'signin';

    document.getElementById('form-signin').style.display = isSignin ? '' : 'none';
    document.getElementById('form-signup').style.display = isSignin ? 'none' : '';

    document.getElementById('tab-signin').classList.toggle('active', isSignin);
    document.getElementById('tab-signup').classList.toggle('active', !isSignin);

    document.getElementById('auth-err').classList.remove('visible');
}

function _showAuthErr(msg) {
    const el = document.getElementById('auth-err');
    el.textContent = msg;
    el.classList.add('visible');
}

function _setFormBusy(formId, btnId, busy, idleLabel) {
    const btn = document.getElementById(btnId);
    btn.disabled    = busy;
    btn.textContent = busy ? 'Please wait…' : idleLabel;
    document.getElementById(formId)
        .querySelectorAll('input')
        .forEach(i => { i.disabled = busy; });
}

document.getElementById('tab-signin').addEventListener('click', () => _switchTab('signin'));
document.getElementById('tab-signup').addEventListener('click', () => _switchTab('signup'));

document.getElementById('form-signin').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email    = document.getElementById('si-email').value.trim();
    const password = document.getElementById('si-password').value;
    if (!email || !password) return;

    document.getElementById('auth-err').classList.remove('visible');
    _setFormBusy('form-signin', 'btn-signin', true, 'Sign in');

    const result = await signIn(email, password);

    _setFormBusy('form-signin', 'btn-signin', false, 'Sign in');
    if (!result.ok) _showAuthErr(result.error);
});

document.getElementById('form-signup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email    = document.getElementById('su-email').value.trim();
    const password = document.getElementById('su-password').value;
    if (!email || !password) return;

    document.getElementById('auth-err').classList.remove('visible');
    _setFormBusy('form-signup', 'btn-signup', true, 'Create account');

    try {
        await createUserWithEmailAndPassword(auth, email, password);
    } catch (err) {
        _setFormBusy('form-signup', 'btn-signup', false, 'Create account');
        _showAuthErr(friendlyAuthError(err.code));
    }
});

document.getElementById('nav-signout').addEventListener('click', async () => {
    await signOut();
});

if (_transferSessionId) {
    _bootstrapTransferLink(_transferSessionId);
}
