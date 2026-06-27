/**
 * lab/app.js
 * ─────────────────────────────────────────────────────────────────────
 * Bootstrap for the Knowledge Extraction Lab.
 *
 * Responsibilities:
 *  - Ping the Cloudflare Worker on load
 *  - Render the auth screen and handle sign-in / sign-up
 *  - Maintain shared state: current user + current session ID
 *  - Export showView(), getCurrentUser(), getSessionId(), setSessionId()
 *    for use by view modules
 */

import { onAuthChange, signIn, signOut } from '../engine/auth.js';
import { ping } from '../engine/ai.js';

// ── Shared state ──────────────────────────────────────────────────────
let _currentUser = null;
let _sessionId = null;

export const getCurrentUser = () => _currentUser;
export const getSessionId = () => _sessionId;
export const setSessionId = (id) => { _sessionId = id; };

// ── View registry ─────────────────────────────────────────────────────
// All view IDs — used to hide every view before showing the target one.
const ALL_VIEW_IDS = [
    'auth', 'profile', 'sorting', 'cue-review',
    'options', 'session', 'model-view', 'elicitation',
    'recipe', 'transfer', 'summary',
];

// Dynamic loaders — only imported when the view is first navigated to.
// Empty placeholder files do not cause errors because they are never
// imported unless the user actually reaches that screen.
const VIEW_LOADERS = {
    'profile': () => import('./views/profile.js'),
    'sorting': () => import('./views/sorting.js'),
    'cue-review': () => import('./views/cue-review.js'),
    'options': () => import('./views/options.js'),
    'session': () => import('./views/session.js'),
    'model-view': () => import('./views/model-view.js'),
    'elicitation': () => import('./views/elicitation.js'),
    'recipe': () => import('./views/recipe.js'),
    'transfer': () => import('./views/transfer.js'),
    'summary': () => import('./views/summary.js'),
};

/**
 * showView(name)
 *
 * Hides every view, reveals the named one, then imports the matching
 * view module and calls its exported init(container, sessionId) function.
 *
 * Calling init() on every navigation (rather than caching) allows each
 * view to reload fresh data from Firestore on each visit, which is safer
 * for a multi-step flow where earlier screens can change later ones.
 *
 * @param {string} name — must match one of ALL_VIEW_IDS
 */
export async function showView(name) {
    // Hide all views
    ALL_VIEW_IDS.forEach(id => {
        document.getElementById(`view-${id}`)?.classList.add('hidden');
    });

    // Show the target view
    const target = document.getElementById(`view-${name}`);
    if (!target) {
        console.error(`[lab/app] showView: no element found for #view-${name}`);
        return;
    }
    target.classList.remove('hidden');

    // Load and call the view module's init() — auth view has no loader
    const loader = VIEW_LOADERS[name];
    if (!loader) return;

    try {
        const mod = await loader();
        if (typeof mod.init === 'function') {
            await mod.init(target, _sessionId);
        }
    } catch (err) {
        console.error(`[lab/app] showView: failed to load view "${name}"`, err);
        target.innerHTML = `
      <div class="lab-page">
        <div class="lab-error">
          Failed to load this screen. Check the browser console for details.
        </div>
      </div>
    `;
    }
}

// ── Auth screen ───────────────────────────────────────────────────────

function renderAuthScreen() {
    const container = document.getElementById('view-auth');
    container.innerHTML = `
    <div class="lab-auth">
      <div class="lab-auth-card card">

        <h1 class="lab-auth-title">Knowledge Extraction Lab</h1>
        <p class="lab-auth-subtitle">Sign in to begin or continue a session.</p>

        <div id="auth-error" class="lab-error hidden"></div>

        <div class="form-group">
          <label class="form-label" for="auth-email">Email</label>
          <input class="input" type="email" id="auth-email"
                 placeholder="you@example.com" autocomplete="email" />
        </div>

        <div class="form-group">
          <label class="form-label" for="auth-password">Password</label>
          <input class="input" type="password" id="auth-password"
                 placeholder="••••••••" autocomplete="current-password" />
        </div>

        <div class="lab-auth-actions">
          <button class="btn btn-primary" id="btn-sign-in">Sign In</button>
          <button class="btn btn-ghost"   id="btn-sign-up">Create Account</button>
        </div>

      </div>
    </div>
  `;

    const emailEl = document.getElementById('auth-email');
    const passwordEl = document.getElementById('auth-password');
    const errorEl = document.getElementById('auth-error');
    const signInBtn = document.getElementById('btn-sign-in');
    const signUpBtn = document.getElementById('btn-sign-up');

    function showError(msg) {
        errorEl.textContent = msg;
        errorEl.classList.remove('hidden');
    }

    function setLoading(on) {
        signInBtn.disabled = on;
        signUpBtn.disabled = on;
        signInBtn.textContent = on ? 'Signing in…' : 'Sign In';
    }

    async function handleAuth(isNewUser) {
        const email = emailEl.value.trim();
        const password = passwordEl.value;
        errorEl.classList.add('hidden');

        if (!email || !password) {
            showError('Please enter both email and password.');
            return;
        }
        if (isNewUser && password.length < 8) {
            showError('Password must be at least 8 characters for a new account.');
            return;
        }

        setLoading(true);
        try {
            // signIn(email, password, isNewUser) — this assumes engine/auth.js
            // accepts a third boolean to switch between sign-in and sign-up.
            // If your auth.js has separate signIn / signUp functions, import
            // signUp here and call it when isNewUser is true.
            await signIn(email, password, isNewUser);
            // Firebase's onAuthChange callback handles navigation after success.
        } catch (err) {
            showError(err.message || 'Authentication failed. Please try again.');
            setLoading(false);
        }
    }

    signInBtn.addEventListener('click', () => handleAuth(false));
    signUpBtn.addEventListener('click', () => handleAuth(true));

    // Allow Enter key to trigger sign-in from either field
    [emailEl, passwordEl].forEach(el =>
        el.addEventListener('keydown', e => { if (e.key === 'Enter') handleAuth(false); })
    );
}

// ── Bootstrap ─────────────────────────────────────────────────────────

function boot() {
    // Confirm the Cloudflare Worker is reachable (fire-and-forget)
    ping().catch(err => console.warn('[lab/app] Worker ping failed:', err));

    // Render the auth screen once (its HTML lives here, not in a view module)
    renderAuthScreen();

    // React to Firebase auth state changes
    onAuthChange(user => {
        _currentUser = user;

        if (user) {
            // Signed in — start at the profile screen
            // (Step 2 will add resume-session logic here)
            showView('profile');
        } else {
            // Signed out — reset session and return to auth
            _sessionId = null;
            showView('auth');
        }
    });
}

boot();