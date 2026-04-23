# LORE

**Organisational knowledge transfer, built on game mechanics.**

LORE captures what your best people know — how they think, what they notice, the judgements they make without thinking — and turns it into training that feels nothing like training.

Senior practitioners contribute without knowing they are contributing. Junior and mid-level practitioners train against realistic scenarios drawn from their own organisation's senior experience. Managers see everything: who is learning, where the gaps are, what the knowledge base looks like.

---

## What problem does this solve?

When experienced people leave an organisation, their pattern recognition leaves with them. It is the most valuable thing they had, and it is the hardest to transfer. Manuals do not capture it. Courses do not reproduce it. Mentorship is inconsistent and unscalable.

LORE solves this by extracting that pattern recognition passively — through materials the organisation already produces — and turning it into structured training scenarios. The senior practitioner never knows it is happening. The junior practitioner experiences it as a game, not a lesson.

---

## How it works

There are three roles in LORE:

**Manager** (the primary customer)
Sets up the organisation, reviews and approves extracted knowledge, monitors team progress. Sees the knowledge base, the extraction pipeline, and detailed capability intelligence for every team member.

**Reviewer** (the knowledge source)
Senior practitioners who receive occasional prompts — framed as quality checks and coaching moments. They are never told their responses are being structured into training content. They see only a simple review interface, never the knowledge base.

**Employee** (the learner)
Junior and mid-level practitioners who train through scenarios. They respond to realistic workplace situations, receive AI-evaluated feedback, and earn XP and rank as they progress. They never see the recipes behind the scenarios.

---

## The knowledge pipeline

```
Senior practitioner responds to a prompt
        ↓
Raw response staged as an extraction in Firestore
        ↓
AI processes it into a structured Career Recipe draft
        ↓
Manager reviews and approves (or edits and approves)
        ↓
Recipe enters the knowledge base
        ↓
AI generates training scenarios from the recipe
        ↓
Employees train against scenarios drawn from senior experience
        ↓
Performance data flows back to the Manager's intelligence view
```

---

## Technology

LORE is built with deliberately minimal dependencies.

- **Frontend:** Vanilla JavaScript, HTML, CSS. No framework, no bundler, no build step. ES modules run natively in the browser.
- **Auth and database:** Firebase Auth (custom claims for role-based access) and Firestore (org-scoped data model).
- **AI:** Gemini via a Cloudflare Worker proxy. Keys never touch the browser. Groq (Llama 3.3 70B) as a fallback.
- **Hosting:** GitHub Pages, served from the repository root.

---

## Repository structure

```
lore/
  index.html          — App shell. All views live inside this single page.
  style.css           — All brand colours, typography, and component styles.
  app.js              — Auth listener and role-based router.
  firebase.js         — Firebase initialisation and exports.
  404.html            — GitHub Pages SPA routing fallback.

  views/
    training.js       — Employee training loop (domain select → scenario → result).
    tasks.js          — Reviewer prompt interface.
    dashboard.js      — Manager knowledge base, extraction queue, team intelligence.
    profile.js        — Manager per-employee capability profile.

  engine/
    ai.js             — All AI calls. Never called directly from views.
    auth.js           — Sign-in, invite redemption, invite generation, custom claims.
    state.js          — XP, streak, rank, domain mastery. localStorage + Firestore sync.
    scenarios.js      — Scenario fetch, generation, storage, evaluation, Reviewer task writing.
    recipes.js        — Recipe and domain reads. Extraction pipeline writes.
    domains.js        — Domain cluster reads, writes, and AI clustering trigger.

  worker/
    index.js          — Cloudflare Worker: AI proxy + Firebase Admin claims endpoint.
    wrangler.toml     — Worker configuration.

  admin/
    index.html        — Unified platform admin dashboard shell.
    admin.js          — All admin logic: provision, seed, reset, activity log.
```

---

## How the data is structured

All customer data is org-scoped. Nothing leaks between organisations. The platform operator has a dedicated namespace separate from customer data.

```
platform/
  lore-platform/                — Platform operator singleton document
                                  (product name, owner email, initialised flag)
    adminLogs/{logId}/          — Every admin action: provision, delete, seed, reset.
                                  Fields: action, orgId, orgName, detail, outcome,
                                  errorMsg, performedBy, createdAt.

organisations/{orgId}/          — Top-level org document (required for listing)
                                  Fields: orgName, industry, createdAt, provisionedBy
  profile/data                  — Org profile sub-document read by dashboard and
                                  domains engine. Fields: orgName, industry,
                                  proposedClusters, lastClusteredAt.
  users/{userId}/               — Profile, XP, streak, mastery, seniority, role
    tasks/{taskId}/             — Reviewer prompts (pending/completed)
    recipeLibrary/              — Recipes an Employee has saved after unlocking
    patternSignals/             — Manager-only cognitive pattern data
  recipes/{recipeId}/           — Approved Career Recipes (the knowledge base)
  scenarios/{scenarioId}/       — Generated training scenarios
  extractions/{extractionId}/   — Staging area: raw → processed → approved/rejected
  domains/{domainId}/           — Confirmed skill areas

invites/{inviteId}/             — Invite tokens for new team members
```

**Why `organisations/{orgId}` exists as a document:** Firestore's `getDocs()` on a collection only returns documents that have been explicitly written at that path. Sub-documents alone (like `profile/data`) do not cause the parent to appear in collection queries. The top-level org document is written by the admin tool on every provision and seed operation.

**Why `platform/` is separate:** The platform operator (LORE HQ) is a real entity in the system with its own concerns — admin activity logs, platform config. Putting these at the Firestore root alongside `organisations/` would mix operator and customer concerns. The `platform/` namespace is admin-only by Firestore rules; no org member can read or write it.

---

## Roles and what they see

| Role | What they see | What they never see |
|---|---|---|
| Manager | Everything — knowledge base, extraction queue, team progress, per-employee intelligence | Nothing is hidden |
| Reviewer | Their own prompt queue (3–5 items, framed as quality checks) | Knowledge base, recipes, extractions, other users |
| Employee | Their training scenarios, their own XP and rank, their saved recipes | Recipes behind scenarios, other users, pattern signals |

---

## Setting up for development

The app runs directly in the browser with no build step.

1. Clone the repository: `git clone https://github.com/lore-platform/lore.git`
2. Serve it locally using any static server. VS Code Live Server works well. Or: `npx serve .` from the repo root.
3. The app connects to the live Firebase project by default. For a development environment, create a separate Firebase project and update `firebase.js` with its config.

**You do not need Node.js to run or develop the frontend.** Node is only needed if you want to deploy or modify the Cloudflare Worker.

---

## Deploying the Worker

The Cloudflare Worker proxies all AI calls and handles Firebase Admin operations (setting custom claims).

```bash
cd worker
npm install -g wrangler
wrangler login
wrangler deploy
```

Set the required secrets — these are never stored in source code:

```bash
wrangler secret put GEMINI_API_KEY
wrangler secret put GROQ_API_KEY
wrangler secret put FIREBASE_PROJECT_ID
wrangler secret put FIREBASE_CLIENT_EMAIL
wrangler secret put FIREBASE_PRIVATE_KEY
wrangler secret put ADMIN_SECRET
```

`FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY` come from a Firebase service account JSON (Firebase Console → Project Settings → Service Accounts → Generate new private key). When setting `FIREBASE_PRIVATE_KEY`, paste the entire key including the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines.

---

## Firestore security rules

Paste these rules in Firebase Console → Firestore → Rules:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function isAdmin() {
      return request.auth != null
          && request.auth.token.email == 'YOUR_ADMIN_EMAIL';
    }

    function hasOrgAccess(orgId) {
      return request.auth != null
          && request.auth.token.orgId == orgId;
    }

    function isManager(orgId) {
      return hasOrgAccess(orgId) && request.auth.token.role == 'manager';
    }

    function isEmployee(orgId) {
      return hasOrgAccess(orgId) && request.auth.token.role == 'employee';
    }

    function isReviewer(orgId) {
      return hasOrgAccess(orgId) && request.auth.token.role == 'reviewer';
    }

    // Platform operator namespace — admin only
    match /platform/{document=**} {
      allow read, write: if isAdmin();
    }

    // Customer orgs — top-level document
    match /organisations/{orgId} {
      allow read:  if isAdmin() || hasOrgAccess(orgId);
      allow write: if isAdmin() || isManager(orgId);
    }

    // All org sub-collections
    match /organisations/{orgId}/{document=**} {
      allow read:  if isAdmin() || hasOrgAccess(orgId);
      allow write: if isAdmin() || isManager(orgId) || isEmployee(orgId) || isReviewer(orgId);
    }

    // Invite tokens
    match /invites/{inviteId} {
      allow read:  if request.auth != null;
      allow write: if isAdmin()
                   || (request.auth != null && request.auth.token.role == 'manager');
    }
  }
}
```

Replace `YOUR_ADMIN_EMAIL` with your platform owner email address.

---

## Using the admin dashboard

The admin dashboard at `https://lore-platform.github.io/lore/admin/` is the single tool for all platform management. It replaces the old `provision.html` and `seed-demo.html` pages.

**Provisioning a Manager for an organisation:**
1. Go to `https://lore-platform.github.io/lore/admin/`
2. Sign in with your platform owner Firebase account
3. Enter your `ADMIN_SECRET` when prompted
4. Fill in the organisation details and Manager's information
5. Click "Create Manager account" — the tool checks for duplicate emails and org IDs before writing anything, runs each step with a live progress log, and displays login details on success

**Seeding the demo environment:**
The demo section is pre-filled with Meridian Advisory details. Click "Provision + Seed demo" to run the full flow in one step — it creates the Manager account and seeds all data sequentially with a unified progress log. Run Reset first if you have seeded before.

**Provisioned organisations list:**
Shows all orgs with Manager name, email, UID, industry, and creation date. Each row has a Delete button that removes the Firebase Auth account and all Firestore data in a single operation.

**Activity log:**
Every admin action (provision, delete, seed, reset) is written to Firestore at `platform/lore-platform/adminLogs/` and displayed newest-first. Persists across devices and browser sessions.

---

## Key design principles

**Knowledge extraction is invisible.** Reviewers never know they are contributing to a knowledge base. Every prompt they receive is framed as reviewing, coaching, or quality-checking — never as knowledge capture.

**Learning should feel like nothing.** The lesson is the experience, not a preamble. Employees see a scenario, respond, and get feedback. There is no explicit "you are now being trained" framing.

**The org's knowledge belongs to the org.** Nothing is seeded from outside LORE's industry starting points. An empty knowledge base on day one is correct.

**Domains emerge from knowledge.** Skill areas are not pre-set. They are proposed by AI after enough recipes accumulate, and confirmed by the Manager.

**The Manager is the primary customer.** Full visibility, full intelligence. Every design decision serves the person making decisions about their organisation.

---

## Infrastructure

| Component | Details |
|---|---|
| GitHub org | lore-platform |
| Repository | https://github.com/lore-platform/lore |
| Live app | https://lore-platform.github.io/lore/ |
| Admin dashboard | https://lore-platform.github.io/lore/admin/ |
| Firebase project | lore-platform-hu247 |
| Cloudflare Worker | https://lore-worker.slop-runner.workers.dev |

---

## Contributing

LORE uses vanilla JavaScript throughout. If you are adding a feature:

- Engine files (`engine/`) import Firebase directly using `../firebase.js`
- View files (`views/`) import engine files using `../engine/[file].js` and Firebase using `../firebase.js`
- Admin files (`admin/`) import Firebase using `../firebase.js`
- No npm packages in the frontend — everything runs natively in the browser
- Comments are part of the specification. Do not remove or shorten them.
- Every function and non-obvious decision must be commented — readable by a non-technical person and by an AI reading cold
- British English throughout
- Gemini model strings are fixed: generation uses `gemini-2.5-flash`, classification uses `gemini-2.5-flash-lite`. Do not change these.

---

*LORE is built on the HOS framework — "From Knowledge to Judgement" (Itseuwa, 2025). Instructional Deconstruction, Open Thinking Frameworks, Execution Loop.*