// =============================================================================
// LORE — Dashboard View (Manager)
// The Manager's command surface. Full visibility into the knowledge base,
// extraction pipeline, domain management, and team progress.
//
// Two tabs only:
//   Knowledge Base — summary header, approved recipes, review queue,
//                    document upload with chunking progress, corpus analysis
//                    action (CORP-03), domains section (DOMAIN-02).
//   Team           — employee list with track assignment (IA-02), team
//                    progress, time to readiness, Reviewer activity.
//
// First-run state: new orgs (non-demo) land on a focused panel with only
// the document upload and a brief value statement. Normal dashboard renders
// once first content exists. Demo org always renders normally.
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
    deriveFromCorpus,
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
import { flagHighSignalResponses } from '../engine/analysis.js';

// ---------------------------------------------------------------------------
// Module-level state for this view.
// ---------------------------------------------------------------------------
let _orgId    = null;
let _uid      = null;
let _orgName  = '';
let _recipes  = [];
let _domains  = [];
let _pending  = [];
let _clusters = [];

// Which top-level tab is active: 'knowledge' | 'team'
let _activeTab = 'knowledge';

// Which sub-section within each tab is active
let _activeKnowledgeSection = 'recipes';
let _activeTeamSection      = 'progress';

// Upload state — persisted across tab switches so an in-progress or completed
// extraction is not lost when the Manager clicks to another tab and back.
let _uploadState = {
    inProgress:    false,
    docName:       '',
    docText:       '',
    result:        null,
    errorMsg:      '',
    chunkProgress: null,   // { current: N, total: N } during chunked processing
};

// ---------------------------------------------------------------------------
// Entry point — called by app.js after auth.
// ---------------------------------------------------------------------------
export async function initDashboard(orgId, uid) {
    _orgId = orgId;
    _uid   = uid;

    const container = document.getElementById('dashboard-content');
    if (!container) return;

    console.log('LORE dashboard.js: initDashboard — orgId:', orgId, 'uid:', uid);
    renderLoading(container, 'Loading your dashboard…');

    // Load org profile for org name
    await _loadOrgProfile();

    // Load data in parallel
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

    // ONBOARD-01 — First-run state.
    // Check whether this org has any content (documents or extractions).
    // If none exists and this is not the demo org, show the focused first-run panel.
    // The demo org always renders the normal dashboard — it is always pre-seeded.
    const isDemo = orgId === 'lore-demo';
    if (!isDemo) {
        const hasContent = await _checkOrgHasContent(orgId);
        if (!hasContent) {
            renderFirstRun(container);
            return;
        }
    }

    renderDashboard(container);
}

// ---------------------------------------------------------------------------
// Load the org profile to get the org name — used in invite generation
// and in the dashboard header.
// ---------------------------------------------------------------------------
async function _loadOrgProfile() {
    const { db } = await import('../firebase.js');
    const { doc, getDoc } = await import(
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );
    try {
        const snap = await getDoc(doc(db, 'organisations', _orgId, 'profile', 'data'));
        if (snap.exists()) {
            _orgName = snap.data().orgName ?? '';
        }
        console.log('LORE dashboard.js: Org profile loaded — orgName:', _orgName);
    } catch (err) {
        console.warn('LORE dashboard.js: Could not load org profile.', err);
    }
}

// ---------------------------------------------------------------------------
// Check whether the org has any existing content — documents or extractions.
// Used by the first-run gate. Returns true if any content exists, false if not.
// Limit 1 on each query — we only need to know if anything exists at all.
// ---------------------------------------------------------------------------
async function _checkOrgHasContent(orgId) {
    const { db } = await import('../firebase.js');
    const { collection, query, limit, getDocs } = await import(
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );
    try {
        const [docsSnap, extSnap] = await Promise.all([
            getDocs(query(collection(db, 'organisations', orgId, 'documents'),    limit(1))),
            getDocs(query(collection(db, 'organisations', orgId, 'extractions'),  limit(1))),
        ]);
        return !docsSnap.empty || !extSnap.empty;
    } catch (err) {
        console.warn('LORE dashboard.js: Could not check for existing content.', err);
        // Fail safe — if we cannot check, show the normal dashboard
        return true;
    }
}

// ---------------------------------------------------------------------------
// ONBOARD-01 — First-run state.
// Shown to new Managers (non-demo) who have no content yet.
// Replaces the Knowledge Base tab content area with a single focused panel:
// a two-sentence value statement and the document upload interface.
// The Team tab remains accessible — the Manager may want to invite people
// before uploading anything.
// The normal dashboard renders on the next load once content exists.
// ---------------------------------------------------------------------------
function renderFirstRun(container) {
    console.log('LORE dashboard.js: Rendering first-run state — no content yet.');

    container.innerHTML = `
        <div>
            <!-- Dashboard header -->
            <div class="flex-between mb-6">
                <div>
                    <h1>Dashboard</h1>
                    <p class="text-secondary text-sm mt-2">${_orgName || 'Your organisation'}</p>
                </div>
            </div>

            <!-- Two-tab shell — Team tab accessible even in first-run -->
            <div style="display: flex; gap: var(--space-2); margin-bottom: var(--space-6); border-bottom: 1px solid rgba(44,36,22,0.08); padding-bottom: var(--space-2);">
                <button class="btn btn-secondary dashboard-tab" id="fr-tab-knowledge"
                    style="font-size: var(--text-sm); padding: var(--space-2) var(--space-5); background: var(--ember); color: white; border: none;">
                    Knowledge Base
                </button>
                <button class="btn btn-secondary dashboard-tab" id="fr-tab-team"
                    style="font-size: var(--text-sm); padding: var(--space-2) var(--space-5);">
                    Team
                </button>
            </div>

            <!-- First-run panel — only shown in Knowledge Base tab -->
            <div id="fr-content">
                ${_renderFirstRunPanel()}
            </div>
        </div>
    `;

    document.getElementById('fr-tab-knowledge')?.addEventListener('click', () => {
        document.getElementById('fr-tab-knowledge').style.background = 'var(--ember)';
        document.getElementById('fr-tab-knowledge').style.color      = 'white';
        document.getElementById('fr-tab-knowledge').style.border     = 'none';
        document.getElementById('fr-tab-team').style.background      = '';
        document.getElementById('fr-tab-team').style.color           = '';
        document.getElementById('fr-tab-team').style.border          = '';
        document.getElementById('fr-content').innerHTML = _renderFirstRunPanel();
        _attachFirstRunUploadHandlers(container);
    });

    document.getElementById('fr-tab-team')?.addEventListener('click', () => {
        document.getElementById('fr-tab-team').style.background      = 'var(--ember)';
        document.getElementById('fr-tab-team').style.color           = 'white';
        document.getElementById('fr-tab-team').style.border          = 'none';
        document.getElementById('fr-tab-knowledge').style.background = '';
        document.getElementById('fr-tab-knowledge').style.color      = '';
        document.getElementById('fr-tab-knowledge').style.border     = '';
        const fc = document.getElementById('fr-content');
        fc.innerHTML = '';
        renderTeamSections(fc);
    });

    _attachFirstRunUploadHandlers(container);
}

function _renderFirstRunPanel() {
    // Value statement — framed around the Manager's documents, not LORE's features.
    // Copy rule: never say "knowledge base", "recipes", "extraction", "training data".
    return `
        <div style="max-width: 560px; margin: var(--space-8) auto 0;">
            <div class="card" style="margin-bottom: var(--space-6);">
                <h2 style="margin-bottom: var(--space-3);">Start with what your team already knows</h2>
                <p class="text-secondary" style="line-height: 1.7;">
                    Upload a document that captures how your team makes decisions — a retrospective,
                    a playbook, a post-mortem. LORE will find the moments of expertise inside it
                    and turn them into training scenarios for the rest of your team.
                </p>
            </div>
            ${_renderUploadForm()}
        </div>
    `;
}

function _attachFirstRunUploadHandlers(container) {
    _attachUploadHandlers(async () => {
        // Once the first document is uploaded and processed, transition to the
        // normal dashboard so the Manager can see the review queue.
        _pending = await getPendingExtractions(_orgId);
        _recipes = await getAllApprovedRecipes(_orgId);
        renderDashboard(container);
    });
}

// ---------------------------------------------------------------------------
// Render the full two-tab dashboard shell.
// ---------------------------------------------------------------------------
function renderDashboard(container) {
    container.innerHTML = `
        <div>
            <!-- Dashboard header -->
            <div class="flex-between mb-6">
                <div>
                    <h1>Dashboard</h1>
                    <p class="text-secondary text-sm mt-2">${_orgName || 'Your organisation'}</p>
                </div>
            </div>

            <!-- Two primary tabs: Knowledge Base and Team -->
            <div style="display: flex; gap: var(--space-2); margin-bottom: var(--space-6); border-bottom: 1px solid rgba(44,36,22,0.08); padding-bottom: var(--space-2);">
                <button class="btn btn-secondary dashboard-tab" id="tab-knowledge"
                    style="font-size: var(--text-sm); padding: var(--space-2) var(--space-5);">
                    Knowledge Base
                </button>
                <button class="btn btn-secondary dashboard-tab" id="tab-team"
                    style="font-size: var(--text-sm); padding: var(--space-2) var(--space-5);">
                    Team
                </button>
            </div>

            <!-- Tab content area -->
            <div id="dashboard-tab-content"></div>
        </div>
    `;

    document.getElementById('tab-knowledge')?.addEventListener('click', () => {
        _activeTab = 'knowledge';
        _setActiveTabStyle('knowledge');
        renderKnowledgeTab(document.getElementById('dashboard-tab-content'));
    });

    document.getElementById('tab-team')?.addEventListener('click', () => {
        _activeTab = 'team';
        _setActiveTabStyle('team');
        renderTeamTab(document.getElementById('dashboard-tab-content'));
    });

    // Render the active tab
    _setActiveTabStyle(_activeTab);
    const tabContent = document.getElementById('dashboard-tab-content');
    if (_activeTab === 'team') {
        renderTeamTab(tabContent);
    } else {
        renderKnowledgeTab(tabContent);
    }
}

function _setActiveTabStyle(activeId) {
    ['knowledge', 'team'].forEach(id => {
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

// =============================================================================
// KNOWLEDGE BASE TAB
// Sub-sections: recipes, queue, upload, domains
// =============================================================================

function renderKnowledgeTab(container) {
    // Summary header — recipe count, domains confirmed, pending count
    const confirmedDomains = _domains.filter(d => !d.provisional).length;
    const pendingCount     = _pending.length;

    container.innerHTML = `
        <div>
            <!-- Summary header -->
            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: var(--space-4); margin-bottom: var(--space-6);">
                <div class="card" style="text-align: center;">
                    <p class="text-xs text-secondary" style="text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: var(--space-2);">Recipes</p>
                    <p style="font-size: var(--text-2xl); font-weight: 600;">${_recipes.length}</p>
                </div>
                <div class="card" style="text-align: center;">
                    <p class="text-xs text-secondary" style="text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: var(--space-2);">Skill areas confirmed</p>
                    <p style="font-size: var(--text-2xl); font-weight: 600;">${confirmedDomains}</p>
                </div>
                <div class="card" style="text-align: center; cursor: ${pendingCount > 0 ? 'pointer' : 'default'};" id="kb-pending-card">
                    <p class="text-xs text-secondary" style="text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: var(--space-2);">Pending review</p>
                    <p style="font-size: var(--text-2xl); font-weight: 600; color: ${pendingCount > 0 ? 'var(--ember)' : 'var(--ink)'};">${pendingCount}</p>
                </div>
            </div>

            <!-- Knowledge Base sub-navigation -->
            <div style="display: flex; gap: var(--space-2); margin-bottom: var(--space-6); flex-wrap: wrap;">
                ${_kbNavTab('recipes', 'Recipes')}
                ${_kbNavTab('queue',   `Review queue${pendingCount > 0 ? ` <span class="queue-badge">${pendingCount}</span>` : ''}`)}
                ${_kbNavTab('upload',  'Add knowledge')}
                ${_kbNavTab('domains', 'Skill areas')}
            </div>

            <!-- Sub-section content -->
            <div id="kb-section-content"></div>
        </div>
    `;

    // Clicking the pending card navigates to the review queue
    document.getElementById('kb-pending-card')?.addEventListener('click', () => {
        if (pendingCount > 0) _switchKbSection('queue');
    });

    // Sub-nav handlers
    ['recipes', 'queue', 'upload', 'domains'].forEach(s => {
        document.getElementById(`kb-tab-${s}`)?.addEventListener('click', () => {
            _switchKbSection(s);
        });
    });

    _switchKbSection(_activeKnowledgeSection);
}

function _kbNavTab(id, label) {
    return `
        <button
            id="kb-tab-${id}"
            class="btn btn-secondary"
            style="font-size: var(--text-sm); padding: var(--space-2) var(--space-4);"
        >${label}</button>
    `;
}

function _switchKbSection(section) {
    _activeKnowledgeSection = section;

    // Update sub-nav active styles
    ['recipes', 'queue', 'upload', 'domains'].forEach(s => {
        const btn = document.getElementById(`kb-tab-${s}`);
        if (!btn) return;
        if (s === section) {
            btn.style.background = 'rgba(44,36,22,0.08)';
            btn.style.fontWeight = '600';
        } else {
            btn.style.background = '';
            btn.style.fontWeight = '';
        }
    });

    const el = document.getElementById('kb-section-content');
    if (!el) return;

    switch (section) {
        case 'recipes': renderKbRecipes(el);  break;
        case 'queue':   renderKbQueue(el);    break;
        case 'upload':  renderKbUpload(el);   break;
        case 'domains': renderKbDomains(el);  break;
        default:        renderKbRecipes(el);
    }
}

// ---------------------------------------------------------------------------
// KB SUB-SECTION: Recipes
// All approved recipes browsable by domain.
// ---------------------------------------------------------------------------
function renderKbRecipes(el) {
    if (_recipes.length === 0) {
        el.innerHTML = `
            <div class="empty-state">
                <h3>No recipes yet</h3>
                <p class="mt-2">Upload a document or invite a Reviewer to start building your knowledge base.</p>
                <button class="btn btn-primary mt-6" id="kb-recipes-go-upload">Upload a document</button>
            </div>
        `;
        document.getElementById('kb-recipes-go-upload')?.addEventListener('click', () => _switchKbSection('upload'));
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
                    ${recipes.map(r => _renderRecipeCard(r)).join('')}
                </div>
            `).join('')}
        </div>
    `;

    // Attach expand/collapse and send-for-review handlers
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
            const isOpen = panel.style.display !== 'none';
            panel.style.display = isOpen ? 'none' : 'block';
            if (isOpen) return;

            const reviewerSelect = document.getElementById(`review-reviewer-${r.id}`);
            const scenarioSelect = document.getElementById(`review-scenario-${r.id}`);
            const statusEl       = document.getElementById(`review-status-${r.id}`);

            const { db: firestoreDb } = await import('../firebase.js');
            const { collection: col, query: q, where: wh, getDocs: gd } =
                await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

            try {
                const usersSnap = await gd(q(col(firestoreDb, 'organisations', _orgId, 'users'), wh('role', '==', 'reviewer')));
                usersSnap.forEach(d => {
                    const opt = document.createElement('option');
                    opt.value = d.id;
                    opt.textContent = d.data().displayName ?? d.data().email ?? d.id;
                    reviewerSelect?.appendChild(opt);
                });

                const scenariosSnap = await gd(q(col(firestoreDb, 'organisations', _orgId, 'scenarios'), wh('recipeId', '==', r.id)));
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

            document.getElementById(`review-send-${r.id}`)?.addEventListener('click', async () => {
                const reviewerId = reviewerSelect?.value;
                const scenarioId = scenarioSelect?.value;
                if (!reviewerId || !scenarioId) {
                    if (statusEl) statusEl.textContent = 'Please choose a Reviewer and a scenario.';
                    return;
                }
                const btn = document.getElementById(`review-send-${r.id}`);
                btn.disabled = true; btn.textContent = 'Sending…';
                const result = await queueScenarioReview(_orgId, scenarioId, reviewerId);
                btn.disabled = false; btn.textContent = 'Send';
                if (statusEl) statusEl.textContent = result.ok
                    ? "Sent. They'll see it in their next session."
                    : result.error ?? 'Could not send. Try again.';
            });
        });
    });
}

function _renderRecipeCard(r) {
    return `
        <div class="card" style="margin-bottom: var(--space-3);">
            <div class="flex-between">
                <p style="font-weight: 500;">${r.skillName}</p>
                <div style="display: flex; gap: var(--space-2);">
                    <button class="btn btn-secondary" id="recipe-review-${r.id}"
                        style="font-size: var(--text-xs); padding: var(--space-1) var(--space-3);">
                        Send for review
                    </button>
                    <button class="btn btn-secondary" id="recipe-toggle-${r.id}"
                        style="font-size: var(--text-xs); padding: var(--space-1) var(--space-3);">
                        Show
                    </button>
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
                    <p class="label mt-4 mb-1">What less experienced people tend to do</p>
                    <p class="text-sm text-secondary">${r.flawPattern}</p>
                ` : ''}
            </div>
            <!-- Send for review panel -->
            <div id="recipe-review-panel-${r.id}" style="display: none; margin-top: var(--space-4);">
                <div class="divider" style="margin: var(--space-3) 0;"></div>
                <p class="label mb-2">Send a scenario for review</p>
                <p class="text-sm text-secondary mb-3">Choose a Reviewer and a scenario. They'll see it as a quality check — nothing else.</p>
                <select class="input mb-3" id="review-reviewer-${r.id}" style="margin-bottom: var(--space-3);">
                    <option value="">Choose a Reviewer…</option>
                </select>
                <select class="input mb-3" id="review-scenario-${r.id}" style="margin-bottom: var(--space-3);">
                    <option value="">Choose a scenario…</option>
                </select>
                <p id="review-status-${r.id}" class="text-xs text-secondary mb-2"></p>
                <button class="btn btn-primary" id="review-send-${r.id}" style="font-size: var(--text-sm);">Send</button>
            </div>
        </div>
    `;
}

// ---------------------------------------------------------------------------
// KB SUB-SECTION: Review Queue (PIPE-05)
// Cards now show: source type and provenance, raw content verbatim,
// intermediate knowledge representation (summary, situation, insight) as
// the primary review surface, draft recipe fields below as editable output.
// ---------------------------------------------------------------------------
function renderKbQueue(el) {
    if (_pending.length === 0) {
        el.innerHTML = `
            <div class="empty-state">
                <h3>Nothing to review</h3>
                <p class="mt-2">When Reviewers contribute or you upload a document, extracted knowledge will appear here for your approval.</p>
            </div>
        `;
        return;
    }

    el.innerHTML = `
        <div>
            <p class="text-secondary text-sm mb-6">${_pending.length} item${_pending.length !== 1 ? 's' : ''} waiting for your review</p>
            <div id="queue-list">
                ${_pending.map((ext, i) => _renderExtractionCard(ext, i)).join('')}
            </div>
        </div>
    `;

    _pending.forEach((ext, i) => _attachExtractionHandlers(ext, i, el));
}

function _renderExtractionCard(ext, index) {
    // PIPE-05: source type label includes provenance context
    const sourceLabels = {
        'scenario_review':  'Scenario feedback',
        'mentorship_note':  'Mentorship note',
        'document_chunk':   'Document',
        'employee_response':'Team response pattern',
    };
    const sourceLabel = sourceLabels[ext.sourceType] ?? 'Contribution';

    // Provenance line — shows what the contributor was responding to
    const provenanceLine = ext.rawPrompt
        ? `<p class="text-xs text-secondary mt-1" style="font-style: italic;">${_esc(ext.rawPrompt.slice(0, 120))}${ext.rawPrompt.length > 120 ? '…' : ''}</p>`
        : '';

    const hasKnowledge = ext.knowledge && ext.knowledge.hasKnowledge !== false && ext.knowledge.summary;
    const hasDraft     = ext.draft && ext.draft.skillName;

    return `
        <div class="card" style="margin-bottom: var(--space-6);" id="ext-card-${index}">

            <!-- Source and provenance header -->
            <div style="margin-bottom: var(--space-4);">
                <div class="flex-between">
                    <span class="chip chip-pending">${sourceLabel}</span>
                    <span class="text-xs text-secondary">${ext.wordCount ? ext.wordCount + ' words' : ''}</span>
                </div>
                ${provenanceLine}
            </div>

            <!-- Raw content — verbatim, always shown -->
            <div style="margin-bottom: var(--space-4);">
                <p class="label mb-2">What was contributed</p>
                <div style="background: rgba(44,36,22,0.04); border-radius: var(--radius-md); padding: var(--space-3) var(--space-4);">
                    <p class="text-sm" style="line-height: 1.7; color: var(--ink);">${_esc(ext.rawContent ?? 'No content available')}</p>
                </div>
            </div>

            <!-- Intermediate knowledge representation — shown when Stage 2 has run -->
            ${hasKnowledge ? `
                <div style="margin-bottom: var(--space-4); padding: var(--space-4); border: 1px solid rgba(44,36,22,0.1); border-radius: var(--radius-md); background: rgba(95,127,95,0.04);">
                    <p class="label mb-3" style="color: var(--sage);">What LORE understood</p>
                    <p class="text-xs text-secondary" style="font-weight: 600; margin-bottom: var(--space-1);">Summary</p>
                    <p class="text-sm" style="line-height: 1.6; margin-bottom: var(--space-3);">${_esc(ext.knowledge.summary ?? '')}</p>
                    <p class="text-xs text-secondary" style="font-weight: 600; margin-bottom: var(--space-1);">Situation</p>
                    <p class="text-sm" style="line-height: 1.6; margin-bottom: var(--space-3);">${_esc(ext.knowledge.situation ?? '')}</p>
                    <p class="text-xs text-secondary" style="font-weight: 600; margin-bottom: var(--space-1);">Insight</p>
                    <p class="text-sm" style="line-height: 1.6;">${_esc(ext.knowledge.insight ?? '')}</p>
                </div>
            ` : ''}

            <!-- Draft recipe fields — editable, shown when Stage 3 has run -->
            ${hasDraft ? `
                <div style="margin-bottom: var(--space-4);">
                    <p class="label mb-3">Proposed recipe — edit before approving</p>
                    <div class="auth-field">
                        <label class="label mb-1">Skill name</label>
                        <input class="input" id="draft-skill-${index}" value="${_esc(ext.draft.skillName ?? '')}" style="margin-bottom: var(--space-3);">
                    </div>
                    <div class="auth-field">
                        <label class="label mb-1">When to use it</label>
                        <textarea class="input" id="draft-trigger-${index}" rows="2" style="margin-bottom: var(--space-3); resize: vertical;">${_esc(ext.draft.trigger ?? '')}</textarea>
                    </div>
                    <div class="auth-field">
                        <label class="label mb-1">What to do</label>
                        <textarea class="input" id="draft-action-${index}" rows="3" style="margin-bottom: var(--space-3); resize: vertical;">${_esc(ext.draft.actionSequence ?? '')}</textarea>
                    </div>
                    <div class="auth-field">
                        <label class="label mb-1">What it produces</label>
                        <textarea class="input" id="draft-outcome-${index}" rows="2" style="margin-bottom: var(--space-3); resize: vertical;">${_esc(ext.draft.expectedOutcome ?? '')}</textarea>
                    </div>
                    <div class="auth-field">
                        <label class="label mb-1">Assign to skill area</label>
                        <input class="input" id="draft-domain-${index}"
                            value="${_esc(ext.knowledge?.domain ?? ext.draft.domain ?? (_domains[0]?.name ?? ''))}"
                            placeholder="Type a skill area name…">
                    </div>
                </div>
            ` : `
                <!-- No draft yet — show the raw content status and a process button -->
                <p class="text-xs text-secondary mb-3" id="process-status-${index}"></p>
            `}

            <div class="divider" style="margin: var(--space-4) 0;"></div>

            <!-- Action buttons -->
            <div style="display: flex; gap: var(--space-3);">
                ${hasDraft ? `
                    <button class="btn btn-primary" id="approve-btn-${index}" style="font-size: var(--text-sm);">
                        Add to knowledge base
                    </button>
                ` : `
                    <button class="btn btn-primary" id="process-btn-${index}" style="font-size: var(--text-sm);">
                        Extract knowledge
                    </button>
                `}
                <button class="btn btn-secondary" id="reject-btn-${index}"
                    style="font-size: var(--text-sm); color: var(--error);">
                    Dismiss
                </button>
            </div>
        </div>
    `;
}

function _attachExtractionHandlers(ext, index, el) {
    // Process button (raw → three-stage pipeline)
    document.getElementById(`process-btn-${index}`)?.addEventListener('click', async () => {
        const btn    = document.getElementById(`process-btn-${index}`);
        const status = document.getElementById(`process-status-${index}`);
        btn.disabled    = true;
        btn.textContent = 'Extracting…';
        if (status) status.textContent = 'Running extraction pipeline…';

        const result = await processExtraction(_orgId, ext.id, ext);

        if (!result.ok) {
            const reason = result.reason === 'NO_KNOWLEDGE'
                ? 'No clear expert decision logic found in this contribution.'
                : 'Could not extract at this time. Try again shortly.';
            if (status) status.textContent = reason;
            btn.disabled    = false;
            btn.textContent = 'Try again';
            return;
        }

        // Re-fetch the updated extraction and re-render the card in place
        const cardEl = document.getElementById(`ext-card-${index}`);
        if (cardEl) {
            const updatedExt = { ...ext, knowledge: result.knowledge, draft: result.draft, status: 'processed' };
            _pending[index]  = updatedExt;
            cardEl.outerHTML = _renderExtractionCard(updatedExt, index);
            _attachExtractionHandlers(updatedExt, index, el);
        }
    });

    // Approve button (draft → live recipe)
    document.getElementById(`approve-btn-${index}`)?.addEventListener('click', async () => {
        const btn = document.getElementById(`approve-btn-${index}`);
        btn.disabled    = true;
        btn.textContent = 'Saving…';

        const draft = {
            skillName:       document.getElementById(`draft-skill-${index}`)?.value?.trim()   ?? ext.draft?.skillName,
            trigger:         document.getElementById(`draft-trigger-${index}`)?.value?.trim() ?? ext.draft?.trigger,
            actionSequence:  document.getElementById(`draft-action-${index}`)?.value?.trim()  ?? ext.draft?.actionSequence,
            expectedOutcome: document.getElementById(`draft-outcome-${index}`)?.value?.trim() ?? ext.draft?.expectedOutcome,
            flawPattern:     ext.draft?.flawPattern ?? null,
        };
        const domain = document.getElementById(`draft-domain-${index}`)?.value?.trim()
            ?? (_domains[0]?.name ?? 'General');

        const recipeId = await approveRecipe(_orgId, draft, ext.id, domain);

        if (recipeId) {
            _pending.splice(index, 1);
            _recipes = await getAllApprovedRecipes(_orgId);
            // Re-render the full Knowledge Base tab to update the summary header counts
            renderKnowledgeTab(document.getElementById('dashboard-tab-content'));
        } else {
            btn.disabled    = false;
            btn.textContent = 'Add to knowledge base';
        }
    });

    // Reject button
    document.getElementById(`reject-btn-${index}`)?.addEventListener('click', async () => {
        await rejectExtraction(_orgId, ext.id);
        _pending.splice(index, 1);
        renderKbQueue(document.getElementById('kb-section-content'));
    });
}

// ---------------------------------------------------------------------------
// KB SUB-SECTION: Upload (Add knowledge)
// Document upload with chunking progress indicator (PIPE-05).
// ---------------------------------------------------------------------------
function renderKbUpload(el) {
    if (_uploadState.inProgress) {
        const progress = _uploadState.chunkProgress;
        el.innerHTML = `
            <div class="card">
                <div class="empty-state">
                    <div class="spinner"></div>
                    <p class="text-secondary mt-4">Reading <strong>${_uploadState.docName || 'your document'}</strong>…</p>
                    ${progress ? `
                        <p class="text-secondary text-sm mt-2">Processing chunk ${progress.current} of ${progress.total}</p>
                        <div class="xp-bar-track" style="width: 200px; margin: var(--space-3) auto 0;">
                            <div class="xp-bar-fill" style="width: ${Math.round((progress.current / progress.total) * 100)}%; background: var(--ember); transition: width 0.4s ease;"></div>
                        </div>
                    ` : `
                        <p class="text-secondary text-sm mt-2">This usually takes 10–20 seconds.</p>
                    `}
                </div>
            </div>
        `;
        return;
    }

    if (_uploadState.result) {
        const result = _uploadState.result;
        let resultHtml;
        if (!result.ok) {
            resultHtml = `
                <div class="card" style="border-left: 3px solid var(--error);">
                    <p style="font-weight: 500;">Could not process the document</p>
                    <p class="text-secondary text-sm mt-2">${_uploadState.errorMsg || 'Please try again shortly.'}</p>
                </div>`;
        } else if (result.extractionsCreated === 0) {
            resultHtml = `
                <div class="card" style="border-left: 3px solid var(--ember);">
                    <p style="font-weight: 500;">No clear training moments found</p>
                    <p class="text-secondary text-sm mt-2">This document does not appear to contain the kind of specific decision logic LORE looks for. Try a retrospective, post-mortem, or playbook.</p>
                </div>`;
        } else {
            resultHtml = `
                <div class="card" style="border-left: 3px solid var(--sage);">
                    <p style="font-weight: 500; color: var(--sage);">Found ${result.extractionsCreated} training moment${result.extractionsCreated !== 1 ? 's' : ''} in "${_esc(_uploadState.docName)}"</p>
                    <p class="text-secondary text-sm mt-2">They are in your review queue. Go through them and add the ones that feel right to your knowledge base.</p>
                    <div style="display: flex; gap: var(--space-3); margin-top: var(--space-4);">
                        <button class="btn btn-primary" id="go-to-queue" style="font-size: var(--text-sm);">Open review queue</button>
                        <button class="btn btn-secondary" id="upload-another" style="font-size: var(--text-sm);">Add another document</button>
                    </div>
                </div>`;
        }

        el.innerHTML = `<div style="margin-top: var(--space-2);">${resultHtml}</div>`;

        document.getElementById('go-to-queue')?.addEventListener('click', () => _switchKbSection('queue'));
        document.getElementById('upload-another')?.addEventListener('click', () => {
            _uploadState = { inProgress: false, docName: '', docText: '', result: null, errorMsg: '', chunkProgress: null };
            renderKbUpload(el);
        });
        return;
    }

    // Default: upload form
    el.innerHTML = `
        <div class="card">
            <h3 style="margin-bottom: var(--space-2);">Add a document</h3>
            <p class="text-secondary text-sm mb-6" style="line-height: 1.6;">
                Paste in any document that captures how your team makes decisions — a retrospective,
                a playbook, a post-mortem. LORE reads it and finds the decision-making moments
                that become training scenarios.
            </p>
            ${_renderUploadForm()}
        </div>
        <div id="upload-result" style="margin-top: var(--space-6);"></div>
    `;

    _attachUploadHandlers(async () => {
        _pending = await getPendingExtractions(_orgId);
        renderKnowledgeTab(document.getElementById('dashboard-tab-content'));
    });
}

// Shared upload form markup — used in both first-run and normal upload sections.
function _renderUploadForm() {
    return `
        <div class="auth-field">
            <label class="label" for="doc-name">Document name</label>
            <input class="input" id="doc-name" type="text"
                placeholder="e.g. Q3 Project Retrospective"
                value="${_esc(_uploadState.docName)}">
        </div>
        <div class="auth-field mt-4">
            <label class="label" for="doc-text">Document content</label>
            <textarea class="input" id="doc-text" rows="12"
                placeholder="Paste the document text here…"
                style="resize: vertical;">${_esc(_uploadState.docText)}</textarea>
        </div>
        <button class="btn btn-primary mt-4" id="process-doc">Find training moments</button>
        <div id="upload-result" style="margin-top: var(--space-4);"></div>
    `;
}

// Shared upload handler — onComplete is called after a successful upload.
function _attachUploadHandlers(onComplete) {
    document.getElementById('doc-name')?.addEventListener('input', e => { _uploadState.docName = e.target.value; });
    document.getElementById('doc-text')?.addEventListener('input', e => { _uploadState.docText = e.target.value; });

    document.getElementById('process-doc')?.addEventListener('click', async () => {
        const name = document.getElementById('doc-name')?.value?.trim();
        const text = document.getElementById('doc-text')?.value?.trim();

        if (!name || !text) {
            const resultEl = document.getElementById('upload-result');
            if (resultEl) resultEl.innerHTML = '<p class="text-secondary text-sm" style="color: var(--error);">Please enter a document name and paste the content.</p>';
            return;
        }

        _uploadState.inProgress    = true;
        _uploadState.docName       = name;
        _uploadState.docText       = text;
        _uploadState.result        = null;
        _uploadState.errorMsg      = '';
        _uploadState.chunkProgress = null;

        const btn = document.getElementById('process-doc');
        if (btn) { btn.disabled = true; btn.textContent = 'Reading…'; }

        // Re-render the upload section to show the in-progress spinner
        const kbContent = document.getElementById('kb-section-content');
        if (kbContent) renderKbUpload(kbContent);

        // Progress callback — updates chunkProgress and re-renders the spinner
        const onProgress = (current, total) => {
            _uploadState.chunkProgress = { current, total };
            const kbEl = document.getElementById('kb-section-content');
            if (kbEl && _activeKnowledgeSection === 'upload') renderKbUpload(kbEl);
        };

        // processDocument now accepts uid and an onProgress callback
        const result = await processDocument(_orgId, _uid, text, name, onProgress);

        _uploadState.inProgress    = false;
        _uploadState.chunkProgress = null;
        _uploadState.result        = result;
        if (!result.ok) _uploadState.errorMsg = 'Could not process the document right now. Please try again shortly.';

        if (result.ok && result.extractionsCreated > 0) {
            await onComplete();
        }

        const kbEl = document.getElementById('kb-section-content');
        if (kbEl && _activeKnowledgeSection === 'upload') renderKbUpload(kbEl);
    });
}

// ---------------------------------------------------------------------------
// KB SUB-SECTION: Domains (DOMAIN-02)
// "Create a skill area" (manual) always shown first.
// "Suggest skill areas from recipes" (AI clustering) shown only when
// recipe count >= 3.
// Provisional seeds shown as dismissible chips.
// ---------------------------------------------------------------------------
function renderKbDomains(el) {
    const confirmed   = _domains.filter(d => !d.provisional);
    const provisional = _domains.filter(d =>  d.provisional);
    const canCluster  = _recipes.length >= 3;

    // Check whether there are flagged responses to show the corpus analysis action
    _checkFlaggedResponses().then(hasFlagged => {
        const corpusBtn = document.getElementById('corpus-analysis-btn');
        if (corpusBtn) corpusBtn.style.display = hasFlagged ? 'block' : 'none';
    });

    el.innerHTML = `
        <div>
            <!-- CORP-03: Corpus analysis action — shown only when flagged responses exist -->
            <div id="corpus-analysis-section" style="margin-bottom: var(--space-6); display: none;">
                <div class="card" style="border-left: 3px solid var(--ember);">
                    <p style="font-weight: 500;">New patterns found in team responses</p>
                    <p class="text-secondary text-sm mt-2 mb-4">LORE has found response patterns from your senior team members that may contain useful knowledge. Run the analysis to extract them into your review queue.</p>
                    <button class="btn btn-primary" id="corpus-analysis-btn" style="font-size: var(--text-sm);">
                        Find patterns in team responses
                    </button>
                    <p id="corpus-status" class="text-xs text-secondary mt-3"></p>
                </div>
            </div>

            <!-- Manual domain creation — always first -->
            <div class="card" style="margin-bottom: var(--space-6);">
                <h3 style="margin-bottom: var(--space-2);">Create a skill area</h3>
                <p class="text-secondary text-sm mb-4">Name a skill area that matters to your organisation. You can always rename it later.</p>
                <div class="auth-field">
                    <label class="label mb-1">Skill area name</label>
                    <input class="input" id="new-domain-name" type="text" placeholder="e.g. Client Engagement" style="margin-bottom: var(--space-3);">
                </div>
                <div class="auth-field">
                    <label class="label mb-1">Description (optional)</label>
                    <input class="input" id="new-domain-desc" type="text" placeholder="One sentence describing this skill area…">
                </div>
                <p id="new-domain-error" class="text-xs" style="color: var(--error); margin-top: var(--space-2); display: none;"></p>
                <button class="btn btn-primary mt-4" id="create-domain-btn" style="font-size: var(--text-sm);">
                    Create skill area
                </button>
            </div>

            <!-- AI clustering — shown only when recipe count >= 3 (DOMAIN-02) -->
            ${canCluster ? `
                <div class="card" style="margin-bottom: var(--space-6);">
                    <h3 style="margin-bottom: var(--space-2);">Suggest skill areas from recipes</h3>
                    <p class="text-secondary text-sm mb-4">LORE can group your ${_recipes.length} recipes into suggested skill areas. You confirm, rename, or adjust them.</p>
                    ${_clusters.length > 0 ? _renderProposedClusters() : `
                        <button class="btn btn-secondary" id="run-clustering" style="font-size: var(--text-sm);">
                            Suggest skill areas
                        </button>
                    `}
                </div>
            ` : ''}

            <!-- Confirmed skill areas -->
            ${confirmed.length > 0 ? `
                <div style="margin-bottom: var(--space-6);">
                    <h3 style="margin-bottom: var(--space-4);">Your skill areas</h3>
                    ${confirmed.map(d => `
                        <div class="card" style="margin-bottom: var(--space-3);">
                            <div class="flex-between">
                                <div>
                                    <p style="font-weight: 500;">${_esc(d.name)}</p>
                                    <p class="text-secondary text-sm mt-1">${_esc(d.description ?? '')}</p>
                                </div>
                                <p class="text-xs text-secondary">${(d.recipeIds ?? []).length} recipe${(d.recipeIds ?? []).length !== 1 ? 's' : ''}</p>
                            </div>
                        </div>
                    `).join('')}
                </div>
            ` : ''}

            <!-- Provisional seed domains — dismissible -->
            ${provisional.length > 0 ? `
                <div>
                    <h3 style="margin-bottom: var(--space-2);">Starting points</h3>
                    <p class="text-secondary text-sm mb-4">Provisional skill areas based on your industry. Dismiss any that don't apply — LORE will replace them with your organisation's own as knowledge builds.</p>
                    ${provisional.map(d => `
                        <div class="card" style="margin-bottom: var(--space-3); opacity: 0.75;">
                            <div class="flex-between">
                                <div>
                                    <p style="font-weight: 500; color: var(--warm-grey);">${_esc(d.name)}</p>
                                    <span class="chip chip-pending" style="margin-top: var(--space-1); font-size: 10px;">Provisional</span>
                                </div>
                                <button class="btn btn-secondary" id="dismiss-provisional-${d.id}"
                                    style="font-size: var(--text-xs); padding: var(--space-1) var(--space-3); color: var(--warm-grey);">
                                    Dismiss
                                </button>
                            </div>
                        </div>
                    `).join('')}
                </div>
            ` : ''}
        </div>
    `;

    // Show corpus analysis section if there are flagged responses
    _checkFlaggedResponses().then(hasFlagged => {
        const section = document.getElementById('corpus-analysis-section');
        if (section) section.style.display = hasFlagged ? 'block' : 'none';
    });

    // Create domain handler
    document.getElementById('create-domain-btn')?.addEventListener('click', async () => {
        const name  = document.getElementById('new-domain-name')?.value?.trim();
        const desc  = document.getElementById('new-domain-desc')?.value?.trim();
        const errEl = document.getElementById('new-domain-error');

        if (!name) {
            errEl.textContent   = 'Please enter a name for the skill area.';
            errEl.style.display = 'block';
            return;
        }
        errEl.style.display = 'none';

        const btn = document.getElementById('create-domain-btn');
        btn.disabled    = true;
        btn.textContent = 'Creating…';

        const newId = await confirmDomain(_orgId, { name, description: desc ?? '', recipeIds: [], reviewerIds: [] });
        if (newId) {
            _domains = await getDomains(_orgId);
            renderKbDomains(el);
        } else {
            btn.disabled    = false;
            btn.textContent = 'Create skill area';
            errEl.textContent   = 'Could not create the skill area. Please try again.';
            errEl.style.display = 'block';
        }
    });

    // AI clustering handler
    document.getElementById('run-clustering')?.addEventListener('click', async () => {
        const btn = document.getElementById('run-clustering');
        btn.disabled    = true;
        btn.textContent = 'Grouping…';
        const result = await triggerClustering(_orgId, _recipes);
        if (result.ok && result.clusters.length > 0) {
            _clusters = result.clusters;
            renderKbDomains(el);
        } else {
            btn.disabled    = false;
            btn.textContent = 'Suggest skill areas';
        }
    });

    // Corpus analysis handler
    document.getElementById('corpus-analysis-btn')?.addEventListener('click', async () => {
        const btn    = document.getElementById('corpus-analysis-btn');
        const status = document.getElementById('corpus-status');
        btn.disabled    = true;
        btn.textContent = 'Analysing…';
        if (status) status.textContent = 'Looking for patterns in team responses…';

        // Step 1: Flag high-signal responses (senior-correct on junior-missed scenarios).
        // This must run before deriveFromCorpus so there is something flagged to process.
        await flagHighSignalResponses(_orgId);

        // Step 2: Derive extractions from all flagged responses across all domains.
        const result = await deriveFromCorpus(_orgId, null);
        btn.disabled    = false;
        btn.textContent = 'Find patterns in team responses';

        if (status) {
            status.textContent = result.ok && result.extractionsCreated > 0
                ? `Found ${result.extractionsCreated} pattern${result.extractionsCreated !== 1 ? 's' : ''} — check your review queue.`
                : result.ok
                ? 'No new patterns found at this time.'
                : 'Could not complete the analysis. Try again shortly.';
        }

        if (result.ok && result.extractionsCreated > 0) {
            _pending = await getPendingExtractions(_orgId);
        }
    });

    // Dismiss provisional domain handlers
    provisional.forEach(d => {
        document.getElementById(`dismiss-provisional-${d.id}`)?.addEventListener('click', async () => {
            await deleteDomain(_orgId, d.id);
            _domains = _domains.filter(x => x.id !== d.id);
            renderKbDomains(el);
        });
    });

    // Confirm proposed cluster handlers
    _clusters.forEach((cluster, i) => {
        document.getElementById(`confirm-cluster-${i}`)?.addEventListener('click', async () => {
            const name = document.getElementById(`cluster-name-${i}`)?.value?.trim();
            const desc = document.getElementById(`cluster-desc-${i}`)?.value?.trim();
            if (!name) return;

            const btn = document.getElementById(`confirm-cluster-${i}`);
            btn.disabled    = true;
            btn.textContent = 'Confirming…';

            await confirmDomain(_orgId, { ...cluster, name, description: desc });
            _domains = await getDomains(_orgId);
            _clusters.splice(i, 1);
            if (_clusters.length === 0) clearPendingClusters(_orgId);
            renderKbDomains(el);
        });

        document.getElementById(`dismiss-cluster-${i}`)?.addEventListener('click', () => {
            _clusters.splice(i, 1);
            if (_clusters.length === 0) clearPendingClusters(_orgId);
            renderKbDomains(el);
        });
    });
}

function _renderProposedClusters() {
    return `
        <div>
            <p class="text-secondary text-sm mb-4">Based on your recipes, LORE suggests these groupings. Edit the names, then confirm.</p>
            ${_clusters.map((cluster, i) => `
                <div style="border: 1px solid rgba(44,36,22,0.1); border-radius: var(--radius-md); padding: var(--space-4); margin-bottom: var(--space-4);">
                    <div class="auth-field">
                        <label class="label mb-1">Skill area name</label>
                        <input class="input" id="cluster-name-${i}" value="${_esc(cluster.name ?? '')}" style="margin-bottom: var(--space-2);">
                    </div>
                    <div class="auth-field">
                        <label class="label mb-1">Description</label>
                        <input class="input" id="cluster-desc-${i}" value="${_esc(cluster.description ?? '')}" placeholder="One sentence…">
                    </div>
                    <p class="text-xs text-secondary mt-3 mb-3">${(cluster.recipeIds ?? []).length} recipe${(cluster.recipeIds ?? []).length !== 1 ? 's' : ''}</p>
                    <div style="display: flex; gap: var(--space-3);">
                        <button class="btn btn-primary" id="confirm-cluster-${i}" style="font-size: var(--text-sm);">Confirm</button>
                        <button class="btn btn-secondary" id="dismiss-cluster-${i}" style="font-size: var(--text-sm);">Dismiss</button>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

// Check whether any unflagged responses exist to determine whether to show
// the corpus analysis action. Returns a boolean.
async function _checkFlaggedResponses() {
    const { db } = await import('../firebase.js');
    const { collection, query, where, limit, getDocs } = await import(
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );
    try {
        const snap = await getDocs(query(
            collection(db, 'organisations', _orgId, 'responses'),
            where('flaggedForExtraction', '==', true),
            limit(1)
        ));
        return !snap.empty;
    } catch {
        return false;
    }
}


// =============================================================================
// TEAM TAB
// Sub-sections: employee list with track assignment, team progress,
// time to readiness, Reviewer activity.
// =============================================================================

function renderTeamTab(container) {
    container.innerHTML = `
        <div>
            <!-- Team sub-navigation -->
            <div style="display: flex; gap: var(--space-2); margin-bottom: var(--space-6); flex-wrap: wrap;">
                ${_teamNavTab('members',  'Team members')}
                ${_teamNavTab('progress', 'Team progress')}
                ${_teamNavTab('ttc',      'Time to readiness')}
                ${_teamNavTab('reviewer', 'Reviewer activity')}
            </div>
            <div id="team-section-content"></div>
        </div>
    `;

    ['members', 'progress', 'ttc', 'reviewer'].forEach(s => {
        document.getElementById(`team-tab-${s}`)?.addEventListener('click', () => _switchTeamSection(s));
    });

    _switchTeamSection(_activeTeamSection);
}

// Shared helper used by renderFirstRun when the Team tab is clicked.
function renderTeamSections(container) {
    renderTeamTab(container);
}

function _teamNavTab(id, label) {
    return `
        <button id="team-tab-${id}" class="btn btn-secondary"
            style="font-size: var(--text-sm); padding: var(--space-2) var(--space-4);">
            ${label}
        </button>
    `;
}

function _switchTeamSection(section) {
    _activeTeamSection = section;

    ['members', 'progress', 'ttc', 'reviewer'].forEach(s => {
        const btn = document.getElementById(`team-tab-${s}`);
        if (!btn) return;
        if (s === section) {
            btn.style.background = 'rgba(44,36,22,0.08)';
            btn.style.fontWeight = '600';
        } else {
            btn.style.background = '';
            btn.style.fontWeight = '';
        }
    });

    const el = document.getElementById('team-section-content');
    if (!el) return;

    switch (section) {
        case 'members':  renderTeamMembers(el);        break;
        case 'progress': renderTeamProgress(el);       break;
        case 'ttc':      renderTimeToReadiness(el);    break;
        case 'reviewer': renderReviewerActivity(el);   break;
        default:         renderTeamMembers(el);
    }
}

// ---------------------------------------------------------------------------
// TEAM SUB-SECTION: Members
// Employee and Reviewer list. Invite form. Per-employee track assignment (IA-02).
// ---------------------------------------------------------------------------
function renderTeamMembers(el) {
    el.innerHTML = `
        <div>
            <div class="flex-between mb-6">
                <h3>Team members</h3>
                <button class="btn btn-primary" id="show-invite-form" style="font-size: var(--text-sm);">
                    Invite someone
                </button>
            </div>

            <div id="invite-form-container" style="display: none; margin-bottom: var(--space-6);">
                ${_renderInviteForm()}
            </div>

            <div id="team-list">
                <p class="text-secondary text-sm">Loading team…</p>
            </div>
        </div>
    `;

    document.getElementById('show-invite-form')?.addEventListener('click', () => {
        const form = document.getElementById('invite-form-container');
        if (form) form.style.display = form.style.display === 'none' ? 'block' : 'none';
    });

    _attachInviteFormHandlers();
    _loadTeamList(el);
}

function _renderInviteForm() {
    return `
        <div class="card" style="border-left: 3px solid var(--ember);">
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
        const emailPat  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!name) {
            errorEl.textContent = 'Please enter their name.'; errorEl.style.display = 'block'; return;
        }
        if (!email || !emailPat.test(email)) {
            errorEl.textContent = 'Please enter a valid email address.'; errorEl.style.display = 'block'; return;
        }

        errorEl.style.display  = 'none';
        resultEl.style.display = 'none';

        const btn = document.getElementById('generate-invite');
        btn.disabled = true; btn.textContent = 'Generating…';

        const result = await generateInvite(_orgId, _uid, {
            email, role, roleTitle: title, seniority, orgName: _orgName, displayName: name,
        });

        btn.disabled = false; btn.textContent = 'Generate invite link';

        if (!result.ok) {
            errorEl.textContent   = result.error ?? 'Something went wrong. Please try again.';
            errorEl.style.display = 'block';
            return;
        }

        resultEl.style.display = 'block';
        resultEl.innerHTML = `
            <div class="card" style="border-left: 3px solid var(--sage);">
                <p style="font-weight: 500; color: var(--sage); margin-bottom: var(--space-2);">Invite link ready</p>
                <p class="text-secondary text-sm mb-3">Copy this link and send it to ${_esc(name)}. It expires in 7 days.</p>
                <div style="display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap;">
                    <input class="input" id="invite-url-display" value="${result.inviteUrl}" readonly style="flex: 1; font-size: var(--text-sm);">
                    <button class="btn btn-secondary" id="copy-link" style="font-size: var(--text-sm);">Copy</button>
                </div>
            </div>
        `;

        document.getElementById('copy-link')?.addEventListener('click', () => {
            navigator.clipboard.writeText(result.inviteUrl).then(() => {
                document.getElementById('copy-link').textContent = 'Copied';
            });
        });
    });
}

async function _loadTeamList(parentEl) {
    const { db } = await import('../firebase.js');
    const { collection, getDocs } = await import(
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );

    const listEl = document.getElementById('team-list');
    if (!listEl) return;

    try {
        const snap  = await getDocs(collection(db, 'organisations', _orgId, 'users'));
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
                        <p style="font-weight: 500;">${_esc(u.displayName ?? u.email ?? 'Team member')}</p>
                        <p class="text-secondary text-sm mt-1">${_esc(u.roleTitle ?? u.role ?? '')}</p>
                    </div>
                    <div style="display: flex; gap: var(--space-2); align-items: center;">
                        <span class="chip chip-correct" style="font-size: var(--text-xs);">${u.role ?? 'employee'}</span>
                        ${u.role === 'employee' ? `
                            <button class="btn btn-secondary" id="track-btn-${u.id}"
                                style="font-size: var(--text-xs); padding: var(--space-1) var(--space-3);">
                                Manage track
                            </button>
                        ` : ''}
                    </div>
                </div>
                <!-- IA-02: Track assignment panel — shown when Manager clicks "Manage track" -->
                <div id="track-panel-${u.id}" style="display: none; margin-top: var(--space-4);">
                    <div class="divider" style="margin: var(--space-3) 0;"></div>
                    <p class="label mb-2">Assigned skill areas</p>
                    <p class="text-secondary text-sm mb-3">Select the skill areas this employee should train in.</p>
                    <div id="track-domains-${u.id}" style="display: flex; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-4);">
                        ${_domains.map(d => `
                            <label style="display: flex; align-items: center; gap: var(--space-2); cursor: pointer;">
                                <input type="checkbox" value="${d.id}" data-name="${_esc(d.name)}"
                                    class="track-domain-check-${u.id}"
                                    ${(u.assignedDomains ?? []).includes(d.id) ? 'checked' : ''}>
                                <span class="text-sm">${_esc(d.name)}</span>
                            </label>
                        `).join('')}
                        ${_domains.length === 0 ? '<p class="text-secondary text-sm">No skill areas confirmed yet.</p>' : ''}
                    </div>
                    <p class="label mb-2">Handover package (optional)</p>
                    <p class="text-secondary text-sm mb-2">If this employee is taking over from someone, note their name here so LORE can contextualise the training.</p>
                    <input class="input" id="handover-from-${u.id}" type="text"
                        placeholder="e.g. Amaka Obi"
                        value="${_esc(u.handoverFrom?.name ?? '')}">
                    <p id="track-status-${u.id}" class="text-xs text-secondary mt-3"></p>
                    <button class="btn btn-primary mt-4" id="save-track-${u.id}" style="font-size: var(--text-sm);">
                        Save track
                    </button>
                </div>
            </div>
        `).join('');

        // Attach track panel toggle and save handlers for each employee
        users.filter(u => u.role === 'employee').forEach(u => {
            document.getElementById(`track-btn-${u.id}`)?.addEventListener('click', () => {
                const panel = document.getElementById(`track-panel-${u.id}`);
                if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
            });

            document.getElementById(`save-track-${u.id}`)?.addEventListener('click', async () => {
                const btn      = document.getElementById(`save-track-${u.id}`);
                const statusEl = document.getElementById(`track-status-${u.id}`);
                btn.disabled    = true;
                btn.textContent = 'Saving…';

                // Collect selected domain IDs
                const checkedBoxes = document.querySelectorAll(`.track-domain-check-${u.id}:checked`);
                const assignedDomains = Array.from(checkedBoxes).map(cb => cb.value);

                // Handover field
                const handoverName = document.getElementById(`handover-from-${u.id}`)?.value?.trim();
                const handoverFrom = handoverName ? { name: handoverName } : {};

                const { db: _db } = await import('../firebase.js');
                const { doc, updateDoc } = await import(
                    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
                );

                try {
                    await updateDoc(doc(_db, 'organisations', _orgId, 'users', u.id), {
                        assignedDomains,
                        handoverFrom,
                    });
                    if (statusEl) statusEl.textContent = 'Track saved.';
                    console.log('LORE dashboard.js: Track saved for uid:', u.id, 'domains:', assignedDomains);
                } catch (err) {
                    console.warn('LORE dashboard.js: Could not save track for uid:', u.id, err);
                    if (statusEl) statusEl.textContent = 'Could not save. Please try again.';
                }

                btn.disabled    = false;
                btn.textContent = 'Save track';
            });
        });

    } catch (err) {
        console.warn('LORE dashboard.js: Could not load team list.', err);
        listEl.innerHTML = '<p class="text-secondary text-sm">Could not load team list.</p>';
    }
}

// ---------------------------------------------------------------------------
// TEAM SUB-SECTION: Team Progress
// ---------------------------------------------------------------------------
async function renderTeamProgress(el) {
    el.innerHTML = `
        <div class="empty-state">
            <div class="spinner"></div>
            <p class="text-secondary mt-4">Loading team progress…</p>
        </div>
    `;

    const { db: firestoreDb } = await import('../firebase.js');
    const { collection: col, getDocs: gd } = await import(
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );

    let employees = [];
    try {
        const snap = await gd(col(firestoreDb, 'organisations', _orgId, 'users'));
        employees  = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(u => u.role === 'employee');
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
        document.getElementById('progress-go-invite')?.addEventListener('click', () => _switchTeamSection('members'));
        return;
    }

    employees.sort((a, b) => {
        if (!a.lastTrainedAt && !b.lastTrainedAt) return 0;
        if (!a.lastTrainedAt) return 1;
        if (!b.lastTrainedAt) return -1;
        const ts = v => v?.toDate ? v.toDate() : new Date(v);
        return ts(b.lastTrainedAt) - ts(a.lastTrainedAt);
    });

    const { getRankForXP } = await import('../engine/utils.js');

    function overallMastery(mastery) {
        const domains = Object.values(mastery ?? {});
        if (domains.length === 0) return null;
        const total   = domains.reduce((s, d) => s + (d.played   ?? 0), 0);
        const correct = domains.reduce((s, d) => s + (d.correct  ?? 0), 0);
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
                const toDate = v => v?.toDate ? v.toDate() : (v ? new Date(v) : null);
                const lastDate   = toDate(emp.lastTrainedAt);
                const lastActive = lastDate ? _relativeTime(lastDate) : 'Never trained';
                const isStale    = lastDate ? (Date.now() - lastDate.getTime()) > 7 * 24 * 60 * 60 * 1000 : true;

                return `
                    <div class="card" style="margin-bottom: var(--space-3); cursor: pointer;" id="emp-row-${emp.id}">
                        <div class="flex-between">
                            <div style="flex: 1;">
                                <div class="flex-between">
                                    <p style="font-weight: 500;">${_esc(emp.displayName ?? emp.email ?? 'Team member')}</p>
                                    <span class="rank-badge" style="font-size: 10px;">${rank.name}</span>
                                </div>
                                <p class="text-secondary text-sm mt-1">${_esc(emp.roleTitle ?? '')}</p>
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

    employees.forEach(emp => {
        document.getElementById(`emp-row-${emp.id}`)?.addEventListener('click', () => {
            window.location.href = `${window.location.pathname}?employee=${emp.id}`;
        });
    });
}

// ---------------------------------------------------------------------------
// TEAM SUB-SECTION: Time to Readiness
// ---------------------------------------------------------------------------
async function renderTimeToReadiness(el) {
    el.innerHTML = `
        <div class="empty-state">
            <div class="spinner"></div>
            <p class="text-secondary mt-4">Loading…</p>
        </div>
    `;

    const { db: firestoreDb } = await import('../firebase.js');
    const { collection: col, getDocs: gd } = await import(
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );

    let employees = [];
    try {
        const snap = await gd(col(firestoreDb, 'organisations', _orgId, 'users'));
        employees  = snap.docs.map(d => ({ id: d.id, ...d.data() }))
            .filter(u => u.role === 'employee' && (u.sessionsTotal ?? 0) > 0);
    } catch (err) {
        console.warn('LORE dashboard.js: Could not load employees for time to readiness.', err);
    }

    if (employees.length === 0) {
        el.innerHTML = `
            <div class="empty-state">
                <h3>No training data yet</h3>
                <p class="mt-2">Progress narratives appear once Employees have completed their first sessions.</p>
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
                            <p style="font-weight: 500;">${_esc(emp.displayName ?? 'Team member')}</p>
                            <p class="text-secondary text-sm">${_esc(emp.roleTitle ?? '')} · ${emp.sessionsTotal ?? 0} sessions</p>
                        </div>
                        <button class="btn btn-secondary" id="ttc-gen-${i}"
                            style="font-size: var(--text-xs); padding: var(--space-1) var(--space-3);">
                            Generate
                        </button>
                    </div>
                    <p id="ttc-text-${i}" class="text-secondary text-sm" style="line-height: 1.8;">
                        Click Generate to see a progress narrative for ${_esc(emp.displayName ?? 'this team member')}.
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
// TEAM SUB-SECTION: Reviewer Activity
// ---------------------------------------------------------------------------
async function renderReviewerActivity(el) {
    el.innerHTML = `
        <div class="empty-state">
            <div class="spinner"></div>
            <p class="text-secondary mt-4">Loading…</p>
        </div>
    `;

    const { db: firestoreDb } = await import('../firebase.js');
    const { collection: col, query: q, where: wh, getDocs: gd } = await import(
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );

    let reviewers      = [];
    let allExtractions = [];
    try {
        const [reviewerSnap, extractionSnap] = await Promise.all([
            gd(q(col(firestoreDb, 'organisations', _orgId, 'users'), wh('role', '==', 'reviewer'))),
            gd(col(firestoreDb, 'organisations', _orgId, 'extractions')),
        ]);
        reviewers      = reviewerSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        allExtractions = extractionSnap.docs.map(d => ({ id: d.id, ...d.data() }));
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
        document.getElementById('reviewer-go-invite')?.addEventListener('click', () => _switchTeamSection('members'));
        return;
    }

    const activityByReviewer = {};
    reviewers.forEach(r => {
        activityByReviewer[r.id] = { scenario_review: 0, mentorship_note: 0, document_chunk: 0, approved: 0 };
    });

    allExtractions.forEach(ext => {
        if (ext.reviewerId && activityByReviewer[ext.reviewerId]) {
            const type = ext.sourceType ?? 'document_chunk';
            if (activityByReviewer[ext.reviewerId][type] !== undefined) {
                activityByReviewer[ext.reviewerId][type]++;
            }
            if (ext.status === 'approved') activityByReviewer[ext.reviewerId].approved++;
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
                                <p style="font-weight: 500;">${_esc(r.displayName ?? r.email ?? 'Reviewer')}</p>
                                <p class="text-secondary text-sm mt-1">${_esc(r.roleTitle ?? '')}</p>
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


// =============================================================================
// SHARED HELPERS
// =============================================================================

function renderLoading(container, message) {
    container.innerHTML = `
        <div class="empty-state">
            <div class="spinner"></div>
            <p class="text-secondary mt-4">${message}</p>
        </div>
    `;
}

function _relativeTime(date) {
    const diff  = Date.now() - date.getTime();
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

// HTML-escape helper — prevents XSS when interpolating user-supplied data into innerHTML.
function _esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}