// =============================================================================
// Lab — views/profile.js
// Screen 1 — Profile Intake
//
// On a first visit (session has no profile data), renders an intro guide
// explaining the 8-step process. The "Start session" button re-renders the
// same container with the profile form — no separate routing needed.
//
// The form itself is now two phases:
//   Phase A (_renderRoleStep) — role, plus an optional CV/job description
//     (upload or paste).
//   Phase B (_renderMainForm) — the full form. Each question has an opt-in
//     toggle revealing an adjacent-role example — a different, related role,
//     never the expert's own — to show the level of specificity wanted
//     without inviting a copy-edit of a same-role answer.
//
// LOCAL-FIRST, AI-ENHANCES: the adjacent-role example is generated locally,
// with zero network calls, the instant role is entered — see domain-signals.js
// (detectDomain / pickAdjacentDomain / DOMAIN_CONTENT — shared with
// cue-review.js, which uses the same domain detection to illustrate what a
// "cue" means with something from the expert's own field) and this file's
// _localExamples(). Phase B renders immediately using this, no wait, no
// loading state on Continue. One classify() call then runs in the
// background to try to produce a more tailored version, informed by the
// CV/JD when one was given; if it lands, it patches the toggles in place
// (see _attachExampleToggles). If it's slow, fails, or AI is unavailable,
// nothing happens — the local example already shown is not treated as a
// degraded state to recover from, it's the intended default experience.
// AI is a layer that can make a good local answer better; it was deliberately
// not built as the thing the feature depends on to work at all.
//
// If a CV/JD was provided, a small secondary link inside each toggle's box
// offers real evidence lines extracted from it (extractEvidenceLines, from
// domain-signals.js) as an alternative to the domain example — also local,
// also no AI.
//
// On a return visit with a role already saved, Phase A is skipped — Phase B
// renders immediately with a fresh local example, and the same background
// AI-enhancement call runs exactly as above.
//
// After form submission, runs one classify() call to propose a cue library.
// Saves both profile and cueLibrary to Firestore before advancing.
// =============================================================================

import { classify }                    from '../../engine/ai.js';
import { extractJSON }                 from '../../engine/utils.js';
import { cleanText }                   from '../../engine/ingest.js';
import { saveProfile, saveCueLibrary } from '../db.js';
import {
    DOMAIN_CONTENT,
    detectDomain,
    pickAdjacentDomain,
    extractEvidenceLines,
} from '../domain-signals.js';

// Cap on document text sent to the AI — keeps classify() within token budget.
// [TUNING TARGET] raise if experts regularly upload longer documents.
const MAX_DOC_CHARS     = 6000;
const EXAMPLE_DOC_CHARS = 2000;  // smaller excerpt for the example-generation call — only needs
                                  // enough to calibrate tone/specificity, not the full document

// ---------------------------------------------------------------------------
// _localExamples(role, documentsText) — the local, no-AI baseline for the
// adjacent-role examples on this screen. Detects a domain from the role (and
// CV/JD, if given — see domain-signals.js), picks a genuinely different
// adjacent domain, and returns that domain's hand-written example content in
// the same shape _generateExamples() returns, so both can feed
// _attachExampleToggles() interchangeably. Always succeeds — 'general' is a
// real, usable entry in DOMAIN_CONTENT, not an error state.
// ---------------------------------------------------------------------------
function _localExamples(role, documentsText) {
    const detected = detectDomain(`${role || ''} ${documentsText || ''}`);
    const adjacent  = pickAdjacentDomain(detected, role || detected);
    const content   = DOMAIN_CONTENT[adjacent] || DOMAIN_CONTENT.general;

    return {
        mode:             'local',
        adjacentRole:     content.roleName,
        whatYouDoExample: content.whatYouDoExample,
        decisionExample:  content.decisionExample,
        hardExample:      content.hardExample,
    };
}

// ---------------------------------------------------------------------------
// render() — entry point called by app.js.
// Routes to guide (first visit) or form (returning visit).
// ---------------------------------------------------------------------------
export function render(el, session, next) {
    const p = session.profile ?? {};

    if (!p.role) {
        _renderGuide(el, session, next);
        return;
    }

    _renderForm(el, session, next, p);
}

// ---------------------------------------------------------------------------
// _renderForm() — dispatches to Phase A (role only, first time through this
// screen) or Phase B (the full form). On a return visit with a role already
// on record, goes straight to Phase B — local examples render instantly, AI
// enhancement (if it lands) upgrades them in the background.
// ---------------------------------------------------------------------------
function _renderForm(el, session, next, p) {
    if (!p.role) {
        _renderRoleStep(el, session, next);
        return;
    }

    const localExamples = _localExamples(p.role, p.documentsText);
    _renderMainForm(el, session, next, p, localExamples);

    const docExcerpt = p.documentsText ? p.documentsText.slice(0, EXAMPLE_DOC_CHARS) : '';
    _generateExamples(p.role, docExcerpt).then(aiExamples => {
        if (aiExamples) _attachExampleToggles(el, aiExamples, p.documentsText);
    });
}

// ---------------------------------------------------------------------------
// _renderRoleStep() — Phase A. Role, plus an optional CV/job description —
// collected here now so it can inform the adjacent-role examples, not just
// the later cue-extraction call. On continue, fetches examples before Phase B
// ever renders, so the toggles are ready to show instantly rather than
// triggering a wait on click.
// ---------------------------------------------------------------------------
function _renderRoleStep(el, session, next) {
    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(1)}</div>

  <h1 class="lab-h1">Tell us about your expertise</h1>
  <p class="lab-sub">
    Start with your role — and a CV or job description if you have one handy. We'll use both
    to tailor the examples on the questions that follow, to make them easier to answer.
  </p>

  <div id="role-err" class="lab-notice lab-err" style="display:none"></div>

  <div class="lab-card">
    <div class="form-group">
      <label class="label lab-question-label" for="f-role-only">What is your area of expertise?</label>
      <input class="input" id="f-role-only" type="text"
        placeholder="e.g. Senior commercial underwriter" required>
    </div>

    <div class="form-group" style="margin-bottom:0">
      <label class="label">Have a CV or job description handy? Add it (optional)</label>
      <p class="form-hint">
        Adding it here means fewer things we need to ask you directly later, and helps tailor
        the examples on the next screen to your actual field rather than a generic guess.
      </p>

      <div class="lab-tab-row" style="margin-bottom:var(--space-3)">
        <button type="button" class="lab-tab active" id="doc-tab-upload">Upload a file</button>
        <button type="button" class="lab-tab" id="doc-tab-paste">Paste text instead</button>
      </div>

      <div id="doc-upload-pane">
        <div class="lab-dropzone" id="dropzone">
          Click to choose files, or drag them here<br>
          <span style="font-size:0.78rem">Plain text, Markdown, or .csv work best — if your CV is a .docx or .pdf, use "Paste text instead" and paste the contents in directly</span>
          <input type="file" id="file-input" multiple accept=".txt,.md,.csv" style="display:none">
        </div>
        <div id="file-list"></div>
      </div>

      <div id="doc-paste-pane" style="display:none">
        <textarea class="input" id="doc-paste-text" rows="6"
          placeholder="Paste the text of your CV or job description here"></textarea>
      </div>
    </div>
  </div>

  <div class="lab-btn-row">
    <button type="button" class="btn btn-primary" id="role-continue">Continue</button>
  </div>
</div>`;

    const input = el.querySelector('#f-role-only');
    input.focus();

    // ── Document upload / paste toggle ──────────────────────────────────
    let uploadedText = '';
    const fileNames   = [];

    const dropzone      = el.querySelector('#dropzone');
    const fileInput     = el.querySelector('#file-input');
    const fileListEl    = el.querySelector('#file-list');
    const tabUpload      = el.querySelector('#doc-tab-upload');
    const tabPaste       = el.querySelector('#doc-tab-paste');
    const uploadPane     = el.querySelector('#doc-upload-pane');
    const pastePane      = el.querySelector('#doc-paste-pane');
    const pasteTextarea  = el.querySelector('#doc-paste-text');

    let activeDocSource = 'upload';

    tabUpload.addEventListener('click', () => {
        activeDocSource = 'upload';
        tabUpload.classList.add('active');
        tabPaste.classList.remove('active');
        uploadPane.style.display = '';
        pastePane.style.display  = 'none';
    });

    tabPaste.addEventListener('click', () => {
        activeDocSource = 'paste';
        tabPaste.classList.add('active');
        tabUpload.classList.remove('active');
        pastePane.style.display  = '';
        uploadPane.style.display = 'none';
    });

    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('over');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('over');
        _handleFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', () => _handleFiles(fileInput.files));

    function _handleFiles(fileListObj) {
        const files = Array.from(fileListObj || []);
        if (files.length === 0) return;
        let pending = files.length;
        files.forEach((file) => {
            const reader = new FileReader();
            reader.onload = () => {
                uploadedText += (uploadedText ? '\n\n' : '') + cleanText(String(reader.result));
                fileNames.push(file.name);
                if (--pending === 0) _renderFileList();
            };
            reader.onerror = () => { if (--pending === 0) _renderFileList(); };
            reader.readAsText(file);
        });
    }

    function _renderFileList() {
        fileListEl.innerHTML = fileNames
            .map(n => `<div class="lab-file-name">✓ ${_esc(n)}</div>`)
            .join('');
    }

    // ── Continue ─────────────────────────────────────────────────────────
    const submitRole = () => {
        const role  = input.value.trim();
        const errEl = el.querySelector('#role-err');

        if (!role) {
            errEl.textContent   = 'Please enter your area of expertise to continue.';
            errEl.style.display = '';
            return;
        }
        errEl.style.display = 'none';

        const documentsText = activeDocSource === 'paste'
            ? cleanText(pasteTextarea.value.trim())
            : uploadedText;

        // Local generation is instant — no AI wait needed to move on to Phase B.
        const localExamples = _localExamples(role, documentsText);
        const p = { role, whatYouDo: '', decisionTypes: '', whatMakesItHard: '', documentsText };
        _renderMainForm(el, session, next, p, localExamples);

        // AI enhancement, in the background — upgrades the toggles in place if
        // it lands, purely additive. If it's slow, fails, or AI is unavailable,
        // the local example already shown stays exactly as good as it was.
        const docExcerpt = documentsText ? documentsText.slice(0, EXAMPLE_DOC_CHARS) : '';
        _generateExamples(role, docExcerpt).then(aiExamples => {
            if (aiExamples) _attachExampleToggles(el, aiExamples, documentsText);
        });
    };

    el.querySelector('#role-continue').addEventListener('click', submitRole);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitRole(); }
    });
}

// ---------------------------------------------------------------------------
// _generateExamples(role, docExcerpt) — one classify() call. Invents a
// plausible ADJACENT role (never the expert's own) and writes an example
// answer to each of the three main questions as if answering for that
// adjacent role. An optional CV/JD excerpt calibrates realism and vocabulary
// only — it must not leak into the example as copyable content.
//
// This is an ENHANCEMENT over _localExamples(), not the primary source — the
// local version has already rendered and is already good by the time this
// resolves. Returns null on failure/unavailability; the caller (see
// _renderRoleStep, _renderForm) simply leaves the local example in place
// rather than treating this as an error to recover from.
// ---------------------------------------------------------------------------
async function _generateExamples(role, docExcerpt) {
    const system = `You help ground abstract interview questions with a concrete illustration, for a professional
decision-capture exercise.

Given a person's stated area of expertise, invent a plausible ADJACENT role — a specific, different role in a
closely related field, NOT the same role and not a generic variant of it — and write one example answer to
each of three questions, AS IF answering for that invented adjacent role. These examples exist purely to show
the level of specificity and concreteness wanted. They must read as clearly not the expert's own field, so
they illustrate rather than invite copying.
${docExcerpt ? `
You are also given an excerpt from the expert's own CV or job description. Use it ONLY to calibrate the
realism, seniority, and vocabulary level of your example — for instance, matching the scale of organisation or
the technical register. Do NOT copy any specific fact, project, or detail from it into the example, and do NOT
use it to pick the adjacent role — the adjacent role must still be a different field from the expert's own.` : ''}

Return a JSON object with exactly these fields:
{
  "adjacentRole": "The invented adjacent role, e.g. 'Senior Property Underwriter' if given 'Senior Commercial Underwriter'",
  "whatYouDoExample": "2-3 sentences: the shape of the adjacent role — what they own, who it's for, roughly what a week looks like. No decisions or trade-offs here.",
  "decisionExample": "One concrete, specific, real-sounding decision this adjacent-role person might have made recently, plus 2-3 similar recurring decisions named briefly.",
  "hardExample": "Two similar-looking situations this adjacent-role person would handle differently, and the specific detail that changes their response."
}
Return the JSON object only — no other text.`;

    const prompt = `Stated area of expertise: ${role}
${docExcerpt ? `\nExcerpt from the expert's own CV/job description (for calibration only, do not copy from it):\n${docExcerpt}` : ''}

Invent one adjacent-but-different role and write the three example answers.`;

    const result = await classify(prompt, system);
    if (!result.ok) return null;

    const parsed = extractJSON(result.text);
    if (!parsed || !parsed.adjacentRole) return null;
    return parsed;
}

// ---------------------------------------------------------------------------
// _renderGuide() — intro screen shown before the profile form on first visit.
// "Start session" re-renders the same container with the form.
// ---------------------------------------------------------------------------
function _renderGuide(el, session, next) {
    el.innerHTML = `
<div class="lab-wrap" style="max-width:600px">
  <div class="lab-steps">${_pips(1)}</div>

  <h1 class="lab-h1">What you're about to do</h1>
  <p class="lab-sub">
    This session captures how you make decisions — not by asking you to explain
    your rules, but by watching how you respond to realistic situations from your
    field. Most people can't articulate their decision logic directly, but they
    apply it correctly every time. This process surfaces it.
  </p>

  <div class="lab-card">
    <div class="lab-section-head">What you'll produce</div>
    <p style="font-size:var(--text-sm);line-height:1.7;color:var(--ink);margin:0">
      A <strong>Recipe</strong> — a structured record of what you pay attention to,
      how you weigh your options, and what drives your best calls in your field.
      Precise enough to teach to someone else, verify against your own behaviour,
      and compare against other experts.
    </p>
  </div>

  <div class="lab-card">
    <div class="lab-section-head">How it works — 8 steps, roughly 45–60 minutes</div>
    <div class="intro-step-list">
      ${_step(1, 'Your background',
        'Tell us about your work, the types of decisions you make, and what makes situations genuinely hard.')}
      ${_step(2, 'Sort situations',
        "You'll see 16 situations from your field. Group the ones you'd handle the same way. Your groupings reveal what you actually pay attention to.")}
      ${_step(3, 'Review your cues',
        "The system proposes the factors that drive your decisions. You check, edit, and add to the list until it's accurate.")}
      ${_step(4, 'Confirm your options',
        "Review the range of actions available to you — these are the choices you'll pick between in the scenario session.")}
      ${_step(5, 'Scenario session',
        '30 quick situations, one after another. Pick a response for each. No explanations needed — just your instinct.')}
      ${_step(6, 'Review your decision pattern',
        "See how the system understood your decisions. You confirm whether it's right, and correct it if not.")}
      ${_step(7, 'Deep-dive',
        'Walk through a few tricky edge cases and explain what you noticed that others might have missed.')}
      ${_step(8, 'Your Recipe',
        'Review the extracted knowledge and confirm it accurately represents how you actually make decisions in your field.')}
    </div>
  </div>

  <div class="lab-notice lab-info">
    Your progress is saved automatically after each step. If you need to stop
    and come back, you'll resume exactly where you left off.
  </div>

  <button type="button" class="btn btn-primary btn-full" id="guide-start"
    style="margin-top:var(--space-4);padding:var(--space-4)">
    Start session →
  </button>
</div>`;

    el.querySelector('#guide-start').addEventListener('click', () => {
        _renderForm(el, session, next, session.profile ?? {});
    });
}

// ---------------------------------------------------------------------------
// _renderMainForm() — Phase B, the full profile intake form.
// p = the existing profile data. examples = the adjacent-role illustrations
// from _generateExamples(), or null if not yet available/failed — the three
// toggle buttons render in a pending/unavailable state until patched by
// _attachExampleToggles().
// ---------------------------------------------------------------------------
function _renderMainForm(el, session, next, p, examples) {
    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(1)}</div>

  <h1 class="lab-h1">Tell us about your expertise</h1>
  <p class="lab-sub">
    This gives the system enough context to build situations and decision
    options that actually reflect your field. Be specific — vague answers
    here produce vague scenarios later.
  </p>

  <div id="profile-err" class="lab-notice lab-err" style="display:none"></div>

  <form id="profile-form">
    <div class="lab-card">

      <div class="form-group">
        <label class="label lab-question-label" for="f-role">What is your area of expertise?</label>
        <input class="input" id="f-role" type="text"
          placeholder="e.g. Senior commercial underwriter"
          value="${_esc(p.role)}" required>
        <button type="button" class="lab-example-toggle" id="regen-examples" style="margin-top:var(--space-2)">
          Changed your role above? Refresh the examples below
        </button>
      </div>

      <div class="form-group">
        <label class="label lab-question-label" for="f-whatyoudo">
          In a few sentences, what's the shape of your role?
        </label>
        <p class="form-hint">
          Just the scene-setting for now — what you own, who it's for, roughly what a week looks
          like. We'll get specifically into decisions next, so there's no need to get into
          judgement calls or trade-offs here.
        </p>
        ${_exampleToggleHTML('whatYouDo')}
        <textarea class="input" id="f-whatyoudo" rows="4"
          placeholder="e.g. I own product strategy and roadmap for a B2B analytics tool, working with 6 engineers and 2 designers, reporting to the Head of Product."
          required>${_esc(p.whatYouDo)}</textarea>
      </div>

      <div class="form-group">
        <label class="label lab-question-label" for="f-decisiontypes">
          Describe one real decision you made recently — then name a couple more like it
        </label>
        <p class="form-hint">
          Start with a single concrete moment: a specific situation where you picked one path
          over another, and what you actually did. A real instance is much easier to describe
          accurately than a general category — and it's the specific instances that reveal what
          actually separates you from someone less experienced in your seat. Once you've given
          one, briefly name two or three other decisions that come up in a similar way.
        </p>
        ${_exampleToggleHTML('decision')}
        <textarea class="input" id="f-decisiontypes" rows="5"
          placeholder="e.g. Last week a customer asked for a feature that would've delayed the roadmap by two weeks — I declined it and offered a lighter alternative, since it only served one account. Similar recurring decisions: whether to fast-track a bug fix or batch it into the next release; whether to greenlight a feature with unclear ROI."
          required>${_esc(p.decisionTypes)}</textarea>
      </div>

      <div class="form-group">
        <label class="label lab-question-label" for="f-hard">
          Think of two situations that look similar on the surface, but where you'd actually respond differently. What's the difference?
        </label>
        <p class="form-hint">
          Not which topics are hard in general — pick two specific situations that would look
          the same to someone outside your field, but where you'd genuinely do something
          different. What's the same on the surface? What's the detail that changes your response?
        </p>
        ${_exampleToggleHTML('hard')}
        <textarea class="input" id="f-hard" rows="5"
          placeholder="e.g. Two feature requests can look equally reasonable on paper — but one comes from a single vocal customer and one reflects a pattern across our top accounts. That pattern is the difference that actually changes what I do."
          required>${_esc(p.whatMakesItHard)}</textarea>
      </div>

      <div class="form-group" style="margin-bottom:0">
        ${p.documentsText
            ? `<div class="lab-file-name">✓ CV/job description added — carried over from the previous step</div>`
            : `<p class="form-hint" style="margin:0">No CV or job description added — that's fine, you can still continue.</p>`}
      </div>

    </div>

    <div class="lab-btn-row">
      <button type="submit" class="btn btn-primary" id="profile-submit">
        Continue
      </button>
    </div>
  </form>
</div>`;

    // ── Adjacent-role example toggles ───────────────────────────────────
    if (examples) {
        _attachExampleToggles(el, examples, p.documentsText);
    }

    el.querySelector('#regen-examples').addEventListener('click', () => {
        const role = el.querySelector('#f-role').value.trim();
        const btn  = el.querySelector('#regen-examples');
        if (!role) {
            btn.textContent = 'Enter a role above first';
            setTimeout(() => { btn.textContent = 'Changed your role above? Refresh the examples below'; }, 2000);
            return;
        }

        // Local refresh is instant — swap immediately, then try an AI upgrade
        // in the background exactly as the initial render does.
        const localExamples = _localExamples(role, p.documentsText);
        _attachExampleToggles(el, localExamples, p.documentsText);

        btn.textContent = 'Asking AI to tailor this further…';
        const docExcerpt = p.documentsText ? p.documentsText.slice(0, EXAMPLE_DOC_CHARS) : '';
        _generateExamples(role, docExcerpt).then(aiExamples => {
            btn.textContent = 'Changed your role above? Refresh the examples below';
            if (aiExamples) _attachExampleToggles(el, aiExamples, p.documentsText);
        });
    });

    // ── Form submit ─────────────────────────────────────────────────────
    // The CV/JD itself was already collected in Phase A (_renderRoleStep) —
    // p.documentsText carries it forward as-is, there's nothing further to
    // read from the DOM for it here.
    el.querySelector('#profile-form').addEventListener('submit', async (e) => {
        e.preventDefault();

        const profile = {
            role:            el.querySelector('#f-role').value.trim(),
            whatYouDo:       el.querySelector('#f-whatyoudo').value.trim(),
            decisionTypes:   el.querySelector('#f-decisiontypes').value.trim(),
            whatMakesItHard: el.querySelector('#f-hard').value.trim(),
            documentsText:   p.documentsText ?? '',
        };

        _setBusy(el, true);
        _hideErr(el);

        const profileOk = await saveProfile(session.id, profile);
        if (!profileOk) {
            _showErr(el, "Couldn't save your profile. Check your connection and try again.");
            _setBusy(el, false);
            return;
        }
        session.profile = profile;

        // ── Classify call: propose a cue library from profile text ──────
        const docExcerpt = profile.documentsText
            ? profile.documentsText.slice(0, MAX_DOC_CHARS)
            : '';

        const systemPrompt = `You are extracting the decision-relevant cues a professional uses, from their own description of their work.
A "cue" is a single piece of information that changes what a skilled person in this field would do. Cues are not the decision itself — they are the inputs that drive it.

Return a JSON array only — no markdown fences, no other text. Each element must have exactly these fields:
{
  "name": "Short cue name, 2-5 words",
  "definition": "One sentence — what this cue means and how to recognise it",
  "scale": "binary" or "three-point",
  "layer": 1, 2, or 3 — 1 is a surface/obvious cue, 3 is a subtle expert-level cue,
  "options": an array of strings the cue can take — exactly 2 strings if scale is "binary", exactly 3 if scale is "three-point"
}
Propose between 5 and 9 cues. Favour cues that are specific to this field over generic ones any layperson would already know.`;

        const prompt = `Area of expertise: ${profile.role}

What their work involves day to day:
${profile.whatYouDo}

The kinds of decisions their work involves:
${profile.decisionTypes}

What makes a situation genuinely difficult versus routine:
${profile.whatMakesItHard}
${docExcerpt ? `\nAdditional context from uploaded documents:\n${docExcerpt}` : ''}

Return a JSON array of proposed cues.`;

        const result = await classify(prompt, systemPrompt);

        if (!result.ok) {
            _showErr(el, "The AI service didn't respond. Your profile is saved — click Continue to try again.");
            _setBusy(el, false);
            return;
        }

        const parsed = extractJSON(result.text);
        if (!parsed || !Array.isArray(parsed) || parsed.length === 0) {
            _showErr(el, "Couldn't make sense of the proposed cues. Your profile is saved — click Continue to try again.");
            _setBusy(el, false);
            return;
        }

        const expertCues = parsed.map((c, i) => ({
            id:         `cue-${Date.now()}-${i}`,
            name:       c.name ?? `Cue ${i + 1}`,
            definition: c.definition ?? '',
            scale:      c.scale === 'three-point' ? 'three-point' : 'binary',
            layer:      [1, 2, 3].includes(c.layer) ? c.layer : 2,
            options:    Array.isArray(c.options) && c.options.length > 0
                ? c.options
                : (c.scale === 'three-point' ? ['Low', 'Medium', 'High'] : ['Yes', 'No']),
            source:     'expert',
        }));

        // ── Second classify call: labelled ai-suggested augmentation ────────
        // Expert-primary, AI-secondary house rule (system-updates-v2.md): this
        // never blends into the expert-derived list undistinguished — every
        // cue it proposes is written with source: 'ai-suggested' and merged
        // into the same array, kept distinguishable by that field alone.
        _setStageLabel(el, 'Checking for anything else worth proposing…');

        const augmentSystem = `You are proposing ADDITIONAL cues a practitioner in this field might plausibly rely on, that are not
already covered by the cues already proposed from the expert's own words below.
A "cue" is a single piece of information that changes what a skilled person in this field would do.
Only propose cues you are NOT certain the expert actually holds — this is a suggestion for them to confirm or reject, not a confirmed extraction.
Do not repeat or rephrase any cue already listed below as already proposed.

Return a JSON array only — no markdown fences, no other text. Each element must have exactly these fields:
{
  "name": "Short cue name, 2-5 words",
  "definition": "One sentence — what this cue means and how to recognise it",
  "scale": "binary" or "three-point",
  "layer": 1, 2, or 3 — 1 is a surface/obvious cue, 3 is a subtle expert-level cue,
  "options": an array of strings the cue can take — exactly 2 strings if scale is "binary", exactly 3 if scale is "three-point"
}
Propose between 2 and 4 additional cues. It is fine to return fewer if you can't think of genuinely distinct ones.`;

        const augmentPrompt = `Area of expertise: ${profile.role}

What their work involves day to day:
${profile.whatYouDo}

The kinds of decisions their work involves:
${profile.decisionTypes}
${docExcerpt ? `\nAdditional context from uploaded documents:\n${docExcerpt}` : ''}

Cues already proposed from the expert's own words:
${expertCues.map(c => `- ${c.name}: ${c.definition}`).join('\n')}

Return a JSON array of additional, clearly distinct ai-suggested cues.`;

        const augmentResult = await classify(augmentPrompt, augmentSystem);
        const augmentParsed = augmentResult.ok ? extractJSON(augmentResult.text) : null;

        const suggestedCues = (Array.isArray(augmentParsed) ? augmentParsed : []).map((c, i) => ({
            id:         `cue-${Date.now()}-sug-${i}`,
            name:       c.name ?? `Suggested cue ${i + 1}`,
            definition: c.definition ?? '',
            scale:      c.scale === 'three-point' ? 'three-point' : 'binary',
            layer:      [1, 2, 3].includes(c.layer) ? c.layer : 2,
            options:    Array.isArray(c.options) && c.options.length > 0
                ? c.options
                : (c.scale === 'three-point' ? ['Low', 'Medium', 'High'] : ['Yes', 'No']),
            source:     'ai-suggested',
        }));
        // Non-fatal if this call fails or returns nothing — the expert-derived
        // cues from the primary call are the ones that matter and are already secured.

        const cueLibrary = [...expertCues, ...suggestedCues];

        const cueOk = await saveCueLibrary(session.id, cueLibrary);
        if (!cueOk) {
            _showErr(el, "Couldn't save the proposed cue library. Try again.");
            _setBusy(el, false);
            return;
        }

        session.cueLibrary = cueLibrary;
        next();
    });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
const _EXAMPLE_FIELD_MAP = {
    whatYouDo: 'whatYouDoExample',
    decision:  'decisionExample',
    hard:      'hardExample',
};

// Renders the toggle button + hidden illustration box in a "pending" state.
// _attachExampleToggles() enables the button and fills the box — in practice
// this runs synchronously right after render() with the local example, which
// is always available, so this pending state is a defensive default rather
// than something a person is expected to actually see.
function _exampleToggleHTML(key) {
    return `
<button type="button" class="lab-example-toggle" data-example-key="${key}" disabled>
  Loading example…
</button>
<div class="lab-example-box" data-example-key="${key}" style="display:none"></div>`;
}

// Enables and wires up all three toggle buttons with resolved example
// content. Safe to call more than once — used both for the initial local
// render and again if an AI-enhanced version lands, or after "Refresh the
// examples". Local and AI-enhanced content are labelled identically to the
// person (both are "an example for a related role") — the distinction only
// matters internally for the fallback logic, not to someone reading it.
//
// If a CV/JD was provided, each box also gets a small secondary link that
// swaps its content to real evidence lines pulled from the document instead
// (_extractEvidenceLines) — a second, local, always-available option
// alongside the domain example, not a replacement for it.
function _attachExampleToggles(el, examples, documentsText) {
    const evidenceLines = extractEvidenceLines(documentsText);
    const domainLabel   = `Example — for a ${_esc(examples.adjacentRole || 'related role')} (illustration only, not to copy)`;
    const cvLabel        = "From your own CV/job description — not a generated example, just here in case a specific detail helps";

    Object.entries(_EXAMPLE_FIELD_MAP).forEach(([key, exampleKey]) => {
        const btn = el.querySelector(`.lab-example-toggle[data-example-key="${key}"]`);
        const box = el.querySelector(`.lab-example-box[data-example-key="${key}"]`);
        if (!btn || !box) return;

        const text = examples[exampleKey];
        if (!text) {
            btn.textContent = 'Example unavailable';
            btn.disabled    = true;
            return;
        }

        const cvLinkHTML = evidenceLines.length > 0
            ? `<button type="button" class="lab-example-subtoggle">or see something from your own CV instead</button>`
            : '';

        box.innerHTML = `
<div class="lab-example-label">${domainLabel}</div>
<p class="lab-example-text">${_esc(text)}</p>
${cvLinkHTML}`;

        btn.disabled    = false;
        btn.textContent = 'Show me an example for a role like mine';

        // Replace the node to drop any previous click listener before rewiring —
        // avoids stacking duplicate handlers across a "Refresh examples" click.
        const freshBtn = btn.cloneNode(true);
        btn.replaceWith(freshBtn);

        freshBtn.addEventListener('click', () => {
            const showing = box.style.display !== 'none';
            box.style.display    = showing ? 'none' : '';
            freshBtn.textContent = showing ? 'Show me an example for a role like mine' : 'Hide';
        });

        const subToggle = box.querySelector('.lab-example-subtoggle');
        if (subToggle) {
            let showingCV = false;
            subToggle.addEventListener('click', () => {
                showingCV = !showingCV;
                box.querySelector('.lab-example-label').textContent = showingCV ? cvLabel : domainLabel;
                box.querySelector('.lab-example-text').textContent  = showingCV ? evidenceLines.join('  ·  ') : text;
                subToggle.textContent = showingCV
                    ? 'or see the related-role example instead'
                    : 'or see something from your own CV instead';
            });
        }
    });
}

function _step(num, title, desc) {
    return `
<div class="intro-step">
  <div class="intro-step-num">${num}</div>
  <div>
    <div class="intro-step-title">${title}</div>
    <div class="intro-step-desc">${desc}</div>
  </div>
</div>`;
}

function _pips(active) {
    return Array.from({ length: 10 }, (_, i) => {
        const n   = i + 1;
        const cls = n === active ? 'active' : n < active ? 'done' : '';
        return `<div class="lab-pip ${cls}" title="Screen ${n}"></div>`;
    }).join('');
}

function _esc(s) {
    if (!s) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function _setBusy(el, busy) {
    const btn = el.querySelector('#profile-submit');
    if (!btn) return;
    btn.disabled    = busy;
    btn.textContent = busy ? 'Analysing your responses…' : 'Continue';
    el.querySelectorAll('input, textarea').forEach(i => { i.disabled = busy; });
}

function _setStageLabel(el, label) {
    const btn = el.querySelector('#profile-submit');
    if (btn) btn.textContent = label;
}

function _showErr(el, msg) {
    const e = el.querySelector('#profile-err');
    if (!e) return;
    e.textContent   = msg;
    e.style.display = '';
}

function _hideErr(el) {
    const e = el.querySelector('#profile-err');
    if (e) e.style.display = 'none';
}
