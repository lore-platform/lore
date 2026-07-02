// =============================================================================
// Lab — views/intro.js
// Screen 0 — Introduction
//
// Shown once before Screen 1, only when the session has no profile data yet.
// Explains what the extraction process is, what the expert will produce,
// and what each of the 8 steps involves. Does not use pips — it is not
// a numbered step in the session sequence.
//
// The `advance` callback is passed directly from app.js as:
//   () => showView('profile')
// rather than going through _makeAdvance(), because 'intro' is not in
// SCREEN_SEQ and has no Firestore writes of its own.
// =============================================================================

export function render(el, session, advance) {
    el.innerHTML = `
<div class="lab-wrap" style="max-width:600px">

  <h1 class="lab-h1" style="margin-top:var(--space-6)">What you're about to do</h1>
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
        'You\'ll see 12 situations from your field. Group the ones you\'d handle the same way. Your groupings reveal what you actually pay attention to.')}
      ${_step(3, 'Review your cues',
        'The system proposes a list of the factors that drive your decisions. You check, edit, and add to it until it\'s accurate.')}
      ${_step(4, 'Confirm your options',
        'Review the range of actions available to you — these are the choices you\'ll pick between in the scenario session.')}
      ${_step(5, 'Scenario session',
        '30 quick situations, one after another. Pick a response for each. No explanations needed — just your instinct.')}
      ${_step(6, 'Review your decision pattern',
        'See how the system understood your decisions. You confirm whether it\'s right, and correct it if not.')}
      ${_step(7, 'Deep-dive',
        'Walk through a few tricky edge cases and explain what you noticed that others might have missed.')}
      ${_step(8, 'Your Recipe',
        'Review the extracted knowledge and confirm it accurately represents how you actually make decisions in your field.')}
    </div>
  </div>

  <div class="lab-notice lab-info">
    Your progress is saved automatically after each step. If you need to stop
    and come back, you\'ll resume exactly where you left off.
  </div>

  <button type="button" class="btn btn-primary btn-full" id="intro-start"
    style="margin-top:var(--space-4);padding:var(--space-4)">
    Start session →
  </button>

</div>`;

    el.querySelector('#intro-start').addEventListener('click', advance);
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
