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
    provision.html    — Platform owner tool: create Manager accounts, manage orgs.
    seed-demo.html    — One-click demo data seeder (for demo environments only).
```

---

## How the data is structured

All data is org-scoped. Nothing leaks between organisations.

```
organisations/{orgId}/
  profile/                  — Org name, industry, proposed domain clusters
  users/{userId}/           — Profile, XP, streak, mastery, seniority, role
    tasks/{taskId}/         — Reviewer prompts (pending/completed)
    recipeLibrary/          — Recipes an Employee has saved after unlocking
    patternSignals/         — Manager-only cognitive pattern data (never shown to Employee)
  recipes/{recipeId}/       — Approved Career Recipes (the knowledge base)
  scenarios/{scenarioId}/   — Generated training scenarios
  extractions/{extractionId}/ — Staging area: raw → processed → approved/rejected
  domains/{domainId}/       — Confirmed skill areas (may be provisional from industry seed)

invites/{inviteId}/         — Invite tokens for new team members
```

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

    function isAdminEmail() {
      return request.auth != null && request.auth.token.email == 'YOUR_ADMIN_EMAIL';
    }

    function hasOrgAccess(orgId) {
      return request.auth != null && request.auth.token.orgId == orgId;
    }

    match /organisations/{orgId} {
      allow read, write: if isAdminEmail() || hasOrgAccess(orgId);
    }

    match /organisations/{orgId}/{document=**} {
      allow read, write: if isAdminEmail() || hasOrgAccess(orgId);
    }

    match /invites/{inviteId} {
      allow read: if request.auth != null;
      allow write: if isAdminEmail() || (request.auth != null && request.auth.token.role == 'manager');
    }
  }
}
```

Replace `YOUR_ADMIN_EMAIL` with the email address you use for the platform admin account.

---

## Provisioning the first Manager for an organisation

The app has no self-registration. Every account is created by the platform owner through the admin tool.

1. Go to `https://lore-platform.github.io/lore/admin/provision.html`
2. Sign in with your platform owner Firebase account (email/password — must be created in Firebase Console → Authentication → Users → Add user)
3. Enter your `ADMIN_SECRET` (the value you set with `wrangler secret put ADMIN_SECRET`)
4. Fill in the organisation name, org ID, Manager's details, and industry
5. Click Create — the tool creates the Firebase Auth account, sets the custom claims, creates the Firestore documents, and displays a temporary password to send to the Manager

The Manager signs in at `https://lore-platform.github.io/lore/` with their email and the temporary password.

---

## Seeding a demo environment

The seeder populates a fictional organisation (Meridian Advisory) with a complete dataset for demonstration purposes.

1. First, use the provision tool to create an org with the ID `lore-demo`
2. Go to `https://lore-platform.github.io/lore/admin/seed-demo.html`
3. Sign in with your platform owner account
4. Click Seed demo data and wait approximately 60–90 seconds

The seeder creates 25 recipes across 5 domains, 75 scenarios, 8 employees with 12 weeks of simulated training history, and 3 Reviewer contributions. The Reset button clears everything if you need a clean run.

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
| Firebase project | lore-platform-hu247 |
| Cloudflare Worker | https://lore-worker.slop-runner.workers.dev |
| Admin provision | https://lore-platform.github.io/lore/admin/provision.html |
| Demo seeder | https://lore-platform.github.io/lore/admin/seed-demo.html |

---

## Contributing

LORE uses vanilla JavaScript throughout. If you are adding a feature:

- Engine files (`engine/`) import Firebase directly using `./firebase.js`
- View files (`views/`) import engine files using `../engine/[file].js`
- No npm packages in the frontend — everything runs natively in the browser
- Comments are part of the specification. Do not remove or shorten them.
- Every function and non-obvious decision must be commented — readable by a non-technical person and by an AI reading cold
- British English throughout
- Gemini model strings are fixed: generation uses `gemini-2.5-flash`, classification uses `gemini-2.5-flash-lite`. Do not change these.

---

*LORE is built on the HOS framework — "From Knowledge to Judgement" (Itseuwa, 2025). Instructional Deconstruction, Open Thinking Frameworks, Execution Loop.*