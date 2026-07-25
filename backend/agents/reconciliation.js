const { checkCapacity } = require("./capacity");
const { verify } = require("./fraud");
const { allocateSlots } = require("./notificationGovernor");
const { matchDonors } = require("./donorMatching");
const { logDecision } = require("./util");

// RECONCILIATION AGENT (orchestrator)
// Simple synchronous fan-out: calls Fraud first (hard gate), then Capacity,
// then Donor Matching + Notification Governor, then produces one ranked
// decision. Every step is logged with correlation_id so the trace is a
// literal, replayable log of this function's inputs and output - not a
// narrated summary.
async function reconcileRequestFulfillment(db, { request_id, proposed_qty }) {
  const correlationId = `req-${request_id}-${Date.now()}`;
  const trace = [];

  const request = db.prepare(`SELECT r.*, o.name as org_name FROM requests r JOIN orgs o ON r.org_id = o.id WHERE r.id = ?`).get(request_id);
  if (!request) return { ok: false, reason: "unknown_request", trace };

  // 1. Fraud/Verification - hard gate, runs first
  const fraudResult = await verify(db, { org_id: request.org_id, qty: proposed_qty });
  logDecision(db, correlationId, "FRAUD_VERIFICATION", { org_id: request.org_id, qty: proposed_qty }, fraudResult);
  trace.push({ agent: "FRAUD/VERIFICATION", input: { org_id: request.org_id, qty: proposed_qty }, output: fraudResult });
  if (fraudResult.veto) {
    return { ok: false, reason: "fraud_veto", flags: fraudResult.flags, correlation_id: correlationId, trace };
  }

  // 2. Capacity - every recommendation must clear this before finalizing
  const capacityResult = checkCapacity(db, { org_id: request.org_id, qty: proposed_qty });
  logDecision(db, correlationId, "CAPACITY", { org_id: request.org_id, qty: proposed_qty }, capacityResult);
  trace.push({ agent: "CAPACITY", input: { org_id: request.org_id, qty: proposed_qty }, output: capacityResult });

  // 3. Donor Matching - who should even be considered
  const matchResult = matchDonors(db, { request_id });
  logDecision(db, correlationId, "DONOR_MATCHING", { request_id }, matchResult);
  trace.push({ agent: "DONOR_MATCHING", input: { request_id }, output: matchResult });

  // 4. Notification Governor - competes matched donors for scarce weekly slots
  const candidateIds = (matchResult.ranked_donors || []).slice(0, 3).map(d => d.donor_id);
  const govResult = allocateSlots(db, { candidateDonorIds: candidateIds, requestPriority: request.urgent ? 2 : 1 });
  logDecision(db, correlationId, "NOTIFICATION_GOVERNOR", { candidateIds, urgent: !!request.urgent }, govResult);
  trace.push({ agent: "NOTIFICATION_GOVERNOR", input: { candidateIds, urgent: !!request.urgent }, output: govResult });

  // 5. Final ranked decision
  const finalDecision = {
    org_id: request.org_id,
    org_name: request.org_name,
    accepted_qty: capacityResult.accepted_qty,
    capped_by_capacity: capacityResult.accepted_qty < proposed_qty,
    frozen_for_review: fraudResult.frozen,
    donors_notified: govResult.granted.map(g => g.name),
    donors_skipped_budget: govResult.denied.map(g => g.name),
  };
  logDecision(db, correlationId, "RECONCILIATION_FINAL", { request_id, proposed_qty }, finalDecision);
  trace.push({ agent: "RECONCILIATION", input: { request_id, proposed_qty }, output: finalDecision, final: true });

  return { ok: true, correlation_id: correlationId, decision: finalDecision, trace };
}

// Surplus-specific reconciliation: splits one signal across multiple orgs by capacity headroom.
async function reconcileSurplusSplit(db, { source_id, item, unit, qty, category }) {
  const correlationId = `surplus-${source_id}-${Date.now()}`;
  const trace = [];

  const fraudResult = await verify(db, { source_id, qty });
  logDecision(db, correlationId, "FRAUD_VERIFICATION", { source_id, qty }, fraudResult);
  trace.push({ agent: "FRAUD/VERIFICATION", input: { source_id, qty }, output: fraudResult });
  if (fraudResult.veto) return { ok: false, reason: "fraud_veto", flags: fraudResult.flags, trace };

  const candidateOrgs = db.prepare(`SELECT * FROM orgs WHERE category = ? ORDER BY (daily_capacity - current_load) DESC LIMIT 3`).all(category);
  let remaining = qty;
  const splits = [];
  for (const org of candidateOrgs) {
    if (remaining <= 0) break;
    const cap = checkCapacity(db, { org_id: org.id, qty: remaining });
    logDecision(db, correlationId, "CAPACITY", { org_id: org.id, qty: remaining }, cap);
    trace.push({ agent: "CAPACITY", input: { org_id: org.id, qty: remaining }, output: cap });
    if (cap.accepted_qty > 0) {
      splits.push({ org_id: org.id, org_name: org.name, qty: cap.accepted_qty });
      remaining -= cap.accepted_qty;
    }
  }

  const finalDecision = { item, unit, total_qty: qty, splits, unallocated: remaining };
  logDecision(db, correlationId, "RECONCILIATION_FINAL", { source_id, item, qty }, finalDecision);
  trace.push({ agent: "RECONCILIATION", input: { source_id, item, qty }, output: finalDecision, final: true });

  return { ok: true, correlation_id: correlationId, decision: finalDecision, trace };
}

module.exports = { reconcileRequestFulfillment, reconcileSurplusSplit };