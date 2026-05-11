// =============================================================================
// LORE — Dashboard View (Manager)
// The Manager's command surface. Full visibility into the knowledge base,
// extraction pipeline, domain management, and team progress.
//
// Two tabs only:
//   Knowledge Base — summary header, four sub-sections:
//                    Add knowledge (default) — upload form and corpus analysis.
//                    Review queue            — pending extractions to approve/reject.
//                    Recipes                 — approved recipes browsable by domain.
//                    Skill areas             — domain management (DOMAIN-02).
//   Team           — employee list with track assignment (IA-02), team
//                    progress, time to readiness, Reviewer activity.
//
// Knowledge Base sub-nav order and defaults:
//   Add knowledge (default) | Review queue | Recipes | Skill areas
//   The review queue is now its own sub-section so the Manager can reach it
//   directly from the "To review" stat card without scrolling past the upload form.
//
// First-run state: new orgs (non-demo) land on a focused panel with only
// the document upload and a brief value statement. Normal dashboard renders
// once first content exists.
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
import { queueScenarioReview, queueRecipeReview } from '../engine/scenarios.js';
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

// Unsubscribe handle for the team list onSnapshot listener.
// Called when the tab navigates away so the listener does not keep firing
// against a DOM that no longer exists.
let _teamListUnsub = null;

// Which sub-section within the Knowledge Base tab is active.
// Default is 'upload' — the upload-first principle means the Manager always
// lands on the Add knowledge section, not the recipe list.
// 'upload' | 'queue' | 'recipes' | 'domains'
let _activeKnowledgeSection = 'upload';

// Which sub-section within the Team tab is active.
// 'members' | 'progress' | 'ttc' | 'reviewer'
let _activeTeamSection = 'progress';

// Upload state — persisted across tab switches so an in-progress or completed
// extraction is not lost when the Manager clicks to another tab and back.
let _uploadState = {
    inProgress:    false,
    docName:       '',
    docText:       '',
    result:        null,
    errorMsg:      '',
    chunkProgress: null,   // { current: N, total: N } during chunked processing
    partial:       false,  // true if Gemini returned partial content (MAX_TOKENS hit)
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
            getDocs(query(collection(db, 'organisations', orgId, 'documents'),   limit(1))),
            getDocs(query(collection(db, 'organisations', orgId, 'extractions'), limit(1))),
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
        // Unsubscribe the team list listener before switching away — the DOM
        // nodes it would update are about to be replaced.
        if (_teamListUnsub) { _teamListUnsub(); _teamListUnsub = null; }
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
//
// Three sub-sections, in this order:
//   Add knowledge (default) — upload form + inline review queue + corpus analysis
//   Recipes                 — approved recipes browsable by domain
//   Skill areas             — domain management
//
// The review queue is not a separate tab. It lives below the upload form in
// Add knowledge so the Manager sees pending extractions immediately after upload
// without having to navigate away. This reinforces the upload → review → approve
// flow as a single continuous action.
// =============================================================================

function renderKnowledgeTab(container) {
    // Summary header — recipe count, domains confirmed, pending count
    const confirmedDomains = _domains.filter(d => !d.provisional).length;
    const pendingCount     = _pending.length;

    container.innerHTML = `
        <div>
            <!-- Summary header — compact stat row, all three cards identical height.
                 All three are clickable — Recipes and Skill areas jump to their sub-nav,
                 To review jumps to Add knowledge where the queue lives.
                 stat-card class centres content vertically (style.css). -->
            <div style="display: flex; gap: var(--space-3); margin-bottom: var(--space-6); flex-wrap: wrap;">
                <div class="card stat-card" id="kb-recipes-card" style="text-align:center;padding:12px 20px!important;min-width:120px;flex:1;max-width:200px;cursor:pointer;">
                    <p class="text-xs text-secondary" style="text-transform:uppercase;letter-spacing:0.07em;margin-bottom:var(--space-2);">Recipes</p>
                    <p style="font-size:var(--text-xl);font-weight:700;line-height:1;">${_recipes.length}</p>
                </div>
                <div class="card stat-card" id="kb-domains-card" style="text-align:center;padding:12px 20px!important;min-width:120px;flex:1;max-width:200px;cursor:pointer;margin-top:0;">
                    <p class="text-xs text-secondary" style="text-transform:uppercase;letter-spacing:0.07em;margin-bottom:var(--space-2);">Skill areas</p>
                    <p style="font-size:var(--text-xl);font-weight:700;line-height:1;">${confirmedDomains}</p>
                </div>
                <div class="card stat-card" id="kb-pending-card" style="text-align:center;padding:12px 20px!important;min-width:120px;flex:1;max-width:200px;cursor:pointer;margin-top:0;border-color:${pendingCount > 0 ? 'rgba(180,80,30,0.25)' : 'rgba(44,36,22,0.08)'};">
                    <p class="text-xs text-secondary" style="text-transform:uppercase;letter-spacing:0.07em;margin-bottom:var(--space-2);">To review</p>
                    <p style="font-size:var(--text-xl);font-weight:700;line-height:1;color:${pendingCount > 0 ? 'var(--ember)' : 'var(--ink)'};">${pendingCount}</p>
                </div>
            </div>

            <!-- Knowledge Base sub-navigation — compact pill strip -->
            <div style="
                display: flex;
                gap: var(--space-1);
                margin-bottom: var(--space-6);
                border-bottom: 1px solid rgba(44,36,22,0.08);
                padding-bottom: var(--space-2);
            ">
                ${_kbNavTab('upload',  'Add knowledge',  '', 0)}
                ${_kbNavTab('queue',   'Review queue',   '', pendingCount)}
                ${_kbNavTab('recipes', 'Recipes',        '', 0)}
                ${_kbNavTab('domains', 'Skill areas',    '', 0)}
            </div>

            <!-- Sub-section content -->
            <div id="kb-section-content"></div>
        </div>
    `;

    // Stat card click handlers — each jumps to its corresponding sub-section.
    // 'To review' now routes directly to the Review queue sub-section.
    document.getElementById('kb-recipes-card')?.addEventListener('click', () => _switchKbSection('recipes'));
    document.getElementById('kb-domains-card')?.addEventListener('click', () => _switchKbSection('domains'));
    document.getElementById('kb-pending-card')?.addEventListener('click', () => _switchKbSection('queue'));

    // Sub-nav handlers
    ['upload', 'queue', 'recipes', 'domains'].forEach(s => {
        document.getElementById(`kb-tab-${s}`)?.addEventListener('click', () => {
            _switchKbSection(s);
        });
    });

    _switchKbSection(_activeKnowledgeSection);
}

// Each sub-nav tab is a compact pill — label only, no description.
// Active state is a filled background. badge is an optional number shown
// inline next to the label when > 0.
function _kbNavTab(id, label, description, badge) {
    const badgeHtml = badge > 0
        ? `<span style="
                display: inline-flex;
                align-items: center;
                justify-content: center;
                min-width: 18px;
                height: 18px;
                padding: 0 5px;
                border-radius: 100px;
                background: var(--ember);
                color: #fff;
                font-size: 10px;
                font-weight: 700;
                margin-left: 6px;
                line-height: 1;
                vertical-align: middle;
            ">${badge}</span>`
        : '';
    return `
        <button
            id="kb-tab-${id}"
            style="
                display: inline-flex;
                align-items: center;
                gap: 0;
                padding: var(--space-2) var(--space-4);
                border-radius: 100px;
                border: 1px solid transparent;
                background: transparent;
                font-size: var(--text-sm);
                font-weight: 500;
                color: var(--warm-grey);
                cursor: pointer;
                white-space: nowrap;
                transition: background 0.15s, color 0.15s;
            "
        >${label}${badgeHtml}</button>
    `;
}

function _switchKbSection(section) {
    _activeKnowledgeSection = section;

    // Update sub-nav active styles — pill style: filled background when active,
    // transparent when inactive. No border manipulation needed.
    ['upload', 'queue', 'recipes', 'domains'].forEach(s => {
        const btn = document.getElementById(`kb-tab-${s}`);
        if (!btn) return;
        if (s === section) {
            btn.style.background = 'rgba(44,36,22,0.08)';
            btn.style.color      = 'var(--ink)';
            btn.style.fontWeight = '600';
        } else {
            btn.style.background = 'transparent';
            btn.style.color      = 'var(--warm-grey)';
            btn.style.fontWeight = '500';
        }
    });

    const el = document.getElementById('kb-section-content');
    if (!el) return;

    switch (section) {
        case 'upload':  renderKbUpload(el);   break;
        case 'queue':   renderKbReviewQueue(el); break;
        case 'recipes': renderKbRecipes(el);  break;
        case 'domains': renderKbDomains(el);  break;
        default:        renderKbUpload(el);
    }
}

// ---------------------------------------------------------------------------
// KB SUB-SECTION: Add knowledge
// Upload form at the top. Corpus analysis action below it (CORP-03).
// The review queue is now its own sub-section (renderKbReviewQueue) so the
// Manager can reach it directly without scrolling past the upload form.
// ---------------------------------------------------------------------------
function renderKbUpload(el) {
    // In-progress spinner during document processing
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

    // Aha moment — shown after a successful extraction. This is the key value
    // moment in the Manager's experience of LORE. It must feel like receiving
    // a briefing from a senior analyst, not a system notification.
    // Three states: success with findings, success with no findings, failure.
    if (_uploadState.result) {
        const result = _uploadState.result;
        let resultHtml;

        if (!result.ok) {
            resultHtml = `
                <div class="card" style="border-left: 3px solid var(--error); margin-bottom: var(--space-6);">
                    <p style="font-weight: 500;">Could not process the document</p>
                    <p class="text-secondary text-sm mt-2">${_uploadState.errorMsg || 'Please try again shortly.'}</p>
                    <button class="btn btn-secondary mt-4" id="upload-reset" style="font-size: var(--text-sm);">Try again</button>
                </div>`;

        } else if (result.extractionsCreated === 0) {
            resultHtml = `
                <div class="card" style="margin-bottom: var(--space-6); padding: var(--space-8);">
                    <div style="text-align: center; max-width: 480px; margin: 0 auto;">
                        <!-- Visual mark — neutral, no knowledge found -->
                        <div style="
                            width: 56px; height: 56px;
                            border-radius: 50%;
                            background: rgba(140,123,106,0.12);
                            display: flex; align-items: center; justify-content: center;
                            margin: 0 auto var(--space-5);
                        ">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <circle cx="12" cy="12" r="10" stroke="var(--warm-grey)" stroke-width="1.5"/>
                                <path d="M12 8v4M12 16h.01" stroke="var(--warm-grey)" stroke-width="1.5" stroke-linecap="round"/>
                            </svg>
                        </div>
                        <p style="font-weight: 600; font-size: var(--text-lg); margin-bottom: var(--space-3);">Nothing transferable found in this document</p>
                        <p class="text-secondary text-sm" style="line-height: 1.7;">
                            LORE looks for moments of expert decision-making — the kind of
                            judgement that takes years to develop and is rarely written down.
                            This document does not appear to contain that kind of content.
                            Documents that work well tend to be retrospectives, post-mortems,
                            playbooks, or records of how specific situations were actually handled.
                        </p>
                        <button class="btn btn-secondary mt-6" id="upload-reset" style="font-size: var(--text-sm);">Try a different document</button>
                    </div>
                </div>`;

        } else {
            // The aha moment. LORE found something real — this screen should feel
            // like the consultant walking into the room with a prepared briefing.
            // Visual flourish: a composed mark, a specific statement of what was found,
            // and a quiet reveal of the skill names before the Manager dives into review.
            const foundCount  = result.extractionsCreated;
            const docName     = _uploadState.docName;

            // Build a preview of the skill names if we have them from the pending queue.
            // This makes the aha moment specific — the Manager sees names, not a count.
            const skillNames  = _pending
                .filter(ext => ext.draft?.skillName)
                .map(ext => ext.draft.skillName)
                .slice(0, foundCount);

            const skillPreview = skillNames.length > 0
                ? `<div style="margin: var(--space-6) 0; text-align: left; max-width: 420px; margin-left: auto; margin-right: auto;">
                    ${skillNames.map(name => `
                        <div style="
                            display: flex; align-items: center; gap: var(--space-3);
                            padding: var(--space-3) 0;
                            border-bottom: 1px solid rgba(44,36,22,0.06);
                        ">
                            <div style="
                                width: 6px; height: 6px; border-radius: 50%;
                                background: var(--sage); flex-shrink: 0;
                            "></div>
                            <p style="font-size: var(--text-sm); font-weight: 500; color: var(--ink);">${_esc(name)}</p>
                        </div>
                    `).join('')}
                   </div>`
                : '';

            resultHtml = `
                <div class="card" style="
                    margin-bottom: var(--space-6);
                    padding: var(--space-10) var(--space-8);
                    text-align: center;
                    border-top: 3px solid var(--sage);
                    position: relative;
                    overflow: hidden;
                ">
                    <!-- Background texture — subtle geometric mark, purely decorative -->
                    <div aria-hidden="true" style="
                        position: absolute;
                        top: -40px; right: -40px;
                        width: 200px; height: 200px;
                        border-radius: 50%;
                        background: radial-gradient(circle, rgba(61,139,110,0.06) 0%, transparent 70%);
                        pointer-events: none;
                    "></div>
                    <div aria-hidden="true" style="
                        position: absolute;
                        bottom: -60px; left: -60px;
                        width: 240px; height: 240px;
                        border-radius: 50%;
                        background: radial-gradient(circle, rgba(196,98,45,0.04) 0%, transparent 70%);
                        pointer-events: none;
                    "></div>

                    <!-- The mark — a composed circle with a check, in LORE's sage -->
                    <div style="
                        width: 64px; height: 64px;
                        border-radius: 50%;
                        background: rgba(61,139,110,0.1);
                        border: 1.5px solid rgba(61,139,110,0.25);
                        display: flex; align-items: center; justify-content: center;
                        margin: 0 auto var(--space-6);
                    ">
                        <svg width="26" height="26" viewBox="0 0 26 26" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M6 13.5L10.5 18L20 8" stroke="var(--sage)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                    </div>

                    <!-- The statement — specific, confident, framed as discovery -->
                    <p style="
                        font-size: var(--text-xs);
                        text-transform: uppercase;
                        letter-spacing: 0.1em;
                        color: var(--sage);
                        font-weight: 600;
                        margin-bottom: var(--space-3);
                    ">Knowledge recovered</p>

                    <h2 style="
                        font-size: var(--text-2xl);
                        font-weight: 700;
                        line-height: 1.3;
                        margin-bottom: var(--space-4);
                        max-width: 480px;
                        margin-left: auto;
                        margin-right: auto;
                    ">
                        ${foundCount === 1
                            ? `Inside &ldquo;${_esc(docName)}&rdquo;, LORE recovered one piece of expertise your organisation would have lost.`
                            : `Inside &ldquo;${_esc(docName)}&rdquo;, LORE recovered ${foundCount} pieces of expertise your organisation would have lost.`
                        }
                    </h2>

                    <p class="text-secondary" style="
                        font-size: var(--text-sm);
                        line-height: 1.7;
                        max-width: 400px;
                        margin: 0 auto;
                    ">
                        This is the kind of knowledge that lives in experienced people's heads
                        and disappears when they leave. It is now part of your organisation's record.
                    </p>

                    <!-- Skill name preview — makes the moment specific, not just a count -->
                    ${skillPreview}

                    <button class="btn btn-primary mt-6" id="upload-review-btn" style="font-size: var(--text-sm);">
                        Review what we found
                    </button>
                    <div style="margin-top: var(--space-3);">
                        <button class="btn btn-secondary" id="upload-reset" style="font-size: var(--text-sm); color: var(--warm-grey);">
                            Add another document
                        </button>
                    </div>
                </div>`;
        }

        el.innerHTML = `<div>${resultHtml}${_renderCorpusAnalysisCard()}${result.ok && result.extractionsCreated > 0 ? '' : ''}</div>`;

        // "Review what we found" switches to the Review queue sub-section.
        document.getElementById('upload-review-btn')?.addEventListener('click', () => {
            _switchKbSection('queue');
        });

        document.getElementById('upload-reset')?.addEventListener('click', () => {
            _uploadState = { inProgress: false, docName: '', docText: '', result: null, errorMsg: '', chunkProgress: null, partial: false };
            renderKbUpload(el);
        });

        _attachCorpusAnalysisHandlers();
        return;
    }

    // Default: upload form + corpus analysis card
    // The review queue has moved to its own sub-section — the Manager reaches
    // it via the Review queue tab or the 'To review' stat card.
    el.innerHTML = `
        <div>
            <div class="card" style="margin-bottom: var(--space-6);">
                <h3 style="margin-bottom: var(--space-2);">Add a document</h3>
                <p class="text-secondary text-sm mb-6" style="line-height: 1.6;">
                    Paste in any document that captures how your team makes decisions — a retrospective,
                    a playbook, a post-mortem. LORE reads it and finds the decision-making moments
                    that become training scenarios.
                </p>
                ${_renderUploadForm()}
            </div>
            ${_renderCorpusAnalysisCard()}
        </div>
    `;

    _attachUploadHandlers(async () => {
        _pending = await getPendingExtractions(_orgId);
        renderKnowledgeTab(document.getElementById('dashboard-tab-content'));
    });

    _attachCorpusAnalysisHandlers();
}

// Corpus analysis card — shown in Add knowledge section (CORP-03).
// Only renders the actionable state — visibility is determined by whether
// flagged responses exist, checked asynchronously after render.
function _renderCorpusAnalysisCard() {
    return `
        <div id="corpus-analysis-section" style="margin-bottom: var(--space-6); display: none;">
            <div class="card" style="border-left: 3px solid var(--ember);">
                <p style="font-weight: 500;">New patterns found in team responses</p>
                <p class="text-secondary text-sm mt-2 mb-4">
                    LORE has found response patterns from your senior team members that may contain useful knowledge.
                    Run the analysis to extract them into your review queue below.
                </p>
                <button class="btn btn-primary" id="corpus-analysis-btn" style="font-size: var(--text-sm);">
                    Find patterns in team responses
                </button>
                <p id="corpus-status" class="text-xs text-secondary mt-3"></p>
            </div>
        </div>
    `;
}

function _attachCorpusAnalysisHandlers() {
    // Check asynchronously whether flagged responses exist to decide visibility.
    _checkFlaggedResponses().then(hasFlagged => {
        const section = document.getElementById('corpus-analysis-section');
        if (section) section.style.display = hasFlagged ? 'block' : 'none';
    });

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
                ? `Found ${result.extractionsCreated} pattern${result.extractionsCreated !== 1 ? 's' : ''} — they appear in the review queue below.`
                : result.ok
                ? 'No new patterns found at this time.'
                : 'Could not complete the analysis. Try again shortly.';
        }

        if (result.ok && result.extractionsCreated > 0) {
            _pending = await getPendingExtractions(_orgId);
            // Re-render the active sub-section to show the new extractions.
            // Route to the queue section if the Manager is already there.
            const kbEl = document.getElementById('kb-section-content');
            if (kbEl) {
                if (_activeKnowledgeSection === 'queue') renderKbReviewQueue(kbEl);
                else if (_activeKnowledgeSection === 'upload') renderKbUpload(kbEl);
            }
            _refreshSummaryHeader();
        }
    });
}

// ---------------------------------------------------------------------------
// KB SUB-SECTION: Review queue
// Dedicated sub-section for pending extractions — reached via the Review queue
// sub-nav tab or the 'To review' stat card. Reuses _renderInlineQueue and
// _attachInlineQueueHandlers so the card logic stays in one place.
// ---------------------------------------------------------------------------
function renderKbReviewQueue(el) {
    el.innerHTML = `
        <div>
            <!-- Section intro strip — consistent with the Recipes tab header treatment -->
            <div style="
                background: rgba(44,36,22,0.03);
                border: 1px solid rgba(44,36,22,0.07);
                border-radius: var(--radius-lg);
                padding: var(--space-5) var(--space-6);
                margin-bottom: var(--space-6);
                display: flex;
                align-items: flex-start;
                gap: var(--space-4);
            ">
                <div style="flex: 1;">
                    <p class="text-secondary text-sm" style="line-height: 1.7;">
                        Approve or reject knowledge extracted from uploaded documents and Reviewer contributions.
                        Approved items become recipes in your knowledge base.
                    </p>
                </div>
                ${_pending.length > 0 ? `
                    <span style="
                        font-size: var(--text-xs);
                        font-weight: 700;
                        color: var(--ember);
                        background: rgba(196,98,45,0.08);
                        border-radius: 100px;
                        padding: 2px var(--space-3);
                        flex-shrink: 0;
                        white-space: nowrap;
                    ">${_pending.length} waiting</span>
                ` : ''}
            </div>
            ${_renderInlineQueue()}
        </div>
    `;
    _attachInlineQueueHandlers(el);
}

// Inline review queue — reusable HTML block for pending extractions.
// Now rendered via renderKbReviewQueue in the dedicated sub-section.
function _renderInlineQueue() {
    if (_pending.length === 0) {
        return `
            <div class="empty-state" style="padding: var(--space-8) var(--space-6);">
                <h3>Nothing to review</h3>
                <p class="mt-2">When you upload a document or a Reviewer contributes, extracted knowledge will appear here for your approval.</p>
            </div>
        `;
    }

    return `
        <div>
            <div class="flex-between" style="margin-bottom: var(--space-4);">
                <h3>${_pending.length} item${_pending.length !== 1 ? 's' : ''} waiting for review</h3>
            </div>
            <div id="inline-queue-list">
                ${_pending.map((ext, i) => _renderExtractionCard(ext, i)).join('')}
            </div>
        </div>
    `;
}

function _attachInlineQueueHandlers(parentEl) {
    _pending.forEach((ext, i) => _attachExtractionHandlers(ext, i, parentEl));
}

// ---------------------------------------------------------------------------
// Extraction card — the intelligence brief.
//
// Design principle: LORE's understanding is the deliverable. The card
// presents extracted knowledge the way a senior analyst presents a finding —
// with a clear headline, a structured insight, and a recommended action
// expressed as clean steps. The Manager reads a finished piece of work.
//
// Interaction model:
//   Read mode (default) — the card is a document, not a form. The Manager
//   reads the skill name, the situation, the insight, and the action steps.
//   A quiet "Edit" affordance allows any field to be changed before approving.
//   Edit mode — inputs replace the read view for the field being changed.
//   The raw source is collapsed behind "See source material" — always accessible
//   but never the lead.
//
// actionSequence rendering:
//   The extraction pipeline produces steps separated by newlines (fixed in
//   recipes.js). At render time we also split on the legacy `.,` separator
//   in case older extractions are present in Firestore, so both formats render
//   correctly as a numbered list.
//
// Three card states:
//   1. No pipeline run yet — source chip, collapsed raw content, Extract button.
//   2. Processed, full brief — knowledge + recipe in read mode, approve/edit.
//   3. Knowledge only, no draft — knowledge shown, re-run pipeline button.
// ---------------------------------------------------------------------------
function _renderExtractionCard(ext, index) {
    const sourceLabels = {
        'scenario_review':   'Scenario feedback',
        'mentorship_note':   'Mentorship note',
        'document_chunk':    'Document',
        'employee_response': 'Team response pattern',
    };
    const sourceLabel = sourceLabels[ext.sourceType] ?? 'Contribution';

    const hasKnowledge = ext.knowledge && ext.knowledge.hasKnowledge !== false && ext.knowledge.summary;
    const hasDraft     = ext.draft && ext.draft.skillName;

    // Provenance line — e.g. "Chunk 2 of 3 from document: meridian_playbook"
    const provenanceLine = ext.rawPrompt
        ? `<p class="text-xs text-secondary mt-1" style="font-style: italic;">${_esc(ext.rawPrompt.slice(0, 100))}${ext.rawPrompt.length > 100 ? '…' : ''}</p>`
        : (ext.documentName ? `<p class="text-xs text-secondary mt-1">${_esc(ext.documentName)}</p>` : '');

    // Raw content — collapsed by default. Always accessible.
    const rawSection = `
        <div style="margin-top: var(--space-4); padding-top: var(--space-4); border-top: 1px solid rgba(44,36,22,0.06);">
            <button
                id="raw-toggle-${index}"
                style="
                    background: none; border: none; cursor: pointer; padding: 0;
                    font-size: var(--text-xs); color: var(--warm-grey);
                    text-decoration: underline; text-underline-offset: 2px;
                "
            >See source material</button>
            <div id="raw-content-${index}" style="display: none; margin-top: var(--space-3);">
                <div style="
                    background: rgba(44,36,22,0.03);
                    border-radius: var(--radius-md);
                    padding: var(--space-4);
                    border-left: 2px solid rgba(44,36,22,0.1);
                    max-height: 320px;
                    overflow-y: auto;
                ">
                    ${_renderMarkdown(ext.rawContent ?? '') || `<p style="font-size: var(--text-xs); color: var(--warm-grey);">No content available.</p>`}
                </div>
            </div>
        </div>
    `;

    // ---------------------------------------------------------------------------
    // State 1: No pipeline run yet — the Manager needs to trigger extraction.
    // Show a preview of the raw content (first 200 chars) and an Extract button.
    // ---------------------------------------------------------------------------
    if (!hasKnowledge && !hasDraft) {
        const rawPreview = (ext.rawContent ?? '').slice(0, 200);
        const isTrimmed  = (ext.rawContent ?? '').length > 200;

        return `
            <div class="card" style="margin-bottom: var(--space-5);" id="ext-card-${index}">
                <div class="flex-between" style="margin-bottom: var(--space-3);">
                    <span class="chip chip-pending">${sourceLabel}</span>
                    <span class="text-xs text-secondary">${ext.wordCount ? ext.wordCount + ' words' : ''}</span>
                </div>
                ${provenanceLine}
                <p style="
                    font-size: var(--text-sm); line-height: 1.7;
                    color: var(--warm-grey); margin-top: var(--space-3);
                ">${_esc(rawPreview)}${isTrimmed ? '…' : ''}</p>
                <p class="text-xs mt-3" id="process-status-${index}" style="color: var(--warm-grey);"></p>
                <div style="display: flex; gap: var(--space-3); margin-top: var(--space-4);">
                    <button class="btn btn-primary" id="process-btn-${index}" style="font-size: var(--text-sm);">
                        Extract knowledge
                    </button>
                    <button class="btn btn-secondary" id="reject-btn-${index}"
                        style="font-size: var(--text-sm); color: var(--warm-grey);">
                        Dismiss
                    </button>
                </div>
            </div>
        `;
    }

    // ---------------------------------------------------------------------------
    // Parse actionSequence into clean steps for display.
    // Handles both the new newline format and the legacy ., separator.
    // ---------------------------------------------------------------------------
    function _parseSteps(raw) {
        // Coerce to string — Firestore may return an array or other type
        // if the extraction pipeline stored steps differently in older records.
        const str = Array.isArray(raw)
            ? raw.join('\n')
            : String(raw ?? '');
        if (!str.trim()) return [];
        // Split on newline first (new format from fixed extraction prompt)
        let lines = str.split('\n').map(s => s.trim()).filter(Boolean);
        // If only one line, check for legacy ., separator
        if (lines.length === 1) {
            lines = str.split('.,').map(s => s.trim()).filter(Boolean);
        }
        // Strip leading "1. 2. 3." numbering if present — we re-number in the template
        return lines.map(line => line.replace(/^\d+\.\s*/, '').trim()).filter(Boolean);
    }

    const steps = _parseSteps(ext.draft?.actionSequence ?? '');

    // ---------------------------------------------------------------------------
    // State 2 + 3: The intelligence brief — read mode.
    // The skill name is the headline. The insight leads the body.
    // Recipe fields display as a structured document, not a form.
    // ---------------------------------------------------------------------------
    const domainLabel = ext.knowledge?.domain ?? ext.draft?.domain ?? (_domains[0]?.name ?? '');

    return `
        <div class="card" style="
            margin-bottom: var(--space-5);
            padding: 0;
            overflow: hidden;
        " id="ext-card-${index}">

            <!-- Card header — skill area badge + source chip -->
            <div style="
                padding: var(--space-4) var(--space-6);
                background: rgba(44,36,22,0.025);
                border-bottom: 1px solid rgba(44,36,22,0.07);
                display: flex; justify-content: space-between; align-items: center;
            ">
                <div style="display: flex; align-items: center; gap: var(--space-3);">
                    <span class="chip chip-pending">${sourceLabel}</span>
                    ${domainLabel ? `<span style="
                        font-size: var(--text-xs);
                        color: var(--warm-grey);
                        padding: 2px var(--space-2);
                        background: rgba(44,36,22,0.06);
                        border-radius: var(--radius-sm);
                    ">${_esc(domainLabel)}</span>` : ''}
                </div>
                <span class="text-xs text-secondary">${ext.wordCount ? ext.wordCount + ' words' : ''}</span>
            </div>

            <!-- Brief body -->
            <div style="padding: var(--space-6);">

                ${hasDraft ? `
                    <!-- Skill headline — the name of the thing LORE found -->
                    <div id="read-skillname-${index}">
                        <p style="
                            font-size: var(--text-xs);
                            text-transform: uppercase;
                            letter-spacing: 0.08em;
                            color: var(--sage);
                            font-weight: 600;
                            margin-bottom: var(--space-2);
                        ">Skill identified</p>
                        <h3 style="
                            font-size: var(--text-xl);
                            font-weight: 700;
                            line-height: 1.2;
                            margin-bottom: 0;
                        ">${_esc(ext.draft.skillName)}</h3>
                    </div>
                    <div id="edit-skillname-${index}" style="display: none; margin-bottom: var(--space-4);">
                        <label class="label mb-1">Skill name</label>
                        <input class="input" id="draft-skill-${index}" value="${_esc(ext.draft.skillName ?? '')}">
                    </div>
                ` : ''}

                <!-- Divider -->
                <div style="height: 1px; background: rgba(44,36,22,0.07); margin: var(--space-5) 0;"></div>

                ${hasKnowledge ? `
                    <!-- LORE's understanding — the intellectual core of the card -->
                    <div style="margin-bottom: var(--space-5);">
                        <p style="
                            font-size: var(--text-xs);
                            text-transform: uppercase;
                            letter-spacing: 0.08em;
                            color: var(--warm-grey);
                            font-weight: 600;
                            margin-bottom: var(--space-3);
                        ">What this is really about</p>
                        <p style="
                            font-size: var(--text-base);
                            line-height: 1.75;
                            color: var(--ink);
                            font-style: italic;
                            border-left: 3px solid var(--sage);
                            padding-left: var(--space-4);
                            margin-bottom: var(--space-4);
                        ">${_esc(ext.knowledge.insight ?? '')}</p>
                        <p style="font-size: var(--text-sm); line-height: 1.6; color: var(--warm-grey);">${_esc(ext.knowledge.summary ?? '')}</p>
                    </div>
                ` : ''}

                ${hasDraft ? `
                    <!-- When it applies -->
                    <div style="margin-bottom: var(--space-5);">
                        <p style="
                            font-size: var(--text-xs);
                            text-transform: uppercase;
                            letter-spacing: 0.08em;
                            color: var(--warm-grey);
                            font-weight: 600;
                            margin-bottom: var(--space-2);
                        ">When this applies</p>
                        <div id="read-trigger-${index}">
                            <p style="font-size: var(--text-sm); line-height: 1.65; color: var(--ink);">${_esc(ext.draft.trigger ?? '')}</p>
                        </div>
                        <div id="edit-trigger-${index}" style="display: none;">
                            <textarea class="input" id="draft-trigger-${index}" rows="2" style="resize: vertical;">${_esc(ext.draft.trigger ?? '')}</textarea>
                        </div>
                    </div>

                    <!-- What to do — numbered steps, clean and readable -->
                    <div style="margin-bottom: var(--space-5);">
                        <p style="
                            font-size: var(--text-xs);
                            text-transform: uppercase;
                            letter-spacing: 0.08em;
                            color: var(--warm-grey);
                            font-weight: 600;
                            margin-bottom: var(--space-3);
                        ">What to do</p>
                        <div id="read-action-${index}">
                            ${steps.length > 0
                                ? `<ol style="padding: 0; margin: 0; list-style: none;">
                                    ${steps.map((step, si) => `
                                        <li style="
                                            display: flex; gap: var(--space-3);
                                            padding: var(--space-2) 0;
                                            ${si < steps.length - 1 ? 'border-bottom: 1px solid rgba(44,36,22,0.05);' : ''}
                                        ">
                                            <span style="
                                                font-size: var(--text-xs);
                                                font-weight: 700;
                                                color: var(--ember);
                                                min-width: 20px;
                                                padding-top: 2px;
                                            ">${si + 1}</span>
                                            <p style="font-size: var(--text-sm); line-height: 1.65; color: var(--ink); margin: 0;">${_esc(step)}</p>
                                        </li>
                                    `).join('')}
                                   </ol>`
                                : `<p style="font-size: var(--text-sm); color: var(--ink); line-height: 1.65;">${_esc(ext.draft.actionSequence ?? '')}</p>`
                            }
                        </div>
                        <div id="edit-action-${index}" style="display: none;">
                            <textarea class="input" id="draft-action-${index}" rows="4" style="resize: vertical;">${_esc(ext.draft.actionSequence ?? '')}</textarea>
                            <p class="text-xs text-secondary mt-1">One step per line. LORE will display them as a numbered list.</p>
                        </div>
                    </div>

                    <!-- What it produces -->
                    <div style="
                        margin-bottom: var(--space-5);
                        padding: var(--space-4);
                        background: rgba(61,139,110,0.05);
                        border-radius: var(--radius-md);
                        border: 1px solid rgba(61,139,110,0.12);
                    ">
                        <p style="
                            font-size: var(--text-xs);
                            text-transform: uppercase;
                            letter-spacing: 0.08em;
                            color: var(--sage);
                            font-weight: 600;
                            margin-bottom: var(--space-2);
                        ">What it produces</p>
                        <div id="read-outcome-${index}">
                            <p style="font-size: var(--text-sm); line-height: 1.65; color: var(--ink);">${_esc(ext.draft.expectedOutcome ?? '')}</p>
                        </div>
                        <div id="edit-outcome-${index}" style="display: none;">
                            <textarea class="input" id="draft-outcome-${index}" rows="2" style="resize: vertical;">${_esc(ext.draft.expectedOutcome ?? '')}</textarea>
                        </div>
                    </div>

                    <!-- Skill area assignment -->
                    <div style="margin-bottom: var(--space-4);">
                        <p style="
                            font-size: var(--text-xs);
                            text-transform: uppercase;
                            letter-spacing: 0.08em;
                            color: var(--warm-grey);
                            font-weight: 600;
                            margin-bottom: var(--space-2);
                        ">Skill area</p>
                        <div id="read-domain-${index}">
                            <p style="font-size: var(--text-sm); color: var(--ink);">${_esc(domainLabel || 'Not assigned')}</p>
                        </div>
                        <div id="edit-domain-${index}" style="display: none;">
                            <input class="input" id="draft-domain-${index}"
                                value="${_esc(domainLabel)}"
                                placeholder="Type a skill area name…">
                        </div>
                    </div>

                    <!-- Reviewer assignment -->
                    <div style="
                        margin-bottom: var(--space-5);
                        padding-top: var(--space-4);
                        border-top: 1px solid rgba(44,36,22,0.07);
                    ">
                        <label style="
                            font-size: var(--text-xs);
                            text-transform: uppercase;
                            letter-spacing: 0.08em;
                            color: var(--warm-grey);
                            font-weight: 600;
                            display: block;
                            margin-bottom: var(--space-2);
                        ">Send for Reviewer validation (optional)</label>
                        <p class="text-xs text-secondary mb-2">A Reviewer will see this as a quality check — they will not know it is part of a knowledge base.</p>
                        <select class="input" id="draft-reviewer-${index}" style="font-size: var(--text-sm);">
                            <option value="">No Reviewer — approve only</option>
                        </select>
                        <p id="reviewer-load-status-${index}" class="text-xs text-secondary mt-1"></p>
                    </div>
                ` : `
                    <!-- Knowledge present but no draft yet — rare state -->
                    <p class="text-xs text-secondary mb-4" id="process-status-${index}"></p>
                `}

                <!-- Raw source — collapsed, accessible -->
                ${rawSection}

                <!-- Action bar -->
                <div style="
                    display: flex; gap: var(--space-3);
                    margin-top: var(--space-6);
                    padding-top: var(--space-5);
                    border-top: 1px solid rgba(44,36,22,0.07);
                    align-items: center;
                    flex-wrap: wrap;
                ">
                    ${hasDraft ? `
                        <button class="btn btn-primary" id="approve-btn-${index}" style="font-size: var(--text-sm);">
                            Add to knowledge base
                        </button>
                        <button class="btn btn-secondary" id="edit-toggle-${index}" style="font-size: var(--text-sm);">
                            Edit
                        </button>
                    ` : `
                        <button class="btn btn-primary" id="process-btn-${index}" style="font-size: var(--text-sm);">
                            Extract knowledge
                        </button>
                    `}
                    <button class="btn btn-secondary" id="reject-btn-${index}"
                        style="font-size: var(--text-sm); color: var(--warm-grey); margin-left: auto;">
                        Dismiss
                    </button>
                </div>

            </div>
        </div>
    `;
}

function _attachExtractionHandlers(ext, index, parentEl) {
    // If the card has a draft, load the Reviewer dropdown asynchronously
    if (ext.draft && ext.draft.skillName) {
        _populateReviewerDropdown(index);
    }

    // ---------------------------------------------------------------------------
    // Raw source toggle — "See source material" / "Hide source"
    // ---------------------------------------------------------------------------
    document.getElementById(`raw-toggle-${index}`)?.addEventListener('click', () => {
        const raw    = document.getElementById(`raw-content-${index}`);
        const btn    = document.getElementById(`raw-toggle-${index}`);
        if (!raw) return;
        const isOpen = raw.style.display !== 'none';
        raw.style.display   = isOpen ? 'none' : 'block';
        btn.textContent     = isOpen ? 'See source material' : 'Hide source';
    });

    // ---------------------------------------------------------------------------
    // Edit toggle — swaps all read-mode elements to their edit counterparts.
    // A second click on "Save changes" re-renders the card with updated values.
    // ---------------------------------------------------------------------------
    let _editMode = false;
    document.getElementById(`edit-toggle-${index}`)?.addEventListener('click', () => {
        _editMode = !_editMode;
        const btn = document.getElementById(`edit-toggle-${index}`);

        const fields = ['skillname', 'trigger', 'action', 'outcome', 'domain'];
        fields.forEach(field => {
            const readEl = document.getElementById(`read-${field}-${index}`);
            const editEl = document.getElementById(`edit-${field}-${index}`);
            if (readEl) readEl.style.display = _editMode ? 'none' : 'block';
            if (editEl) editEl.style.display = _editMode ? 'block' : 'none';
        });

        if (btn) btn.textContent = _editMode ? 'Save changes' : 'Edit';
    });

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

        // Re-fetch the updated extraction and re-render the card in place.
        // outerHTML replacement keeps the card's DOM position stable.
        const cardEl = document.getElementById(`ext-card-${index}`);
        if (cardEl) {
            const updatedExt = { ...ext, knowledge: result.knowledge, draft: result.draft, status: 'processed' };
            _pending[index]  = updatedExt;
            cardEl.outerHTML = _renderExtractionCard(updatedExt, index);
            _attachExtractionHandlers(updatedExt, index, parentEl);
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

        const recipeId = await approveRecipe(_orgId, draft, ext.id, domain, ext.knowledge ?? null);

        if (recipeId) {
            // Dismiss bug fix: remove from local _pending array first, then re-render.
            // Previously the array was mutated after re-render which caused stale badge counts
            // and ghost cards on dismiss. Splicing before re-render keeps all counts in sync.
            _pending.splice(index, 1);
            _recipes = await getAllApprovedRecipes(_orgId);

            // If a Reviewer was selected, queue a scenario review task for them.
            const reviewerSelect = document.getElementById(`draft-reviewer-${index}`);
            const reviewerId     = reviewerSelect?.value ?? '';
            if (reviewerId && recipeId) {
                // Queue a recipe accuracy check for the Reviewer. This works
                // immediately on approval — no scenario needs to exist first.
                // The Reviewer will see it as a situational quality check.
                const reviewResult = await queueRecipeReview(_orgId, recipeId, reviewerId);
                if (!reviewResult.ok) {
                    console.warn('LORE dashboard.js: Could not queue recipe review after approval:', reviewResult.error);
                }
            }

            // Re-render only the active sub-section so the Manager stays in
            // the queue tab after approving. Then refresh the summary header
            // so stat counts and badge update without a full tab re-render.
            const kbContent = document.getElementById('kb-section-content');
            if (kbContent) {
                if (_activeKnowledgeSection === 'queue') renderKbReviewQueue(kbContent);
                else renderKbUpload(kbContent);
            }
            _refreshSummaryHeader();
        } else {
            btn.disabled    = false;
            btn.textContent = 'Add to knowledge base';
        }
    });

    // Reject / Dismiss button
    // Dismiss bug fix: update _pending array before re-rendering the queue.
    // Previously the queue was re-rendered first, leaving a stale badge on the
    // summary header and potentially showing ghost cards until the next page load.
    document.getElementById(`reject-btn-${index}`)?.addEventListener('click', async () => {
        await rejectExtraction(_orgId, ext.id);
        // Remove from local array first, then re-render so counts are correct
        _pending.splice(index, 1);
        const kbContent = document.getElementById('kb-section-content');
        // Re-render the active section — if the Manager is in the queue tab,
        // show the queue (including the empty state when the last item is dismissed).
        // Do not fall back to the upload section.
        if (kbContent) {
            if (_activeKnowledgeSection === 'queue') renderKbReviewQueue(kbContent);
            else renderKbUpload(kbContent);
        }
        // Also update the summary header to reflect the new pending count
        _refreshSummaryHeader();
    });
}

// ---------------------------------------------------------------------------
// Populate the Reviewer dropdown for a given extraction card.
// Loads Reviewer users from Firestore asynchronously after card render.
// ---------------------------------------------------------------------------
async function _populateReviewerDropdown(index) {
    const select   = document.getElementById(`draft-reviewer-${index}`);
    const statusEl = document.getElementById(`reviewer-load-status-${index}`);
    if (!select) return;

    const { db } = await import('../firebase.js');
    const { collection, query, where, getDocs } = await import(
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );

    try {
        const snap = await getDocs(
            query(collection(db, 'organisations', _orgId, 'users'), where('role', '==', 'reviewer'))
        );
        if (snap.empty) {
            if (statusEl) statusEl.textContent = 'No Reviewers in your team yet.';
            return;
        }
        snap.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.id;
            opt.textContent = d.data().displayName ?? d.data().email ?? d.id;
            select.appendChild(opt);
        });
    } catch (err) {
        console.warn('LORE dashboard.js: Could not load Reviewers for dropdown.', err);
        if (statusEl) statusEl.textContent = 'Could not load Reviewers.';
    }
}

// ---------------------------------------------------------------------------
// Try to queue a Reviewer task for a newly approved recipe.

// ---------------------------------------------------------------------------
// Refresh only the summary header counts without re-rendering the whole tab.
// Called after a dismiss so the pending badge updates immediately.
// ---------------------------------------------------------------------------
function _refreshSummaryHeader() {
    const confirmedDomains = _domains.filter(d => !d.provisional).length;
    const pendingCount     = _pending.length;

    // Update recipe count
    const recipeCountEl = document.querySelector('#dashboard-tab-content .stat-card:nth-child(1) p:last-child');
    if (recipeCountEl) recipeCountEl.textContent = _recipes.length;

    // Update pending count and its colour
    const pendingEl    = document.querySelector('#dashboard-tab-content .stat-card:nth-child(3) p:last-child');
    const pendingCard  = document.getElementById('kb-pending-card');
    if (pendingEl) {
        pendingEl.textContent = pendingCount;
        pendingEl.style.color = pendingCount > 0 ? 'var(--ember)' : 'var(--ink)';
    }
    if (pendingCard) {
        pendingCard.style.cursor = pendingCount > 0 ? 'pointer' : 'default';
    }

    // Update the Review queue tab badge inline.
    // The badge is a <span> inside #kb-tab-queue — find it by its style
    // signature (ember background). We update its text or remove it entirely.
    const queueTab = document.getElementById('kb-tab-queue');
    if (queueTab) {
        // Remove any existing badge first
        const existingBadge = queueTab.querySelector('span[style]');
        if (existingBadge) existingBadge.remove();
        if (pendingCount > 0) {
            const badge = document.createElement('span');
            badge.textContent = pendingCount;
            badge.setAttribute('style', [
                'display:inline-flex',
                'align-items:center',
                'justify-content:center',
                'min-width:18px',
                'height:18px',
                'padding:0 5px',
                'border-radius:100px',
                'background:var(--ember)',
                'color:#fff',
                'font-size:10px',
                'font-weight:700',
                'margin-left:6px',
                'line-height:1',
                'vertical-align:middle',
            ].join(';'));
            queueTab.appendChild(badge);
        }
    }
}

// ---------------------------------------------------------------------------
// KB SUB-SECTION: Recipes
// All approved recipes, browsable by domain.
// Includes send-for-review panel for routing individual scenarios to Reviewers.
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

    // ---------------------------------------------------------------------------
    // Grouping strategy — match each recipe to a confirmed Skill Area by comparing
    // r.domain (the string set at approval time) against confirmed domain names.
    // Matching is case-insensitive and trims whitespace so minor inconsistencies
    // in how the Manager typed the domain at approval time do not create orphans.
    //
    // Three buckets:
    //   byDomain      — Map of confirmed domain id → { domain object, recipes[] }
    //   unmatched     — Recipes whose r.domain string matches no confirmed Skill Area
    //   noDomainsYet  — True when there are no confirmed Skill Areas at all
    // ---------------------------------------------------------------------------
    const confirmed = _domains.filter(d => !d.provisional);

    // Build a lookup: normalised name → domain object
    const domainByName = {};
    confirmed.forEach(d => {
        domainByName[d.name.trim().toLowerCase()] = d;
    });

    const byDomainId  = {}; // domainId → { domain, recipes[] }
    const unmatched   = []; // recipes with no confirmed Skill Area match

    confirmed.forEach(d => {
        byDomainId[d.id] = { domain: d, recipes: [] };
    });

    _recipes.forEach(r => {
        const key    = (r.domain ?? '').trim().toLowerCase();
        const match  = domainByName[key];
        if (match) {
            byDomainId[match.id].recipes.push(r);
        } else {
            unmatched.push(r);
        }
    });

    // Detect Employee assignment gap for the contextual prompt
    // (same check as Feature 2 — checked here so the Recipes tab can also surface it)
    // We read _domains which is already loaded — no extra Firestore call needed here.
    const hasConfirmedDomains = confirmed.length > 0;

    // Build the section summary line
    const matchedCount   = _recipes.length - unmatched.length;
    const summaryParts   = [];
    if (matchedCount > 0)   summaryParts.push(`${matchedCount} in ${Object.values(byDomainId).filter(b => b.recipes.length > 0).length} skill area${Object.values(byDomainId).filter(b => b.recipes.length > 0).length !== 1 ? 's' : ''}`);
    if (unmatched.length > 0) summaryParts.push(`${unmatched.length} not yet assigned to a skill area`);

    el.innerHTML = `
        <div>
            <!-- Section intro — warm parchment-toned header strip -->
            <div style="
                background: rgba(44,36,22,0.03);
                border: 1px solid rgba(44,36,22,0.07);
                border-radius: var(--radius-lg);
                padding: var(--space-5) var(--space-6);
                margin-bottom: var(--space-6);
            ">
                <p class="text-secondary text-sm" style="line-height: 1.7; margin-bottom: var(--space-3);">
                    Recipes are the structured knowledge your organisation has approved. Each one captures a situation,
                    how your team approaches it, and what a good outcome looks like. They are what Employees train against.
                </p>
                <div style="display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;">
                    <span style="
                        font-size: var(--text-xs);
                        font-weight: 700;
                        color: var(--ember);
                        background: rgba(196,98,45,0.08);
                        border-radius: 100px;
                        padding: 2px var(--space-3);
                    ">${_recipes.length} recipe${_recipes.length !== 1 ? 's' : ''}</span>
                    ${summaryParts.length > 0 ? `<span class="text-xs text-secondary">${summaryParts.join(' · ')}</span>` : ''}
                </div>
            </div>

            <!-- Gap prompt: recipes exist but no confirmed Skill Areas yet -->
            ${!hasConfirmedDomains ? `
                <div style="
                    display: flex;
                    gap: var(--space-4);
                    align-items: flex-start;
                    padding: var(--space-5);
                    margin-bottom: var(--space-6);
                    background: rgba(196,98,45,0.05);
                    border: 1px solid rgba(196,98,45,0.18);
                    border-radius: var(--radius-lg);
                    border-left: 3px solid var(--ember);
                ">
                    <div style="
                        width: 36px; height: 36px; border-radius: 50%;
                        background: rgba(196,98,45,0.1);
                        display: flex; align-items: center; justify-content: center;
                        flex-shrink: 0;
                    ">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M8 3v5M8 11h.01" stroke="var(--ember)" stroke-width="1.5" stroke-linecap="round"/>
                            <circle cx="8" cy="8" r="6.5" stroke="var(--ember)" stroke-width="1.5"/>
                        </svg>
                    </div>
                    <div style="flex: 1;">
                        <p style="font-weight: 600; font-size: var(--text-sm); margin-bottom: var(--space-1);">
                            Your recipes need skill areas before training can begin
                        </p>
                        <p class="text-secondary text-sm" style="line-height: 1.6; margin-bottom: var(--space-3);">
                            Employees train within skill areas — without them, no one can be assigned a track
                            and training cannot start. Create skill areas to organise these recipes.
                        </p>
                        <button class="btn btn-secondary" id="recipes-go-domains"
                            style="font-size: var(--text-sm); border-color: rgba(196,98,45,0.3); color: var(--ember);">
                            Go to Skill areas →
                        </button>
                    </div>
                </div>
            ` : ''}

            <!-- Recipes grouped under their confirmed Skill Area headings -->
            ${confirmed.map(d => {
                const group = byDomainId[d.id];
                if (!group || group.recipes.length === 0) return '';
                return `
                    <div style="margin-bottom: var(--space-8);">
                        <!-- Skill area heading — sage accent dot for warmth -->
                        <div style="
                            display: flex;
                            align-items: center;
                            gap: var(--space-3);
                            margin-bottom: var(--space-4);
                            padding-bottom: var(--space-3);
                            border-bottom: 1px solid rgba(44,36,22,0.07);
                        ">
                            <span style="
                                width: 8px; height: 8px;
                                border-radius: 50%;
                                background: var(--sage);
                                flex-shrink: 0;
                            "></span>
                            <h3 style="margin: 0;">${_esc(d.name)}</h3>
                            <span style="
                                font-size: var(--text-xs);
                                color: var(--warm-grey);
                                margin-left: auto;
                            ">${group.recipes.length} recipe${group.recipes.length !== 1 ? 's' : ''}</span>
                        </div>
                        ${group.recipes.map(r => _renderRecipeCard(r)).join('')}
                    </div>
                `;
            }).join('')}

            <!-- Unmatched recipes — exist in Firestore but their r.domain string
                 does not match any confirmed Skill Area name. Shown with a nudge
                 to either create a matching Skill Area or send them for review. -->
            ${unmatched.length > 0 ? `
                <div style="margin-bottom: var(--space-8);">
                    <div style="
                        display: flex;
                        align-items: center;
                        gap: var(--space-3);
                        margin-bottom: var(--space-4);
                        padding-bottom: var(--space-3);
                        border-bottom: 1px solid rgba(44,36,22,0.07);
                    ">
                        <span style="
                            width: 8px; height: 8px;
                            border-radius: 50%;
                            background: rgba(140,123,106,0.5);
                            flex-shrink: 0;
                        "></span>
                        <h3 style="margin: 0; color: var(--warm-grey);">Not yet in a skill area</h3>
                        <span style="
                            font-size: var(--text-xs);
                            color: var(--warm-grey);
                            margin-left: auto;
                        ">${unmatched.length} recipe${unmatched.length !== 1 ? 's' : ''}</span>
                    </div>
                    <div style="
                        padding: var(--space-4) var(--space-5);
                        background: rgba(44,36,22,0.03);
                        border-radius: var(--radius-md);
                        margin-bottom: var(--space-4);
                        border: 1px solid rgba(44,36,22,0.07);
                    ">
                        <p class="text-secondary text-sm" style="line-height: 1.6; margin-bottom: var(--space-3);">
                            These recipes are approved but their skill area label does not match any confirmed
                            Skill Area. Create a matching Skill Area so they can be used in training.
                        </p>
                        <button class="btn btn-secondary" id="unmatched-go-domains"
                            style="font-size: var(--text-sm);">
                            Create a skill area →
                        </button>
                    </div>
                    ${unmatched.map(r => _renderRecipeCard(r)).join('')}
                </div>
            ` : ''}
        </div>
    `;

    // Gap prompt handlers — route to the correct sub-section
    document.getElementById('recipes-go-domains')?.addEventListener('click',   () => _switchKbSection('domains'));
    document.getElementById('unmatched-go-domains')?.addEventListener('click', () => _switchKbSection('domains'));

    // Wire up per-recipe handlers — same as before
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

        // Source material — fetch raw content from the extraction on demand.
        // The extraction record is linked via extractionId saved on the recipe.
        // We fetch once and cache the result in the DOM so repeated clicks
        // do not make repeated Firestore reads.
        document.getElementById(`recipe-source-${r.id}`)?.addEventListener('click', async () => {
            const contentEl = document.getElementById(`recipe-source-content-${r.id}`);
            const textEl    = document.getElementById(`recipe-source-text-${r.id}`);
            const btn       = document.getElementById(`recipe-source-${r.id}`);
            if (!contentEl) return;

            const isOpen = contentEl.style.display !== 'none';
            contentEl.style.display = isOpen ? 'none' : 'block';
            btn.textContent = isOpen ? 'See source material' : 'Hide source';
            if (isOpen) return;

            // Only fetch if not already loaded (textEl still says "Loading…")
            if (textEl && textEl.textContent !== 'Loading…') return;

            try {
                const { db: firestoreDb } = await import('../firebase.js');
                const { doc: fdoc, getDoc: fget } = await import(
                    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
                );
                const snap = await fget(fdoc(firestoreDb, 'organisations', _orgId, 'extractions', r.extractionId));
                if (snap.exists()) {
                    const rawContent = snap.data().rawContent ?? '';
                    if (textEl) {
                        // Render with markdown support — handles blockquotes, bold,
                        // numbered lists, headings, and line breaks within paragraphs
                        textEl.innerHTML = _renderMarkdown(rawContent);
                    }
                } else {
                    if (textEl) textEl.textContent = 'Source material not found.';
                }
            } catch (err) {
                console.warn('LORE dashboard.js: Could not fetch source material for recipe:', r.id, err);
                if (textEl) textEl.textContent = 'Could not load source material.';
            }
        });

        // _openReviewPanel populates and wires the send panel for a given recipe.
        // Extracted as a named async function so it can be called both on the
        // initial 'Send for review' click and after 'Send to someone else' resets
        // the panel — without triggering the outer toggle handler again.
        async function _openReviewPanel() {
            const panel = document.getElementById(`recipe-review-panel-${r.id}`);
            if (!panel) return;

            // Restore the original panel markup so the dropdown is fresh
            panel.innerHTML = `
                <p class="label" style="margin-bottom: var(--space-3);">Send for Reviewer validation</p>
                <p class="text-secondary text-sm" style="margin-bottom: var(--space-3); line-height: 1.6;">
                    A Reviewer will see this as a quality check — they will not know it is part of a knowledge base.
                </p>
                <select class="input mb-3" id="review-reviewer-${r.id}" style="margin-bottom: var(--space-3);">
                    <option value="">Choose a Reviewer…</option>
                </select>
                <p id="review-status-${r.id}" class="text-xs text-secondary mb-2"></p>
                <button class="btn btn-primary" id="review-send-${r.id}">Send</button>
            `;

            panel.style.display = 'block';
            panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

            const reviewerSelect = document.getElementById(`review-reviewer-${r.id}`);
            const statusEl       = document.getElementById(`review-status-${r.id}`);

            // Populate the Reviewer dropdown — only users with role 'reviewer'
            const { db: firestoreDb } = await import('../firebase.js');
            const { collection: col, query: q, where: wh, getDocs: gd } =
                await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

            try {
                const usersSnap = await gd(q(col(firestoreDb, 'organisations', _orgId, 'users'), wh('role', '==', 'reviewer')));
                if (usersSnap.empty) {
                    if (statusEl) statusEl.textContent = 'No Reviewers in your team yet.';
                }
                usersSnap.forEach(d => {
                    const opt = document.createElement('option');
                    opt.value = d.id;
                    opt.textContent = d.data().displayName ?? d.data().email ?? d.id;
                    reviewerSelect?.appendChild(opt);
                });
            } catch (err) {
                console.warn('LORE dashboard.js: Could not load Reviewers for recipe review panel.', err);
                if (statusEl) statusEl.textContent = 'Could not load Reviewers. Try again.';
            }

            document.getElementById(`review-send-${r.id}`)?.addEventListener('click', async () => {
                const reviewerId = reviewerSelect?.value;
                if (!reviewerId) {
                    if (statusEl) statusEl.textContent = 'Please choose a Reviewer.';
                    return;
                }
                const btn = document.getElementById(`review-send-${r.id}`);
                btn.disabled = true; btn.textContent = 'Sending…';
                // Queue a recipe_review task — works whether or not scenarios exist.
                // The Reviewer sees this as a situational accuracy check, not a
                // training review. No scenario is needed for this path.
                const result = await queueRecipeReview(_orgId, r.id, reviewerId);
                btn.disabled = false; btn.textContent = 'Send';
                if (!result.ok) {
                    if (statusEl) statusEl.textContent = result.error ?? 'Could not send. Try again.';
                    return;
                }
                // Replace panel content with a confirmation state.
                // 'Send to someone else' calls _openReviewPanel() directly — no
                // .click() on the outer button — so the dropdown is always fresh.
                const panelEl = document.getElementById(`recipe-review-panel-${r.id}`);
                if (panelEl) {
                    panelEl.innerHTML = `
                        <div style="display:flex;align-items:center;gap:var(--space-3);">
                            <span style="
                                color: var(--sage);
                                font-size: var(--text-lg);
                                font-weight: 600;
                                background: rgba(61,139,110,0.1);
                                border-radius: 50%;
                                width: 32px; height: 32px;
                                display: inline-flex;
                                align-items: center;
                                justify-content: center;
                                flex-shrink: 0;
                            ">✓</span>
                            <div>
                                <p style="font-size:var(--text-sm);font-weight:600;color:var(--sage);">Sent for review</p>
                                <p style="font-size:var(--text-xs);color:var(--warm-grey);margin-top:2px;">They'll see it in their next session.</p>
                            </div>
                        </div>
                        <button id="recipe-review-resend-${r.id}" style="
                            background:none;border:none;cursor:pointer;padding:0;
                            font-size:var(--text-xs);color:var(--warm-grey);
                            text-decoration:underline;text-underline-offset:2px;
                            margin-top:var(--space-3);display:block;
                        ">Send to someone else</button>
                    `;
                    // Re-open a fresh populated panel directly — do not use .click()
                    // on the outer toggle button as that would re-enter the toggle
                    // and close the panel if it was already open.
                    document.getElementById(`recipe-review-resend-${r.id}`)?.addEventListener('click', () => {
                        _openReviewPanel();
                    });
                }
            });
        }

        document.getElementById(`recipe-review-${r.id}`)?.addEventListener('click', async () => {
            const panel = document.getElementById(`recipe-review-panel-${r.id}`);
            if (!panel) return;
            // Toggle: close if already open, open if closed.
            if (panel.style.display !== 'none') {
                panel.style.display = 'none';
                return;
            }
            await _openReviewPanel();
        });
    });
}

function _renderRecipeCard(r) {
    // Parse actionSequence into clean steps — same logic as the extraction card.
    // Handles both the newline format (new) and the legacy ., separator (old).
    function parseSteps(raw) {
        const str = Array.isArray(raw) ? raw.join('\n') : String(raw ?? '');
        if (!str.trim()) return [];
        let lines = str.split('\n').map(s => s.trim()).filter(Boolean);
        if (lines.length === 1) lines = str.split('.,').map(s => s.trim()).filter(Boolean);
        return lines.map(l => l.replace(/^\d+\.\s*/, '').trim()).filter(Boolean);
    }
    const steps = parseSteps(r.actionSequence);

    return `
        <div class="card" style="margin-bottom: var(--space-4); padding: 0; overflow: hidden;" id="recipe-card-${r.id}">

            <!-- Card header -->
            <div style="
                padding: var(--space-4) var(--space-5);
                background: rgba(44,36,22,0.025);
                border-bottom: 1px solid rgba(44,36,22,0.07);
                display: flex; justify-content: space-between; align-items: center;
            ">
                <span style="
                    font-size: var(--text-xs);
                    color: var(--warm-grey);
                    padding: 2px var(--space-2);
                    background: rgba(44,36,22,0.06);
                    border-radius: var(--radius-sm);
                ">${_esc(r.domain ?? 'Uncategorised')}</span>
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

            <!-- Brief body — collapsed by default, shown on toggle -->
            <div style="padding: var(--space-5);">

                <!-- Skill headline -->
                <p style="font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.08em; color: var(--sage); font-weight: 600; margin-bottom: var(--space-1);">Skill</p>
                <h3 style="font-size: var(--text-lg); font-weight: 700; margin-bottom: 0; line-height: 1.2;">${_esc(r.skillName)}</h3>

                <!-- Expandable detail -->
                <div id="recipe-detail-${r.id}" style="display: none; margin-top: var(--space-5);">

                    <!-- Insight — shown if saved with the recipe -->
                    ${r.insight ? `
                        <div style="margin-bottom: var(--space-5);">
                            <p style="font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.08em; color: var(--warm-grey); font-weight: 600; margin-bottom: var(--space-2);">What this is really about</p>
                            <p style="
                                font-size: var(--text-sm); line-height: 1.75;
                                font-style: italic; color: var(--ink);
                                border-left: 3px solid var(--sage);
                                padding-left: var(--space-4);
                                margin-bottom: ${r.summary ? 'var(--space-3)' : '0'};
                            ">${_esc(r.insight)}</p>
                            ${r.summary ? `<p style="font-size: var(--text-sm); line-height: 1.6; color: var(--warm-grey);">${_esc(r.summary)}</p>` : ''}
                        </div>
                    ` : ''}

                    <div style="height: 1px; background: rgba(44,36,22,0.07); margin-bottom: var(--space-5);"></div>

                    <!-- When it applies -->
                    <div style="margin-bottom: var(--space-5);">
                        <p style="font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.08em; color: var(--warm-grey); font-weight: 600; margin-bottom: var(--space-2);">When this applies</p>
                        <p style="font-size: var(--text-sm); line-height: 1.65; color: var(--ink);">${_esc(r.trigger)}</p>
                    </div>

                    <!-- What to do — numbered steps -->
                    <div style="margin-bottom: var(--space-5);">
                        <p style="font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.08em; color: var(--warm-grey); font-weight: 600; margin-bottom: var(--space-3);">What to do</p>
                        ${steps.length > 0
                            ? `<ol style="padding: 0; margin: 0; list-style: none;">
                                ${steps.map((step, si) => `
                                    <li style="
                                        display: flex; gap: var(--space-3);
                                        padding: var(--space-2) 0;
                                        ${si < steps.length - 1 ? 'border-bottom: 1px solid rgba(44,36,22,0.05);' : ''}
                                    ">
                                        <span style="font-size: var(--text-xs); font-weight: 700; color: var(--ember); min-width: 20px; padding-top: 2px;">${si + 1}</span>
                                        <p style="font-size: var(--text-sm); line-height: 1.65; color: var(--ink); margin: 0;">${_esc(step)}</p>
                                    </li>
                                `).join('')}
                               </ol>`
                            : `<p style="font-size: var(--text-sm); line-height: 1.65; color: var(--ink);">${_esc(r.actionSequence ?? '')}</p>`
                        }
                    </div>

                    <!-- What it produces -->
                    <div style="
                        margin-bottom: var(--space-5);
                        padding: var(--space-4);
                        background: rgba(61,139,110,0.05);
                        border-radius: var(--radius-md);
                        border: 1px solid rgba(61,139,110,0.12);
                    ">
                        <p style="font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.08em; color: var(--sage); font-weight: 600; margin-bottom: var(--space-2);">What it produces</p>
                        <p style="font-size: var(--text-sm); line-height: 1.65; color: var(--ink);">${_esc(r.expectedOutcome)}</p>
                    </div>

                    <!-- Flaw pattern — what less experienced people tend to do -->
                    ${r.flawPattern ? `
                        <div style="
                            margin-bottom: var(--space-5);
                            padding: var(--space-4);
                            background: rgba(180,80,30,0.04);
                            border-radius: var(--radius-md);
                            border: 1px solid rgba(180,80,30,0.1);
                        ">
                            <p style="font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.08em; color: var(--ember); font-weight: 600; margin-bottom: var(--space-2);">What less experienced people tend to do</p>
                            <p style="font-size: var(--text-sm); line-height: 1.65; color: var(--ink);">${_esc(r.flawPattern)}</p>
                        </div>
                    ` : ''}

                    <!-- Source material link — fetches raw content on demand -->
                    ${r.extractionId ? `
                        <div style="padding-top: var(--space-4); border-top: 1px solid rgba(44,36,22,0.07);">
                            <button
                                id="recipe-source-${r.id}"
                                style="background: none; border: none; cursor: pointer; padding: 0; font-size: var(--text-xs); color: var(--warm-grey); text-decoration: underline; text-underline-offset: 2px;"
                            >See source material</button>
                            <div id="recipe-source-content-${r.id}" style="display: none; margin-top: var(--space-3);">
                                <div style="
                                    background: rgba(44,36,22,0.03);
                                    border-left: 2px solid rgba(44,36,22,0.1);
                                    border-radius: var(--radius-md);
                                    padding: var(--space-4);
                                    max-height: 320px;
                                    overflow-y: auto;
                                ">
                                    <p id="recipe-source-text-${r.id}" class="text-xs text-secondary" style="line-height: 1.8;">Loading…</p>
                                </div>
                            </div>
                        </div>
                    ` : ''}

                </div>
            </div>

            <!-- Send for review panel — hidden until button clicked -->
            <div id="recipe-review-panel-${r.id}" style="display: none; padding: var(--space-5); border-top: 1px solid rgba(44,36,22,0.07);">
                <p class="label mb-2">Send for Reviewer validation</p>
                <p class="text-sm text-secondary mb-3">A Reviewer will see this as a quality check — they will not know it is part of a knowledge base.</p>
                <select class="input mb-3" id="review-reviewer-${r.id}" style="margin-bottom: var(--space-3);">
                    <option value="">Choose a Reviewer…</option>
                </select>
                <p id="review-status-${r.id}" class="text-xs text-secondary mb-2"></p>
                <button class="btn btn-primary" id="review-send-${r.id}" style="font-size: var(--text-sm);">Send</button>
            </div>
        </div>
    `;
}

// ---------------------------------------------------------------------------
// KB SUB-SECTION: Skill areas (DOMAIN-02)
// Manual domain creation always shown first.
// AI clustering shown only when recipe count >= 3.
// Provisional seeds shown as dismissible cards.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Clear all provisional seed domains from Firestore once the Manager has
// confirmed at least one real Skill Area. Provisional domains are industry
// seeds created at org provisioning time — they have served their purpose
// once real domains exist. Deleting from Firestore (not just hiding) ensures
// they vanish from the track assignment panel and training view too.
// Updates the in-memory _domains array immediately so the session stays clean.
// ---------------------------------------------------------------------------
async function _clearProvisionalDomains(orgId) {
    const provisional = _domains.filter(d => d.provisional);
    if (provisional.length === 0) return;

    const { db: _db } = await import('../firebase.js');
    const { doc: _doc, deleteDoc } = await import(
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );
    for (const d of provisional) {
        try {
            await deleteDoc(_doc(_db, 'organisations', orgId, 'domains', d.id));
            console.log('LORE dashboard.js: Provisional domain deleted —', d.name, '(', d.id, ')');
        } catch (err) {
            console.warn('LORE dashboard.js: Could not delete provisional domain:', d.id, err);
        }
    }
    // Remove from the in-memory array so the rest of the session sees a clean list
    _domains = _domains.filter(d => !d.provisional);
}

async function renderKbDomains(el) {
    const confirmed   = _domains.filter(d => !d.provisional);
    const provisional = _domains.filter(d =>  d.provisional);
    const canCluster  = _recipes.length >= 3;

    // State flag: whether any confirmed domains exist yet.
    // Controls the layout priority — confirmed domains are dominant once created.
    const hasConfirmed = confirmed.length > 0;

    // Check for unassigned Employees asynchronously so the page renders
    // immediately and the nudge appears once the data is ready.
    // Only run the check when confirmed domains exist — if there are none,
    // the Manager's next job is to create them, not to assign anyone.
    let unassignedEmployees = [];
    if (hasConfirmed) {
        try {
            const { db: _db } = await import('../firebase.js');
            const { collection: _col, query: _q, where: _wh, getDocs: _gd } = await import(
                'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
            );
            const empSnap = await _gd(
                _q(_col(_db, 'organisations', _orgId, 'users'), _wh('role', '==', 'employee'))
            );
            unassignedEmployees = empSnap.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .filter(u => !u.assignedDomains || u.assignedDomains.length === 0);
        } catch (err) {
            console.warn('LORE dashboard.js: Could not check Employee assignment status.', err);
        }
    }

    const showAssignmentNudge = hasConfirmed && unassignedEmployees.length > 0;

    // ---------------------------------------------------------------------------
    // Two distinct layout states:
    //
    // EMPTY STATE (no confirmed domains yet):
    //   A prominent directed prompt explains why skill areas matter and what to
    //   do. The creation form follows as the primary action. The clustering card
    //   is secondary. Provisional seeds appear below as starting-point reference.
    //
    // POST-CREATION STATE (at least one confirmed domain exists):
    //   Confirmed domains are the dominant element — rendered first, full-width,
    //   with ember accent bars. The assignment nudge (if needed) follows directly
    //   below. The creation form collapses to a secondary toggle below the list.
    //   The clustering card steps back to a quiet secondary option. Provisional
    //   seeds are auto-deleted from Firestore so they cannot appear anywhere.
    // ---------------------------------------------------------------------------

    if (!hasConfirmed) {
        // -----------------------------------------------------------------------
        // EMPTY STATE — no confirmed skill areas yet.
        // The prompt to create skill areas takes full visual priority.
        // -----------------------------------------------------------------------
        el.innerHTML = `
            <div>
                <!-- Primary prompt — dominant visual presence before any confirmed
                     domains exist. Framed around value, not feature names. -->
                <div style="
                    padding: var(--space-6);
                    margin-bottom: var(--space-6);
                    background: rgba(196,98,45,0.05);
                    border: 1px solid rgba(196,98,45,0.15);
                    border-radius: var(--radius-lg);
                    border-left: 4px solid var(--ember);
                ">
                    <div style="display: flex; align-items: flex-start; gap: var(--space-4);">
                        <div style="
                            width: 40px; height: 40px;
                            border-radius: 50%;
                            background: rgba(196,98,45,0.12);
                            display: flex; align-items: center; justify-content: center;
                            flex-shrink: 0; margin-top: 2px;
                        ">
                            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M9 2v7m0 3h.01" stroke="var(--ember)" stroke-width="1.75" stroke-linecap="round"/>
                                <circle cx="9" cy="9" r="7.5" stroke="var(--ember)" stroke-width="1.5"/>
                            </svg>
                        </div>
                        <div>
                            <p style="font-weight: 700; font-size: var(--text-base); margin-bottom: var(--space-2); color: var(--ink);">
                                Define your skill areas before assigning training tracks
                            </p>
                            <p class="text-secondary text-sm" style="line-height: 1.7; margin-bottom: 0;">
                                Skill areas tell LORE which practice areas your organisation values.
                                They determine what scenarios Employees train against and which Reviewers
                                are notified when an Employee misses something. Create at least one
                                before assigning any team members to a track.
                            </p>
                        </div>
                    </div>
                </div>

                <!-- Creation form — primary action in empty state -->
                <div class="card" style="margin-bottom: var(--space-5);">
                    <h3 style="margin-bottom: var(--space-2);">Create a skill area</h3>
                    <p class="text-secondary text-sm mb-4" style="line-height: 1.6;">
                        Name a practice area that matters to your organisation. You can always
                        rename it or add more later.
                    </p>
                    <div class="auth-field">
                        <label class="label mb-1">Skill area name</label>
                        <input class="input" id="new-domain-name" type="text"
                            placeholder="e.g. Client Engagement" style="margin-bottom: var(--space-3);">
                    </div>
                    <div class="auth-field">
                        <label class="label mb-1">Description (optional)</label>
                        <input class="input" id="new-domain-desc" type="text"
                            placeholder="One sentence describing this skill area…">
                    </div>
                    <p id="new-domain-error" class="text-xs" style="color: var(--error); margin-top: var(--space-2); display: none;"></p>
                    <button class="btn btn-primary mt-4" id="create-domain-btn" style="font-size: var(--text-sm);">
                        Create skill area
                    </button>
                </div>

                <!-- AI clustering — secondary option, shown only when enough recipes exist -->
                ${canCluster ? `
                    <div class="card" style="margin-bottom: var(--space-6); opacity: 0.9;">
                        <h3 style="margin-bottom: var(--space-2);">Or — let LORE suggest skill areas</h3>
                        <p class="text-secondary text-sm mb-4" style="line-height: 1.6;">
                            LORE can group your ${_recipes.length} approved recipes into suggested skill
                            areas. You confirm, rename, or adjust them before anything is created.
                        </p>
                        ${_clusters.length > 0 ? _renderProposedClusters() : `
                            <button class="btn btn-secondary" id="run-clustering" style="font-size: var(--text-sm);">
                                Suggest skill areas from recipes
                            </button>
                        `}
                    </div>
                ` : ''}

                <!-- Provisional seed domains — reference only, below the action -->
                ${provisional.length > 0 ? `
                    <div style="margin-top: var(--space-4);">
                        <div style="display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-3);">
                            <p style="font-size: var(--text-sm); font-weight: 500; color: var(--warm-grey);">Starting points</p>
                            <span style="
                                font-size: var(--text-xs);
                                color: var(--warm-grey);
                                background: rgba(44,36,22,0.05);
                                border-radius: 100px;
                                padding: 2px var(--space-3);
                            ">Based on your industry</span>
                        </div>
                        <p class="text-secondary text-sm mb-4" style="line-height: 1.6;">
                            These provisional areas are seeded from your industry. Use them as
                            inspiration or dismiss any that don't apply — they are replaced
                            automatically once you create your own skill areas.
                        </p>
                        ${provisional.map(d => `
                            <div class="card" style="
                                margin-bottom: var(--space-3);
                                opacity: 0.7;
                                padding: var(--space-4) var(--space-5);
                            ">
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

    } else {
        // -----------------------------------------------------------------------
        // POST-CREATION STATE — confirmed skill areas exist.
        // Confirmed domains are the dominant element. Creation and clustering
        // step back to collapsed secondary affordances below the list.
        // -----------------------------------------------------------------------
        el.innerHTML = `
            <div>
                <!-- Assignment nudge — most urgent next step when domains exist
                     but Employees have no track yet. Shown above the domain list. -->
                ${showAssignmentNudge ? `
                    <div style="
                        display: flex;
                        gap: var(--space-4);
                        align-items: flex-start;
                        padding: var(--space-5);
                        margin-bottom: var(--space-6);
                        background: rgba(196,98,45,0.06);
                        border: 1px solid rgba(196,98,45,0.2);
                        border-radius: var(--radius-lg);
                        border-left: 4px solid var(--ember);
                    ">
                        <div style="
                            width: 36px; height: 36px;
                            border-radius: 50%;
                            background: rgba(196,98,45,0.12);
                            display: flex; align-items: center; justify-content: center;
                            flex-shrink: 0;
                        ">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M8 3v5M8 11h.01" stroke="var(--ember)" stroke-width="1.5" stroke-linecap="round"/>
                                <circle cx="8" cy="8" r="6.5" stroke="var(--ember)" stroke-width="1.5"/>
                            </svg>
                        </div>
                        <div style="flex: 1;">
                            <p style="font-weight: 700; font-size: var(--text-sm); margin-bottom: var(--space-1); color: var(--ink);">
                                ${unassignedEmployees.length === 1
                                    ? 'One Employee has no skill areas assigned yet'
                                    : `${unassignedEmployees.length} Employees have no skill areas assigned yet`}
                            </p>
                            <p class="text-secondary text-sm" style="line-height: 1.6; margin-bottom: var(--space-3);">
                                Your skill areas are confirmed. Assign each Employee a track in
                                Team members so their training can begin.
                            </p>
                            <button class="btn btn-secondary" id="domains-go-assign"
                                style="font-size: var(--text-sm); border-color: rgba(196,98,45,0.3); color: var(--ember);">
                                Go to Team members →
                            </button>
                        </div>
                    </div>
                ` : ''}

                <!-- Confirmed skill areas — dominant element -->
                <div style="margin-bottom: var(--space-6);">
                    <div style="
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        margin-bottom: var(--space-5);
                    ">
                        <h3>Your skill areas</h3>
                        <span style="
                            font-size: var(--text-xs);
                            color: var(--warm-grey);
                            background: rgba(44,36,22,0.05);
                            border-radius: 100px;
                            padding: 2px var(--space-3);
                        ">${confirmed.length} confirmed</span>
                    </div>

                    ${confirmed.map(d => `
                        <div class="card" style="
                            margin-bottom: var(--space-3);
                            padding: 0;
                            overflow: hidden;
                        ">
                            <div style="display: flex; align-items: stretch;">
                                <!-- Ember left accent bar -->
                                <div style="
                                    width: 4px;
                                    background: var(--ember);
                                    border-radius: var(--radius-lg) 0 0 var(--radius-lg);
                                    flex-shrink: 0;
                                "></div>
                                <div style="
                                    flex: 1;
                                    padding: var(--space-5) var(--space-6);
                                    display: flex;
                                    justify-content: space-between;
                                    align-items: center;
                                    gap: var(--space-4);
                                ">
                                    <div style="min-width: 0;">
                                        <p style="font-weight: 700; font-size: var(--text-base); color: var(--ink);">${_esc(d.name)}</p>
                                        ${d.description
                                            ? `<p class="text-secondary text-sm" style="margin-top: var(--space-1); line-height: 1.5;">${_esc(d.description)}</p>`
                                            : ''}
                                    </div>
                                    <div style="flex-shrink: 0; text-align: right;">
                                        <span style="
                                            display: inline-block;
                                            font-size: var(--text-xs);
                                            font-weight: 700;
                                            color: ${(d.recipeIds ?? []).length > 0 ? 'var(--ember)' : 'var(--warm-grey)'};
                                            background: ${(d.recipeIds ?? []).length > 0 ? 'rgba(196,98,45,0.1)' : 'rgba(44,36,22,0.05)'};
                                            border-radius: 100px;
                                            padding: 3px var(--space-3);
                                            white-space: nowrap;
                                        ">${(d.recipeIds ?? []).length} recipe${(d.recipeIds ?? []).length !== 1 ? 's' : ''}</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>

                <!-- Secondary section — creation form and clustering as collapsed
                     toggles below the confirmed domain list -->
                <div style="
                    border-top: 1px solid rgba(44,36,22,0.08);
                    padding-top: var(--space-5);
                ">
                    <!-- Collapsed creation form -->
                    <div style="margin-bottom: var(--space-4);">
                        <button class="btn btn-secondary" id="toggle-create-domain"
                            style="font-size: var(--text-sm); color: var(--warm-grey);">
                            + Add another skill area
                        </button>
                        <div id="create-domain-form" style="display: none; margin-top: var(--space-4);">
                            <div class="auth-field">
                                <label class="label mb-1">Skill area name</label>
                                <input class="input" id="new-domain-name" type="text"
                                    placeholder="e.g. Client Engagement" style="margin-bottom: var(--space-3);">
                            </div>
                            <div class="auth-field">
                                <label class="label mb-1">Description (optional)</label>
                                <input class="input" id="new-domain-desc" type="text"
                                    placeholder="One sentence describing this skill area…">
                            </div>
                            <p id="new-domain-error" class="text-xs" style="color: var(--error); margin-top: var(--space-2); display: none;"></p>
                            <button class="btn btn-primary mt-4" id="create-domain-btn" style="font-size: var(--text-sm);">
                                Create skill area
                            </button>
                        </div>
                    </div>

                    <!-- Collapsed clustering option -->
                    ${canCluster ? `
                        <div>
                            <button class="btn btn-secondary" id="toggle-clustering"
                                style="font-size: var(--text-sm); color: var(--warm-grey);">
                                Suggest skill areas from recipes
                            </button>
                            <div id="clustering-panel" style="display: none; margin-top: var(--space-4);">
                                <p class="text-secondary text-sm mb-4" style="line-height: 1.6;">
                                    LORE will group your ${_recipes.length} recipes into suggested skill areas.
                                    You confirm, rename, or adjust them before anything is created.
                                </p>
                                ${_clusters.length > 0 ? _renderProposedClusters() : `
                                    <button class="btn btn-secondary" id="run-clustering" style="font-size: var(--text-sm);">
                                        Run suggestion
                                    </button>
                                `}
                            </div>
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    }

    // ---------------------------------------------------------------------------
    // Event handlers — attached after innerHTML is set, regardless of state branch.
    // ---------------------------------------------------------------------------

    // Assignment nudge — routes to Team members.
    // _activeTeamSection is set BEFORE renderTeamTab so that renderTeamTab's
    // internal call to _switchTeamSection(_activeTeamSection) requests 'members'
    // directly. Without this, _activeTeamSection defaults to 'progress', which
    // fires the async renderTeamProgress — that async call resolves later and
    // overwrites the members view, causing the routing bug.
    document.getElementById('domains-go-assign')?.addEventListener('click', () => {
        _activeTab         = 'team';
        _activeTeamSection = 'members';
        _setActiveTabStyle('team');
        renderTeamTab(document.getElementById('dashboard-tab-content'));
    });

    // Toggle the collapsed creation form in the post-creation state
    document.getElementById('toggle-create-domain')?.addEventListener('click', () => {
        const form = document.getElementById('create-domain-form');
        if (!form) return;
        const isOpen = form.style.display !== 'none';
        form.style.display = isOpen ? 'none' : 'block';
        const btn = document.getElementById('toggle-create-domain');
        if (btn) btn.textContent = isOpen ? '+ Add another skill area' : '− Cancel';
    });

    // Toggle the clustering panel in the post-creation state
    document.getElementById('toggle-clustering')?.addEventListener('click', () => {
        const panel = document.getElementById('clustering-panel');
        if (!panel) return;
        const isOpen = panel.style.display !== 'none';
        panel.style.display = isOpen ? 'none' : 'block';
        const btn = document.getElementById('toggle-clustering');
        if (btn) btn.textContent = isOpen ? 'Suggest skill areas from recipes' : '− Cancel';
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
            // Auto-clear provisional seeds now that a real domain exists.
            // Runs before the reload so the reload returns a clean list.
            await _clearProvisionalDomains(_orgId);
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
            btn.textContent = 'Suggest skill areas from recipes';
        }
    });

    // Dismiss provisional domain handlers
    provisional.forEach(d => {
        document.getElementById(`dismiss-provisional-${d.id}`)?.addEventListener('click', async () => {
            await deleteDomain(_orgId, d.id);
            // Remove from local array before re-rendering so the card disappears immediately
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
            // Auto-clear provisional seeds now that a real domain exists.
            // Runs before the reload so the reload returns a clean list.
            await _clearProvisionalDomains(_orgId);
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

// ---------------------------------------------------------------------------
// Check whether any flagged responses exist.
// Used to determine visibility of the corpus analysis card in Add knowledge.
// Returns a boolean.
// ---------------------------------------------------------------------------
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
        case 'members':  renderTeamMembers(el);       break;
        case 'progress': renderTeamProgress(el);      break;
        case 'ttc':      renderTimeToReadiness(el);   break;
        case 'reviewer': renderReviewerActivity(el);  break;
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
    const { collection, onSnapshot, query, where } = await import(
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
    );

    const listEl = document.getElementById('team-list');
    if (!listEl) return;

    // Use onSnapshot on both queries so the team list updates in real time
    // when an invite is redeemed — no page refresh needed.
    // Both start as null; _renderTeamList waits until both have fired once.
    let _users          = null;
    let _pendingInvites = null;

    function _renderTeamList() {
        if (_users === null || _pendingInvites === null) return;

        const now            = new Date();
        const pendingInvites = _pendingInvites.filter(inv => {
            if (!inv.expiresAt) return true;
            const expiry = inv.expiresAt.toDate ? inv.expiresAt.toDate() : new Date(inv.expiresAt);
            return expiry > now;
        });

        if (_users.length === 0 && pendingInvites.length === 0) {
            listEl.innerHTML = `
                <div style="
                    padding: var(--space-8) var(--space-6);
                    background: rgba(196,98,45,0.04);
                    border: 1px solid rgba(196,98,45,0.12);
                    border-radius: var(--radius-lg);
                    border-left: 4px solid var(--ember);
                    text-align: center;
                ">
                    <p style="font-weight: 600; color: var(--ink); margin-bottom: var(--space-2);">
                        No team members yet
                    </p>
                    <p class="text-secondary text-sm" style="line-height: 1.7; max-width: 380px; margin: 0 auto;">
                        Use the Invite someone button above to send personal invite links to your
                        Employees and Reviewers. Each link expires after 7 days.
                    </p>
                </div>
            `;
            return;
        }

        // Render pending invites as a separate section above or below active members.
        // Each pending invite shows name, email, role, and a copyable invite link.
        const inviteBase = 'https://lore-platform.github.io/lore/';
        const pendingHtml = pendingInvites.length > 0 ? `
            <div style="margin-bottom: var(--space-6);">
                <p class="label" style="margin-bottom: var(--space-3); color: var(--warm-grey);">
                    Invited — pending
                </p>
                ${pendingInvites.map(inv => {
                    const inviteUrl = `${inviteBase}?invite=${inv.id}`;
                    return `
                        <div class="card" style="margin-bottom: var(--space-3); opacity: 0.85;">
                            <div class="flex-between" style="margin-bottom: var(--space-3);">
                                <div>
                                    <p style="font-weight: 500;">${_esc(inv.displayName ?? inv.email ?? 'Invited person')}</p>
                                    <p class="text-secondary text-sm mt-1">${_esc(inv.email ?? '')}${inv.roleTitle ? ' · ' + _esc(inv.roleTitle) : ''}</p>
                                </div>
                                <span class="chip chip-pending" style="font-size: var(--text-xs);">${_esc(inv.role ?? 'employee')}</span>
                            </div>
                            <div style="display: flex; gap: var(--space-2); align-items: center;">
                                <input
                                    class="input"
                                    value="${_esc(inviteUrl)}"
                                    readonly
                                    style="flex: 1; font-size: var(--text-xs); color: var(--warm-grey); cursor: default;"
                                    id="pending-invite-url-${inv.id}"
                                >
                                <button
                                    class="btn btn-secondary"
                                    id="copy-pending-${inv.id}"
                                    style="font-size: var(--text-xs); padding: var(--space-1) var(--space-3); white-space: nowrap;"
                                >Copy link</button>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        ` : '';

        if (_users.length === 0) {
            listEl.innerHTML = pendingHtml + `
                <div class="empty-state">
                    <p class="text-secondary">No accepted team members yet.</p>
                </div>
            `;
            // Attach copy handlers for pending invites
            pendingInvites.forEach(inv => {
                const inviteUrl = `${inviteBase}?invite=${inv.id}`;
                document.getElementById(`copy-pending-${inv.id}`)?.addEventListener('click', () => {
                    navigator.clipboard.writeText(inviteUrl).then(() => {
                        const btn = document.getElementById(`copy-pending-${inv.id}`);
                        if (btn) btn.textContent = 'Copied';
                    });
                });
            });
            return;
        }

        listEl.innerHTML = pendingHtml + _users.map(u => `
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

        // Attach copy handlers for pending invite links
        pendingInvites.forEach(inv => {
            const inviteUrl = `${inviteBase}?invite=${inv.id}`;
            document.getElementById(`copy-pending-${inv.id}`)?.addEventListener('click', () => {
                navigator.clipboard.writeText(inviteUrl).then(() => {
                    const btn = document.getElementById(`copy-pending-${inv.id}`);
                    if (btn) btn.textContent = 'Copied';
                });
            });
        });

        // Attach track panel toggle and save handlers for each employee
        _users.filter(u => u.role === 'employee').forEach(u => {
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
                const checkedBoxes    = document.querySelectorAll(`.track-domain-check-${u.id}:checked`);
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

    } // end _renderTeamList

    // Subscribe to the users collection — fires immediately and on every write.
    const unsubUsers = onSnapshot(
        collection(db, 'organisations', _orgId, 'users'),
        (snap) => {
            _users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            console.log('LORE dashboard.js: Team users snapshot —', _users.length, 'members.');
            _renderTeamList();
        },
        (err) => {
            console.warn('LORE dashboard.js: Team users snapshot error.', err);
            listEl.innerHTML = '<p class="text-secondary text-sm">Could not load team list.</p>';
        }
    );

    // Subscribe to pending invites — fires when an invite is redeemed so the
    // pending entry disappears and the user moves to the active members list.
    const unsubInvites = onSnapshot(
        query(
            collection(db, 'invites'),
            where('orgId',     '==', _orgId),
            where('createdBy', '==', _uid),
            where('redeemed',  '==', false),
        ),
        (snap) => {
            _pendingInvites = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            console.log('LORE dashboard.js: Pending invites snapshot —', _pendingInvites.length, 'pending.');
            _renderTeamList();
        },
        (err) => {
            console.warn('LORE dashboard.js: Pending invites snapshot error.', err);
            // Non-fatal — active members will still render
            _pendingInvites = _pendingInvites ?? [];
            _renderTeamList();
        }
    );

    // Store a combined unsubscribe so the tab-switch handler can clean up both
    _teamListUnsub = () => { unsubUsers(); unsubInvites(); };
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
                textEl.textContent     = result.text;
                textEl.style.color     = 'var(--ink)';
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
        // recipe_reviews_completed is fetched per-Reviewer below — initialise to 0 here
        activityByReviewer[r.id] = {
            scenario_review:          0,
            mentorship_note:          0,
            document_chunk:           0,
            approved:                 0,
            recipe_reviews_completed: 0,
        };
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

    // Fetch completed recipe_review tasks for every Reviewer in parallel.
    // Each task lives at organisations/{orgId}/users/{reviewerId}/tasks
    // and has type === 'recipe_review' and status === 'completed'.
    // We run all fetches concurrently so the total wait is one round-trip, not N.
    try {
        await Promise.all(reviewers.map(async r => {
            const taskSnap = await gd(q(
                col(firestoreDb, 'organisations', _orgId, 'users', r.id, 'tasks'),
                wh('type',   '==', 'recipe_review'),
                wh('status', '==', 'completed'),
            ));
            activityByReviewer[r.id].recipe_reviews_completed = taskSnap.size;
        }));
    } catch (err) {
        // Non-fatal — the other three metrics will still render
        console.warn('LORE dashboard.js: Could not load recipe_review task counts.', err);
    }

    el.innerHTML = `
        <div>
            <!-- Section header with a subtle decorative accent -->
            <div style="
                display: flex;
                align-items: flex-start;
                justify-content: space-between;
                margin-bottom: var(--space-6);
                padding-bottom: var(--space-4);
                border-bottom: 1px solid rgba(44,36,22,0.07);
            ">
                <div>
                    <h3 style="margin-bottom: var(--space-1);">Reviewer activity</h3>
                    <p class="text-secondary text-sm" style="line-height: 1.6;">
                        Contributions from each Reviewer across scenarios, mentorship, recipe validation, and approved knowledge.
                    </p>
                </div>
                <span style="
                    font-size: var(--text-xs);
                    font-weight: 600;
                    color: var(--warm-grey);
                    background: rgba(44,36,22,0.05);
                    border-radius: 100px;
                    padding: var(--space-1) var(--space-3);
                    white-space: nowrap;
                    margin-left: var(--space-4);
                    flex-shrink: 0;
                ">${reviewers.length} reviewer${reviewers.length !== 1 ? 's' : ''}</span>
            </div>
            ${reviewers.map(r => {
                const activity = activityByReviewer[r.id];
                // Total counts all interaction types for the active/inactive chip
                const total    = (activity.scenario_review ?? 0)
                               + (activity.mentorship_note ?? 0)
                               + (activity.recipe_reviews_completed ?? 0);
                // Metric definitions — label, value, accent colour
                const metrics = [
                    {
                        label: 'Scenarios reviewed',
                        value: activity.scenario_review ?? 0,
                        colour: 'var(--ink)',
                    },
                    {
                        label: 'Mentorship notes',
                        value: activity.mentorship_note ?? 0,
                        colour: 'var(--ink)',
                    },
                    {
                        label: 'Recipes reviewed',
                        value: activity.recipe_reviews_completed ?? 0,
                        colour: 'var(--ember)',
                    },
                    {
                        label: 'Recipes contributed',
                        value: activity.approved ?? 0,
                        colour: 'var(--sage)',
                    },
                ];
                return `
                    <div class="card" style="
                        margin-bottom: var(--space-4);
                        padding: 0;
                        overflow: hidden;
                    ">
                        <!-- Card header — name, title, active chip -->
                        <div style="
                            padding: var(--space-4) var(--space-5);
                            background: rgba(44,36,22,0.025);
                            border-bottom: 1px solid rgba(44,36,22,0.07);
                            display: flex;
                            justify-content: space-between;
                            align-items: center;
                        ">
                            <div>
                                <p style="font-weight: 600; font-size: var(--text-base);">${_esc(r.displayName ?? r.email ?? 'Reviewer')}</p>
                                ${r.roleTitle ? `<p class="text-secondary text-sm" style="margin-top: 2px;">${_esc(r.roleTitle)}</p>` : ''}
                            </div>
                            <span class="chip chip-${total > 0 ? 'correct' : 'pending'}" style="flex-shrink: 0; margin-left: var(--space-3);">
                                ${total > 0 ? 'Active' : 'No contributions yet'}
                            </span>
                        </div>

                        <!-- Four metrics in a responsive flex row —
                             flex-wrap means they reflow to 2×2 on narrow viewports
                             without overflow or cramping. Each metric is flex: 1
                             with a min-width so they never get too thin. -->
                        <div style="
                            padding: var(--space-5);
                            display: flex;
                            flex-wrap: wrap;
                            gap: var(--space-4);
                        ">
                            ${metrics.map(m => `
                                <div style="
                                    flex: 1 1 110px;
                                    padding: var(--space-3) var(--space-4);
                                    background: rgba(44,36,22,0.02);
                                    border-radius: var(--radius-md);
                                    border: 1px solid rgba(44,36,22,0.06);
                                ">
                                    <p class="text-xs text-secondary" style="
                                        text-transform: uppercase;
                                        letter-spacing: 0.06em;
                                        margin-bottom: var(--space-2);
                                        line-height: 1.4;
                                    ">${m.label}</p>
                                    <p style="
                                        font-size: var(--text-2xl);
                                        font-weight: 700;
                                        line-height: 1;
                                        color: ${m.value > 0 ? m.colour : 'var(--warm-grey)'};
                                    ">${m.value}</p>
                                </div>
                            `).join('')}
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

// Shared upload form markup — used in both first-run and normal upload sections.
//
// Two ways to add content:
//   1. File upload — the Manager drops or selects a file. The browser reads it
//      to base64 and sends it to the Worker's parseDocument mode. Gemini converts
//      it to text and the textarea is pre-populated for the Manager to review.
//   2. Paste — the Manager pastes raw text directly. Works exactly as before.
//
// The supported formats note is framed as capability, not limitation. It appears
// once, quietly, so the Manager knows what to expect without being alarmed.
//
// [TUNING TARGET] MAX_FILE_BYTES — 15MB leaves headroom below Gemini's ~20MB
// inline data limit while accounting for base64 encoding overhead (~33% expansion).
const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB

function _renderUploadForm() {
    return `
        <div>
            <!-- Supported formats note — framed as capability, not warning.
                 Shown once, quietly. Gives the Manager a mental model before they upload. -->
            <div style="
                background: rgba(44,36,22,0.04);
                border-radius: var(--radius-md);
                padding: var(--space-3) var(--space-4);
                margin-bottom: var(--space-5);
                display: flex;
                gap: var(--space-3);
                align-items: flex-start;
            ">
                <div style="flex: 1;">
                    <p class="text-sm" style="font-weight: 500; margin-bottom: var(--space-1);">What works best</p>
                    <p class="text-xs text-secondary" style="line-height: 1.6;">
                        Digital PDFs and plain text files come through cleanly every time.
                        Scanned documents and images usually work well too, though very blurry scans
                        may have gaps. Word documents (.docx) are supported via text extraction.
                        Files over 15MB are not supported — if your document is that large,
                        paste the most relevant sections instead.
                    </p>
                </div>
            </div>

            <!-- File upload — drop zone or click to select -->
            <div class="auth-field">
                <label class="label" for="doc-file">Upload a file</label>
                <div id="file-drop-zone" style="
                    border: 2px dashed rgba(44,36,22,0.2);
                    border-radius: var(--radius-md);
                    padding: var(--space-6) var(--space-4);
                    text-align: center;
                    cursor: pointer;
                    transition: border-color 0.15s ease, background 0.15s ease;
                    position: relative;
                ">
                    <input type="file" id="doc-file"
                        accept=".pdf,.txt,.png,.jpg,.jpeg,.webp,.docx"
                        style="position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%;">
                    <p class="text-sm text-secondary" id="file-drop-label">
                        Drop a file here, or click to choose one
                    </p>
                    <p class="text-xs text-secondary mt-2" style="opacity: 0.7;">
                        PDF · Word · Plain text · PNG · JPEG · WEBP · Up to 15MB
                    </p>
                </div>
                <p id="file-parse-status" class="text-xs mt-2" style="display: none;"></p>
            </div>

            <!-- Divider between file upload and paste -->
            <div style="
                display: flex;
                align-items: center;
                gap: var(--space-4);
                margin: var(--space-5) 0;
            ">
                <div style="flex: 1; height: 1px; background: rgba(44,36,22,0.1);"></div>
                <p class="text-xs text-secondary">or paste text directly</p>
                <div style="flex: 1; height: 1px; background: rgba(44,36,22,0.1);"></div>
            </div>

            <!-- Document name — used in the aha moment and for Firestore record -->
            <div class="auth-field">
                <label class="label" for="doc-name">Document name</label>
                <input class="input" id="doc-name" type="text"
                    placeholder="e.g. Q3 Project Retrospective"
                    value="${_esc(_uploadState.docName)}">
            </div>

            <!-- Text area — pre-populated after file parsing, or filled by paste -->
            <div class="auth-field mt-4">
                <label class="label" for="doc-text">Document content</label>
                <textarea class="input" id="doc-text" rows="12"
                    placeholder="Paste the document text here…"
                    style="resize: vertical;">${_esc(_uploadState.docText)}</textarea>
                <p id="doc-text-meta" class="text-xs text-secondary mt-2" style="${_uploadState.docText ? '' : 'display: none;'}">
                    ${_uploadState.docText ? _wordCount(_uploadState.docText) + ' words · Review before continuing' : ''}
                </p>
            </div>

            <!-- Progress log — shown during extraction pipeline, hidden at rest -->
            <div id="upload-progress-log" style="display: none; margin-top: var(--space-4);">
                <div style="
                    background: rgba(44,36,22,0.03);
                    border: 1px solid rgba(44,36,22,0.08);
                    border-radius: var(--radius-md);
                    padding: var(--space-3) var(--space-4);
                    max-height: 160px;
                    overflow-y: auto;
                " id="progress-log-inner"></div>
            </div>

            <button class="btn btn-primary mt-4" id="process-doc">Find training moments</button>
            <div id="upload-result" style="margin-top: var(--space-4);"></div>
        </div>
    `;
}

// ---------------------------------------------------------------------------
// Word count helper — used in the doc-text-meta line after file parsing.
// Counts non-empty tokens split on whitespace.
// ---------------------------------------------------------------------------
function _wordCount(text) {
    return text.trim().split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// File validation — run before sending to the Worker.
// Returns { ok: true } or { ok: false, reason: string (user-facing) }.
//
// Checks:
//   - File size under MAX_FILE_BYTES (15MB)
//   - MIME type is one we can handle (either via Gemini or DOCX XML extraction)
//
// Note: MIME type from the browser's File object can sometimes be empty for
// unusual file associations. We fall back to extension detection in that case.
// ---------------------------------------------------------------------------
function _validateFile(file) {
    const SUPPORTED_EXTENSIONS = ['.pdf', '.txt', '.png', '.jpg', '.jpeg', '.webp', '.docx'];
    const ext = '.' + file.name.split('.').pop().toLowerCase();

    if (file.size > MAX_FILE_BYTES) {
        return {
            ok:     false,
            reason: `This file is ${Math.round(file.size / (1024 * 1024))}MB — the limit is 15MB. Paste the most relevant sections instead.`,
        };
    }

    const supportedMimes = [
        'application/pdf',
        'image/jpeg',
        'image/jpg',
        'image/png',
        'image/webp',
        'text/plain',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];

    const mimeOk = supportedMimes.includes(file.type) || SUPPORTED_EXTENSIONS.includes(ext);
    if (!mimeOk) {
        return {
            ok:     false,
            reason: `${file.name} is not a supported file type. Use PDF, Word (.docx), plain text, or an image.`,
        };
    }

    return { ok: true };
}

// ---------------------------------------------------------------------------
// Derive the MIME type to send to the Worker.
// The browser's File.type can be empty for some file associations, so we
// fall back to extension-based detection.
// ---------------------------------------------------------------------------
function _resolveMimeType(file) {
    if (file.type && file.type !== 'application/octet-stream') return file.type;
    const ext = file.name.split('.').pop().toLowerCase();
    const map = {
        pdf:  'application/pdf',
        txt:  'text/plain',
        png:  'image/png',
        jpg:  'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    return map[ext] ?? file.type;
}

// ---------------------------------------------------------------------------
// DOCX client-side text extraction.
// A DOCX file is a ZIP archive. The main document text lives in
// word/document.xml inside the ZIP. We extract that XML and strip all
// tags to get the raw text content — no library needed, just native
// browser APIs (DecompressionStream, TextDecoder).
//
// Limitation: this approach strips all formatting, comments, and headers/footers.
// For LORE's purposes — feeding plain text into the extraction pipeline —
// that is exactly what we want.
//
// Returns the extracted text string, or null if extraction fails.
// ---------------------------------------------------------------------------
async function _extractDocxText(file) {
    try {
        // Read the file as an ArrayBuffer (DOCX is binary ZIP)
        const buffer = await file.arrayBuffer();

        // Use the browser's native DecompressionStream to walk the ZIP.
        // We need to find the word/document.xml entry inside the ZIP.
        // We do this by parsing the ZIP central directory manually.
        // ZIP format: local file headers at the start, central directory at the end.
        const bytes = new Uint8Array(buffer);

        // Helper: read a little-endian uint16 from bytes at offset
        const u16 = offset => bytes[offset] | (bytes[offset + 1] << 8);
        // Helper: read a little-endian uint32 from bytes at offset
        const u32 = offset => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);

        // Walk local file entries until we find word/document.xml
        let offset = 0;
        while (offset < bytes.length - 4) {
            // Local file header signature: 0x04034b50
            if (u32(offset) !== 0x04034b50) break;

            const compressionMethod = u16(offset + 8);
            const compressedSize    = u32(offset + 18);
            const fileNameLength    = u16(offset + 26);
            const extraLength       = u16(offset + 28);
            const fileNameBytes     = bytes.slice(offset + 30, offset + 30 + fileNameLength);
            const entryName         = new TextDecoder().decode(fileNameBytes);
            const dataOffset        = offset + 30 + fileNameLength + extraLength;

            if (entryName === 'word/document.xml') {
                const compressedData = bytes.slice(dataOffset, dataOffset + compressedSize);

                let xmlText;
                if (compressionMethod === 0) {
                    // Stored — no compression
                    xmlText = new TextDecoder('utf-8').decode(compressedData);
                } else if (compressionMethod === 8) {
                    // Deflate — use DecompressionStream
                    const ds     = new DecompressionStream('deflate-raw');
                    const writer = ds.writable.getWriter();
                    const reader = ds.readable.getReader();
                    writer.write(compressedData);
                    writer.close();

                    const chunks = [];
                    let totalLen = 0;
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        chunks.push(value);
                        totalLen += value.length;
                    }
                    const merged = new Uint8Array(totalLen);
                    let pos = 0;
                    for (const chunk of chunks) { merged.set(chunk, pos); pos += chunk.length; }
                    xmlText = new TextDecoder('utf-8').decode(merged);
                } else {
                    // Unsupported compression — bail
                    console.warn('LORE dashboard.js: DOCX entry uses unsupported compression method:', compressionMethod);
                    return null;
                }

                // Strip XML tags — leave only text content.
                // Paragraph tags (<w:p>) become newlines to preserve document structure.
                const withNewlines = xmlText.replace(/<\/w:p>/g, '\n');
                const plainText    = withNewlines.replace(/<[^>]+>/g, '').replace(/\r/g, '').trim();
                return plainText || null;
            }

            offset = dataOffset + compressedSize;
        }

        // word/document.xml not found — not a valid DOCX
        console.warn('LORE dashboard.js: word/document.xml not found in DOCX archive.');
        return null;

    } catch (err) {
        console.warn('LORE dashboard.js: DOCX extraction failed:', err.message);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Local fallback: plain text
// Decodes a .txt file directly in the browser — no network call, no AI.
// This mirrors what the Worker does for text/plain, so plain text files
// always succeed even when both AI models are unavailable.
// Returns the decoded string or null on failure.
// ---------------------------------------------------------------------------
async function _parseTextFileLocally(file) {
    try {
        const buffer = await file.arrayBuffer();
        const text   = new TextDecoder('utf-8').decode(new Uint8Array(buffer));
        console.log('LORE dashboard.js: _parseTextFileLocally — decoded, length:', text.length);
        return text || null;
    } catch (err) {
        console.warn('LORE dashboard.js: _parseTextFileLocally — failed:', err.message);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Local fallback: PDF text extraction via PDF.js
// Used when both Gemini models are unavailable (AI_BUSY from Worker).
// Loads PDF.js from cdnjs on demand — not bundled, only fetched when needed.
// Works reliably for digital PDFs (text-layer PDFs). Does not work for
// scanned PDFs, which are image-only and have no embedded text layer.
// For scanned PDFs the extraction will return empty or near-empty text,
// which the caller treats as a failure and surfaces a clear message.
//
// PDF.js is loaded lazily — only on first call. Subsequent calls reuse
// the already-loaded library via the _pdfjsLib module-level cache.
//
// Returns the extracted text string or null on failure.
// ---------------------------------------------------------------------------
let _pdfjsLib = null; // Module-level cache — set on first successful load

async function _parsePdfLocally(file) {
    // Load PDF.js from cdnjs if not already loaded
    if (!_pdfjsLib) {
        try {
            await new Promise((resolve, reject) => {
                // Check if already present on window (e.g. loaded by another call)
                if (window.pdfjsLib) { _pdfjsLib = window.pdfjsLib; resolve(); return; }

                const script = document.createElement('script');
                script.src   = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs';
                script.type  = 'module';
                script.onload  = () => {
                    // pdf.min.mjs exposes pdfjsLib on window when loaded as a classic
                    // module script. If not, import() is the alternative path.
                    _pdfjsLib = window.pdfjsLib ?? null;
                    resolve();
                };
                script.onerror = () => reject(new Error('PDF.js failed to load'));
                document.head.appendChild(script);
            });
        } catch (err) {
            console.warn('LORE dashboard.js: _parsePdfLocally — could not load PDF.js:', err.message);
            return null;
        }
    }

    // PDF.js may expose itself differently depending on load method.
    // Try window.pdfjsLib as the primary reference.
    const pdfjs = _pdfjsLib ?? window.pdfjsLib;
    if (!pdfjs) {
        console.warn('LORE dashboard.js: _parsePdfLocally — PDF.js not available after load.');
        return null;
    }

    try {
        // Set the worker source — required by PDF.js for parsing.
        // The worker script must match the library version.
        if (!pdfjs.GlobalWorkerOptions.workerSrc) {
            pdfjs.GlobalWorkerOptions.workerSrc =
                'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';
        }

        const buffer   = await file.arrayBuffer();
        const loadTask = pdfjs.getDocument({ data: new Uint8Array(buffer) });
        const pdf      = await loadTask.promise;

        console.log('LORE dashboard.js: _parsePdfLocally — PDF loaded, pages:', pdf.numPages);

        // Extract text from every page using position-aware line reconstruction.
        //
        // PDF.js returns text as a flat list of items, each with:
        //   item.str       — the text string for this span
        //   item.transform — a 6-element matrix where transform[5] is the y-coordinate
        //                    (vertical position from the bottom of the page)
        //   item.height    — the font height of this span in points
        //
        // Without using position data, all spans are concatenated into a wall of text
        // with no line breaks or paragraph spacing. The fix:
        //
        //   1. Sort items by descending y (PDF coordinates start from bottom-left,
        //      so a higher y value means higher on the page — we want top to bottom).
        //   2. Compare each item's y position to the previous item's y.
        //      If the y difference exceeds one line height, it is a new line (\n).
        //      If the y difference exceeds roughly 2.5 line heights, it is a new
        //      paragraph (\n\n). These thresholds catch headings, section breaks,
        //      and blank lines without being sensitive to minor baseline shifts
        //      between characters on the same line.
        //   3. Items on the same line are joined with a space.
        //
        // [TUNING TARGET] LINE_BREAK_THRESHOLD and PARA_BREAK_THRESHOLD — adjust
        // if extracted text has too many or too few paragraph breaks for typical
        // documents in this org's industry.
        const LINE_BREAK_THRESHOLD = 1.2;  // y-gap > 1.2× line height = new line
        const PARA_BREAK_THRESHOLD = 2.5;  // y-gap > 2.5× line height = paragraph

        const pageTexts = [];
        for (let i = 1; i <= pdf.numPages; i++) {
            const page    = await pdf.getPage(i);
            const content = await page.getTextContent();

            // Filter out empty strings and items with no position data
            const items = content.items.filter(item => item.str && item.transform);

            if (items.length === 0) continue;

            // Sort top-to-bottom (descending y coordinate)
            items.sort((a, b) => b.transform[5] - a.transform[5]);

            // Walk items, inserting line or paragraph breaks based on y-gap
            let pageText = '';
            let prevY    = null;
            let prevH    = null;

            for (const item of items) {
                const y    = item.transform[5];
                // Use item.height if available, fall back to a reasonable default
                const h    = (item.height && item.height > 0) ? item.height : 10;

                if (prevY === null) {
                    // First item on the page — no preceding context
                    pageText += item.str;
                } else {
                    const gap         = prevY - y; // positive = moved down the page
                    const lineHeight  = prevH ?? h;

                    if (gap > lineHeight * PARA_BREAK_THRESHOLD) {
                        // Large gap — paragraph break
                        pageText += '\n\n' + item.str;
                    } else if (gap > lineHeight * LINE_BREAK_THRESHOLD) {
                        // Normal gap — new line
                        pageText += '\n' + item.str;
                    } else {
                        // Same line — join with a space (only if not already spaced)
                        const needsSpace = pageText.length > 0
                            && !pageText.endsWith(' ')
                            && !item.str.startsWith(' ');
                        pageText += (needsSpace ? ' ' : '') + item.str;
                    }
                }

                prevY = y;
                prevH = h;
            }

            if (pageText.trim()) pageTexts.push(pageText.trim());
        }

        const fullText = pageTexts.join('\n\n');
        if (!fullText.trim()) {
            // No text layer — likely a scanned PDF
            console.warn('LORE dashboard.js: _parsePdfLocally — no text layer found. Possibly a scanned PDF.');
            return null;
        }

        console.log('LORE dashboard.js: _parsePdfLocally — extracted', fullText.length, 'chars from', pdf.numPages, 'pages.');
        return fullText;

    } catch (err) {
        console.warn('LORE dashboard.js: _parsePdfLocally — extraction failed:', err.message);
        return null;
    }
}

// Shared upload handler — onComplete is called after a successful extraction pipeline run.
//
// Two flows:
//   A. File upload — file → validate → parse (Worker or DOCX extraction) →
//      populate textarea → Manager reviews text → pipeline runs on confirm.
//   B. Paste — textarea content used directly, no parse step.
//
// The progress log is appended to during pipeline processing so the Manager
// always knows what stage is happening and how far along it is.
function _attachUploadHandlers(onComplete) {
    // Keep textarea and name input in sync with _uploadState
    document.getElementById('doc-name')?.addEventListener('input', e => { _uploadState.docName = e.target.value; });
    document.getElementById('doc-text')?.addEventListener('input', e => {
        _uploadState.docText = e.target.value;
        const metaEl = document.getElementById('doc-text-meta');
        if (metaEl) {
            if (_uploadState.docText.trim()) {
                metaEl.textContent = _wordCount(_uploadState.docText) + ' words · Review before continuing';
                metaEl.style.display = 'block';
            } else {
                metaEl.style.display = 'none';
            }
        }
    });

    // ---------------------------------------------------------------------------
    // File input — drop zone drag-and-drop and click-to-select
    // ---------------------------------------------------------------------------
    const dropZone  = document.getElementById('file-drop-zone');
    const fileInput = document.getElementById('doc-file');

    if (dropZone) {
        // Visual feedback on drag-over
        dropZone.addEventListener('dragover', e => {
            e.preventDefault();
            dropZone.style.borderColor = 'var(--ember)';
            dropZone.style.background  = 'rgba(180,80,30,0.04)';
        });
        dropZone.addEventListener('dragleave', () => {
            dropZone.style.borderColor = '';
            dropZone.style.background  = '';
        });
        dropZone.addEventListener('drop', e => {
            e.preventDefault();
            dropZone.style.borderColor = '';
            dropZone.style.background  = '';
            const file = e.dataTransfer?.files?.[0];
            if (file) _handleFileSelected(file);
        });
    }

    if (fileInput) {
        fileInput.addEventListener('change', () => {
            const file = fileInput.files?.[0];
            if (file) _handleFileSelected(file);
        });
    }

    // ---------------------------------------------------------------------------
    // Internal: handle a selected or dropped file.
    //
    // Parsing fallback chain per file type:
    //
    //   plain text  → local decode directly (no Worker, no AI, always works)
    //   DOCX        → local ZIP/XML extraction (no Worker, no AI, always works)
    //   PDF         → Worker (Gemini Flash → Flash Lite) → PDF.js local fallback
    //   images      → Worker (Gemini Flash → Flash Lite) → clear message, no local fallback
    //
    // The Worker returns { ok: false, error: 'AI_BUSY' } when both Gemini models
    // are unavailable. That is the signal to attempt local parsing.
    //
    // For images, there is no reliable local fallback — Tesseract.js is too slow
    // and inaccurate to offer a good experience. The Manager is told clearly that
    // our processing system is temporarily busy and invited to try again shortly
    // or paste the text directly.
    // ---------------------------------------------------------------------------
    async function _handleFileSelected(file) {
        const statusEl  = document.getElementById('file-parse-status');
        const labelEl   = document.getElementById('file-drop-label');
        const nameInput = document.getElementById('doc-name');
        const textArea  = document.getElementById('doc-text');
        const metaEl    = document.getElementById('doc-text-meta');

        // Validate file type and size
        const validation = _validateFile(file);
        if (!validation.ok) {
            if (statusEl) {
                statusEl.textContent   = validation.reason;
                statusEl.style.color   = 'var(--error)';
                statusEl.style.display = 'block';
            }
            return;
        }

        // Pre-fill the document name from the file name (without extension)
        const nameWithoutExt = file.name.replace(/\.[^.]+$/, '');
        if (nameInput && !nameInput.value.trim()) {
            nameInput.value      = nameWithoutExt;
            _uploadState.docName = nameWithoutExt;
        }

        if (statusEl) {
            statusEl.textContent   = `Reading ${file.name}…`;
            statusEl.style.color   = 'var(--warm-grey)';
            statusEl.style.display = 'block';
        }
        if (labelEl) labelEl.textContent = file.name;

        const mimeType = _resolveMimeType(file);
        let extractedText = null;

        // -----------------------------------------------------------------------
        // Plain text — decode locally, no Worker or AI call needed.
        // This always works regardless of AI availability.
        // -----------------------------------------------------------------------
        if (mimeType === 'text/plain') {
            extractedText = await _parseTextFileLocally(file);
            if (!extractedText) {
                if (statusEl) {
                    statusEl.textContent = 'Could not read this text file. Try pasting the content directly.';
                    statusEl.style.color = 'var(--error)';
                }
                return;
            }
            if (statusEl) {
                statusEl.textContent   = `Read successfully · ${_wordCount(extractedText)} words`;
                statusEl.style.color   = 'var(--sage)';
                statusEl.style.display = 'block';
            }
        }

        // -----------------------------------------------------------------------
        // DOCX — extract text client-side from the ZIP/XML structure.
        // No Worker call needed — avoids sending binary DOCX to Gemini, which
        // handles DOCX less reliably than PDF. Client-side XML extraction is
        // more predictable for this format and always works locally.
        // -----------------------------------------------------------------------
        else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            extractedText = await _extractDocxText(file);
            if (!extractedText) {
                if (statusEl) {
                    statusEl.textContent = 'Could not extract text from this Word document. Try saving it as a PDF and uploading that instead.';
                    statusEl.style.color = 'var(--error)';
                }
                return;
            }
            if (statusEl) {
                statusEl.textContent   = `Extracted successfully · ${_wordCount(extractedText)} words`;
                statusEl.style.color   = 'var(--sage)';
                statusEl.style.display = 'block';
            }
        }

        // -----------------------------------------------------------------------
        // PDF and images — try Worker first (Gemini Flash → Flash Lite),
        // then fall back to local parsing if the Worker returns AI_BUSY.
        // -----------------------------------------------------------------------
        else {
            const isPdf   = mimeType === 'application/pdf';
            const isImage = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(mimeType);

            if (statusEl) statusEl.textContent = 'Reading your document — this usually takes 10–20 seconds…';

            // Read file as base64 for the Worker call
            let fileBase64;
            try {
                fileBase64 = await _fileToBase64(file);
            } catch (err) {
                console.warn('LORE dashboard.js: Could not read file as base64:', err.message);
                if (statusEl) {
                    statusEl.textContent = 'Could not read this file. Try a different format or paste the text directly.';
                    statusEl.style.color = 'var(--error)';
                }
                return;
            }

            // Ping the Worker to reduce cold-start timeout risk on the real call
            await fetch('https://lore-worker.slop-runner.workers.dev', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ mode: 'ping' }),
            }).catch(() => {});

            // --- Worker call ---
            let parseResult = null;
            let workerFailed = false;

            try {
                const res = await fetch('https://lore-worker.slop-runner.workers.dev', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({
                        mode: 'parseDocument',
                        fileBase64,
                        mimeType,
                        fileName: file.name,
                    }),
                });
                parseResult = await res.json().catch(() => ({}));
            } catch (err) {
                console.warn('LORE dashboard.js: parseDocument Worker call failed (network):', err.message);
                workerFailed = true;
            }

            const aiBusy = workerFailed || !parseResult?.ok;

            if (!aiBusy) {
                // Worker succeeded
                extractedText = parseResult.text;

                // Partial content warning — document was too long for a single pass
                if (parseResult.partial) {
                    if (statusEl) {
                        statusEl.textContent = 'This document is very long — only part of it came through. Review the text below and remove irrelevant sections before continuing.';
                        statusEl.style.color   = '#8C5A0A'; // amber — warning, not error
                        statusEl.style.display = 'block';
                    }
                } else {
                    if (statusEl) {
                        statusEl.textContent   = `Read successfully · ${_wordCount(extractedText)} words extracted`;
                        statusEl.style.color   = 'var(--sage)';
                        statusEl.style.display = 'block';
                    }
                }

            } else {
                // Worker returned AI_BUSY or network failed — attempt local fallback
                console.warn('LORE dashboard.js: Worker unavailable, attempting local fallback. mimeType:', mimeType);

                if (isPdf) {
                    // PDF.js local fallback
                    if (statusEl) {
                        statusEl.textContent = 'Our processing system is currently handling a high volume of requests — reading your PDF locally instead…';
                        statusEl.style.color = '#8C5A0A';
                    }

                    extractedText = await _parsePdfLocally(file);

                    if (!extractedText) {
                        // PDF.js returned nothing — likely a scanned PDF with no text layer.
                        // At this point there is genuinely no local fallback for scanned PDFs.
                        if (statusEl) {
                            statusEl.textContent = 'Our processing system is currently handling a high volume of requests and local reading could not extract text from this file — it may be a scanned document. Please try again shortly, or paste the text directly.';
                            statusEl.style.color = 'var(--error)';
                        }
                        return;
                    }

                    if (statusEl) {
                        statusEl.textContent   = `Read locally · ${_wordCount(extractedText)} words extracted · Note: our processing system was temporarily busy`;
                        statusEl.style.color   = '#8C5A0A'; // amber — success but via fallback, worth noting
                        statusEl.style.display = 'block';
                    }

                } else if (isImage) {
                    // No local fallback for images — surface a clear, honest message
                    if (statusEl) {
                        statusEl.textContent = 'Our processing system is currently handling a high volume of requests and cannot read image files locally. Please try again shortly, or paste the text directly.';
                        statusEl.style.color = 'var(--error)';
                    }
                    return;

                } else {
                    // Unsupported type that slipped through — should not happen but handle gracefully
                    if (statusEl) {
                        statusEl.textContent = 'Could not read this file. Try a different format or paste the text directly.';
                        statusEl.style.color = 'var(--error)';
                    }
                    return;
                }
            }
        }

        // Populate the textarea with the extracted text for Manager review
        if (textArea) {
            textArea.value       = extractedText;
            _uploadState.docText = extractedText;
        }
        if (metaEl) {
            metaEl.textContent   = _wordCount(extractedText) + ' words · Review before continuing';
            metaEl.style.display = 'block';
        }

        console.log('LORE dashboard.js: File parsed — name:', file.name, 'words:', _wordCount(extractedText), 'mimeType:', mimeType);
    }

    // ---------------------------------------------------------------------------
    // Process button — runs the extraction pipeline on whatever text is in the
    // textarea, whether it came from a file or was pasted directly.
    // ---------------------------------------------------------------------------
    document.getElementById('process-doc')?.addEventListener('click', async () => {
        const name = document.getElementById('doc-name')?.value?.trim();
        const text = document.getElementById('doc-text')?.value?.trim();

        if (!name || !text) {
            const resultEl = document.getElementById('upload-result');
            if (resultEl) resultEl.innerHTML = '<p class="text-secondary text-sm" style="color: var(--error);">Please enter a document name and add some content — either upload a file or paste text.</p>';
            return;
        }

        _uploadState.inProgress    = true;
        _uploadState.docName       = name;
        _uploadState.docText       = text;
        _uploadState.result        = null;
        _uploadState.errorMsg      = '';
        _uploadState.chunkProgress = null;

        // Show the progress log and start appending entries
        _showProgressLog();
        _logProgress('Starting — reading your document…');

        const btn = document.getElementById('process-doc');
        if (btn) { btn.disabled = true; btn.textContent = 'Reading…'; }

        // Re-render the upload section to show the in-progress spinner
        const kbContent = document.getElementById('kb-section-content');
        if (kbContent) renderKbUpload(kbContent);

        // Progress callback — updates chunkProgress and appends a log entry.
        // Called by processDocument() for each chunk processed.
        const onProgress = (current, total) => {
            _uploadState.chunkProgress = { current, total };
            _logProgress(`Analysing section ${current} of ${total}…`);
            const kbEl = document.getElementById('kb-section-content');
            if (kbEl && _activeKnowledgeSection === 'upload') renderKbUpload(kbEl);
        };

        // processDocument accepts uid and an onProgress callback
        const result = await processDocument(_orgId, _uid, text, name, onProgress);

        _uploadState.inProgress    = false;
        _uploadState.chunkProgress = null;
        _uploadState.result        = result;

        if (!result.ok) {
            _uploadState.errorMsg = 'Could not process the document right now. Please try again shortly.';
            _logProgress('Something went wrong — please try again.');
        } else if (result.extractionsCreated > 0) {
            _logProgress(`Done — found ${result.extractionsCreated} training moment${result.extractionsCreated !== 1 ? 's' : ''}.`);
        } else {
            _logProgress('Done — no clear training moments found in this document.');
        }

        if (result.ok && result.extractionsCreated > 0) {
            await onComplete();
        }

        const kbEl = document.getElementById('kb-section-content');
        if (kbEl && _activeKnowledgeSection === 'upload') renderKbUpload(kbEl);
    });
}

// ---------------------------------------------------------------------------
// Read a File object as a base64-encoded string.
// Returns a Promise that resolves to the base64 string (without the data URL
// prefix — just the raw base64 bytes that the Worker's parseDocument expects).
// ---------------------------------------------------------------------------
function _fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => {
            // result is a data URL: "data:<mimeType>;base64,<base64>"
            // We only want the base64 part after the comma
            const base64 = reader.result.split(',')[1];
            resolve(base64);
        };
        reader.onerror = () => reject(new Error('FileReader failed'));
        reader.readAsDataURL(file);
    });
}

// ---------------------------------------------------------------------------
// Progress log — append a timestamped entry to the visible log during pipeline
// processing. Called from _attachUploadHandlers during extraction.
// ---------------------------------------------------------------------------
function _showProgressLog() {
    const logEl = document.getElementById('upload-progress-log');
    if (logEl) {
        logEl.style.display = 'block';
        const inner = document.getElementById('progress-log-inner');
        if (inner) inner.innerHTML = '';
    }
}

function _logProgress(message) {
    const inner = document.getElementById('progress-log-inner');
    if (!inner) return;
    const now    = new Date();
    const time   = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const entry  = document.createElement('p');
    entry.className   = 'text-xs text-secondary';
    entry.style.cssText = 'margin-bottom: var(--space-1); line-height: 1.5;';
    entry.textContent = `${time} — ${message}`;
    inner.appendChild(entry);
    // Auto-scroll to latest entry
    inner.scrollTop = inner.scrollHeight;
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

// ---------------------------------------------------------------------------
// Lightweight markdown renderer for raw source content display.
// Handles the subset of markdown that appears in practitioner-contributed
// documents: blockquotes, bold, numbered lists, headings, horizontal rules,
// and line breaks within paragraphs.
//
// Process: escape HTML first so angle brackets in content are safe, then
// apply markdown patterns to the escaped text. This order is critical —
// reversing it would cause _esc() to consume the markdown characters.
//
// Returns an HTML string safe to set as innerHTML.
// ---------------------------------------------------------------------------
function _renderMarkdown(raw) {
    if (!raw) return '';

    // Split into blocks on one or more blank lines
    const blocks = raw.split(/\n{2,}/);

    return blocks.map(block => {
        const trimmed = block.trim();
        if (!trimmed) return '';

        // Escape HTML in the raw block before applying any patterns
        const esc = trimmed
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            // Do not escape > here — we detect blockquotes first using the raw char
            ;

        // Horizontal rule — a line of three or more dashes or asterisks
        if (/^[-*]{3,}$/.test(trimmed)) {
            return '<hr style="border: none; border-top: 1px solid rgba(44,36,22,0.12); margin: var(--space-4) 0;">';
        }

        // Heading — one to three # characters followed by a space
        const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
        if (headingMatch) {
            const level   = headingMatch[1].length;
            const content = _applyInlineMarkdown(
                headingMatch[2]
                    .replace(/&/g, '&amp;')
                    .replace(/"/g, '&quot;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
            );
            const size    = level === 1 ? 'var(--text-base)' : 'var(--text-sm)';
            return `<p style="font-size: ${size}; font-weight: 600; color: var(--ink); margin-bottom: var(--space-2); line-height: 1.5;">${content}</p>`;
        }

        // Blockquote — every line in the block starts with >
        // Strip the leading > and optional space from each line, then render
        // the inner content recursively so nested markdown is handled.
        const lines = trimmed.split('\n');
        if (lines.every(l => l.trimStart().startsWith('>'))) {
            const inner = lines
                .map(l => l.trimStart().replace(/^>\s?/, ''))
                .join('\n');
            const innerHtml = _renderMarkdown(inner);
            return `<blockquote style="
                border-left: 2px solid rgba(44,36,22,0.2);
                margin: 0 0 var(--space-3) 0;
                padding: var(--space-2) var(--space-4);
                color: var(--warm-grey);
                font-size: var(--text-xs);
                line-height: 1.8;
            ">${innerHtml}</blockquote>`;
        }

        // Numbered list — one or more lines starting with a digit and period
        if (lines.some(l => /^\d+\.\s/.test(l.trimStart()))) {
            const items = lines
                .filter(l => /^\d+\.\s/.test(l.trimStart()))
                .map(l => {
                    const content = _applyInlineMarkdown(l.trimStart().replace(/^\d+\.\s+/, ''));
                    return `<li style="margin-bottom: var(--space-1); line-height: 1.7;">${content}</li>`;
                })
                .join('');
            return `<ol style="padding-left: var(--space-5); margin-bottom: var(--space-3); font-size: var(--text-xs); color: var(--warm-grey);">${items}</ol>`;
        }

        // Plain paragraph — apply inline markdown and preserve single line breaks
        const html = lines
            .map(l => _applyInlineMarkdown(l
                .replace(/&/g, '&amp;')
                .replace(/"/g, '&quot;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
            ))
            .join('<br>');
        return `<p style="font-size: var(--text-xs); line-height: 1.8; color: var(--warm-grey); margin-bottom: var(--space-3);">${html}</p>`;
    }).join('');
}

// ---------------------------------------------------------------------------
// Apply inline markdown patterns to an already-HTML-escaped string.
// Bold only — covers the most common pattern in practitioner writing.
// Called by _renderMarkdown() for inline content inside blocks.
// ---------------------------------------------------------------------------
function _applyInlineMarkdown(str) {
    return str
        // Bold: **text** or __text__
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/__(.+?)__/g, '<strong>$1</strong>');
}