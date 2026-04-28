// =============================================================================
// LORE — AI Engine
// All AI calls go through this file. Never directly from views.
//
// Two call types:
//   classify() — Flash-Lite, temp 0.2, tokens 1024. Used for evaluation,
//                classification, domain clustering.
//   generate() — Flash, temp 0.7, tokens 4096. Used for scenario generation,
//                feedback copy.
//
// Both route through the Cloudflare Worker proxy. Keys never touch the browser.
//
// JSON extraction uses a five-pass recovery strategy. If all five fail,
// returns null. Callers handle null by falling back to stored content.
// =============================================================================

// [TUNING TARGET] Worker URL — replace if Worker is redeployed under a new name
const WORKER_URL = 'https://lore-worker.slop-runner.workers.dev';

import { extractJSON } from './utils.js';
// Re-export so callers that import extractJSON from ai.js continue to work.
export { extractJSON };

// ---------------------------------------------------------------------------
// Classification call — for evaluation, extraction, clustering.
// Lower temperature, smaller output — fast and deterministic.
// Returns { ok: true, text } or { ok: false, error, quota }.
// ---------------------------------------------------------------------------
export async function classify(prompt, systemPrompt = '') {
    return _call({ mode: 'classify', prompt, systemPrompt });
}

// ---------------------------------------------------------------------------
// Generation call — for scenario generation, feedback, copy.
// Higher temperature, larger output — creative and varied.
// Returns { ok: true, text } or { ok: false, error, quota }.
// ---------------------------------------------------------------------------
export async function generate(prompt, systemPrompt = '') {
    return _call({ mode: 'generate', prompt, systemPrompt });
}

// ---------------------------------------------------------------------------
// Internal call — sends request to Worker, returns safe response shape.
// ---------------------------------------------------------------------------
async function _call({ mode, prompt, systemPrompt }) {
    console.log(`LORE ai.js: Calling Worker — mode: ${mode}, prompt length: ${prompt.length} chars`);
    try {
        const res = await fetch(WORKER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode, prompt, systemPrompt }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            console.warn('LORE ai.js: Worker returned error', res.status, err);
            return { ok: false, error: err.error ?? 'AI_ERROR', quota: err.quota ?? false };
        }

        const data = await res.json();
        console.log(`LORE ai.js: Worker responded OK — mode: ${mode}, response length: ${data?.text?.length ?? 0} chars`);
        return data;

    } catch (err) {
        console.warn('LORE ai.js: Fetch to Worker failed.', err.message);
        return { ok: false, error: 'NETWORK_ERROR', quota: false };
    }
}