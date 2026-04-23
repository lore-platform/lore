// =============================================================================
// LORE — Profile View (Manager, per-Employee)
// The Manager's per-Employee intelligence surface. Launched from the Team
// Progress section when the Manager clicks an Employee's row.
//
// Phase 3 additions to what was built in Phase 2:
//   - Accuracy by scenario type (judgement, recognition, reflection)
//   - Learning velocity — recent sessions vs earlier sessions
//   - Consistent blind spots — skill areas the Employee consistently misses
//   - Cognitive pattern signals — inferred tendencies from patternSignals sub-collection
//   - Enhanced AI summary prompt using all available signal
//
// Privacy architecture:
//   patternSignals sub-collection is Manager-only. Employees cannot see it.
//   The Manager sees aggregate patterns, not a log of individual mistakes.
//   No notification is ever sent to an Employee about their inferred patterns.
//
// Import paths: views/ files import engine files using ../engine/[file].js.
// =============================================================================

import { getRankForXP, RANKS } from '../engine/state.js';

// ---------------------------------------------------------------------------
// Entry point — called by app.js when a Manager navigates to an Employee.
// employeeId: the Firestore UID of the Employee being viewed.
// ---------------------------------------------------------------------------
export async function initProfile(orgId, employeeId) {
    console.log('LORE profile.js: initProfile — orgId:', orgId, 'employeeId:', employeeId);
    const container = document.getElementById('profile-content');
    if (!container) return;

    renderLoading(container, 'Loading profile…');

    const data = await _loadEmployeeData(orgId, employeeId);

    if (!data) {
        container.innerHTML = `
            <div class="empty-state">
                <h3>Profile not found</h3>
                <p class="mt-2">We couldn't load this team member's profile. They may not have signed in yet.</p>
                <button class="btn btn-secondary mt-6" id="back-to-dash">Back to dashboard</button>
            </div>
        `;
        document.getElementById('back-to-dash')?.addEventListener('click', () => {
            window.history.back();
        });
        return;
    }

    renderProfile(container, data, orgId);
}

// ---------------------------------------------------------------------------
// Load all Employee data from Firestore:
//   - Main user document (xp, streak, domainMastery, sessionsTotal, seniority)
//   - Recipe library (recipes unlocked and saved)
//   - patternSignals sub-collection (Manager-only — not readable by Employee)
//
// Returns a combined data object or null on failure.
// ---------------------------------------------------------------------------
async function _loadEmployeeData(orgId, employeeId) {
    const { db } = await import('../firebase.js');
    const {
        doc,
        getDoc,
        collection,
        getDocs,
    } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

    try {
        // All three reads run in parallel — user doc, library, and pattern signals
        const [userSnap, librarySnap, signalsSnap] = await Promise.all([
            getDoc(doc(db, 'organisations', orgId, 'users', employeeId)),
            getDocs(collection(db, 'organisations', orgId, 'users', employeeId, 'recipeLibrary')),
            getDocs(collection(db, 'organisations', orgId, 'users', employeeId, 'patternSignals')),
        ]);

        if (!userSnap.exists()) return null;
        const user = userSnap.data();

        const library = librarySnap.docs.map(d => d.data());
        const signals = signalsSnap.docs.map(d => d.data());

        console.log('LORE profile.js: Loaded', signals.length, 'pattern signals for employee:', employeeId);

        return {
            uid:           employeeId,
            xp:            user.xp            ?? 0,
            streak:        user.streak         ?? 0,
            sessionsTotal: user.sessionsTotal  ?? 0,
            isCalibrated:  (user.sessionsTotal ?? 0) >= 20,
            domainMastery: user.domainMastery  ?? {},
            displayName:   user.displayName    ?? null,
            roleTitle:     user.roleTitle      ?? null,
            seniority:     user.seniority      ?? null,
            createdAt:     user.createdAt      ?? null,
            lastTrainedAt: user.lastTrainedAt  ?? null,
            library,
            signals,
        };
    } catch (err) {
        console.warn('LORE profile.js: Could not load employee data.', err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Render the full profile view.
// ---------------------------------------------------------------------------
function renderProfile(container, data, orgId) {
    const rank = getRankForXP(data.xp);
    const name = data.displayName ?? 'This team member';
    const masteryDomains = Object.keys(data.domainMastery);

    // Derive intelligence from the pattern signals collection
    const intelligence = _deriveIntelligence(data.signals, data.domainMastery);

    container.innerHTML = `
        <div>
            <!-- Back button -->
            <button class="btn btn-secondary mb-6" id="back-btn" style="font-size: var(--text-sm);">
                ← Back to dashboard
            </button>

            <!-- Header -->
            <div class="flex-between mb-6">
                <div>
                    <h1>${name}</h1>
                    <p class="text-secondary text-sm mt-1">${data.roleTitle ?? ''}</p>
                </div>
                <span class="rank-badge" style="font-size: var(--text-sm);">${rank.name}</span>
            </div>

            <!-- Stats row -->
            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: var(--space-4); margin-bottom: var(--space-6);">
                <div class="card" style="text-align: center;">
                    <p class="label">XP</p>
                    <p style="font-size: var(--text-2xl); font-weight: 600; margin-top: var(--space-1);">${data.xp.toLocaleString()}</p>
                </div>
                <div class="card" style="text-align: center;">
                    <p class="label">Sessions</p>
                    <p style="font-size: var(--text-2xl); font-weight: 600; margin-top: var(--space-1);">${data.sessionsTotal}</p>
                </div>
                <div class="card" style="text-align: center;">
                    <p class="label">Streak</p>
                    <p style="font-size: var(--text-2xl); font-weight: 600; margin-top: var(--space-1);">${data.streak}</p>
                    <p class="text-xs text-secondary">days</p>
                </div>
            </div>

            <!-- Calibration status -->
            ${renderCalibrationStatus(data)}

            <!-- Skill area mastery -->
            ${masteryDomains.length > 0
                ? renderMasterySection(data.domainMastery)
                : renderNoMastery()
            }

            <!-- Accuracy by scenario type — Phase 3 -->
            ${data.signals.length > 0 ? renderScenarioTypeAccuracy(intelligence.byType) : ''}

            <!-- Response speed vs cohort — Phase 3 -->
            ${data.signals.length >= 5 ? renderResponseSpeed(intelligence.speedVsMedian) : ''}

            <!-- Learning velocity — Phase 3 -->
            ${data.signals.length >= 10 ? renderLearningVelocity(intelligence.velocity) : ''}

            <!-- Blind spots — Phase 3 -->
            ${intelligence.blindSpots.length > 0 ? renderBlindSpots(intelligence.blindSpots) : ''}

            <!-- Cognitive pattern signals — Phase 3 — Manager only -->
            ${data.signals.length >= 5 ? renderPatternSignals(intelligence) : ''}

            <!-- Recipe library -->
            ${data.library.length > 0 ? renderLibrarySection(data.library) : ''}

            <!-- Plain-language summary — generated on demand -->
            <div class="card mt-6" id="summary-card">
                <div class="flex-between mb-4">
                    <div>
                        <h3>Summary</h3>
                        <p class="text-secondary text-sm mt-1">Written for decision-making, not data reporting.</p>
                    </div>
                    <button class="btn btn-secondary" id="generate-summary" style="font-size: var(--text-sm);">
                        Generate
                    </button>
                </div>
                <p class="text-secondary text-sm" id="summary-text" style="line-height: 1.8;">
                    Generate a plain-language read of ${name}'s development.
                </p>
            </div>
        </div>
    `;

    document.getElementById('back-btn')?.addEventListener('click', () => {
        window.history.back();
    });

    _attachSummaryHandler(data, name, intelligence);
}

// ---------------------------------------------------------------------------
// Derive actionable intelligence from the raw pattern signals array.
// This is where raw signals become Manager-readable insight.
//
// Returns:
//   byType      — accuracy breakdown by scenario type
//   velocity    — recent accuracy vs earlier accuracy
//   blindSpots  — domains the Employee consistently misses (< 40%, >= 5 sessions)
//   tendencies  — inferred cognitive tendencies from the full signal corpus
// ---------------------------------------------------------------------------
function _deriveIntelligence(signals, domainMastery) {
    // --- Accuracy by scenario type ---
    const byType = {
        judgement:   { played: 0, correct: 0 },
        recognition: { played: 0, correct: 0 },
        reflection:  { played: 0, correct: 0 },
    };
    signals.forEach(s => {
        const type = s.scenarioType;
        if (byType[type]) {
            byType[type].played++;
            if (s.verdict === 'correct') byType[type].correct++;
        }
    });

    // --- Learning velocity ---
    // Split signals into two halves chronologically — earlier vs recent.
    // Requires at least 10 signals for a meaningful split.
    let velocity = null;
    if (signals.length >= 10) {
        const sorted = [...signals].sort((a, b) => {
            const aMs = a.createdAt?.toMillis?.() ?? 0;
            const bMs = b.createdAt?.toMillis?.() ?? 0;
            return aMs - bMs;
        });
        const mid     = Math.floor(sorted.length / 2);
        const earlier = sorted.slice(0, mid);
        const recent  = sorted.slice(mid);

        const earlyAcc  = earlier.filter(s => s.verdict === 'correct').length / earlier.length;
        const recentAcc = recent.filter(s => s.verdict === 'correct').length / recent.length;

        velocity = {
            earlier:   Math.round(earlyAcc  * 100),
            recent:    Math.round(recentAcc * 100),
            delta:     Math.round((recentAcc - earlyAcc) * 100),
            direction: recentAcc > earlyAcc ? 'improving' : recentAcc < earlyAcc ? 'declining' : 'steady',
        };
    }

    // --- Blind spots ---
    // Domains with >= 5 sessions and < 40% accuracy — a sustained gap.
    const blindSpots = Object.entries(domainMastery)
        .filter(([, stats]) => (stats.played ?? 0) >= 5 && ((stats.correct ?? 0) / (stats.played ?? 1)) < 0.4)
        .map(([domain, stats]) => ({
            domain,
            accuracy: Math.round(((stats.correct ?? 0) / (stats.played ?? 1)) * 100),
            played:   stats.played,
        }))
        .sort((a, b) => a.accuracy - b.accuracy);

    // --- Response speed vs cohort ---
    // Computes the Employee's median response time and compares it to the
    // org-wide median across all signals that have secondsTaken recorded.
    // A faster-than-median time under pressure is a signal of confidence.
    // A slower time is not necessarily bad — may indicate thoroughness.
    const speedVsMedian = _computeSpeedVsMedian(signals);

    // --- Cognitive tendencies ---
    const tendencies = _inferTendencies(signals, byType, velocity, blindSpots);

    return { byType, velocity, blindSpots, tendencies, speedVsMedian };
}

// ---------------------------------------------------------------------------
// Compute this Employee's median response speed and compare it to a
// reference median derived from their own signal history.
//
// True cohort comparison (across all Employees in the org) would require
// reading all patternSignals sub-collections — expensive. Instead, we use
// the Employee's own median vs their domain-specific median as a proxy.
// When the org has more data, this can be upgraded to a true cross-Employee
// comparison by storing org-level aggregates in the org profile document.
//
// Returns { employeeMedian, faster, label } or null if insufficient data.
// [TUNING TARGET] Minimum 5 timed signals required for a meaningful read.
// ---------------------------------------------------------------------------
function _computeSpeedVsMedian(signals) {
    const timed = signals
        .filter(s => s.secondsTaken != null && s.secondsTaken > 0)
        .map(s => s.secondsTaken);

    if (timed.length < 5) return null;

    const sorted = [...timed].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    // Compare against the RESPONSE_TIME_SECONDS midpoint (120s) as a
    // reference anchor until org-level aggregates are available.
    // 120s = halfway through a 4-minute window — a reasonable neutral baseline.
    const reference = 120;
    const delta     = reference - median;
    const faster    = delta > 0;

    return {
        employeeMedian: Math.round(median),
        reference,
        faster,
        delta:  Math.abs(Math.round(delta)),
        label:  faster
            ? `Responds ${Math.abs(Math.round(delta))}s faster than the midpoint — confident under time pressure.`
            : `Takes ${Math.abs(Math.round(delta))}s longer than the midpoint — measured and thorough.`,
    };
}

// ---------------------------------------------------------------------------
// Infer cognitive tendencies from the signal corpus.
// Qualitative labels derived from quantitative patterns.
// [TUNING TARGET] Thresholds — adjust as real training data accumulates.
// ---------------------------------------------------------------------------
function _inferTendencies(signals, byType, velocity, blindSpots) {
    const tendencies = [];
    if (signals.length < 5) return tendencies;

    // Strong execution instinct — high accuracy on judgement scenarios
    if (byType.judgement.played >= 3) {
        const jAcc = byType.judgement.correct / byType.judgement.played;
        if (jAcc >= 0.7) tendencies.push('Strong execution instinct — reads action-required situations well.');
        else if (jAcc < 0.4) tendencies.push('Execution judgement still forming — tends to hesitate or misread when immediate action is needed.');
    }

    // Pattern recognition strength
    if (byType.recognition.played >= 3) {
        const rAcc = byType.recognition.correct / byType.recognition.played;
        if (rAcc >= 0.7) tendencies.push('Good pattern recognition — identifies when a specific skill applies without being told.');
        else if (rAcc < 0.4) tendencies.push('Pattern recognition still developing — struggles to identify when a specific approach is called for.');
    }

    // Reflective reasoning strength
    if (byType.reflection.played >= 3) {
        const refAcc = byType.reflection.correct / byType.reflection.played;
        if (refAcc >= 0.7) tendencies.push('Strong retrospective reasoning — can identify why outcomes happened and extract the principle.');
        else if (refAcc < 0.4) tendencies.push('Post-hoc reasoning still forming — difficulty extracting the principle from a described outcome.');
    }

    // Momentum
    if (velocity) {
        if (velocity.direction === 'improving' && velocity.delta >= 15) {
            tendencies.push('Clear upward momentum — accuracy has improved meaningfully over recent sessions.');
        } else if (velocity.direction === 'declining' && velocity.delta <= -15) {
            tendencies.push('Recent accuracy has dipped — may benefit from a change of scenario difficulty or domain.');
        }
    }

    // Multiple blind spots
    if (blindSpots.length >= 2) {
        tendencies.push(`Consistent gaps in ${blindSpots.slice(0, 2).map(b => b.domain).join(' and ')} — accuracy below 40% across multiple sessions in both areas.`);
    }

    // Under-explaining on hard scenarios — proxy for uncertainty avoidance
    const missedWithShortResponse = signals.filter(s => s.verdict === 'missed' && (s.responseLength ?? 0) < 80);
    if (signals.length >= 10 && missedWithShortResponse.length / signals.length > 0.3) {
        tendencies.push('Tends to under-explain on difficult scenarios — may be flagging uncertainty rather than reasoning through it.');
    }

    return tendencies;
}

// ---------------------------------------------------------------------------
// Calibration status card.
// ---------------------------------------------------------------------------
function renderCalibrationStatus(data) {
    if (data.sessionsTotal === 0) {
        return `
            <div class="card mb-6" style="border-left: 3px solid var(--amber-text);">
                <p style="font-weight: 500; color: var(--amber-text);">Calibration pending</p>
                <p class="text-secondary text-sm mt-2">This team member hasn't started training yet. Their baseline will be established after their first session.</p>
            </div>
        `;
    }
    if (!data.isCalibrated) {
        const remaining = 20 - data.sessionsTotal;
        return `
            <div class="card mb-6" style="border-left: 3px solid var(--amber-text);">
                <p style="font-weight: 500; color: var(--amber-text);">Baseline forming</p>
                <p class="text-secondary text-sm mt-2">${remaining} more session${remaining !== 1 ? 's' : ''} until their baseline is confirmed. Numbers up to now are directional.</p>
            </div>
        `;
    }
    return `
        <div class="card mb-6" style="border-left: 3px solid var(--sage);">
            <p style="font-weight: 500; color: var(--sage);">Baseline confirmed</p>
            <p class="text-secondary text-sm mt-2">20 sessions completed. Performance data is reliable enough to track progress meaningfully.</p>
        </div>
    `;
}

// ---------------------------------------------------------------------------
// Skill area mastery — accuracy bar per domain.
// ---------------------------------------------------------------------------
function renderMasterySection(domainMastery) {
    const domains = Object.entries(domainMastery).sort((a, b) => (b[1].played ?? 0) - (a[1].played ?? 0));
    return `
        <div class="card mb-6">
            <h3 style="margin-bottom: var(--space-4);">Skill area mastery</h3>
            ${domains.map(([domain, stats]) => {
                const played      = stats.played  ?? 0;
                const correct     = stats.correct ?? 0;
                const accuracy    = played > 0 ? Math.round((correct / played) * 100) : 0;
                const barColour   = accuracy >= 70 ? 'var(--sage)' : accuracy >= 40 ? '#D4943A' : 'var(--ember)';
                const labelColour = accuracy >= 70 ? 'var(--sage)' : accuracy >= 40 ? '#8C5A0A' : 'var(--error)';
                const label       = accuracy >= 70 ? 'Strong' : accuracy >= 40 ? 'Developing' : 'Building';
                return `
                    <div style="margin-bottom: var(--space-5);">
                        <div class="flex-between mb-2">
                            <p style="font-size: var(--text-sm); font-weight: 500;">${domain}</p>
                            <p style="font-size: var(--text-xs); color: ${labelColour};">${accuracy}% · ${played} session${played !== 1 ? 's' : ''} · ${label}</p>
                        </div>
                        <div class="xp-bar-track">
                            <div class="xp-bar-fill" style="width: ${accuracy}%; background: ${barColour};"></div>
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

function renderNoMastery() {
    return `
        <div class="card mb-6">
            <h3 style="margin-bottom: var(--space-2);">Skill area mastery</h3>
            <p class="text-secondary text-sm">No training sessions completed yet.</p>
        </div>
    `;
}

// ---------------------------------------------------------------------------
// Accuracy by scenario type — judgement, recognition, reflection.
// ---------------------------------------------------------------------------
function renderScenarioTypeAccuracy(byType) {
    const types = [
        { key: 'judgement',   label: 'Judgement',   desc: 'Reads situations and knows the right first move' },
        { key: 'recognition', label: 'Recognition', desc: 'Identifies when a specific skill applies' },
        { key: 'reflection',  label: 'Reflection',  desc: 'Extracts principles from described outcomes' },
    ];
    return `
        <div class="card mb-6">
            <h3 style="margin-bottom: var(--space-1);">Accuracy by scenario type</h3>
            <p class="text-secondary text-sm mb-4">Different scenario types test different kinds of thinking.</p>
            ${types.map(t => {
                const stats    = byType[t.key];
                const accuracy = stats.played > 0 ? Math.round((stats.correct / stats.played) * 100) : null;
                const barColour = accuracy === null ? 'rgba(44,36,22,0.1)'
                    : accuracy >= 70 ? 'var(--sage)'
                    : accuracy >= 40 ? '#D4943A'
                    : 'var(--ember)';
                return `
                    <div style="margin-bottom: var(--space-5);">
                        <div class="flex-between mb-1">
                            <div>
                                <p style="font-size: var(--text-sm); font-weight: 500;">${t.label}</p>
                                <p class="text-xs text-secondary">${t.desc}</p>
                            </div>
                            <p style="font-size: var(--text-sm); font-weight: 500; min-width: 60px; text-align: right;">
                                ${accuracy !== null ? accuracy + '%' : '—'}
                                <span class="text-xs text-secondary" style="display: block; font-weight: 400;">${stats.played} played</span>
                            </p>
                        </div>
                        <div class="xp-bar-track" style="margin-top: var(--space-2);">
                            <div class="xp-bar-fill" style="width: ${accuracy ?? 0}%; background: ${barColour};"></div>
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

// ---------------------------------------------------------------------------
// Response speed vs cohort midpoint.
// Shown as a plain-language read — not a score. Speed alone is not a quality
// signal; it is an engagement and confidence signal when combined with accuracy.
// ---------------------------------------------------------------------------
function renderResponseSpeed(speedVsMedian) {
    if (!speedVsMedian) return '';

    const mins = Math.floor(speedVsMedian.employeeMedian / 60);
    const secs = speedVsMedian.employeeMedian % 60;
    const formatted = `${mins}:${secs.toString().padStart(2, '0')}`;

    const colour = speedVsMedian.faster ? 'var(--sage)' : 'var(--warm-grey)';

    return `
        <div class="card mb-6">
            <h3 style="margin-bottom: var(--space-1);">Response speed</h3>
            <p class="text-secondary text-sm mb-4">How quickly they respond under time pressure — a signal of confidence, not just pace.</p>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-4); margin-bottom: var(--space-3);">
                <div style="text-align: center;">
                    <p class="text-xs text-secondary">Median response time</p>
                    <p style="font-size: var(--text-2xl); font-weight: 600; margin-top: var(--space-1);">${formatted}</p>
                </div>
                <div style="text-align: center;">
                    <p class="text-xs text-secondary">vs midpoint (2:00)</p>
                    <p style="font-size: var(--text-sm); font-weight: 500; color: ${colour}; margin-top: var(--space-2);">
                        ${speedVsMedian.faster ? '▲ Faster' : '▼ Slower'} by ${speedVsMedian.delta}s
                    </p>
                </div>
            </div>
            <p class="text-secondary text-sm">${speedVsMedian.label}</p>
        </div>
    `;
}

// ---------------------------------------------------------------------------
// Learning velocity — earlier sessions vs recent sessions.
// ---------------------------------------------------------------------------
function renderLearningVelocity(velocity) {
    if (!velocity) return '';
    const directionColour = velocity.direction === 'improving' ? 'var(--sage)'
        : velocity.direction === 'declining' ? 'var(--error)'
        : 'var(--warm-grey)';
    const directionLabel = velocity.direction === 'improving'
        ? `▲ Up ${velocity.delta}% from earlier sessions`
        : velocity.direction === 'declining'
        ? `▼ Down ${Math.abs(velocity.delta)}% from earlier sessions`
        : 'Holding steady';
    return `
        <div class="card mb-6">
            <h3 style="margin-bottom: var(--space-1);">Learning velocity</h3>
            <p class="text-secondary text-sm mb-4">How accuracy is moving across recent sessions compared to earlier ones.</p>
            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: var(--space-4);">
                <div style="text-align: center;">
                    <p class="text-xs text-secondary">Earlier sessions</p>
                    <p style="font-size: var(--text-2xl); font-weight: 600; margin-top: var(--space-1);">${velocity.earlier}%</p>
                </div>
                <div style="text-align: center;">
                    <p class="text-xs text-secondary">Recent sessions</p>
                    <p style="font-size: var(--text-2xl); font-weight: 600; margin-top: var(--space-1);">${velocity.recent}%</p>
                </div>
                <div style="text-align: center;">
                    <p class="text-xs text-secondary">Direction</p>
                    <p style="font-size: var(--text-sm); font-weight: 500; color: ${directionColour}; margin-top: var(--space-2);">${directionLabel}</p>
                </div>
            </div>
        </div>
    `;
}

// ---------------------------------------------------------------------------
// Blind spots — domains where accuracy is consistently below 40%.
// ---------------------------------------------------------------------------
function renderBlindSpots(blindSpots) {
    return `
        <div class="card mb-6" style="border-left: 3px solid var(--ember);">
            <h3 style="margin-bottom: var(--space-1);">Consistent gaps</h3>
            <p class="text-secondary text-sm mb-4">Skill areas where accuracy has stayed below 40% across multiple sessions — a sustained pattern, not a bad day.</p>
            ${blindSpots.map(b => `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: var(--space-3) 0; border-bottom: 1px solid rgba(44,36,22,0.06);">
                    <div>
                        <p style="font-size: var(--text-sm); font-weight: 500;">${b.domain}</p>
                        <p class="text-xs text-secondary">${b.played} sessions</p>
                    </div>
                    <p style="font-size: var(--text-sm); font-weight: 600; color: var(--error);">${b.accuracy}%</p>
                </div>
            `).join('')}
        </div>
    `;
}

// ---------------------------------------------------------------------------
// Cognitive pattern signals — Manager only. Never shown to the Employee.
// ---------------------------------------------------------------------------
function renderPatternSignals(intelligence) {
    if (intelligence.tendencies.length === 0) return '';
    return `
        <div class="card mb-6">
            <h3 style="margin-bottom: var(--space-1);">How they tend to think</h3>
            <p class="text-secondary text-sm mb-4">Inferred from training behaviour. For your read — not for sharing.</p>
            ${intelligence.tendencies.map(t => `
                <div style="padding: var(--space-3) 0; border-bottom: 1px solid rgba(44,36,22,0.06);">
                    <p style="font-size: var(--text-sm); line-height: 1.7;">${t}</p>
                </div>
            `).join('')}
        </div>
    `;
}

// ---------------------------------------------------------------------------
// Recipe library — recipes the Employee has saved after unlocking them.
// ---------------------------------------------------------------------------
function renderLibrarySection(library) {
    return `
        <div class="card mb-6">
            <h3 style="margin-bottom: var(--space-4);">Saved recipes</h3>
            <p class="text-secondary text-sm mb-4">What resonated enough to save — a signal of where attention is landing.</p>
            ${library.map(item => `
                <div style="padding: var(--space-3) 0; border-bottom: 1px solid rgba(44,36,22,0.06);">
                    <p style="font-size: var(--text-sm); font-weight: 500;">${item.skillName ?? 'Unnamed skill'}</p>
                    <p class="text-xs text-secondary mt-1">${item.domain ?? ''}</p>
                </div>
            `).join('')}
        </div>
    `;
}

// ---------------------------------------------------------------------------
// Plain-language summary — AI-generated, on demand, Manager only.
// Uses full Phase 3 intelligence: mastery, scenario type accuracy, velocity,
// blind spots, and cognitive tendencies.
// ---------------------------------------------------------------------------
function _attachSummaryHandler(data, name, intelligence) {
    document.getElementById('generate-summary')?.addEventListener('click', async () => {
        const btn    = document.getElementById('generate-summary');
        const textEl = document.getElementById('summary-text');
        btn.disabled    = true;
        btn.textContent = 'Generating…';
        if (textEl) textEl.textContent = '';

        const { generate } = await import('../engine/ai.js');

        const masteryText = Object.entries(data.domainMastery).map(([domain, stats]) => {
            const acc = stats.played > 0 ? Math.round((stats.correct / stats.played) * 100) : 0;
            return `${domain}: ${acc}% across ${stats.played} sessions`;
        }).join('; ') || 'No domain data';

        const typeText = Object.entries(intelligence.byType).map(([type, stats]) => {
            const acc = stats.played > 0 ? Math.round((stats.correct / stats.played) * 100) : 0;
            return `${type}: ${acc}% (${stats.played} played)`;
        }).join('; ');

        const velocityText = intelligence.velocity
            ? `Earlier: ${intelligence.velocity.earlier}%. Recent: ${intelligence.velocity.recent}%. Direction: ${intelligence.velocity.direction}.`
            : 'Insufficient data for velocity.';

        const blindSpotText = intelligence.blindSpots.length > 0
            ? `Consistent gaps: ${intelligence.blindSpots.map(b => `${b.domain} (${b.accuracy}%)`).join(', ')}.`
            : 'No consistent blind spots identified.';

        const tendencyText = intelligence.tendencies.length > 0
            ? intelligence.tendencies.join(' ')
            : 'Insufficient signal for tendencies.';

        const systemPrompt = `You are writing a brief plain-language summary for a manager about one of their team members' development.
Tone: trusted colleague, warm but precise. Not clinical, not generic.
Length: 3 to 4 sentences maximum.
Never use: scores, percentages, "the data shows", "pattern signals", "metric", LORE, training platform.
Write about: what they seem to understand well, where instinct is still forming, one grounded observation the manager could act on.
Do not begin with the person's name. Do not mention that you have been given data.
Write as if you have watched them work.`;

        const prompt = `Team member: ${name}
Role: ${data.roleTitle ?? 'not specified'}
Experience level: ${data.seniority ?? 'not specified'}
Sessions completed: ${data.sessionsTotal}
Baseline confirmed: ${data.isCalibrated ? 'yes' : 'not yet'}
Skill area performance: ${masteryText}
Scenario type accuracy: ${typeText}
Learning velocity: ${velocityText}
${blindSpotText}
Inferred tendencies: ${tendencyText}

Write the summary.`;

        console.log('LORE profile.js: Generating AI summary for employee:', data.uid);
        const result = await generate(prompt, systemPrompt);

        btn.disabled    = false;
        btn.textContent = 'Regenerate';

        if (!result.ok) {
            console.warn('LORE profile.js: Summary generation failed.');
            if (textEl) textEl.textContent = 'Could not generate right now. Try again shortly.';
            return;
        }

        console.log('LORE profile.js: Summary generated successfully.');
        if (textEl) {
            textEl.textContent     = result.text;
            textEl.style.color     = 'var(--ink)';
            textEl.style.lineHeight = '1.8';
            textEl.style.fontStyle = 'normal';
        }
    });
}

// ---------------------------------------------------------------------------
// Loading state.
// ---------------------------------------------------------------------------
function renderLoading(container, message) {
    container.innerHTML = `
        <div class="empty-state">
            <div class="spinner"></div>
            <p class="text-secondary mt-4">${message}</p>
        </div>
    `;
}