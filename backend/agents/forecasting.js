// FORECASTING AGENT
// Real (if simple) model: looks at an org's historical request cadence for a
// category and flags if they're due for another one soon. Naive frequency
// model - no external weather/calendar API, per the "what NOT to build" scope.
function forecast(db, { org_id, category }) {
  const org = db.prepare(`SELECT * FROM orgs WHERE id = ?`).get(org_id);
  if (!org) return { ok: false, reason: "unknown_org" };

  const priorRequests = db
    .prepare(`SELECT * FROM requests WHERE org_id = ? AND category = ? ORDER BY created_at DESC`)
    .all(org_id, category);

  // Heuristic: orgs with an existing near-fulfilled request in this category
  // historically re-request within ~2-3 weeks. Confidence scales with sample size.
  const nearFulfilled = priorRequests.filter(r => r.have / r.need > 0.8).length;
  const confidence = Math.min(0.95, 0.5 + nearFulfilled * 0.15);

  return {
    ok: true,
    org_id,
    org_name: org.name,
    category,
    likely_to_reneed: nearFulfilled > 0,
    confidence: Number(confidence.toFixed(2)),
    basis: `${priorRequests.length} historical ${category} request(s) on file, ${nearFulfilled} near-fulfilled`,
  };
}

// SURPLUS SENSING AGENT
// Predicts surplus from a source based on a rolling pattern. For the demo,
// pattern = time-of-day + source reliability; a real version would read
// actual POS/inventory signal history.
function predictSurplus(db, { source_id, hour = new Date().getHours() }) {
  const src = db.prepare(`SELECT * FROM surplus_sources WHERE id = ?`).get(source_id);
  if (!src) return { ok: false, reason: "unknown_source" };

  const closingHours = { Food: [17, 18, 19] };
  const likely = (closingHours[src.category] || []).includes(hour);
  const confidence = likely ? Math.min(0.97, src.reliability_pct / 100 + 0.05) : 0.1;

  return {
    ok: true,
    source_id,
    source_name: src.name,
    category: src.category,
    likely_surplus_now: likely,
    confidence: Number(confidence.toFixed(2)),
    reliability_pct: src.reliability_pct,
  };
}

module.exports = { forecast, predictSurplus };
