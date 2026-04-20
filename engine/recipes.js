// =============================================================================
// LORE — Recipes Engine
// Reads Career Recipes from Firestore for display (after unlock) and for
// use in scenario generation and evaluation.
//
// Write operations (creating, approving recipes) are Manager-only and live
// in dashboard.js. This file handles reads used in the Training view.
// =============================================================================

import { db } from './firebase.js';
import {
    doc,
    getDoc,
    collection,
    getDocs,
    addDoc,
    query,
    where,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ---------------------------------------------------------------------------
// Get a single recipe by ID.
// Returns the recipe object or null.
// ---------------------------------------------------------------------------
export async function getRecipe(orgId, recipeId) {
    try {
        const snap = await getDoc(doc(db, 'organisations', orgId, 'recipes', recipeId));
        if (!snap.exists()) return null;
        return { id: snap.id, ...snap.data() };
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Get all approved recipes for a domain.
// Used to check if a domain has enough recipes for calibration (needs >= 5).
// Returns an array.
// ---------------------------------------------------------------------------
export async function getRecipesForDomain(orgId, domain) {
    try {
        const ref = collection(db, 'organisations', orgId, 'recipes');
        const q = query(ref, where('domain', '==', domain), where('approved', '==', true));
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Get all approved domains (skill areas) for an org.
// Used by the Training view to render the domain selection screen.
// Returns an array of domain objects: { id, name, recipeCount }.
// ---------------------------------------------------------------------------
export async function getDomains(orgId) {
    try {
        const ref = collection(db, 'organisations', orgId, 'domains');
        const snap = await getDocs(ref);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Save a recipe to the Employee's personal recipe library (after unlock).
// Idempotent — saving the same recipe twice is harmless.
// ---------------------------------------------------------------------------
export async function saveToLibrary(orgId, uid, recipe) {
    try {
        const ref = collection(
            db, 'organisations', orgId, 'users', uid, 'recipeLibrary'
        );
        await addDoc(ref, {
            recipeId:    recipe.id,
            skillName:   recipe.skillName,
            domain:      recipe.domain,
            savedAt:     serverTimestamp(),
        });
        return true;
    } catch {
        return false;
    }
}