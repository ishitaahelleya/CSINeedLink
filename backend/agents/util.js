function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function logDecision(db, correlationId, agent, input, output) {
  db.prepare(
    `INSERT INTO agent_decisions (correlation_id, agent, input_json, output_json) VALUES (?,?,?,?)`
  ).run(correlationId, agent, JSON.stringify(input), JSON.stringify(output));
}

module.exports = { haversineMiles, logDecision };
