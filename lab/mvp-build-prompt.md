# MVP Build Prompt — Knowledge Extraction Lab (`/lab`)

Paste this prompt plus the spec (`mvp-spec.md`) at the start of each new chat session.

---

## Context — what already exists in the Lore repo

The MVP lives inside the existing `lore-platform` GitHub repository as `/lab`. The following already exist and must not be modified:

| File | What it provides |
|---|---|
| `firebase.js` | Firebase init, exported `db` and `auth` |
| `style.css` | Full design system — all tokens, components, buttons, inputs, nav |
| `engine/ai.js` | `classify()`, `generate()`, `ping()` — calls the live Cloudflare Worker |
| `engine/utils.js` | `extractJSON()` five-pass JSON recovery, `friendlyAuthError()` |
| `engine/auth.js` | `signIn()`, `signOut()`, `onAuthChange()` |
| `engine/ingest.js` | `cleanText()`, `chunkDocument()` for document text processing |
| `404.html` | GitHub Pages SPA redirect — already handles all paths including `/lab` |

The Cloudflare Worker (`lore-worker`) is already live. Gemini and Groq API keys are already set as Wrangler secrets. No Worker changes are needed.

**Import paths from `/lab` — always go up one level:**
```javascript
import { db }            from '../firebase.js';
import { classify,
         generate, ping } from '../engine/ai.js';
import { extractJSON }   from '../engine/utils.js';
import { signIn, signOut,
         onAuthChange }  from '../engine/auth.js';
import { cleanText }     from '../engine/ingest.js';
```

---

## Stack — fixed, do not change

- Vanilla HTML, CSS, JavaScript — no frameworks, no build tools, no npm for the frontend
- Existing Firebase project — no new project needed
- Existing Cloudflare Worker — no Wrangler, no new secrets
- GitHub Pages — `/lab` accessible at `https://lore-platform.github.io/lore/lab/`
- Dev environment: Windows 11, VS Code, PowerShell terminal, push via VS Code Git panel

---

## Ground rules

- All Firestore reads and writes go through `lab/db.js` — no inline Firestore calls in view files
- All AI calls go through `../engine/ai.js` — no direct Worker fetch calls anywhere in `/lab`
- Every `classify()` response that expects JSON must go through `extractJSON()` from `../engine/utils.js` before parsing
- Call `ping()` from `../engine/ai.js` once on app load in `lab/app.js`
- The data model in the spec is the source of truth for Firestore document structure — do not deviate without flagging it first
- Do not touch any file outside the `/lab` directory

---

## How to work with me

- Build one file at a time within a step
- After each file, tell me exactly what to create or edit, where it lives, and what to do next
- Write exact PowerShell commands when terminal work is needed
- Describe Firebase console actions precisely with exact field names and values
- Flag any decision that needs my input before proceeding
- If something in the spec is ambiguous, ask before assuming

---

## Step 0 — Folder structure (first chat only)

Lore is already cloned locally. Give me the exact PowerShell commands to:

1. Create this structure inside the existing repo:
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
All files as empty placeholders.

2. Confirm these shared files exist in the repo root:
`firebase.js`, `style.css`, `engine/ai.js`, `engine/utils.js`, `engine/auth.js`, `engine/ingest.js`

3. Commit and push via VS Code Git panel

Once `/lab` is visible on GitHub, start a new chat for Step 1.

---

## Step 1 — Foundation + Setup Screens (new chat)

Tell me at the start of this chat that we are on Step 1. Build in this order:

1. `lab/index.html` — shell with auth screen div and all view divs, loads `app.js` as a module
2. `lab/app.js` — auth state listener using `onAuthChange`, `showView()` router, calls `ping()` on load
3. `lab/db.js` — all Firestore read/write functions for the `sessions` collection (full data model from spec)
4. Auth screen wired up — sign in and sign up using `signIn()` from `../engine/auth.js`
5. `lab/views/profile.js` — Screen 1: profile intake form, classify call for cue extraction, saves to Firestore
6. `lab/views/sorting.js` — Screen 2: AI-generated situation descriptions, grouping UI, discrimination prompts
7. `lab/views/cue-review.js` — Screen 3: cue library review, keep/edit/remove
8. `lab/views/options.js` — Screen 4: decision option set review and confirmation

**Test before moving to Step 2:** sign in works, profile intake saves a session document to Firestore with the correct shape, cue library written correctly.

---

## Step 2 — Capture, Intelligence, Elicitation, Recipe (new chat)

Tell me at the start of this chat that we are on Step 2. Paste the current state of `lab/db.js` and any view files Screen 5 depends on. Build in this order:

1. `lab/model-fit.js` — decision tree fitting, policy summary generation, policy break detection, bootstrapped prediction
2. `lab/views/session.js` — Screen 5: 30-scenario session
3. `lab/views/model-view.js` — Screen 6: policy summary review
4. `lab/views/elicitation.js` — Screen 7: conversational exchange + triad
5. `lab/views/recipe.js` — Screen 8: three classify calls, Recipe display, expert review

**If context gets unwieldy mid-step:** start a fresh chat, paste this prompt, the spec, and the current state of all `/lab` files built so far. Continue from where you left off.

**Test before moving to Step 3:** one expert completes all eight screens and produces a confirmed Recipe. Ask them: does this Recipe accurately represent what you actually do? If yes, extraction is working. If no, diagnose before building Step 3.

---

## Step 3 — Transfer and Summary (new chat)

Tell me at the start of this chat that we are on Step 3. Paste the confirmed Recipe and the current state of `lab/db.js`. Build in this order:

1. `lab/views/transfer.js` — Screen 9: learner flow, pre/post scenarios, comparison
2. `lab/views/summary.js` — Screen 10: results display for expert and learner

**Test after this chat:** one learner completes the transfer test against a Recipe the expert validated as accurate. Did their decision pattern shift toward the expert's? This answers the second core question.

---

## Context management

Start a new chat for each step. At the start of each new chat, paste this prompt and the spec. Paste the current state of any files being modified in that session. Do not run the full build in one conversation.

## On using Claude Sonnet 4.6

Use standard mode — no extended thinking — for all routine build steps. Speed and precision matter more than deep reasoning for iterative coding work. If a genuinely complex architectural decision comes up, ask the model to "think carefully about this before answering" for that one question only.
