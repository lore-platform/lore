// =============================================================================
// LORE — Auth Engine
// Handles: Firebase Auth sign-in, invite redemption (account creation),
// sign-out, and reading custom claims (orgId, role).
//
// No user self-registers. Every account is created via a Manager-generated
// invite link. This file handles both the normal sign-in path and the
// invite redemption path.
// =============================================================================

import { auth, db } from './firebase.js';
import {
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signOut as firebaseSignOut,
    onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
    doc,
    getDoc,
    updateDoc,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ---------------------------------------------------------------------------
// Sign in with email and password.
// Returns { ok: true } or { ok: false, error: string }.
// The error string is safe to show to a user.
// ---------------------------------------------------------------------------
export async function signIn(email, password) {
    try {
        await signInWithEmailAndPassword(auth, email, password);
        return { ok: true };
    } catch (err) {
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

    // 4. Create the Firebase Auth account
    // Note: custom claims (orgId, role) are set by a Cloud Function triggered
    // on user creation. For now we store the invite data and the Cloud Function
    // picks it up. This will be wired in Phase 2.
    let userCredential;
    try {
        // We use the invite's orgId as the email domain isn't constrained —
        // the invite document is the access control.
        userCredential = await createUserWithEmailAndPassword(auth, invite.email, password);
    } catch (err) {
        return { ok: false, error: friendlyAuthError(err.code) };
    }

    // 5. Mark the invite as redeemed
    try {
        await updateDoc(inviteRef, {
            redeemed: true,
            redeemedAt: serverTimestamp(),
            redeemedBy: userCredential.user.uid
        });
    } catch {
        // Non-fatal — invite may be marked redeemed on next sign-in check
        console.warn('LORE: Could not mark invite as redeemed.');
    }

    return { ok: true, role: invite.role, orgId: invite.orgId };
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
        if (!orgId || !role) return null;
        return { orgId, role, uid: user.uid, email: user.email };
    } catch {
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

// ---------------------------------------------------------------------------
// Map Firebase Auth error codes to plain language messages.
// The user should never see a raw Firebase error code.
// ---------------------------------------------------------------------------
function friendlyAuthError(code) {
    const map = {
        'auth/invalid-email':          'That email address doesn\'t look right.',
        'auth/user-not-found':         'We couldn\'t find an account with that email.',
        'auth/wrong-password':         'That password isn\'t correct.',
        'auth/invalid-credential':     'Your email or password isn\'t correct.',
        'auth/too-many-requests':      'Too many attempts. Please wait a moment and try again.',
        'auth/email-already-in-use':   'An account with that email already exists.',
        'auth/weak-password':          'Your password needs to be at least 8 characters.',
        'auth/network-request-failed': 'Check your connection and try again.',
    };
    return map[code] || 'Something went wrong. Please try again.';
}