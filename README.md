# NeedLink

An intelligent community donation network. Built for CSI Hacks 2026.

**"We tell you what's needed, before you have to ask."**

The frontend is deliberately the simplest surface possible — one obvious action per screen. The complexity lives in a multi-agent backend model (currently client-simulated, structured to drop in a real backend) and in the pieces that are already wired to real browser APIs.

## Run it

No build step. It's a single static HTML file.

```bash
npm start
# or just open index.html directly in a browser
```

Best viewed at mobile width (it's built mobile-first, capped at 480px).

## What's actually real vs. simulated

This was built hackathon-speed, so it's honest about which parts are live and which are mocked for the demo — swapping the mocked parts for real services is the natural next step, not a rewrite.

**Real, working today:**
- **Camera capture** — the scan button opens your actual device camera (`<input capture="environment">`), not a file-picker mockup.
- **Geolocation** — on load, the app requests your real location via `navigator.geolocation` and computes real haversine distances to every request, surplus match, and community event. Deny it and the app degrades gracefully to a default location.
- **Optional live AI vision** — drop your own Anthropic API key into Settings (⚙ on the home feed) and the item scanner calls the real Claude API (`claude-sonnet-4-6`, vision) directly from the browser to identify the item and read any printed quantity, then runs a client-side best-match scorer (category affinity + real distance + urgency) to recommend where to donate it. No key set → falls back to a mocked guess so the demo still works offline/without a key.
- **Native sharing** — event "share" buttons use `navigator.share` where available, with a clipboard fallback.
- **Every interaction** (pledges, onboarding, filters, inventory) is wired to real in-memory state — nothing is a static screenshot.

**Simulated for the demo (by design — see "What NOT to build" in the original brief):**
- Organization/request/event data in the **frontend** (`index.html`) is still mock/in-memory for the standalone single-file demo. A real, working backend for this data now exists in `/backend` (see below) — the frontend just isn't wired to it yet.
- No auth system — donor/org views are toggled directly.
- No payments, no KYC.

## `/backend` — a real multi-agent service (not simulated)

This is a genuine Express + SQLite backend, not a mock. Every agent below runs
real queries against a real database and returns real computed output —
tested end-to-end during the build (see `backend/README.md` for actual
request/response examples, including a run where Capacity genuinely capped a
request and Notification Governor denied the top-ranked donor because her
weekly budget was already spent).

```bash
cd backend
npm install
npm run seed   # builds needlink.db — Dublin, Pleasanton, Livermore only
npm start      # http://localhost:4000
```

- **Capacity** — real per-org headroom model (`daily_capacity - current_load`, staffing-adjusted)
- **Fraud/Verification** — rules-based veto/freeze (unverified orgs, new orgs, low-reliability surplus sources)
- **Notification Governor** — real weekly push-budget enforcement across donors, with genuine slot scarcity
- **Donor Matching** — ranks donors by real haversine distance + interest overlap
- **Forecasting / Surplus Sensing** — frequency/time-of-day heuristics over real historical data
- **Reconciliation** — orchestrator; fans out to all of the above synchronously and logs every input/output, queryable via `GET /api/trace/:correlationId`

Seed data covers **Dublin, Pleasanton, and Livermore, CA only** — 8 fictional
orgs, 6 fictional school clubs, 3 fictional surplus sources, all at real
coordinates in those three cities. Org/club names are invented for this demo,
not real nonprofits — see `backend/README.md` for the full disclosure and data
model.

The frontend isn't wired to this yet (see `backend/README.md` → "Wiring the
frontend to this" for the exact steps) — right now they're two working,
independently-testable pieces, not yet joined.

## Structure

Everything lives in `index.html` — HTML, CSS (custom properties for the brand system), and vanilla JS (no framework, no build step) in one file, organized top-to-bottom as: brand tokens → mock data → state → render functions (one per screen) → event handlers. Kept single-file on purpose for a hackathon judge to open and read start to finish; splitting into `/css`, `/js`, `/components` is a natural follow-up once this moves past demo stage.

## Brand system

| Token | Hex | Use |
|---|---|---|
| Background | `#4A2A28` | Page background |
| Surface | `#5C3634` | Cards |
| Accent | `#F0B34D` | CTAs, headlines, progress, active states |
| Cream | `#F3E9DC` | Body text |
| Muted | `#A88B82` | Secondary text |
| Teal | `#4E9E8F` | Reserved exclusively for surplus-sensing-origin content |

Font: [League Spartan](https://fonts.google.com/specimen/League+Spartan) throughout.

## Demo script (~3 min)

1. Land → "I want to help" → onboarding → feed appears (~30s)
2. Switch to org view → trigger the forecast alert → open the reasoning trace, narrate agent arbitration (~45s)
3. Trigger the 6 PM surplus sequence (bakery pre-flagged → business one-tap confirm → capacity-aware split across two orgs) (~40s)
4. Accept the forecasted request, cut to donor view, watch a pledge land live (~35s)
5. Scan a real item with the camera, watch the best-match reveal (~20s)
6. End on Impact, numbers ticking up (~15s)

## License

MIT — see `LICENSE`.
