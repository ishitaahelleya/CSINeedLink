const { haversineMiles } = require("./util");

// DONOR MATCHING AGENT
// Ranks which donors are worth notifying about a given request, based on
// real distance + interest overlap. Output feeds into Notification Governor,
// which may not have enough slots for everyone this agent recommends.
function matchDonors(db, { request_id }) {
  const request = db.prepare(`SELECT r.*, o.lat as org_lat, o.lng as org_lng, o.name as org_name
                               FROM requests r JOIN orgs o ON r.org_id = o.id WHERE r.id = ?`).get(request_id);
  if (!request) return { ok: false, reason: "unknown_request" };

  const donors = db.prepare(`SELECT * FROM donors`).all();
  const scored = donors.map(d => {
    const distMi = haversineMiles(d.lat, d.lng, request.org_lat, request.org_lng);
    const interests = d.interests.split(",").map(s => s.trim());
    const interestMatch = interests.includes(request.category) ? 1 : 0.3;
    const distScore = Math.max(0, 1 - distMi / 12);
    const score = interestMatch * 0.6 + distScore * 0.4;
    return { donor_id: d.id, name: d.name, distance_mi: Number(distMi.toFixed(2)), score: Number(score.toFixed(3)) };
  });

  scored.sort((a, b) => b.score - a.score);
  return { ok: true, request_id, org_name: request.org_name, ranked_donors: scored };
}

module.exports = { matchDonors };
