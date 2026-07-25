const { callOllama } = require("./llmClient");

// FORECASTING AGENT
// Predicts whether an org is likely to re-need a category soon. Tries a
// real local LLM (Ollama) first - this is a genuine judgment call over a
// pattern, not a lookup, so it's a good fit for a model instead of a fixed
// formula. Falls back to the original frequency heuristic if Ollama isn't
// running or returns something unusable. `method: "llm" | "rules"` on
// every result says which one actually produced it.

function gatherForecastContext(db, { org_id, category }) {
  const org = db.prepare(`SELECT * FROM orgs WHERE id = ?`).get(org_id);
  if (!org) return null;
  const priorRequests = db
    .prepare(`SELECT item, need, have, urgent, created_at FROM requests WHERE org_id = ? AND category = ? ORDER BY created_at DESC`)
    .all(org_id, category);
  return {
    org_name: org.name,
    category,
    daily_capacity: org.daily_capacity,
    staffing_level: org.staffing_level,
    prior_requests: priorRequests.map(r => ({
      item: r.item, need: r.need, have: r.have, pct_fulfilled: Math.round((r.have / r.need) * 100), urgent: !!r.urgent,
    })),
  };
}

function forecastRules(db, { org_id, category }) {
  const org = db.prepare(`SELECT * FROM orgs WHERE id = ?`).get(org_id);
  if (!org) return { ok: false, reason: "unknown_org", method: "rules" };

  const priorRequests = db
    .prepare(`SELECT * FROM requests WHERE org_id = ? AND category = ? ORDER BY created_at DESC`)
    .all(org_id, category);

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
    method: "rules",
  };
}

async function forecastWithLLM(db, { org_id, category }) {
  const context = gatherForecastContext(db, { org_id, category });
  if (!context) throw new Error("unknown_org");

  const prompt = `You are a demand-forecasting agent for a donation-matching platform. Given an organization's request history in one category, judge whether they are likely to need this category again soon.

Context (JSON): ${JSON.stringify(context)}

Consider: how many prior requests exist, how close to fully-funded they got (a request that closes near 100% often means the org has recurring need in that category), and whether requests were urgent (recurring urgency suggests an ongoing pattern, not a one-off).

Respond with ONLY raw JSON, no markdown, no preamble, in exactly this shape:
{"likely_to_reneed": boolean, "confidence": number between 0 and 1, "basis": "one short sentence explaining your reasoning from the actual data given"}`;

  const result = await callOllama(prompt, { timeoutMs: 20000 });
  if (typeof result.likely_to_reneed !== "boolean" || typeof result.confidence !== "number") {
    throw new Error("Ollama response missing required fields");
  }
  const org = db.prepare(`SELECT * FROM orgs WHERE id = ?`).get(org_id);
  return {
    ok: true,
    org_id,
    org_name: org.name,
    category,
    likely_to_reneed: result.likely_to_reneed,
    confidence: Math.max(0, Math.min(1, Number(result.confidence.toFixed(2)))),
    basis: result.basis,
    method: "llm",
  };
}

async function forecast(db, { org_id, category }) {
  try {
    return await forecastWithLLM(db, { org_id, category });
  } catch (err) {
    console.warn(`[FORECASTING] Ollama unavailable or failed (${err.message}) - falling back to frequency heuristic.`);
    return forecastRules(db, { org_id, category });
  }
}

// SURPLUS SENSING AGENT
// Predicts whether a surplus source likely has surplus right now. Same
// LLM-first-with-fallback pattern.

function predictSurplusRules(db, { source_id, hour = new Date().getHours() }) {
  const src = db.prepare(`SELECT * FROM surplus_sources WHERE id = ?`).get(source_id);
  if (!src) return { ok: false, reason: "unknown_source", method: "rules" };

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
    method: "rules",
  };
}

async function predictSurplusWithLLM(db, { source_id, hour = new Date().getHours() }) {
  const src = db.prepare(`SELECT * FROM surplus_sources WHERE id = ?`).get(source_id);
  if (!src) throw new Error("unknown_source");

  const prompt = `You are a surplus-prediction agent for a donation-matching platform. A business may have leftover inventory at certain times of day. Judge whether this source likely has surplus available right now.

Context (JSON): ${JSON.stringify({ source_name: src.name, category: src.category, reliability_pct: src.reliability_pct, tier: src.tier, current_hour_24h: hour })}

Food businesses (bakeries, cafes, grocers) most commonly have surplus near closing time, roughly 5-7pm (hour 17-19). A more reliable source (higher reliability_pct) is more likely to actually have real, usable surplus rather than false alarms.

Respond with ONLY raw JSON, no markdown, no preamble, in exactly this shape:
{"likely_surplus_now": boolean, "confidence": number between 0 and 1, "reasoning": "one short sentence"}`;

  const result = await callOllama(prompt, { timeoutMs: 20000 });
  if (typeof result.likely_surplus_now !== "boolean" || typeof result.confidence !== "number") {
    throw new Error("Ollama response missing required fields");
  }
  return {
    ok: true,
    source_id,
    source_name: src.name,
    category: src.category,
    likely_surplus_now: result.likely_surplus_now,
    confidence: Math.max(0, Math.min(1, Number(result.confidence.toFixed(2)))),
    reliability_pct: src.reliability_pct,
    reasoning: result.reasoning,
    method: "llm",
  };
}

async function predictSurplus(db, { source_id, hour }) {
  try {
    return await predictSurplusWithLLM(db, { source_id, hour });
  } catch (err) {
    console.warn(`[SURPLUS_SENSING] Ollama unavailable or failed (${err.message}) - falling back to time-of-day heuristic.`);
    return predictSurplusRules(db, { source_id, hour });
  }
}

module.exports = { forecast, forecastRules, forecastWithLLM, predictSurplus, predictSurplusRules, predictSurplusWithLLM };