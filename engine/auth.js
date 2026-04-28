// =============================================================================
// LORE — Auth Engine
// Handles: Firebase Auth sign-in, invite redemption (account creation),
// sign-out, reading custom claims (orgId, role), and invite generation.
//
// No user self-registers. Every account is created via a Manager-generated
// invite link. This file handles both the normal sign-in path and the
// invite redemption path.
//
// Phase 2 addition: generateInvite() — Managers create invite links for
// Employees and Reviewers from the Dashboard.
// =============================================================================

import { auth, db } from '../firebase.js';
import {
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signOut as firebaseSignOut,
    onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
    doc,
    getDoc,
    addDoc,
    collection,
    updateDoc,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { friendlyAuthError } from './utils.js';

// ---------------------------------------------------------------------------
// Sign in with email and password.
// Returns { ok: true } or { ok: false, error: string }.
// The error string is safe to show to a user.
// ---------------------------------------------------------------------------
export async function signIn(email, password) {
    console.log('LORE auth.js: Sign-in attempt for:', email);
    try {
        await signInWithEmailAndPassword(auth, email, password);
        console.log('LORE auth.js: Sign-in successful.');
        return { ok: true };
    } catch (err) {
        console.warn('LORE auth.js: Sign-in failed —', err.code);
        return { ok: false, error: friendlyAuthError(err.code) };
    }
}

// ---------------------------------------------------------------------------
// Redeem an invite link and create an account.
// inviteId comes from the URL query parameter.
// Returns { ok: true, role } or { ok: false, error: string }.
// ---------------------------------------------------------------------------
export async function redeemInvite(inviteId, name, password) {
    // 1. Read the invite document
    const inviteRef = doc(db, 'invites', inviteId);
    let invite;
    try {
        const snap = await getDoc(inviteRef);
        if (!snap.exists()) {
            return { ok: false, error: 'This invite link is not valid.' };
        }
        invite = snap.data();
    } catch {
        return { ok: false, error: 'Could not verify your invite. Please try again.' };
    }

    // 2. Check it has not already been used
    if (invite.redeemed) {
        return { ok: false, error: 'This invite has already been used.' };
    }

    // 3. Check it has not expired
    if (invite.expiresAt && invite.expiresAt.toDate() < new Date()) {
        return { ok: false, error: 'This invite has expired. Ask your manager to send a new one.' };
    }

    // 4. Create the Firebase Auth account.
    let userCredential;
    try {
        userCredential = await createUserWithEmailAndPassword(auth, invite.email, password);
    } catch (err) {
        return { ok: false, error: friendlyAuthError(err.code) };
    }

    const uid = userCredential.user.uid;

    // 5. Set custom claims via the Cloudflare Worker's redeemInviteClaims route.
    // The Worker reads the invite document server-side using its service account
    // token, validates it, and sets orgId + role claims on the new account.
    // No admin secret is needed — the invite document is the trust mechanism.
    // There is no Cloud Function — claims must be set explicitly here.
    // We ping first to avoid a cold-start timeout on the real call.
    console.log('LORE auth.js: Setting claims for invited user uid:', uid);
    try {
        await fetch('https://lore-worker.slop-runner.workers.dev', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ mode: 'ping' }),
        }).catch(() => {});

        const claimsRes = await fetch('https://lore-worker.slop-runner.workers.dev', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ mode: 'redeemInviteClaims', uid, inviteId }),
        });

        const claimsData = await claimsRes.json().catch(() => ({}));
        if (!claimsData.ok) {
            console.warn('LORE auth.js: redeemInviteClaims failed:', claimsData.error);
        } else {
            console.log('LORE auth.js: Claims set successfully for uid:', uid);
        }
    } catch (err) {
        console.warn('LORE auth.js: redeemInviteClaims fetch failed:', err.message);
    }

    // 6. Mark the invite as redeemed
    try {
        await updateDoc(inviteRef, {
            redeemed:    true,
            redeemedAt:  serverTimestamp(),
            redeemedBy:  uid,
        });
    } catch {
        console.warn('LORE: Could not mark invite as redeemed.');
    }

    return { ok: true, role: invite.role, orgId: invite.orgId };
}

// ---------------------------------------------------------------------------
// Generate an invite link for a new team member.
// Called by the Manager from the Dashboard.
//
// options: {
//   email:     string  — the email address to invite
//   role:      'employee' | 'reviewer'
//   roleTitle: string  — their job title (e.g. "Senior Account Manager")
//   seniority: 'junior' | 'mid' | 'senior' — used to calibrate scenario difficulty
//   orgName:   string  — shown on the invite screen
// }
//
// Returns { ok: true, inviteId, inviteUrl } or { ok: false, error }.
// ---------------------------------------------------------------------------
export async function generateInvite(orgId, creatorUid, options) {
    console.log('LORE auth.js: Generating invite — email:', options.email, 'role:', options.role);
    // Invites expire after 7 days — [TUNING TARGET] adjust if needed
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    try {
        const ref = collection(db, 'invites');
        const added = await addDoc(ref, {
            orgId:     orgId,
            email:     options.email,
            role:      options.role,
            roleTitle: options.roleTitle ?? '',
            seniority: options.seniority ?? 'mid',
            orgName:   options.orgName   ?? '',
            createdBy: creatorUid,
            createdAt: serverTimestamp(),
            expiresAt,
            redeemed:  false,
        });

        // Build the invite URL — uses the live app URL with the invite ID as a query param
        const base = 'https://lore-platform.github.io/lore/';
        const inviteUrl = `${base}?invite=${added.id}`;

        return { ok: true, inviteId: added.id, inviteUrl };
    } catch (err) {
        console.warn('LORE Auth: Could not generate invite.', err);
        return { ok: false, error: 'Could not create the invite. Please try again.' };
    }
}

// ---------------------------------------------------------------------------
// Get the current user's custom claims from their ID token.
// Claims include: orgId, role ('manager' | 'employee' | 'reviewer').
// Returns null if not signed in or claims not yet set.
// ---------------------------------------------------------------------------
export async function getClaims() {
    const user = auth.currentUser;
    if (!user) return null;

    try {
        // forceRefresh: true ensures we get the latest claims after invite redemption
        const token = await user.getIdTokenResult(true);
        const { orgId, role } = token.claims;
        if (!orgId || !role) {
            console.warn('LORE auth.js: Claims present but orgId or role missing — claims not yet set by Cloud Function.');
            return null;
        }
        console.log('LORE auth.js: Claims read — role:', role, 'orgId:', orgId);
        return { orgId, role, uid: user.uid, email: user.email };
    } catch (err) {
        console.warn('LORE auth.js: Could not read claims.', err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Sign out the current user.
// ---------------------------------------------------------------------------
export async function signOut() {
    try {
        await firebaseSignOut(auth);
    } catch {
        // Sign-out failure is non-fatal — the auth state listener will clean up
        console.warn('LORE: Sign-out error.');
    }
}

// ---------------------------------------------------------------------------
// Subscribe to auth state changes.
// Calls callback(user) when signed in, callback(null) when signed out.
// Returns the unsubscribe function.
// ---------------------------------------------------------------------------
export function onAuthChange(callback) {
    return onAuthStateChanged(auth, callback);
}

// ---------------------------------------------------------------------------
// Read an invite document without redeeming it.
// Used to pre-populate the invite UI with the org name and role context.
// Returns the invite data or null.
// ---------------------------------------------------------------------------
export async function readInvite(inviteId) {
    try {
        const snap = await getDoc(doc(db, 'invites', inviteId));
        if (!snap.exists()) return null;
        const data = snap.data();
        if (data.redeemed) return null;
        return data;
    } catch {
        return null;
    }
}