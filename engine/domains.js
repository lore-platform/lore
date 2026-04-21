// =============================================================================
// LORE — Domains Engine
// Manages the org's skill area taxonomy, which emerges from their recipes —
// never imposed by LORE from outside.
//
// How domains work:
//   1. Recipes accumulate in Firestore.
//   2. When enough recipes exist, AI clusters them by semantic similarity.
//   3. The Manager sees proposed clusters — they can confirm, rename, merge,
//      split, or move individual recipes between clusters.
//   4. Confirmed clusters become the org's official domains.
//
// Clustering is a batch job — it runs when new recipes are approved,
// not on every page load. This file handles reads (for training, dashboard),
// writes (confirming, renaming, merging clusters), and triggering the
// clustering job when the recipe count crosses a useful threshold.
//
// Import paths: this file imports firebase.js from the repo root directly.
// This is correct for the flat repo structure — engine/ files use ./firebase.js.
// =============================================================================

import { db } from './firebase.js';
import {
    collection,
    doc,
    getDocs,
    getDoc,
    addDoc,
    updateDoc,
    deleteDoc,
    serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { generate, extractJSON } from './ai.js';

// ---------------------------------------------------------------------------
// [TUNING TARGET] Minimum recipes before clustering is worth triggering.
// Below this count there is not enough material for meaningful clusters.
// ---------------------------------------------------------------------------
const MIN_RECIPES_FOR_CLUSTERING = 3;

// ---------------------------------------------------------------------------
// Get all confirmed domains for an org.
// Returns an array of domain objects: { id, name, description, recipeIds[] }.
// Used by training.js to render the domain selection screen.
// ---------------------------------------------------------------------------
export async function getDomains(orgId) {
    try {
        const ref = collection(db, 'organisations', orgId, 'domains');
        const snap = await getDocs(ref);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
        console.warn('LORE Domains: Could not fetch domains.', err);
        return [];
    }
}

// ---------------------------------------------------------------------------
// Get a single domain by ID.
// Returns the domain object or null.
// ---------------------------------------------------------------------------
export async function getDomain(orgId, domainId) {
    try {
        const snap = await getDoc(doc(db, 'organisations', orgId, 'domains', domainId));
        if (!snap.exists()) return null;
        return { id: snap.id, ...snap.data() };
    } catch (err) {
        console.warn('LORE Domains: Could not fetch domain.', err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Confirm a proposed cluster as an official domain.
// Called when the Manager accepts AI-proposed clusters, potentially after
// renaming or adjusting recipe membership.
//
// domain: { name, description, recipeIds[] }
// Returns the new domain ID or null on failure.
// ---------------------------------------------------------------------------
export async function confirmDomain(orgId, domain) {
    try {
        const ref = collection(db, 'organisations', orgId, 'domains');
        const added = await addDoc(ref, {
            name:        domain.name,
            description: domain.description ?? '',
            recipeIds:   domain.recipeIds   ?? [],
            confirmedAt: serverTimestamp(),
        });
        return added.id;
    } catch (err) {
        console.warn('LORE Domains: Could not confirm domain.', err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Update an existing confirmed domain — used when the Manager renames or
// adjusts recipe membership after initial confirmation.
// Returns true on success, false on failure.
// ---------------------------------------------------------------------------
export async function updateDomain(orgId, domainId, updates) {
    try {
        await updateDoc(
            doc(db, 'organisations', orgId, 'domains', domainId),
            { ...updates, updatedAt: serverTimestamp() }
        );
        return true;
    } catch (err) {
        console.warn('LORE Domains: Could not update domain.', err);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Delete a domain — used when the Manager merges two clusters into one.
// Recipes from the deleted domain should be moved to another domain first.
// Returns true on success.
// ---------------------------------------------------------------------------
export async function deleteDomain(orgId, domainId) {
    try {
        await deleteDoc(doc(db, 'organisations', orgId, 'domains', domainId));
        return true;
    } catch (err) {
        console.warn('LORE Domains: Could not delete domain.', err);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Get pending (AI-proposed but not yet confirmed) domain clusters.
// These are stored under the org profile document as a transient field —
// set by the clustering job and cleared when the Manager acts on them.
// Returns an array of cluster objects or an empty array.
// ---------------------------------------------------------------------------
export async function getPendingClusters(orgId) {
    try {
        const snap = await getDoc(doc(db, 'organisations', orgId, 'profile'));
        if (!snap.exists()) return [];
        return snap.data().proposedClusters ?? [];
    } catch (err) {
        console.warn('LORE Domains: Could not fetch pending clusters.', err);
        return [];
    }
}

// ---------------------------------------------------------------------------
// Clear the pending cluster proposals after the Manager has acted on them.
// Called after the Manager confirms, dismisses, or reorganises the proposals.
// ---------------------------------------------------------------------------
export async function clearPendingClusters(orgId) {
    try {
        await updateDoc(doc(db, 'organisations', orgId, 'profile'), {
            proposedClusters:      [],
            lastClusterReviewedAt: serverTimestamp(),
        });
    } catch (err) {
        console.warn('LORE Domains: Could not clear pending clusters.', err);
    }
}

// ---------------------------------------------------------------------------
// Trigger a domain clustering run over the org's approved recipes.
// This is the batch job — it calls AI to find semantic groupings, then
// stores the proposals in the org profile for the Manager to review.
//
// Only runs if there are enough approved recipes to make clustering useful.
// Does not overwrite existing confirmed domains — only produces new proposals.
//
// Returns { ok: true, clusters[] } or { ok: false, reason }.
// ---------------------------------------------------------------------------
export async function triggerClustering(orgId, recipes) {
    // Guard: not enough content to form meaningful clusters yet
    if (!recipes || recipes.length < MIN_RECIPES_FOR_CLUSTERING) {
        return { ok: false, reason: 'NOT_ENOUGH_RECIPES' };
    }

    const systemPrompt = `You are organising a set of professional skill recipes into coherent skill areas for an organisation.
Each recipe has a skill name and a trigger condition.
Your job is to group them into clusters where each cluster represents one distinct skill area.
Return a JSON array of cluster objects. Each object must have exactly these fields:
{
  "name": "Short skill area name — 2 to 4 words, plain language, no jargon",
  "description": "One sentence describing what this skill area covers",
  "recipeIds": ["array", "of", "recipe", "ids", "in", "this", "cluster"]
}
Use every recipe ID exactly once. Do not create clusters with fewer than 2 recipes if avoidable.
Return the JSON array only — no other text, no markdown fences.`;

    const prompt = `Group these professional skill recipes into skill areas:

${recipes.map(r =>
    `ID: ${r.id}\nSkill: ${r.skillName}\nTrigger: ${r.trigger}`
).join('\n\n')}

Return a JSON array of cluster objects.`;

    const result = await generate(prompt, systemPrompt);
    if (!result.ok) {
        return { ok: false, reason: 'AI_UNAVAILABLE' };
    }

    const clusters = extractJSON(result.text);
    if (!clusters || !Array.isArray(clusters) || clusters.length === 0) {
        return { ok: false, reason: 'PARSE_FAILED' };
    }

    // Store the proposed clusters in the org profile for Manager review
    try {
        await updateDoc(doc(db, 'organisations', orgId, 'profile'), {
            proposedClusters: clusters,
            lastClusteredAt:  serverTimestamp(),
        });
    } catch (err) {
        // Non-fatal — return the clusters in-memory even if storage failed
        console.warn('LORE Domains: Could not store proposed clusters.', err);
    }

    return { ok: true, clusters };
}