// =============================================================================
// LORE — Profile View (Manager, per-Employee)
// Built in Phase 2. Per-Employee capability intelligence and time to competency.
// =============================================================================

export async function initProfile(orgId, employeeId) {
    const container = document.getElementById('profile-content');
    if (!container) return;

    container.innerHTML = `
        <div class="empty-state">
            <h3>Profile</h3>
            <p class="mt-2">Employee capability intelligence is built here in Phase 2.</p>
        </div>
    `;
}