# Smoothest Route

A phone PWA that ranks Litchfield → Hartford commute corridors by **smoothness** (how close live
traffic runs to the posted speed limit), not just by ETA. See [docs/design.md](docs/design.md)
for the full design and [docs/CONTRACTS.md](docs/CONTRACTS.md) for module interfaces.

## How it works

1. On refresh the app asks the HERE Routing API v8 for one route per named corridor
   (forced through a `via` waypoint) plus HERE's own fastest route.
2. Each route's spans carry a posted limit (`maxSpeed`) and a live traffic speed
   (`dynamicSpeedInfo.trafficSpeed`). For each span, `r = min(live / limit, 1)`.
3. Smoothness `S = sqrt( Σ t·(1−r)² / Σ t )`, time-weighted. The badge shown is `100·(1−S)`.
4. Routes are sorted by S, with the ETA penalty vs. the fastest route shown beside each.

## Running

No build step. Any static server works:

```sh
npm test                 # unit tests (node:test, no dependencies)
python3 -m http.server   # then open http://localhost:8000/
```

Open `http://localhost:8000/?demo=1` to drive the UI from recorded fixtures without an API key.

## Deploying

Pushes to `master` run the tests and deploy the repo root to GitHub Pages via
`.github/workflows/pages.yml`. In the repository settings set **Pages → Source → GitHub Actions**.

## First-time setup on the phone

1. Get a HERE API key (see [docs/research.md](docs/research.md) for plan limits and how to
   restrict the key to your Pages origin).
2. Open the deployed site, go to **Settings**, paste the key, check the home/work and corridor
   waypoint coordinates, save.
3. Add to Home Screen. The key lives only in the phone's IndexedDB and is never committed.

## Layout

```
index.html  styles.css  sw.js  manifest.webmanifest  icons/
src/
  metric.js    scoring + ranking (pure)
  here.js      HERE v8 client, parser, flexible-polyline decoder, overlap
  storage.js   IndexedDB settings + history, CSV export
  maps.js      Open-in-Maps URLs
  defaults.js  default endpoints and corridors
  ui.js        render helpers (HTML strings)
  app.js       controller / router
tests/         node:test suites + recorded HERE fixtures
docs/          design doc, contracts, research notes
```
