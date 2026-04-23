// =============================================================================
// LORE — Application Shell
// Listens for auth state changes and routes the user to the correct view
// based on their role claim. Manages navigation state and shared UI elements
// (nav bar, XP display, rank badge).
//
// Routing logic:
//   No user        → auth screen
//   role=employee  → training view
//   role=reviewer  → tasks view
//   role=manager   → dashboard view (or profile view if ?employee=UID in URL)
//
// Phase 2 additions:
//   Sign-out button in nav bar for all authenticated roles
//   ?employee=UID  → profile view (Manager only — deep-link to per-Employee view)
// =============================================================================

import { onAuthChange, getClaims, signIn, readInvite, redeemInvite, signOut } from './engine/auth.js';
import { loadState, clearState, getRankForXP } from './engine/state.js';
import { initTraining }  from './views/training.js';
import { initTasks }     from './views/tasks.js';
import { initDashboard } from './views/dashboard.js';
import { initProfile }   from './views/profile.js';

// ---------------------------------------------------------------------------
// Read invite ID from URL if present.
// Invite links look like: /?invite=INVITE_ID
// ---------------------------------------------------------------------------
function getInviteId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('invite') ?? null;
}

// ---------------------------------------------------------------------------
// Read employee UID from URL if present.
// Manager profile deep-links look like: /?employee=UID
// ---------------------------------------------------------------------------
function getEmployeeId() {
    const params = new URLSearchParams(window.location.search);
    return params.get('employee') ?? null;
}

// ---------------------------------------------------------------------------
// Show a view by ID, hide all others.
// ---------------------------------------------------------------------------
function showView(viewId) {
    const views = [
        'view-auth',
        'view-training',
        'view-tasks',
        'view-dashboard',
        'view-profile',
    ];
    views.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('active', id === viewId);
    });
}

// ---------------------------------------------------------------------------
// Update the shared nav bar for authenticated users.
// ---------------------------------------------------------------------------
function updateNav(role, state) {
    const nav = document.getElementById('app-nav');
    if (nav) nav.style.display = 'flex';

    const isEmployee = role === 'employee';

    const navXP      = document.getElementById('nav-xp');
    const navStreak  = document.getElementById('nav-streak');
    const navRank    = document.getElementById('nav-rank');
    const navSignOut = document.getElementById('nav-signout');

    if (navXP)      navXP.style.display      = isEmployee ? 'flex' : 'none';
    if (navStreak)  navStreak.style.display   = isEmployee ? 'flex' : 'none';
    if (navRank)    navRank.style.display     = isEmployee ? 'inline-flex' : 'none';
    // Sign-out is shown for all authenticated roles
    if (navSignOut) navSignOut.style.display  = 'inline-flex';

    if (isEmployee && state) {
        const xpVal  = document.getElementById('nav-xp-value');
        const strVal = document.getElementById('nav-streak-value');
        if (xpVal)  xpVal.textContent  = state.xp.toLocaleString();
        if (strVal) strVal.textContent = state.streak;

        const rank = getRankForXP(state.xp);
        if (navRank) navRank.textContent = rank.name;
    }
}

// ---------------------------------------------------------------------------
// Hide the nav bar (used on auth screen).
// ---------------------------------------------------------------------------
function hideNav() {
    const nav = document.getElementById('app-nav');
    if (nav) nav.style.display = 'none';
}

// refreshNav() was removed — training.js updates the nav directly to avoid
// a circular import. app.js → training.js → app.js is not valid in ES modules.

// ---------------------------------------------------------------------------
// Auth screen — sign-in and invite flow.
// ---------------------------------------------------------------------------
async function initAuth() {
    showView('view-auth');
    hideNav();

    const inviteId = getInviteId();

    // If there is an invite ID, load and show the invite section
    if (inviteId) {
        const invite = await readInvite(inviteId);
        if (invite) {
            document.getElementById('invite-section').style.display = 'block';
            document.getElementById('auth-submit').style.display = 'none';

            const context = document.getElementById('invite-context');
            if (context) {
                // Copy framed as joining the team — no mention of knowledge capture
                context.textContent = `You've been invited to join ${invite.orgName ?? 'your team'} on LORE.`;
            }
        }
    }

    // Sign-in form
    document.getElementById('auth-submit')?.addEventListener('click', async () => {
        const email    = document.getElementById('auth-email')?.value?.trim();
        const password = document.getElementById('auth-password')?.value;

        if (!email || !password) {
            showAuthError('Please enter your email and password.');
            return;
        }

        const btn = document.getElementById('auth-submit');
        btn.disabled = true;
        btn.textContent = 'Signing in…';

        const result = await signIn(email, password);
        if (!result.ok) {
            btn.disabled = false;
            btn.textContent = 'Sign in';
            showAuthError(result.error);
        }
        // On success, onAuthStateChanged fires and routes the user
    });

    // Enter key on email or password fields submits the sign-in form
    document.getElementById('auth-email')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('auth-submit')?.click();
    });
    document.getElementById('auth-password')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('auth-submit')?.click();
    });

    // Password visibility toggle
    document.getElementById('auth-pw-toggle')?.addEventListener('click', () => {
        const input  = document.getElementById('auth-password');
        const toggle = document.getElementById('auth-pw-toggle');
        if (!input) return;
        const isHidden = input.type === 'password';
        input.type       = isHidden ? 'text' : 'password';
        toggle.textContent = isHidden ? 'Hide' : 'Show';
        toggle.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
    });

    // Enter key on invite fields submits the invite form
    document.getElementById('invite-name')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('invite-submit')?.click();
    });
    document.getElementById('invite-password')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('invite-submit')?.click();
    });

    // Invite redemption form
    document.getElementById('invite-submit')?.addEventListener('click', async () => {
        const name     = document.getElementById('invite-name')?.value?.trim();
        const password = document.getElementById('invite-password')?.value;

        if (!name || !password) {
            showAuthError('Please enter your name and choose a password.');
            return;
        }
        if (password.length < 8) {
            showAuthError('Your password needs to be at least 8 characters.');
            return;
        }

        const btn = document.getElementById('invite-submit');
        btn.disabled = true;
        btn.textContent = 'Setting up your account…';

        const result = await redeemInvite(inviteId, name, password);
        if (!result.ok) {
            btn.disabled = false;
            btn.textContent = 'Join the team';
            showAuthError(result.error);
        }
        // On success, onAuthStateChanged fires and routes the user
    });
}

function showAuthError(message) {
    const el = document.getElementById('auth-error');
    if (el) {
        el.textContent = message;
        el.classList.add('visible');
    }
}

// ---------------------------------------------------------------------------
// Main auth state listener — routes user on every auth state change.
// ---------------------------------------------------------------------------
onAuthChange(async (user) => {
    if (!user) {
        console.log('LORE app.js: Auth state — no user. Routing to auth screen.');
        clearState();
        initAuth();
        return;
    }

    console.log('LORE app.js: Auth state — user signed in, uid:', user.uid);
    // User is signed in — get their role and org from token claims
    const claims = await getClaims();

    if (!claims) {
        // Claims not yet set (can happen immediately after invite redemption
        // before the Cloud Function has run). Show a brief loading state
        // and retry after a delay.
        showView('view-auth');
        hideNav();
        document.getElementById('view-auth').innerHTML = `
            <div class="auth-screen">
                <p class="auth-wordmark">LORE</p>
                <p style="color: var(--warm-grey); margin-top: 1rem;">Setting up your account…</p>
                <div class="spinner" style="margin-top: 1rem;"></div>
            </div>
        `;
        setTimeout(async () => {
            // Force token refresh and try again
            await user.getIdToken(true);
            window.location.reload();
        }, 3000);
        return;
    }

    const { role, orgId, uid } = claims;

    // Load state for Employees (XP, streak, rank)
    let state = null;
    if (role === 'employee') {
        state = await loadState(uid, orgId);
    }

    // Update shared nav
    updateNav(role, state);

    // Attach sign-out handler — wired once, available to all roles
    document.getElementById('nav-signout')?.addEventListener('click', async () => {
        await signOut();
        // onAuthStateChanged fires and routes to auth screen
    });

    // Route to the correct view
    console.log('LORE app.js: Routing — role:', role, 'orgId:', orgId);
    switch (role) {
        case 'employee':
            showView('view-training');
            await initTraining(orgId, uid, state);
            break;

        case 'reviewer':
            showView('view-tasks');
            await initTasks(orgId, uid, claims);
            break;

        case 'manager': {
            // Check if the URL contains a specific employee to profile
            const employeeId = getEmployeeId();
            if (employeeId) {
                showView('view-profile');
                await initProfile(orgId, employeeId);
            } else {
                showView('view-dashboard');
                await initDashboard(orgId, uid);
            }
            break;
        }

        default:
            // Unknown role — sign out and show auth
            await signOut();
            initAuth();
    }
});