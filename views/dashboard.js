// =============================================================================
// LORE — Dashboard View (Manager)
// The Manager's command surface. Full visibility into the knowledge base,
// Reviewer extraction pipeline, domain clustering, and team progress.
//
// Sections rendered in this view:
//   Overview         — recipe count, coverage summary, pending queue count
//   Knowledge Base   — all approved recipes by skill area
//   Review Queue     — pending extractions awaiting Manager approval
//   Add Knowledge    — document upload for AI extraction
//   Skill Areas      — domain confirmation UI (proposed clusters)
//   Team             — all staff with role, status, and invite generation
//
// This is the Manager's full intelligence surface. Every other role sees
// a focused, single-purpose screen. The Manager sees everything.
//
// Import paths: views/ files import engine files using ../engine/[file].js.
// =============================================================================

import {
    getPendingExtractions,
    getAllApprovedRecipes,
    processExtraction,
    approveRecipe,
    rejectExtraction,
    processDocument,
} from '../engine/recipes.js';
import {
    getDomains,
    confirmDomain,
    updateDomain,
    deleteDomain,
    getPendingClusters,
    clearPendingClusters,
    triggerClustering,
} from '../engine/domains.js';
import { generateInvite } from '../engine/auth.js';
import { queueScenarioReview } from '../engine/scenarios.js';

// ---------------------------------------------------------------------------
// Module-level state for this view.
// ---------------------------------------------------------------------------
let _orgId     = null;
let _uid       = null;
let _orgName   = '';
let _recipes   = [];
let _domains   = [];
let _pending   = [];
let _clusters  = [];

// Which section of the dashboard is currently active
let _activeSection = 'overview';

// ---------------------------------------------------------------------------
// Entry point — called by app.js after auth.
// ---------------------------------------------------------------------------
export async function initDashboard(orgId, uid) {
    _orgId = orgId;
    _uid   = uid;

    const container = document.getElementById('dashboard-content');
    if (!container) return;

    console.log('LORE dashboard.js: initDashboard called — orgId:', orgId, 'uid:', uid);
    renderLoading(container, 'Loading your knowledge base…');

    // Load org profile for the org name
    await _loadOrgProfile();

    // Load data in parallel — the dashboard needs all of this to render
    const [recipes, domains, pending, clusters] = await Promise.all([
        getAllApprovedRecipes(orgId),
        getDomains(orgId),
        getPendingExtractions(orgId),
        getPendingClusters(orgId),
    ]);

    _recipes  = recipes;
    _domains  = domains;
    _pending  = pending;
    _clusters = clusters;

    // If the org has not yet set their industry, show the onboarding gate first.
    // The gate is a single question — once answered the Manager proceeds to the
    // main dashboard. It does not block anything; it enriches the domain seed.
    if (!_industry) {
        renderOnboarding(container);
    } else {
        renderDashboard(container);
    }
}

// ---------------------------------------------------------------------------
// Load the org profile to get the org name — used in invite generation.
// ---------------------------------------------------------------------------
// Module-level — industry stored here after onboarding so the gate
// does not re-appear on subsequent loads within the same session.
let _industry = null;

async function _loadOrgProfile() {
    const { db } = await import('../firebase.js');
    const { doc, getDoc } = await import(
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );
    try {
        const snap = await getDoc(doc(db, 'organisations', _orgId, 'profile', 'data'));
        if (snap.exists()) {
            _orgName  = snap.data().orgName  ?? '';
            _industry = snap.data().industry ?? null;
        }
        console.log('LORE dashboard.js: Org profile loaded — orgName:', _orgName, 'industry:', _industry);
    } catch (err) {
        console.warn('LORE dashboard.js: Could not load org profile.', err);
    }
}

// ---------------------------------------------------------------------------
// Onboarding gate — shown once, on first Manager sign-in, before the main
// dashboard. Asks one question: what industry does the organisation operate in?
// The answer seeds tentative domain name suggestions — clearly labelled as
// starting points, not confirmed skill areas.
//
// Copy rule: never say "knowledge base", "training data", or "recipes" here.
// Frame everything as helping LORE understand the organisation's context.
// ---------------------------------------------------------------------------
function renderOnboarding(container) {
    console.log('LORE dashboard.js: Rendering onboarding gate — no industry set yet.');

    // Tentative domain seeds by broad industry category.
    // These are displayed as dismissible chips after the Manager answers.
    // [TUNING TARGET] Expand this list as LORE is used across more industries.
    const seeds = {
        'Consulting':        ['Client Engagement', 'Stakeholder Management', 'Proposal Development', 'Delivery Excellence', 'Commercial Judgement'],
        'Financial Services':['Risk Assessment', 'Client Advisory', 'Regulatory Navigation', 'Portfolio Management', 'Deal Execution'],
        'Technology':        ['Product Thinking', 'Technical Communication', 'Delivery Management', 'Stakeholder Alignment', 'Incident Response'],
        'Healthcare':        ['Clinical Judgement', 'Patient Communication', 'Protocol Navigation', 'Team Coordination', 'Documentation'],
        'Legal':             ['Client Counsel', 'Matter Management', 'Risk Identification', 'Negotiation', 'Document Drafting'],
        'Education':         ['Learner Engagement', 'Curriculum Design', 'Assessment', 'Parent Communication', 'Classroom Management'],
        'Retail & Consumer': ['Customer Experience', 'Merchandising', 'Supplier Management', 'Operations', 'Sales Execution'],
        'Media & Creative':  ['Brief Interpretation', 'Client Management', 'Creative Direction', 'Production', 'Pitching'],
        'Non-profit':        ['Programme Delivery', 'Funder Relations', 'Community Engagement', 'Impact Measurement', 'Partnerships'],
        'Other':             ['Leadership', 'Communication', 'Problem Solving', 'Stakeholder Management', 'Decision Making'],
    };

    const industryOptions = Object.keys(seeds);

    container.innerHTML = `
        <div style="max-width: 520px; margin: var(--space-16) auto 0;">
            <p class="auth-wordmark" style="color: var(--ink); margin-bottom: var(--space-2);">Welcome to LORE</p>
            <p class="text-secondary mt-2 mb-8">One question before we start. What industry does your organisation operate in?</p>

            <div class="card">
                <div class="auth-field">
                    <label class="label" for="industry-select">Industry</label>
                    <select class="input" id="industry-select">
                        <option value="">Choose one…</option>
                        ${industryOptions.map(opt => `<option value="${opt}">${opt}</option>`).join('')}
                    </select>
                </div>

                <!-- Seed chips — shown after an industry is chosen -->
                <div id="seed-preview" style="display: none; margin-top: var(--space-4);">
                    <p class="label mb-3">Starting points</p>
                    <p class="text-secondary text-sm mb-3">These are tentative skill areas based on your industry. LORE will replace them with your organisation's own as knowledge is added — they are not permanent.</p>
                    <div id="seed-chips" style="display: flex; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-4);"></div>
                </div>

                <p id="onboarding-error" style="color: var(--error); font-size: var(--text-sm); display: none; margin-bottom: var(--space-3);"></p>

                <button class="btn btn-primary btn-full" id="onboarding-submit" disabled>
                    Set up my dashboard
                </button>
            </div>
        </div>
    `;

    // Show seed chips when industry is selected
    document.getElementById('industry-select')?.addEventListener('change', (e) => {
        const selected  = e.target.value;
        const preview   = document.getElementById('seed-preview');
        const chipsEl   = document.getElementById('seed-chips');
        const submitBtn = document.getElementById('onboarding-submit');

        if (!selected) {
            preview.style.display   = 'none';
            submitBtn.disabled      = true;
            return;
        }

        const domainSeeds = seeds[selected] ?? seeds['Other'];
        chipsEl.innerHTML = domainSeeds.map(name => `
            <span class="chip chip-pending" style="cursor: default;">${name}</span>
        `).join('');

        preview.style.display  = 'block';
        submitBtn.disabled     = false;
    });

    document.getElementById('onboarding-submit')?.addEventListener('click', async () => {
        const selected  = document.getElementById('industry-select')?.value;
        const errorEl   = document.getElementById('onboarding-error');
        if (!selected) {
            errorEl.textContent   = 'Please choose an industry to continue.';
            errorEl.style.display = 'block';
            return;
        }

        const btn = document.getElementById('onboarding-submit');
        btn.disabled    = true;
        btn.textContent = 'Setting up…';

        await _saveIndustryAndProceed(container, selected, seeds[selected] ?? seeds['Other']);
    });
}

// ---------------------------------------------------------------------------
// Save the industry to the org profile and seed tentative domains.
// Then proceed to the main dashboard.
// ---------------------------------------------------------------------------
async function _saveIndustryAndProceed(container, industry, domainSeeds) {
    const { db } = await import('../firebase.js');
    const {
        doc,
        setDoc,
        addDoc,
        collection,
        serverTimestamp
    } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

    // Save industry to org profile — this is what prevents the gate
    // from showing on subsequent sign-ins.
    try {
        await setDoc(
            doc(db, 'organisations', _orgId, 'profile', 'data'),
            { industry, updatedAt: serverTimestamp() },
            { merge: true }
        );
        _industry = industry;
        console.log('LORE dashboard.js: Industry saved:', industry);
    } catch (err) {
        console.warn('LORE dashboard.js: Could not save industry.', err);
        // Proceed anyway — the gate will show again next sign-in but that is acceptable
    }

    // Seed tentative domain documents — each labelled as provisional so
    // the Manager knows they are starting points, not confirmed skill areas.
    for (const name of domainSeeds) {
        try {
            await addDoc(collection(db, 'organisations', _orgId, 'domains'), {
                name,
                description: '',
                recipeIds:   [],
                reviewerIds: [],
                provisional: true,   // shown differently in Skill Areas — greyed, dismissible
                confirmedAt: serverTimestamp(),
            });
        } catch (err) {
            console.warn('LORE dashboard.js: Could not seed domain:', name, err);
        }
    }

    console.log('LORE dashboard.js: Seeded', domainSeeds.length, 'provisional domains. Proceeding to dashboard.');

    // Reload domains (now includes the seeds) and render main dashboard
    _domains = await getDomains(_orgId);
    renderDashboard(container);
}

// ---------------------------------------------------------------------------
// Render the full dashboard shell with section navigation.
// ---------------------------------------------------------------------------
function renderDashboard(container) {
    const pendingCount = _pending.length;
    const clusterCount = _clusters.length;

    container.innerHTML = `
        <div>
            <!-- Dashboard header -->
            <div class="flex-between mb-6">
                <div>
                    <h1>Dashboard</h1>
                    <p class="text-secondary text-sm mt-2">${_orgName || 'Your organisation'}</p>
                </div>
                <button class="btn btn-primary" id="invite-btn" style="font-size: var(--text-sm);">
                    Invite someone
                </button>
            </div>

            <!-- Section navigation -->
            <div class="dashboard-nav" style="display: flex; gap: var(--space-2); margin-bottom: var(--space-6); flex-wrap: wrap;">
                ${_navTab('overview',   'Overview')}
                ${_navTab('progress',   'Team progress')}
                ${_navTab('ttc',        'Time to readiness')}
                ${_navTab('reviewer',   'Reviewer activity')}
                ${_navTab('knowledge',  'Knowledge base')}
                ${_navTab('queue',      `Review queue${pendingCount > 0 ? ` <span class="queue-badge">${pendingCount}</span>` : ''}`)}
                ${_navTab('upload',     'Add knowledge')}
                ${_navTab('areas',      `Skill areas${clusterCount > 0 ? ' <span class="queue-badge">!</span>' : ''}`)}
                ${_navTab('team',       'Team')}
            </div>

            <!-- Section content -->
            <div id="dashboard-section"></div>
        </div>
    `;

    // Attach nav tab handlers
    ['overview', 'progress', 'ttc', 'reviewer', 'knowledge', 'queue', 'upload', 'areas', 'team'].forEach(section => {
        document.getElementById(`tab-${section}`)?.addEventListener('click', () => {
            _activeSection = section;
            _setActiveTab(section);
            renderSection(section);
        });
    });

    // Invite button
    document.getElementById('invite-btn')?.addEventListener('click', () => {
        _activeSection = 'team';
        _setActiveTab('team');
        renderSection('team', { openInvite: true });
    });

    // Render the default section
    _setActiveTab(_activeSection);
    renderSection(_activeSection);
}

// ---------------------------------------------------------------------------
// Tab builder helpers.
// ---------------------------------------------------------------------------
function _navTab(id, label) {
    return `
        <button
            id="tab-${id}"
            class="btn btn-secondary dashboard-tab"
            style="font-size: var(--text-sm); padding: var(--space-2) var(--space-4);"
        >
            ${label}
        </button>
    `;
}

function _setActiveTab(activeId) {
    ['overview', 'progress', 'ttc', 'reviewer', 'knowledge', 'queue', 'upload', 'areas', 'team'].forEach(id => {
        const btn = document.getElementById(`tab-${id}`);
        if (!btn) return;
        if (id === activeId) {
            btn.style.background = 'var(--ember)';
            btn.style.color      = 'white';
            btn.style.border     = 'none';
        } else {
            btn.style.background = '';
            btn.style.color      = '';
            btn.style.border     = '';
        }
    });
}

// ---------------------------------------------------------------------------
// Render the content for a given section.
// ---------------------------------------------------------------------------
function renderSection(section, opts = {}) {
    const el = document.getElementById('dashboard-section');
    if (!el) return;

    switch (section) {
        case 'overview':   renderOverview(el);            break;
        case 'progress':   renderTeamProgress(el);        break;
        case 'ttc':        renderTimeToReadiness(el);     break;
        case 'reviewer':   renderReviewerActivity(el);    break;
        case 'knowledge':  renderKnowledgeBase(el);       break;
        case 'queue':      renderReviewQueue(el);         break;
        case 'upload':     renderUpload(el);              break;
        case 'areas':      renderSkillAreas(el);          break;
        case 'team':       renderTeam(el, opts);          break;
        default:           renderOverview(el);
    }
}

// ---------------------------------------------------------------------------
// SECTION: Overview
// High-level numbers — recipe count, coverage summary, pending queue count.
// The Manager sees the health of the knowledge base at a glance.
// ---------------------------------------------------------------------------
function renderOverview(el) {
    // Group recipes by domain name for the coverage heat map
    const byDomain = {};
    _recipes.forEach(r => {
        const d = r.domain || 'Uncategorised';
        if (!byDomain[d]) byDomain[d] = 0;
        byDomain[d]++;
    });

    const domainCount  = Object.keys(byDomain).length;
    const pendingCount = _pending.length;

    // Thin areas: domains with fewer than 5 recipes cannot generate varied
    // scenarios reliably. Flagged prominently so the Manager knows where to
    // focus knowledge-building effort.
    const thinAreas = Object.entries(byDomain).filter(([, count]) => count < 5);

    const clusterAlert = _clusters.length > 0
        ? `<div class="card mt-4" style="border-left: 3px solid var(--ember);">
               <p style="font-weight: 500; color: var(--ember);">Skill areas ready to confirm</p>
               <p class="text-secondary text-sm mt-2">LORE has grouped your recipes into ${_clusters.length} proposed skill areas. Review them in the Skill Areas tab.</p>
           </div>`
        : '';

    const thinAlert = thinAreas.length > 0 && _recipes.length > 0
        ? `<div class="card mt-4" style="border-left: 3px solid #D4943A;">
               <p style="font-weight: 500; color: #8C5A0A;">
                   ${thinAreas.length} skill area${thinAreas.length !== 1 ? 's' : ''} need${thinAreas.length === 1 ? 's' : ''} more recipes
               </p>
               <p class="text-secondary text-sm mt-2">
                   ${thinAreas.map(([d]) => d).join(', ')} — fewer than 5 recipes each. Scenario variety will be limited until more are added.
               </p>
           </div>`
        : '';

    el.innerHTML = `
        <div>
            ${clusterAlert}
            ${thinAlert}

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); margin-top: var(--space-4);">
                <div class="card">
                    <p class="label">Recipes in knowledge base</p>
                    <p style="font-size: var(--text-3xl); font-weight: 600; margin-top: var(--space-2);">${_recipes.length}</p>
                    <p class="text-secondary text-sm mt-2">${domainCount} skill area${domainCount !== 1 ? 's' : ''}</p>
                </div>
                <div class="card">
                    <p class="label">Awaiting your review</p>
                    <p style="font-size: var(--text-3xl); font-weight: 600; margin-top: var(--space-2);">${pendingCount}</p>
                    <p class="text-secondary text-sm mt-2">${pendingCount > 0 ? 'Open Review Queue' : 'Nothing pending'}</p>
                </div>
            </div>

            ${_recipes.length === 0 ? renderEmptyKnowledgeBase() : renderCoverageHeatMap(byDomain)}

            <div class="card mt-4">
                <h3 style="margin-bottom: var(--space-3);">Getting started</h3>
                <p class="text-secondary text-sm">Add knowledge by uploading a document, or invite a senior team member to start contributing. Once you have three or more recipes, LORE will suggest skill areas to confirm.</p>
                <div style="display: flex; gap: var(--space-3); margin-top: var(--space-4); flex-wrap: wrap;">
                    <button class="btn btn-primary" id="go-upload" style="font-size: var(--text-sm);">Upload a document</button>
                    <button class="btn btn-secondary" id="go-invite" style="font-size: var(--text-sm);">Invite a reviewer</button>
                </div>
            </div>
        </div>
    `;

    document.getElementById('go-upload')?.addEventListener('click', () => {
        _activeSection = 'upload'; _setActiveTab('upload'); renderSection('upload');
    });
    document.getElementById('go-invite')?.addEventListener('click', () => {
        _activeSection = 'team'; _setActiveTab('team'); renderSection('team', { openInvite: true });
    });
}

function renderEmptyKnowledgeBase() {
    return `
        <div class="card mt-4" style="text-align: center; padding: var(--space-10);">
            <p style="color: var(--warm-grey); font-size: var(--text-lg);">No recipes yet</p>
            <p class="text-secondary text-sm mt-2">Your knowledge base is empty on day one — that's correct. Upload a document or invite a senior team member to start building it.</p>
        </div>
    `;
}

// Coverage heat map — visual representation of recipe depth per skill area.
// Colour-coded: sage (strong, >= 5), amber (developing, 3–4), ember (thin, < 3).
// The 5-recipe threshold is not arbitrary — below it, scenario variety drops
// and Employees will see repeated content, breaking the learning experience.
function renderCoverageHeatMap(byDomain) {
    const max = Math.max(...Object.values(byDomain));
    return `
        <div class="card mt-4">
            <h3 style="margin-bottom: var(--space-1);">Coverage heat map</h3>
            <p class="text-secondary text-sm mb-4">Skill areas with fewer than 5 recipes cannot generate enough varied scenarios for effective training.</p>
            ${Object.entries(byDomain).sort((a, b) => b[1] - a[1]).map(([domain, count]) => {
                const barColour  = count >= 5 ? 'var(--sage)' : count >= 3 ? '#D4943A' : 'var(--ember)';
                const labelColour = count >= 5 ? 'var(--sage)' : count >= 3 ? '#8C5A0A' : 'var(--error)';
                const pct        = Math.round((count / max) * 100);
                const label      = count >= 5 ? 'Strong' : count >= 3 ? 'Developing' : 'Thin — needs recipes';
                return `
                    <div style="margin-bottom: var(--space-4);">
                        <div class="flex-between mb-2">
                            <p style="font-size: var(--text-sm); font-weight: 500;">${domain}</p>
                            <p style="font-size: var(--text-xs); color: ${labelColour};">${count} recipe${count !== 1 ? 's' : ''} · ${label}</p>
                        </div>
                        <div class="xp-bar-track">
                            <div class="xp-bar-fill" style="width: ${pct}%; background: ${barColour};"></div>
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

// ---------------------------------------------------------------------------
// SECTION: Knowledge Base
// All approved recipes listed by skill area.
// ---------------------------------------------------------------------------
function renderKnowledgeBase(el) {
    if (_recipes.length === 0) {
        el.innerHTML = `
            <div class="empty-state">
                <h3>No recipes yet</h3>
                <p class="mt-2">Upload a document or invite a Reviewer to start building your knowledge base.</p>
                <button class="btn btn-primary mt-6" id="kb-go-upload">Upload a document</button>
            </div>
        `;
        document.getElementById('kb-go-upload')?.addEventListener('click', () => {
            _activeSection = 'upload'; _setActiveTab('upload'); renderSection('upload');
        });
        return;
    }

    // Group by domain
    const byDomain = {};
    _recipes.forEach(r => {
        const d = r.domain || 'Uncategorised';
        if (!byDomain[d]) byDomain[d] = [];
        byDomain[d].push(r);
    });

    el.innerHTML = `
        <div>
            <p class="text-secondary text-sm mb-6">${_recipes.length} recipe${_recipes.length !== 1 ? 's' : ''} across ${Object.keys(byDomain).length} skill area${Object.keys(byDomain).length !== 1 ? 's' : ''}</p>
            ${Object.entries(byDomain).map(([domain, recipes]) => `
                <div style="margin-bottom: var(--space-8);">
                    <h3 style="margin-bottom: var(--space-4);">${domain}</h3>
                    ${recipes.map(r => renderRecipeCard(r)).join('')}
                </div>
            `).join('')}
        </div>
    `;

    // Attach expand/collapse and send-for-review handlers for each recipe
    _recipes.forEach(r => {
        document.getElementById(`recipe-toggle-${r.id}`)?.addEventListener('click', () => {
            const detail = document.getElementById(`recipe-detail-${r.id}`);
            const btn    = document.getElementById(`recipe-toggle-${r.id}`);
            if (detail) {
                const isVisible = detail.style.display !== 'none';
                detail.style.display = isVisible ? 'none' : 'block';
                btn.textContent = isVisible ? 'Show' : 'Hide';
            }
        });

        document.getElementById(`recipe-review-${r.id}`)?.addEventListener('click', async () => {
            const panel = document.getElementById(`recipe-review-panel-${r.id}`);
            if (!panel) return;

            // Toggle the panel
            const isOpen = panel.style.display !== 'none';
            panel.style.display = isOpen ? 'none' : 'block';
            if (isOpen) return;

            // Populate Reviewer dropdown from team members with role='reviewer'
            const reviewerSelect   = document.getElementById(`review-reviewer-${r.id}`);
            const scenarioSelect   = document.getElementById(`review-scenario-${r.id}`);
            const statusEl         = document.getElementById(`review-status-${r.id}`);

            // Load Reviewers
            const { db: firestoreDb } = await import('../firebase.js');
            const { collection: col, query: q, where: wh, getDocs: gd } =
                await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

            try {
                const usersSnap = await gd(
                    q(col(firestoreDb, 'organisations', _orgId, 'users'), wh('role', '==', 'reviewer'))
                );
                usersSnap.forEach(d => {
                    const opt = document.createElement('option');
                    opt.value = d.id;
                    opt.textContent = d.data().displayName ?? d.data().email ?? d.id;
                    reviewerSelect?.appendChild(opt);
                });

                // Load scenarios for this recipe
                const scenariosSnap = await gd(
                    q(col(firestoreDb, 'organisations', _orgId, 'scenarios'), wh('recipeId', '==', r.id))
                );
                if (scenariosSnap.empty) {
                    if (statusEl) statusEl.textContent = 'No scenarios generated for this recipe yet.';
                } else {
                    scenariosSnap.forEach((d, i) => {
                        const opt = document.createElement('option');
                        opt.value = d.id;
                        opt.textContent = `Scenario ${i + 1} — ${d.data().scenarioType ?? 'general'}`;
                        scenarioSelect?.appendChild(opt);
                    });
                }
            } catch (err) {
                console.warn('LORE dashboard.js: Could not load Reviewers or scenarios.', err);
                if (statusEl) statusEl.textContent = 'Could not load Reviewers. Try again.';
            }

            // Send button
            document.getElementById(`review-send-${r.id}`)?.addEventListener('click', async () => {
                const reviewerId = reviewerSelect?.value;
                const scenarioId = scenarioSelect?.value;
                if (!reviewerId || !scenarioId) {
                    if (statusEl) statusEl.textContent = 'Please choose a Reviewer and a scenario.';
                    return;
                }
                const btn = document.getElementById(`review-send-${r.id}`);
                btn.disabled = true;
                btn.textContent = 'Sending…';

                const result = await queueScenarioReview(_orgId, scenarioId, reviewerId);
                btn.disabled = false;
                btn.textContent = 'Send';
                if (statusEl) statusEl.textContent = result.ok
                    ? "Sent. They'll see it in their next session."
                    : result.error ?? 'Could not send. Try again.';
            });
        });
    });
}

function renderRecipeCard(r) {
    // Find scenarios in Firestore linked to this recipe so the Manager
    // can send one for Reviewer quality check. The scenario list is
    // fetched lazily when the Manager clicks "Send for review."
    return `
        <div class="card" style="margin-bottom: var(--space-3);">
            <div class="flex-between">
                <p style="font-weight: 500;">${r.skillName}</p>
                <div style="display: flex; gap: var(--space-2);">
                    <button
                        class="btn btn-secondary"
                        id="recipe-review-${r.id}"
                        style="font-size: var(--text-xs); padding: var(--space-1) var(--space-3);"
                        title="Send a scenario from this recipe for Reviewer quality check"
                    >Send for review</button>
                    <button
                        class="btn btn-secondary"
                        id="recipe-toggle-${r.id}"
                        style="font-size: var(--text-xs); padding: var(--space-1) var(--space-3);"
                    >Show</button>
                </div>
            </div>
            <div id="recipe-detail-${r.id}" style="display: none; margin-top: var(--space-4);">
                <div class="divider" style="margin: var(--space-3) 0;"></div>
                <p class="label mb-1">When to use it</p>
                <p class="text-sm text-secondary">${r.trigger}</p>
                <p class="label mt-4 mb-1">What to do</p>
                <p class="text-sm text-secondary">${r.actionSequence}</p>
                <p class="label mt-4 mb-1">What it produces</p>
                <p class="text-sm text-secondary">${r.expectedOutcome}</p>
                ${r.flawPattern ? `
                    <p class="label mt-4 mb-1">Common mistake</p>
                    <p class="text-sm text-secondary">${r.flawPattern}</p>
                ` : ''}
            </div>
            <!-- Send for review panel — shown when Manager clicks the button -->
            <div id="recipe-review-panel-${r.id}" style="display: none; margin-top: var(--space-4);">
                <div class="divider" style="margin: var(--space-3) 0;"></div>
                <p class="label mb-2">Send a scenario for review</p>
                <p class="text-sm text-secondary mb-3">Choose a Reviewer and a scenario generated from this recipe. They'll see it as a quality check — nothing else.</p>
                <select class="input mb-3" id="review-reviewer-${r.id}" style="margin-bottom: var(--space-3);">
                    <option value="">Choose a Reviewer…</option>
                </select>
                <select class="input mb-3" id="review-scenario-${r.id}" style="margin-bottom: var(--space-3);">
                    <option value="">Choose a scenario…</option>
                </select>
                <p id="review-status-${r.id}" class="text-xs text-secondary mb-2"></p>
                <button class="btn btn-primary" id="review-send-${r.id}" style="font-size: var(--text-sm);">
                    Send
                </button>
            </div>
        </div>
    `;
}

// ---------------------------------------------------------------------------
// SECTION: Review Queue
// Pending extractions — the Manager reads each one and decides to approve,
// edit and approve, or reject. Each approved extraction becomes a live recipe.
// ---------------------------------------------------------------------------
function renderReviewQueue(el) {
    if (_pending.length === 0) {
        el.innerHTML = `
            <div class="empty-state">
                <h3>Nothing to review</h3>
                <p class="mt-2">When Reviewers submit feedback or you upload a document, the extracted knowledge will appear here for your sign-off.</p>
            </div>
        `;
        return;
    }

    el.innerHTML = `
        <div>
            <p class="text-secondary text-sm mb-6">${_pending.length} item${_pending.length !== 1 ? 's' : ''} waiting for your review</p>
            <div id="queue-list">
                ${_pending.map((ext, i) => renderExtractionCard(ext, i)).join('')}
            </div>
        </div>
    `;

    // Attach handlers for each extraction card
    _pending.forEach((ext, i) => {
        _attachExtractionHandlers(ext, i, el);
    });
}

function renderExtractionCard(ext, index) {
    const sourceLabel = {
        'scenario_review': 'Scenario feedback',
        'mentorship_note': 'Mentorship note',
        'document':        'Document',
    }[ext.sourceType] ?? 'Contribution';

    // An extraction may already have a processed draft (from AI), or may be raw
    const hasDraft = ext.draft && ext.draft.hasRecipe !== false && ext.draft.skillName;

    return `
        <div class="card" style="margin-bottom: var(--space-4);" id="ext-card-${index}">
            <div class="flex-between mb-3">
                <span class="chip chip-pending">${sourceLabel}</span>
                <span class="text-xs text-secondary">${ext.contextNote ? ext.contextNote.slice(0, 60) : ''}</span>
            </div>

            ${hasDraft ? renderDraftPreview(ext.draft, index) : renderRawContent(ext, index)}

            <div class="divider" style="margin: var(--space-4) 0;"></div>

            ${hasDraft ? renderApprovalControls(index, ext.draft) : renderProcessButton(index)}
        </div>
    `;
}

function renderRawContent(ext, index) {
    return `
        <div>
            <p class="label mb-2">Raw contribution</p>
            <p class="text-sm text-secondary" style="line-height: 1.7;">${ext.rawContent ?? 'No content available'}</p>
            <p class="text-xs text-secondary mt-3" id="process-status-${index}"></p>
        </div>
    `;
}

function renderDraftPreview(draft, index) {
    return `
        <div>
            <p class="label mb-1">Skill</p>
            <input
                class="input"
                id="draft-skill-${index}"
                value="${_esc(draft.skillName ?? '')}"
                style="margin-bottom: var(--space-3);"
            >
            <p class="label mb-1">When to use it</p>
            <textarea class="input" id="draft-trigger-${index}" rows="2" style="margin-bottom: var(--space-3); resize: vertical;">${_esc(draft.trigger ?? '')}</textarea>
            <p class="label mb-1">What to do</p>
            <textarea class="input" id="draft-action-${index}" rows="3" style="margin-bottom: var(--space-3); resize: vertical;">${_esc(draft.actionSequence ?? '')}</textarea>
            <p class="label mb-1">What it produces</p>
            <textarea class="input" id="draft-outcome-${index}" rows="2" style="margin-bottom: var(--space-3); resize: vertical;">${_esc(draft.expectedOutcome ?? '')}</textarea>
            <p class="label mb-1">Assign to skill area</p>
            <input
                class="input"
                id="draft-domain-${index}"
                value="${_esc(draft.domain ?? (_domains[0]?.name ?? ''))}"
                placeholder="Type a skill area name…"
            >
        </div>
    `;
}

function renderProcessButton(index) {
    return `
        <div style="display: flex; gap: var(--space-3);">
            <button class="btn btn-primary" id="process-btn-${index}" style="font-size: var(--text-sm);">
                Extract knowledge
            </button>
            <button class="btn btn-secondary" id="reject-btn-${index}" style="font-size: var(--text-sm); color: var(--error);">
                Dismiss
            </button>
        </div>
    `;
}

function renderApprovalControls(index, draft) {
    return `
        <div style="display: flex; gap: var(--space-3);">
            <button class="btn btn-primary" id="approve-btn-${index}" style="font-size: var(--text-sm);">
                Add to knowledge base
            </button>
            <button class="btn btn-secondary" id="reject-btn-${index}" style="font-size: var(--text-sm); color: var(--error);">
                Dismiss
            </button>
        </div>
    `;
}

function _attachExtractionHandlers(ext, index, el) {
    // Process button (raw → draft)
    document.getElementById(`process-btn-${index}`)?.addEventListener('click', async () => {
        const btn = document.getElementById(`process-btn-${index}`);
        const status = document.getElementById(`process-status-${index}`);
        btn.disabled = true;
        btn.textContent = 'Extracting…';
        if (status) status.textContent = 'Reading contribution…';

        const result = await processExtraction(_orgId, ext.id, ext);

        if (!result.ok || !result.draft?.hasRecipe) {
            if (status) status.textContent = result.ok
                ? 'No clear recipe pattern found in this contribution.'
                : 'Could not extract at this time. Try again shortly.';
            btn.disabled  = false;
            btn.textContent = 'Try again';
            return;
        }

        // Update the local pending list and re-render the card in place
        const cardEl = document.getElementById(`ext-card-${index}`);
        if (cardEl) {
            const updatedExt = { ...ext, draft: result.draft, status: 'processed' };
            _pending[index] = updatedExt;
            cardEl.outerHTML = renderExtractionCard(updatedExt, index);
            _attachExtractionHandlers(updatedExt, index, el);
        }
    });

    // Approve button (draft → live recipe)
    document.getElementById(`approve-btn-${index}`)?.addEventListener('click', async () => {
        const btn = document.getElementById(`approve-btn-${index}`);
        btn.disabled = true;
        btn.textContent = 'Saving…';

        // Read any Manager edits from the form fields
        const draft = {
            skillName:      document.getElementById(`draft-skill-${index}`)?.value?.trim()   ?? ext.draft?.skillName,
            trigger:        document.getElementById(`draft-trigger-${index}`)?.value?.trim() ?? ext.draft?.trigger,
            actionSequence: document.getElementById(`draft-action-${index}`)?.value?.trim()  ?? ext.draft?.actionSequence,
            expectedOutcome: document.getElementById(`draft-outcome-${index}`)?.value?.trim() ?? ext.draft?.expectedOutcome,
            flawPattern:    ext.draft?.flawPattern ?? null,
            sourceType:     ext.sourceType,
        };
        const domain = document.getElementById(`draft-domain-${index}`)?.value?.trim()
            ?? (_domains[0]?.name ?? 'General');

        const recipeId = await approveRecipe(_orgId, draft, ext.id, domain);

        if (recipeId) {
            // Remove from pending list and reload recipes
            _pending.splice(index, 1);
            _recipes = await getAllApprovedRecipes(_orgId);
            renderReviewQueue(document.getElementById('dashboard-section'));

            // Trigger clustering if we have enough recipes now
            if (_recipes.length >= 3) {
                const clusterResult = await triggerClustering(_orgId, _recipes);
                if (clusterResult.ok) _clusters = clusterResult.clusters;
            }
        } else {
            btn.disabled    = false;
            btn.textContent = 'Add to knowledge base';
        }
    });

    // Reject button
    document.getElementById(`reject-btn-${index}`)?.addEventListener('click', async () => {
        await rejectExtraction(_orgId, ext.id);
        _pending.splice(index, 1);
        renderReviewQueue(document.getElementById('dashboard-section'));
    });
}

// ---------------------------------------------------------------------------
// SECTION: Upload
// Manager uploads a document as plain text; AI extracts recipe drafts.
// The Manager sees a count of training moments found — copy never mentions
// extraction, knowledge base, or recipes.
// ---------------------------------------------------------------------------
function renderUpload(el) {
    el.innerHTML = `
        <div>
            <h3 style="margin-bottom: var(--space-2);">Add knowledge from a document</h3>
            <p class="text-secondary text-sm mb-6">Paste in a retrospective, post-mortem, playbook, or any internal document. LORE will find the training moments inside it.</p>

            <div class="card">
                <div class="auth-field">
                    <label class="label" for="doc-name">Document name</label>
                    <input
                        class="input"
                        id="doc-name"
                        type="text"
                        placeholder="e.g. Q3 Project Retrospective"
                    >
                </div>

                <div class="auth-field mt-4">
                    <label class="label" for="doc-text">Document content</label>
                    <textarea
                        class="input"
                        id="doc-text"
                        rows="12"
                        placeholder="Paste the document text here…"
                        style="resize: vertical;"
                    ></textarea>
                </div>

                <p class="text-xs text-secondary mb-4">The first 6,000 characters will be processed. For longer documents, paste the most decision-rich sections.</p>

                <button class="btn btn-primary" id="process-doc">
                    Find training moments
                </button>
            </div>

            <div id="upload-result" style="margin-top: var(--space-6);"></div>
        </div>
    `;

    document.getElementById('process-doc')?.addEventListener('click', async () => {
        const name = document.getElementById('doc-name')?.value?.trim();
        const text = document.getElementById('doc-text')?.value?.trim();

        if (!name || !text) {
            document.getElementById('upload-result').innerHTML = `
                <p class="text-secondary text-sm" style="color: var(--error);">Please enter a document name and paste the content.</p>
            `;
            return;
        }

        const btn = document.getElementById('process-doc');
        btn.disabled = true;
        btn.textContent = 'Reading…';

        const resultEl = document.getElementById('upload-result');
        resultEl.innerHTML = `<div class="empty-state"><div class="spinner"></div><p class="text-secondary mt-4">Reading your document…</p></div>`;

        const result = await processDocument(_orgId, text, name);

        btn.disabled    = false;
        btn.textContent = 'Find training moments';

        if (!result.ok) {
            resultEl.innerHTML = `<p class="text-secondary text-sm" style="color: var(--error);">Could not process the document right now. Please try again shortly.</p>`;
            return;
        }

        if (result.extractions.length === 0) {
            resultEl.innerHTML = `
                <div class="card">
                    <p style="font-weight: 500;">No clear training moments found</p>
                    <p class="text-secondary text-sm mt-2">This document doesn't seem to contain the kind of specific decision logic LORE looks for. Try a retrospective, post-mortem, or playbook that describes how your team made specific calls.</p>
                </div>
            `;
            return;
        }

        // Reload pending queue and switch to it
        _pending = await getPendingExtractions(_orgId);
        resultEl.innerHTML = `
            <div class="card" style="border-left: 3px solid var(--sage);">
                <p style="font-weight: 500; color: var(--sage);">We found ${result.extractions.length} training moment${result.extractions.length !== 1 ? 's' : ''}</p>
                <p class="text-secondary text-sm mt-2">They're in your review queue. Go through them and add the ones that feel right to your knowledge base.</p>
                <button class="btn btn-primary mt-4" id="go-to-queue" style="font-size: var(--text-sm);">Open review queue</button>
            </div>
        `;
        document.getElementById('go-to-queue')?.addEventListener('click', () => {
            _activeSection = 'queue'; _setActiveTab('queue'); renderSection('queue');
        });
    });
}

// ---------------------------------------------------------------------------
// SECTION: Skill Areas
// Shows AI-proposed domain clusters for Manager review.
// The Manager can confirm, rename, or dismiss clusters.
// Also shows already-confirmed domains.
// ---------------------------------------------------------------------------
function renderSkillAreas(el) {
    const hasProposed  = _clusters.length > 0;
    const hasConfirmed = _domains.length  > 0;

    el.innerHTML = `
        <div>
            <h3 style="margin-bottom: var(--space-2);">Skill areas</h3>
            <p class="text-secondary text-sm mb-6">Skill areas are found in what your organisation knows — not set in advance. LORE proposes groupings; you confirm them.</p>

            ${hasProposed ? renderProposedClusters() : ''}
            ${hasConfirmed ? renderConfirmedDomains() : ''}
            ${!hasProposed && !hasConfirmed ? renderNoAreas() : ''}
        </div>
    `;

    // Populate Reviewer dropdowns and attach confirm handlers for each proposed cluster
    _loadReviewersForSelects(_clusters.map((_, i) => `cluster-reviewer-${i}`));

    _clusters.forEach((cluster, i) => {
        document.getElementById(`confirm-cluster-${i}`)?.addEventListener('click', async () => {
            const name       = document.getElementById(`cluster-name-${i}`)?.value?.trim();
            const desc       = document.getElementById(`cluster-desc-${i}`)?.value?.trim();
            const reviewerId = document.getElementById(`cluster-reviewer-${i}`)?.value;
            if (!name) return;

            const btn = document.getElementById(`confirm-cluster-${i}`);
            btn.disabled = true;
            btn.textContent = 'Confirming…';

            // reviewerIds is an array — supports multiple Reviewers per domain
            // in the future. For now, one Reviewer maximum via this UI.
            const reviewerIds = reviewerId ? [reviewerId] : [];
            await confirmDomain(_orgId, { ...cluster, name, description: desc, reviewerIds });
            console.log('LORE dashboard.js: Domain confirmed:', name, 'reviewerIds:', reviewerIds);

            // Refresh domains list and re-render after confirmation
            _domains  = await getDomains(_orgId);
            _clusters.splice(i, 1);
            if (_clusters.length === 0) clearPendingClusters(_orgId);
            renderSkillAreas(el);
        });

        document.getElementById(`dismiss-cluster-${i}`)?.addEventListener('click', () => {
            // Remove this cluster from local list and re-render
            _clusters.splice(i, 1);
            if (_clusters.length === 0) clearPendingClusters(_orgId);
            renderSkillAreas(el);
        });
    });

    // Dismiss handlers for provisional (seeded) domains
    _domains.filter(d => d.provisional).forEach(d => {
        document.getElementById(`dismiss-provisional-${d.id}`)?.addEventListener('click', async () => {
            await deleteDomain(_orgId, d.id);
            _domains = _domains.filter(x => x.id !== d.id);
            console.log('LORE dashboard.js: Provisional domain dismissed:', d.name);
            renderSkillAreas(el);
        });
    });

    // Trigger re-clustering if there are enough recipes but no proposals yet
    document.getElementById('run-clustering')?.addEventListener('click', async () => {
        const btn = document.getElementById('run-clustering');
        btn.disabled = true;
        btn.textContent = 'Grouping…';

        const result = await triggerClustering(_orgId, _recipes);
        if (result.ok && result.clusters.length > 0) {
            _clusters = result.clusters;
            _domains  = await getDomains(_orgId);
            renderSkillAreas(el);
        } else {
            btn.disabled    = false;
            btn.textContent = 'Group my recipes';
        }
    });
}

function renderProposedClusters() {
    // Build a Reviewer option list from known team members —
    // rendered as a datalist so the Manager can type or pick.
    // The actual Reviewer uid is stored in a hidden input alongside the name.
    return `
        <div class="card mb-6" style="border-left: 3px solid var(--ember);">
            <p style="font-weight: 500; margin-bottom: var(--space-2);">Proposed skill areas</p>
            <p class="text-secondary text-sm mb-6">Based on your recipes, LORE suggests these groupings. Edit the names, assign a Reviewer, then confirm.</p>

            ${_clusters.map((cluster, i) => `
                <div style="border: 1px solid rgba(44,36,22,0.1); border-radius: var(--radius-md); padding: var(--space-4); margin-bottom: var(--space-4);">
                    <div class="auth-field">
                        <label class="label" for="cluster-name-${i}">Skill area name</label>
                        <input class="input" id="cluster-name-${i}" value="${_esc(cluster.name ?? '')}" style="margin-bottom: var(--space-2);">
                    </div>
                    <div class="auth-field">
                        <label class="label" for="cluster-desc-${i}">Description</label>
                        <input class="input" id="cluster-desc-${i}" value="${_esc(cluster.description ?? '')}" placeholder="One sentence description…">
                    </div>
                    <div class="auth-field mt-3">
                        <label class="label" for="cluster-reviewer-${i}">Assign a Reviewer (optional)</label>
                        <select class="input" id="cluster-reviewer-${i}">
                            <option value="">No Reviewer assigned</option>
                            <!-- Populated by _loadReviewersIntoSelect() after render -->
                        </select>
                        <p class="text-xs text-secondary mt-1">The assigned Reviewer receives mentorship prompts when an Employee misses a scenario in this area.</p>
                    </div>
                    <p class="text-xs text-secondary mt-3 mb-4">${(cluster.recipeIds ?? []).length} recipe${(cluster.recipeIds ?? []).length !== 1 ? 's' : ''}</p>
                    <div style="display: flex; gap: var(--space-3);">
                        <button class="btn btn-primary" id="confirm-cluster-${i}" style="font-size: var(--text-sm);">Confirm skill area</button>
                        <button class="btn btn-secondary" id="dismiss-cluster-${i}" style="font-size: var(--text-sm);">Dismiss</button>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

function renderConfirmedDomains() {
    const confirmed    = _domains.filter(d => !d.provisional);
    const provisional  = _domains.filter(d =>  d.provisional);

    return `
        <div>
            ${confirmed.length > 0 ? `
                <h3 style="margin-bottom: var(--space-4);">Your skill areas</h3>
                ${confirmed.map(d => `
                    <div class="card" style="margin-bottom: var(--space-3);">
                        <div class="flex-between">
                            <div>
                                <p style="font-weight: 500;">${d.name}</p>
                                <p class="text-secondary text-sm mt-1">${d.description ?? ''}</p>
                            </div>
                            <p class="text-xs text-secondary">${(d.recipeIds ?? []).length} recipe${(d.recipeIds ?? []).length !== 1 ? 's' : ''}</p>
                        </div>
                    </div>
                `).join('')}
            ` : ''}

            ${provisional.length > 0 ? `
                <h3 style="margin-bottom: var(--space-2); margin-top: ${confirmed.length > 0 ? 'var(--space-8)' : '0'};">Starting points</h3>
                <p class="text-secondary text-sm mb-4">These are provisional — based on your industry. They will be replaced by LORE as your organisation's own knowledge builds. Dismiss any that don't apply.</p>
                ${provisional.map(d => `
                    <div class="card" style="margin-bottom: var(--space-3); opacity: 0.7;">
                        <div class="flex-between">
                            <div>
                                <p style="font-weight: 500; color: var(--warm-grey);">${d.name}</p>
                                <span class="chip chip-pending" style="margin-top: var(--space-1); font-size: 10px;">Provisional</span>
                            </div>
                            <button
                                class="btn btn-secondary"
                                id="dismiss-provisional-${d.id}"
                                style="font-size: var(--text-xs); padding: var(--space-1) var(--space-3); color: var(--warm-grey);"
                            >Dismiss</button>
                        </div>
                    </div>
                `).join('')}
            ` : ''}
        </div>
    `;
}

function renderNoAreas() {
    const canCluster = _recipes.length >= 3;
    return `
        <div class="empty-state">
            <h3>No skill areas yet</h3>
            <p class="mt-2">
                ${canCluster
                    ? 'You have enough recipes for LORE to suggest skill areas.'
                    : 'Add at least 3 recipes to your knowledge base before LORE can suggest skill areas.'}
            </p>
            ${canCluster ? `
                <button class="btn btn-primary mt-6" id="run-clustering">Group my recipes</button>
            ` : ''}
        </div>
    `;
}

// ---------------------------------------------------------------------------
// SECTION: Team
// All staff, their roles and statuses. Invite generation for new members.
// ---------------------------------------------------------------------------
function renderTeam(el, opts = {}) {
    el.innerHTML = `
        <div>
            <div class="flex-between mb-6">
                <h3>Team</h3>
                <button class="btn btn-primary" id="show-invite-form" style="font-size: var(--text-sm);">
                    Invite someone
                </button>
            </div>

            <div id="invite-form" style="display: ${opts.openInvite ? 'block' : 'none'};">
                ${renderInviteForm()}
            </div>

            <div id="team-list">
                <p class="text-secondary text-sm">Loading team…</p>
            </div>
        </div>
    `;

    // Toggle the invite form
    document.getElementById('show-invite-form')?.addEventListener('click', () => {
        const form = document.getElementById('invite-form');
        if (form) form.style.display = form.style.display === 'none' ? 'block' : 'none';
    });

    _attachInviteFormHandlers();
    _loadTeamList();
}

function renderInviteForm() {
    return `
        <div class="card mb-6" style="border-left: 3px solid var(--ember);">
            <h3 style="margin-bottom: var(--space-4);">Invite a team member</h3>

            <div class="auth-field">
                <label class="label" for="inv-name">Their name</label>
                <input class="input" id="inv-name" type="text" placeholder="First and last name">
            </div>

            <div class="auth-field mt-3">
                <label class="label" for="inv-email">Email address</label>
                <input class="input" id="inv-email" type="email" placeholder="their@email.com">
            </div>

            <div class="auth-field mt-3">
                <label class="label" for="inv-role">Role in LORE</label>
                <select class="input" id="inv-role">
                    <option value="employee">Employee — will train</option>
                    <option value="reviewer">Reviewer — will contribute knowledge</option>
                </select>
            </div>

            <div class="auth-field mt-3">
                <label class="label" for="inv-title">Their job title</label>
                <input class="input" id="inv-title" type="text" placeholder="e.g. Senior Account Manager">
            </div>

            <div class="auth-field mt-3">
                <label class="label" for="inv-seniority">Experience level</label>
                <select class="input" id="inv-seniority">
                    <option value="junior">Junior</option>
                    <option value="mid" selected>Mid-level</option>
                    <option value="senior">Senior</option>
                </select>
            </div>

            <p id="invite-error" style="color: var(--error); font-size: var(--text-sm); margin-top: var(--space-2); display: none;"></p>
            <p id="invite-link-result" style="margin-top: var(--space-4); display: none;"></p>

            <button class="btn btn-primary mt-4" id="generate-invite">Generate invite link</button>
        </div>
    `;
}

function _attachInviteFormHandlers() {
    document.getElementById('generate-invite')?.addEventListener('click', async () => {
        const name      = document.getElementById('inv-name')?.value?.trim();
        const email     = document.getElementById('inv-email')?.value?.trim();
        const role      = document.getElementById('inv-role')?.value;
        const title     = document.getElementById('inv-title')?.value?.trim();
        const seniority = document.getElementById('inv-seniority')?.value;
        const errorEl   = document.getElementById('invite-error');
        const resultEl  = document.getElementById('invite-link-result');

        // Basic email format validation — catches names typed into the email field
        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!name) {
            errorEl.textContent = 'Please enter their name.';
            errorEl.style.display = 'block';
            return;
        }
        if (!email || !emailPattern.test(email)) {
            errorEl.textContent = 'Please enter a valid email address.';
            errorEl.style.display = 'block';
            return;
        }

        errorEl.style.display  = 'none';
        resultEl.style.display = 'none';

        const btn = document.getElementById('generate-invite');
        btn.disabled    = true;
        btn.textContent = 'Generating…';

        const result = await generateInvite(_orgId, _uid, {
            email,
            role,
            roleTitle:   title,
            seniority,
            orgName:     _orgName,
            displayName: name,
        });

        btn.disabled    = false;
        btn.textContent = 'Generate invite link';

        if (!result.ok) {
            errorEl.textContent   = result.error ?? 'Something went wrong. Please try again.';
            errorEl.style.display = 'block';
            return;
        }

        resultEl.style.display = 'block';
        resultEl.innerHTML = `
            <div class="card" style="border-left: 3px solid var(--sage);">
                <p style="font-weight: 500; color: var(--sage); margin-bottom: var(--space-2);">Invite link ready</p>
                <p class="text-secondary text-sm mb-3">Copy this link and send it to ${name}. It expires in 7 days.</p>
                <div style="display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap;">
                    <input
                        class="input"
                        id="invite-url-display"
                        value="${result.inviteUrl}"
                        readonly
                        style="flex: 1; font-size: var(--text-sm);"
                    >
                    <button class="btn btn-secondary" id="copy-link" style="font-size: var(--text-sm);">Copy</button>
                </div>
            </div>
        `;

        document.getElementById('copy-link')?.addEventListener('click', () => {
            const input = document.getElementById('invite-url-display');
            if (input) {
                navigator.clipboard.writeText(input.value).then(() => {
                    document.getElementById('copy-link').textContent = 'Copied';
                });
            }
        });
    });
}

async function _loadTeamList() {
    const { db } = await import('../firebase.js');
    const {
        collection,
        getDocs
    } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

    const listEl = document.getElementById('team-list');
    if (!listEl) return;

    try {
        const snap = await getDocs(
            collection(db, 'organisations', _orgId, 'users')
        );
        const users = snap.docs.map(d => ({ id: d.id, ...d.data() }));

        if (users.length === 0) {
            listEl.innerHTML = `
                <div class="empty-state">
                    <p class="text-secondary">No team members yet. Generate an invite link to add your first person.</p>
                </div>
            `;
            return;
        }

        listEl.innerHTML = users.map(u => `
            <div class="card" style="margin-bottom: var(--space-3);">
                <div class="flex-between">
                    <div>
                        <p style="font-weight: 500;">${u.displayName ?? u.email ?? 'Team member'}</p>
                        <p class="text-secondary text-sm mt-1">${u.roleTitle ?? u.role ?? ''}</p>
                    </div>
                    <span class="chip chip-correct" style="font-size: var(--text-xs);">${u.role ?? 'employee'}</span>
                </div>
            </div>
        `).join('');
    } catch (err) {
        console.warn('LORE Dashboard: Could not load team list.', err);
        listEl.innerHTML = `<p class="text-secondary text-sm">Could not load team list.</p>`;
    }
}

// ---------------------------------------------------------------------------
// SECTION: Team Progress
// Every Employee's mastery percentage, rank, sessions completed, and last
// active date — in one scannable list. The Manager uses this to spot who is
// active, who has stalled, and who needs a nudge.
// Clicking an Employee's row navigates to their full profile view.
// ---------------------------------------------------------------------------
async function renderTeamProgress(el) {
    el.innerHTML = `<div class="empty-state"><div class="spinner"></div><p class="text-secondary mt-4">Loading team progress…</p></div>`;

    const { db: firestoreDb } = await import('../firebase.js');
    const { collection: col, getDocs: gd } =
        await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

    let employees = [];
    try {
        const snap = await gd(col(firestoreDb, 'organisations', _orgId, 'users'));
        employees = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(u => u.role === 'employee');
    } catch (err) {
        console.warn('LORE dashboard.js: Could not load employees for team progress.', err);
    }

    if (employees.length === 0) {
        el.innerHTML = `
            <div class="empty-state">
                <h3>No Employees yet</h3>
                <p class="mt-2">Invite team members to start tracking their progress here.</p>
                <button class="btn btn-primary mt-6" id="progress-go-invite">Invite someone</button>
            </div>
        `;
        document.getElementById('progress-go-invite')?.addEventListener('click', () => {
            _activeSection = 'team'; _setActiveTab('team'); renderSection('team', { openInvite: true });
        });
        return;
    }

    // Sort: most recently active first, never-active last
    employees.sort((a, b) => {
        if (!a.lastTrainedAt && !b.lastTrainedAt) return 0;
        if (!a.lastTrainedAt) return 1;
        if (!b.lastTrainedAt) return -1;
        return new Date(b.lastTrainedAt) - new Date(a.lastTrainedAt);
    });

    const { getRankForXP } = await import('../engine/state.js');

    // Overall mastery: average accuracy across all domains for each Employee
    function overallMastery(mastery) {
        const domains = Object.values(mastery ?? {});
        if (domains.length === 0) return null;
        const total   = domains.reduce((sum, d) => sum + (d.played ?? 0), 0);
        const correct = domains.reduce((sum, d) => sum + (d.correct ?? 0), 0);
        return total > 0 ? Math.round((correct / total) * 100) : null;
    }

    el.innerHTML = `
        <div>
            <div class="flex-between mb-6">
                <h3>Team progress</h3>
                <p class="text-secondary text-sm">${employees.length} employee${employees.length !== 1 ? 's' : ''}</p>
            </div>

            ${employees.map(emp => {
                const rank    = getRankForXP(emp.xp ?? 0);
                const mastery = overallMastery(emp.domainMastery);
                const masteryColour = mastery === null ? 'var(--warm-grey)'
                    : mastery >= 70 ? 'var(--sage)'
                    : mastery >= 40 ? '#8C5A0A'
                    : 'var(--error)';

                const lastActive = emp.lastTrainedAt
                    ? _relativeTime(new Date(emp.lastTrainedAt))
                    : 'Never trained';

                const isStale = emp.lastTrainedAt
                    ? (Date.now() - new Date(emp.lastTrainedAt).getTime()) > 7 * 24 * 60 * 60 * 1000
                    : true;

                return `
                    <div class="card" style="margin-bottom: var(--space-3); cursor: pointer;" id="emp-row-${emp.id}">
                        <div class="flex-between">
                            <div style="flex: 1;">
                                <div class="flex-between">
                                    <p style="font-weight: 500;">${emp.displayName ?? emp.email ?? 'Team member'}</p>
                                    <span class="rank-badge" style="font-size: 10px;">${rank.name}</span>
                                </div>
                                <p class="text-secondary text-sm mt-1">${emp.roleTitle ?? ''}</p>
                                <div style="display: flex; gap: var(--space-6); margin-top: var(--space-3); flex-wrap: wrap;">
                                    <div>
                                        <p class="text-xs text-secondary">Overall mastery</p>
                                        <p style="font-size: var(--text-sm); font-weight: 500; color: ${masteryColour};">
                                            ${mastery !== null ? mastery + '%' : 'No sessions yet'}
                                        </p>
                                    </div>
                                    <div>
                                        <p class="text-xs text-secondary">Sessions</p>
                                        <p style="font-size: var(--text-sm); font-weight: 500;">${emp.sessionsTotal ?? 0}</p>
                                    </div>
                                    <div>
                                        <p class="text-xs text-secondary">Last active</p>
                                        <p style="font-size: var(--text-sm); font-weight: 500; color: ${isStale ? 'var(--error)' : 'var(--ink)'};">
                                            ${lastActive}
                                        </p>
                                    </div>
                                    <div>
                                        <p class="text-xs text-secondary">XP</p>
                                        <p style="font-size: var(--text-sm); font-weight: 500;">${(emp.xp ?? 0).toLocaleString()}</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    `;

    // Each row navigates to the Employee's full profile view
    employees.forEach(emp => {
        document.getElementById(`emp-row-${emp.id}`)?.addEventListener('click', () => {
            // Navigate using the ?employee=UID pattern that app.js handles
            window.location.href = `${window.location.pathname}?employee=${emp.id}`;
        });
    });
}

// ---------------------------------------------------------------------------
// SECTION: Time to Readiness
// Per-Employee progress narratives. Not a raw metric — a plain-language
// read of where each Employee is in their development curve.
// Generated by AI on demand, or shown as a skeleton if no sessions yet.
//
// The internal label is "Time to Competency". What the Manager sees is
// always expressed as a progress narrative: "Adaeze has moved from
// developing to mid-level in client management over 4 months."
// ---------------------------------------------------------------------------
async function renderTimeToReadiness(el) {
    el.innerHTML = `<div class="empty-state"><div class="spinner"></div><p class="text-secondary mt-4">Loading…</p></div>`;

    const { db: firestoreDb } = await import('../firebase.js');
    const { collection: col, getDocs: gd } =
        await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

    let employees = [];
    try {
        const snap = await gd(col(firestoreDb, 'organisations', _orgId, 'users'));
        employees = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(u => u.role === 'employee' && (u.sessionsTotal ?? 0) > 0);
    } catch (err) {
        console.warn('LORE dashboard.js: Could not load employees for TTC.', err);
    }

    if (employees.length === 0) {
        el.innerHTML = `
            <div class="empty-state">
                <h3>No training data yet</h3>
                <p class="mt-2">Progress narratives appear here once Employees have completed their first training sessions.</p>
            </div>
        `;
        return;
    }

    el.innerHTML = `
        <div>
            <h3 style="margin-bottom: var(--space-2);">Time to readiness</h3>
            <p class="text-secondary text-sm mb-6">Where each person is in their development curve, in plain language.</p>
            ${employees.map((emp, i) => `
                <div class="card" style="margin-bottom: var(--space-4);">
                    <div class="flex-between mb-3">
                        <div>
                            <p style="font-weight: 500;">${emp.displayName ?? 'Team member'}</p>
                            <p class="text-secondary text-sm">${emp.roleTitle ?? ''} · ${emp.sessionsTotal ?? 0} sessions</p>
                        </div>
                        <button class="btn btn-secondary" id="ttc-gen-${i}" style="font-size: var(--text-xs); padding: var(--space-1) var(--space-3);">
                            Generate
                        </button>
                    </div>
                    <p id="ttc-text-${i}" class="text-secondary text-sm" style="line-height: 1.8;">
                        Click Generate to see a progress narrative for ${emp.displayName ?? 'this team member'}.
                    </p>
                </div>
            `).join('')}
        </div>
    `;

    const { generate } = await import('../engine/ai.js');

    employees.forEach((emp, i) => {
        document.getElementById(`ttc-gen-${i}`)?.addEventListener('click', async () => {
            const btn    = document.getElementById(`ttc-gen-${i}`);
            const textEl = document.getElementById(`ttc-text-${i}`);
            btn.disabled    = true;
            btn.textContent = 'Generating…';

            const masteryLines = Object.entries(emp.domainMastery ?? {}).map(([domain, stats]) => {
                const acc = stats.played > 0 ? Math.round((stats.correct / stats.played) * 100) : 0;
                return `${domain}: ${acc}% accuracy across ${stats.played} session${stats.played !== 1 ? 's' : ''}`;
            }).join('; ') || 'No domain data yet';

            const systemPrompt = `You are writing a brief, plain-language progress narrative for a manager about one of their team members.
This is about their development trajectory — not a performance score.
Tone: trusted colleague, warm but precise. Not clinical.
Length: 2 to 3 sentences maximum.
Never use: "time to competency", "metric", "data shows", "score", "percentage", LORE, training.
Do not begin with the person's name.
Focus on: where they are now, how far they have come, a realistic sense of what comes next.`;

            const prompt = `Team member: ${emp.displayName ?? 'this person'}
Role: ${emp.roleTitle ?? 'not specified'}
Experience level: ${emp.seniority ?? 'not specified'}
Sessions completed: ${emp.sessionsTotal ?? 0}
Calibration confirmed: ${(emp.sessionsTotal ?? 0) >= 20 ? 'yes' : 'not yet — still forming'}
Skill area performance: ${masteryLines}

Write the progress narrative.`;

            console.log('LORE dashboard.js: Generating TTC narrative for employee:', emp.id);
            const result = await generate(prompt, systemPrompt);

            btn.disabled    = false;
            btn.textContent = 'Regenerate';

            if (!result.ok) {
                if (textEl) textEl.textContent = 'Could not generate right now. Try again shortly.';
                return;
            }

            if (textEl) {
                textEl.textContent    = result.text;
                textEl.style.color    = 'var(--ink)';
                textEl.style.fontStyle = 'normal';
            }
        });
    });
}

// ---------------------------------------------------------------------------
// SECTION: Reviewer Activity
// Shows what each Reviewer has contributed: scenarios reviewed, mentorship
// notes written, documents processed. The Manager needs this to know whether
// the extraction side of the system is producing at the rate expected.
//
// Data is read from the extractions collection grouped by reviewerId,
// and from the tasks sub-collection completion counts.
// ---------------------------------------------------------------------------
async function renderReviewerActivity(el) {
    el.innerHTML = `<div class="empty-state"><div class="spinner"></div><p class="text-secondary mt-4">Loading…</p></div>`;

    const { db: firestoreDb } = await import('../firebase.js');
    const {
        collection: col,
        query: q,
        where: wh,
        getDocs: gd,
    } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

    // Load all Reviewers and all extractions in parallel
    let reviewers = [];
    let allExtractions = [];
    try {
        const [reviewerSnap, extractionSnap] = await Promise.all([
            gd(q(col(firestoreDb, 'organisations', _orgId, 'users'), wh('role', '==', 'reviewer'))),
            gd(col(firestoreDb, 'organisations', _orgId, 'extractions')),
        ]);
        reviewers       = reviewerSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        allExtractions  = extractionSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
        console.warn('LORE dashboard.js: Could not load Reviewer activity data.', err);
    }

    if (reviewers.length === 0) {
        el.innerHTML = `
            <div class="empty-state">
                <h3>No Reviewers yet</h3>
                <p class="mt-2">Invite senior team members as Reviewers to start building your knowledge base.</p>
                <button class="btn btn-primary mt-6" id="reviewer-go-invite">Invite a Reviewer</button>
            </div>
        `;
        document.getElementById('reviewer-go-invite')?.addEventListener('click', () => {
            _activeSection = 'team'; _setActiveTab('team'); renderSection('team', { openInvite: true });
        });
        return;
    }

    // Group extractions by reviewerId and sourceType
    const activityByReviewer = {};
    reviewers.forEach(r => {
        activityByReviewer[r.id] = {
            scenario_review:  0,
            mentorship_note:  0,
            document:         0,
            approved:         0,
        };
    });

    allExtractions.forEach(ext => {
        if (ext.reviewerId && activityByReviewer[ext.reviewerId]) {
            const type = ext.sourceType ?? 'document';
            if (activityByReviewer[ext.reviewerId][type] !== undefined) {
                activityByReviewer[ext.reviewerId][type]++;
            }
            if (ext.status === 'approved') {
                activityByReviewer[ext.reviewerId].approved++;
            }
        }
    });

    el.innerHTML = `
        <div>
            <h3 style="margin-bottom: var(--space-2);">Reviewer activity</h3>
            <p class="text-secondary text-sm mb-6">Contributions from each Reviewer — scenarios reviewed, mentorship notes, and approved recipes they helped build.</p>

            ${reviewers.map(r => {
                const activity = activityByReviewer[r.id];
                const total    = (activity.scenario_review ?? 0) + (activity.mentorship_note ?? 0);
                return `
                    <div class="card" style="margin-bottom: var(--space-4);">
                        <div class="flex-between mb-4">
                            <div>
                                <p style="font-weight: 500;">${r.displayName ?? r.email ?? 'Reviewer'}</p>
                                <p class="text-secondary text-sm mt-1">${r.roleTitle ?? ''}</p>
                            </div>
                            <span class="chip chip-${total > 0 ? 'correct' : 'pending'}">${total > 0 ? 'Active' : 'No contributions yet'}</span>
                        </div>
                        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: var(--space-4);">
                            <div>
                                <p class="text-xs text-secondary">Scenarios reviewed</p>
                                <p style="font-size: var(--text-xl); font-weight: 600; margin-top: var(--space-1);">${activity.scenario_review ?? 0}</p>
                            </div>
                            <div>
                                <p class="text-xs text-secondary">Mentorship notes</p>
                                <p style="font-size: var(--text-xl); font-weight: 600; margin-top: var(--space-1);">${activity.mentorship_note ?? 0}</p>
                            </div>
                            <div>
                                <p class="text-xs text-secondary">Recipes contributed</p>
                                <p style="font-size: var(--text-xl); font-weight: 600; margin-top: var(--space-1); color: var(--sage);">${activity.approved ?? 0}</p>
                            </div>
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

// ---------------------------------------------------------------------------
// Relative time helper — converts a Date to "2 days ago", "just now", etc.
// Used in Team Progress to show last active without exposing raw timestamps.
// ---------------------------------------------------------------------------
function _relativeTime(date) {
    const diff = Date.now() - date.getTime();
    const mins  = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days  = Math.floor(diff / 86400000);

    if (mins  <  2) return 'Just now';
    if (mins  < 60) return `${mins} minutes ago`;
    if (hours <  2) return '1 hour ago';
    if (hours < 24) return `${hours} hours ago`;
    if (days  <  2) return 'Yesterday';
    if (days  <  7) return `${days} days ago`;
    return `${Math.floor(days / 7)} week${Math.floor(days / 7) !== 1 ? 's' : ''} ago`;
}

// ---------------------------------------------------------------------------
// Loading state — shown while data is being fetched on init.
// ---------------------------------------------------------------------------
function renderLoading(container, message) {
    container.innerHTML = `
        <div class="empty-state">
            <div class="spinner"></div>
            <p class="text-secondary mt-4">${message}</p>
        </div>
    `;
}

// ---------------------------------------------------------------------------
// Populate one or more <select> elements with the org's Reviewer list.
// Called after rendering any UI that contains a Reviewer assignment dropdown.
// selectIds: array of element IDs to populate.
// ---------------------------------------------------------------------------
async function _loadReviewersForSelects(selectIds) {
    const { db: firestoreDb } = await import('../firebase.js');
    const { collection: col, query: q, where: wh, getDocs: gd } =
        await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

    try {
        const snap = await gd(
            q(col(firestoreDb, 'organisations', _orgId, 'users'), wh('role', '==', 'reviewer'))
        );
        const reviewers = snap.docs.map(d => ({
            id:   d.id,
            name: d.data().displayName ?? d.data().email ?? d.id,
        }));

        selectIds.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            reviewers.forEach(r => {
                const opt = document.createElement('option');
                opt.value       = r.id;
                opt.textContent = r.name;
                el.appendChild(opt);
            });
        });
        console.log('LORE dashboard.js: Loaded', reviewers.length, 'Reviewers into selects:', selectIds);
    } catch (err) {
        console.warn('LORE dashboard.js: Could not load Reviewers for selects.', err);
    }
}

// ---------------------------------------------------------------------------
// HTML-escape helper — prevents XSS when interpolating user-supplied data
// into innerHTML. Used on all Manager-editable fields.
// ---------------------------------------------------------------------------
function _esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}