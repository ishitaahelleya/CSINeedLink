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
const { haversineMiles } = require("./agents/util");

const dbPath = path.join(__dirname, "needlink.db");
const db = new Database(dbPath, { fileMustExist: true }); // run `npm run seed` first

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
    ORDER BY r.urgent DESC, r.created_at DESC
  `).all();
  res.json(rows);
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
app.post("/api/agents/fraud", (req, res) => res.json(verify(db, req.body)));
app.post("/api/agents/notification-governor", (req, res) => res.json(allocateSlots(db, req.body)));
app.post("/api/agents/donor-matching", (req, res) => res.json(matchDonors(db, req.body)));
app.post("/api/agents/forecasting", (req, res) => res.json(forecast(db, req.body)));
app.post("/api/agents/surplus-sensing", (req, res) => res.json(predictSurplus(db, req.body)));

// ---------- Reconciliation orchestrator (fans out to all agents above) ----------
app.post("/api/reconcile/request", (req, res) => {
  const { request_id, proposed_qty } = req.body;
  if (!request_id || !proposed_qty) return res.status(400).json({ error: "request_id and proposed_qty required" });
  res.json(reconcileRequestFulfillment(db, { request_id, proposed_qty }));
});

app.post("/api/reconcile/surplus", (req, res) => {
  const { source_id, item, unit, qty, category } = req.body;
  if (!source_id || !item || !qty || !category) return res.status(400).json({ error: "source_id, item, qty, category required" });
  res.json(reconcileSurplusSplit(db, { source_id, item, unit, qty, category }));
});

app.get("/api/health", (req, res) => res.json({ ok: true, db: dbPath }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`NeedLink backend running on http://localhost:${PORT}`));
