// FRAUD / VERIFICATION AGENT
// Holds veto power - nothing reaches Reconciliation without clearing this.
// Rules-based (deterministic) for a hackathon-real build; swap in an ML/LLM
// pattern-review pass later without changing the contract below.
function verify(db, { org_id, source_id, qty }) {
  const flags = [];

  if (org_id) {
    const org = db.prepare(`SELECT * FROM orgs WHERE id = ?`).get(org_id);
    if (!org) flags.push("org_not_found");
    else {
      if (!org.verified) flags.push("org_not_yet_verified");
      const ageYears = new Date().getFullYear() - org.founded_year;
      if (ageYears < 1) flags.push("org_very_new");
    }
  }

  if (source_id) {
    const src = db.prepare(`SELECT * FROM surplus_sources WHERE id = ?`).get(source_id);
    if (!src) flags.push("source_not_found");
    else if (src.reliability_pct < 70) flags.push("low_reliability_source");
  }

  if (qty && qty > 500) flags.push("unusually_large_quantity");

  const veto = flags.includes("org_not_found") || flags.includes("source_not_found");
  const frozen = !veto && flags.length > 0 && flags.every(f => f === "org_very_new" || f === "org_not_yet_verified");

  return {
    cleared: flags.length === 0,
    veto,       // hard stop - nothing proceeds
    frozen,     // soft hold - proceeds but flagged for human review
    flags,
  };
}

module.exports = { verify };
