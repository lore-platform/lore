// =============================================================================
// Lab — model-fit.js
// Decision tree fitting, bootstrapped (bagged) prediction, policy break
// detection, plain-language policy summary generation, and triad selection.
//
// This file is pure logic plus one AI call (generatePolicySummary). No
// Firestore reads/writes happen here — session.js, model-view.js, and
// elicitation.js call these functions and persist the results via db.js.
//
// -----------------------------------------------------------------------
// WHY BAGGING + OUT-OF-BAG (OOB) EVALUATION, NOT JUST ONE TREE
// -----------------------------------------------------------------------
// A single decision tree fit on all 30 scenarios and then tested against
// those same 30 scenarios will "predict" almost everything correctly —
// not because the model has found the expert's real policy, but because
// it has memorised the answers. Any "policy break" found that way would
// mostly be noise from an overfit tree, not a genuine break in behaviour.
//
// Instead:
//   1. fitDecisionTree() — ONE shallow tree fit on all 30 scenarios. This
//      is the canonical, storable, human-readable policy tree.
//   2. buildForest() — 25 trees, each fit on a bootstrap resample (30
//      scenarios drawn with replacement). Each tree also records which
//      original scenarios were left OUT of its resample — its
//      "out-of-bag" (OOB) scenarios.
//   3. detectPolicyBreaks() — for every scenario, predicts its label
//      using ONLY the trees that never trained on it (its OOB trees).
//      This is the standard honest way to test a bagged model against
//      data it did not fit — even with a sample this small. If the OOB
//      majority disagrees with what the expert actually chose, AND the
//      forest was reasonably confident (>=60% of OOB trees agreed with
//      each other), that is a genuine policy break. If the OOB trees
//      themselves were split and unsure, it isn't a meaningful break —
//      the model didn't have a strong expectation to violate — so it's
//      filtered out.
//
// [TUNING TARGET] All thresholds below are conservative for a ~30-row,
// ~5-9-cue dataset. Revisit if session length or cue count changes.
// =============================================================================

import { classify } from '../engine/ai.js';
import { extractJSON } from '../engine/utils.js';

const MAX_DEPTH            = 3;   // shallow — avoids overfitting on 30 rows
const MIN_SAMPLES_SPLIT    = 4;   // a node needs at least this many samples to split further
const MIN_SAMPLES_LEAF     = 2;   // a split is rejected if it would create a leaf smaller than this
const NUM_TREES            = 25;  // forest size for bagging
const MIN_OOB_TREES        = 3;   // a scenario needs at least this many OOB trees to be evaluated fairly
const BREAK_CONFIDENCE_MIN = 0.6; // OOB trees must agree on the "expected" label at least this often
const MAX_BREAKS_RETURNED  = 3;   // Screen 7 wants 2-3 cases

// =============================================================================
// Shared tree-building internals
// =============================================================================

// ---------------------------------------------------------------------------
// _entropy(labels) — Shannon entropy of a list of class labels (base 2).
// ---------------------------------------------------------------------------
function _entropy(labels) {
    if (labels.length === 0) return 0;
    const counts = {};
    labels.forEach(l => { counts[l] = (counts[l] ?? 0) + 1; });
    const total = labels.length;
    return -Object.values(counts).reduce((sum, c) => {
        const p = c / total;
        return sum + p * Math.log2(p);
    }, 0);
}

// ---------------------------------------------------------------------------
// _majorityLabel(labels) — most frequent label, with a distribution map.
// Ties broken by first-seen order (deterministic, not random).
// ---------------------------------------------------------------------------
function _majorityLabel(labels) {
    const counts = {};
    labels.forEach(l => { counts[l] = (counts[l] ?? 0) + 1; });
    let best = null;
    let bestCount = -1;
    for (const l of labels) {
        if (counts[l] > bestCount) { best = l; bestCount = counts[l]; }
    }
    return { label: best, distribution: counts };
}

// ---------------------------------------------------------------------------
// _bestSplit(samples, cueIds) — tries every candidate cue, returns the one
// with the highest information gain, plus the resulting branches.
// Split is multi-way categorical: one branch per distinct value actually
// present among the samples at this node (not every possible cue value —
// avoids empty branches on small samples).
//
// Returns null if no cue produces a valid split (respecting MIN_SAMPLES_LEAF
// and MIN_SAMPLES_SPLIT), or if every candidate has zero information gain.
// ---------------------------------------------------------------------------
function _bestSplit(samples, cueIds) {
    const parentLabels  = samples.map(s => s.label);
    const parentEntropy = _entropy(parentLabels);

    let best = null;

    for (const cueId of cueIds) {
        const groups = {};
        samples.forEach(s => {
            const value = s.cueCombination?.[cueId];
            if (value === undefined || value === null) return; // skip if cue absent on this sample
            if (!groups[value]) groups[value] = [];
            groups[value].push(s);
        });

        const branchValues = Object.keys(groups);
        // Need at least 2 branches for the split to mean anything.
        if (branchValues.length < 2) continue;
        // Reject splits that would create a leaf smaller than MIN_SAMPLES_LEAF.
        if (branchValues.some(v => groups[v].length < MIN_SAMPLES_LEAF)) continue;

        const weightedChildEntropy = branchValues.reduce((sum, v) => {
            const childLabels = groups[v].map(s => s.label);
            return sum + (groups[v].length / samples.length) * _entropy(childLabels);
        }, 0);

        const gain = parentEntropy - weightedChildEntropy;

        if (gain > 0 && (!best || gain > best.gain)) {
            best = { cueId, gain, groups };
        }
    }

    return best;
}

// ---------------------------------------------------------------------------
// _buildTreeNode(samples, cueLibrary, usedCueIds, depth) — recursive builder.
// samples: [{ cueCombination, label }]
// Returns a node:
//   Leaf:     { isLeaf: true,  label, samples, distribution }
//   Internal: { isLeaf: false, cueId, cueName, majorityLabel, samples,
//               branches: { [value]: childNode } }
// majorityLabel on internal nodes is the fallback prediction used when a
// cue value at prediction time was never seen during training.
// ---------------------------------------------------------------------------
function _buildTreeNode(samples, cueLibrary, usedCueIds, depth) {
    const labels = samples.map(s => s.label);
    const { label: majority, distribution } = _majorityLabel(labels);

    const isPure        = Object.keys(distribution).length === 1;
    const atDepthLimit   = depth >= MAX_DEPTH;
    const tooFewSamples  = samples.length < MIN_SAMPLES_SPLIT;

    if (isPure || atDepthLimit || tooFewSamples) {
        return { isLeaf: true, label: majority, samples: samples.length, distribution };
    }

    const candidateCueIds = cueLibrary
        .map(c => c.id)
        .filter(id => !usedCueIds.has(id));

    if (candidateCueIds.length === 0) {
        return { isLeaf: true, label: majority, samples: samples.length, distribution };
    }

    const split = _bestSplit(samples, candidateCueIds);

    if (!split) {
        // No cue improves purity enough to justify a split — stop here.
        return { isLeaf: true, label: majority, samples: samples.length, distribution };
    }

    const cue = cueLibrary.find(c => c.id === split.cueId);
    const nextUsed = new Set(usedCueIds);
    nextUsed.add(split.cueId);

    const branches = {};
    for (const value of Object.keys(split.groups)) {
        branches[value] = _buildTreeNode(split.groups[value], cueLibrary, nextUsed, depth + 1);
    }

    return {
        isLeaf:        false,
        cueId:         split.cueId,
        cueName:       cue?.name ?? split.cueId,
        majorityLabel: majority,
        samples:       samples.length,
        branches,
    };
}

// ---------------------------------------------------------------------------
// _toSamples(scenarios) — converts session.scenarios into the {cueCombination,
// label, scenarioId} shape used internally. structuredSelection (the id of
// the decision option the expert picked) is used as the class label.
// Scenarios missing either field are dropped — they can't be used for fitting.
// ---------------------------------------------------------------------------
function _toSamples(scenarios) {
    return (scenarios ?? [])
        .filter(s => s.cueCombination && s.structuredSelection)
        .map(s => ({
            scenarioId:     s.scenarioId,
            cueCombination: s.cueCombination,
            label:          s.structuredSelection,
        }));
}

// =============================================================================
// fitDecisionTree(scenarios, cueLibrary)
// Builds the single canonical tree on the full scenario set. This is the
// object saved to policyModel.decisionTree.tree.
// =============================================================================
export function fitDecisionTree(scenarios, cueLibrary) {
    const samples = _toSamples(scenarios);
    console.log('Lab model-fit.js: fitDecisionTree — samples:', samples.length, 'cues:', cueLibrary.length);

    if (samples.length === 0) {
        console.warn('Lab model-fit.js: No usable scenarios to fit a tree from.');
        return { isLeaf: true, label: null, samples: 0, distribution: {} };
    }

    return _buildTreeNode(samples, cueLibrary, new Set(), 0);
}

// =============================================================================
// predictWithTree(tree, cueCombination)
// Walks a single tree for a given cue combination. Falls back to the
// node's majorityLabel if a branch value was never seen during training.
// Returns the predicted label (string) or null if the tree is empty.
// =============================================================================
export function predictWithTree(tree, cueCombination) {
    let node = tree;
    while (node && !node.isLeaf) {
        const value = cueCombination?.[node.cueId];
        const child = value !== undefined ? node.branches[value] : undefined;
        if (!child) return node.majorityLabel;
        node = child;
    }
    return node ? node.label : null;
}

// =============================================================================
// buildForest(scenarios, cueLibrary)
// Builds NUM_TREES trees, each on a bootstrap resample of the scenarios.
// Returns an array of { tree, oobScenarioIds } — oobScenarioIds are the
// scenarioIds NOT included in that tree's bootstrap sample.
// =============================================================================
export function buildForest(scenarios, cueLibrary) {
    const samples = _toSamples(scenarios);
    const n = samples.length;
    console.log('Lab model-fit.js: buildForest — building', NUM_TREES, 'trees from', n, 'samples');

    if (n === 0) return [];

    const forest = [];

    for (let t = 0; t < NUM_TREES; t++) {
        const includedIdx = new Set();
        const resample = [];
        for (let i = 0; i < n; i++) {
            const pick = Math.floor(Math.random() * n);
            includedIdx.add(pick);
            resample.push(samples[pick]);
        }

        const oobScenarioIds = samples
            .filter((_, idx) => !includedIdx.has(idx))
            .map(s => s.scenarioId);

        const tree = _buildTreeNode(resample, cueLibrary, new Set(), 0);
        forest.push({ tree, oobScenarioIds });
    }

    return forest;
}

// =============================================================================
// predictWithForest(forest, cueCombination)
// Majority vote across every tree in the forest.
// Returns { label, confidence, votes } — confidence is the fraction of
// trees that agreed with the winning label. votes is the full count map.
// =============================================================================
export function predictWithForest(forest, cueCombination) {
    if (!forest || forest.length === 0) return { label: null, confidence: 0, votes: {} };

    const votes = {};
    forest.forEach(({ tree }) => {
        const label = predictWithTree(tree, cueCombination);
        if (label === null) return;
        votes[label] = (votes[label] ?? 0) + 1;
    });

    const totalVotes = Object.values(votes).reduce((a, b) => a + b, 0);
    if (totalVotes === 0) return { label: null, confidence: 0, votes };

    let winner = null;
    let winnerCount = -1;
    for (const label of Object.keys(votes)) {
        if (votes[label] > winnerCount) { winner = label; winnerCount = votes[label]; }
    }

    return { label: winner, confidence: winnerCount / totalVotes, votes };
}

// =============================================================================
// detectPolicyBreaks(scenarios, forest, cueLibrary, decisionOptions)
// For every scenario, predicts its label using only that scenario's OOB
// trees. Flags a break when:
//   - the scenario had at least MIN_OOB_TREES trees to evaluate it fairly
//   - the OOB majority disagrees with what the expert actually chose
//   - the OOB trees agreed with each other at least BREAK_CONFIDENCE_MIN
//     of the time (i.e. the model had a real expectation to violate)
//
// Returns the top MAX_BREAKS_RETURNED breaks, sorted by OOB confidence
// (highest first — the most surprising breaks lead).
//
// Each break: { scenarioId, expectedLabel, actualLabel, confidence,
//               cueCombination, description }
// `description` is a plain-language sentence built from cueLibrary and
// decisionOptions labels — this is what gets stored (as strings) in
// policyModel.policyBreaks.
// =============================================================================
export function detectPolicyBreaks(scenarios, forest, cueLibrary, decisionOptions) {
    const samples = _toSamples(scenarios);
    const breaks  = [];

    for (const sample of samples) {
        const oobTrees = forest.filter(f => f.oobScenarioIds.includes(sample.scenarioId));
        if (oobTrees.length < MIN_OOB_TREES) continue;

        const votes = {};
        oobTrees.forEach(({ tree }) => {
            const label = predictWithTree(tree, sample.cueCombination);
            if (label === null) return;
            votes[label] = (votes[label] ?? 0) + 1;
        });

        const totalVotes = Object.values(votes).reduce((a, b) => a + b, 0);
        if (totalVotes === 0) continue;

        let expected = null;
        let expectedCount = -1;
        for (const label of Object.keys(votes)) {
            if (votes[label] > expectedCount) { expected = label; expectedCount = votes[label]; }
        }
        const confidence = expectedCount / totalVotes;

        if (expected !== sample.label && confidence >= BREAK_CONFIDENCE_MIN) {
            breaks.push({
                scenarioId:     sample.scenarioId,
                expectedLabel:  expected,
                actualLabel:    sample.label,
                confidence,
                cueCombination: sample.cueCombination,
                description: _describeBreak(sample, expected, cueLibrary, decisionOptions),
            });
        }
    }

    breaks.sort((a, b) => b.confidence - a.confidence);
    console.log('Lab model-fit.js: detectPolicyBreaks — found', breaks.length, 'candidate breaks');
    return breaks.slice(0, MAX_BREAKS_RETURNED);
}

// ---------------------------------------------------------------------------
// _describeBreak — builds a plain-language sentence for one break, resolving
// cue ids and option ids to their human-readable names/labels.
// ---------------------------------------------------------------------------
function _describeBreak(sample, expectedLabel, cueLibrary, decisionOptions) {
    const cueBits = Object.entries(sample.cueCombination)
        .map(([cueId, value]) => {
            const cue = cueLibrary.find(c => c.id === cueId);
            return cue ? `${cue.name}: ${value}` : null;
        })
        .filter(Boolean)
        .join(', ');

    const actualOpt   = decisionOptions.find(o => o.id === sample.label)?.label   ?? sample.label;
    const expectedOpt  = decisionOptions.find(o => o.id === expectedLabel)?.label ?? expectedLabel;

    return `In a scenario with ${cueBits}, you chose "${actualOpt}" — similar situations pointed to "${expectedOpt}".`;
}

// =============================================================================
// computeFeatureImportance(tree, cueLibrary)
// Walks the canonical tree, summing information gain weighted by the
// proportion of samples at each split, per cue. Returns cues sorted by
// importance descending, normalised to sum to 1 (or an empty array if the
// tree has no splits at all).
// =============================================================================
export function computeFeatureImportance(tree, cueLibrary) {
    const totals = {};

    function walk(node) {
        if (!node || node.isLeaf) return;

        const childLabelSets = Object.values(node.branches).map(child =>
            child.isLeaf
                ? Array(child.samples).fill(child.label)
                : Array(child.samples).fill(null) // internal children — approximate via their own leaves below
        );
        // Recompute entropy gain at this node directly from branch distributions
        // where available (leaf children), otherwise fall back to a rough
        // proportional weighting. This keeps importance approximate but stable.
        const parentSamples = node.samples;
        let weightedChildEntropy = 0;
        let anyDistributionKnown = false;

        Object.values(node.branches).forEach(child => {
            const dist = child.isLeaf ? child.distribution : _collectLeafDistribution(child);
            const labels = Object.entries(dist).flatMap(([label, count]) => Array(count).fill(label));
            if (labels.length > 0) {
                anyDistributionKnown = true;
                weightedChildEntropy += (child.samples / parentSamples) * _entropy(labels);
            }
        });

        if (anyDistributionKnown) {
            const parentDist   = _collectLeafDistribution(node);
            const parentLabels = Object.entries(parentDist).flatMap(([label, count]) => Array(count).fill(label));
            const gain = _entropy(parentLabels) - weightedChildEntropy;
            totals[node.cueId] = (totals[node.cueId] ?? 0) + Math.max(gain, 0) * parentSamples;
        }

        Object.values(node.branches).forEach(walk);
    }

    walk(tree);

    const total = Object.values(totals).reduce((a, b) => a + b, 0);
    if (total === 0) return [];

    return Object.entries(totals)
        .map(([cueId, weight]) => ({
            cueId,
            name:       cueLibrary.find(c => c.id === cueId)?.name ?? cueId,
            importance: weight / total,
        }))
        .sort((a, b) => b.importance - a.importance);
}

// ---------------------------------------------------------------------------
// _collectLeafDistribution — aggregates the label distribution across all
// leaves beneath a node (used by computeFeatureImportance for internal nodes).
// ---------------------------------------------------------------------------
function _collectLeafDistribution(node) {
    if (node.isLeaf) return node.distribution;
    const merged = {};
    Object.values(node.branches).forEach(child => {
        const childDist = _collectLeafDistribution(child);
        Object.entries(childDist).forEach(([label, count]) => {
            merged[label] = (merged[label] ?? 0) + count;
        });
    });
    return merged;
}

// =============================================================================
// _describeTreePaths(tree, cueLibrary, decisionOptions)
// Produces a short, human-readable list of the tree's root-to-leaf paths,
// sorted by sample count descending. Used only to build the prompt for
// generatePolicySummary — never shown to the expert directly.
// =============================================================================
function _describeTreePaths(tree, cueLibrary, decisionOptions) {
    const paths = [];

    function walk(node, conditions) {
        if (node.isLeaf) {
            const optLabel = decisionOptions.find(o => o.id === node.label)?.label ?? node.label;
            paths.push({
                conditions: conditions.length ? conditions.join(' AND ') : '(no condition — applies generally)',
                outcome:    optLabel,
                samples:    node.samples,
            });
            return;
        }
        Object.entries(node.branches).forEach(([value, child]) => {
            walk(child, [...conditions, `${node.cueName} = ${value}`]);
        });
    }

    walk(tree, []);
    paths.sort((a, b) => b.samples - a.samples);
    return paths.slice(0, 8); // cap — keeps the prompt focused on the strongest patterns
}

// =============================================================================
// generatePolicySummary(session, tree, featureImportance)
// The one AI call in this file. Turns the fitted tree + feature importance
// into 3-5 plain-language statements for Screen 6.
// Returns { ok: true, summaryText } or { ok: false }.
// summaryText is the 3-5 statements joined with '\n\n' — matches the
// policyModel.summaryText: string field in the data model. model-view.js
// splits on '\n\n' to render them as separate cards.
// =============================================================================
export async function generatePolicySummary(session, tree, featureImportance) {
    const p               = session.profile ?? {};
    const decisionOptions = session.decisionOptions ?? [];
    const cueLibrary      = session.cueLibrary ?? [];

    const paths      = _describeTreePaths(tree, cueLibrary, decisionOptions);
    const topCues    = featureImportance.slice(0, 5)
        .map(f => `${f.name} (${Math.round(f.importance * 100)}% of the pattern)`)
        .join(', ');

    const systemPrompt = `You are describing a professional's decision-making pattern back to them, in plain language, based on a statistical model fit to their own responses.
Write 3 to 5 short statements. Each should describe a real, specific pattern in how they decide — not a vague generality.
Ground every statement in the actual conditions and outcomes provided below. Do not invent patterns not supported by the data.
Write directly to the person ("You tend to...", "When X, you..."), in a neutral, observational tone — this is a mirror, not a judgement.

Return a JSON array of 3 to 5 strings only — no markdown fences, no other text.`;

    const prompt = `Area of expertise: ${p.role}

Most influential factors in their decisions, in order:
${topCues || 'No clear pattern emerged — the model could not confidently separate factors.'}

The strongest decision patterns found (condition → what they chose, with how many scenarios supported it):
${paths.map(pa => `- When ${pa.conditions}, they chose "${pa.outcome}" (${pa.samples} scenario${pa.samples === 1 ? '' : 's'})`).join('\n')}

Decision options available: ${decisionOptions.map(o => o.label).join(', ')}

Return a JSON array of 3-5 plain-language statements describing this decision pattern.`;

    const result = await classify(prompt, systemPrompt);
    if (!result.ok) {
        console.warn('Lab model-fit.js: generatePolicySummary — classify call failed.');
        return { ok: false };
    }

    const statements = extractJSON(result.text);
    if (!statements || !Array.isArray(statements) || statements.length === 0) {
        console.warn('Lab model-fit.js: generatePolicySummary — JSON extraction failed.');
        return { ok: false };
    }

    return { ok: true, summaryText: statements.join('\n\n') };
}

// =============================================================================
// selectTriad(scenarios, tree)
// Picks three scenarios for the Screen 7 repertory grid: two that land in
// the same tree leaf (handled the same way) and one from a different leaf
// (handled differently) — ideally one whose path diverges by only a single
// cue, so the discrimination is meaningful rather than trivially obvious.
//
// Returns { scenarioIds: [a, b, c] } or null if there aren't enough
// scenarios with distinct leaves to build a triad.
// =============================================================================
export function selectTriad(scenarios, tree) {
    const samples = _toSamples(scenarios);
    if (samples.length < 3) return null;

    // Group scenarios by which leaf they land in.
    const leafGroups = {};
    samples.forEach(s => {
        const leafKey = _leafPathKey(tree, s.cueCombination);
        if (!leafGroups[leafKey]) leafGroups[leafKey] = [];
        leafGroups[leafKey].push(s);
    });

    const leafKeys = Object.keys(leafGroups);
    const sameLeafKey = leafKeys.find(k => leafGroups[k].length >= 2);
    if (!sameLeafKey) return null;

    const otherLeafKey = leafKeys.find(k => k !== sameLeafKey && leafGroups[k].length >= 1);
    if (!otherLeafKey) return null;

    const [a, b] = leafGroups[sameLeafKey];
    const c       = leafGroups[otherLeafKey][0];

    return { scenarioIds: [a.scenarioId, b.scenarioId, c.scenarioId] };
}

// ---------------------------------------------------------------------------
// _leafPathKey — walks the tree for a cue combination and returns a string
// key identifying which leaf it lands in (used to group scenarios by leaf).
// ---------------------------------------------------------------------------
function _leafPathKey(tree, cueCombination) {
    let node = tree;
    let path = '';
    while (node && !node.isLeaf) {
        const value = cueCombination?.[node.cueId];
        path += `${node.cueId}=${value};`;
        const child = value !== undefined ? node.branches[value] : undefined;
        if (!child) break;
        node = child;
    }
    return path;
}
