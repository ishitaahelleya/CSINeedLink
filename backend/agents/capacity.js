// CAPACITY AGENT
// Every other agent has to query this before finalizing a recommendation.
// Model: daily_capacity - current_load = realistic headroom, adjusted down
// slightly per staffing level to avoid over-promising understaffed orgs.
function checkCapacity(db, { org_id, qty }) {
  const org = db.prepare(`SELECT * FROM orgs WHERE id = ?`).get(org_id);
  if (!org) return { ok: false, reason: "unknown_org", max_qty: 0 };

  const staffingFactor = Math.min(1, org.staffing_level / 2); // 1 staffer = half-strength intake
  const headroom = Math.max(0, org.daily_capacity - org.current_load);
  const effectiveMax = Math.floor(headroom * staffingFactor);

  const accepted = Math.min(qty, effectiveMax);
  return {
    ok: accepted > 0,
    org_id,
    org_name: org.name,
    requested_qty: qty,
    max_qty: effectiveMax,
    accepted_qty: accepted,
    reason: accepted === 0 ? "no_headroom_or_understaffed" : accepted < qty ? "partial_capacity" : "full_capacity",
  };
}

module.exports = { checkCapacity };
