const { callOllama } = require("./llmClient");

// FRAUD / VERIFICATION AGENT
// Holds veto power - nothing reaches Reconciliation without clearing this.
//
// Tries a real local LLM (Ollama) first, asking it to reason over the
// org/source's actual history and make a judgment call - not just a fixed
// threshold. If Ollama isn't running, times out, or returns something we
// can't parse, we fall back to the deterministic rules below so the demo
// never breaks because a model wasn't running. Every result says which
// path produced it via `method: "llm" | "rules"`.
//
// Known LLM reliability gap (found via real testing, not theoretical):
// a local model can list a concern in `flags` without actually acting on
// it in `cleared`/`frozen`/`veto` - e.g. flagging "large_quantity" but
// still returning cleared:true, frozen:false. Prompt wording alone can't
// guarantee it won't do that again, so `enforceConsistency()` below is a
// hard, deterministic backstop applied to every LLM result before it's
// ever returned: if anything got flagged, the decision MUST reflect it.

function gatherContext(db, { org_id, source_id, qty }) {
  const context = { qty: qty || null };
  if (org_id) {
    const org = db.prepare(`SELECT * FROM orgs WHERE id = ?`).get(org_id);
    context.org_exists = !!org;
    context.org = org
      ? { name: org.name, verified: !!org.verified, founded_year: org.founded_year, age_years: new Date().getFullYear() - org.founded_year }
      : null;
  }
  if (source_id) {
    const src = db.prepare(`SELECT * FROM surplus_sources WHERE id = ?`).get(source_id);
    context.source_exists = !!src;
    context.source = src ? { name: src.name, reliability_pct: src.reliability_pct, tier: src.tier } : null;
  }
  return context;
}

function verifyRules(db, { org_id, source_id, qty }) {
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

  return enforceConsistency({
    cleared: flags.length === 0,
    veto,
    frozen,
    flags,
    reasoning: flags.length === 0 ? "No risk flags matched." : `Rule-matched flags: ${flags.join(", ")}.`,
    method: "rules",
  });
}

// Deterministic safety net, not another prompt: if anything (LLM or rules)
// raised flags but didn't actually act on them - no veto, no frozen hold -
// force a hold. A decision that names a risk and takes no action on it is
// treated as a bug, regardless of what `cleared` happened to say.
function enforceConsistency(result) {
  const hasFlags = Array.isArray(result.flags) && result.flags.length > 0;
  const tookNoAction = !result.veto && !result.frozen;
  if (hasFlags && tookNoAction) {
    return {
      ...result,
      cleared: false,
      frozen: true,
      reasoning: `${result.reasoning} (auto-frozen for review: flags were raised but not acted on)`,
      consistency_corrected: true,
    };
  }
  return result;
}

async function verifyWithLLM(db, { org_id, source_id, qty }) {
  const context = gatherContext(db, { org_id, source_id, qty });
  const prompt = `You are a fraud and verification checker for a donation-matching platform. Decide whether this donation/request should be cleared, frozen for human review, or vetoed outright.

Context (JSON): ${JSON.stringify(context)}

Rules of thumb:
- If org_exists or source_exists is explicitly false, that entity does not exist at all - veto:true.
- Missing verification or a very new org should be frozen, not vetoed.
- A quantity over 500 units is unusually large and worth flagging.
- A surplus source below 70% reliability is risky but not disqualifying alone.
- CRITICAL CONSISTENCY RULE: if you put anything in "flags", you MUST set frozen:true or veto:true. Never return a non-empty flags list together with cleared:true, frozen:false, veto:false - that is a contradiction and not allowed. If something is worth flagging, it is worth acting on; if it isn't worth acting on, leave flags empty.

Respond with ONLY raw JSON, no markdown, no preamble, in exactly this shape:
{"cleared": boolean, "veto": boolean, "frozen": boolean, "flags": ["short_flag_slug", ...], "reasoning": "one short sentence explaining the decision"}`;

  const result = await callOllama(prompt, { timeoutMs: 20000 });
  if (typeof result.cleared !== "boolean" || typeof result.veto !== "boolean") {
    throw new Error("Ollama response missing required fields");
  }
  return enforceConsistency({ ...result, flags: result.flags || [], method: "llm" });
}

async function verify(db, { org_id, source_id, qty }) {
  try {
    return await verifyWithLLM(db, { org_id, source_id, qty });
  } catch (err) {
    console.warn(`[FRAUD] Ollama unavailable or failed (${err.message}) - falling back to rules-based verification.`);
    return verifyRules(db, { org_id, source_id, qty });
  }
}

module.exports = { verify, verifyRules, verifyWithLLM, enforceConsistency };