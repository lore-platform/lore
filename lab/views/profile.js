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
// with zero network calls, the instant role is entered — see the LOCAL
// DOMAIN SYSTEM block below (_detectDomain / _pickAdjacentDomain /
// _localExamples / DOMAIN_CONTENT). Phase B renders immediately using this,
// no wait, no loading state on Continue. One classify() call then runs in
// the background to try to produce a more tailored version, informed by the
// CV/JD when one was given; if it lands, it patches the toggles in place
// (see _attachExampleToggles). If it's slow, fails, or AI is unavailable,
// nothing happens — the local example already shown is not treated as a
// degraded state to recover from, it's the intended default experience.
// AI is a layer that can make a good local answer better; it was deliberately
// not built as the thing the feature depends on to work at all.
//
// If a CV/JD was provided, a small secondary link inside each toggle's box
// offers real evidence lines extracted from it (_extractEvidenceLines) as an
// alternative to the domain example — also local, also no AI.
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

// Cap on document text sent to the AI — keeps classify() within token budget.
// [TUNING TARGET] raise if experts regularly upload longer documents.
const MAX_DOC_CHARS     = 6000;
const EXAMPLE_DOC_CHARS = 2000;  // smaller excerpt for the example-generation call — only needs
                                  // enough to calibrate tone/specificity, not the full document
const MAX_EVIDENCE_LINES = 5;    // cap on how many CV lines the local extractor surfaces

// =============================================================================
// LOCAL DOMAIN SYSTEM — no AI, no network call, no wait.
//
// This is the primary source for the adjacent-role examples on Screen 1.
// AI (_generateExamples, further down) is an ENHANCEMENT layer on top of this,
// not a dependency — if the AI call is slow, fails, or is unavailable, what's
// shown is this local content, not an error state or a blank toggle. The
// person typing on the other end of a bad connection or a temporary outage
// still gets a genuinely useful example, not a degraded one.
//
// Three pieces:
//   DOMAIN_SIGNALS  — keyword lists for a lightweight local classifier
//                      (_detectDomain), scored against the entered role text
//                      and any CV/JD provided. Deliberately spans well beyond
//                      tech — insurance, hospitality/retail, healthcare,
//                      research, education, legal, HR, finance, community,
//                      operations, sales, marketing, alongside product/
//                      design/engineering/data — since testers are not
//                      predominantly technical roles.
//   DOMAIN_ADJACENCY — a hand-curated map of which domain sits "next to"
//                      which. _pickAdjacentDomain uses this to choose a
//                      genuinely different-but-related field deterministically
//                      — no AI needed to invent one.
//   DOMAIN_CONTENT   — real, specific, hand-written example content per
//                      domain (role name + the three question examples).
//                      This is static prose, not a fill-in-the-blank
//                      template — each one was written to be concrete on its
//                      own terms, the same way the AI-generated ones aim to be.
// =============================================================================

const DOMAIN_SIGNALS = {
    community:                  ['community', 'forum', 'discourse', 'engagement', 'members', 'moderat', 'ecosystem', 'community manager', 'community lead', 'community advocate', 'user group', 'online community'],
    product:                    ['product manager', 'product management', 'product lead', 'product owner', 'roadmap', 'user story', 'backlog', 'sprint', 'mvp', 'product strategy', 'product development'],
    engineering:                ['engineer', 'developer', 'software', 'backend', 'frontend', 'full stack', 'fullstack', 'devops', 'coding', 'programming', 'infrastructure', 'web development', 'mobile development', 'codebase', 'deployment'],
    design:                     ['user experience', 'user interface', 'ux design', 'ui design', 'figma', 'sketch', 'wireframe', 'prototype', 'design system', 'visual design', 'interaction design', 'graphic design', 'brand design'],
    finance:                    ['finance', 'financial', 'accounting', 'accountant', 'audit', 'tax', 'treasury', 'budgeting', 'p&l', 'profit and loss', 'revenue reporting', 'forecasting', 'investment', 'banking', 'financial analysis', 'fp&a'],
    hr:                         ['human resources', 'people operations', 'talent acquisition', 'recruitment', 'recruiter', 'hiring', 'onboarding', 'performance management', 'employee relations', 'compensation', 'hr manager', 'hr business partner', 'people manager', 'workforce planning', ' hr ', 'hr director'],
    operations:                 ['operations', 'logistics', 'supply chain', 'procurement', 'process improvement', 'lean', 'six sigma', 'facilities management', 'vendor management', 'operational efficiency', 'business operations', 'ops manager', 'warehouse', 'dispatch'],
    learning_education:         ['learning and development', 'training', 'curriculum', 'instructional design', 'education', 'teaching', 'facilitation', 'talent development', 'l&d', 'capacity building', 'e-learning', 'upskilling', 'workshop design', 'teacher', 'lecturer', 'tutor'],
    sales:                      ['sales', 'account executive', 'account manager', 'business development', 'revenue target', 'quota', 'pipeline', 'client acquisition', 'closing deals', 'crm', 'b2b sales', 'enterprise sales', 'sales manager'],
    marketing:                  ['marketing', 'seo', 'sem', 'content strategy', 'brand manager', 'campaign', 'social media', 'demand generation', 'copywriting', 'growth marketing', 'digital marketing', 'performance marketing', 'brand strategy', 'communications'],
    data_analytics:             ['data analyst', 'data scientist', 'data engineer', 'analytics', 'sql', 'tableau', 'power bi', 'machine learning', 'python', 'statistics', 'data analysis', 'data insights', 'business intelligence', 'reporting analyst'],
    legal_compliance:           ['legal', 'lawyer', 'attorney', 'solicitor', 'legal counsel', 'in-house counsel', 'general counsel', 'compliance', 'contract management', 'litigation', 'regulatory', 'intellectual property', 'corporate law', 'legal advisor', 'paralegal'],
    healthcare:                 ['healthcare', 'clinical', 'medical', 'nursing', 'nurse', 'hospital', 'patient care', 'pharmaceutical', 'pharmacist', 'public health', 'health system', 'doctor', 'physician', 'surgeon', 'paramedic', 'therapist', 'dentist', 'midwife', 'general practitioner', 'health program', 'health coordinator', 'global health', 'clinic'],
    insurance_risk:              ['underwrit', 'insurance', 'actuar', 'claims', 'risk assessment', 'policyholder', 'broker', 'premium', 'reinsurance', 'loss adjust', 'insurer'],
    hospitality_retail_service: ['retail', 'hospitality', 'store manager', 'guest experience', 'front of house', 'merchandising', 'customer service', 'restaurant', 'hotel', 'point of sale', 'shift management', 'customer support', 'call centre', 'call center', 'chef', 'barista', 'concierge', 'housekeeping', 'waiter', 'waitress'],
    research_science:           ['research', 'scientist', 'laboratory', 'experiment', 'study design', 'principal investigator', 'clinical trial', 'peer review', 'publication', 'grant', 'r&d', 'research and development', 'chemist', 'biologist', 'physicist', 'lab technician', 'postdoc'],
};

const DOMAIN_ADJACENCY = {
    community:                  ['marketing', 'hr'],
    product:                    ['design', 'engineering'],
    engineering:                ['data_analytics', 'product'],
    design:                     ['product', 'marketing'],
    finance:                    ['data_analytics', 'operations'],
    hr:                         ['operations', 'learning_education'],
    operations:                 ['finance', 'hr'],
    learning_education:         ['hr', 'community'],
    sales:                      ['marketing', 'hospitality_retail_service'],
    marketing:                  ['sales', 'community'],
    data_analytics:             ['engineering', 'finance'],
    legal_compliance:           ['operations', 'insurance_risk'],
    healthcare:                 ['research_science', 'operations'],
    insurance_risk:              ['finance', 'legal_compliance'],
    hospitality_retail_service: ['sales', 'operations'],
    research_science:           ['data_analytics', 'healthcare'],
    general:                    ['operations', 'hr'],
};

const DOMAIN_CONTENT = {
    community: {
        roleName: 'Community Programmes Lead',
        whatYouDoExample: "I run community strategy for a consumer app with around 40,000 active members, working with two moderators and a part-time content coordinator, reporting to the Head of Growth. A typical week is split between running community programming, triaging escalations from moderators, and reporting engagement trends back to product and marketing.",
        decisionExample: "Last month a highly active member posted content that skirted our guidelines without clearly breaking them — I chose to quietly reach out rather than remove the post publicly, since a public takedown would have created more backlash than the post itself. Similar recurring decisions: whether to feature a member's post more widely or leave it organic; whether a recurring complaint reflects a real policy gap or a single loud voice.",
        hardExample: "Two moderation reports can look equally urgent on the surface — but one is a first-time, isolated complaint and one is the fifth report against the same member in a month. That pattern of repetition, not the content of any single report, is what actually changes whether I escalate to a formal warning or just monitor.",
    },
    product: {
        roleName: 'Senior Product Manager',
        whatYouDoExample: "I own product strategy and roadmap for a B2B analytics tool, working with 6 engineers and 2 designers, reporting to the Head of Product.",
        decisionExample: "Last week a customer asked for a feature that would've delayed the roadmap by two weeks — I declined it and offered a lighter alternative, since it only served one account. Similar recurring decisions: whether to fast-track a bug fix or batch it into the next release; whether to greenlight a feature with unclear ROI.",
        hardExample: "Two feature requests can look equally reasonable on paper — but one comes from a single vocal customer and one reflects a pattern across our top accounts. That pattern is the difference that actually changes what I do.",
    },
    engineering: {
        roleName: 'Senior Backend Engineer',
        whatYouDoExample: "I own the payments service for an e-commerce platform, working within a team of 5 engineers, reporting to an Engineering Manager. Most weeks are a mix of feature work, incident response, and reviewing changes from the rest of the team before they ship.",
        decisionExample: "Last sprint a teammate proposed a quick fix for a timeout issue that would have worked short-term but left a race condition in place — I asked them to hold the release and pair on a proper fix instead, since the quick version would likely resurface under load. Similar recurring decisions: whether to accept a dependency upgrade mid-sprint or defer it; whether a bug is severe enough to interrupt planned work.",
        hardExample: "Two failing tests can look equally serious in a build log — but one is flaky and unrelated to the change, and one is a genuine regression the change introduced. Whether the failure reproduces consistently on a clean run is the detail that tells me which is which, not how alarming the error message looks.",
    },
    design: {
        roleName: 'Senior Product Designer',
        whatYouDoExample: "I lead design for the onboarding and activation flows of a subscription app, working with one other designer and partnering closely with two product managers, reporting to a Design Lead. A typical week moves between research synthesis, prototyping, and defending design decisions in review.",
        decisionExample: "Last week stakeholders asked to add a fourth onboarding step to explain a new feature — I pushed back and folded it into an existing step instead, since testing had shown drop-off increasing sharply after step three. Similar recurring decisions: whether a new pattern needs its own design system component or can reuse an existing one; whether to run a full usability test or rely on a quick internal review.",
        hardExample: "Two pieces of user feedback can sound equally urgent — but one describes a genuine usability failure and one is a personal aesthetic preference from a single tester. Whether the same friction shows up independently across multiple sessions is what actually tells me which one to act on.",
    },
    finance: {
        roleName: 'Finance Business Partner',
        whatYouDoExample: "I support the commercial team as their finance business partner for a mid-sized manufacturing business, working closely with two analysts, reporting to the Head of FP&A. Most weeks involve reviewing monthly numbers, building forecasts, and translating financial trade-offs for non-finance stakeholders.",
        decisionExample: "Last quarter a sales lead wanted to approve a discount structure that would have hit margin targets — I pushed back and proposed a volume-tiered alternative instead, since the flat discount would have set a precedent for future negotiations. Similar recurring decisions: whether a variance from budget needs escalating or is within normal seasonal swing; whether to approve an unbudgeted spend request or push it to next cycle.",
        hardExample: "Two budget overruns can look equally concerning on a report — but one is a one-off timing shift between months and one is a genuine cost creep that will recur. Whether the same category is over budget for a second consecutive month is the signal that tells me which is which.",
    },
    hr: {
        roleName: 'HR Business Partner',
        whatYouDoExample: "I'm the HR business partner for a 60-person operations division, working alongside a talent acquisition partner, reporting to the Head of People. A typical week covers performance conversations, hiring support, and advising managers on people issues as they come up.",
        decisionExample: "Last month a manager wanted to performance-manage someone out after one difficult quarter — I recommended a formal improvement plan instead, since the person's prior two years had been strong and the dip coincided with a personal circumstance they'd disclosed. Similar recurring decisions: whether a conflict between two team members needs formal mediation or will resolve with informal coaching; whether a role really needs backfilling or the work can be redistributed.",
        hardExample: "Two resignation conversations can sound equally final — but one is a considered decision after months of dissatisfaction, and one is a reaction to a single bad week. Whether the person raises specific, longstanding issues or a recent isolated incident is what tells me whether a counter-offer conversation is worth having.",
    },
    operations: {
        roleName: 'Operations Manager',
        whatYouDoExample: "I run day-to-day operations for a regional logistics hub, managing a team of 12 warehouse and dispatch staff, reporting to the Regional Operations Director. Most days are split between resolving live delivery issues, reviewing performance metrics, and coordinating with suppliers.",
        decisionExample: "Last week a key supplier missed a delivery window that risked a client's SLA — I chose to reroute through a backup supplier at higher cost rather than wait, since the client relationship was worth more than the margin on that one order. Similar recurring decisions: whether to authorise overtime to hit a deadline or let it slip; whether a recurring supplier delay is worth escalating contractually.",
        hardExample: "Two late deliveries can look equally bad on a dashboard — but one is caused by a one-off weather disruption and one is the third late delivery from the same supplier this month. That pattern, not the lateness itself, is what decides whether I have a difficult conversation with the supplier or just note it and move on.",
    },
    learning_education: {
        roleName: 'Learning & Development Manager',
        whatYouDoExample: "I run L&D for a 200-person professional services firm, working with one instructional designer, reporting to the Head of People. A typical week involves designing training content, running sessions, and measuring whether programmes are actually changing behaviour on the job.",
        decisionExample: "Last month a department head asked for a one-off workshop to fix a skills gap — I proposed a short ongoing coaching programme instead, since a single workshop rarely changes behaviour that's become habitual over years. Similar recurring decisions: whether a request needs a formal training programme or just better documentation; whether to build content in-house or licence an existing course.",
        hardExample: "Two low completion rates on training modules can look equally concerning — but one is because the content is genuinely too long, and one is because it was scheduled during a busy reporting period. Checking whether completion picks up once that period ends is what tells me whether to redesign the module or just leave the timing.",
    },
    sales: {
        roleName: 'Senior Account Executive',
        whatYouDoExample: "I manage a portfolio of mid-market accounts for a SaaS company, working a full sales cycle from qualification through to close, reporting to a Sales Manager. Most weeks are a mix of discovery calls, proposal work, and internal negotiation over pricing and terms.",
        decisionExample: "Last week a prospect asked for a discount below our usual floor to close before quarter-end — I declined and offered an extended trial instead, since matching the discount would have made it harder to hold pricing with their peers later. Similar recurring decisions: whether a stalled deal needs a fresh angle or should be deprioritised; whether to loop in a solutions engineer early or handle technical questions solo.",
        hardExample: "Two 'not right now' responses from prospects can sound identical — but one is a genuine budget constraint this quarter, and one is a soft no because they're not convinced of the value yet. Whether they ask follow-up questions about the roadmap is usually what tells me which one it is.",
    },
    marketing: {
        roleName: 'Growth Marketing Manager',
        whatYouDoExample: "I run growth marketing for a consumer subscription product, managing paid and lifecycle channels, working with one performance marketer, reporting to the Head of Marketing. A typical week involves reviewing channel performance, briefing creative, and deciding where to shift budget.",
        decisionExample: "Last month one paid channel was hitting target CAC but volume was small — I chose to hold spend flat rather than scale it aggressively, since the audience pool at that CAC was clearly limited. Similar recurring decisions: whether a dip in performance is creative fatigue or a targeting issue; whether to test a new channel now or wait for a cleaner measurement window.",
        hardExample: "Two campaigns can post similar click-through rates — but one converts well on the landing page and one doesn't. Whether the drop happens at the same step in the funnel across multiple campaigns is what tells me whether it's a targeting problem or a landing page problem.",
    },
    data_analytics: {
        roleName: 'Analytics Manager',
        whatYouDoExample: "I lead analytics for a retail e-commerce business, working with two analysts, reporting to the Head of Data. Most weeks involve fielding ad-hoc requests from other teams, maintaining core dashboards, and deciding which questions are worth deeper investigation.",
        decisionExample: "Last week a stakeholder wanted a same-day answer on why conversion dropped — I gave a preliminary read but held off on a firm conclusion until I'd checked for a tracking issue, since a similar-looking dip two months earlier had turned out to be a broken pixel, not a real trend. Similar recurring decisions: whether an anomaly needs immediate investigation or can wait for the next reporting cycle; whether a one-off analysis is worth turning into a recurring dashboard.",
        hardExample: "Two metrics moving together can look like cause and effect — but one relationship holds up when you segment by channel and one disappears entirely. Checking whether the pattern survives segmentation is what tells me whether to report it as a finding or flag it as coincidental.",
    },
    legal_compliance: {
        roleName: 'Commercial Legal Counsel',
        whatYouDoExample: "I'm in-house counsel for a mid-sized technology company, working closely with the commercial and procurement teams, reporting to the General Counsel. A typical week involves reviewing contracts, advising on deal terms, and flagging regulatory risk before it becomes a problem.",
        decisionExample: "Last month sales wanted to accept a customer's non-standard liability clause to close a large deal — I negotiated a capped alternative instead, since the unlimited exposure wasn't justified by the deal size. Similar recurring decisions: whether a contract deviation needs escalation to the General Counsel or is within my own authority; whether a vendor's data-handling terms meet our own compliance bar.",
        hardExample: "Two contract redlines can look equally aggressive from a counterparty — but one is boilerplate they push on every deal, and one signals a genuine concern specific to this engagement. Whether the clause is unusual for their industry is what tells me which one it is.",
    },
    healthcare: {
        roleName: 'Clinical Operations Manager',
        whatYouDoExample: "I manage clinical operations for a multi-site outpatient clinic, overseeing a team of 15 clinical and administrative staff, reporting to the Practice Director. Most days involve staffing coordination, patient flow, and resolving issues that affect care quality or wait times.",
        decisionExample: "Last week a clinician flagged a recurring scheduling conflict that was causing patients to wait over an hour — I restructured the appointment slots for that clinic rather than adding temporary staff, since the root cause was the schedule template, not capacity. Similar recurring decisions: whether a patient complaint reflects a systemic issue or an isolated incident; whether to escalate a staffing shortfall or absorb it for the week.",
        hardExample: "Two patient complaints about wait times can sound identical — but one is a one-off day disrupted by staff illness, and one is the same complaint every week for a month. That repetition is what tells me whether it needs a scheduling fix or was just a bad day.",
    },
    insurance_risk: {
        roleName: 'Senior Commercial Underwriter',
        whatYouDoExample: "I underwrite commercial property risk for a mid-sized insurer, working with a small team of underwriting assistants, reporting to the Underwriting Manager. A typical week is spent assessing new submissions, pricing renewals, and deciding which risks fall inside or outside our appetite.",
        decisionExample: "Last week a broker submitted a renewal with a claims history that had worsened slightly — I chose to renew with tightened terms rather than decline outright, since the deterioration was tied to one identifiable cause the client had since addressed. Similar recurring decisions: whether a submission needs a site survey before quoting or can be priced from the application alone; whether to hold firm on price with a broker pushing for a match against a competitor's quote.",
        hardExample: "Two submissions can carry an identical headline risk score — but one has a claims history driven by a single resolved issue, and one has a slow drift of smaller unrelated claims. That difference in pattern is what tells me whether tightened terms are enough or the risk should be declined.",
    },
    hospitality_retail_service: {
        roleName: 'Regional Retail Operations Manager',
        whatYouDoExample: "I oversee operations across 8 retail stores for a mid-sized fashion brand, managing store managers directly, reporting to the Head of Retail. Most weeks involve reviewing store performance, resolving escalated customer issues, and balancing stock across locations.",
        decisionExample: "Last month one store was consistently missing its sales target — I moved a strong assistant manager there temporarily rather than replacing the store manager outright, since the underlying issue looked like a staffing gap rather than poor management. Similar recurring decisions: whether a customer complaint warrants a refund outright or a smaller gesture; whether to rebalance stock between stores now or wait for the next scheduled delivery.",
        hardExample: "Two underperforming stores can show the same sales dip — but one is explained by a nearby competitor opening, and one has no obvious external cause. Whether other stores in the same area saw a similar dip is what tells me whether it's a market shift or something specific to that store.",
    },
    research_science: {
        roleName: 'Research Programme Manager',
        whatYouDoExample: "I manage a portfolio of applied research projects for a public health research institute, coordinating a team of 5 researchers, reporting to the Research Director. A typical week involves reviewing project progress, managing funding constraints, and deciding where to focus limited analysis time.",
        decisionExample: "Last month a promising early result came in on a secondary research question — I chose to hold off reallocating resources to it until the primary study finished, since chasing every promising signal risked leaving the funded primary question incomplete. Similar recurring decisions: whether a preliminary result is strong enough to justify a follow-up study; whether a delay in one project's data collection should push back the whole programme timeline or run in parallel.",
        hardExample: "Two unexpected results can look equally exciting — but one replicates when the analysis is rerun on a different subset of the data, and one doesn't. Whether it holds up under that check is what tells me whether it's worth reporting as a finding or treating as noise.",
    },
    general: {
        roleName: 'Operations Coordinator',
        whatYouDoExample: "I coordinate day-to-day work for a mid-sized team, working across a few colleagues on shared priorities, reporting to a department lead. A typical week is a mix of planning, handling issues as they surface, and keeping stakeholders updated.",
        decisionExample: "Last week two priorities landed on the same day — I chose to handle the one with an external deadline first and pushed the internal one back a day, since external commitments carried more risk if missed. Similar recurring decisions: whether to escalate a blocked task to a manager or wait it out another day; whether to take on an ad-hoc request immediately or schedule it for later in the week.",
        hardExample: "Two requests can sound equally urgent when they land — but one has a hard external deadline and one just feels urgent to the person asking. Whether there's an actual consequence to missing today is what tells me which one actually needs to jump the queue.",
    },
};

// ---------------------------------------------------------------------------
// _detectDomain(text) — scores DOMAIN_SIGNALS keyword hits against the given
// text (role + any CV/JD provided). Returns the domain with the most
// distinct keyword matches, or 'general' if nothing scored.
// ---------------------------------------------------------------------------
function _detectDomain(text) {
    const lower = (text || '').toLowerCase();
    let best = 'general';
    let bestScore = 0;

    for (const [domain, signals] of Object.entries(DOMAIN_SIGNALS)) {
        const score = signals.filter(s => lower.includes(s)).length;
        if (score > bestScore) {
            best = domain;
            bestScore = score;
        }
    }
    return best;
}

// ---------------------------------------------------------------------------
// _hashStr(s) — a tiny, deterministic string hash. Used only to pick between
// a domain's two adjacency candidates without always picking the same one —
// deterministic per role text, not random, so a given role always sees the
// same adjacent domain rather than a different one on every render.
// ---------------------------------------------------------------------------
function _hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
}

// ---------------------------------------------------------------------------
// _pickAdjacentDomain(domain, seedText) — deterministic pick from
// DOMAIN_ADJACENCY, never the domain itself.
// ---------------------------------------------------------------------------
function _pickAdjacentDomain(domain, seedText) {
    const neighbours = DOMAIN_ADJACENCY[domain] || DOMAIN_ADJACENCY.general;
    return neighbours[_hashStr(seedText || domain) % neighbours.length];
}

// ---------------------------------------------------------------------------
// _localExamples(role, documentsText) — the local, no-AI baseline. Detects a
// domain from the role (and CV/JD, if given), picks a genuinely different
// adjacent domain, and returns that domain's hand-written example content in
// the same shape _generateExamples() returns, so both can feed
// _attachExampleToggles() interchangeably. Always succeeds — 'general' is a
// real, usable entry in DOMAIN_CONTENT, not an error state.
// ---------------------------------------------------------------------------
function _localExamples(role, documentsText) {
    const detected = _detectDomain(`${role || ''} ${documentsText || ''}`);
    const adjacent  = _pickAdjacentDomain(detected, role || detected);
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
// _extractEvidenceLines(documentsText) — local, no AI. Surfaces lines that
// look like quantified achievements (a %, a currency symbol, or a strong
// action verb, word-bounded so it doesn't match inside another word like
// "handled"), while filtering out lines that look like contact details or
// an address — the actual failure mode of the original blind-truncation
// approach this replaces. Aren't too long to plausibly have been a bullet.
// Used as a small supplementary "see something from your own CV instead"
// option alongside the domain example — not a fallback, an addition.
// ---------------------------------------------------------------------------
function _extractEvidenceLines(documentsText) {
    if (!documentsText) return [];

    const lines = documentsText.split('\n').map(l => l.trim()).filter(Boolean);

    const junkPattern = /@|linkedin\.com|github\.com|^\+?[\d\s().-]{7,}$|\bstreet\b|\bavenue\b|\broad\b|\bdrive\b|\bsuite\b|\bfloor\b|\bp\.?o\.? box\b/i;
    const signalPattern = /%|\$|£|€|\bled\b|\bbuilt\b|\bgrew\b|\bsecured\b|\bdesigned\b|\bclosed\b|\breduced\b|\bincreased\b|\bfounded\b|\bcreated\b|\bmanaged\b|\bnegotiated\b|\bdelivered\b|\blaunched\b|\bsaved\b|\btrained\b|\bscaled\b|\bcoordinated\b|\bresolved\b|\bimproved\b|\boversaw\b|\bdrove\b|\bimplemented\b/i;

    return lines
        .filter(l => l.length < 220 && !junkPattern.test(l) && signalPattern.test(l))
        .slice(0, MAX_EVIDENCE_LINES);
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
      <label class="label" for="f-role-only">What is your area of expertise?</label>
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
        <label class="label" for="f-role">What is your area of expertise?</label>
        <input class="input" id="f-role" type="text"
          placeholder="e.g. Senior commercial underwriter"
          value="${_esc(p.role)}" required>
        <button type="button" class="lab-example-toggle" id="regen-examples" style="margin-top:var(--space-2)">
          Changed your role above? Refresh the examples below
        </button>
      </div>

      <div class="form-group">
        <label class="label" for="f-whatyoudo">
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
        <label class="label" for="f-decisiontypes">
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
        <label class="label" for="f-hard">
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
    const evidenceLines = _extractEvidenceLines(documentsText);
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
