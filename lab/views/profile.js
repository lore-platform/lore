// =============================================================================
// Lab — views/profile.js
// Screen 1 — Profile Intake
//
// On a first visit (session has no profile data), renders an intro guide
// explaining the 8-step process. The "Start session" button re-renders the
// same container with the profile form — no separate routing needed.
//
// On return visits (session already has profile data), skips the guide and
// goes straight to the form.
//
// After form submission, runs one classify() call to propose a cue library.
// Saves both profile and cueLibrary to Firestore before advancing.
// =============================================================================

import { classify }                    from '../../engine/ai.js';
import { extractJSON }                 from '../../engine/utils.js';
import { cleanText }                   from '../../engine/ingest.js';
import { saveProfile, saveCueLibrary } from '../db.js';

// Cap on document text sent to the AI — keeps classify() within token budget.
// [TUNING TARGET] raise if experts regularly upload longer documents.
const MAX_DOC_CHARS = 6000;

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
        "You'll see 12 situations from your field. Group the ones you'd handle the same way. Your groupings reveal what you actually pay attention to.")}
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
// _renderForm() — the profile intake form.
// Called directly on return visits, or after guide on first visit.
// p = the existing profile data (all empty strings on first visit).
// ---------------------------------------------------------------------------
function _renderForm(el, session, next, p) {
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
        <label class="label" for="f-role">What is your area of expertise?</label>
        <input class="input" id="f-role" type="text"
          placeholder="e.g. Senior commercial underwriter"
          value="${_esc(p.role)}" required>
      </div>

      <div class="form-group">
        <label class="label" for="f-whatyoudo">
          Describe what your work actually involves day to day
        </label>
        <textarea class="input" id="f-whatyoudo" rows="4"
          placeholder="Walk through a typical week — what crosses your desk, what you're weighing, who you're dealing with."
          required>${_esc(p.whatYouDo)}</textarea>
      </div>

      <div class="form-group">
        <label class="label" for="f-decisiontypes">
          What kinds of decisions does your work involve?
        </label>
        <p class="form-hint">
          Think about the recurring calls you make — not one-off decisions, but the
          types of judgements that come up regularly. For example: which things to
          prioritise over others, whether to approve or reject something, when to
          escalate versus handle it yourself, how to allocate limited resources
          between competing needs.
        </p>
        <textarea class="input" id="f-decisiontypes" rows="4"
          placeholder="e.g. Which features to build next, whether to escalate a client issue, how to allocate the team's time between projects"
          required>${_esc(p.decisionTypes)}</textarea>
      </div>

      <div class="form-group">
        <label class="label" for="f-hard">
          What makes a situation in your field genuinely difficult versus routine?
        </label>
        <p class="form-hint">
          Routine situations have a clear, quick answer — you barely have to think.
          Difficult ones make you pause, gather more information, or weigh competing
          factors before deciding. What is it about the difficult ones that isn't
          present in the routine ones? What's missing, unclear, or in conflict?
        </p>
        <textarea class="input" id="f-hard" rows="4"
          placeholder="e.g. When the data points in different directions, when stakeholder priorities conflict, when the risk level is unclear"
          required>${_esc(p.whatMakesItHard)}</textarea>
      </div>

      <div class="form-group" style="margin-bottom:0">
        <label class="label">Upload any relevant documents (optional)</label>
        <div class="lab-dropzone" id="dropzone">
          Click to choose files, or drag them here<br>
          <span style="font-size:0.78rem">Plain text, Markdown, or .csv work best — .docx/.pdf text extraction isn't supported yet, paste the text directly if needed</span>
          <input type="file" id="file-input" multiple accept=".txt,.md,.csv" style="display:none">
        </div>
        <div id="file-list"></div>
      </div>

    </div>

    <div class="lab-btn-row">
      <button type="submit" class="btn btn-primary" id="profile-submit">
        Continue
      </button>
    </div>
  </form>
</div>`;

    // ── Document upload ─────────────────────────────────────────────────
    let uploadedText = p.documentsText ?? '';
    const fileNames  = [];

    const dropzone   = el.querySelector('#dropzone');
    const fileInput  = el.querySelector('#file-input');
    const fileListEl = el.querySelector('#file-list');

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

    // ── Form submit ─────────────────────────────────────────────────────
    el.querySelector('#profile-form').addEventListener('submit', async (e) => {
        e.preventDefault();

        const profile = {
            role:            el.querySelector('#f-role').value.trim(),
            whatYouDo:       el.querySelector('#f-whatyoudo').value.trim(),
            decisionTypes:   el.querySelector('#f-decisiontypes').value.trim(),
            whatMakesItHard: el.querySelector('#f-hard').value.trim(),
            documentsText:   uploadedText,
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

        const cueLibrary = parsed.map((c, i) => ({
            id:         `cue-${Date.now()}-${i}`,
            name:       c.name ?? `Cue ${i + 1}`,
            definition: c.definition ?? '',
            scale:      c.scale === 'three-point' ? 'three-point' : 'binary',
            layer:      [1, 2, 3].includes(c.layer) ? c.layer : 2,
            options:    Array.isArray(c.options) && c.options.length > 0
                ? c.options
                : (c.scale === 'three-point' ? ['Low', 'Medium', 'High'] : ['Yes', 'No']),
        }));

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
