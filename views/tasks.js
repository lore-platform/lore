// =============================================================================
// LORE — Tasks View (Reviewer)
// Built in Phase 2. Handles Reviewer prompt delivery and response capture.
// =============================================================================

export async function initTasks(orgId, uid, claims) {
    const container = document.getElementById('tasks-content');
    if (!container) return;

    container.innerHTML = `
        <div class="empty-state">
            <h3>You're all caught up</h3>
            <p class="mt-2">When your team needs your input, you'll see it here.</p>
        </div>
    `;
}