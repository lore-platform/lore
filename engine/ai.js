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

// ---------------------------------------------------------------------------
// JSON extraction — five-pass recovery strategy.
// Handles: markdown fences, partial JSON, truncated strings, missing brackets.
// Returns the parsed object/array, or null if all five passes fail.
//
// Usage: const data = extractJSON(aiResponse.text);
//        if (!data) { /* fall back to stored content */ }
// ---------------------------------------------------------------------------
export function extractJSON(text) {
    if (!text) return null;

    // Pass 1: strip markdown fences and parse directly
    try {
        const stripped = text.replace(/```(?:json)?\n?/g, '').trim();
        return JSON.parse(stripped);
    } catch {}

    // Pass 2: find first {...} block
    try {
        const start = text.indexOf('{');
        const end   = text.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) {
            return JSON.parse(text.slice(start, end + 1));
        }
    } catch {}

    // Pass 3: find first [...] block
    try {
        const start = text.indexOf('[');
        const end   = text.lastIndexOf(']');
        if (start !== -1 && end !== -1 && end > start) {
            return JSON.parse(text.slice(start, end + 1));
        }
    } catch {}

    // Pass 4: repair truncated strings
    // Truncate to last safe closing brace and try again
    try {
        const lastBrace = text.lastIndexOf('}');
        if (lastBrace !== -1) {
            const truncated = text.slice(0, lastBrace + 1);
            return JSON.parse(truncated);
        }
    } catch {}

    // Pass 5: bracket-balancing walk
    // Walk the string counting opens vs closes, cut at the point they balance
    try {
        const start = text.indexOf('{');
        if (start !== -1) {
            let depth = 0;
            let inString = false;
            let escaped = false;
            for (let i = start; i < text.length; i++) {
                const ch = text[i];
                if (escaped) { escaped = false; continue; }
                if (ch === '\\' && inString) { escaped = true; continue; }
                if (ch === '"') { inString = !inString; continue; }
                if (inString) continue;
                if (ch === '{') depth++;
                if (ch === '}') {
                    depth--;
                    if (depth === 0) {
                        return JSON.parse(text.slice(start, i + 1));
                    }
                }
            }
        }
    } catch {}

    // All five passes failed
    console.warn('LORE ai.js: JSON extraction failed after five passes. Raw text sample:', text.slice(0, 200));
    return null;
}