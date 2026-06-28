# Knowledge Extraction MVP — Specification

## What This Is

A single-user web app that tests two hypotheses:

1. **Extraction works** — the system can produce a Recipe that accurately represents what a skilled individual actually does, in a form more precise than what they would have written if simply asked.
2. **Transfer works** — a learner who goes through scenario sessions built from an expert's Recipe makes decisions measurably closer to the expert's pattern than before they had the Recipe.

Everything in this spec is traceable to one of those two tests. Anything not traceable to them is out of scope.

---

## Tech Stack

The MVP lives inside the **existing Lore repository** as a `/lab` subdirectory — the same pattern as Lore's existing `/admin`. It shares Lore's Firebase project, Cloudflare Worker, CSS design system, and utility functions. No new Firebase project, no new Worker deployment, no new Wrangler setup.

**Shared from Lore — do not touch these files:**

| File | What it provides |
|---|---|
| `firebase.js` | Firebase init, exported `db` and `auth` |
| `style.css` | Full design system — all tokens, components, buttons, inputs, nav |
| `engine/ai.js` | `classify()`, `generate()`, `ping()` — points to existing Worker |
| `engine/utils.js` | `extractJSON()` five-pass recovery, `friendlyAuthError()` |
| `engine/auth.js` | `signIn()`, `signOut()`, `onAuthChange()` |
| `engine/ingest.js` | `cleanText()`, `chunkDocument()` — used for document upload in profile intake |
| `404.html` | GitHub Pages SPA redirect — already handles all paths including `/lab` |

The existing Cloudflare Worker (`lore-worker`) is already live with Gemini and Groq API keys set as Wrangler secrets. The MVP's AI calls go through the same Worker at the same URL — nothing to configure.

**Built new — everything inside `/lab`:**
- `lab/index.html` — MVP shell, reusing Lore's HTML patterns
- `lab/app.js` — MVP router and auth state handler
- `lab/db.js` — Firestore reads/writes for the `sessions` collection
- `lab/model-fit.js` — decision tree fitting and policy summary logic
- `lab/views/` — ten view files, one per step

**Dev environment:** Windows 11, VS Code, PowerShell terminal, push to GitHub via VS Code's Git panel

### AI Models

| Call type | Purpose | Model | Temp | Max tokens |
|---|---|---|---|---|
| `classify` | Evaluation, extraction, structured JSON | `gemini-2.5-flash-lite` | 0.2 | 1024 |
| `generate` | Scenario generation, conversation, copy | `gemini-2.5-flash` | 0.7 | 4096 |
| Fallback (both) | Gemini 429 or 500 | `llama-3.3-70b-versatile` via Groq | same | 4096 |

All of the above is already handled. No new configuration needed.

### File structure

```
lore-platform/                  ← existing Lore repo root on GitHub
├── index.html                  ← existing Lore app — do not touch
├── style.css                   ← shared — do not touch
├── firebase.js                 ← shared — do not touch
├── 404.html                    ← shared — do not touch
├── engine/
│   ├── ai.js                   ← shared — do not touch
│   ├── utils.js                ← shared — do not touch
│   ├── auth.js                 ← shared — do not touch
│   ├── ingest.js               ← shared — do not touch
│   └── ...
├── admin/                      ← existing Lore admin — do not touch
│   └── ...
└── lab/                        ← NEW — all MVP files live here
    ├── index.html
    ├── app.js
    ├── db.js
    ├── model-fit.js
    └── views/
        ├── profile.js          — step 1: expert profile intake
        ├── sorting.js          — step 2: sorting task
        ├── cue-review.js       — step 3: cue library review
        ├── options.js          — step 4: decision option set review
        ├── session.js          — step 5: 30-scenario capture session
        ├── model-view.js       — step 6: policy summary review
        ├── elicitation.js      — step 7: elicitation conversation + triad
        ├── recipe.js           — step 8: recipe review and confirmation
        ├── transfer.js         — step 9: learner transfer test
        └── summary.js          — step 10: session results
```

### Import paths from `/lab`

All `/lab` files import shared modules by going up one level — the same pattern Lore's `/admin` already uses:

```javascript
import { db }           from '../firebase.js';
import { classify,
         generate,
         ping }         from '../engine/ai.js';
import { extractJSON }  from '../engine/utils.js';
import { signIn,
         signOut,
         onAuthChange } from '../engine/auth.js';
import { cleanText }    from '../engine/ingest.js';
```

---

## Data Model

All data lives in Firestore. One top-level collection: `sessions`.

### `sessions/{sessionId}`

```
{
  sessionId: string,
  createdAt: timestamp,
  expertUid: string,

  // Stage 0 — Foundation
  profile: {
    role: string,
    whatYouDo: string,
    decisionTypes: string,
    whatMakesItHard: string,
    documentsText: string        // extracted text from any uploaded docs
  },

  // Stage 0.2 — Cue Library
  cueLibrary: [
    {
      id: string,
      name: string,
      definition: string,
      scale: 'binary' | 'three-point',
      layer: 1 | 2 | 3,
      options: string[]
    }
  ],

  // Stage 0.3 — Decision Option Set
  decisionOptions: [
    { id: string, label: string, description: string }
  ],

  // Stage 1 — Sorting Task
  sortingTask: {
    situations: string[],
    groups: [
      {
        situationIds: string[],
        commonality: string,
        discriminator: string
      }
    ]
  },

  // Stage 2 — Scenario Session
  scenarios: [
    {
      scenarioId: string,
      cueCombination: object,      // silent
      text: string,
      structuredSelection: string,
      freeText: string,
      timeTaken: number,
      realismFlag: boolean,
      realismNote: string
    }
  ],

  // Stage 3 — Policy Model
  policyModel: {
    decisionTree: object,
    summaryText: string,
    expertAccuracyRating: 'accurate' | 'partial' | 'inaccurate',
    expertAccuracyNote: string,
    policyBreaks: string[]
  },

  // Stage 4 — Elicitation
  elicitation: {
    cases: [
      {
        scenarioId: string,
        exchange: [
          { role: 'system' | 'expert', content: string }
        ]
      }
    ],
    triad: {
      scenarioIds: string[],
      discriminationAnswer: string
    }
  },

  // Stage 5 — Recipe
  recipe: {
    extractedKnowledge: string,
    trigger: string,
    actionSequence: string[],
    expectedOutcome: string,
    expertValidation: 'accurate' | 'needs-editing' | 'send-back',
    expertValidationNote: string,
    status: 'draft' | 'confirmed' | 'rejected'
  },

  // Stage 6 — Transfer
  transfer: {
    learnerUid: string,
    preRecipeScenarios: [
      { scenarioId: string, selection: string }
    ],
    postRecipeScenarios: [
      { scenarioId: string, selection: string }
    ],
    comparisonResult: string,
    shiftMagnitude: number
  }
}
```

---

## AI Call Types

All calls go through `engine/ai.js` — already exists in Lore, import directly, do not recreate.

### `classify(prompt, systemPrompt)`
- Model: `gemini-2.5-flash-lite`, temperature 0.2, max 1024 tokens
- Used for: cue library extraction from profile text, plain-language policy summary, quality check on extracted material, Recipe construction (all three jobs), learner pre/post comparison
- Returns structured JSON — prompts must instruct the model to return JSON only with no markdown fences
- Always run the response through `extractJSON()` from `engine/utils.js` before parsing

### `generate(prompt, systemPrompt)`
- Model: `gemini-2.5-flash`, temperature 0.7, max 4096 tokens
- Used for: sorting task situations, scenario vignettes, elicitation follow-up questions, transfer comparison summary

### `engine/ai.js` — already exists in Lore, do not recreate

The existing `engine/ai.js` in the Lore repo already provides `classify()`, `generate()`, and `ping()`. Import directly from there using `../engine/ai.js`. The Worker URL, Gemini/Groq model routing, system prompt workaround, fallback logic, and ping mode are all already implemented and working.

`lab/app.js` should call `ping()` once on load, before any AI-heavy screen is reached, to warm up the Worker.

---

## Screens and Flow

### Screen 1 — Profile Intake
**File:** `lab/views/profile.js`
**Purpose:** collect domain context for cue library construction and scenario generation.

**Fields:**
- What is your area of expertise? *(short text)*
- Describe what your work actually involves day to day *(paragraph)*
- What kinds of decisions does your work involve? *(paragraph)*
- What makes a situation in your field genuinely difficult versus routine? *(paragraph)*
- Upload any relevant documents *(optional file upload, text extracted client-side)*

**On submit:** profile saved to Firestore. Classify call extracts a proposed cue list from the combined profile text. Proceed to Screen 2.

---

### Screen 2 — Sorting Task
**File:** `lab/views/sorting.js`
**Purpose:** refine the cue library through expert behaviour, not self-report.

**What the expert sees:** 12 short situation descriptions, AI-generated from the profile. Shown as cards they can drag into groups. After grouping, for each group:
1. What do these situations have in common?
2. What would make a situation that looks like one of these actually need a different response?

**On submit:** grouping dimensions added to cue library. Proceed to Screen 3.

---

### Screen 3 — Cue Library Review
**File:** `lab/views/cue-review.js`
**Purpose:** expert reviews and corrects the proposed cue library before scenarios are generated.

Each cue shown with name, definition, and scale. For each: Keep / Edit / Remove.

Two prompts below the list:
1. "Are there situations in your work that would need a different response but would look identical using only these cues?" — add a cue if yes
2. "Are there any of these that wouldn't actually change what you'd do?" — flag for removal

**On confirm:** cue library locked for this session. Proceed to Screen 4.

---

### Screen 4 — Decision Option Set Review
**File:** `lab/views/options.js`
**Purpose:** confirm the response options the expert will select between during scenarios.

4–6 proposed options, each with a label and short description. AI-generated from the profile. Expert can edit labels, descriptions, add an option, remove one.

**On confirm:** option set locked. Proceed to Screen 5.

---

### Screen 5 — 30-Scenario Session
**File:** `lab/views/session.js`
**Purpose:** capture the expert's decision pattern across varied situations.

- 30 scenarios, grouped into 5 sets of 6 with short breaks
- One scenario shown at a time, progress bar visible
- No score, no right/wrong shown at any point

**Each scenario card:**
- Situation text (AI-generated from a cue combination)
- Required: structured selection from the decision option set
- Optional: free-text elaboration field

**After each set of 6:** realism check — did any scenario feel unrealistic? Flag which one and describe what felt off.

**On session complete:** all 30 records saved. Proceed to Screen 6.

---

### Screen 6 — Policy Summary Review
**File:** `lab/views/model-view.js`
**Purpose:** show the expert what the system inferred from their responses.

3–5 plain-language statements describing their decision pattern.

**Expert responds:**
- Accurate / Partially accurate / Inaccurate
- If partially or inaccurate: what specifically is wrong or missing

**On submit:** rating saved. Policy breaks computed. Proceed to Screen 7.

---

### Screen 7 — Elicitation Session
**File:** `lab/views/elicitation.js`
**Purpose:** surface the reasoning behind pattern breaks and structure it toward a Recipe.

- 2–3 policy break cases surfaced, one at a time
- Conversational exchange per case (3–4 turns max, contextual follow-ups — never literally repeating "why")
- Document discrepancy surfaced if applicable
- Repertory Grid triad at the end: three scenarios, which two are handled the same, what makes the third different

**On submit:** full transcript and triad answer saved. Proceed to Screen 8.

---

### Screen 8 — Recipe Review
**File:** `lab/views/recipe.js`
**Purpose:** expert reviews and confirms the draft Recipe.

Three sequential classify calls on entry:
1. Quality check — is there a non-obvious expert-specific skill here?
2. Extraction — what is the actual knowledge, independent of Recipe format?
3. Formatting — produce Trigger, Action Sequence, Expected Outcome as JSON

**Expert responds:**
- Accurate → Recipe confirmed, shareable link shown
- Needs editing → inline edit fields open
- Send back → returns to Screen 7 with note on what was missing

Extracted knowledge statement stored permanently alongside the formatted Recipe.

---

### Screen 9 — Transfer Test (Learner)
**File:** `lab/views/transfer.js`
**Purpose:** test whether the Recipe transfers the expert's policy to a different person.

Accessed via shared link — no account required.

**Phase 1 — Pre-Recipe (15 scenarios):**
Structured selection required. No Recipe shown.

**Between phases:** learner reads the Recipe. Confirmation tap before Phase 2.

**Phase 2 — Post-Recipe (15 scenarios):**
15 new scenarios from the same cue space.

**On completion:** pre/post comparison computed via classify call. Both expert and learner see the summary.

---

### Screen 10 — Session Summary
**File:** `lab/views/summary.js`
**Purpose:** results display and research data.

**Expert view:** Recipe accuracy rating, learner pre/post shift description, specific areas where transfer did and did not occur.

**Learner view:** how decisions shifted, where pattern was already close to expert's, where gaps remain.

**Research log (both):** extraction accuracy rating, transfer shift magnitude, cue combinations where transfer succeeded or failed.

---

## What Is Out of Scope for MVP

- Multi-user organisational accounts
- Recipe approval by a third party
- Cue library refinement from session data (Pass 3)
- Bootstrapped model updating across multiple sessions
- Public Recipe library beyond the direct expert–learner pair
- Mobile-native app
- Gamification or rank system
- Any payment or gating mechanism

---

## Build Order

Four steps total. Step 0 is setup only. Steps 1–3 are one chat session each.

### Step 0 — Create `/lab` folder structure

Since Lore is already cloned locally, this is PowerShell folder and file creation only, then push to GitHub. No code written yet.

```
lab/
├── index.html
├── app.js
├── db.js
├── model-fit.js
└── views/
    ├── profile.js
    ├── sorting.js
    ├── cue-review.js
    ├── options.js
    ├── session.js
    ├── model-view.js
    ├── elicitation.js
    ├── recipe.js
    ├── transfer.js
    └── summary.js
```

Commit and push. Confirm `/lab` is visible on GitHub. Move to Step 1.

---

### Step 1 — Foundation + Setup Screens

**One chat session. Files: 4 core files + 4 view files.**

Build in this order:
1. `lab/index.html` — shell with auth screen and view containers, loads `app.js`
2. `lab/app.js` — auth state listener, `showView()` router, `ping()` on load
3. `lab/db.js` — all Firestore read/write functions for the `sessions` collection
4. Auth screen — sign in and sign up via `../engine/auth.js`
5. `lab/views/profile.js` — Screen 1
6. `lab/views/sorting.js` — Screen 2
7. `lab/views/cue-review.js` — Screen 3
8. `lab/views/options.js` — Screen 4

**Test before Step 2:** sign in works, profile intake saves a session to Firestore, cue library written with correct shape.

---

### Step 2 — Capture, Intelligence, Elicitation, Recipe

**One chat session — the most technically complex step. Restart the chat if context gets unwieldy, pasting the spec and current file states to continue.**

**Files: 1 logic module + 4 view files.**

Build in this order:
1. `lab/model-fit.js` — decision tree fitting, policy summary generation, policy break detection, bootstrapped prediction
2. `lab/views/session.js` — Screen 5: 30-scenario session
3. `lab/views/model-view.js` — Screen 6: policy summary review
4. `lab/views/elicitation.js` — Screen 7: elicitation conversation + triad
5. `lab/views/recipe.js` — Screen 8: three classify calls, Recipe display, expert review

**Test before Step 3:** one expert completes Screens 1–8, produces a confirmed Recipe, validates it as accurate. If the Recipe is clearly wrong, diagnose here before building the transfer layer.

---

### Step 3 — Transfer and Summary

**One chat session. Files: 2 view files.**

1. `lab/views/transfer.js` — Screen 9: learner link flow, pre/post scenarios, comparison
2. `lab/views/summary.js` — Screen 10: results display for expert and learner

**Test:** one learner completes the transfer test against a confirmed Recipe. Did their decision pattern shift toward the expert's?

---

### Testing note

Do not build Step 3 until at least one expert has completed Step 2 and validated the Recipe as accurate. The transfer test has no value if the Recipe it is testing is wrong.
