// =============================================================================
// Lab — domain-signals.js
//
// A shared, local (no AI, no network call) domain-classification utility.
// Originally built for Screen 1's adjacent-role example system, now also
// used by Screen 3 (cue-review.js) to make the abstract idea of a "cue"
// concrete by illustrating it with something from the expert's own field.
//
// Everything here is pure data and pure functions — no DOM, no imports from
// engine/ or db.js. Safe to import from any view file.
//
// MAX_EVIDENCE_LINES — cap on how many CV lines extractEvidenceLines()
// surfaces.
// =============================================================================

const MAX_EVIDENCE_LINES = 5;

export const DOMAIN_SIGNALS = {
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

export const DOMAIN_ADJACENCY = {
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

export const DOMAIN_CONTENT = {
    community: {
        roleName: 'Community Programmes Lead',
        whatYouDoExample: "I run community strategy for a consumer app with around 40,000 active members, working with two moderators and a part-time content coordinator, reporting to the Head of Growth. A typical week is split between running community programming, triaging escalations from moderators, and reporting engagement trends back to product and marketing.",
        decisionExample: "Last month a highly active member posted content that skirted our guidelines without clearly breaking them — I chose to quietly reach out rather than remove the post publicly, since a public takedown would have created more backlash than the post itself. Similar recurring decisions: whether to feature a member's post more widely or leave it organic; whether a recurring complaint reflects a real policy gap or a single loud voice.",
        hardExample: "Two moderation reports can look equally urgent on the surface — but one is a first-time, isolated complaint and one is the fifth report against the same member in a month. That pattern of repetition, not the content of any single report, is what actually changes whether I escalate to a formal warning or just monitor.",
        cueExampleLine: "e.g. whether this is the member's first flagged post or their fifth",
    },
    product: {
        roleName: 'Senior Product Manager',
        whatYouDoExample: "I own product strategy and roadmap for a B2B analytics tool, working with 6 engineers and 2 designers, reporting to the Head of Product.",
        decisionExample: "Last week a customer asked for a feature that would've delayed the roadmap by two weeks — I declined it and offered a lighter alternative, since it only served one account. Similar recurring decisions: whether to fast-track a bug fix or batch it into the next release; whether to greenlight a feature with unclear ROI.",
        hardExample: "Two feature requests can look equally reasonable on paper — but one comes from a single vocal customer and one reflects a pattern across our top accounts. That pattern is the difference that actually changes what I do.",
        cueExampleLine: "e.g. whether a request comes from one customer or reflects a pattern across many",
    },
    engineering: {
        roleName: 'Senior Backend Engineer',
        whatYouDoExample: "I own the payments service for an e-commerce platform, working within a team of 5 engineers, reporting to an Engineering Manager. Most weeks are a mix of feature work, incident response, and reviewing changes from the rest of the team before they ship.",
        decisionExample: "Last sprint a teammate proposed a quick fix for a timeout issue that would have worked short-term but left a race condition in place — I asked them to hold the release and pair on a proper fix instead, since the quick version would likely resurface under load. Similar recurring decisions: whether to accept a dependency upgrade mid-sprint or defer it; whether a bug is severe enough to interrupt planned work.",
        hardExample: "Two failing tests can look equally serious in a build log — but one is flaky and unrelated to the change, and one is a genuine regression the change introduced. Whether the failure reproduces consistently on a clean run is the detail that tells me which is which, not how alarming the error message looks.",
        cueExampleLine: "e.g. whether a failing test reproduces consistently or only sometimes",
    },
    design: {
        roleName: 'Senior Product Designer',
        whatYouDoExample: "I lead design for the onboarding and activation flows of a subscription app, working with one other designer and partnering closely with two product managers, reporting to a Design Lead. A typical week moves between research synthesis, prototyping, and defending design decisions in review.",
        decisionExample: "Last week stakeholders asked to add a fourth onboarding step to explain a new feature — I pushed back and folded it into an existing step instead, since testing had shown drop-off increasing sharply after step three. Similar recurring decisions: whether a new pattern needs its own design system component or can reuse an existing one; whether to run a full usability test or rely on a quick internal review.",
        hardExample: "Two pieces of user feedback can sound equally urgent — but one describes a genuine usability failure and one is a personal aesthetic preference from a single tester. Whether the same friction shows up independently across multiple sessions is what actually tells me which one to act on.",
        cueExampleLine: "e.g. whether the same friction shows up across multiple user sessions or just one",
    },
    finance: {
        roleName: 'Finance Business Partner',
        whatYouDoExample: "I support the commercial team as their finance business partner for a mid-sized manufacturing business, working closely with two analysts, reporting to the Head of FP&A. Most weeks involve reviewing monthly numbers, building forecasts, and translating financial trade-offs for non-finance stakeholders.",
        decisionExample: "Last quarter a sales lead wanted to approve a discount structure that would have hit margin targets — I pushed back and proposed a volume-tiered alternative instead, since the flat discount would have set a precedent for future negotiations. Similar recurring decisions: whether a variance from budget needs escalating or is within normal seasonal swing; whether to approve an unbudgeted spend request or push it to next cycle.",
        hardExample: "Two budget overruns can look equally concerning on a report — but one is a one-off timing shift between months and one is a genuine cost creep that will recur. Whether the same category is over budget for a second consecutive month is the signal that tells me which is which.",
        cueExampleLine: "e.g. whether a budget line is over for a second month running, not just this one",
    },
    hr: {
        roleName: 'HR Business Partner',
        whatYouDoExample: "I'm the HR business partner for a 60-person operations division, working alongside a talent acquisition partner, reporting to the Head of People. A typical week covers performance conversations, hiring support, and advising managers on people issues as they come up.",
        decisionExample: "Last month a manager wanted to performance-manage someone out after one difficult quarter — I recommended a formal improvement plan instead, since the person's prior two years had been strong and the dip coincided with a personal circumstance they'd disclosed. Similar recurring decisions: whether a conflict between two team members needs formal mediation or will resolve with informal coaching; whether a role really needs backfilling or the work can be redistributed.",
        hardExample: "Two resignation conversations can sound equally final — but one is a considered decision after months of dissatisfaction, and one is a reaction to a single bad week. Whether the person raises specific, longstanding issues or a recent isolated incident is what tells me whether a counter-offer conversation is worth having.",
        cueExampleLine: "e.g. whether this is a first-time conflict or the third one involving the same two people",
    },
    operations: {
        roleName: 'Operations Manager',
        whatYouDoExample: "I run day-to-day operations for a regional logistics hub, managing a team of 12 warehouse and dispatch staff, reporting to the Regional Operations Director. Most days are split between resolving live delivery issues, reviewing performance metrics, and coordinating with suppliers.",
        decisionExample: "Last week a key supplier missed a delivery window that risked a client's SLA — I chose to reroute through a backup supplier at higher cost rather than wait, since the client relationship was worth more than the margin on that one order. Similar recurring decisions: whether to authorise overtime to hit a deadline or let it slip; whether a recurring supplier delay is worth escalating contractually.",
        hardExample: "Two late deliveries can look equally bad on a dashboard — but one is caused by a one-off weather disruption and one is the third late delivery from the same supplier this month. That pattern, not the lateness itself, is what decides whether I have a difficult conversation with the supplier or just note it and move on.",
        cueExampleLine: "e.g. whether a supplier delay is a one-off or the third late delivery this month",
    },
    learning_education: {
        roleName: 'Learning & Development Manager',
        whatYouDoExample: "I run L&D for a 200-person professional services firm, working with one instructional designer, reporting to the Head of People. A typical week involves designing training content, running sessions, and measuring whether programmes are actually changing behaviour on the job.",
        decisionExample: "Last month a department head asked for a one-off workshop to fix a skills gap — I proposed a short ongoing coaching programme instead, since a single workshop rarely changes behaviour that's become habitual over years. Similar recurring decisions: whether a request needs a formal training programme or just better documentation; whether to build content in-house or licence an existing course.",
        hardExample: "Two low completion rates on training modules can look equally concerning — but one is because the content is genuinely too long, and one is because it was scheduled during a busy reporting period. Checking whether completion picks up once that period ends is what tells me whether to redesign the module or just leave the timing.",
        cueExampleLine: "e.g. whether low completion is about the content itself or just bad timing",
    },
    sales: {
        roleName: 'Senior Account Executive',
        whatYouDoExample: "I manage a portfolio of mid-market accounts for a SaaS company, working a full sales cycle from qualification through to close, reporting to a Sales Manager. Most weeks are a mix of discovery calls, proposal work, and internal negotiation over pricing and terms.",
        decisionExample: "Last week a prospect asked for a discount below our usual floor to close before quarter-end — I declined and offered an extended trial instead, since matching the discount would have made it harder to hold pricing with their peers later. Similar recurring decisions: whether a stalled deal needs a fresh angle or should be deprioritised; whether to loop in a solutions engineer early or handle technical questions solo.",
        hardExample: "Two 'not right now' responses from prospects can sound identical — but one is a genuine budget constraint this quarter, and one is a soft no because they're not convinced of the value yet. Whether they ask follow-up questions about the roadmap is usually what tells me which one it is.",
        cueExampleLine: "e.g. whether a prospect asks follow-up questions or goes quiet after 'not right now'",
    },
    marketing: {
        roleName: 'Growth Marketing Manager',
        whatYouDoExample: "I run growth marketing for a consumer subscription product, managing paid and lifecycle channels, working with one performance marketer, reporting to the Head of Marketing. A typical week involves reviewing channel performance, briefing creative, and deciding where to shift budget.",
        decisionExample: "Last month one paid channel was hitting target CAC but volume was small — I chose to hold spend flat rather than scale it aggressively, since the audience pool at that CAC was clearly limited. Similar recurring decisions: whether a dip in performance is creative fatigue or a targeting issue; whether to test a new channel now or wait for a cleaner measurement window.",
        hardExample: "Two campaigns can post similar click-through rates — but one converts well on the landing page and one doesn't. Whether the drop happens at the same step in the funnel across multiple campaigns is what tells me whether it's a targeting problem or a landing page problem.",
        cueExampleLine: "e.g. whether a metric holds up once you segment it, or only looks real in aggregate",
    },
    data_analytics: {
        roleName: 'Analytics Manager',
        whatYouDoExample: "I lead analytics for a retail e-commerce business, working with two analysts, reporting to the Head of Data. Most weeks involve fielding ad-hoc requests from other teams, maintaining core dashboards, and deciding which questions are worth deeper investigation.",
        decisionExample: "Last week a stakeholder wanted a same-day answer on why conversion dropped — I gave a preliminary read but held off on a firm conclusion until I'd checked for a tracking issue, since a similar-looking dip two months earlier had turned out to be a broken pixel, not a real trend. Similar recurring decisions: whether an anomaly needs immediate investigation or can wait for the next reporting cycle; whether a one-off analysis is worth turning into a recurring dashboard.",
        hardExample: "Two metrics moving together can look like cause and effect — but one relationship holds up when you segment by channel and one disappears entirely. Checking whether the pattern survives segmentation is what tells me whether to report it as a finding or flag it as coincidental.",
        cueExampleLine: "e.g. whether a pattern survives being checked on a different slice of the data",
    },
    legal_compliance: {
        roleName: 'Commercial Legal Counsel',
        whatYouDoExample: "I'm in-house counsel for a mid-sized technology company, working closely with the commercial and procurement teams, reporting to the General Counsel. A typical week involves reviewing contracts, advising on deal terms, and flagging regulatory risk before it becomes a problem.",
        decisionExample: "Last month sales wanted to accept a customer's non-standard liability clause to close a large deal — I negotiated a capped alternative instead, since the unlimited exposure wasn't justified by the deal size. Similar recurring decisions: whether a contract deviation needs escalation to the General Counsel or is within my own authority; whether a vendor's data-handling terms meet our own compliance bar.",
        hardExample: "Two contract redlines can look equally aggressive from a counterparty — but one is boilerplate they push on every deal, and one signals a genuine concern specific to this engagement. Whether the clause is unusual for their industry is what tells me which one it is.",
        cueExampleLine: "e.g. whether a contract clause is boilerplate the other side uses on every deal, or specific to this one",
    },
    healthcare: {
        roleName: 'Clinical Operations Manager',
        whatYouDoExample: "I manage clinical operations for a multi-site outpatient clinic, overseeing a team of 15 clinical and administrative staff, reporting to the Practice Director. Most days involve staffing coordination, patient flow, and resolving issues that affect care quality or wait times.",
        decisionExample: "Last week a clinician flagged a recurring scheduling conflict that was causing patients to wait over an hour — I restructured the appointment slots for that clinic rather than adding temporary staff, since the root cause was the schedule template, not capacity. Similar recurring decisions: whether a patient complaint reflects a systemic issue or an isolated incident; whether to escalate a staffing shortfall or absorb it for the week.",
        hardExample: "Two patient complaints about wait times can sound identical — but one is a one-off day disrupted by staff illness, and one is the same complaint every week for a month. That repetition is what tells me whether it needs a scheduling fix or was just a bad day.",
        cueExampleLine: "e.g. whether a complaint is a one-off bad day or the same issue every week",
    },
    insurance_risk: {
        roleName: 'Senior Commercial Underwriter',
        whatYouDoExample: "I underwrite commercial property risk for a mid-sized insurer, working with a small team of underwriting assistants, reporting to the Underwriting Manager. A typical week is spent assessing new submissions, pricing renewals, and deciding which risks fall inside or outside our appetite.",
        decisionExample: "Last week a broker submitted a renewal with a claims history that had worsened slightly — I chose to renew with tightened terms rather than decline outright, since the deterioration was tied to one identifiable cause the client had since addressed. Similar recurring decisions: whether a submission needs a site survey before quoting or can be priced from the application alone; whether to hold firm on price with a broker pushing for a match against a competitor's quote.",
        hardExample: "Two submissions can carry an identical headline risk score — but one has a claims history driven by a single resolved issue, and one has a slow drift of smaller unrelated claims. That difference in pattern is what tells me whether tightened terms are enough or the risk should be declined.",
        cueExampleLine: "e.g. whether a claims history is one resolved issue or a slow drift of smaller ones",
    },
    hospitality_retail_service: {
        roleName: 'Regional Retail Operations Manager',
        whatYouDoExample: "I oversee operations across 8 retail stores for a mid-sized fashion brand, managing store managers directly, reporting to the Head of Retail. Most weeks involve reviewing store performance, resolving escalated customer issues, and balancing stock across locations.",
        decisionExample: "Last month one store was consistently missing its sales target — I moved a strong assistant manager there temporarily rather than replacing the store manager outright, since the underlying issue looked like a staffing gap rather than poor management. Similar recurring decisions: whether a customer complaint warrants a refund outright or a smaller gesture; whether to rebalance stock between stores now or wait for the next scheduled delivery.",
        hardExample: "Two underperforming stores can show the same sales dip — but one is explained by a nearby competitor opening, and one has no obvious external cause. Whether other stores in the same area saw a similar dip is what tells me whether it's a market shift or something specific to that store.",
        cueExampleLine: "e.g. whether a sales dip is explained by something external, or nothing else changed nearby",
    },
    research_science: {
        roleName: 'Research Programme Manager',
        whatYouDoExample: "I manage a portfolio of applied research projects for a public health research institute, coordinating a team of 5 researchers, reporting to the Research Director. A typical week involves reviewing project progress, managing funding constraints, and deciding where to focus limited analysis time.",
        decisionExample: "Last month a promising early result came in on a secondary research question — I chose to hold off reallocating resources to it until the primary study finished, since chasing every promising signal risked leaving the funded primary question incomplete. Similar recurring decisions: whether a preliminary result is strong enough to justify a follow-up study; whether a delay in one project's data collection should push back the whole programme timeline or run in parallel.",
        hardExample: "Two unexpected results can look equally exciting — but one replicates when the analysis is rerun on a different subset of the data, and one doesn't. Whether it holds up under that check is what tells me whether it's worth reporting as a finding or treating as noise.",
        cueExampleLine: "e.g. whether a result replicates on a different subset of the data",
    },
    general: {
        roleName: 'Operations Coordinator',
        whatYouDoExample: "I coordinate day-to-day work for a mid-sized team, working across a few colleagues on shared priorities, reporting to a department lead. A typical week is a mix of planning, handling issues as they surface, and keeping stakeholders updated.",
        decisionExample: "Last week two priorities landed on the same day — I chose to handle the one with an external deadline first and pushed the internal one back a day, since external commitments carried more risk if missed. Similar recurring decisions: whether to escalate a blocked task to a manager or wait it out another day; whether to take on an ad-hoc request immediately or schedule it for later in the week.",
        hardExample: "Two requests can sound equally urgent when they land — but one has a hard external deadline and one just feels urgent to the person asking. Whether there's an actual consequence to missing today is what tells me which one actually needs to jump the queue.",
        cueExampleLine: "e.g. whether a request has a real deadline, or just feels urgent to the person asking",
    },
};

// ---------------------------------------------------------------------------
// detectDomain(text) — scores DOMAIN_SIGNALS keyword hits against the given
// text (role + any CV/JD provided). Returns the domain with the most
// distinct keyword matches, or 'general' if nothing scored.
// ---------------------------------------------------------------------------
export function detectDomain(text) {
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
// pickAdjacentDomain(domain, seedText) — deterministic pick from
// DOMAIN_ADJACENCY, never the domain itself.
// ---------------------------------------------------------------------------
export function pickAdjacentDomain(domain, seedText) {
    const neighbours = DOMAIN_ADJACENCY[domain] || DOMAIN_ADJACENCY.general;
    return neighbours[_hashStr(seedText || domain) % neighbours.length];
}

// ---------------------------------------------------------------------------
// extractEvidenceLines(documentsText) — local, no AI. Surfaces lines that
// look like quantified achievements (a %, a currency symbol, or a strong
// action verb, word-bounded so it doesn't match inside another word like
// "handled"), while filtering out lines that look like contact details or
// an address — the actual failure mode of the original blind-truncation
// approach this replaces. Aren't too long to plausibly have been a bullet.
// Used as a small supplementary "see something from your own CV instead"
// option alongside the domain example — not a fallback, an addition.
// ---------------------------------------------------------------------------
export function extractEvidenceLines(documentsText) {
    if (!documentsText) return [];

    const lines = documentsText.split('\n').map(l => l.trim()).filter(Boolean);

    const junkPattern = /@|linkedin\.com|github\.com|^\+?[\d\s().-]{7,}$|\bstreet\b|\bavenue\b|\broad\b|\bdrive\b|\bsuite\b|\bfloor\b|\bp\.?o\.? box\b/i;
    const signalPattern = /%|\$|£|€|\bled\b|\bbuilt\b|\bgrew\b|\bsecured\b|\bdesigned\b|\bclosed\b|\breduced\b|\bincreased\b|\bfounded\b|\bcreated\b|\bmanaged\b|\bnegotiated\b|\bdelivered\b|\blaunched\b|\bsaved\b|\btrained\b|\bscaled\b|\bcoordinated\b|\bresolved\b|\bimproved\b|\boversaw\b|\bdrove\b|\bimplemented\b/i;

    return lines
        .filter(l => l.length < 220 && !junkPattern.test(l) && signalPattern.test(l))
        .slice(0, MAX_EVIDENCE_LINES);
}

// ---------------------------------------------------------------------------
