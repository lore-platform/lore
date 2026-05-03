// =============================================================================
// LORE — Admin Dashboard
// Unified platform admin tool. Replaces provision.html and seed-demo.html.
//
// Responsibilities:
//   — Auth gate: Firebase sign-in + ADMIN_SECRET entry per session
//   — Organisations: list all provisioned orgs with manager details, delete
//   — Provision: create Manager accounts with full pre-flight checks
//   — Demo: provision + seed Meridian Advisory in one sequential flow, reset
//   — Activity log: every admin action written to Firestore, shown newest-first
//
// Firestore data structure:
//
//   platform/lore-platform             — singleton doc: platform operator namespace
//   platform/lore-platform/adminLogs/{logId}
//     Logged on every admin action: provision, delete, seed, reset.
//     Fields: action, orgId, orgName, detail, outcome, errorMsg, performedBy, createdAt.
//     Lives here — NOT at Firestore root — so the operator namespace is distinct
//     from the customer namespace (organisations/) and invite namespace (invites/).
//
//   organisations/{orgId}              — top-level doc, required for getDocs() listing
//   organisations/{orgId}/profile/data — read by dashboard.js and domains.js
//   organisations/{orgId}/users/{uid}  — org member documents
//
//   invites/{inviteId}                 — invite tokens, referenced by orgId (unchanged)
//
// Why platform/lore-platform/?
//   The platform operator is a real entity in the system. Giving it a dedicated
//   top-level collection (platform/) with a singleton document (lore-platform)
//   and sub-collections for its concerns (adminLogs/, config/) keeps operator
//   data cleanly separated from customer data. It also makes Firestore rules
//   straightforward: platform/** is admin-only, organisations/** is org-scoped.
//
// Import paths: admin/ files import from parent directory using ../
// =============================================================================

import { auth, db } from '../firebase.js';
import {
    signInWithEmailAndPassword,
    signOut as firebaseSignOut,
    onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
    collection,
    doc,
    getDoc,
    getDocs,
    setDoc,
    addDoc,
    updateDoc,
    deleteDoc,
    query,
    where,
    orderBy,
    limit,
    startAfter,
    serverTimestamp,
    Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ADMIN_EMAIL = 'osiokeitseuwa@gmail.com';
const WORKER_URL  = 'https://lore-worker.slop-runner.workers.dev';

// Public Firebase API key — used client-side for checkEmailExists and
// createFirebaseAuthUser only. These two calls use the key for its intended
// purpose: checking email availability and creating new accounts via the
// Firebase Auth REST API. They do NOT require admin authority.
// Account deletion and lookup (which DO require admin authority) now go
// through the Cloudflare Worker using a service account token instead.
const FIREBASE_API_KEY = 'AIzaSyBW_PE2RiIs-4_tAoOtKdQLXijh9-WNv7Q';

// Demo org constants — single source of truth, used by both seed and provision
const DEMO = {
    orgId:         'lore-demo',
    orgName:       'Meridian Advisory',
    industry:      'Consulting',
    managerName:   'Adaeze Okafor',
    managerEmail:  'adaeze@meridian.com',
    roleTitle:     'Head of L&D',
    // Interactive demo accounts — real Firebase Auth accounts so anyone can sign in
    employeeEmail: 'demo.employee@meridian-demo.co',
    reviewerEmail: 'demo.reviewer@meridian-demo.co',
    employeeName:  'Lena Marsh',
    reviewerName:  'David Osei',
};

// ---------------------------------------------------------------------------
// Industry domain seeds — provisional skill area names written at provisioning
// time for every new org. The Manager can rename or delete them from the
// dashboard. These are starting points, not permanent labels.
// Moved here from dashboard.js so provisioning owns the write, not the UI.
// [TUNING TARGET] Expand or refine per industry as LORE grows.
// ---------------------------------------------------------------------------
const SEEDS = {
    'Consulting':        ['Client Engagement', 'Stakeholder Management', 'Proposal Development', 'Delivery Excellence', 'Commercial Judgement'],
    'Financial Services':['Risk Assessment', 'Client Advisory', 'Regulatory Navigation', 'Portfolio Management', 'Deal Execution'],
    'Technology':        ['Product Thinking', 'Technical Communication', 'Delivery Management', 'Stakeholder Alignment', 'Incident Response'],
    'Healthcare':        ['Clinical Judgement', 'Patient Communication', 'Protocol Navigation', 'Team Coordination', 'Documentation'],
    'Legal':             ['Client Counsel', 'Matter Management', 'Risk Identification', 'Negotiation', 'Document Drafting'],
    'Education':         ['Learner Engagement', 'Curriculum Design', 'Assessment', 'Parent Communication', 'Classroom Management'],
    'Retail & Consumer': ['Customer Experience', 'Merchandising', 'Supplier Management', 'Operations', 'Sales Execution'],
    'Media & Creative':  ['Brief Interpretation', 'Client Management', 'Creative Direction', 'Production', 'Pitching'],
    'Non-profit':        ['Programme Delivery', 'Funder Relations', 'Community Engagement', 'Impact Measurement', 'Partnerships'],
    'Construction & Engineering': ['Site Management', 'Contract Administration', 'Health & Safety', 'Stakeholder Coordination', 'Technical Delivery'],
    'Other':             ['Leadership', 'Communication', 'Problem Solving', 'Stakeholder Management', 'Decision Making'],
};

// Session-only — entered at runtime, never stored
let _adminSecret  = null;
let _adminEmail   = null;

// Activity log pagination state
let _logLastDoc  = null;   // Firestore cursor doc for startAfter pagination
let _logPage     = 1;
let _logFilter   = '';     // ISO date 'YYYY-MM-DD' or '' for no filter
const LOG_PAGE_SIZE = 10;

// Activity log pagination state

// =============================================================================
// MODAL SYSTEM
// Custom confirm/alert modals — replaces all browser confirm() and alert() calls.
//
// Usage:
//   const confirmed = await showConfirm('Title', 'Body text.', { dangerConfirm: true });
//   if (!confirmed) return;
//   await showAlert('Title', 'Something to acknowledge.');
// =============================================================================

function _ensureModal() {
    if (document.getElementById('lore-modal')) return;
    const overlay = document.createElement('div');
    overlay.id = 'lore-modal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;background:rgba(28,22,14,0.55);backdrop-filter:blur(2px);padding:var(--space-4);';
    overlay.innerHTML = `
        <div style="background:var(--surface-1,#faf7f4);border:1px solid rgba(44,36,22,0.12);border-radius:var(--radius-lg,12px);padding:var(--space-6);max-width:420px;width:100%;box-shadow:0 8px 32px rgba(28,22,14,0.18);">
            <p id="lore-modal-title" style="font-size:var(--text-base);font-weight:600;margin-bottom:var(--space-3);line-height:1.4;"></p>
            <p id="lore-modal-body"  style="font-size:var(--text-sm);color:var(--warm-grey);line-height:1.6;margin-bottom:var(--space-6);white-space:pre-line;"></p>
            <div id="lore-modal-actions" style="display:flex;gap:var(--space-3);justify-content:flex-end;"></div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => {
        if (e.target === overlay && overlay.dataset.dismissible === 'true') { _closeModal(); overlay._resolve?.(); }
    });
}

function showConfirm(title, body, { confirmLabel = 'Confirm', cancelLabel = 'Cancel', dangerConfirm = false } = {}) {
    _ensureModal();
    document.getElementById('lore-modal-title').textContent = title;
    document.getElementById('lore-modal-body').textContent  = body;
    const overlay = document.getElementById('lore-modal');
    overlay.dataset.dismissible = 'false';
    document.getElementById('lore-modal-actions').innerHTML = `
        <button id="lore-modal-cancel"  class="btn btn-secondary" style="font-size:var(--text-sm);">${cancelLabel}</button>
        <button id="lore-modal-confirm" class="btn ${dangerConfirm ? '' : 'btn-primary'}" style="font-size:var(--text-sm);${dangerConfirm ? 'background:var(--error,#b83232);color:#fff;border-color:var(--error,#b83232);' : ''}">${confirmLabel}</button>`;
    overlay.style.display = 'flex';
    requestAnimationFrame(() => document.getElementById('lore-modal-confirm')?.focus());
    return new Promise(resolve => {
        overlay._resolve = resolve;
        document.getElementById('lore-modal-cancel').onclick  = () => { _closeModal(); resolve(false); };
        document.getElementById('lore-modal-confirm').onclick = () => { _closeModal(); resolve(true);  };
    });
}

function showAlert(title, body, { label = 'OK' } = {}) {
    _ensureModal();
    document.getElementById('lore-modal-title').textContent = title;
    document.getElementById('lore-modal-body').textContent  = body;
    const overlay = document.getElementById('lore-modal');
    overlay.dataset.dismissible = 'true';
    document.getElementById('lore-modal-actions').innerHTML = `
        <button id="lore-modal-ok" class="btn btn-primary" style="font-size:var(--text-sm);">${label}</button>`;
    overlay.style.display = 'flex';
    requestAnimationFrame(() => document.getElementById('lore-modal-ok')?.focus());
    return new Promise(resolve => {
        overlay._resolve = resolve;
        document.getElementById('lore-modal-ok').onclick = () => { _closeModal(); resolve(); };
    });
}

function _closeModal() {
    const el = document.getElementById('lore-modal');
    if (el) el.style.display = 'none';
}


// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------
onAuthStateChanged(auth, user => {
    if (user && user.email === ADMIN_EMAIL) {
        _adminEmail = user.email;
        // Already signed in — skip to secret entry if secret not yet set,
        // or straight to app if this is a re-render after secret was set
        if (_adminSecret) {
            showApp();
        } else {
            showSecretEntry();
        }
    } else {
        showSignIn();
    }
});

document.getElementById('gate-submit').addEventListener('click', async () => {
    const email    = document.getElementById('gate-email').value.trim();
    const password = document.getElementById('gate-password').value;
    const btn      = document.getElementById('gate-submit');

    if (!email || !password) { showGateError('Please enter your email and password.'); return; }

    btn.disabled = true; btn.textContent = 'Signing in…';
    try {
        const cred = await signInWithEmailAndPassword(auth, email, password);
        if (cred.user.email !== ADMIN_EMAIL) {
            await firebaseSignOut(auth);
            showGateError('This account does not have admin access.');
            btn.disabled = false; btn.textContent = 'Sign in';
            return;
        }
        _adminEmail = cred.user.email;
        showSecretEntry();
    } catch (err) {
        showGateError('Sign-in failed. Check your email and password.');
        btn.disabled = false; btn.textContent = 'Sign in';
    }
});

document.getElementById('gate-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('gate-submit').click();
});

document.getElementById('secret-submit').addEventListener('click', () => {
    const secret = document.getElementById('secret-input').value.trim();
    if (!secret) { showGateError('Please enter the admin secret.'); return; }
    _adminSecret = secret;
    showApp();
});

document.getElementById('secret-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('secret-submit').click();
});

document.getElementById('admin-signout').addEventListener('click', async () => {
    _adminSecret = null;
    _adminEmail  = null;
    await firebaseSignOut(auth);
    // onAuthStateChanged fires and routes back to sign-in
});

// ---------------------------------------------------------------------------
// Gate display helpers
// ---------------------------------------------------------------------------
function showSignIn() {
    document.getElementById('gate-screen').style.display = 'flex';
    document.getElementById('admin-app').style.display   = 'none';
    document.getElementById('gate-signin').style.display = 'block';
    document.getElementById('gate-secret').style.display = 'none';
    clearGateError();
}

function showSecretEntry() {
    document.getElementById('gate-screen').style.display = 'flex';
    document.getElementById('admin-app').style.display   = 'none';
    document.getElementById('gate-signin').style.display = 'none';
    document.getElementById('gate-secret').style.display = 'block';
    clearGateError();
}

function showApp() {
    document.getElementById('gate-screen').style.display = 'none';
    document.getElementById('admin-app').style.display   = 'block';
    document.getElementById('admin-email-display').textContent = _adminEmail ?? '';
    loadOrgList();
    loadActivityLog();
    loadDemoCreds();
}

function showGateError(msg) {
    const el = document.getElementById('gate-error');
    el.textContent = msg;
    el.classList.add('visible');
}

function clearGateError() {
    const el = document.getElementById('gate-error');
    el.textContent = '';
    el.classList.remove('visible');
}

// ---------------------------------------------------------------------------
// Org-name → slug helper for auto-populating org ID
// ---------------------------------------------------------------------------
function slugify(str) {
    return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

document.getElementById('p-org-name').addEventListener('input', e => {
    const orgIdEl = document.getElementById('p-org-id');
    if (!orgIdEl._manuallyEdited) orgIdEl.value = slugify(e.target.value);
});
document.getElementById('p-org-id').addEventListener('input', () => {
    document.getElementById('p-org-id')._manuallyEdited = true;
});

// ---------------------------------------------------------------------------
// Temp password generator
// ---------------------------------------------------------------------------
function generateTempPassword() {
    const upper   = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lower   = 'abcdefghjkmnpqrstuvwxyz';
    const digits  = '23456789';
    const symbols = '@#$!';
    const all     = upper + lower + digits + symbols;
    const pwd = [
        upper  [Math.floor(Math.random() * upper.length)],
        lower  [Math.floor(Math.random() * lower.length)],
        digits [Math.floor(Math.random() * digits.length)],
        symbols[Math.floor(Math.random() * symbols.length)],
    ];
    for (let i = pwd.length; i < 12; i++) pwd.push(all[Math.floor(Math.random() * all.length)]);
    return pwd.sort(() => Math.random() - 0.5).join('');
}

// ---------------------------------------------------------------------------
// Clipboard helper
// ---------------------------------------------------------------------------
function copyToClipboard(text, btn) {
    navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = orig; }, 1500);
    });
}

// =============================================================================
// SECTION 1 — Organisations list
// =============================================================================

document.getElementById('refresh-orgs').addEventListener('click', loadOrgList);

async function loadOrgList() {
    const listEl = document.getElementById('org-list');
    listEl.innerHTML = '<span class="spinner" style="width:18px;height:18px;"></span>';

    try {
        const orgsSnap = await getDocs(collection(db, 'organisations'));

        if (orgsSnap.empty) {
            listEl.innerHTML = '<p class="text-secondary text-sm">No organisations provisioned yet.</p>';
            return;
        }

        // For each org, load manager details and saved credentials from profile/data
        const orgs = await Promise.all(orgsSnap.docs.map(async orgDoc => {
            const orgId   = orgDoc.id;
            const orgData = orgDoc.data();

            let manager = null;
            let creds   = null;
            try {
                const [usersSnap, profileSnap] = await Promise.all([
                    getDocs(collection(db, 'organisations', orgId, 'users')),
                    getDoc(doc(db, 'organisations', orgId, 'profile', 'data')),
                ]);
                const managerDoc = usersSnap.docs.find(d => d.data().role === 'manager');
                if (managerDoc) manager = { uid: managerDoc.id, ...managerDoc.data() };
                if (profileSnap.exists()) creds = profileSnap.data().orgCredentials ?? null;
            } catch { /* non-fatal */ }

            return { orgId, orgData, manager, creds };
        }));

        listEl.innerHTML = orgs.map(({ orgId, orgData, manager, creds }) => {
            const created = orgData.createdAt
                ? new Date(orgData.createdAt.toDate()).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })
                : '—';

            const credsHtml = creds ? `
                <div class="admin-org-creds" id="creds-${orgId}" style="display:none;">
                    <div style="margin-top:var(--space-3);padding:var(--space-3);background:rgba(44,36,22,0.04);border-radius:var(--radius-md);font-size:var(--text-sm);">
                        <p class="label" style="font-size:var(--text-xs);margin-bottom:var(--space-2);">Sign-in credentials</p>
                        <p style="margin-bottom:var(--space-1);">
                            <span style="color:var(--warm-grey);min-width:80px;display:inline-block;">Email</span>
                            <code style="user-select:all;">${creds.managerEmail ?? manager?.email ?? '—'}</code>
                        </p>
                        <p style="margin-bottom:var(--space-1);">
                            <span style="color:var(--warm-grey);min-width:80px;display:inline-block;">Password</span>
                            <code style="user-select:all;">${creds.managerPassword ?? '—'}</code>
                        </p>
                        <p>
                            <span style="color:var(--warm-grey);min-width:80px;display:inline-block;">URL</span>
                            <a href="https://lore-platform.github.io/lore/" target="_blank" style="color:var(--ember);font-size:var(--text-xs);">lore-platform.github.io/lore/</a>
                        </p>
                        ${creds.savedAt ? `<p style="color:var(--warm-grey);font-size:var(--text-xs);margin-top:var(--space-2);">Saved ${new Date(creds.savedAt.toDate()).toLocaleString('en-GB', { dateStyle:'medium', timeStyle:'short' })}</p>` : ''}
                    </div>
                </div>` : '';

            return `
            <div class="admin-org-row" id="org-row-${orgId}">
                <div class="admin-org-info">
                    <p class="admin-org-name">${orgData.orgName ?? orgId}</p>
                    <p class="admin-org-meta">
                        <span>${orgId}</span>
                        <span>·</span>
                        <span>${orgData.industry ?? '—'}</span>
                        ${manager ? `<span>·</span><span>${manager.displayName ?? '—'} (${manager.email ?? '—'})</span>` : '<span>· No manager found</span>'}
                    </p>
                    <p class="admin-org-meta" style="margin-top:2px;">
                        <span>Created: ${created}</span>
                        ${manager ? `<span>·</span><span class="text-xs" style="color:var(--warm-grey);">UID: ${manager.uid}</span>` : ''}
                    </p>
                    ${creds ? `<button class="admin-org-creds-toggle text-xs" id="creds-toggle-${orgId}" style="margin-top:var(--space-2);background:none;border:none;cursor:pointer;color:var(--ember);padding:0;font-size:var(--text-xs);">Show credentials</button>` : '<p class="text-xs" style="color:var(--warm-grey);margin-top:var(--space-2);">No saved credentials</p>'}
                    ${credsHtml}
                </div>
                <div style="display:flex;flex-direction:column;gap:var(--space-2);align-items:flex-end;flex-shrink:0;">
                    <button class="btn admin-btn-danger" id="delete-org-${orgId}">Delete</button>
                    <div class="admin-org-delete-log" id="delete-log-${orgId}" style="display:none;"></div>
                </div>
            </div>`;
        }).join('');

        orgs.forEach(({ orgId, orgData, manager }) => {
            // Credentials toggle
            document.getElementById(`creds-toggle-${orgId}`)?.addEventListener('click', () => {
                const panel  = document.getElementById(`creds-${orgId}`);
                const toggle = document.getElementById(`creds-toggle-${orgId}`);
                if (!panel) return;
                const isHidden = panel.style.display === 'none';
                panel.style.display  = isHidden ? 'block' : 'none';
                toggle.textContent   = isHidden ? 'Hide credentials' : 'Show credentials';
            });

            // Delete button — now shows inline progress log
            document.getElementById(`delete-org-${orgId}`)?.addEventListener('click', async () => {
                const label = orgData.orgName ?? orgId;
                const confirmed = await showConfirm(
                    `Delete "${label}"?`,
                    `This removes the Firestore org, all sub-collections, and the Manager's Firebase Auth account. This cannot be undone.`,
                    { confirmLabel: 'Delete', dangerConfirm: true }
                );
                if (!confirmed) return;
                const btn    = document.getElementById(`delete-org-${orgId}`);
                const logEl  = document.getElementById(`delete-log-${orgId}`);
                btn.disabled = true; btn.textContent = 'Deleting…';
                if (logEl) logEl.style.display = 'block';
                await deleteOrg(orgId, orgData, manager, logEl);
                document.getElementById(`org-row-${orgId}`)?.remove();
                if (document.querySelectorAll('.admin-org-row').length === 0) {
                    listEl.innerHTML = '<p class="text-secondary text-sm">No organisations provisioned yet.</p>';
                }
            });
        });

    } catch (err) {
        console.error('LORE admin.js: loadOrgList error:', err);
        listEl.innerHTML = `<p style="color:var(--error);font-size:var(--text-sm);">Could not load organisations: ${err.message}</p>`;
    }
}

// ---------------------------------------------------------------------------
// Delete an org — removes Firebase Auth account, all Firestore sub-collections,
// the profile/data sub-document, and the top-level organisations/{orgId} document.
// ---------------------------------------------------------------------------
// logEl is an optional DOM element for inline progress logging during deletion.
// When provided, each step appends a line to it. Null is fine — silent mode.
async function deleteOrg(orgId, orgData, manager, logEl = null) {
    console.log('LORE admin.js: Deleting org:', orgId);
    let outcome  = 'success';
    let errorMsg = null;

    const _dlog = (msg, type = '') => {
        console.log('LORE deleteOrg:', msg);
        if (!logEl) return;
        const line = document.createElement('p');
        line.style.cssText = `margin:0;font-size:var(--text-xs);color:${type === 'err' ? 'var(--error)' : type === 'ok' ? 'var(--sage)' : 'var(--warm-grey)'};`;
        line.textContent = msg;
        logEl.appendChild(line);
    };

    // 1. Delete Firebase Auth account(s).
    // First delete the manager. Then look for interactive demo accounts if this
    // is the lore-demo org (they have email addresses stored on their user docs).
    const authToDelete = [];
    if (manager?.uid) authToDelete.push({ uid: manager.uid, label: 'Manager Auth' });

    // For any org, also check for users with isInteractive flag (interactive demo accounts)
    try {
        const usersSnap = await getDocs(collection(db, 'organisations', orgId, 'users'));
        usersSnap.docs.forEach(d => {
            if (d.data().isInteractive && d.id !== manager?.uid) {
                authToDelete.push({ uid: d.id, label: `${d.data().role ?? 'User'} Auth (${d.data().email ?? d.id})` });
            }
        });
    } catch { /* non-fatal */ }

    for (const account of authToDelete) {
        try {
            await deleteFirebaseAuthUser(account.uid);
            _dlog(`✓ Deleted: ${account.label} (UID: ${account.uid})`, 'ok');
        } catch (err) {
            _dlog(`✗ ${account.label} deletion failed: ${err.message}`, 'err');
            outcome  = 'partial';
            errorMsg = (errorMsg ? errorMsg + ' | ' : '') + `${account.label} deletion failed: ${err.message}`;
        }
    }

    // 2. Delete all sub-collections
    for (const sub of ['users', 'recipes', 'scenarios', 'extractions', 'domains']) {
        try {
            const snap = await getDocs(collection(db, 'organisations', orgId, sub));
            if (sub === 'users') {
                for (const userDoc of snap.docs) {
                    for (const userSub of ['patternSignals', 'recipeLibrary', 'tasks']) {
                        try {
                            const subSnap = await getDocs(collection(db, 'organisations', orgId, 'users', userDoc.id, userSub));
                            for (const sd of subSnap.docs) await deleteDoc(sd.ref);
                        } catch { /* non-fatal */ }
                    }
                    await deleteDoc(userDoc.ref);
                }
            } else {
                for (const d of snap.docs) await deleteDoc(d.ref);
            }
            _dlog(`✓ Deleted: ${sub} (${snap.size} docs)`, 'ok');
        } catch (err) {
            _dlog(`✗ Error deleting ${sub}: ${err.message}`, 'err');
        }
    }

    // 3. Delete profile/data sub-document
    try {
        await deleteDoc(doc(db, 'organisations', orgId, 'profile', 'data'));
        _dlog('✓ Deleted: profile/data', 'ok');
    } catch { /* non-fatal */ }

    // 4. Delete the top-level organisations/{orgId} document
    try {
        await deleteDoc(doc(db, 'organisations', orgId));
        _dlog('✓ Deleted: org document', 'ok');
    } catch (err) {
        _dlog(`✗ Top-level org doc deletion failed: ${err.message}`, 'err');
        outcome  = 'partial';
        errorMsg = (errorMsg ? errorMsg + ' | ' : '') + `Top-level org doc deletion failed: ${err.message}`;
    }

    // 5. Write activity log
    await writeLog({
        action:  'delete_org',
        orgId,
        orgName: orgData?.orgName ?? orgId,
        detail:  `Org and all data deleted. Manager: ${manager?.email ?? 'unknown'}, UID: ${manager?.uid ?? 'unknown'}.`,
        outcome,
        errorMsg,
    });

    _dlog(`${outcome === 'success' ? '✓' : '⚠'} Done — ${outcome}`, outcome === 'success' ? 'ok' : 'err');
    console.log('LORE admin.js: Org deletion complete:', orgId, outcome);
}

// ---------------------------------------------------------------------------
// Delete a Firebase Auth user via the Cloudflare Worker.
// The Worker uses its service account credentials which have full admin
// authority — unlike the client-side REST API which can only delete the
// currently signed-in user, not arbitrary accounts.
// Treats USER_NOT_FOUND as success — the goal state is achieved either way.
// ---------------------------------------------------------------------------
async function deleteFirebaseAuthUser(uid) {
    const res = await fetch(WORKER_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ mode: 'deleteAuthUser', uid, adminSecret: _adminSecret }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
    }
}

// ---------------------------------------------------------------------------
// Look up a Firebase Auth UID by email address via the Cloudflare Worker.
// The Worker uses its service account credentials (Admin REST API) rather
// than the client-side accounts:lookup endpoint, which requires a scoped
// ID token that does not grant cross-account lookup authority.
// Returns the UID string, or null if no account exists for that email.
// ---------------------------------------------------------------------------
async function lookupUidByEmail(email) {
    const res = await fetch(WORKER_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ mode: 'lookupUidByEmail', email, adminSecret: _adminSecret }),
    });
    const data = await res.json().catch(() => ({}));
    return data.uid ?? null;
}

// =============================================================================
// SECTION 2 — Provision a Manager
// =============================================================================

document.getElementById('provision-submit').addEventListener('click', async () => {
    const orgName     = document.getElementById('p-org-name').value.trim();
    const orgId       = document.getElementById('p-org-id').value.trim();
    const displayName = document.getElementById('p-display-name').value.trim();
    const email       = document.getElementById('p-email').value.trim();
    const industry    = document.getElementById('p-industry').value;
    const roleTitle   = document.getElementById('p-role-title').value.trim();

    if (!orgName || !orgId || !displayName || !email || !industry) {
        showProvisionStatus('Please fill in all required fields.', 'err'); return;
    }
    if (!/^[a-z0-9-]+$/.test(orgId)) {
        showProvisionStatus('Org ID must be lowercase letters, numbers, and hyphens only.', 'err'); return;
    }

    const btn       = document.getElementById('provision-submit');
    const logEl     = document.getElementById('provision-log');
    const resultEl  = document.getElementById('provision-result');
    btn.disabled    = true;
    btn.textContent = 'Creating…';
    resultEl.style.display = 'none';
    logEl.style.display    = 'block';
    logEl.innerHTML        = '';
    clearProvisionStatus();

    const tempPassword = generateTempPassword();

    try {
        // Step 1: Check email does not already exist in Firebase Auth
        provisionLog('Checking email availability…');
        const emailCheck = await checkEmailExists(email);
        if (emailCheck) {
            throw new Error(`The email "${email}" already has a Firebase Auth account. Delete it from Firebase Console or use a different email.`);
        }
        provisionLog('✓ Email available');

        // Step 2: Check org ID does not already exist in Firestore
        provisionLog('Checking org ID availability…');
        const existingOrg = await getDoc(doc(db, 'organisations', orgId));
        if (existingOrg.exists()) {
            throw new Error(`Org ID "${orgId}" is already taken. Choose a different one.`);
        }
        provisionLog('✓ Org ID available');

        // Step 3: Create Firebase Auth account
        provisionLog('Creating Firebase Auth account…');
        const uid = await createFirebaseAuthUser(email, tempPassword);
        provisionLog(`✓ Auth account created — UID: ${uid}`);

        // Step 4: Set custom claims via Worker
        provisionLog('Setting role and org access (may take a few seconds)…');
        await setClaims(uid, orgId, 'manager');
        provisionLog('✓ Claims set — role: manager');

        // Step 5: Write Firestore org documents
        // Write top-level organisations/{orgId} so getDocs can list it
        provisionLog('Writing org to Firestore…');
        await writeOrgDocs(orgId, orgName, industry, 'admin-tool');
        provisionLog('✓ Org documents written');

        // Step 5b: Write provisional domain seeds for the selected industry.
        // Every provisioned org arrives with a starting set of skill areas.
        // The Manager can rename or delete these from the dashboard — they are
        // labelled provisional so it is clear they are not confirmed knowledge.
        // Seeds come from the SEEDS constant at the top of this file.
        const industrySeeds = SEEDS[industry] ?? SEEDS['Other'];
        provisionLog(`Seeding ${industrySeeds.length} provisional domains for industry: ${industry}…`);
        for (const seedName of industrySeeds) {
            try {
                await addDoc(collection(db, 'organisations', orgId, 'domains'), {
                    name:        seedName,
                    description: '',
                    recipeIds:   [],
                    reviewerIds: [],
                    provisional: true,
                    confirmedAt: serverTimestamp(),
                });
            } catch (err) {
                // Non-fatal — a missing seed domain does not block provisioning
                console.warn('LORE admin.js: Could not write provisional domain:', seedName, err);
            }
        }
        provisionLog(`✓ ${industrySeeds.length} provisional domains written`);

        // Step 6: Write manager user document
        provisionLog('Writing manager profile…');
        await setDoc(doc(db, 'organisations', orgId, 'users', uid), {
            displayName,
            email,
            role:      'manager',
            roleTitle: roleTitle || 'Manager',
            orgId,
            createdAt: serverTimestamp(),
        });
        provisionLog('✓ Manager profile written');

        // Step 7: Persist credentials to profile/data so they are retrievable after
        // a page refresh. Stored under orgCredentials — separate from demoCredentials
        // which is only used by the lore-demo seed flow.
        provisionLog('Saving credentials…');
        try {
            await updateDoc(doc(db, 'organisations', orgId, 'profile', 'data'), {
                orgCredentials: {
                    managerEmail:    email,
                    managerPassword: tempPassword,
                    savedAt:         serverTimestamp(),
                },
            });
            provisionLog('✓ Credentials saved');
        } catch (err) {
            // Non-fatal — credentials panel will be empty but the account still works
            console.warn('LORE admin.js: Could not save credentials to profile.', err);
            provisionLog('Could not save credentials (non-fatal)', 'err');
        }

        // Step 8: Write activity log
        await writeLog({
            action:  'provision',
            orgId,
            orgName,
            detail:  `Manager provisioned. Name: ${displayName}, Email: ${email}, UID: ${uid}, Role title: ${roleTitle || 'Manager'}.`,
            outcome: 'success',
            errorMsg: null,
        });

        showProvisionStatus('✓ Manager account ready — see login details below.', 'ok');
        resultEl.style.display = 'block';
        resultEl.innerHTML = `
            <p style="font-weight:600;margin-bottom:var(--space-3);">Send to ${displayName}</p>
            <p><strong>Organisation:</strong> ${orgName}</p>
            <p><strong>Email:</strong> ${email}</p>
            <p style="margin-top:var(--space-3);"><strong>Temporary password:</strong></p>
            <div class="admin-copy-row">
                <input class="input" type="text" value="${tempPassword}" readonly id="copy-pwd" style="font-family:monospace;font-size:var(--text-sm);">
                <button class="btn btn-secondary" id="copy-pwd-btn" style="white-space:nowrap;">Copy</button>
            </div>
            <p style="margin-top:var(--space-3);"><strong>Login URL:</strong></p>
            <div class="admin-copy-row">
                <input class="input" type="text" value="https://lore-platform.github.io/lore/" readonly id="copy-url" style="font-family:monospace;font-size:var(--text-sm);">
                <button class="btn btn-secondary" id="copy-url-btn" style="white-space:nowrap;">Copy</button>
            </div>
            <p class="text-secondary text-xs" style="margin-top:var(--space-3);">UID: ${uid} · Org ID: ${orgId}</p>
        `;
        document.getElementById('copy-pwd-btn').addEventListener('click', () =>
            copyToClipboard(tempPassword, document.getElementById('copy-pwd-btn')));
        document.getElementById('copy-url-btn').addEventListener('click', () =>
            copyToClipboard('https://lore-platform.github.io/lore/', document.getElementById('copy-url-btn')));

        loadOrgList();
        loadActivityLog();

    } catch (err) {
        const msg = err.message ?? 'Something went wrong.';
        provisionLog(`✗ ${msg}`, 'err');
        showProvisionStatus(`✗ ${msg}`, 'err');
        console.error('LORE admin.js: Provision error:', err);

        await writeLog({
            action:  'provision',
            orgId,
            orgName,
            detail:  `Provision attempted for ${email}.`,
            outcome: 'error',
            errorMsg: msg,
        });
    } finally {
        btn.disabled    = false;
        btn.textContent = 'Create Manager account';
    }
}); 

// ---------------------------------------------------------------------------
// Check if an email already exists in Firebase Auth.
// Uses the accounts:createAuthUri endpoint — returns true if email exists.
// ---------------------------------------------------------------------------
async function checkEmailExists(email) {
    const res = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${FIREBASE_API_KEY}`,
        {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ identifier: email, continueUri: 'https://lore-platform.github.io/lore/' }),
        }
    );
    const data = await res.json();
    // allProviders is populated if the email is registered
    return Array.isArray(data.allProviders) && data.allProviders.length > 0;
}

// ---------------------------------------------------------------------------
// Create a Firebase Auth user via REST API.
// Returns the new user's UID or throws.
// ---------------------------------------------------------------------------
async function createFirebaseAuthUser(email, password) {
    const res = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
        {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ email, password, returnSecureToken: true }),
        }
    );
    const data = await res.json();
    if (!data.localId) {
        throw new Error(data.error?.message ?? 'Could not create Firebase Auth account.');
    }
    return data.localId;
}

// ---------------------------------------------------------------------------
// Ping the Worker to wake it before a real call.
// Cloudflare Workers cold-start in ~200–500 ms. Sending a cheap ping first
// ensures the Worker is warm before setClaims is attempted, preventing the
// first real call from timing out on a cold container.
// Does not throw — if ping fails the setClaims call will still be attempted
// and will surface its own error if the Worker is genuinely unreachable.
// ---------------------------------------------------------------------------
async function pingWorker() {
    try {
        await fetch(WORKER_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ mode: 'ping' }),
        });
    } catch {
        // Non-fatal — proceed with setClaims regardless
        console.warn('LORE admin.js: Worker ping failed — proceeding anyway.');
    }
}

// ---------------------------------------------------------------------------
// Set custom claims on a Firebase Auth user via the Cloudflare Worker.
// Pings the Worker first to avoid cold-start timeouts.
// Retries once on 503 (Worker not yet ready) with a 2-second backoff.
// Throws if claims cannot be set — callers must treat this as fatal.
// ---------------------------------------------------------------------------
async function setClaims(uid, orgId, role) {
    // Wake the Worker before the real call
    await pingWorker();

    const attempt = async () => {
        const res = await fetch(WORKER_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ mode: 'setClaims', uid, orgId, role, adminSecret: _adminSecret }),
        });
        return res;
    };

    let res;
    try {
        res = await attempt();
    } catch (fetchErr) {
        throw new Error(
            `Could not reach the Worker to set claims. Check the Worker is deployed. ` +
            `Set claims manually in Firebase Console: uid=${uid}, orgId=${orgId}, role=${role}.`
        );
    }

    // On 503, wait 2 seconds and retry once — Worker may still be starting
    if (res.status === 503) {
        console.warn('LORE admin.js: Worker returned 503 on setClaims — retrying after 2 s.');
        await new Promise(resolve => setTimeout(resolve, 2000));
        try {
            res = await attempt();
        } catch (fetchErr) {
            throw new Error(
                `Worker returned 503 and retry also failed. ` +
                `Set claims manually: uid=${uid}, orgId=${orgId}, role=${role}.`
            );
        }
    }

    let data;
    try {
        data = await res.json();
    } catch {
        throw new Error(`Worker returned an unparseable response (HTTP ${res.status}). Set claims manually: uid=${uid}, orgId=${orgId}, role=${role}.`);
    }

    if (!data.ok) {
        throw new Error(
            `Worker rejected claims request: ${data.error ?? 'unknown error'}. ` +
            `Set claims manually: uid=${uid}, orgId=${orgId}, role=${role}.`
        );
    }
}

// ---------------------------------------------------------------------------
// Write both org Firestore documents for a given orgId.
// ALWAYS writes both:
//   organisations/{orgId}              — top-level doc, required for getDocs listing
//   organisations/{orgId}/profile/data — sub-doc, read by dashboard.js and domains.js
// Never write one without the other.
// ---------------------------------------------------------------------------
async function writeOrgDocs(orgId, orgName, industry, provisionedBy) {
    const payload = { orgName, industry, createdAt: serverTimestamp(), provisionedBy };
    await setDoc(doc(db, 'organisations', orgId), payload);
    await setDoc(doc(db, 'organisations', orgId, 'profile', 'data'), payload);
}

// ---------------------------------------------------------------------------
// Provision status helpers
// ---------------------------------------------------------------------------
function showProvisionStatus(msg, type) {
    const el = document.getElementById('provision-status');
    el.textContent = msg;
    el.style.display = 'block';
    el.style.backgroundColor = type === 'ok'
        ? 'rgba(61,139,110,0.08)' : 'rgba(184,50,50,0.08)';
    el.style.color = type === 'ok' ? 'var(--sage)' : 'var(--error)';
}

function clearProvisionStatus() {
    const el = document.getElementById('provision-status');
    el.textContent  = '';
    el.style.display = 'none';
}

function provisionLog(msg, type = '') {
    appendLog('provision-log', msg, type);
}

// =============================================================================
// SECTION 3 — Demo data (Meridian Advisory)
// =============================================================================

document.getElementById('demo-seed-btn').addEventListener('click', async () => {
    const seedOk = await showConfirm(
        'Provision + Seed demo?',
        'This will provision the Meridian Advisory demo Manager account and seed all demo data.\n\nRun Reset first if you have seeded before.',
        { confirmLabel: 'Provision + Seed' }
    );
    if (!seedOk) return;
    await runDemoSeedFlow();
});

document.getElementById('demo-reset-btn').addEventListener('click', async () => {
    const resetOk = await showConfirm(
        'Reset demo data?',
        'This deletes ALL data for the lore-demo org, including all Firestore data and the Manager, Employee, and Reviewer Auth accounts. Cannot be undone.',
        { confirmLabel: 'Reset', dangerConfirm: true }
    );
    if (!resetOk) return;
    await runDemoReset();
});

// ---------------------------------------------------------------------------
// Full demo flow: provision Manager + seed all data sequentially.
// ---------------------------------------------------------------------------
async function runDemoSeedFlow() {
    const seedBtn  = document.getElementById('demo-seed-btn');
    const resetBtn = document.getElementById('demo-reset-btn');
    const logEl    = document.getElementById('demo-log');
    seedBtn.disabled  = true; seedBtn.textContent  = 'Working…';
    resetBtn.disabled = true;
    logEl.style.display = 'block'; logEl.innerHTML = '';

    // Total steps: provision (6) + 1 org profile + 5 domains + 25 recipes
    // (each with 3 scenarios counted within) + 8 employees + 3 contributions + 1 reviewer
    const TOTAL = 6 + 1 + 5 + 25 + 8 + 3 + 1 + 4; // +4: employee Auth+claims, reviewer Auth+claims
    initDemoProgress(TOTAL);
    clearDemoStatus();

    try {
        // ----- Provision -----
        demoLog('Step 1: Provisioning demo Manager account…');

        demoLog('Checking email availability…');
        const emailExists = await checkEmailExists(DEMO.managerEmail);
        if (emailExists) {
            throw new Error(
                `Email "${DEMO.managerEmail}" already has a Firebase Auth account. ` +
                `Run Reset first, or delete the account manually in Firebase Console.`
            );
        }
        demoTick('Email available');

        demoLog('Checking org ID availability…');
        const existingOrg = await getDoc(doc(db, 'organisations', DEMO.orgId));
        if (existingOrg.exists()) {
            throw new Error(
                `Org "${DEMO.orgId}" already exists in Firestore. Run Reset first.`
            );
        }
        demoTick('Org ID available');

        demoLog('Creating Firebase Auth account…');
        const tempPassword = generateTempPassword();
        const uid = await createFirebaseAuthUser(DEMO.managerEmail, tempPassword);
        demoTick(`Auth account created — UID: ${uid}`);

        demoLog('Setting claims…');
        await setClaims(uid, DEMO.orgId, 'manager');
        demoTick('Claims set');

        demoLog('Writing org to Firestore…');
        await writeOrgDocs(DEMO.orgId, DEMO.orgName, DEMO.industry, 'seed-tool');
        demoTick('Org documents written');

        demoLog('Writing manager profile…');
        await setDoc(doc(db, 'organisations', DEMO.orgId, 'users', uid), {
            displayName: DEMO.managerName,
            email:       DEMO.managerEmail,
            role:        'manager',
            roleTitle:   DEMO.roleTitle,
            orgId:       DEMO.orgId,
            createdAt:   serverTimestamp(),
        });
        demoTick('Manager profile written');

        // Show login details now — before seeding — so they are not lost if a later
        // seed step fails. The status bar will be updated again when seeding completes.
        showDemoStatus(
            `Manager account ready — seeding data now… Email: ${DEMO.managerEmail} · Password: ${tempPassword}`,
            'ok'
        );

        // ----- Seed -----
        demoLog('Step 2: Seeding demo data…');

        // Domains
        demoLog('Writing domains…');
        const domainIds = [];
        for (const domain of DEMO_DOMAINS) {
            const ref = await addDoc(collection(db, 'organisations', DEMO.orgId, 'domains'), {
                name:        domain.name,
                description: domain.description,
                recipeIds:   [],
                reviewerIds: [],
                provisional: false,
                confirmedAt: serverTimestamp(),
            });
            domainIds.push(ref.id);
            demoTick(`Domain: ${domain.name}`);
        }

        // Recipes + scenarios (3 per recipe)
        demoLog('Writing recipes and scenarios…');
        for (let i = 0; i < DEMO_RECIPES.length; i++) {
            const recipe    = DEMO_RECIPES[i];
            const recipeRef = await addDoc(collection(db, 'organisations', DEMO.orgId, 'recipes'), {
                skillName:      recipe.skillName,
                trigger:        recipe.trigger,
                actionSequence: recipe.actionSequence,
                expectedOutcome:recipe.expectedOutcome,
                flawPattern:    recipe.flawPattern ?? null,
                domain:         recipe.domain,
                sourceType:     'demo',
                approved:       true,
                approvedAt:     serverTimestamp(),
            });
            const scenarios = generateDemoScenarios(recipe, recipeRef.id);
            for (const s of scenarios) {
                await addDoc(collection(db, 'organisations', DEMO.orgId, 'scenarios'), {
                    ...s, generatedAt: serverTimestamp(),
                });
            }
            demoTick(`Recipe ${i + 1}/${DEMO_RECIPES.length}: ${recipe.skillName}`);
        }

        // Employees + pattern signals
        demoLog('Writing employees and training history…');
        for (const emp of DEMO_EMPLOYEES) {
            const mastery = simulateMastery(emp.profile);
            const signals = simulateSignals(emp);
            const lastMs  = Date.now() - emp.lastActiveDaysAgo * 24 * 60 * 60 * 1000;
            await setDoc(doc(db, 'organisations', DEMO.orgId, 'users', emp.uid), {
                displayName:   emp.displayName,
                email:         emp.email,
                role:          'employee',
                roleTitle:     emp.roleTitle,
                seniority:     emp.seniority,
                orgId:         DEMO.orgId,
                xp:            emp.xp,
                streak:        emp.streak,
                sessionsTotal: emp.sessionsTotal,
                domainMastery: mastery,
                lastTrainedAt: Timestamp.fromMillis(lastMs),
                createdAt:     Timestamp.fromMillis(Date.now() - 12 * 7 * 24 * 60 * 60 * 1000),
                isDemo:        true,
            });
            for (const signal of signals) {
                await addDoc(collection(db, 'organisations', DEMO.orgId, 'users', emp.uid, 'patternSignals'), signal);
            }
            demoTick(`Employee: ${emp.displayName} (${signals.length} signals)`);
        }

        // Reviewer contributions (extractions)
        demoLog('Writing Reviewer contributions…');
        for (const c of DEMO_REVIEWER_CONTRIBUTIONS) {
            await addDoc(collection(db, 'organisations', DEMO.orgId, 'extractions'), {
                sourceType:  c.sourceType,
                rawContent:  c.rawContent,
                contextNote: c.contextNote,
                status:      'processed',
                draft:       c.draft,
                reviewerId:  'demo-reviewer-001',
                createdAt:   Timestamp.fromMillis(Date.now() - 3 * 24 * 60 * 60 * 1000),
                processedAt: Timestamp.fromMillis(Date.now() - 2 * 24 * 60 * 60 * 1000),
            });
            demoTick(`Contribution: ${c.sourceType}`);
        }

        // Simulated Reviewer doc — backs dashboard stats, no Auth account
        demoLog('Writing simulated Reviewer user…');
        await setDoc(doc(db, 'organisations', DEMO.orgId, 'users', 'demo-reviewer-001'), {
            displayName: 'Marcus Obi',
            email:       'marcus@meridian-demo.co',
            role:        'reviewer',
            roleTitle:   'Director of Client Services',
            seniority:   'senior',
            orgId:       DEMO.orgId,
            createdAt:   serverTimestamp(),
            isDemo:      true,
        });
        demoTick('Simulated Reviewer: Marcus Obi');

        // ---------------------------------------------------------------------------
        // Interactive demo accounts — real Firebase Auth accounts so anyone can
        // sign in and experience the Employee and Reviewer views directly.
        // ---------------------------------------------------------------------------
        const demoPassword = 'MeridianDemo2026!';

        demoLog('Creating interactive Employee Auth account…');
        let empUid;
        try {
            empUid = await createFirebaseAuthUser(DEMO.employeeEmail, demoPassword);
            demoTick(`Employee Auth account created — UID: ${empUid}`);
        } catch (err) {
            throw new Error(`Could not create Employee Auth account: ${err.message}`);
        }

        demoLog('Setting Employee claims…');
        await setClaims(empUid, DEMO.orgId, 'employee');
        demoTick('Employee claims set');

        await setDoc(doc(db, 'organisations', DEMO.orgId, 'users', empUid), {
            displayName:   DEMO.employeeName,
            email:         DEMO.employeeEmail,
            role:          'employee',
            roleTitle:     'Consultant',
            seniority:     'junior',
            orgId:         DEMO.orgId,
            xp:            0,
            streak:        0,
            sessionsTotal: 0,
            domainMastery: {},
            lastTrainedAt: null,
            createdAt:     serverTimestamp(),
            isDemo:        true,
            isInteractive: true,
        });

        demoLog('Creating interactive Reviewer Auth account…');
        let revUid;
        try {
            revUid = await createFirebaseAuthUser(DEMO.reviewerEmail, demoPassword);
            demoTick(`Reviewer Auth account created — UID: ${revUid}`);
        } catch (err) {
            throw new Error(`Could not create Reviewer Auth account: ${err.message}`);
        }

        demoLog('Setting Reviewer claims…');
        await setClaims(revUid, DEMO.orgId, 'reviewer');
        demoTick('Reviewer claims set');

        await setDoc(doc(db, 'organisations', DEMO.orgId, 'users', revUid), {
            displayName:   DEMO.reviewerName,
            email:         DEMO.reviewerEmail,
            role:          'reviewer',
            roleTitle:     'Senior Consultant',
            seniority:     'senior',
            orgId:         DEMO.orgId,
            createdAt:     serverTimestamp(),
            isDemo:        true,
            isInteractive: true,
        });

        // Seed two pending tasks for the interactive Reviewer
        await addDoc(collection(db, 'organisations', DEMO.orgId, 'users', revUid, 'tasks'), {
            type:         'scenario_review',
            status:       'pending',
            scenarioText: `You are two weeks into an operational transformation engagement. In the first client meeting, the Operations Director brought six members of his team and spent the first 30 minutes describing everything the previous consultants had recommended that hadn't worked. The CFO asked several questions about what was and wasn't in scope. Does this feel like a situation your team actually encounters?`,
            createdAt:    serverTimestamp(),
        });
        await addDoc(collection(db, 'organisations', DEMO.orgId, 'users', revUid, 'tasks'), {
            type:             'mentorship_note',
            status:           'pending',
            scenarioText:     'A client sponsor has become harder to reach. Calls get rescheduled. Responses are slower than usual. What would be the right move at this point in the engagement?',
            employeeResponse: 'I would send a detailed status update email to keep them informed and show we are making progress.',
            createdAt:        serverTimestamp(),
        });

        await writeLog({
            action:  'seed',
            orgId:   DEMO.orgId,
            orgName: DEMO.orgName,
            detail:  `Demo data seeded. Manager UID: ${uid}. Employee UID: ${empUid}. Reviewer UID: ${revUid}. ${DEMO_RECIPES.length} recipes, ${DEMO_EMPLOYEES.length} simulated employees.`,
            outcome: 'success',
            errorMsg: null,
        });

        demoLog('✓ All done — demo fully seeded.', 'ok');
        // Write all credentials into profile/data — retrieved by loadDemoCreds() and
        // shown in the org list creds panel via orgCredentials field.
        await updateDoc(doc(db, 'organisations', DEMO.orgId, 'profile', 'data'), {
            demoCredentials: {
                url:             'https://lore-platform.github.io/lore/',
                seededAt:        serverTimestamp(),
                managerEmail:    DEMO.managerEmail,
                managerPassword: tempPassword,
                employeeEmail:   DEMO.employeeEmail,
                reviewerEmail:   DEMO.reviewerEmail,
                sharedPassword:  demoPassword,
            },
            // Also write orgCredentials so the org list panel shows Manager creds
            orgCredentials: {
                managerEmail:    DEMO.managerEmail,
                managerPassword: tempPassword,
                savedAt:         serverTimestamp(),
            },
        });

        demoLog('✓ All done — demo fully seeded.');
        showDemoStatus(
            `✓ Demo seeded. Manager: ${DEMO.managerEmail} · Employee: ${DEMO.employeeEmail} · Reviewer: ${DEMO.reviewerEmail} · Shared password (Employee & Reviewer): ${demoPassword}`,
            'ok'
        );
        await loadDemoCreds();
        loadOrgList();
        loadActivityLog();

    } catch (err) {
        const msg = err.message ?? 'Something went wrong.';
        demoLog(`✗ ${msg}`, 'err');
        showDemoStatus(`✗ ${msg}`, 'err');
        console.error('LORE admin.js: Demo seed error:', err);
        await writeLog({
            action:  'seed',
            orgId:   DEMO.orgId,
            orgName: DEMO.orgName,
            detail:  'Demo seed attempted.',
            outcome: 'error',
            errorMsg: msg,
        });
    } finally {
        seedBtn.disabled  = false; seedBtn.textContent  = 'Provision + Seed demo';
        resetBtn.disabled = false;
    }
}

// ---------------------------------------------------------------------------
// Reset demo — wipes all Firestore data and the Manager's Auth account.
// ---------------------------------------------------------------------------
async function runDemoReset() {
    const seedBtn  = document.getElementById('demo-seed-btn');
    const resetBtn = document.getElementById('demo-reset-btn');
    const logEl    = document.getElementById('demo-log');
    seedBtn.disabled  = true;
    resetBtn.disabled = true; resetBtn.textContent = 'Resetting…';
    logEl.style.display = 'block'; logEl.innerHTML = '';
    clearDemoStatus();

    const subCollections = ['users', 'recipes', 'scenarios', 'extractions', 'domains'];
    // +3 = one per Auth account (Manager, Employee, Reviewer) + profile/data + top-level doc
    initDemoProgress(3 + subCollections.length + 2);

    demoLog('Starting reset for org: ' + DEMO.orgId);

    // 1. Delete Firebase Auth accounts for Manager, Employee, and Reviewer.
    // For each: look in Firestore first (by email), then fall back to Worker email lookup.
    const authAccounts = [
        { label: 'Manager',  email: DEMO.managerEmail  },
        { label: 'Employee', email: DEMO.employeeEmail },
        { label: 'Reviewer', email: DEMO.reviewerEmail },
    ];

    // Fetch users sub-collection once for all three lookups
    let usersSnapForReset;
    try {
        usersSnapForReset = await getDocs(collection(db, 'organisations', DEMO.orgId, 'users'));
    } catch {
        usersSnapForReset = { docs: [] };
    }

    for (const account of authAccounts) {
        try {
            let accountUid = null;
            const exactDoc = usersSnapForReset.docs.find(d => d.data().email === account.email);
            if (exactDoc) accountUid = exactDoc.id;
            if (!accountUid) accountUid = await lookupUidByEmail(account.email);

            if (accountUid) {
                await deleteFirebaseAuthUser(accountUid);
                demoTick(`Deleted: ${account.label} Auth account (UID: ${accountUid})`);
            } else {
                demoTick(`No ${account.label} Auth account found — skipped`);
            }
        } catch (err) {
            demoLog(`Could not delete ${account.label} Auth account: ${err.message}`, 'err');
            demoTick(`${account.label} Auth — error (see above)`);
        }
    }

    // 2. Delete sub-collections
    for (const sub of subCollections) {
        try {
            const snap = await getDocs(collection(db, 'organisations', DEMO.orgId, sub));
            if (sub === 'users') {
                for (const userDoc of snap.docs) {
                    for (const userSub of ['patternSignals', 'recipeLibrary', 'tasks']) {
                        try {
                            const subSnap = await getDocs(collection(db, 'organisations', DEMO.orgId, 'users', userDoc.id, userSub));
                            for (const sd of subSnap.docs) await deleteDoc(sd.ref);
                        } catch { /* non-fatal */ }
                    }
                    await deleteDoc(userDoc.ref);
                }
            } else {
                for (const d of snap.docs) await deleteDoc(d.ref);
            }
            demoTick(`Deleted: ${sub} (${snap.size} docs)`);
        } catch (err) {
            demoLog(`Error deleting ${sub}: ${err.message}`, 'err');
            demoTick(`${sub} — error (see above)`);
        }
    }

    // 3. Delete profile/data sub-document
    try {
        await deleteDoc(doc(db, 'organisations', DEMO.orgId, 'profile', 'data'));
        demoTick('Deleted: profile/data');
    } catch (err) {
        demoLog(`Error deleting profile/data: ${err.message}`, 'err');
        demoTick('profile/data — error (see above)');
    }

    // 4. Delete top-level org document
    try {
        await deleteDoc(doc(db, 'organisations', DEMO.orgId));
        demoTick('Deleted: top-level org document');
    } catch (err) {
        demoLog(`Error deleting top-level org doc: ${err.message}`, 'err');
        demoTick('org document — error (see above)');
    }

    await writeLog({
        action:  'reset_seed',
        orgId:   DEMO.orgId,
        orgName: DEMO.orgName,
        detail:  'Demo data reset. All Firestore data and Manager Auth account deleted.',
        outcome: 'success',
        errorMsg: null,
    });

    demoLog('✓ Reset complete — all demo data cleared.', 'ok');
    showDemoStatus('Demo data reset. Run "Provision + Seed demo" to repopulate.', 'ok');
    await loadDemoCreds();
    loadOrgList();
    loadActivityLog();

    seedBtn.disabled  = false;
    resetBtn.disabled = false; resetBtn.textContent = 'Reset demo data';
}

// ---------------------------------------------------------------------------
// Demo progress and log helpers
// ---------------------------------------------------------------------------
let _demoTotal = 0;
let _demoDone  = 0;

function initDemoProgress(total) {
    _demoTotal = total; _demoDone = 0;
    const track = document.getElementById('demo-progress-track');
    const fill  = document.getElementById('demo-progress-fill');
    track.style.display    = 'block';
    fill.style.width       = '0%';
    const logEl = document.getElementById('demo-log');
    logEl.style.display    = 'block';
    logEl.innerHTML        = '';
}

function demoTick(msg) {
    _demoDone++;
    const pct = Math.round((_demoDone / _demoTotal) * 100);
    document.getElementById('demo-progress-fill').style.width = pct + '%';
    demoLog('✓ ' + msg, 'ok');
}

function demoLog(msg, type = '') { appendLog('demo-log', msg, type); }

// ---------------------------------------------------------------------------
// Load and render the demo credentials panel from Firestore.
// Reads from organisations/lore-demo/profile/data.demoCredentials.
// Works from any machine — no localStorage involved.
// Shows nothing if the field is absent (i.e. before first seed or after reset).
// ---------------------------------------------------------------------------
async function loadDemoCreds() {
    const container = document.getElementById('demo-creds-panel');
    if (!container) return;

    try {
        const snap  = await getDoc(doc(db, 'organisations', DEMO.orgId, 'profile', 'data'));
        const creds = snap.exists() ? (snap.data().demoCredentials ?? null) : null;

        if (!creds) { container.innerHTML = ''; return; }

        const seededAt = creds.seededAt?.toDate
            ? creds.seededAt.toDate().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
            : 'recently';

        // Support both old schema (email/password) and new schema (three accounts)
        const isNewSchema = !!(creds.managerEmail);

        container.innerHTML = `
            <div style="margin-top:var(--space-4);padding:var(--space-4);background:var(--surface-2,#f5f0eb);border-radius:var(--radius-md,8px);border:1px solid var(--border,rgba(0,0,0,0.08));">
                <p class="label" style="margin-bottom:var(--space-3);font-size:var(--text-sm);">Demo sign-in details</p>
                <p class="text-sm" style="margin-bottom:var(--space-3);">
                    <span style="color:var(--warm-grey);">URL</span>&ensp;
                    <a href="${creds.url}" target="_blank" style="color:var(--ember);">${creds.url}</a>
                </p>
                ${isNewSchema ? `
                <table style="width:100%;border-collapse:collapse;font-size:var(--text-sm);margin-bottom:var(--space-3);">
                    <thead><tr style="border-bottom:1px solid rgba(44,36,22,0.1);">
                        <th style="text-align:left;padding:2px var(--space-2) var(--space-2) 0;color:var(--warm-grey);font-weight:500;">Role</th>
                        <th style="text-align:left;padding:2px var(--space-2) var(--space-2);color:var(--warm-grey);font-weight:500;">Email</th>
                        <th style="text-align:left;padding:2px 0 var(--space-2) var(--space-2);color:var(--warm-grey);font-weight:500;">Password</th>
                    </tr></thead>
                    <tbody>
                        <tr style="border-bottom:1px solid rgba(44,36,22,0.05);">
                            <td style="padding:var(--space-2) var(--space-2) var(--space-2) 0;font-weight:500;">Manager</td>
                            <td style="padding:var(--space-2);"><code style="user-select:all;">${creds.managerEmail}</code></td>
                            <td style="padding:var(--space-2) 0 var(--space-2) var(--space-2);"><code style="user-select:all;">${creds.managerPassword}</code></td>
                        </tr>
                        <tr style="border-bottom:1px solid rgba(44,36,22,0.05);">
                            <td style="padding:var(--space-2) var(--space-2) var(--space-2) 0;font-weight:500;">Employee</td>
                            <td style="padding:var(--space-2);"><code style="user-select:all;">${creds.employeeEmail}</code></td>
                            <td style="padding:var(--space-2) 0 var(--space-2) var(--space-2);"><code style="user-select:all;">${creds.sharedPassword}</code></td>
                        </tr>
                        <tr>
                            <td style="padding:var(--space-2) var(--space-2) var(--space-2) 0;font-weight:500;">Reviewer</td>
                            <td style="padding:var(--space-2);"><code style="user-select:all;">${creds.reviewerEmail}</code></td>
                            <td style="padding:var(--space-2) 0 var(--space-2) var(--space-2);"><code style="user-select:all;">${creds.sharedPassword}</code></td>
                        </tr>
                    </tbody>
                </table>
                ` : `
                <p class="text-sm" style="margin-bottom:var(--space-2);">
                    <span style="color:var(--warm-grey);">Email</span>&ensp;<code style="user-select:all;">${creds.email}</code>
                </p>
                <p class="text-sm" style="margin-bottom:var(--space-3);">
                    <span style="color:var(--warm-grey);">Password</span>&ensp;<code style="user-select:all;">${creds.password}</code>
                </p>`}
                <p class="text-xs" style="color:var(--warm-grey);">Seeded ${seededAt}. Cleared automatically on Reset.</p>
            </div>
        `;
    } catch (err) {
        console.warn('LORE admin.js: Could not load demo credentials.', err);
        container.innerHTML = '';
    }
}

function showDemoStatus(msg, type) {
    const el = document.getElementById('demo-status');
    el.textContent  = msg;
    el.style.display = 'block';
    el.style.backgroundColor = type === 'ok'
        ? 'rgba(61,139,110,0.08)' : 'rgba(184,50,50,0.08)';
    el.style.color   = type === 'ok' ? 'var(--sage)' : 'var(--error)';
}

function clearDemoStatus() {
    const el = document.getElementById('demo-status');
    el.textContent   = '';
    el.style.display = 'none';
}

// =============================================================================
// SECTION 4 — Activity log (paginated, filterable by date, deleteable)
// =============================================================================

document.getElementById('refresh-logs').addEventListener('click', () => {
    _logPage   = 1;
    _logLastDoc = null;
    loadActivityLog(true);
});

// Render the log controls (filter + delete) above the list
function renderLogControls() {
    const section = document.getElementById('activity-log-list').parentElement;
    let controls  = document.getElementById('log-controls');
    if (controls) return; // already rendered

    controls = document.createElement('div');
    controls.id = 'log-controls';
    controls.style.cssText = 'display:flex;flex-wrap:wrap;gap:var(--space-3);align-items:center;margin-bottom:var(--space-4);';
    controls.innerHTML = `
        <div style="display:flex;gap:var(--space-2);align-items:center;">
            <label class="label" style="margin:0;white-space:nowrap;">Filter by date</label>
            <input type="date" id="log-date-filter" class="input" style="font-size:var(--text-sm);padding:var(--space-1) var(--space-2);width:auto;">
            <button class="btn btn-secondary" id="log-filter-apply" style="font-size:var(--text-sm);padding:var(--space-1) var(--space-3);">Apply</button>
            <button class="btn btn-secondary" id="log-filter-clear" style="font-size:var(--text-sm);padding:var(--space-1) var(--space-3);color:var(--warm-grey);">Clear</button>
        </div>
        <div style="margin-left:auto;">
            <button class="btn btn-secondary" id="log-delete-period" style="font-size:var(--text-sm);padding:var(--space-1) var(--space-3);color:var(--error);border-color:rgba(184,50,50,0.3);">
                Delete entries in filter period
            </button>
        </div>
    `;

    // Insert before the list
    const listEl = document.getElementById('activity-log-list');
    section.insertBefore(controls, listEl);

    document.getElementById('log-filter-apply')?.addEventListener('click', () => {
        _logFilter  = document.getElementById('log-date-filter')?.value ?? '';
        _logPage    = 1;
        _logLastDoc = null;
        loadActivityLog(true);
    });

    document.getElementById('log-filter-clear')?.addEventListener('click', () => {
        _logFilter  = '';
        _logPage    = 1;
        _logLastDoc = null;
        const dateInput = document.getElementById('log-date-filter');
        if (dateInput) dateInput.value = '';
        loadActivityLog(true);
    });

    document.getElementById('log-delete-period')?.addEventListener('click', deleteLogEntries);
}

async function loadActivityLog(resetPagination = false) {
    renderLogControls();

    const listEl = document.getElementById('activity-log-list');
    listEl.innerHTML = '<p class="text-secondary text-sm">Loading…</p>';

    if (resetPagination) {
        _logPage    = 1;
        _logLastDoc = null;
    }

    try {
        // Build the query. Firestore cursor pagination: use startAfter when on
        // page > 1 and we have a cursor doc from the previous page load.
        let constraints = [
            orderBy('createdAt', 'desc'),
        ];

        // Date filter — converts the selected date to start/end of day timestamps
        if (_logFilter) {
            const dayStart = new Date(_logFilter + 'T00:00:00');
            const dayEnd   = new Date(_logFilter + 'T23:59:59.999');
            constraints.push(where('createdAt', '>=', Timestamp.fromDate(dayStart)));
            constraints.push(where('createdAt', '<=', Timestamp.fromDate(dayEnd)));
        }

        if (_logLastDoc && _logPage > 1) {
            constraints.push(startAfter(_logLastDoc));
        }

        constraints.push(limit(LOG_PAGE_SIZE));

        const q    = query(collection(db, 'platform', 'lore-platform', 'adminLogs'), ...constraints);
        const snap = await getDocs(q);

        if (snap.empty && _logPage === 1) {
            listEl.innerHTML = '<p class="text-secondary text-sm">No activity yet' + (_logFilter ? ' for this date.' : '.') + '</p>';
            _renderLogPagination(false, false);
            return;
        }

        if (snap.empty) {
            // Past end of results — step back
            _logPage = Math.max(1, _logPage - 1);
            listEl.innerHTML = '<p class="text-secondary text-sm">No more entries.</p>';
            _renderLogPagination(true, false);
            return;
        }

        _logLastDoc = snap.docs[snap.docs.length - 1];

        listEl.innerHTML = snap.docs.map(logDoc => {
            const d   = logDoc.data();
            const ts  = d.createdAt ? new Date(d.createdAt.toDate()).toLocaleString('en-GB', {
                day: 'numeric', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit',
            }) : '—';
            const outcomeColour = d.outcome === 'success'
                ? 'var(--sage)' : d.outcome === 'partial'
                ? 'var(--amber-text)' : 'var(--error)';
            return `
                <div class="admin-log-row">
                    <div class="admin-log-meta">
                        <span class="admin-log-action">${formatAction(d.action)}</span>
                        <span class="admin-log-org">${d.orgName ?? d.orgId ?? '—'}</span>
                        <span class="admin-log-outcome" style="color:${outcomeColour};">${d.outcome ?? '—'}</span>
                        <span class="admin-log-time">${ts}</span>
                    </div>
                    <p class="admin-log-detail">${d.detail ?? ''}</p>
                    ${d.errorMsg ? `<p class="admin-log-error">Error: ${d.errorMsg}</p>` : ''}
                </div>
            `;
        }).join('');

        const hasPrev = _logPage > 1;
        const hasNext = snap.size === LOG_PAGE_SIZE;
        _renderLogPagination(hasPrev, hasNext);

    } catch (err) {
        console.error('LORE admin.js: loadActivityLog error:', err);
        listEl.innerHTML = `<p style="color:var(--error);font-size:var(--text-sm);">Could not load activity log: ${err.message}</p>`;
    }
}

function _renderLogPagination(hasPrev, hasNext) {
    let pag = document.getElementById('log-pagination');
    if (!pag) {
        pag = document.createElement('div');
        pag.id = 'log-pagination';
        pag.style.cssText = 'display:flex;gap:var(--space-3);align-items:center;margin-top:var(--space-4);justify-content:space-between;';
        document.getElementById('activity-log-list').after(pag);
    }

    pag.innerHTML = `
        <button class="btn btn-secondary" id="log-prev" style="font-size:var(--text-sm);padding:var(--space-1) var(--space-3);" ${hasPrev ? '' : 'disabled'}>← Previous</button>
        <span class="text-xs text-secondary">Page ${_logPage}</span>
        <button class="btn btn-secondary" id="log-next" style="font-size:var(--text-sm);padding:var(--space-1) var(--space-3);" ${hasNext ? '' : 'disabled'}>Next →</button>
    `;

    document.getElementById('log-prev')?.addEventListener('click', () => {
        if (_logPage <= 1) return;
        _logPage--;
        _logLastDoc = null; // reset cursor — reload from start up to current page
        // Simple approach: reload from page 1 and advance. For 10-per-page this is fast.
        _loadLogPage(_logPage);
    });

    document.getElementById('log-next')?.addEventListener('click', () => {
        _logPage++;
        loadActivityLog(false);
    });
}

// Load a specific page by re-fetching from the beginning (offset simulation).
// Only used for Prev button — acceptable since we have small page counts.
async function _loadLogPage(targetPage) {
    _logPage    = 1;
    _logLastDoc = null;
    // Walk forward page by page until we reach the target
    while (_logPage < targetPage) {
        let constraints = [orderBy('createdAt', 'desc')];
        if (_logFilter) {
            const dayStart = new Date(_logFilter + 'T00:00:00');
            const dayEnd   = new Date(_logFilter + 'T23:59:59.999');
            constraints.push(where('createdAt', '>=', Timestamp.fromDate(dayStart)));
            constraints.push(where('createdAt', '<=', Timestamp.fromDate(dayEnd)));
        }
        if (_logLastDoc) constraints.push(startAfter(_logLastDoc));
        constraints.push(limit(LOG_PAGE_SIZE));
        try {
            const snap = await getDocs(query(collection(db, 'platform', 'lore-platform', 'adminLogs'), ...constraints));
            if (snap.empty) break;
            _logLastDoc = snap.docs[snap.docs.length - 1];
            _logPage++;
        } catch { break; }
    }
    loadActivityLog(false);
}

// Delete all log entries in the currently selected filter period (or all if no filter).
async function deleteLogEntries() {
    const periodLabel = _logFilter ? `on ${_logFilter}` : 'all time';
    const deleteOk = await showConfirm(
        'Delete log entries?',
        `Delete all activity log entries for ${periodLabel}? This cannot be undone.`,
        { confirmLabel: 'Delete entries', dangerConfirm: true }
    );
    if (!deleteOk) return;

    const listEl = document.getElementById('activity-log-list');
    listEl.innerHTML = '<p class="text-secondary text-sm">Deleting…</p>';

    try {
        // Fetch all matching docs (no pagination — we are deleting all of them)
        let constraints = [orderBy('createdAt', 'desc')];
        if (_logFilter) {
            const dayStart = new Date(_logFilter + 'T00:00:00');
            const dayEnd   = new Date(_logFilter + 'T23:59:59.999');
            constraints.push(where('createdAt', '>=', Timestamp.fromDate(dayStart)));
            constraints.push(where('createdAt', '<=', Timestamp.fromDate(dayEnd)));
        }
        // Firestore limit for safety — if someone somehow has 500+ logs, this handles it
        constraints.push(limit(500));
        const snap = await getDocs(query(collection(db, 'platform', 'lore-platform', 'adminLogs'), ...constraints));

        for (const d of snap.docs) await deleteDoc(d.ref);

        listEl.innerHTML = `<p class="text-secondary text-sm">${snap.size} entries deleted.</p>`;
        _logPage    = 1;
        _logLastDoc = null;
        setTimeout(() => loadActivityLog(true), 1200);

    } catch (err) {
        console.error('LORE admin.js: deleteLogEntries error:', err);
        listEl.innerHTML = `<p style="color:var(--error);font-size:var(--text-sm);">Could not delete entries: ${err.message}</p>`;
    }
}

function formatAction(action) {
    return {
        provision:   'Provision',
        delete_org:  'Delete org',
        seed:        'Seed demo',
        reset_seed:  'Reset demo',
    }[action] ?? action;
}

// ---------------------------------------------------------------------------
// Write an entry to the Firestore adminLogs collection.
// Called after every admin action — success or failure.
// ---------------------------------------------------------------------------
async function writeLog({ action, orgId, orgName, detail, outcome, errorMsg }) {
    try {
        await addDoc(collection(db, 'platform', 'lore-platform', 'adminLogs'), {
            action,
            orgId:       orgId    ?? null,
            orgName:     orgName  ?? null,
            detail:      detail   ?? null,
            outcome,
            errorMsg:    errorMsg ?? null,
            performedBy: _adminEmail ?? 'unknown',
            createdAt:   serverTimestamp(),
        });
    } catch (err) {
        // Non-fatal — log to console but do not surface to user
        console.warn('LORE admin.js: Could not write activity log entry.', err);
    }
}

// =============================================================================
// Shared log panel helper
// =============================================================================
function appendLog(elementId, msg, type = '') {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.style.display = 'block';
    const line = document.createElement('div');
    line.className   = type === 'ok' ? 'admin-log-ok' : type === 'err' ? 'admin-log-err' : '';
    line.textContent = msg;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
}

// =============================================================================
// DEMO DATA DEFINITIONS
// Exact same dataset as seed-demo.html — single source of truth here.
// =============================================================================

const DEMO_DOMAINS = [
    { name: 'Design Practice',      description: 'How we approach and deliver design work' },
    { name: 'Business Development', description: 'Growing client relationships and winning work' },
    { name: 'Market Intelligence',  description: 'Reading markets and competitive dynamics' },
    { name: 'User Insight',         description: 'Understanding and working with user research' },
    { name: 'Project Delivery',     description: 'Managing delivery and client expectations' },
];

const DEMO_RECIPES = [
    { domain: 'Design Practice',      skillName: 'Framing the design brief',                       trigger: 'A client presents a brief that describes a solution rather than a problem.',                                                              actionSequence: '1. Reflect the brief back in problem language. 2. Ask what outcome the client needs for end users. 3. Reframe scope together before accepting.',                                                            expectedOutcome: 'The team works on the right problem, not the client\'s assumed solution.',                                              flawPattern: 'Accepting the solution-as-brief and designing within it.' },
    { domain: 'Design Practice',      skillName: 'Calibrating fidelity to phase',                  trigger: 'A team member proposes high-fidelity output at a discovery or early-concept phase.',                                                     actionSequence: '1. Name the current phase and its decision purpose. 2. Identify minimum fidelity to answer the phase question. 3. Redirect effort to that fidelity level.',                                                   expectedOutcome: 'Resources stay proportionate to the certainty level — no expensive rework from premature commitment.',                  flawPattern: 'Polishing early-stage concepts to impress the client before the right direction is known.' },
    { domain: 'Design Practice',      skillName: 'Managing subjective client feedback',            trigger: 'A client gives feedback that expresses personal preference without a design rationale.',                                                  actionSequence: '1. Acknowledge the reaction without conceding the design. 2. Ask what specifically the feedback is responding to. 3. Surface the design principle behind the choice. 4. Offer to explore an alternative.',  expectedOutcome: 'Feedback gets absorbed without destroying the design intent.',                                                          flawPattern: 'Immediately redesigning to match the preference, producing work with no defensible rationale.' },
    { domain: 'Design Practice',      skillName: 'Separating signal from noise in research',       trigger: 'A research session produces contradictory findings across participants.',                                                                 actionSequence: '1. Separate frequency from intensity. 2. Look for the underlying need behind each contradictory position. 3. Check whether contradiction is about solution or problem. 4. Present findings as a tension.',  expectedOutcome: 'Decision-makers work from an accurate picture of user complexity.',                                                     flawPattern: 'Averaging contradictory findings into a single user view.' },
    { domain: 'Design Practice',      skillName: 'Structuring a design critique',                  trigger: 'A design review session risks becoming a preference-sharing exercise.',                                                                   actionSequence: '1. Establish criteria before showing work. 2. Separate observation from interpretation from recommendation. 3. Track decisions made and their rationale.',                                                    expectedOutcome: 'The critique produces clear decisions with recorded reasoning.',                                                        flawPattern: 'Opening the floor to general feedback without criteria.' },
    { domain: 'Design Practice',      skillName: 'Recognising scope creep in design requests',     trigger: 'A client adds new design requirements mid-project framed as small additions.',                                                          actionSequence: '1. Acknowledge without committing. 2. Assess impact on scope and cost. 3. Bring to project lead. 4. Respond with a clear choice: include with adjustment, or defer.',                                       expectedOutcome: 'Scope remains controlled and the team does not absorb uncosted work.',                                                 flawPattern: 'Agreeing to small additions each time, letting scope grow without acknowledgement.' },
    { domain: 'Business Development', skillName: 'Reading client readiness to buy',                trigger: 'A client is engaging with the work but not moving toward commitment.',                                                                   actionSequence: '1. Distinguish intellectual interest from commercial readiness. 2. Ask directly about decision timeline and who is involved. 3. Identify the obstacle. 4. Address the specific obstacle.',                    expectedOutcome: 'Energy goes toward real opportunities, not indefinite exploratory conversations.',                                      flawPattern: 'Treating continued engagement as a positive signal without testing commercial intent.' },
    { domain: 'Business Development', skillName: 'Pricing conversations without discounting',      trigger: 'A client pushes back on price during a proposal conversation.',                                                                          actionSequence: '1. Do not immediately offer a discount. 2. Ask what specifically concerns them. 3. Reframe around value of the outcome. 4. If budget is real, reduce scope rather than margin.',                             expectedOutcome: 'Price integrity holds.',                                                                                                flawPattern: 'Offering a discount as a first response.' },
    { domain: 'Business Development', skillName: 'Qualifying the right contact',                   trigger: 'A lead is enthusiastic but does not appear to have decision-making authority.',                                                          actionSequence: '1. Identify whether this person controls budget, recommends, or influences. 2. Ask who else is involved before investing heavily. 3. Work with the contact to get access to the decision-maker.',           expectedOutcome: 'Proposals reach the right people.',                                                                                    flawPattern: 'Building a relationship with an enthusiast who cannot buy.' },
    { domain: 'Business Development', skillName: 'Writing a proposal that answers the real question', trigger: 'A proposal brief asks for methodology but the real question is "can I trust these people?"',                                        actionSequence: '1. Identify the real question behind the formal brief. 2. Lead with the outcome you are committing to. 3. Use case evidence that mirrors their specific situation. 4. Save methodology for an appendix.',  expectedOutcome: 'The proposal addresses the decision-maker\'s actual concern.',                                                         flawPattern: 'Writing a thorough methodology document that misses the emotional evaluation.' },
    { domain: 'Business Development', skillName: 'Turning a lost bid into a relationship',         trigger: 'A proposal is rejected and the client gives vague feedback.',                                                                            actionSequence: '1. Request a debrief call. 2. Ask specifically what won it for the winner. 3. Close with a gracious note that keeps the door open. 4. Record what you learned.',                                            expectedOutcome: 'You learn something real and the client remembers you well.',                                                           flawPattern: 'Accepting vague rejection feedback and moving on.' },
    { domain: 'Business Development', skillName: 'Protecting the relationship during difficult delivery', trigger: 'A project is running into difficulty and there is pressure to avoid telling the client.',                                       actionSequence: '1. Raise the issue before they notice it. 2. Come with a proposed response plan. 3. Acknowledge what went wrong. 4. Confirm what happens next.',                                                            expectedOutcome: 'Trust survives the difficulty.',                                                                                        flawPattern: 'Delaying disclosure until the client discovers the problem themselves.' },
    { domain: 'Market Intelligence',  skillName: 'Distinguishing trend from noise',                trigger: 'A single data point is presented as evidence of a market shift.',                                                                        actionSequence: '1. Ask for the time span and sample. 2. Look for corroborating signals. 3. Identify what would have to be true for this to be a trend vs a fluctuation.',                                                   expectedOutcome: 'Decisions are based on pattern, not anecdote.',                                                                        flawPattern: 'Accepting a single data point as evidence of a trend.' },
    { domain: 'Market Intelligence',  skillName: 'Reading a competitive move accurately',          trigger: 'A competitor makes a public announcement that appears to threaten the firm\'s position.',                                               actionSequence: '1. Separate the announcement from the capability behind it. 2. Ask: do they have the resources to execute? 3. Identify what client behaviour change would need to happen. 4. Decide whether to respond.',  expectedOutcome: 'The firm responds to real threats and ignores PR moves.',                                                               flawPattern: 'Treating every competitor announcement as a genuine threat.' },
    { domain: 'Market Intelligence',  skillName: 'Synthesising client intelligence across the portfolio', trigger: 'Multiple client conversations in a week surface similar concerns.',                                                             actionSequence: '1. Note the pattern without assuming it is universal. 2. Test whether it is broad or sector-specific. 3. Bring it to leadership framed as a pattern.',                                                       expectedOutcome: 'Intelligence from client relationships compounds into strategic awareness.',                                            flawPattern: 'Treating each client conversation as isolated.' },
    { domain: 'Market Intelligence',  skillName: 'Presenting market uncertainty honestly',         trigger: 'A client asks for a clear forecast in a genuinely uncertain environment.',                                                               actionSequence: '1. Resist the pressure to give false certainty. 2. Present a range of scenarios with conditions. 3. Identify what the client can and cannot control. 4. Recommend the most robust decision.',              expectedOutcome: 'The client makes a better decision and trusts the firm for not pretending to know.',                                   flawPattern: 'Producing a confident-sounding forecast to satisfy the client\'s desire for certainty.' },
    { domain: 'Market Intelligence',  skillName: 'Identifying the real unit of competition',       trigger: 'A firm is defining their competitive set too narrowly.',                                                                                 actionSequence: '1. Ask what decision the end customer is actually making. 2. Map the real alternatives including doing nothing. 3. Reframe the competitive set around those alternatives.',                                 expectedOutcome: 'Strategy addresses the actual competitive threat.',                                                                    flawPattern: 'Defining competitors as direct category peers only.' },
    { domain: 'User Insight',         skillName: 'Designing research for a decision',              trigger: 'A research brief asks to "understand the user" without specifying what decision the insight will inform.',                               actionSequence: '1. Ask what decision this research will be used to make. 2. Identify what the team needs to know to make that decision. 3. Design the research to produce that specific knowledge.',                        expectedOutcome: 'Research produces insight that changes or confirms a decision.',                                                       flawPattern: 'Running broad discovery that produces interesting findings but does not resolve the decision.' },
    { domain: 'User Insight',         skillName: 'Handling the leading interview question',        trigger: 'A team member proposes interview questions that contain the answer they are looking for.',                                               actionSequence: '1. Identify the assumption embedded in the question. 2. Rewrite to ask about behaviour without suggesting the expected answer. 3. Pilot before the interview.',                                            expectedOutcome: 'Research reveals what users actually think, not what the team hoped to find.',                                         flawPattern: 'Running interviews with leading questions and finding false confirmation.' },
    { domain: 'User Insight',         skillName: 'Distinguishing what users say from what they do', trigger: 'Research findings show a gap between stated user preference and observed behaviour.',                                                 actionSequence: '1. Flag the gap explicitly — do not smooth over it. 2. Weight behaviour over stated preference. 3. Investigate the gap itself — it often contains the most useful insight.',                              expectedOutcome: 'Decisions are made on what users actually do.',                                                                        flawPattern: 'Averaging stated preferences and observed behaviour into a single finding.' },
    { domain: 'User Insight',         skillName: 'Recruiting the right research participants',     trigger: 'There is pressure to use convenient participants rather than actual target users.',                                                      actionSequence: '1. Name the difference between convenient participants and target users. 2. Estimate the cost of wrong-participant findings. 3. Push for proper recruitment or scope explicitly as a proxy with caveats.', expectedOutcome: 'Research findings reflect the target audience — or the team knows clearly that they do not.',                         flawPattern: 'Running research with convenient participants and presenting findings as representative.' },
    { domain: 'User Insight',         skillName: 'Making research actionable for a non-research audience', trigger: 'A research presentation is falling flat with a client who does not engage with quotes and themes.',                           actionSequence: '1. Lead with the decision implication, not the finding. 2. Translate themes into "this means you should" language. 3. Offer a recommended direction.',                                                      expectedOutcome: 'Stakeholders engage with findings and make decisions from them.',                                                      flawPattern: 'Presenting themes and quotes without explicit implications.' },
    { domain: 'Project Delivery',     skillName: 'Setting expectations at project kickoff',        trigger: 'A project is starting with vague success criteria or unclear roles.',                                                                    actionSequence: '1. Establish what success looks like specifically. 2. Agree who makes decisions and at what stages. 3. Put both in writing before any work begins.',                                                        expectedOutcome: 'The project has a clear finish line and decision-making structure.',                                                   flawPattern: 'Starting work before success is defined.' },
    { domain: 'Project Delivery',     skillName: 'Managing a missed deadline without damaging trust', trigger: 'The team will not meet a committed delivery date.',                                                                                actionSequence: '1. Tell the client before the deadline, not after. 2. Explain the cause specifically. 3. Give a revised date you are confident in. 4. Describe what will be different.',                                    expectedOutcome: 'Trust takes a smaller hit than a surprise miss.',                                                                      flawPattern: 'Saying nothing until the deadline passes.' },
    { domain: 'Project Delivery',     skillName: 'Closing a project cleanly',                      trigger: 'A project is technically finished but the client keeps raising small new requests.',                                                     actionSequence: '1. Call the project closure explicitly. 2. Document what was delivered. 3. Acknowledge open items and route them to a new brief.',                                                                           expectedOutcome: 'The firm does not absorb unbounded post-project work.',                                                                flawPattern: 'Treating the project as still running because the client is still contacting you.' },
];

const DEMO_EMPLOYEES = [
    { uid: 'demo-emp-001', displayName: 'Adaeze Okafor',  email: 'adaeze@meridian-demo.co', roleTitle: 'Senior Consultant', seniority: 'mid',    sessionsTotal: 48, xp: 1720, streak: 5,  profile: 'strong',            lastActiveDaysAgo: 0  },
    { uid: 'demo-emp-002', displayName: 'Kofi Asante',    email: 'kofi@meridian-demo.co',   roleTitle: 'Consultant',        seniority: 'junior', sessionsTotal: 31, xp: 890,  streak: 3,  profile: 'fast-bd',           lastActiveDaysAgo: 1  },
    { uid: 'demo-emp-003', displayName: 'Priya Menon',    email: 'priya@meridian-demo.co',  roleTitle: 'Associate',         seniority: 'junior', sessionsTotal: 27, xp: 620,  streak: 0,  profile: 'blind-spot-design', lastActiveDaysAgo: 4  },
    { uid: 'demo-emp-004', displayName: 'Tom Whitfield',  email: 'tom@meridian-demo.co',    roleTitle: 'Senior Consultant', seniority: 'mid',    sessionsTotal: 52, xp: 1340, streak: 2,  profile: 'steady',            lastActiveDaysAgo: 1  },
    { uid: 'demo-emp-005', displayName: 'Yemi Adeyemi',   email: 'yemi@meridian-demo.co',   roleTitle: 'Consultant',        seniority: 'mid',    sessionsTotal: 39, xp: 1150, streak: 7,  profile: 'strong-user',       lastActiveDaysAgo: 0  },
    { uid: 'demo-emp-006', displayName: 'Clara Birch',    email: 'clara@meridian-demo.co',  roleTitle: 'Associate',         seniority: 'junior', sessionsTotal: 22, xp: 480,  streak: 4,  profile: 'early',             lastActiveDaysAgo: 2  },
    { uid: 'demo-emp-007', displayName: 'Remi Osei',      email: 'remi@meridian-demo.co',   roleTitle: 'Senior Consultant', seniority: 'senior', sessionsTotal: 87, xp: 3200, streak: 14, profile: 'high-performer',    lastActiveDaysAgo: 0  },
    { uid: 'demo-emp-008', displayName: 'Nadia Volkov',   email: 'nadia@meridian-demo.co',  roleTitle: 'Consultant',        seniority: 'mid',    sessionsTotal: 18, xp: 390,  streak: 0,  profile: 'stalled',           lastActiveDaysAgo: 10 },
];

const DEMO_VERDICT_WEIGHTS = {
    'strong':             [0.65, 0.25, 0.10],
    'fast-bd':            [0.58, 0.28, 0.14],
    'blind-spot-design':  [0.55, 0.28, 0.17],
    'steady':             [0.52, 0.30, 0.18],
    'strong-user':        [0.62, 0.25, 0.13],
    'early':              [0.48, 0.32, 0.20],
    'high-performer':     [0.78, 0.16, 0.06],
    'stalled':            [0.45, 0.32, 0.23],
};

function simulateMastery(profile) {
    const domains = ['Design Practice', 'Business Development', 'Market Intelligence', 'User Insight', 'Project Delivery'];
    const rates   = {
        'strong':             { base: 0.72, variance: 0.10 },
        'fast-bd':            { base: 0.58, variance: 0.18, 'Business Development': 0.82 },
        'blind-spot-design':  { base: 0.62, variance: 0.08, 'Design Practice': 0.28 },
        'steady':             { base: 0.55, variance: 0.06 },
        'strong-user':        { base: 0.60, variance: 0.12, 'User Insight': 0.84 },
        'early':              { base: 0.50, variance: 0.15 },
        'high-performer':     { base: 0.81, variance: 0.07 },
        'stalled':            { base: 0.48, variance: 0.12 },
    }[profile] ?? { base: 0.55, variance: 0.10 };

    const mastery = {};
    domains.forEach(d => {
        const rate    = rates[d] ?? (rates.base + (Math.random() - 0.5) * rates.variance);
        const played  = Math.floor(5 + Math.random() * 20);
        const correct = Math.floor(played * Math.min(1, Math.max(0, rate)));
        mastery[d]    = { played, correct };
    });
    return mastery;
}

function simulateSignals(emp) {
    const domains        = ['Design Practice', 'Business Development', 'Market Intelligence', 'User Insight', 'Project Delivery'];
    const types          = ['judgement', 'recognition', 'reflection'];
    const weights        = DEMO_VERDICT_WEIGHTS[emp.profile] ?? [0.55, 0.28, 0.17];
    const twelveWeeksAgo = Date.now() - (12 * 7 * 24 * 60 * 60 * 1000);
    const signals        = [];
    const baseSpeed      = emp.profile === 'high-performer' ? 80 : emp.profile === 'stalled' ? 155 : 115;

    for (let i = 0; i < emp.sessionsTotal; i++) {
        const domain  = domains[i % domains.length];
        const type    = types [i % types.length];
        const rng     = Math.random();
        let verdict   = rng < weights[0] ? 'correct' : rng < weights[0] + weights[1] ? 'partial' : 'missed';
        if (emp.profile === 'blind-spot-design' && domain === 'Design Practice' && Math.random() < 0.6) verdict = 'missed';
        const signalMs     = twelveWeeksAgo + (i / emp.sessionsTotal) * 12 * 7 * 24 * 60 * 60 * 1000;
        const secondsTaken = Math.max(20, Math.min(240, Math.floor(baseSpeed + (Math.random() - 0.5) * 60)));
        signals.push({
            domain,
            scenarioType:   type,
            verdict,
            responseLength: Math.floor(80 + Math.random() * 300),
            secondsTaken,
            createdAt:      Timestamp.fromMillis(signalMs),
        });
    }
    return signals;
}

function generateDemoScenarios(recipe, recipeId) {
    return [
        { recipeId, domain: recipe.domain, text: `You are working on a ${recipe.domain.toLowerCase()} challenge with a client. ${recipe.trigger} The team is looking to you for direction.`, questionPrompt: 'What do you notice, and what would you do?', scenarioType: 'judgement',   difficulty: 'mid', approved: true },
        { recipeId, domain: recipe.domain, text: `Your colleague has shared an update that may — or may not — call for ${recipe.skillName.toLowerCase()}. The details are still emerging.`,        questionPrompt: 'Does this situation call for this approach? Why or why not?', scenarioType: 'recognition', difficulty: 'mid', approved: true },
        { recipeId, domain: recipe.domain, text: `A recent project concluded well. Looking back, the key move was: ${recipe.actionSequence.split('.')[0].replace(/^1\. /, '')}. The client noticed.`, questionPrompt: 'What principle does this outcome reflect?', scenarioType: 'reflection',  difficulty: 'mid', approved: true },
    ];
}

const DEMO_REVIEWER_CONTRIBUTIONS = [
    { sourceType: 'scenario_review', rawContent: 'The scenario uses procurement language our clients never use. They say "does this feel right?" not "please validate the scope parameters." It reads as a government tender, not an advisory relationship.', contextNote: 'Scenario review — Business Development domain', draft: { hasRecipe: true, skillName: 'Reading register in client communication', trigger: 'A client\'s language signals a formality mismatch.', actionSequence: '1. Notice the register mismatch. 2. Match the client\'s register. 3. Signal that informal conversation is available.', expectedOutcome: 'Client feels the relationship fits their context.', flawPattern: 'Responding in a formal register that reinforces a transactional tone.', confidence: 'high' } },
    { sourceType: 'mentorship_note', rawContent: 'What they missed is that the client wasn\'t asking for a recommendation — they were asking to be heard. You have to slow down, reflect it back, and let them talk for another two minutes before you introduce any ideas.', contextNote: 'Mentorship note — senior client expressing doubt about project direction', draft: { hasRecipe: true, skillName: 'Responding to expressed client doubt', trigger: 'A senior client signals concern mid-engagement.', actionSequence: '1. Acknowledge the concern before the content. 2. Ask to let them say more. 3. Reflect back before introducing ideas.', expectedOutcome: 'Client feels understood — the precondition for accepting advice.', flawPattern: 'Moving immediately to problem-solving mode.', confidence: 'high' } },
    { sourceType: 'document', rawContent: 'The retrospective noted that on three occasions the team absorbed contradictions from research without raising them. Each time they didn\'t want to "derail the project" — but each contradiction was a signal the direction wasn\'t serving real user behaviour.', contextNote: 'Q3 Project Retrospective — Westbridge engagement', draft: { hasRecipe: true, skillName: 'Surfacing contradictions from research', trigger: 'Research produces findings that contradict the brief.', actionSequence: '1. Document the contradiction. 2. Raise it with the project lead. 3. Present it as a decision point, not a problem.', expectedOutcome: 'Contradictions are surfaced at the right level at the right time.', flawPattern: 'Absorbing contradictions silently to avoid derailing the project.', confidence: 'high' } },
];