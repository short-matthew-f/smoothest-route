# Smooth Commute Router — Design Document

Oct 11, 2026 · @Matthew Short

## Overview and goals

The app ranks Litchfield→Hartford routes by how close live traffic runs to posted speed, not by ETA alone. The fastest route often wins on paper while delivering stop-and-go driving; this app makes that trade-off visible before departure.

**Goals**

- Score every candidate route on smoothness (live speed vs. posted limit) and show it beside ETA.
- Always evaluate the known corridors, not just the alternatives the routing engine volunteers.
- Run as a phone PWA, checked before leaving; one tap to see today's ranking.
- Cost nothing to run at one user's volume.

**Non-goals**

- Turn-by-turn navigation. The user opens the chosen route in their normal maps app.
- Multi-user accounts, sharing, or a backend server.
- General-purpose routing between arbitrary places in v1 (endpoints are configurable, but tuning targets this commute).

## Smoothness metric

Each route gets a smoothness score S: the time-weighted RMS shortfall of live speed against posted speed. Lower is smoother; 0 means every stretch runs at the limit.

For each road span i with live traffic speed vᵢ, posted limit Lᵢ, and traversal time tᵢ:

```latex
r_i = \min\left(\frac{v_i}{L_i},\ 1\right) \qquad S = \sqrt{\frac{\sum_i t_i\,(1 - r_i)^2}{\sum_i t_i}}
```

**Why not plain standard deviation.** Std dev of r measures only variability around the route's own mean. A route crawling steadily at 50% of the limit would score a perfect 0. RMS of (1 − r) measures distance from the target of 1, so it penalizes both stop-and-go and uniform slowness.

**Why time-weighted.** Minutes spent creeping are what make a commute miserable. Distance weighting would underweight a 0.3-mile jam that costs 6 minutes.

**Why cap r at 1.** Traffic flowing above the limit is not "extra smooth" and should not offset a jam elsewhere on the route.

**Secondary indicators** (shown, not ranked on):

- Slow share: percent of drive time spent below 0.5 × limit.
- Delay vs. free flow: ETA minus the ETA at base (uncongested) speed.

**Ranking.** Default sort is by S. Each row shows ETA delta vs. the fastest route, so the user decides the trade ("+4 min, much smoother"). A configurable max-penalty filter (default +10 min) hides routes that are smooth but absurdly long.

**Spans without a speed limit.** Fall back to base speed (the provider's free-flow speed) as the reference and flag the route as partially estimated.

## Data source

HERE Routing API v8 is the data source: it is the only mainstream router that returns live traffic speed and the posted limit per span in one response.

**Request shape** (one call per candidate corridor):

```
GET https://router.hereapi.com/v8/routes
  ?transportMode=car
  &origin=<home lat,lng>
  &destination=<work lat,lng>
  &via=<corridor waypoint lat,lng>
  &departureTime=<now or planned>
  &return=polyline,summary
  &spans=maxSpeed,dynamicSpeedInfo,length,duration
  &apikey=<key>
```

**Fields used**

| Field | Meaning | Use |
| --- | --- | --- |
| `maxSpeed` | Posted limit on the span (m/s) | Lᵢ in the metric |
| `dynamicSpeedInfo.trafficSpeed` | Live traffic speed (m/s) | vᵢ in the metric |
| `dynamicSpeedInfo.baseSpeed` | Free-flow speed (m/s) | Fallback reference; free-flow ETA |
| `duration` | Span traversal time (s) | tᵢ weight |
| `summary.duration` | Route ETA | ETA column |
| `polyline` | Route geometry | Map preview |

Spans are requested only alongside `polyline`, which HERE requires. HERE's changelog marks the `speedLimit` span type deprecated, so the app uses `maxSpeed` ([HERE API changes](https://developer.here.com/documentation/routing-api/release_notes/topics/api-changes.html), [spans guide](https://developer.here.com/documentation/routing-api/dev_guide/topics/spans-street-speed.html)).

**Rejected providers**

| Provider | Why rejected |
| --- | --- |
| Google Routes API | Traffic only as coarse categories (normal / slow / jam) per polyline interval; no posted limits. |
| TomTom Routing | Gives traffic delay per section, but no per-span posted limit in the route response. |
| OSRM / OpenStreetMap | No live traffic. OSM `maxspeed` tags are patchy on CT state routes. |

Pricing and free-tier limits need checking against HERE's current plans before build; expected volume is about 3 corridors × 2 checks/day ≈ 130 requests/month.

## Route candidates

The app scores a fixed set of named corridors on every check, each forced with a `via` waypoint, plus HERE's own fastest route. Routing engines often drop plausible corridors from their alternatives, so relying on `alternatives=N` would hide exactly the smooth-but-slightly-longer options this app exists to surface.

| Corridor | Via waypoint (approx.) | Character |
| --- | --- | --- |
| Rt 4 | Burlington / Unionville | Two-lane state road; signals in Farmington |
| US 202 → Rt 44 | Canton / Avon | Torrington and Avon commercial strips |
| Rt 8 → I-84 | Waterbury (Rt 8 / I-84 interchange) | Highway-heavy; I-84 congestion risk |
| HERE fastest | none | Whatever the engine picks today |

Waypoint coordinates are user-editable in settings, and corridors can be added or disabled. Duplicate detection: if two results share more than 85% of their polyline, show one and note the merge.

**Waypoint pitfall.** A `via` placed on the wrong side of a divided road or interchange forces a U-turn or loop. Each waypoint should sit on a through-lane mid-corridor; the app flags any result whose length exceeds the HERE fastest route by more than 40%.

## Architecture

The app is a static PWA hosted on GitHub Pages; all logic runs on the phone and the only live dependency is HERE. There is no backend, so there is nothing to run or pay for beyond the API.

&#91;embedded content: architecture · static PWA, one external API\]

On refresh, the fetcher reads the key and corridor waypoints from on-device storage, calls HERE once per corridor in parallel, and the scoring engine turns the returned spans into S per route. The chosen route opens in the user's normal maps app.

- **Stack:** plain HTML/JS (or a small Vite build), service worker for installability and offline shell.
- **API key:** entered once in Settings, stored in IndexedDB, never committed to the repo. Restricted to the Pages origin in HERE's console.
- **Fallback if CORS is blocked:** a free serverless function (e.g., Cloudflare Worker) that forwards the request and holds the key.

## UI

Three screens; the ranking screen is the whole app on a normal morning.

1. **Ranking** (home). Direction toggle (To work / To home, auto-selected by time of day). One card per route, sorted by S: corridor name, smoothness score as a 0–100 badge (100 = all at limit), ETA, delta vs. fastest, slow share. Tapping a card expands a strip chart of r along the route, coloured green / amber / red, so jams are visible by location. "Open in Maps" hands the route to Google or Apple Maps via waypoints.
2. **Settings.** Home and work coordinates, corridor list with editable waypoints, max ETA penalty, HERE API key.
3. **History** (phase 2). Per-corridor smoothness by weekday and departure time.

The badge maps S to 100 × (1 − S). Refresh is manual plus on app open; no background polling.

## Historical logging (phase 2)

Phase 2 records every check so the app can answer "which corridor is reliably smooth on a Tuesday at 7:40," not just "which is smooth right now."

- **Storage:** IndexedDB on the phone. One record per corridor per check: timestamp, direction, S, ETA, slow share. About 100 bytes each; years of data fit easily.
- **Passive collection only:** records accrue when the user opens the app. A scheduled logger (GitHub Actions cron calling HERE and committing JSON) is possible but adds key exposure in CI and is deferred.
- **History view:** median S and its spread per corridor, bucketed by weekday × 15-minute departure window. Spread matters as much as the median: a corridor that is usually smooth but occasionally terrible may be worse than a consistently middling one.
- **Export:** CSV download for analysis elsewhere.

## Risks, open questions, testing

**Risks**

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Rural CT roads lack live traffic coverage | `trafficSpeed` missing or equal to base speed; S looks falsely perfect | Report coverage % per route; flag routes under 70% as low-confidence |
| `maxSpeed` missing on some spans | No reference speed | Fall back to `baseSpeed`; mark route as partially estimated |
| Signals and stop signs invisible to live speed at low volume | Rt 4 / Rt 44 look smoother than they drive | Phase 2 history plus manual comparison against real drives |
| HERE changes or deprecates span fields | App breaks silently | Schema check on response; show an explicit error, never a score of 0 |
| API key exposed in a client-side app | Key abuse | Restrict key to the GitHub Pages origin in HERE's console; key stored only on device |

**Open questions**

- [ ] Does HERE Routing v8 allow browser (CORS) calls with an API key, or is a tiny proxy needed?
- [ ] Current HERE free-tier limits and whether a credit card is required.
- [ ] Exact waypoint coordinates for each corridor (pick on a map, verify no loops).
- [ ] Is span granularity on Rt 4 fine enough to see individual signal queues?

**Testing** (behaviour, not build metadata)

- Metric: a route at exactly the limit scores S = 0; a steady 50%-of-limit route scores S = 0.5 (std dev would give 0); above-limit spans do not lower S.
- Weighting: a short, slow span outweighs a long fast one in proportion to time.
- Fallbacks: spans with no `maxSpeed` use `baseSpeed` and set the estimated flag.
- Ranking: routes beyond the max ETA penalty are hidden; ties break on ETA.
- Parsing: recorded HERE responses for each corridor as fixtures; a malformed response yields an error card, not a score.

## Decision log

| Decision | Outcome | Reason |
| --- | --- | --- |
| Smoothness = std dev of speed / posted speed | Rejected | Rates a uniformly slow route as perfect |
| Smoothness = time-weighted RMS of (1 − r), r capped at 1 | Accepted | Penalizes stop-and-go and uniform slowness; jams weighted by time lost |
| Distance weighting | Rejected | Underweights short jams that cost the most time |
| HERE Routing v8 | Accepted | Only provider returning live speed and posted limit per span |
| Google Routes / TomTom / OSRM | Rejected | Coarse categories, no limits, or no live traffic (see Data source) |
| `speedLimit` span | Rejected | Deprecated by HERE; use `maxSpeed` |
| Rely on engine alternatives only | Rejected | Engines drop plausible corridors; force corridors via waypoints |
| Publish as a claude.ai artifact | Rejected | Published artifacts block external network calls |
| Self-hosted PWA on GitHub Pages | Accepted | Free hosting; can call HERE directly (pending CORS check) |
| Turn-by-turn navigation | Rejected (non-goal) | Hand off to existing maps apps |
| Scheduled cloud logger | Deferred | Key exposure in CI; passive on-device logging first |
