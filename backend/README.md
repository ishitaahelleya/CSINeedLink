# NeedLink backend — real multi-agent service

A real Express + SQLite backend. No mocking, no `setTimeout`-as-agent — every
endpoint below runs actual queries against `needlink.db` and returns real
computed output. Orchestration is **simple synchronous fan-out**: Reconciliation
calls each agent in sequence (Fraud first as a hard gate, then Capacity, then
Donor Matching + Notification Governor) and returns one ranked decision.

## Setup

```bash
cd backend
npm install
npm run seed     # builds needlink.db from seed/locations.json (safe to re-run — rebuilds fresh)
npm start         # http://localhost:4000
```

Requires Node 18+. `better-sqlite3` installs prebuilt binaries for common
platforms; if your platform needs a source build it'll compile automatically
via `node-gyp` (needs Python + a C++ toolchain — standard on most systems).

## Seed data — Dublin, Pleasanton, Livermore only

`seed/locations.json` — **all organization and club names are fictional**,
generated for this demo. Coordinates are real points inside Dublin,
Pleasanton, and Livermore, CA so distance math is genuine; the orgs sitting at
those points are not real nonprofits. Scale is intentionally modest (8 orgs,
6 school clubs, 3 surplus sources, capacities in the 10–50/day range) —
realistic for a Tri-Valley pilot, not a fictional mega-network.

Re-seed any time with `npm run seed` — it wipes and rebuilds `needlink.db`
from scratch, so it's safe to experiment against.

## Endpoints

**Reads**
- `GET /api/orgs?lat=&lng=&maxDistance=` — orgs, with real haversine distance + sort when lat/lng given
- `GET /api/requests` — open requests joined with their org
- `GET /api/clubs`, `GET /api/surplus-sources`, `GET /api/donors`
- `GET /api/trace/:correlationId` — full agent decision log for one reconciliation run (this is what powers the app's reasoning-trace UI)

**Individual agents** (each independently callable and testable)
- `POST /api/agents/capacity` — `{ org_id, qty }` → real headroom model (`daily_capacity - current_load`, scaled by staffing)
- `POST /api/agents/fraud` — `{ org_id?, source_id?, qty? }` → rules-based veto/freeze
- `POST /api/agents/notification-governor` — `{ candidateDonorIds, requestPriority }` → real weekly-budget slot allocation (mutates donor push counts)
- `POST /api/agents/donor-matching` — `{ request_id }` → donors ranked by real distance + interest overlap
- `POST /api/agents/forecasting` — `{ org_id, category }` → re-need likelihood from historical request pattern
- `POST /api/agents/surplus-sensing` — `{ source_id, hour? }` → surplus likelihood from time-of-day pattern

**Orchestrator** (fans out to the agents above, arbitrates, logs everything)
- `POST /api/reconcile/request` — `{ request_id, proposed_qty }` → Fraud gate → Capacity check → Donor Matching → Notification Governor → final decision, with full trace
- `POST /api/reconcile/surplus` — `{ source_id, item, unit, qty, category }` → Fraud gate → capacity-aware split across up to 3 orgs

## Proven end-to-end (from actual test runs during build)

```bash
curl -X POST localhost:4000/api/reconcile/request \
  -H "Content-Type: application/json" \
  -d '{"request_id":2,"proposed_qty":20}'
```
Real result: Capacity capped 20→15 (Amador Valley Family Shelter's actual
staffing-adjusted headroom). Donor Matching ranked "Pleasanton donor - Jamie"
#1 by distance, but Notification Governor denied her — her weekly push budget
was already spent — and granted the next two donors instead. That's a real
scarce-resource negotiation outcome, not a scripted line.

```bash
curl -X POST localhost:4000/api/reconcile/surplus \
  -H "Content-Type: application/json" \
  -d '{"source_id":"src_1","item":"bread loaves","unit":"loaves","qty":70,"category":"Food"}'
```
Real result: 70 loaves split 50/20 across Pleasanton Interfaith Food Bank and
Dublin Pantry Project — the first org's actual remaining capacity, then
overflow to the next-best.

## Wiring the frontend to this

`index.html` currently uses in-memory mock arrays and `setTimeout` to
simulate agent latency. To point it at this backend:

1. Serve this backend (`npm start`, port 4000) alongside the frontend.
2. Replace the mock `requests`/`communityEvents` arrays in `index.html` with a
   `fetch('http://localhost:4000/api/requests')` on load.
3. Replace the scripted `eveningStage` surplus sequence and the static
   `traceLog` with real calls to `/api/reconcile/surplus` and
   `/api/trace/:correlationId`.
4. Add CORS origin restriction (currently open) before deploying anywhere
   public.

## What's still simplified (honest scope)

- Fraud/Verification runs **synchronously** in this simple version (it's
  called and awaited like the others), not as a truly async background
  process with a late-arriving veto. Upgrading to that is the next step if
  you want the "genuinely async, can freeze something after the fact"
  behavior described in the original brief — it needs a queue (Redis
  Streams, or Postgres `LISTEN/NOTIFY`) instead of a direct function call.
- Forecasting and Surplus Sensing use simple frequency/time-of-day heuristics
  on real seed data, not a trained model. Real, just not ML.
- No auth on any endpoint yet.
