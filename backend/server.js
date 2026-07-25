const path = require("path");
const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");

const { checkCapacity } = require("./agents/capacity");
const { verify } = require("./agents/fraud");
const { allocateSlots } = require("./agents/notificationGovernor");
const { matchDonors } = require("./agents/donorMatching");
const { forecast, predictSurplus } = require("./agents/forecasting");
const { reconcileRequestFulfillment, reconcileSurplusSplit } = require("./agents/reconciliation");
const { isOllamaReachable, OLLAMA_MODEL } = require("./agents/llmClient");
const { haversineMiles } = require("./agents/util");

const dbPath = path.join(__dirname, "needlink.db");
const db = new Database(dbPath, { fileMustExist: true }); // run `npm run seed` first

// Idempotent migrations so an existing needlink.db picks up the columns the
// app needs without forcing a re-seed (which would wipe posted requests).
function addColumnIfMissing(table, col, decl){
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
addColumnIfMissing("requests", "urgency", "TEXT NOT NULL DEFAULT 'urgent'");
addColumnIfMissing("requests", "details", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("requests", "needed_by", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing("requests", "pledgers", "TEXT NOT NULL DEFAULT '[]'");

// A recipient posting from the app may not be one of the seeded orgs, so make
// sure a matching org row exists before inserting their request.
function ensureOrg(name, lat, lng, category){
  const existing = db.prepare(`SELECT * FROM orgs WHERE name = ?`).get(name);
  if (existing) return existing.id;
  const id = "org_app_" + Date.now();
  db.prepare(`INSERT INTO orgs (id,name,city,category,lat,lng,daily_capacity,current_load,staffing_level,verified,founded_year)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, name, "Tri-Valley", category || "Food", lat || 37.7022, lng || -121.9358, 60, 0, 3, 1, new Date().getFullYear() - 3);
  return id;
}

const app = express();
app.use(cors());
app.use(express.json());

// ---------- Read endpoints (Dublin/Pleasanton/Livermore data) ----------
app.get("/api/orgs", (req, res) => {
  const { lat, lng, maxDistance } = req.query;
  let orgs = db.prepare(`SELECT * FROM orgs`).all();
  if (lat && lng) {
    orgs = orgs.map(o => ({ ...o, distance_mi: Number(haversineMiles(+lat, +lng, o.lat, o.lng).toFixed(2)) }));
    if (maxDistance) orgs = orgs.filter(o => o.distance_mi <= +maxDistance);
    orgs.sort((a, b) => a.distance_mi - b.distance_mi);
  }
  res.json(orgs);
});

app.get("/api/requests", (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, o.name as org_name, o.city, o.lat, o.lng, o.verified
    FROM requests r JOIN orgs o ON r.org_id = o.id
    ORDER BY r.created_at DESC
  `).all();
  res.json(rows.map(r => ({ ...r, pledgers: JSON.parse(r.pledgers || "[]") })));
});

// Create a request. This is what makes two machines share state: a recipient
// posts here, and every donor polling /api/requests sees it appear.
// The multi-agent pipeline gates it first - a hard fraud veto blocks the post.
app.post("/api/requests", async (req, res) => {
  const { org_name, item, unit, need, urgency, details, needed_by, category, lat, lng } = req.body;
  if (!org_name || !item || !need) return res.status(400).json({ error: "org_name, item and need are required" });

  const org_id = ensureOrg(org_name, lat, lng, category);
  const check = await verify(db, { org_id, qty: Number(need) });
  if (check.veto) return res.status(403).json({ error: "blocked_by_fraud_agent", agent: check });

  const info = db.prepare(`INSERT INTO requests (org_id,item,unit,need,have,urgent,category,urgency,details,needed_by,pledgers)
                           VALUES (?,?,?,?,0,?,?,?,?,?,'[]')`)
    .run(org_id, item, unit || item, Number(need), urgency === "urgent" ? 1 : 0,
         category || "Food", urgency || "urgent", details || "", needed_by || "");

  const row = db.prepare(`SELECT r.*, o.name as org_name, o.lat, o.lng, o.verified
                          FROM requests r JOIN orgs o ON r.org_id = o.id WHERE r.id = ?`).get(info.lastInsertRowid);
  res.json({ ok: true, request: { ...row, pledgers: [] }, agent_check: check });
});

// Pledge against a request - increments have + records who pledged.
app.post("/api/requests/:id/pledge", (req, res) => {
  const { qty, donor_name } = req.body;
  const r = db.prepare(`SELECT * FROM requests WHERE id = ?`).get(req.params.id);
  if (!r) return res.status(404).json({ error: "unknown_request" });
  const pledgers = JSON.parse(r.pledgers || "[]");
  pledgers.push(donor_name || "A donor");
  db.prepare(`UPDATE requests SET have = have + ?, pledgers = ? WHERE id = ?`)
    .run(Number(qty) || 1, JSON.stringify(pledgers), req.params.id);
  res.json({ ok: true, pledgers });
});

// Cancel - only allowed while nobody has pledged yet.
app.delete("/api/requests/:id", (req, res) => {
  const r = db.prepare(`SELECT * FROM requests WHERE id = ?`).get(req.params.id);
  if (!r) return res.status(404).json({ error: "unknown_request" });
  if (JSON.parse(r.pledgers || "[]").length > 0) {
    return res.status(409).json({ error: "cannot_cancel_after_pledges" });
  }
  db.prepare(`DELETE FROM requests WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/clubs", (req, res) => res.json(db.prepare(`SELECT * FROM clubs`).all()));
app.get("/api/surplus-sources", (req, res) => res.json(db.prepare(`SELECT * FROM surplus_sources`).all()));
app.get("/api/donors", (req, res) => res.json(db.prepare(`SELECT id,name,lat,lng,interests,pushes_this_week,weekly_push_budget FROM donors`).all()));

app.get("/api/trace/:correlationId", (req, res) => {
  const rows = db.prepare(`SELECT agent, input_json, output_json, created_at FROM agent_decisions WHERE correlation_id = ? ORDER BY id ASC`).all(req.params.correlationId);
  res.json(rows.map(r => ({ agent: r.agent, input: JSON.parse(r.input_json), output: JSON.parse(r.output_json), created_at: r.created_at })));
});

// ---------- Individual agent endpoints (each independently callable) ----------
app.post("/api/agents/capacity", (req, res) => res.json(checkCapacity(db, req.body)));
app.post("/api/agents/fraud", async (req, res) => res.json(await verify(db, req.body)));
app.post("/api/agents/notification-governor", (req, res) => res.json(allocateSlots(db, req.body)));
app.post("/api/agents/donor-matching", (req, res) => res.json(matchDonors(db, req.body)));
app.post("/api/agents/forecasting", async (req, res) => res.json(await forecast(db, req.body)));
app.post("/api/agents/surplus-sensing", async (req, res) => res.json(await predictSurplus(db, req.body)));

// ---------- Reconciliation orchestrator (fans out to all agents above) ----------
app.post("/api/reconcile/request", async (req, res) => {
  const { request_id, proposed_qty } = req.body;
  if (!request_id || !proposed_qty) return res.status(400).json({ error: "request_id and proposed_qty required" });
  res.json(await reconcileRequestFulfillment(db, { request_id, proposed_qty }));
});

app.post("/api/reconcile/surplus", async (req, res) => {
  const { source_id, item, unit, qty, category } = req.body;
  if (!source_id || !item || !qty || !category) return res.status(400).json({ error: "source_id, item, qty, category required" });
  res.json(await reconcileSurplusSplit(db, { source_id, item, unit, qty, category }));
});

// Real check of whether the local Ollama server is reachable right now -
// not a hardcoded flag. Lets the frontend show live/fallback status honestly.
app.get("/api/llm-status", async (req, res) => {
  const reachable = await isOllamaReachable();
  res.json({ ollama_reachable: reachable, model: OLLAMA_MODEL });
});

app.get("/api/health", (req, res) => res.json({ ok: true, db: dbPath }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`NeedLink backend running on http://localhost:${PORT}`));