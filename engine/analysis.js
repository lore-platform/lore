// =============================================================================
// LORE — Corpus Analysis Engine (CORP-02)
// Pure code. No AI calls. Reads the responses/ corpus and produces structured
// analysis data for the Manager and the extraction pipeline.
//
// Four exported functions:
//
//   getAccuracyByScenarioAndSeniority(orgId, scenarioId)
//     — Verdict distribution grouped by seniority for a specific scenario.
//       Used in the Manager's review queue to understand whether a scenario
//       reliably separates senior from junior responses.
//
//   flagHighSignalResponses(orgId)
//     — Identifies responses where a senior employee got the verdict correct
//       on a scenario that junior employees predominantly missed.
//       Sets flaggedForExtraction: true on those senior response documents.
//       This is the bridge between the training loop and the extraction pipeline.
//       Returns the count of newly flagged documents.
//
//   getGapMap(orgId, uid)
//     — Compares a specific employee's verdict distribution against senior
//       employees for the same scenario types and domains.
//       Returns a structured gap map: { [domain]: { [scenarioType]: gapLevel } }
//       where gapLevel is 'none' | 'small' | 'significant'.
//       Used by the Manager for track assignment decisions.
//
//   getOrgConsensusPattern(orgId, domain)
//     — Fetches correct-verdict responses from senior employees in a domain.
//       Returns grouped response data ready to be consumed by deriveFromCorpus()
//       in recipes.js. No AI call here — only selection and grouping.
//
// Import paths: engine/ files import firebase.js from the repo root using ../firebase.js.
// All functions are named exports.
// =============================================================================

import { db } from '../firebase.js';
import {
    collection,
    query,
    where,
    getDocs,
    updateDoc,
    doc,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ---------------------------------------------------------------------------
// Seniority tiers — used to classify responses as junior or senior for
// gap analysis and high-signal flagging.
// [TUNING TARGET] If the org uses different seniority labels, update here.
// ---------------------------------------------------------------------------
const JUNIOR_SENIORITY  = ['junior'];
const SENIOR_SENIORITY  = ['senior'];

// ---------------------------------------------------------------------------
// Gap thresholds — used by getGapMap() to classify verdict rate differences.
// [TUNING TARGET] Adjust if the definition of "significant" gap needs to change.
// A 'significant' gap means the employee's correct rate is more than 25 percentage
// points below the senior benchmark. A 'small' gap is 10–25 points.
// ---------------------------------------------------------------------------
const GAP_SIGNIFICANT_THRESHOLD = 0.25;
const GAP_SMALL_THRESHOLD        = 0.10;

// ---------------------------------------------------------------------------
// Minimum response count — a group needs at least this many responses before
// we trust the statistics enough to act on them.
// [TUNING TARGET] Raise if the org is large and has many responses per scenario.
// ---------------------------------------------------------------------------
const MIN_RESPONSE_COUNT = 3;


// =============================================================================
// getAccuracyByScenarioAndSeniority(orgId, scenarioId)
//
// Queries the responses corpus for all responses to a specific scenario, then
// groups the verdicts by seniority tier.
//
// Returns an object shaped like:
//   {
//     junior:  { correct: N, partial: N, missed: N, total: N },
//     mid:     { correct: N, partial: N, missed: N, total: N },
//     senior:  { correct: N, partial: N, missed: N, total: N },
//   }
//
// A seniority tier is omitted from the result if no responses exist for it.
// Returns an empty object if the query fails or there are no responses.
// =============================================================================

/**
 * Returns verdict counts grouped by seniority for a given scenario.
 *
 * @param {string} orgId      - The organisation ID.
 * @param {string} scenarioId - The scenario to analyse.
 * @returns {Promise<Object>} Verdict counts per seniority tier.
 */
export async function getAccuracyByScenarioAndSeniority(orgId, scenarioId) {
    if (!orgId || !scenarioId) return {};

    console.log('LORE analysis.js: getAccuracyByScenarioAndSeniority — scenario:', scenarioId);

    try {
        const ref  = collection(db, 'organisations', orgId, 'responses');
        const q    = query(ref, where('scenarioId', '==', scenarioId));
        const snap = await getDocs(q);

        if (snap.empty) return {};

        // Accumulate verdict counts per seniority tier.
        const result = {};

        snap.docs.forEach(d => {
            const data     = d.data();
            const seniority = data.seniority ?? 'unknown';
            const verdict   = data.verdict   ?? 'unknown';

            if (!result[seniority]) {
                result[seniority] = { correct: 0, partial: 0, missed: 0, total: 0 };
            }

            result[seniority].total++;
            if (verdict === 'correct') result[seniority].correct++;
            else if (verdict === 'partial') result[seniority].partial++;
            else if (verdict === 'missed')  result[seniority].missed++;
        });

        console.log('LORE analysis.js: Accuracy by seniority for scenario', scenarioId, '—', JSON.stringify(result));
        return result;

    } catch (err) {
        console.warn('LORE analysis.js: getAccuracyByScenarioAndSeniority failed.', err);
        return {};
    }
}


// =============================================================================
// flagHighSignalResponses(orgId)
//
// This is the core bridge between the training corpus and the extraction pipeline.
//
// Logic:
//   For each scenario in the corpus:
//     1. Find all senior responses with a correct verdict.
//     2. Find all junior responses and check if the majority missed the scenario.
//     3. If junior majority is 'missed' AND senior responses are correct, those
//        senior responses are high-signal: they demonstrate expert judgement that
//        novices consistently lack. Set flaggedForExtraction: true on them.
//
// "Majority missed" means more than half of the junior responses for that
// scenario have a 'missed' verdict.
//
// Only flags responses that are not already flagged — avoids double-flagging
// responses that were flagged but not yet processed by deriveFromCorpus().
//
// Returns the count of newly flagged response documents.
// Returns 0 if there is nothing to flag or the query fails.
// =============================================================================

/**
 * Identifies high-signal senior responses and sets flaggedForExtraction: true
 * on their Firestore documents. Returns the count of newly flagged documents.
 *
 * @param {string} orgId - The organisation ID.
 * @returns {Promise<number>} Count of newly flagged response documents.
 */
export async function flagHighSignalResponses(orgId) {
    if (!orgId) return 0;

    console.log('LORE analysis.js: flagHighSignalResponses — orgId:', orgId);

    try {
        // Fetch all senior-correct responses that are not yet flagged.
        // We need the scenarioId to cross-reference with junior responses.
        const ref     = collection(db, 'organisations', orgId, 'responses');
        const seniorQ = query(
            ref,
            where('seniority', 'in', SENIOR_SENIORITY),
            where('verdict',   '==', 'correct'),
            where('flaggedForExtraction', '==', false)
        );
        const seniorSnap = await getDocs(seniorQ);

        if (seniorSnap.empty) {
            console.log('LORE analysis.js: No unflagged senior-correct responses found.');
            return 0;
        }

        // Build a map of scenarioId → [senior response docs]
        const seniorByScenario = {};
        seniorSnap.docs.forEach(d => {
            const scenarioId = d.data().scenarioId;
            if (!scenarioId) return;   // responses without a scenarioId cannot be grouped
            if (!seniorByScenario[scenarioId]) seniorByScenario[scenarioId] = [];
            seniorByScenario[scenarioId].push({ id: d.id, ...d.data() });
        });

        const scenarioIds = Object.keys(seniorByScenario);
        if (scenarioIds.length === 0) return 0;

        console.log('LORE analysis.js: Checking', scenarioIds.length, 'unique scenarios for junior miss patterns.');

        let newlyFlagged = 0;

        for (const scenarioId of scenarioIds) {
            // Fetch junior responses for this scenario.
            const juniorQ = query(
                ref,
                where('scenarioId', '==', scenarioId),
                where('seniority',  'in', JUNIOR_SENIORITY)
            );
            const juniorSnap = await getDocs(juniorQ);

            // Skip if not enough junior responses to establish a pattern.
            if (juniorSnap.size < MIN_RESPONSE_COUNT) continue;

            const juniorDocs   = juniorSnap.docs.map(d => d.data());
            const juniorMissed = juniorDocs.filter(d => d.verdict === 'missed').length;
            const juniorTotal  = juniorDocs.length;

            // "Majority missed" = more than half of the junior responses missed.
            const juniorMajorityMissed = juniorMissed / juniorTotal > 0.5;

            if (!juniorMajorityMissed) continue;

            // Flag all unflagged senior-correct responses for this scenario.
            const seniorDocs = seniorByScenario[scenarioId];
            for (const seniorResponse of seniorDocs) {
                try {
                    await updateDoc(doc(db, 'organisations', orgId, 'responses', seniorResponse.id), {
                        flaggedForExtraction: true,
                    });
                    newlyFlagged++;
                    console.log('LORE analysis.js: Flagged senior response:', seniorResponse.id, '— scenario:', scenarioId, '— junior miss rate:', Math.round(juniorMissed / juniorTotal * 100) + '%');
                } catch (err) {
                    console.warn('LORE analysis.js: Could not flag response:', seniorResponse.id, err);
                }
            }
        }

        console.log('LORE analysis.js: flagHighSignalResponses complete — newly flagged:', newlyFlagged);
        return newlyFlagged;

    } catch (err) {
        console.warn('LORE analysis.js: flagHighSignalResponses failed.', err);
        return 0;
    }
}


// =============================================================================
// getGapMap(orgId, uid)
//
// Produces a map of where a specific employee's performance falls short of
// the senior benchmark, broken down by domain and scenario type.
//
// For each combination of (domain, scenarioType) where the employee has at
// least MIN_RESPONSE_COUNT responses:
//   — Compute their correct rate.
//   — Compute the senior correct rate for the same combination.
//   — Classify the gap as 'none', 'small', or 'significant'.
//
// Returns:
//   {
//     [domain]: {
//       [scenarioType]: {
//         gapLevel:         'none' | 'small' | 'significant',
//         employeeRate:     0–1 (fraction correct),
//         seniorRate:       0–1 (fraction correct),
//         employeeCount:    number of employee responses used,
//         seniorCount:      number of senior responses used,
//       }
//     }
//   }
//
// Domains or scenario types with fewer than MIN_RESPONSE_COUNT responses from
// the employee are omitted — not enough data to compute a meaningful gap.
//
// Returns an empty object if the query fails.
// =============================================================================

/**
 * Computes a performance gap map for a specific employee against the
 * senior cohort, by domain and scenario type.
 *
 * @param {string} orgId - The organisation ID.
 * @param {string} uid   - The employee's user ID.
 * @returns {Promise<Object>} Gap map object keyed by domain and scenario type.
 */
export async function getGapMap(orgId, uid) {
    if (!orgId || !uid) return {};

    console.log('LORE analysis.js: getGapMap — orgId:', orgId, 'uid:', uid);

    try {
        const ref = collection(db, 'organisations', orgId, 'responses');

        // Fetch the employee's responses and all senior responses in parallel.
        const [employeeSnap, seniorSnap] = await Promise.all([
            getDocs(query(ref, where('uid', '==', uid))),
            getDocs(query(ref, where('seniority', 'in', SENIOR_SENIORITY), where('verdict', '==', 'correct'))),
        ]);

        if (employeeSnap.empty) return {};

        // Build a lookup of senior correct rates by (domain, scenarioType).
        // seniorRates[domain][scenarioType] = { correct: N, total: N }
        const seniorRates = {};
        seniorSnap.docs.forEach(d => {
            const { domain, scenarioType, verdict } = d.data();
            if (!domain || !scenarioType) return;
            if (!seniorRates[domain]) seniorRates[domain] = {};
            if (!seniorRates[domain][scenarioType]) seniorRates[domain][scenarioType] = { correct: 0, total: 0 };
            seniorRates[domain][scenarioType].total++;
            if (verdict === 'correct') seniorRates[domain][scenarioType].correct++;
        });

        // Build the employee's verdict counts by (domain, scenarioType).
        const employeeRates = {};
        employeeSnap.docs.forEach(d => {
            const { domain, scenarioType, verdict } = d.data();
            if (!domain || !scenarioType) return;
            if (!employeeRates[domain]) employeeRates[domain] = {};
            if (!employeeRates[domain][scenarioType]) {
                employeeRates[domain][scenarioType] = { correct: 0, total: 0 };
            }
            employeeRates[domain][scenarioType].total++;
            if (verdict === 'correct') employeeRates[domain][scenarioType].correct++;
        });

        // Compute the gap map by comparing each (domain, scenarioType) cell.
        const gapMap = {};

        for (const domain of Object.keys(employeeRates)) {
            for (const scenarioType of Object.keys(employeeRates[domain])) {
                const empStats = employeeRates[domain][scenarioType];

                // Skip cells with too few data points.
                if (empStats.total < MIN_RESPONSE_COUNT) continue;

                const empRate    = empStats.correct / empStats.total;
                const senStats   = seniorRates[domain]?.[scenarioType];
                const seniorRate = senStats && senStats.total > 0
                    ? senStats.correct / senStats.total
                    : null;

                // If no senior data exists for this cell, we cannot compute a gap.
                if (seniorRate === null) continue;

                const gap      = seniorRate - empRate;
                let   gapLevel = 'none';
                if (gap >= GAP_SIGNIFICANT_THRESHOLD) gapLevel = 'significant';
                else if (gap >= GAP_SMALL_THRESHOLD)  gapLevel = 'small';

                if (!gapMap[domain]) gapMap[domain] = {};
                gapMap[domain][scenarioType] = {
                    gapLevel,
                    employeeRate:  parseFloat(empRate.toFixed(2)),
                    seniorRate:    parseFloat(seniorRate.toFixed(2)),
                    employeeCount: empStats.total,
                    seniorCount:   senStats.total,
                };
            }
        }

        console.log('LORE analysis.js: getGapMap complete — domains with gaps:', Object.keys(gapMap).length);
        return gapMap;

    } catch (err) {
        console.warn('LORE analysis.js: getGapMap failed.', err);
        return {};
    }
}


// =============================================================================
// getOrgConsensusPattern(orgId, domain)
//
// Fetches correct-verdict responses from senior-seniority employees in the
// given domain and groups them by scenarioId (or scenarioType as fallback).
//
// This is the data selection layer for deriveFromCorpus() in recipes.js.
// No AI call happens here — this function only reads and groups Firestore data.
// The grouped output is passed directly to deriveFromCorpus() which runs the
// AI pipeline on each group.
//
// Returns:
//   [
//     {
//       scenarioId:   string | null,
//       scenarioType: string | null,
//       domain:       string,
//       responses:    [responseText strings],
//       responseIds:  [Firestore document IDs],
//       scenarioText: string | null,   — the rawPrompt / scenario text
//     }
//   ]
//
// Returns an empty array if the query fails or no qualifying responses exist.
// =============================================================================

/**
 * Returns grouped senior-correct responses for a domain, ready for corpus derivation.
 *
 * @param {string} orgId   - The organisation ID.
 * @param {string} domain  - The skill area to fetch responses for.
 * @returns {Promise<Array>} Array of response groups, each with responseText and metadata.
 */
export async function getOrgConsensusPattern(orgId, domain) {
    if (!orgId || !domain) return [];

    console.log('LORE analysis.js: getOrgConsensusPattern — orgId:', orgId, 'domain:', domain);

    try {
        const ref = collection(db, 'organisations', orgId, 'responses');
        const q   = query(
            ref,
            where('domain',    '==', domain),
            where('seniority', 'in', SENIOR_SENIORITY),
            where('verdict',   '==', 'correct')
        );
        const snap = await getDocs(q);

        if (snap.empty) {
            console.log('LORE analysis.js: No senior-correct responses found for domain:', domain);
            return [];
        }

        // Group by scenarioId (preferred) or scenarioType (fallback).
        const groups = {};
        snap.docs.forEach(d => {
            const data     = d.data();
            const groupKey = data.scenarioId
                ? `scenario:${data.scenarioId}`
                : `type:${data.scenarioType ?? 'unknown'}`;

            if (!groups[groupKey]) {
                groups[groupKey] = {
                    scenarioId:   data.scenarioId   ?? null,
                    scenarioType: data.scenarioType ?? null,
                    domain,
                    scenarioText: null,
                    responses:    [],
                    responseIds:  [],
                };
            }

            // Capture scenario text from the first response that has it.
            if (!groups[groupKey].scenarioText && data.rawPrompt) {
                groups[groupKey].scenarioText = data.rawPrompt;
            }

            groups[groupKey].responses.push(data.responseText ?? '');
            groups[groupKey].responseIds.push(d.id);
        });

        const result = Object.values(groups).filter(g => g.responses.length > 0);
        console.log('LORE analysis.js: getOrgConsensusPattern — found', result.length, 'response groups for domain:', domain);
        return result;

    } catch (err) {
        console.warn('LORE analysis.js: getOrgConsensusPattern failed.', err);
        return [];
    }
}
