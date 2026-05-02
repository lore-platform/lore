// =============================================================================
// LORE — Ingest Engine (PIPE-02)
// Code-only content processing layer. No AI calls anywhere in this file.
// No side effects except deduplicateCheck(), which reads Firestore.
//
// This file sits between raw content submission and the AI pipeline.
// Every piece of content passes through here before any AI call is made.
// The functions here are deterministic, fast, and testable in isolation.
//
// Responsibilities:
//   cleanText()         — normalise whitespace, strip HTML, remove boilerplate
//   detectLanguage()    — lightweight character-frequency language detection
//   hashContent()       — SHA-256 hex digest via Web Crypto API
//   countWords()        — split on whitespace, return integer
//   chunkDocument()     — 800-word chunks with 150-word overlap, paragraph-aware
//   shouldChunk()       — returns true if word count exceeds the chunk threshold
//   deduplicateCheck()  — Firestore read: has this content hash been seen before?
//
// Import paths: engine/ files import firebase.js from the repo root using ../firebase.js.
// All functions are named exports — no default export.
// =============================================================================

import { db } from '../firebase.js';
import {
    collection,
    query,
    where,
    limit,
    getDocs,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// [TUNING TARGET] Chunk size in words. 800 words is roughly one dense page —
// large enough to hold a complete thought, small enough for the AI to process
// accurately. Overlap prevents key ideas at chunk boundaries from being lost.
const CHUNK_WORD_LIMIT   = 800;
const CHUNK_OVERLAP_WORDS = 150;

// ---------------------------------------------------------------------------
// HTML boilerplate patterns to strip before processing.
// These patterns appear in copy-pasted web content and document exports.
// The list is conservative — only strip what is clearly structural noise.
// [TUNING TARGET] Add patterns here if recurring noise appears in submissions.
// ---------------------------------------------------------------------------
const BOILERPLATE_PATTERNS = [
    /cookie\s+policy/gi,
    /privacy\s+policy/gi,
    /terms\s+(of\s+)?(use|service)/gi,
    /all\s+rights\s+reserved/gi,
    /copyright\s+©?\s*\d{4}/gi,
    /subscribe\s+to\s+our\s+newsletter/gi,
    /click\s+here\s+to\s+(read|learn|find\s+out)\s+more/gi,
    /\[?\s*read\s+more\s*\]?/gi,
    /\bpage\s+\d+\s+of\s+\d+\b/gi,
    /\bconfidential\b.*?\bdo\s+not\s+distribute\b/gi,
];

// =============================================================================
// cleanText(rawText)
//
// Normalises a raw string for processing:
//   1. Strips HTML tags (handles nested, self-closing, and attribute-heavy tags).
//   2. Removes boilerplate phrases (cookie notices, legal footers, nav cruft).
//   3. Decodes common HTML entities (&amp; &lt; &gt; &nbsp; &quot; &#39;).
//   4. Normalises line endings to \n.
//   5. Collapses excessive whitespace — multiple spaces to one,
//      more than two consecutive blank lines to two.
//   6. Trims leading and trailing whitespace.
//
// Returns a plain-text string. Guaranteed to return a string even on empty input.
// Pure function — no side effects, no async.
// =============================================================================

/**
 * Cleans raw text by stripping HTML, decoding entities, removing boilerplate,
 * and normalising whitespace.
 *
 * @param {string} rawText - The raw input string (may contain HTML).
 * @returns {string} A clean, normalised plain-text string.
 */
export function cleanText(rawText) {
    if (!rawText || typeof rawText !== 'string') return '';

    let text = rawText;

    // Step 1: Strip HTML tags.
    // The regex handles self-closing tags, tags with attributes, and multiline tags.
    // It does not parse HTML — it removes anything between < and > that looks like a tag.
    text = text.replace(/<[^>]*>/g, ' ');

    // Step 2: Decode common HTML entities.
    // Order matters — &amp; must come last to avoid double-decoding &amp;lt; → <.
    text = text
        .replace(/&nbsp;/gi,  ' ')
        .replace(/&lt;/gi,    '<')
        .replace(/&gt;/gi,    '>')
        .replace(/&quot;/gi,  '"')
        .replace(/&#39;/gi,   "'")
        .replace(/&mdash;/gi, '—')
        .replace(/&ndash;/gi, '–')
        .replace(/&amp;/gi,   '&');

    // Step 3: Remove boilerplate phrases.
    for (const pattern of BOILERPLATE_PATTERNS) {
        text = text.replace(pattern, ' ');
    }

    // Step 4: Normalise line endings to \n.
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Step 5: Collapse runs of spaces and tabs (not newlines) to a single space.
    text = text.replace(/[ \t]+/g, ' ');

    // Step 6: Collapse more than two consecutive blank lines to two.
    // This preserves paragraph structure while removing page-break-like whitespace.
    text = text.replace(/\n{3,}/g, '\n\n');

    // Step 7: Trim.
    return text.trim();
}

// =============================================================================
// detectLanguage(text)
//
// Lightweight language detection based on character-frequency analysis.
// Checks for the presence of language-specific characters and common
// high-frequency function words to produce a best-guess language code.
//
// This is intentionally simple — LORE's content is almost exclusively
// English, and the goal is to flag non-English content for the Manager,
// not to provide production-grade multilingual classification.
//
// Returns a BCP-47 language code string: 'en', 'fr', 'de', 'es', 'pt',
// 'nl', 'it', or 'unknown'.
//
// Pure function — no side effects, no async.
// =============================================================================

/**
 * Detects the most likely language of a text string using character frequency
 * and common function-word heuristics.
 *
 * @param {string} text - Plain text to analyse. Should be cleaned before passing.
 * @returns {string} A BCP-47 language code: 'en' | 'fr' | 'de' | 'es' | 'pt' | 'nl' | 'it' | 'unknown'.
 */
export function detectLanguage(text) {
    if (!text || typeof text !== 'string' || text.trim().length < 20) return 'unknown';

    const lower = text.toLowerCase();

    // Each entry: [languageCode, arrayOfHighFrequencyFunctionWords].
    // Function words are the most reliable signal because they appear constantly
    // regardless of topic. We check for word-boundary matches to avoid false
    // positives from substrings (e.g. 'les' inside 'tables').
    const SIGNATURES = [
        ['fr', ['le ', 'la ', 'les ', 'de ', 'du ', 'des ', 'en ', 'que ', 'qui ', 'est ', 'dans ', 'avec ', 'une ', 'par ']],
        ['de', ['der ', 'die ', 'das ', 'und ', 'ist ', 'mit ', 'von ', 'für ', 'eine ', 'nicht ', 'ich ', 'sich ', 'auf ', 'dem ']],
        ['es', ['el ', 'la ', 'los ', 'las ', 'de ', 'del ', 'en ', 'que ', 'con ', 'una ', 'por ', 'para ', 'su ', 'como ']],
        ['pt', ['de ', 'da ', 'do ', 'dos ', 'das ', 'em ', 'que ', 'com ', 'uma ', 'por ', 'para ', 'se ', 'no ', 'na ']],
        ['nl', ['de ', 'het ', 'een ', 'van ', 'en ', 'in ', 'is ', 'op ', 'dat ', 'zijn ', 'met ', 'voor ', 'niet ', 'ook ']],
        ['it', ['il ', 'la ', 'i ', 'le ', 'di ', 'del ', 'e ', 'in ', 'che ', 'con ', 'una ', 'per ', 'si ', 'non ']],
        ['en', ['the ', 'and ', 'of ', 'to ', 'in ', 'is ', 'it ', 'that ', 'for ', 'on ', 'with ', 'this ', 'are ', 'be ']],
    ];

    // Score each language by counting how many of its function words appear in the text.
    // The language with the highest score wins.
    let bestLang  = 'unknown';
    let bestScore = 0;

    for (const [lang, words] of SIGNATURES) {
        let score = 0;
        for (const word of words) {
            // Count occurrences — multiple hits strengthen the signal
            let pos = 0;
            while ((pos = lower.indexOf(word, pos)) !== -1) {
                score++;
                pos += word.length;
            }
        }
        if (score > bestScore) {
            bestScore = score;
            bestLang  = lang;
        }
    }

    // Minimum threshold — a score below this means we don't have enough signal
    // [TUNING TARGET] If short snippets are mislabelled, raise this threshold
    return bestScore >= 5 ? bestLang : 'unknown';
}

// =============================================================================
// hashContent(text)
//
// Produces a SHA-256 hex digest of the input string.
// Used for deduplication — the same content submitted twice produces the
// same hash, so the second submission can be identified and skipped.
//
// Uses the Web Crypto API (crypto.subtle.digest) — available natively in
// all modern browsers and in Cloudflare Workers. No npm import needed.
//
// Returns a Promise<string> — the hex-encoded SHA-256 digest.
// Async because crypto.subtle.digest is Promise-based.
// =============================================================================

/**
 * Computes a SHA-256 hex digest of the input text for deduplication.
 * Uses the Web Crypto API — no external libraries required.
 *
 * @param {string} text - The text to hash. Should be the cleaned content.
 * @returns {Promise<string>} The SHA-256 hex digest as a lowercase hex string.
 */
export async function hashContent(text) {
    if (!text || typeof text !== 'string') return '';

    // Encode the text as a UTF-8 byte array — required by crypto.subtle.digest
    const encoded = new TextEncoder().encode(text);

    // SHA-256 digest — returns an ArrayBuffer
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);

    // Convert the ArrayBuffer to a hex string.
    // Each byte becomes two hex characters, zero-padded to ensure consistent length.
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// =============================================================================
// countWords(text)
//
// Counts words by splitting on whitespace.
// A "word" is any non-whitespace token — this matches how chunking works,
// so the counts are consistent across the pipeline.
//
// Returns an integer. Returns 0 for empty or non-string input.
// Pure function — no side effects, no async.
// =============================================================================

/**
 * Counts the number of words in a string by splitting on whitespace.
 *
 * @param {string} text - The text to count. Works on both raw and cleaned text.
 * @returns {number} The word count as a non-negative integer.
 */
export function countWords(text) {
    if (!text || typeof text !== 'string') return 0;
    // filter(Boolean) removes empty strings from leading/trailing/multiple spaces
    return text.trim().split(/\s+/).filter(Boolean).length;
}

// =============================================================================
// shouldChunk(wordCount)
//
// Returns true if the word count exceeds the chunk threshold.
// Called before chunkDocument() to avoid chunking short content unnecessarily.
// A Reviewer note of 200 words should not go through chunking.
// A 5,000-word document should.
//
// Pure function — no side effects, no async.
// =============================================================================

/**
 * Returns true if the content is long enough to require chunking.
 *
 * @param {number} wordCount - The word count of the content, from countWords().
 * @returns {boolean} True if chunking is required.
 */
export function shouldChunk(wordCount) {
    return typeof wordCount === 'number' && wordCount > CHUNK_WORD_LIMIT;
}

// =============================================================================
// chunkDocument(text)
//
// Splits a long document into overlapping chunks for AI processing.
//
// Why chunking?
//   AI models have context limits. Chunking allows LORE to process documents
//   of any length without truncation. Each chunk is processed independently
//   through the extraction pipeline and produces its own extraction document.
//
// How it works:
//   1. Split the text into paragraphs (double-newline boundaries).
//   2. Assemble paragraphs into chunks of up to CHUNK_WORD_LIMIT words.
//      Paragraph boundaries are respected — a paragraph is never split
//      mid-sentence across two chunks.
//   3. Each new chunk starts by including the last CHUNK_OVERLAP_WORDS words
//      from the previous chunk. This overlap means ideas near chunk boundaries
//      are represented in full in at least one chunk.
//   4. If a single paragraph exceeds CHUNK_WORD_LIMIT words, it is included
//      as its own chunk (oversized paragraphs cannot be avoided without
//      splitting sentences, which we do not do).
//
// Returns an array of chunk strings. Returns [''] for empty input.
// Pure function — no side effects, no async.
// =============================================================================

/**
 * Splits a document into overlapping word-bounded chunks, respecting paragraph
 * boundaries. Produces chunks of up to 800 words with 150-word overlap.
 *
 * @param {string} text - The full document text. Should be cleaned first.
 * @returns {string[]} An array of chunk strings, each ready for AI processing.
 */
export function chunkDocument(text) {
    if (!text || typeof text !== 'string' || text.trim().length === 0) return [''];

    // Step 1: Split on paragraph boundaries (one or more blank lines).
    // Filter removes empty strings left by leading/trailing whitespace.
    const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);

    if (paragraphs.length === 0) return [text.trim()];

    const chunks = [];
    // currentParagraphs holds the paragraphs assembled into the current chunk.
    let currentParagraphs = [];
    let currentWordCount  = 0;

    // The overlap tail — the last CHUNK_OVERLAP_WORDS words from the previous chunk,
    // stored as a string to prepend to the next chunk.
    let overlapTail = '';

    /**
     * Finalises the current chunk and starts a new one.
     * Extracts the overlap tail from the end of the completed chunk and resets
     * currentParagraphs so the next chunk begins with that tail.
     */
    const flushChunk = () => {
        if (currentParagraphs.length === 0) return;

        const chunkText = (overlapTail ? overlapTail + '\n\n' : '') + currentParagraphs.join('\n\n');
        chunks.push(chunkText.trim());

        // Extract the overlap tail from the end of the current content
        // (not including the prepended overlapTail, which was already in the previous chunk).
        const currentContent = currentParagraphs.join(' ');
        const words          = currentContent.split(/\s+/).filter(Boolean);
        overlapTail = words.slice(-CHUNK_OVERLAP_WORDS).join(' ');

        currentParagraphs = [];
        currentWordCount  = 0;
    };

    for (const paragraph of paragraphs) {
        const paragraphWordCount = countWords(paragraph);

        // Case 1: Adding this paragraph would exceed the chunk limit.
        // Flush the current chunk first, then start fresh with this paragraph.
        if (currentWordCount + paragraphWordCount > CHUNK_WORD_LIMIT && currentWordCount > 0) {
            flushChunk();
        }

        // Case 2: This paragraph alone exceeds the chunk limit.
        // It cannot be split without breaking sentences, so treat it as its own chunk.
        // Note: this case only fires when currentWordCount === 0 after the flush above.
        if (paragraphWordCount > CHUNK_WORD_LIMIT && currentWordCount === 0) {
            // Add what we have (just the oversized paragraph) and flush immediately.
            currentParagraphs.push(paragraph);
            currentWordCount += paragraphWordCount;
            flushChunk();
            continue;
        }

        // Normal case: add the paragraph to the current chunk.
        currentParagraphs.push(paragraph);
        currentWordCount += paragraphWordCount;
    }

    // Flush any remaining content as the final chunk.
    if (currentParagraphs.length > 0) {
        const chunkText = (overlapTail ? overlapTail + '\n\n' : '') + currentParagraphs.join('\n\n');
        chunks.push(chunkText.trim());
    }

    // Guard: always return at least one chunk.
    return chunks.length > 0 ? chunks : [text.trim()];
}

// =============================================================================
// deduplicateCheck(orgId, contentHash)
//
// Queries Firestore to check whether an extraction with the same content hash
// already exists for this org. Called before createExtraction() to prevent
// the same content from being staged multiple times.
//
// Why org-scoped?
//   The same document could legitimately be used by two different orgs.
//   Deduplication applies within an org's knowledge base only.
//
// Returns the existing extraction ID string if a duplicate is found,
// or null if no duplicate exists.
//
// Async — reads Firestore.
// =============================================================================

/**
 * Checks whether an extraction with the given content hash already exists
 * for this organisation.
 *
 * @param {string} orgId       - The organisation ID to scope the search to.
 * @param {string} contentHash - The SHA-256 hex digest from hashContent().
 * @returns {Promise<string|null>} The existing extraction ID, or null if no duplicate.
 */
export async function deduplicateCheck(orgId, contentHash) {
    if (!orgId || !contentHash) return null;

    console.log('LORE ingest.js: Deduplication check — orgId:', orgId, 'hash:', contentHash.slice(0, 12) + '…');

    try {
        const ref = collection(db, 'organisations', orgId, 'extractions');
        const q   = query(
            ref,
            where('contentHash', '==', contentHash),
            limit(1)   // We only need to know if any duplicate exists — one is enough
        );
        const snap = await getDocs(q);

        if (!snap.empty) {
            const existingId = snap.docs[0].id;
            console.warn('LORE ingest.js: Duplicate content detected — existing extraction ID:', existingId);
            return existingId;
        }

        console.log('LORE ingest.js: No duplicate found — content is new.');
        return null;

    } catch (err) {
        // If the deduplication check itself fails, log it and return null
        // (allowing the write to proceed rather than silently blocking it).
        // This is safer than blocking on an uncertain failure — a duplicate is
        // less harmful than silently preventing a legitimate new submission.
        console.warn('LORE ingest.js: Deduplication check failed — proceeding without it.', err);
        return null;
    }
}
