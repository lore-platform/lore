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
    deleteDoc,
    query,
    orderBy,
    limit,
    serverTimestamp,
    Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ADMIN_EMAIL = 'osiokeitseuwa@gmail.com';
const WORKER_URL  = 'https://lore-worker.slop-runner.workers.dev';

const FIREBASE_API_KEY = 'AIzaSyBW_PE2RiIs-4_tAoOtKdQLXijh9-WNv7Q';

// Demo org constants — single source of truth, used by both seed and provision
const DEMO = {
    orgId:       'lore-demo',
    orgName:     'Meridian Advisory',
    industry:    'Consulting',
    managerName: 'Adaeze Okafor',
    managerEmail:'adaeze@meridian.com',
    roleTitle:   'Head of L&D',
};

// Session-only — entered at runtime, never stored
let _adminSecret  = null;
let _adminEmail   = null;

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
    // Ensure the platform singleton document exists. Uses setDoc with merge:true
    // so it is a no-op on every sign-in after the first — never overwrites.
    // This is the platform owner record: Osioke/LORE HQ as a first-class entity.
    setDoc(
        doc(db, 'platform', 'lore-platform'),
        { productName: 'LORE', ownerEmail: _adminEmail, initialised: true },
        { merge: true }
    ).catch(err => console.warn('LORE admin.js: Could not write platform doc.', err));
    loadOrgList();
    loadActivityLog();
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
        // getDocs on the top-level organisations collection.
        // Each org document must exist at organisations/{orgId} — not just its sub-documents.
        // The provision and seed flows both write this top-level doc explicitly.
        const orgsSnap = await getDocs(collection(db, 'organisations'));

        if (orgsSnap.empty) {
            listEl.innerHTML = '<p class="text-secondary text-sm">No organisations provisioned yet.</p>';
            return;
        }

        // For each org, read the manager user doc. We find the manager by querying
        // the users sub-collection for role === 'manager'.
        const orgs = await Promise.all(orgsSnap.docs.map(async orgDoc => {
            const orgId   = orgDoc.id;
            const orgData = orgDoc.data();

            // Read manager from users sub-collection
            let manager = null;
            try {
                const usersSnap = await getDocs(collection(db, 'organisations', orgId, 'users'));
                const managerDoc = usersSnap.docs.find(d => d.data().role === 'manager');
                if (managerDoc) manager = { uid: managerDoc.id, ...managerDoc.data() };
            } catch { /* non-fatal — show org without manager detail */ }

            return { orgId, orgData, manager };
        }));

        listEl.innerHTML = orgs.map(({ orgId, orgData, manager }) => `
            <div class="admin-org-row" id="org-row-${orgId}">
                <div class="admin-org-info">
                    <p class="admin-org-name">${orgData.orgName ?? orgId}</p>
                    <p class="admin-org-meta">
                        <span>${orgId}</span>
                        <span>·</span>
                        <span>${orgData.industry ?? '—'}</span>
                        ${manager ? `<span>·</span><span>${manager.displayName} (${manager.email})</span>` : ''}
                        ${manager ? `<span>·</span><span class="text-xs" style="color:var(--warm-grey);">UID: ${manager.uid}</span>` : '<span>· No manager found</span>'}
                    </p>
                    <p class="admin-org-meta" style="margin-top:2px;">
                        Created: ${orgData.createdAt ? new Date(orgData.createdAt.toDate()).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }) : '—'}
                    </p>
                </div>
                <button class="btn admin-btn-danger" id="delete-org-${orgId}">Delete</button>
            </div>
        `).join('');

        orgs.forEach(({ orgId, orgData, manager }) => {
            document.getElementById(`delete-org-${orgId}`)?.addEventListener('click', async () => {
                const label = orgData.orgName ?? orgId;
                if (!confirm(`Delete "${label}" and all its data? This removes the Firestore org, all sub-collections, and the Manager's Firebase Auth account. This cannot be undone.`)) return;
                const btn = document.getElementById(`delete-org-${orgId}`);
                btn.disabled = true; btn.textContent = 'Deleting…';
                await deleteOrg(orgId, orgData, manager);
                document.getElementById(`org-row-${orgId}`)?.remove();
                if (document.querySelectorAll('.admin-org-row').length === 0) {
                    listEl.innerHTML = '<p class="text-secondary text-sm">No organisations provisioned yet.</p>';
                }
            });
        });

    } catch (err) {
        console.error('LORE admin.js: loadOrgList error:', err);
        listEl.innerHTML = `<p style="color:var(--error);font-size:var(--text-sm);">
            Could not load organisations: ${err.message}
        </p>`;
    }
}

// ---------------------------------------------------------------------------
// Delete an org — removes Firebase Auth account, all Firestore sub-collections,
// the profile/data sub-document, and the top-level organisations/{orgId} document.
// ---------------------------------------------------------------------------
async function deleteOrg(orgId, orgData, manager) {
    console.log('LORE admin.js: Deleting org:', orgId);
    let outcome = 'success';
    let errorMsg = null;

    // 1. Delete Firebase Auth account for the manager
    if (manager?.uid) {
        try {
            await deleteFirebaseAuthUser(manager.uid);
        } catch (err) {
            console.warn('LORE admin.js: Could not delete auth account for', manager.uid, err);
            outcome  = 'partial';
            errorMsg = `Auth account deletion failed for UID ${manager.uid}: ${err.message}`;
        }
    }

    // 2. Delete all sub-collections
    for (const sub of ['users', 'recipes', 'scenarios', 'extractions', 'domains']) {
        try {
            const snap = await getDocs(collection(db, 'organisations', orgId, sub));
            // For users, also delete their sub-collections first
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
        } catch (err) {
            console.warn('LORE admin.js: Could not delete sub-collection', sub, err);
        }
    }

    // 3. Delete profile/data sub-document
    try {
        await deleteDoc(doc(db, 'organisations', orgId, 'profile', 'data'));
    } catch { /* non-fatal if it doesn't exist */ }

    // 4. Delete the top-level organisations/{orgId} document
    try {
        await deleteDoc(doc(db, 'organisations', orgId));
    } catch (err) {
        console.warn('LORE admin.js: Could not delete top-level org doc:', err);
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

    console.log('LORE admin.js: Org deletion complete:', orgId, outcome);
}

// ---------------------------------------------------------------------------
// Delete a Firebase Auth user via the REST API.
// The Admin SDK is not available client-side — this uses the accounts:delete
// endpoint with the Firebase API key. This only works when the currently
// signed-in user is the admin — Firestore rules protect the data side.
// ---------------------------------------------------------------------------
async function deleteFirebaseAuthUser(uid) {
    const res = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${FIREBASE_API_KEY}`,
        {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ localId: uid }),
        }
    );
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message ?? `HTTP ${res.status}`);
    }
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

        // Step 7: Write activity log
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
// Set custom claims on a Firebase Auth user via the Cloudflare Worker.
// Throws if claims cannot be set — callers must treat this as fatal.
// ---------------------------------------------------------------------------
async function setClaims(uid, orgId, role) {
    let data;
    try {
        const res = await fetch(WORKER_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ mode: 'setClaims', uid, orgId, role, adminSecret: _adminSecret }),
        });
        data = await res.json();
    } catch (fetchErr) {
        throw new Error(
            `Could not reach the Worker to set claims. Check the Worker is deployed. ` +
            `Set claims manually in Firebase Console: uid=${uid}, orgId=${orgId}, role=${role}.`
        );
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
    if (!confirm(
        'This will provision the Meridian Advisory demo Manager account and seed all demo data.\n\n' +
        'Run Reset first if you have seeded before.'
    )) return;
    await runDemoSeedFlow();
});

document.getElementById('demo-reset-btn').addEventListener('click', async () => {
    if (!confirm(
        'Delete ALL data for the lore-demo org?\n\n' +
        'This removes all Firestore data and the Manager\'s Firebase Auth account. Cannot be undone.'
    )) return;
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
    const TOTAL = 6 + 1 + 5 + 25 + 8 + 3 + 1;
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

        // Show login details before seeding so they are not lost if seed errors
        showDemoStatus(
            `✓ Manager account ready. Email: ${DEMO.managerEmail} · Password: ${tempPassword} · Login: https://lore-platform.github.io/lore/`,
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

        // Reviewer user doc
        demoLog('Writing Reviewer user…');
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
        demoTick('Reviewer: Marcus Obi');

        await writeLog({
            action:  'seed',
            orgId:   DEMO.orgId,
            orgName: DEMO.orgName,
            detail:  `Demo data seeded. Manager UID: ${uid}. ${DEMO_RECIPES.length} recipes, ${DEMO_EMPLOYEES.length} employees.`,
            outcome: 'success',
            errorMsg: null,
        });

        showDemoStatus(
            `✓ Demo seeded. Sign in at https://lore-platform.github.io/lore/ · Email: ${DEMO.managerEmail} · Password: ${tempPassword}`,
            'ok'
        );
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
    initDemoProgress(subCollections.length + 3); // subs + profile/data + top-level doc + auth

    demoLog('Starting reset for org: ' + DEMO.orgId);

    // 1. Delete Firebase Auth account for the Manager
    try {
        const usersSnap  = await getDocs(collection(db, 'organisations', DEMO.orgId, 'users'));
        const managerDoc = usersSnap.docs.find(d => d.data().role === 'manager');
        if (managerDoc) {
            await deleteFirebaseAuthUser(managerDoc.id);
            demoTick('Deleted: Manager Firebase Auth account');
        } else {
            demoTick('No Manager Auth account found — skipped');
        }
    } catch (err) {
        demoLog(`Could not delete Manager Auth account: ${err.message}`, 'err');
        demoTick('Auth account — error (see above)');
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

    showDemoStatus('Demo data reset. Run "Provision + Seed demo" to repopulate.', 'ok');
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
// SECTION 4 — Activity log
// =============================================================================

document.getElementById('refresh-logs').addEventListener('click', loadActivityLog);

async function loadActivityLog() {
    const listEl = document.getElementById('activity-log-list');
    listEl.innerHTML = '<p class="text-secondary text-sm">Loading…</p>';

    try {
        const q    = query(collection(db, 'platform', 'lore-platform', 'adminLogs'), orderBy('createdAt', 'desc'), limit(50));
        const snap = await getDocs(q);

        if (snap.empty) {
            listEl.innerHTML = '<p class="text-secondary text-sm">No activity yet.</p>';
            return;
        }

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

    } catch (err) {
        console.error('LORE admin.js: loadActivityLog error:', err);
        listEl.innerHTML = `<p style="color:var(--error);font-size:var(--text-sm);">Could not load activity log: ${err.message}</p>`;
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