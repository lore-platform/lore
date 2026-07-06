// =============================================================================
// Lab — views/elicitation.js
// Screen 7 — Elicitation Session
//
// Surfaces 2-3 policy-break cases (read directly from
// session.policyModel.decisionTree.breaks — computed once in model-view.js,
// not recomputed here) one at a time, with a short conversational exchange
// per case, then a repertory-grid triad to close.
//
// Turn structure per case (3 exchanges — within the spec's "3-4 turns max"):
//   1. System opens with a DETERMINISTIC, templated question naming the
//      specific scenario and what was different about the expert's choice.
//      No AI call needed for this — the facts come straight from the break.
//   2. Expert answers.
//   3. System asks one AI-generated follow-up that reacts to what the
//      expert just wrote (never a generic "why", per spec) — this is where
//      generate() is used, with the running transcript as context.
//   4. Expert answers.
//   5. System asks one more AI-generated follow-up, same approach.
//   6. Expert answers, then the expert can move to the next case.
// If uploaded documents exist on the profile, an excerpt is included in the
// follow-up prompt context so the model can surface a conflict "if applicable"
// per the spec — it decides whether that's relevant, we don't force it.
//
// SEND-BACK RE-ENTRY: if the expert sent the Screen 8 Recipe back with a
// note on what was missing (session.recipe.status === 'draft' and
// expertValidation === 'send-back'), this screen opens with one extra
// freeform prompt addressing that note before (re)entering the case flow,
// so the resulting Recipe redraft has something new to work with.
// =============================================================================

import { generate }        from '../../engine/ai.js';
import { saveElicitation } from '../db.js';
import { selectTriad }     from '../model-fit.js';

const EXCHANGES_PER_CASE = 3;
const DOC_EXCERPT_CHARS  = 1500;

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------
let _cases       = [];  // rich break objects, from policyModel.decisionTree.breaks
let _caseIndex   = 0;
let _exchange    = [];  // [{ role: 'system' | 'expert', content }] for the CURRENT case
let _turnCount   = 0;   // number of system turns issued for the current case
let _finished    = [];  // completed { scenarioId, exchange } records

export function render(el, session, next) {
    _cases     = session.policyModel?.decisionTree?.breaks ?? [];
    _caseIndex = 0;
    _finished  = [];

    const isSendBackReentry = session.recipe?.status === 'draft'
        && session.recipe?.expertValidation === 'send-back'
        && session.recipe?.expertValidationNote;

    if (isSendBackReentry) {
        _renderSendBackPrompt(el, session, next);
        return;
    }

    _startCases(el, session, next);
}

// ---------------------------------------------------------------------------
// _renderSendBackPrompt — shown only when re-entering after the expert sent
// the draft Recipe back from Screen 8. Captures one more open answer and
// stores it as a synthetic case before continuing to the triad.
// ---------------------------------------------------------------------------
function _renderSendBackPrompt(el, session, next) {
    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(7)}</div>
  <h1 class="lab-h1">Before we redraft your Recipe</h1>
  <div class="lab-notice lab-info">
    Last time, you said the draft was missing something: "${_esc(session.recipe.expertValidationNote)}"
  </div>
  <p class="lab-sub">Tell us more about that — the next draft will be built with this in mind.</p>

  <div class="lab-card">
    <textarea class="input" id="sendback-answer" rows="4"
      placeholder="What should the Recipe capture that it's currently missing?"></textarea>
  </div>

  <div id="sendback-err" class="lab-notice lab-err" style="display:none"></div>

  <div class="lab-btn-row">
    <button type="button" class="btn btn-primary" id="sendback-continue">Continue</button>
  </div>
</div>`;

    el.querySelector('#sendback-continue').addEventListener('click', () => {
        const answer = el.querySelector('#sendback-answer').value.trim();
        if (!answer) {
            const errEl = el.querySelector('#sendback-err');
            errEl.textContent   = 'Please add a note before continuing.';
            errEl.style.display = '';
            return;
        }

        _finished.push({
            scenarioId: 'send-back-followup',
            exchange: [
                { role: 'system', content: `You noted the draft Recipe was missing: "${session.recipe.expertValidationNote}". Can you say more?` },
                { role: 'expert', content: answer },
            ],
        });

        _startCases(el, session, next);
    });
}

// ---------------------------------------------------------------------------
// _startCases — kicks off the case loop, or skips straight to the triad if
// there are no break cases to explore (a highly consistent expert).
// ---------------------------------------------------------------------------
function _startCases(el, session, next) {
    _caseIndex = 0;
    if (_cases.length === 0) {
        _renderTriad(el, session, next);
        return;
    }
    _openCase(el, session, next);
}

// ---------------------------------------------------------------------------
// _openCase — begins a case with its deterministic opening question.
// ---------------------------------------------------------------------------
function _openCase(el, session, next) {
    const brk      = _cases[_caseIndex];
    const scenario = (session.scenarios ?? []).find(s => s.scenarioId === brk.scenarioId);
    const options  = session.decisionOptions ?? [];

    const actualLabel   = options.find(o => o.id === brk.actualLabel)?.label   ?? brk.actualLabel;
    const expectedLabel = options.find(o => o.id === brk.expectedLabel)?.label ?? brk.expectedLabel;

    const opening = scenario
        ? `Here's a situation from your session: "${scenario.text}" — in similar situations, you generally chose to ${expectedLabel.toLowerCase()}, but here you chose to ${actualLabel.toLowerCase()} instead. What was different about this one, in your mind?`
        : `In one of your responses, you chose to ${actualLabel.toLowerCase()} where similar situations usually led you to ${expectedLabel.toLowerCase()}. What was different about this one, in your mind?`;

    _exchange  = [{ role: 'system', content: opening }];
    _turnCount = 1;

    _renderCase(el, session, next, scenario);
}

// ---------------------------------------------------------------------------
// _renderCase — draws the running transcript for the current case plus an
// input box for the expert's next reply.
// ---------------------------------------------------------------------------
function _renderCase(el, session, next, scenario) {
    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(7)}</div>
  <h1 class="lab-h1">A closer look</h1>
  <p class="lab-sub">Case ${_caseIndex + 1} of ${_cases.length} — a few quick questions about a specific decision.</p>

  <div class="lab-chat-wrap" id="chat-wrap">
    ${_exchange.map(_bubbleHTML).join('')}
  </div>

  <div id="case-input-wrap" class="lab-card">
    <textarea class="input" id="case-answer" rows="3" placeholder="Type your answer…"></textarea>
  </div>

  <div id="case-err" class="lab-notice lab-err" style="display:none"></div>

  <div class="lab-btn-row">
    <button type="button" class="btn btn-primary" id="case-send">Send</button>
  </div>
</div>`;

    el.querySelector('#case-send').addEventListener('click', () => _submitCaseAnswer(el, session, next, scenario));
}

// ---------------------------------------------------------------------------
// _submitCaseAnswer — records the expert's reply, then either requests an
// AI follow-up or closes out the case once EXCHANGES_PER_CASE is reached.
// ---------------------------------------------------------------------------
async function _submitCaseAnswer(el, session, next, scenario) {
    const textarea = el.querySelector('#case-answer');
    const answer   = textarea.value.trim();

    if (!answer) {
        const errEl = el.querySelector('#case-err');
        errEl.textContent   = 'Please add a reply before sending.';
        errEl.style.display = '';
        return;
    }

    _exchange.push({ role: 'expert', content: answer });

    if (_turnCount >= EXCHANGES_PER_CASE) {
        _closeCase(el, session, next);
        return;
    }

    // Show the expert's reply immediately, with a thinking indicator for the follow-up.
    el.querySelector('#chat-wrap').innerHTML = _exchange.map(_bubbleHTML).join('')
        + `<div class="lab-thinking" style="justify-content:flex-start;padding:var(--space-4) 0">
             <div class="lab-dots"><div class="lab-dot"></div><div class="lab-dot"></div><div class="lab-dot"></div></div>
           </div>`;
    el.querySelector('#case-input-wrap').style.display = 'none';
    el.querySelector('#case-send').disabled = true;

    const followUp = await _generateFollowUp(session, scenario);
    _exchange.push({ role: 'system', content: followUp });
    _turnCount++;

    _renderCase(el, session, next, scenario);
}

// ---------------------------------------------------------------------------
// _generateFollowUp — one AI call, reacting to the transcript so far.
// Falls back to a safe, still-non-generic question if the call fails.
// ---------------------------------------------------------------------------
async function _generateFollowUp(session, scenario) {
    const p            = session.profile ?? {};
    const docExcerpt   = (p.documentsText ?? '').slice(0, DOC_EXCERPT_CHARS);
    const transcript   = _exchange.map(t => `${t.role === 'system' ? 'Interviewer' : 'Expert'}: ${t.content}`).join('\n');

    const systemPrompt = `You are conducting a brief follow-up interview with a professional about a specific decision they made that differed from their usual pattern.
Ask exactly ONE short, natural follow-up question that builds on what they just said. Do not ask a generic "why" question, and do not repeat a question already asked in the transcript.
${docExcerpt ? 'If the reference document context below conflicts with what they just said, you may gently surface that tension in your question.' : ''}
Keep it to one or two sentences. Return plain text only — the question itself, nothing else, no quotation marks, no preamble.`;

    const prompt = `Area of expertise: ${p.role}
${scenario ? `Scenario under discussion: ${scenario.text}` : ''}
${docExcerpt ? `Reference document context:\n${docExcerpt}` : ''}

Conversation so far:
${transcript}

Ask one natural follow-up question.`;

    const result = await generate(prompt, systemPrompt);
    if (!result.ok || !result.text?.trim()) {
        console.warn('Lab elicitation.js: follow-up generation failed — using fallback question.');
        return "Can you say a bit more about what made this situation feel different at the time?";
    }
    return result.text.trim();
}

// ---------------------------------------------------------------------------
// _closeCase — records the finished case and moves to the next one, or to
// the triad if this was the last case.
// ---------------------------------------------------------------------------
function _closeCase(el, session, next) {
    _finished.push({ scenarioId: _cases[_caseIndex].scenarioId, exchange: _exchange });

    _caseIndex++;
    if (_caseIndex < _cases.length) {
        _openCase(el, session, next);
    } else {
        _renderTriad(el, session, next);
    }
}

// ---------------------------------------------------------------------------
// _renderTriad — the closing repertory-grid exercise. Skips gracefully to
// finishing the screen if the tree doesn't have enough leaf diversity to
// build a meaningful triad.
// ---------------------------------------------------------------------------
function _renderTriad(el, session, next) {
    const tree  = session.policyModel?.decisionTree?.tree;
    const triad = tree ? selectTriad(session.scenarios ?? [], tree) : null;

    if (!triad) {
        _finish(el, session, next, null);
        return;
    }

    const scenarioMap = new Map((session.scenarios ?? []).map(s => [s.scenarioId, s]));
    const letters      = ['A', 'B', 'C'];

    el.innerHTML = `
<div class="lab-wrap">
  <div class="lab-steps">${_pips(7)}</div>
  <h1 class="lab-h1">One last comparison</h1>
  <p class="lab-sub">
    Here are three situations from your session. Two of them you'd handle the same way —
    the third calls for something different.
  </p>

  <div id="triad-cards">
    ${triad.scenarioIds.map((id, i) => `
      <div class="lab-card">
        <div class="lab-section-head">Situation ${letters[i]}</div>
        <p style="margin:0;font-size:var(--text-base);line-height:1.6;color:var(--ink)">
          ${_esc(scenarioMap.get(id)?.text ?? '(situation text unavailable)')}
        </p>
      </div>`).join('')}
  </div>

  <div class="lab-card">
    <label class="label" for="triad-answer">
      Which two would you handle the same way, and what specifically makes the third one different?
    </label>
    <textarea class="input" id="triad-answer" rows="4"
      placeholder="e.g. A and C I'd handle the same because... B is different because..."></textarea>
  </div>

  <div id="triad-err" class="lab-notice lab-err" style="display:none"></div>

  <div class="lab-btn-row">
    <button type="button" class="btn btn-primary" id="triad-submit">Finish this step</button>
  </div>
</div>`;

    el.querySelector('#triad-submit').addEventListener('click', () => {
        const answer = el.querySelector('#triad-answer').value.trim();
        if (!answer) {
            const errEl = el.querySelector('#triad-err');
            errEl.textContent   = 'Please answer before continuing.';
            errEl.style.display = '';
            return;
        }
        _finish(el, session, next, { scenarioIds: triad.scenarioIds, discriminationAnswer: answer });
    });
}

// ---------------------------------------------------------------------------
// _finish — saves the full elicitation object and advances.
// ---------------------------------------------------------------------------
async function _finish(el, session, next, triadResult) {
    const elicitation = {
        cases: _finished,
        triad: {
            scenarioIds:           triadResult?.scenarioIds ?? [],
            discriminationAnswer:  triadResult?.discriminationAnswer ?? '',
        },
    };

    const wrap = el.querySelector('.lab-wrap') ?? el;
    wrap.innerHTML = `
  <div class="lab-thinking">
    <div class="lab-dots"><div class="lab-dot"></div><div class="lab-dot"></div><div class="lab-dot"></div></div>
    Saving…
  </div>`;

    const ok = await saveElicitation(session.id, elicitation);
    if (!ok) {
        wrap.innerHTML += `
<div class="lab-notice lab-err">Couldn't save this step. Try again.</div>
<button class="btn btn-primary" id="retry-elicit-save">Retry</button>`;
        el.querySelector('#retry-elicit-save').addEventListener('click', () => _finish(el, session, next, triadResult));
        return;
    }

    session.elicitation = elicitation;
    next();
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function _bubbleHTML(turn) {
    const cls = turn.role === 'system' ? 'lab-chat-system' : 'lab-chat-expert';
    return `<div class="lab-chat-bubble ${cls}">${_esc(turn.content)}</div>`;
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
