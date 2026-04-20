// =============================================================================
// LORE — Dashboard View (Manager)
// Built in Phase 2. Knowledge base overview, staff progress, recipe queue.
// =============================================================================

export async function initDashboard(orgId, uid) {
    const container = document.getElementById('dashboard-content');
    if (!container) return;

    container.innerHTML = `
        <div>
            <h1>Dashboard</h1>
            <p class="text-secondary mt-2">Your knowledge base and team overview will appear here. Add your first skill area to get started.</p>
        </div>
    `;
}