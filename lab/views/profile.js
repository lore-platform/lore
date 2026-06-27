/**
 * lab/views/profile.js
 * Screen 1 — Expert Profile Intake
 * ─────────────────────────────────────────────────────────────────────
 * Flow:
 *  1. Render the intake form
 *  2. Optional: read uploaded document files as text via FileReader,
 *     clean with cleanText()
 *  3. On submit:
 *     a. Validate required fields
 *     b. Create a new Firestore session (or use existing if resuming)
 *     c. Save profile to Firestore via updateProfile()
 *     d. Call classify() to extract initial cue library
 *     e. Parse response with extractJSON()
 *     f. Save cue library via updateCueLibrary()
 *     g. Navigate to Screen 2 (sorting)
 */

import { classify } from '../../engine/ai.js';
import { extractJSON } from '../../engine/utils.js';
import { cleanText } from '../../engine/ingest.js';
import {
    createSession, updateProfile,
    updateCueLibrary
} from '../db.js';
import {
    getCurrentUser, getSessionId,
    setSessionId, showView
} from '../app.js';

// ── Classify prompt for cue extraction ───────────────────────────────

const CUE_SYSTEM_PROMPT = `
You are an expert in cognitive task analysis and knowledge engineering.
Your task is to extract situational cues from an expert's profile.

A cue is a feature of a situation that a skilled person notices — consciously
or not — that changes what they decide to do. Good cues are discriminating:
they distinguish between situations that look similar but need different responses.

Respond ONLY with a valid JSON array. No markdown fences, no explanation, no preamble.
Each element must be an object with exactly these fields:
  id:         string  — unique key, format "cue_001", "cue_002", etc.
  name:       string  — short label, 2–5 words
  definition: string  — 1–2 sentences explaining what this cue means in practice
  scale:      "binary" | "three-point"
              binary       = present or absent (yes/no, true/false)
              three-point  = low / medium / high or equivalent gradations
  layer:      1 | 2 | 3
              1 = context or situational features (what kind of situation is this?)
              2 = task or problem features (what specifically needs doing?)
              3 = resource or constraint features (what is available or limiting?)
  options:    string[]  — exactly 2 values for binary, exactly 3 for three-point
`.trim();

function buildCuePrompt(profile) {
    const docSection = profile.documentsText
        ? `\n\nADDITIONAL CONTEXT FROM UPLOADED DOCUMENTS:\n${profile.documentsText.slice(0, 3000)}`
        : '';

    return `
Here is an expert's profile. Extract 6–10 situational cues that this expert
uses — consciously or not — to decide how to respond.

Prioritise cues that would genuinely discriminate between different decisions.
Avoid generic cues that any professional in any field would use.

PROFILE:
Role: ${profile.role}
What I do day-to-day: ${profile.whatYouDo}
Types of decisions I make: ${profile.decisionTypes}
What makes these decisions hard: ${profile.whatMakesItHard}${docSection}

Return a JSON array of cue objects only. Nothing else.
  `.trim();
}

// ── Render ────────────────────────────────────────────────────────────

/**
 * init(container, sessionId)
 * Called by app.js's showView() every time this screen is navigated to.
 * If a sessionId already exists (returning visit), the form is still
 * shown fresh — pre-filling from Firestore can be added in a later pass.
 */
export async function init(container, sessionId) {
    // Track captured document text in closure so the submit handler can read it
    let documentsText = '';

    container.innerHTML = `
    <div class="lab-page">

      <div class="lab-header">
        <span class="lab-step-label">Step 1 of 10</span>
        <h2 class="lab-title">Your Expertise</h2>
        <p class="lab-subtitle">
          Describe your role and the decisions you make. Be specific —
          the quality of everything that follows depends on this.
        </p>
      </div>

      <div class="lab-body">
        <div id="profile-error" class="lab-error hidden"></div>

        <div class="form-group">
          <label class="form-label" for="p-role">
            Your role <span class="required">*</span>
          </label>
          <input class="input" type="text" id="p-role"
                 placeholder="e.g. Senior Cardiac ICU Nurse, Credit Risk Analyst, Infrastructure Engineer"
                 maxlength="140" />
        </div>

        <div class="form-group">
          <label class="form-label" for="p-what-you-do">
            What you actually do, in plain terms <span class="required">*</span>
          </label>
          <textarea class="input textarea" id="p-what-you-do" rows="4"
                    placeholder="Describe the core decisions you make day-to-day. What do you assess, judge, or determine? What are you responsible for getting right?"></textarea>
        </div>

        <div class="form-group">
          <label class="form-label" for="p-decision-types">
            The types of decisions you make most often <span class="required">*</span>
          </label>
          <textarea class="input textarea" id="p-decision-types" rows="3"
                    placeholder="e.g. Whether to escalate a patient, which credit tier to assign, whether to approve a deployment, how to prioritise a project queue"></textarea>
        </div>

        <div class="form-group">
          <label class="form-label" for="p-what-makes-hard">
            What makes these decisions genuinely hard — not just complex <span class="required">*</span>
          </label>
          <textarea class="input textarea" id="p-what-makes-hard" rows="4"
                    placeholder="What are the edge cases that trip people up? What do novices miss that you catch? Where does the standard procedure break down?"></textarea>
        </div>

        <div class="form-group">
          <label class="form-label" for="p-doc-upload">
            Relevant documents
            <span class="optional">(optional — text files only: .txt, .md)</span>
          </label>
          <p class="form-hint">
            Protocols, guidelines, case summaries, or any text that reflects
            how decisions are made in your field.
          </p>
          <input class="input" type="file" id="p-doc-upload"
                 accept=".txt,.md" multiple />
          <p id="p-doc-status" class="form-hint hidden"></p>
        </div>

        <div class="lab-actions">
          <button class="btn btn-primary" id="btn-profile-submit">
            Extract Cues and Continue →
          </button>
        </div>

        <div id="profile-loading" class="lab-loading hidden">
          <p id="profile-loading-text">Working…</p>
        </div>
      </div>

    </div>
  `;

    // ── Document upload handler ─────────────────────────────────────────
    document.getElementById('p-doc-upload').addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        const statusEl = document.getElementById('p-doc-status');
        if (!files.length) return;

        statusEl.textContent = 'Reading files…';
        statusEl.classList.remove('hidden');

        try {
            const texts = await Promise.all(files.map(readFileAsText));
            documentsText = texts.map(t => cleanText(t)).join('\n\n---\n\n');
            const kChars = Math.round(documentsText.length / 1000);
            statusEl.textContent = `✓ ${files.length} file(s) loaded (${kChars}k characters)`;
        } catch (err) {
            statusEl.textContent = `Could not read file: ${err.message}`;
        }
    });

    // ── Submit handler ──────────────────────────────────────────────────
    document.getElementById('btn-profile-submit').addEventListener('click', () => {
        handleSubmit(sessionId, () => documentsText);
    });
}

// ── File reader ───────────────────────────────────────────────────────

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error(`Could not read "${file.name}"`));
        reader.readAsText(file);
    });
}

// ── Submit logic ──────────────────────────────────────────────────────

async function handleSubmit(existingSessionId, getDocText) {
    const errorEl = document.getElementById('profile-error');
    const loadingEl = document.getElementById('profile-loading');
    const loadTextEl = document.getElementById('profile-loading-text');
    const submitBtn = document.getElementById('btn-profile-submit');

    errorEl.classList.add('hidden');

    // Gather form values
    const role = document.getElementById('p-role').value.trim();
    const whatYouDo = document.getElementById('p-what-you-do').value.trim();
    const decisionTypes = document.getElementById('p-decision-types').value.trim();
    const whatMakesItHard = document.getElementById('p-what-makes-hard').value.trim();
    const documentsText = getDocText();

    // Validate required fields
    if (!role || !whatYouDo || !decisionTypes || !whatMakesItHard) {
        errorEl.textContent = 'Please fill in all four required fields before continuing.';
        errorEl.classList.remove('hidden');
        errorEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
    }

    const profile = { role, whatYouDo, decisionTypes, whatMakesItHard, documentsText };

    submitBtn.disabled = true;
    loadingEl.classList.remove('hidden');

    try {
        // Step 1 — Create session if this is the first visit to this screen
        let sessionId = existingSessionId || getSessionId();

        if (!sessionId) {
            loadTextEl.textContent = 'Creating session…';
            const user = getCurrentUser();
            if (!user) throw new Error('No authenticated user. Please sign in again.');
            sessionId = await createSession(user.uid);
            setSessionId(sessionId);
        }

        // Step 2 — Save profile to Firestore
        loadTextEl.textContent = 'Saving profile…';
        await updateProfile(sessionId, profile);

        // Step 3 — Call classify() to extract the initial cue library
        loadTextEl.textContent = 'Extracting cues from your profile… (this usually takes 10–20 seconds)';
        const rawResponse = await classify(
            buildCuePrompt(profile),
            CUE_SYSTEM_PROMPT
        );

        // Step 4 — Check the Worker response, then parse with extractJSON
        if (!rawResponse.ok) {
            throw new Error(
                rawResponse.quota
                    ? 'AI quota exceeded. Please wait a few minutes and try again.'
                    : 'The AI call failed. Please try again.'
            );
        }
        const cueLibrary = extractJSON(rawResponse.text);

        if (!Array.isArray(cueLibrary) || cueLibrary.length === 0) {
            throw new Error(
                'The AI returned an unexpected format for the cue library. ' +
                'Please try submitting again. If the problem persists, try adding ' +
                'more detail to the "What makes it hard" field.'
            );
        }

        // Step 5 — Save cue library to Firestore
        loadTextEl.textContent = 'Saving cue library…';
        await updateCueLibrary(sessionId, cueLibrary);

        // Step 6 — Navigate to Screen 2
        showView('sorting');

    } catch (err) {
        console.error('[profile] submit error:', err);
        errorEl.textContent = err.message || 'Something went wrong. Please try again.';
        errorEl.classList.remove('hidden');
        errorEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        submitBtn.disabled = false;
    } finally {
        loadingEl.classList.add('hidden');
    }
}