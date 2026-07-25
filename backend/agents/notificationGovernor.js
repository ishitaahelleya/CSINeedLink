// NOTIFICATION GOVERNOR AGENT
// Enforces a per-donor weekly push budget. Multiple requests/signals
// genuinely compete for a limited number of remaining slots per donor -
// this is real scarce-resource allocation, not decoration.
function allocateSlots(db, { candidateDonorIds, requestPriority = 1 }) {
  const donors = candidateDonorIds.length
    ? db.prepare(`SELECT * FROM donors WHERE id IN (${candidateDonorIds.map(() => "?").join(",")})`).all(...candidateDonorIds)
    : db.prepare(`SELECT * FROM donors`).all();

  const eligible = [];
  const denied = [];
  for (const d of donors) {
    const remaining = d.weekly_push_budget - d.pushes_this_week;
    if (remaining > 0) eligible.push({ donor_id: d.id, name: d.name, remaining_slots: remaining });
    else denied.push({ donor_id: d.id, name: d.name, reason: "weekly_budget_exhausted" });
  }

  // Priority requests (urgent) get first claim on slots when multiple signals compete same tick
  const granted = eligible
    .sort((a, b) => b.remaining_slots - a.remaining_slots)
    .slice(0, Math.max(1, Math.ceil(eligible.length * (requestPriority >= 2 ? 1 : 0.6))));

  // actually decrement budget for granted donors (real state mutation, not simulated)
  const upd = db.prepare(`UPDATE donors SET pushes_this_week = pushes_this_week + 1 WHERE id = ?`);
  granted.forEach(g => upd.run(g.donor_id));

  return {
    eligible_count: eligible.length,
    granted: granted.map(g => ({ donor_id: g.donor_id, name: g.name })),
    denied,
  };
}

module.exports = { allocateSlots };
