# Module contracts

Plain ES modules, no build step, no dependencies. Served as-is from GitHub Pages.
Tests use Node's built-in `node:test` + `node:assert/strict`, run with `npm test`.
All speeds internally are **m/s** (HERE's unit); the UI converts to mph for display.
All durations are **seconds**, lengths **metres**.

Every module must work in both the browser and Node (no `window` access at import time,
except `storage.js` and `app.js`, which are browser-only).

---

## `src/metric.js`  (pure, no I/O)

```js
/**
 * @typedef {Object} Span
 * @property {number} t        traversal time, seconds (>0)
 * @property {number} len      length, metres
 * @property {number|null} v   live traffic speed m/s (dynamicSpeedInfo.trafficSpeed) or null if absent
 * @property {number|null} L   posted limit m/s (maxSpeed) or null if absent
 * @property {number|null} base free-flow speed m/s (dynamicSpeedInfo.baseSpeed) or null
 */

/**
 * @typedef {Object} RouteScore
 * @property {number} S           time-weighted RMS of (1 - r), r = min(v/ref, 1). 0..1
 * @property {number} badge       Math.round(100 * (1 - S)), 0..100
 * @property {number} slowShare   fraction (0..1) of drive time with r < 0.5
 * @property {number} coverage    fraction (0..1) of drive time on spans with a usable live speed
 *                                (v present and v !== base). See "coverage" below.
 * @property {boolean} estimated  true if any span used base speed as reference because L was missing
 * @property {boolean} lowConfidence  coverage < 0.7
 * @property {number} durationSec  sum of t
 * @property {number} freeFlowSec  sum over spans of len / ref  (ref as defined below); the uncongested ETA
 * @property {number} delaySec     max(0, durationSec - freeFlowSec)
 * @property {Array<{r:number, t:number, len:number, cum:number, band:'green'|'amber'|'red'|'none'}>} segments
 *   one per input span in order; cum = cumulative length at span END; band from r (see below)
 */

export function scoreRoute(spans) -> RouteScore
```

Rules:
- Reference speed `ref` for a span = `L` if `L` is a positive number, else `base` if positive (and set `estimated=true`), else the span is **excluded** from S, slowShare, coverage numerator and denominator, but still counted in `durationSec` and `segments` with `band:'none'`, `r:NaN`.
- Live speed: if `v` is a positive number use it; if `v` is null/absent, use `base` if positive (r is then typically 1) — this is the "no live data" case and counts as **uncovered** for `coverage`. If neither, exclude as above.
- `coverage` numerator: time on spans where `v` is present **and** `v !== base` (equal-to-base means HERE had no live reading). If `base` is null and `v` present, count as covered.
- r = min(v / ref, 1). S = sqrt( Σ t(1−r)² / Σ t ) over included spans. If no spans included, S = NaN and badge = null.
- Bands: r ≥ 0.8 green, 0.5 ≤ r < 0.8 amber, r < 0.5 red.
- Throw `TypeError` on non-array input or a span with non-positive/non-numeric `t`.

```js
/**
 * @typedef {Object} RouteResult   produced by the fetch layer, consumed by rankRoutes and the UI
 * @property {string} corridorId
 * @property {string} name
 * @property {boolean} isFastest      true for the HERE "no via" route
 * @property {RouteScore|null} score  null if error
 * @property {number} etaSec          summary.duration
 * @property {number} lengthM         summary.length
 * @property {Array<[number,number]>} polyline   decoded [lat,lng] pairs
 * @property {string|null} error      human-readable error, score is null when set
 */

/**
 * @param {RouteResult[]} results
 * @param {{maxPenaltySec?: number, lengthRatioFlag?: number, overlapThreshold?: number}} opts
 *   defaults: maxPenaltySec 600, lengthRatioFlag 1.4, overlapThreshold 0.85
 * @returns {{ ranked: RankedRoute[], hidden: RankedRoute[], errors: RouteResult[] }}
 *
 * RankedRoute = RouteResult & {
 *   etaDeltaSec: number,        etaSec - min etaSec among non-error results
 *   flags: string[],            any of: 'estimated','low-confidence','long-detour','merged'
 *   mergedWith: string[]        names of corridors deduped into this one (overlap > threshold)
 * }
 */
export function rankRoutes(results, opts) 
```
Rules:
- Errors go to `errors`, never ranked. Baseline ETA = min over non-error results.
- Sort by S ascending; ties (|ΔS| < 1e-9) break on etaSec ascending.
- Routes with etaDeltaSec > maxPenaltySec go to `hidden` (still sorted).
- `long-detour` flag if lengthM > lengthRatioFlag × (length of the isFastest route, if present).
- Dedupe: `rankRoutes` accepts an optional `opts.overlap(a, b) -> 0..1` function (injected from here.js so metric.js stays pure of geometry). When provided, for each pair with overlap > overlapThreshold keep the one with lower S, add the other's name to `mergedWith`, flag 'merged', drop the other.

---

## `src/here.js`

```js
export class HereSchemaError extends Error {}   // response shape not what we expect
export class HereApiError extends Error { status: number }   // non-2xx

/** Build the request URL (string). via may be null/undefined for the fastest route. */
export function buildRouteUrl({ origin:[lat,lng], destination:[lat,lng], via, departureTime, apiKey })
//  GET https://router.hereapi.com/v8/routes?transportMode=car&origin=..&destination=..&via=..
//      &departureTime=..&return=polyline,summary&spans=maxSpeed,dynamicSpeedInfo,length,duration&apikey=..
//  departureTime: ISO string or 'any'; omit the param if undefined (HERE then uses now).

/**
 * Parse a HERE v8 /routes JSON body into our shape. Uses routes[0], concatenates all sections.
 * Throws HereSchemaError if: no routes, no sections, a section lacks polyline/summary/spans,
 * or spans lack numeric `duration`/`length`.
 * @returns {{ spans: Span[], polyline: Array<[number,number]>, etaSec: number, lengthM: number }}
 */
export function parseRouteResponse(json)

/** HERE flexible polyline decoder (https://github.com/heremaps/flexible-polyline). Returns [[lat,lng],...]. */
export function decodeFlexiblePolyline(str)

/**
 * Fraction of polyline `a`'s length that lies within `toleranceM` (default 30) of polyline `b`.
 * Symmetric overlap = min(overlap(a,b), overlap(b,a)). Use a grid/hash index so it is O(n) not O(n²).
 */
export function polylineOverlap(a, b, toleranceM = 30) -> number 0..1

/**
 * Fetch and parse one route. Uses global fetch (injectable for tests via opts.fetch).
 * On non-2xx throws HereApiError with status and HERE's error message if JSON.
 * @returns parsed result from parseRouteResponse plus `raw` (the JSON) for debugging
 */
export async function fetchRoute(params, opts = {})
```

Span mapping from HERE: each `sections[].spans[]` entry has `offset` (polyline vertex index),
`length`, `duration`, optional `maxSpeed` (m/s), optional `dynamicSpeedInfo:{baseSpeed, trafficSpeed, turnTime}`.
Map → `{ t: duration, len: length, v: trafficSpeed ?? null, L: maxSpeed ?? null, base: baseSpeed ?? null }`.
Also attach `offset` so the UI can map spans to polyline vertices.

---

## `src/defaults.js`

```js
export const DEFAULT_SETTINGS = {
  home:  { name: 'Litchfield', lat: 41.7473, lng: -73.1887 },
  work:  { name: 'Hartford',   lat: 41.7637, lng: -72.6851 },
  maxPenaltyMin: 10,
  apiKey: '',
  corridors: [
    { id: 'rt4',     name: 'Rt 4',            enabled: true, via: { lat: 41.7570, lng: -72.8870 }, note: 'Burlington / Unionville' },
    { id: 'us202',   name: 'US 202 → Rt 44',  enabled: true, via: { lat: 41.8100, lng: -72.8300 }, note: 'Canton / Avon' },
    { id: 'rt8',     name: 'Rt 8 → I-84',     enabled: true, via: { lat: 41.5560, lng: -73.0380 }, note: 'Waterbury interchange' },
  ],
};
export const FASTEST_ID = 'fastest';   // the no-via HERE route, always evaluated
```
Coordinates are approximate placeholders; Settings lets the user edit them.

---

## `src/storage.js`  (browser only; IndexedDB, no deps)

```js
export async function loadSettings() -> settings (DEFAULT_SETTINGS merged under stored values)
export async function saveSettings(settings)
export async function appendHistory(records)   // records: HistoryRecord[]
export async function listHistory({ since } = {}) -> HistoryRecord[]
export async function clearHistory()
export function historyToCsv(records) -> string

/** HistoryRecord = { ts: number (epoch ms), direction: 'toWork'|'toHome', corridorId, name, S, badge, etaSec, slowShare, coverage } */
```
DB name `smoothest-route`, version 1, stores `settings` (key 'main') and `history` (autoIncrement, index on `ts`).

---

## `src/maps.js` (pure)

```js
/** Google Maps directions URL with via waypoint. */
export function googleMapsUrl({ origin, destination, via })   // each {lat,lng}; via optional
/** Apple Maps URL (Apple has no via support; use daddr with '+to:' chaining). */
export function appleMapsUrl({ origin, destination, via })
export function isApplePlatform(ua = navigator.userAgent) -> boolean
```

---

## `src/app.js`, `index.html`, `styles.css`

Single-page, three views toggled by hash: `#/` ranking, `#/settings`, `#/history`.
- Direction toggle (To work / To home); default `toWork` before 12:00 local, else `toHome`.
- Refresh button → for each enabled corridor + fastest, call `fetchRoute` in parallel (`Promise.allSettled`),
  `scoreRoute` each, build `RouteResult[]`, `rankRoutes`, render cards. Append to history.
- Card: name, badge (0–100) coloured by band of S, ETA (min), Δ vs fastest, slow share %, flags chips.
  Expand → strip chart: an SVG bar of width 100% where each segment's width ∝ len and colour by band.
  "Open in Maps" button.
- Error card per failed corridor (message), never a score.
- Missing API key → banner linking to Settings.
- `?demo=1` in the URL loads `tests/fixtures/*.json` via fetch instead of HERE so the UI can be
  developed and screenshotted without a key.
- Mobile-first, works at 360px wide, dark-mode via `prefers-color-scheme`.

## `sw.js`, `manifest.webmanifest`
App-shell cache (index.html, styles.css, src/*.js, icons). Network-only for `router.hereapi.com`.
Cache name includes a version string; old caches deleted on activate.
