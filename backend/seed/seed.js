// Builds needlink.db from seed/locations.json.
// Run with: npm run seed
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const dbPath = path.join(__dirname, "..", "needlink.db");
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); // fresh seed each run
const db = new Database(dbPath);

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "locations.json"), "utf-8"));

db.exec(`
CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  category TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  daily_capacity INTEGER NOT NULL,
  current_load INTEGER NOT NULL DEFAULT 0,
  staffing_level INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  founded_year INTEGER
);

CREATE TABLE clubs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  type TEXT NOT NULL,
  member_count INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL
);

CREATE TABLE surplus_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  category TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  reliability_pct INTEGER NOT NULL,
  tier INTEGER NOT NULL
);

CREATE TABLE requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  item TEXT NOT NULL,
  unit TEXT NOT NULL,
  need INTEGER NOT NULL,
  have INTEGER NOT NULL DEFAULT 0,
  urgent INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE donors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  interests TEXT NOT NULL, -- comma separated categories
  pushes_this_week INTEGER NOT NULL DEFAULT 0,
  weekly_push_budget INTEGER NOT NULL DEFAULT 3
);

CREATE TABLE surplus_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES surplus_sources(id),
  item TEXT NOT NULL,
  unit TEXT NOT NULL,
  qty INTEGER NOT NULL,
  expires_minutes INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE agent_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  correlation_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const insOrg = db.prepare(`INSERT INTO orgs (id,name,city,category,lat,lng,daily_capacity,current_load,staffing_level,verified,founded_year)
  VALUES (@id,@name,@city,@category,@lat,@lng,@daily_capacity,0,@staffing_level,@verified,@founded_year)`);
data.orgs.forEach(o => insOrg.run({ ...o, verified: o.verified ? 1 : 0 }));

const insClub = db.prepare(`INSERT INTO clubs (id,name,city,type,member_count,lat,lng) VALUES (@id,@name,@city,@type,@member_count,@lat,@lng)`);
data.clubs.forEach(c => insClub.run(c));

const insSrc = db.prepare(`INSERT INTO surplus_sources (id,name,city,category,lat,lng,reliability_pct,tier) VALUES (@id,@name,@city,@category,@lat,@lng,@reliability_pct,@tier)`);
data.surplus_sources.forEach(s => insSrc.run(s));

// A handful of realistic open requests, scaled to each org's actual size (not "500,000 items" hackathon nonsense)
const sampleRequests = [
  { org_id: "org_1", item: "canned goods", unit: "cans", need: 120, have: 74, urgent: false, category: "Food" },
  { org_id: "org_2", item: "blankets", unit: "blankets", need: 25, have: 9, urgent: true, category: "Shelter" },
  { org_id: "org_3", item: "fresh produce boxes", unit: "boxes", need: 30, have: 22, urgent: false, category: "Food" },
  { org_id: "org_4", item: "school backpacks", unit: "backpacks", need: 40, have: 31, urgent: false, category: "Education" },
  { org_id: "org_5", item: "winter coats", unit: "coats", need: 18, have: 4, urgent: true, category: "Shelter" },
  { org_id: "org_7", item: "pantry staples", unit: "boxes", need: 60, have: 51, urgent: false, category: "Food" },
  { org_id: "org_6", item: "first aid kits", unit: "kits", need: 15, have: 6, urgent: true, category: "Health" },
  { org_id: "org_8", item: "children's clothing", unit: "bags", need: 12, have: 3, urgent: false, category: "Shelter" }
];
const insReq = db.prepare(`INSERT INTO requests (org_id,item,unit,need,have,urgent,category) VALUES (@org_id,@item,@unit,@need,@have,@urgent,@category)`);
sampleRequests.forEach(r => insReq.run({ ...r, urgent: r.urgent ? 1 : 0 }));

// A few sample donors near the Tri-Valley area, some already near their weekly push budget
const sampleDonors = [
  { name: "Dublin donor - Alex", lat: 37.7050, lng: -121.9310, interests: "Food,Education", pushes_this_week: 1, weekly_push_budget: 3 },
  { name: "Pleasanton donor - Jamie", lat: 37.6620, lng: -121.8760, interests: "Shelter,Health", pushes_this_week: 3, weekly_push_budget: 3 },
  { name: "Livermore donor - Sam", lat: 37.6825, lng: -121.7700, interests: "Food,Shelter", pushes_this_week: 0, weekly_push_budget: 3 },
  { name: "Pleasanton donor - Priya", lat: 37.6560, lng: -121.8830, interests: "Education,Food", pushes_this_week: 2, weekly_push_budget: 3 }
];
const insDonor = db.prepare(`INSERT INTO donors (name,lat,lng,interests,pushes_this_week,weekly_push_budget) VALUES (@name,@lat,@lng,@interests,@pushes_this_week,@weekly_push_budget)`);
sampleDonors.forEach(d => insDonor.run(d));

console.log("Seeded needlink.db:");
console.log(" -", data.orgs.length, "orgs (Dublin/Pleasanton/Livermore)");
console.log(" -", data.clubs.length, "clubs");
console.log(" -", data.surplus_sources.length, "surplus sources");
console.log(" -", sampleRequests.length, "open requests");
console.log(" -", sampleDonors.length, "donors");
db.close();
