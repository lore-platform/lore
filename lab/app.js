// =============================================================================
// Lab — app.js
// Auth state listener, view router, session manager, and auth form handler.
//
// This file coordinates the entire lab:
//   - onAuthChange() drives everything — all routing starts here.
//   - showView(name) is the single function that switches the active screen.
//   - Each view's render(el, session, next) is called when that screen is shown.
//   - next() reloads the session from Firestore and advances to the next screen.
//
// Auth note: The Lab uses open self-registration (email + password, no invite).
// This is deliberate — the Lab is a standalone MVP with no org-level access
// control. signIn() and signOut() come from engine/auth.js; createUserWithEmail
// is called directly from Firebase Auth since auth.js has no sign-up function.
//
// Ping note: engine/ai.js does not currently export ping(). The Worker is
// warmed up here with a direct fire-and-forget fetch. The page renders
// immediately regardless of whether it succeeds — no blocking.
// =============================================================================

import { onAuthChange, signIn, signOut } from '../engine/auth.js';
import { friendlyAuthError }             from '../engine/utils.js';
import { auth }                          from '../firebase.js';
import {
    createUserWithEmailAndPassword,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

import { createSession, getLatestSession, getSession } from './db.js';

import { render as renderProfile   } from './views/profile.js';
import { render as renderSorting   } from './views/sorting.js';
import { render as renderCueReview } from './views/cue-review.js';
import { render as renderOptions   } from './views/options.js';

// Step 2 view imports — uncomment as each file is built:
// import { render as renderSession     } from './views/session.js';
// import { render as renderModelView   } from './views/model-view.js';
// import { render as renderElicitation } from './views/elicitation.js';
// import { render as renderRecipe      } from './views/recipe.js';

// Step 3 view imports — uncomment as each file is built:
// import { render as renderTransfer  } from './views/transfer.js';
// import { render as renderSummary   } from './views/summary.js';

// ---------------------------------------------------------------------------
// Warm up the Worker on load — fire-and-forget, never blocks rendering.
// engine/ai.js does not export ping(); this direct call is intentional.
// The Worker handles mode:'ping' (same as the pattern in engine/auth.js).
// ---------------------------------------------------------------------------
fetch('https://lore-worker.slop-runner.workers.dev', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ mode: 'ping' }),
}).catch(() => {}); // Non-fatal — error is silently swallowed

// ---------------------------------------------------------------------------
// View names — in screen order.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------
let _currentUser    = null;
let _currentSession = null;

// ---------------------------------------------------------------------------
// showView(name) — hides all views, shows the target, calls its render fn.
// ---------------------------------------------------------------------------
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

        // Step 2 — swap placeholder for real render call when built:
        case 'session':
        case 'model-view':
        case 'elicitation':
        case 'recipe':
        case 'transfer':
        case 'summary':
            el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_makePips(SCREEN_NUM[name])}</div>
  <p style="color:var(--warm-grey);padding:var(--space-8) 0;font-size:var(--text-base)">
    Screen ${SCREEN_NUM[name]} — built in Step 2.
  </p>
</div>`;
            break;

        default:
            console.warn('Lab app.js: unknown view:', name);
    }
}

// ---------------------------------------------------------------------------
// _makeAdvance(currentView) — builds the `next` callback passed to each view.
// ---------------------------------------------------------------------------
function _makeAdvance(currentView) {
    const idx      = SCREEN_SEQ.indexOf(currentView);
    const nextView = idx >= 0 && idx < SCREEN_SEQ.length - 1
        ? SCREEN_SEQ[idx + 1]
        : 'summary';

    return async () => {
        if (_currentSession?.id) {
            const fresh = await getSession(_currentSession.id);
            if (fresh) _currentSession = fresh;
        }
        showView(nextView);
    };
}

// ---------------------------------------------------------------------------
// _getResumeView(session) — finds the correct screen to resume from.
// ---------------------------------------------------------------------------
function _getResumeView(s) {
    if (!s) return 'profile';
    if (s.recipe?.status === 'confirmed')           return 'summary';
    if (s.recipe?.trigger)                          return 'recipe';
    if (s.elicitation?.triad?.discriminationAnswer) return 'recipe';
    if (s.elicitation?.cases?.length)               return 'elicitation';
    if (s.policyModel?.expertAccuracyRating)        return 'elicitation';
    if (s.policyModel?.summaryText)                 return 'model-view';
    if ((s.scenarios?.length ?? 0) >= 30)           return 'model-view';
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

// ============================================================================
// Auth state listener
// ============================================================================
onAuthChange(async (user) => {
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

// ============================================================================
// Auth form — tab switching
// ============================================================================
function _switchTab(tab) {
    const isSignin = tab === 'signin';

    document.getElementById('form-signin').style.display = isSignin ? '' : 'none';
    document.getElementById('form-signup').style.display = isSignin ? 'none' : '';

    document.getElementById('tab-signin').classList.toggle('active', isSignin);
    document.getElementById('tab-signup').classList.toggle('active', !isSignin);

    // Clear any previous error when switching tabs
    document.getElementById('auth-err').classList.remove('visible');
}

// Auth error uses .auth-error.visible from root style.css
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

// Sign-in form
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
    // On success, onAuthChange fires and handles routing
});

// Create account form
document.getElementById('form-signup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email    = document.getElementById('su-email').value.trim();
    const password = document.getElementById('su-password').value;
    if (!email || !password) return;

    document.getElementById('auth-err').classList.remove('visible');
    _setFormBusy('form-signup', 'btn-signup', true, 'Create account');

    try {
        await createUserWithEmailAndPassword(auth, email, password);
        // onAuthChange fires on success and handles routing
    } catch (err) {
        _setFormBusy('form-signup', 'btn-signup', false, 'Create account');
        _showAuthErr(friendlyAuthError(err.code));
    }
});

// Sign-out button
document.getElementById('nav-signout').addEventListener('click', async () => {
    await signOut();
    // onAuthChange fires and routes to auth screen
});
