# LORE

**Organisational knowledge transfer. Built for the moment experienced people leave.**

---

## The problem

When an experienced person leaves an organisation, the most valuable thing they had leaves with them. Not their contacts list. Not their files. Their judgement — how they read a room, what they noticed that others missed, the calls they made without being able to explain exactly why.

Manuals do not capture this. Courses cannot reproduce it. Mentorship is inconsistent and does not scale.

Organisations spend significant resources replacing experienced staff and then spend more helping new people reach the same level of capability. Most of that knowledge transfer is informal, accidental, or does not happen at all.

LORE is built to change this.

---

## What LORE does

LORE captures expert judgement from the people who have it — without disrupting them or requiring them to teach — and makes it available to the people who need it, in a form they can actually absorb.

The knowledge is structured into a private, growing knowledge base that belongs entirely to the organisation. When someone new joins — whether replacing a departing colleague or simply onboarding into a team — they can be placed on a structured path through that knowledge. They learn what the organisation's best people know, at the speed the organisation decides.

The result: shorter time to competence, more consistent decision-making across the team, and less dependency on any one person's continued presence.

---

## The three roles

**Manager** — The primary user and decision-maker. Sees everything: the knowledge base, what is being extracted, who is learning what, where the gaps are. Sets up team members, reviews and approves extracted knowledge, and assigns each person their learning path. Has full visibility into every team member's capability development.

**Reviewer** — A senior practitioner on the team. Receives occasional short prompts — framed as quality checks and coaching moments. Responds in a few sentences. That is all they see. Their contributions flow into the knowledge base without them ever knowing it is happening. No extra burden. No change to how they work.

**Employee** — A junior or mid-level practitioner. Works through training scenarios drawn from the organisation's own knowledge. Responds to realistic situations from their actual field, receives feedback, and builds pattern recognition over time. Earns rank as they progress.

---

## How the knowledge flows

A senior practitioner on the team responds to a prompt. Their words are captured and stored as a permanent raw record. The system processes that record — first to understand what knowledge it contains, then to structure it, then to use it as the basis for training material. A Manager reviews and approves before anything reaches the knowledge base. Once approved, the knowledge becomes available for training scenarios. Employees encounter those scenarios, respond, and receive feedback grounded in the organisation's own expertise.

The same flow applies to documents the organisation already has. Playbooks, project retrospectives, client briefings, internal guides — any document can be uploaded and processed through the same pipeline. The system finds the expert decision logic inside it and extracts it.

Every piece of extracted knowledge — from whatever source — is stored permanently in its original form. It can be re-processed as the system evolves. It can eventually power different kinds of access to the knowledge, beyond training scenarios. The raw record is the asset. Everything else is a derived view of it.

---

## For knowledge management and L&D professionals

LORE sits at the intersection of knowledge management and learning design, and it makes a deliberate set of choices that are worth understanding.

**On tacit knowledge.** Most knowledge management systems are designed for explicit knowledge — documented processes, policies, reference material. LORE is designed specifically for tacit knowledge: the expertise that exists only in practitioners' heads and resists being written down. The extraction mechanism is designed around how tacit knowledge actually surfaces — through responses to real situations, through corrections, through the judgements people make when they are prompted to make them — rather than through structured documentation exercises.

**On learning transfer.** The gap between training and on-the-job performance is one of the most persistent problems in L&D. LORE addresses this by making the training content entirely specific to the organisation. Employees are not training on generic scenarios or industry best practice. They are training on their own organisation's patterns, drawn from their own senior colleagues' experience. The transfer problem is reduced because the training and the work are drawing from the same source.

**On knowledge retention.** When an experienced person is leaving, LORE supports a structured handover — a curated path through that person's extracted knowledge, assigned to their replacement. This is distinct from a general training path. It is targeted, role-specific, and designed to close the specific gap left by a specific departure.

**On contributor experience.** LORE takes the position that requiring experts to document their knowledge creates resistance and produces lower-quality outputs than capturing it in context. The Reviewer experience is designed to feel nothing like knowledge documentation. Contributors respond to prompts. The system does the structuring work.

---

## For designers and product contributors

LORE is built on a set of principles that should guide any contribution to the product.

The extraction is invisible. The Reviewer experience must never reveal what is actually happening to the knowledge they contribute. Every label, prompt, button, and confirmation message is written to feel like a quality review or coaching moment — never like knowledge capture. This is not deceptive in a harmful sense: the organisation has a legitimate interest in retaining its own expertise, and the Reviewer's contribution is the organisation's knowledge, not exclusively theirs. But the experience must be designed around the Reviewer's natural frame of reference, not the system's internal model.

Learning should feel like nothing. The Employee experience must never announce itself as training. The scenario is the lesson. The feedback is the teaching. There is no preamble, no module structure, no "you are now being trained" framing. The product should feel more like a daily habit than a course.

The Manager is the primary customer. When there is a design tension between what is useful for the Manager and what is convenient for another role, the Manager wins. They are the decision-maker, the buyer, and the person accountable for the organisation's capability.

Simplicity is not a constraint — it is the product. LORE does one thing. It is not a general learning platform, a knowledge wiki, a course builder, or an HR system. Every feature should serve the core job: extract tacit knowledge, transfer it to people who need it.

---

## For data and systems contributors

LORE's knowledge pipeline is the technical heart of the product. Understanding it is essential before contributing to it.

All knowledge enters through one of two paths: a Reviewer responding to a prompt, or a Manager uploading a document. Either way, the first thing that happens is that the raw content is stored permanently as a complete record. It is never truncated, never overwritten, and never discarded. The source text and the metadata of how it was captured are part of the permanent record.

Processing happens in stages. The first stage is code-based: cleaning, normalisation, deduplication by content hash, chunking of long documents into manageable segments with overlapping context windows. The second stage is AI-based: classification to identify whether the content contains expert decision logic, then extraction of a structured knowledge representation, then derivation of a recipe draft from that representation. Each stage produces its own stored output, layered on top of the raw record rather than replacing it.

Human approval gates the knowledge base. No extraction reaches the knowledge base without a Manager reviewing and approving it. AI confidence scores inform the review but do not bypass it.

The data model is org-scoped. Nothing leaks between organisations. The platform operator has a separate namespace from all customer data.

---

## Technical overview

LORE is deliberately built with minimal dependencies.

The frontend is vanilla JavaScript, HTML, and CSS. No framework, no build step, no bundler. ES modules run natively in the browser. This makes the codebase readable and modifiable without a development environment setup.

Authentication and data storage use Firebase — Firebase Auth for identity with custom role claims, and Firestore for all application data organised by organisation.

AI processing routes through a Cloudflare Worker proxy. API keys never touch the browser. The Worker handles both AI calls and Firebase Admin operations.

The application is hosted on GitHub Pages, served directly from the repository.

---

## Repository structure

```
lore/
  index.html          — App shell. All views live inside this single page.
  style.css           — Brand system: colours, typography, component styles.
  app.js              — Auth listener and role-based router.
  firebase.js         — Firebase initialisation and exports.

  views/
    training.js       — Employee training loop.
    tasks.js          — Reviewer prompt interface.
    dashboard.js      — Manager knowledge base and team intelligence.
    profile.js        — Manager per-employee capability view.

  engine/
    ai.js             — All AI calls. Never called directly from views.
    auth.js           — Sign-in, invite redemption, invite generation.
    state.js          — XP, streak, rank, domain mastery.
    scenarios.js      — Scenario generation, evaluation, and storage.
    recipes.js        — Knowledge pipeline: extraction, processing, approval.
    domains.js        — Skill area management and AI clustering.
    ingest.js         — Code-only content cleaning, chunking, and deduplication.

  worker/
    index.js          — Cloudflare Worker: AI proxy and admin claims endpoint.
    wrangler.toml     — Worker configuration.

  admin/
    index.html        — Platform admin dashboard.
    admin.js          — Provisioning, seeding, and activity logging.
```

---

## Setting up for development

The application runs directly in the browser with no build step required.

Clone the repository and serve it with any static server. VS Code Live Server works well. The application connects to the live Firebase project by default. For a separate development environment, create a new Firebase project and update `firebase.js` with its configuration.

Node.js is only required for deploying or modifying the Cloudflare Worker.

---

## Infrastructure

| Component | Details |
|---|---|
| Repository | https://github.com/lore-platform/lore |
| Live application | https://lore-platform.github.io/lore/ |
| Admin dashboard | https://lore-platform.github.io/lore/admin/ |
| Firebase project | lore-platform-hu247 |

---

## Contributing

Contributions to LORE are welcome across several dimensions — not only code.

**Knowledge management and L&D professionals:** The product's core decisions — how tacit knowledge is structured, what a useful training scenario looks like, how feedback should be framed for different learning outcomes — benefit from domain expertise. Contributions to the specification, design principles, and knowledge model are as valuable as code contributions.

**Designers:** The three role experiences (Manager, Reviewer, Employee) each have distinct design requirements and constraints. See the design principles above. The brand system lives in `style.css`.

**Data and systems contributors:** The knowledge pipeline and Firestore data model are documented in the codebase. See `engine/ingest.js`, `engine/recipes.js`, and the data model section above.

**Code contributors:**
- Vanilla JavaScript throughout — no frameworks, no npm packages in the frontend
- Engine files import Firebase using `../firebase.js`
- View files import engine files using `../engine/[file].js`
- Comments are part of the specification — do not remove or shorten them
- British English throughout
- Every function must be commented clearly enough to be understood by a non-technical reader

---

*LORE is the organisational implementation of the HOS framework — ["From Knowledge to Judgement" (Itseuwa, 2025)](https://osioke.github.io/from-knowledge-to-judgement/).*