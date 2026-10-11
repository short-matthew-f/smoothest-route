# HERE Routing v8 research notes

Checked 2026-10-11 (all "today" statements below refer to this date). Context: static PWA on GitHub Pages calling `https://router.hereapi.com/v8/routes` directly from the browser, about 130 requests/month, key restricted to the Pages origin.

## Bottom line

Direct browser calls: **yes (CORS verified live on the real endpoint; not yet verified on an authenticated 200 because no valid key was available)**. Free tier: **Base plan, free monthly allowance per product; the official number could not be read (the pricing pages are JS-rendered or blocked), third-party sources say 5,000 to 30,000 routing transactions/month, either way far above ~130; card required: yes** (HERE's own getting-started blog; the no-card Limited plan was retired 2025-08-31). Key restriction is "Trusted domains" on the app in Access Manager (domain only, no path, up to 30 min to propagate). Span field names and units are confirmed from the live OpenAPI document. Two design.md issues found: the `via` must use `!passThrough=true` or HERE splits the route into sections and makes the via a stop, and the Rt 8 / I-84 corridor is likely to trip the "longer than fastest by 40%" flag (see Q6).

---

## 1. CORS

**Result: CORS is enabled, with `?apikey=` auth. Tested live today.**

Actual commands run from this sandbox (through the agent proxy; the proxy worked, no README fix needed), 2026-10-11 16:14 to 16:15 UTC:

```
$ curl -sS -D - -o /dev/null -H "Origin: https://example.github.io" \
  "https://router.hereapi.com/v8/routes?transportMode=car&origin=41.747,-73.189&destination=41.764,-72.685&return=summary&apikey=INVALID"
HTTP/1.1 401 Unauthorized
Content-Type: application/json
Server: openresty
Access-Control-Allow-Credentials: true
Access-Control-Allow-Origin: https://example.github.io
X-Correlation-ID: 32ae9843-cb7d-405b-bb59-173b104dde6a
X-Request-Id: REQ-0f7a6179-...
```

Body: `{"error":"Unauthorized","error_description":"apiKey invalid. apiKey not found."}` (so the lowercase `apikey` query name is accepted as the API-key parameter).

CORS preflight (`OPTIONS` with `Access-Control-Request-Headers: authorization,content-type`) on the same URL:

```
HTTP/1.1 200 OK
access-control-allow-origin: *
access-control-allow-methods: GET, POST
access-control-allow-headers: authorization,content-type
access-control-max-age: 86400
access-control-expose-headers: X-Request-Id,x-irt,x-ra
vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers
```

Notes:
- The 401 carries ACAO, so a browser `fetch` will see HERE error JSON instead of an opaque CORS failure. The app can show "invalid key" properly.
- A plain `GET` with no custom headers is a "simple" request: no preflight at all. Keep it that way (do not add `Authorization` or `Content-Type`).
- Not verified: the ACAO header on a 200 with a real key. It is the same gateway (openresty / `x-served-by: ...gemini...`), and the 401 path already emits it, so very likely identical, but confirm with the first real key. Also not verified: a documented statement from HERE about CORS. I searched HERE docs (docs.here.com/routing quick-start, Routing v8 OpenAPI) and found no CORS text, so the evidence is empirical (headers above), not a documented guarantee. HERE's own Maps API for JavaScript and reference client call the same host from browsers, which is consistent with this.
- Sources: live test above; quick-start (apiKey as a query param, no CORS mention): https://docs.here.com/routing/docs/routing-v8-get-started (checked 2026-10-11).
- Fallback (Cloudflare Worker proxy) is therefore not needed for CORS.

## 2. Pricing / free tier

**Official numbers: could not be verified. Facts split by confidence.**

Verified from HERE (blog "How to Get Started with the HERE platform", https://www.here.com/learn/blog/how-to-get-started-with-here-platform, checked 2026-10-11):
- Base Plan **requires a credit card at registration**, but "users will not be charged unless they exceed the free tier of any Platform Resource".
- The older Limited Plan (no card, 1,000 free daily requests) is **retired**: a HERE knowledge-base article reported by search says retired 2025-08-31, no new sign-ups from 2025-03-27 (https://docs.here.com/here-kb/docs/can-i-switch-from-here-base-plan-to-here-limited-plan; the page returned 404 to a direct fetch, so this is from the search snippet only).
- HERE's pricing page https://www.here.com/get-started/pricing is JS-rendered and exposes no numbers to a fetch ("HERE Base Plan Pricing", "Get started for free"). developers.here.com/pricing returned 503 / TLS handshake failure. So the exact monthly free allowance for Routing was **not** read from HERE.

Third-party, conflicting (low confidence):
- placematic.com (updated Aug 2026): Routing draws from a **5,000 transactions/month** free tier; also notes about +6% price rise from 2026-04-01. https://placematic.com/here-location-services/here-pricing/
- apio.sh (verified 2026-06-14) and apicostcalc.com (2026-08-15): **30,000 transactions/month** under the Base plan. apio says card required; apicostcalc says "no card" (it appears to describe the retired Limited plan; treat as wrong). https://apio.sh/apis/here-routing , https://apicostcalc.com/here.html
- The "250,000/month freemium" figure is from a 2018 press release and an old developer-portal page; ignore.

Standard vs advanced:
- HERE's 2024-01-25 blog states that a basic v8 request with no `departureTime`/`arrivalTime` "would be categorized as a Time Aware Routing for pricing purposes", because departure defaults to now: https://www.here.com/developer/blog/time-aware-route-routing-v8 . design.md sends `departureTime=<now or planned>`, so every call is "Time Aware Routing" regardless.
- apio.sh lists time-aware routing at about $0.0028/transaction (about $2.80 per 1,000) versus about $0.83 per 1,000 for plain car routing. Unverified. Even if all 130 requests were billed at that rate, the cost is about $0.36/month, and it is zero if they fall inside the free allowance.
- I found no source saying that adding `spans=` (including `dynamicSpeedInfo`) changes the transaction category or count. Not verified either way. One call = one transaction for a single origin/destination pair (the multiplier rules cited by HERE apply to matrix routing with 5+ origins/destinations).

Practical conclusion: at ~130 requests/month the app is inside any plausible free tier (even the lowest figure, 5,000). A card is needed to sign up; consider setting a billing alert or using the account's usage page, since a leaked key is the only realistic way to incur charges.

## 3. API key restriction (Trusted domains)

HERE calls this **Trusted domains**, set per app (not per key). Steps as documented today (https://docs.here.com/identity-and-access-management/docs/plat-using-apikeys and https://www.here.com/learn/blog/trusted-domains-here-platform, checked 2026-10-11):

1. Sign in to the HERE platform (platform.here.com), open **Access Manager** from the launcher.
2. **Apps** tab, select the app. (API key itself: app **Credentials** tab, **API Keys**, **Create API key**; max 2 keys per app.)
3. Open the **Trusted domains** tab, add the domain(s), then toggle **Enable trusted domains** on.

Details:
- Default: any website can use the key until trusted domains are enabled. Empty list with the toggle on: no effect (any domain).
- Entry format: domain only, **no paths**. Optional protocol, port or IPv4. Max 2048 chars. Examples that fit this app: `youruser.github.io` (matches the host with any protocol/port/subdomain) or `https://youruser.github.io` (only https). Do not use `github.io` alone (would trust every Pages site). The project-site path (`/smoothest-route/`) cannot be restricted.
- A stored bare domain matches referrers with protocol, port, or subdomain; a stored subdomain does not match its parent; a stored `https://example.com` does not match a referrer of `example.com` (HERE's own match table).
- Limits: 20 domains via the web UI, up to 3,000 via the HERE (OLP) CLI.
- Propagation: up to 30 minutes (stated in the IAM doc; the blog post does not mention it).
- Works only with API keys (not OAuth tokens).
- Not stated in the docs: whether HERE checks the `Origin` header, the `Referer` header, or both. The doc's table talks about "referrers". Browsers send both on a cross-origin `fetch`; do not set `referrerPolicy: "no-referrer"` on the fetch, and test after enabling (a restricted key from a wrong origin should be rejected). Not testable here: no key.
- This is a soft control: anyone can spoof Referer/Origin with curl, and the key is visible in DevTools. It stops casual reuse from other websites only. Keep usage alerts on.

## 4. Span fields

Source: the live OpenAPI document served by HERE at `https://router.hereapi.com/v8/openapi` (info.version **8.164.0**, fetched 2026-10-11, no key needed), plus docs page https://docs.here.com/routing/docs/routing-v8-span (checked 2026-10-11).

| Field | Where | Type / unit (quoted from the schema) |
| --- | --- | --- |
| `maxSpeed` | span | "Speed in meters per second, or `"unlimited"` indicating that the speed is unlimited, e.g., on a German autobahn". `oneOf: number (minimum 0) | string enum [unlimited]` |
| `dynamicSpeedInfo.trafficSpeed` | span | "Estimated speed (in meters per second) ... taking into account traffic-related constraints". Same as `baseSpeed` if `traffic[mode]=disabled` |
| `dynamicSpeedInfo.baseSpeed` | span | "Estimated speed (in meters per second) without considering any traffic-related constraints" |
| `dynamicSpeedInfo.turnTime` | span | "Estimate of the time (in seconds) it takes to turn from this span into the next" (integer seconds) |
| `length` | span | `Distance`: integer, **meters** |
| `duration` | span | `Duration`: integer, **seconds** |
| `offset` | span | integer index into the section's decoded polyline |

Rules and gotchas:
- `dynamicSpeedInfo` requires all three of `trafficSpeed`, `baseSpeed`, `turnTime` (schema `required`), so `trafficSpeed`/`baseSpeed` are always present when `dynamicSpeedInfo` is present. Whether `dynamicSpeedInfo` itself is present on every span (rural CT) is not guaranteed by the schema: it is optional on the span. Code must handle a missing `dynamicSpeedInfo`.
- `maxSpeed` is optional on a span (not in the schema's `required`), and can be the **string `"unlimited"`** (rare in CT, but the type allows it). Parse as `typeof v === "number" ? v : (v === "unlimited" ? Infinity/ignore : missing)`. Treat 0 with suspicion (schema minimum is 0).
- `spans` requires `return=polyline`: the `spans` parameter text says "This parameter also requires that the `polyline` option is set within the `return` parameter", and the `return` text says "If at least one attribute is requested within the `spans` parameter, then `polyline` must be request[ed] as well". Docs page: start/end of spans derive from the polyline.
- `spans` is a comma-separated list; allowed values include `length, duration, baseDuration, typicalDuration, maxSpeed, dynamicSpeedInfo, speedLimit (deprecated), segmentId (deprecated), segmentRef, ...`. design.md's `spans=maxSpeed,dynamicSpeedInfo,length,duration` is valid. The `speedLimit` deprecation note is confirmed in the same text ("use maxSpeed instead").
- A new span starts whenever any requested attribute changes; `length`, `duration` and `consumption` do NOT split spans. `dynamicSpeedInfo` changes often, so expect many spans.
- Spans live under each `sections[i].spans`. Without `passThrough` on a via, a route has multiple sections, and `offset` is relative to the section's own polyline. Score all sections (see Q7).

Example span: the HERE docs and the OpenAPI examples do **not** include a genuine `maxSpeed`/`dynamicSpeedInfo` example span. The only genuine example (OpenAPI, Berlin) is a `names` span: `{"offset": 49, "names": [{"value": "Invalidenstraße", "language": "de"}, {"value": "Sandkrugbrücke", "language": "de"}], "length": 51}`. A schema-conformant illustration, **constructed by me, not copied from HERE**, with invented values for a 40 mph limit (17.88 m/s):

```json
{ "offset": 12, "length": 318, "duration": 24,
  "maxSpeed": 17.88,
  "dynamicSpeedInfo": { "trafficSpeed": 13.4, "baseSpeed": 17.9, "turnTime": 2 } }
```

Use real recorded responses as test fixtures once a key exists.

## 5. Flexible polyline

- Spec/README: https://github.com/heremaps/flexible-polyline (README: https://github.com/heremaps/flexible-polyline/blob/master/README.md ), linked from HERE's span docs. Checked 2026-10-11.
- Format: `[header version][header content][data]`. Alphabet `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_` (`A`=0, `_`=63). Each integer is emitted in 5-bit chunks, little-endian, continuation flag 0x20 on all but the last chunk. Signed: zigzag-like (`v<0 ? ~(v<<1) : v<<1`, so decoding is `u&1 ? ~(u>>1) : u>>1`). First varint = version (1). Second varint = header content: bits 0-3 = 2D precision, bits 4-6 = 3rd dim type (0 none, 1 level, 2 altitude, 3 elevation, 6/7 custom), bits 7-10 = 3rd dim precision. Then tuples of 2 (or 3) signed varints; first tuple absolute, rest are deltas; divide by 10^precision. Use 64-bit-safe integer math when precision is large (not an issue at HERE's precision 5, but JS bitwise ops are 32-bit, so use multiplication/`Math.floor` or BigInt in the varint accumulator).
- Official example (README): input (50.10228, 8.69821), (50.10201, 8.69567), (50.10063, 8.69150), (50.09878, 8.68752), precision 5, no third dimension, encodes to `BFoz5xJ67i1B1B7PzIhaxL7Y`. I implemented the decoder from the spec in Python and it reproduces exactly those four points from that string.
- Test vector files (3,072 cases each, one case per line, same line number across files): `test/original.txt`, `test/round_half_up/{encoded,decoded}.txt`, `test/round_half_even/{encoded,decoded}.txt` (raw URL pattern `https://raw.githubusercontent.com/heremaps/flexible-polyline/master/test/round_half_up/encoded.txt`). Choose the folder matching the rounding of your language (JS `Math.round` rounds ties toward +infinity, which is neither exactly half-up-away-from-zero nor half-even, so for encode tests prefer decode-only tests, or avoid exact ties). Only 59 of 3,072 encoded lines differ between the two folders. A line format is `{(prec2D[, thirdType, prec3D]); [(a, b[, c]), ...]}`.
- Important for tests: the values in these files are abstract tuples, **not lat/lng ordered or range-limited** (first value goes beyond 90). The decoder must not clamp or swap them. Decode-only tests are the safe ones (the format is lossy; re-encoding `original.txt` should give `encoded.txt`, but decoding `encoded.txt` gives `decoded.txt`, not `original.txt`).
- Small 2D vectors I verified with my decoder (line numbers in `round_half_up`, precision 5, 2D):
  - line 48: `BF4lj8W_-0-J` decodes to `[(119.94716, -52.20848)]`
  - line 176: `BFioioS_1wiBrl_4K10m9L` decodes to `[(95.69409, -5.656), (39.17355, -68.11307)]`
  - line 304: `BFn0yrRx7-uL0xhxDwsyrV2zxpK9txvB` decodes to `[(-91.0266, -60.12345), (-72.50474, 51.87343), (-18.51119, 44.08368)]`
  - line 8 (precision 0): `BA3E0E` decodes to `[(-76, 74)]`
- HERE route polylines are returned per section as `sections[i].polyline` (precision 5 typically, with a possible 3rd dimension if `return=elevation` is requested; not requested here, but the decoder should read the header, not assume 2D).

## 6. Corridor waypoints

Method: Nominatim (found the road ways), then the OSM API (`api.openstreetmap.org/api/0.6`) to read the actual way nodes, tags (`ref`, `oneway`, `lanes`) and to check that the chosen node is a plain mid-segment node (not a junction) of a single two-way way. Overpass was down/blocked through the proxy, so it was not used. Finally each point was checked with the public OSRM demo router (`router.project-osrm.org`, no live traffic) for: no u-turn maneuvers, the expected road names, and detour size. Origin 41.7473,-73.1887 (Litchfield green), destination 41.7637,-72.6851 (Hartford). Straight-line baseline 41.8 km.

| Corridor | Via (lat,lng) | OSM basis | OSRM check (not HERE) |
| --- | --- | --- | --- |
| Rt 4 | **41.7738,-72.9495** | OSM node 6503003633 on way 674952234, "Spielman Highway", `ref=CT 4`, `highway=primary`, 2 lanes, 40 mph, two-way, no junction within 150 m. Burlington | Route 49.7 km, 0 u-turns, roads CT 118 then CT 4 |
| US 202 to Rt 44 | **41.8296,-72.9023** | OSM node 1836634598 on way 1271084745, "Albany Turnpike", `ref=US 44;US 202`, `highway=trunk`, 4 lanes, 40 mph, a **single centerline way (not `oneway`)**, i.e. undivided, so the point is valid in both directions. Canton, just past the signal at 41.8292,-72.9016 | Route 51.4 km (identical to OSRM's own fastest), 0 u-turns, US 202 / US 44 |
| Rt 8 to I-84, direction Litchfield to Hartford (EB) | **41.5380,-73.0040** | OSM node 12117505023 on way 235427390, `ref=I 84`, `oneway=yes`, 3 lanes, 55 mph, node order runs west to east (EB). About 2.5 km east of the Rt 8 / I-84 interchange (interchange is around 41.551,-73.037), no junction for several hundred meters either side | Route 75.6 km, 0 u-turns, CT 118 > CT 254 > CT 8 > I 84 |
| Rt 8 to I-84, direction Hartford to Litchfield (WB) | **41.5382,-73.0040** | OSM node 1827178578 area on way 235427388, `ref=I 84`, `oneway=yes`, 3 lanes, node order east to west (WB). Parallel carriageway, about 47 m north of the EB point | Route 75.7 km, 0 u-turns |

Direction matters for I-84 only (Rt 4 and US 44 here are single two-way centerlines). I-84 and Rt 8 are separate one-way carriageways about 47 m apart here. Test of the failure mode: using the EB point (41.5380) for the Hartford-to-Litchfield trip made OSRM route 84.7 km instead of 75.7 km (+9 km, a forced loop via ramps; OSRM did not emit a literal u-turn but HERE with `passThrough=true` may refuse or detour similarly). So `defaults.js` needs the I-84 via per direction (the app already has a To work / To home toggle). A direction-neutral alternative would be `;radius=100` (HERE: "consider all places within the given radius"; max 200 m), but that is untested and could match a ramp or the wrong road, so I do not recommend it as default.

Two things the sanity check surfaced that affect design.md:

1. **`passThrough` is required.** In the OpenAPI text, a `via` defaults to `passThrough=false`: "The route will stop at the via waypoint, creating a new route section". `passThrough=true` asks the router to avoid "introducing a stop... splitting the route into sections... changing the direction of travel". design.md's request shape has plain `via=<lat,lng>`. Use `via=41.7738,-72.9495!passThrough=true` (waypoint options use `!`; place options like `;radius=` use `;`). Otherwise the route is two sections and the via is treated as a stop (u-turn allowed unless avoided). Fix in design.md and in the fetcher/scorer (which should still loop over all `sections` for robustness).
2. **The Rt 8 / I-84 corridor will probably trip the 40% length flag.** OSRM: 75.6 km vs 51.4 km fastest = +47%. The straight-line sums (via points) are 64.4 km vs 41.8 km direct. ETA also differs (about 66 min vs 49-51 min on OSRM). Consider raising the flag threshold for this corridor (or per-corridor) or the flag fires every time, which is correct information but not a loop. The US 44 corridor is likely the same road as HERE's own fastest (OSRM agrees), so the duplicate-merge (>85% shared polyline) rule will merge them; expected, not a bug. Unverified on HERE: its fastest route might differ from OSRM's.

Not checked: whether the via snaps to this road on HERE's map (HERE matches to the nearest road; points are on the centerline nodes so this should hold; an unusual snap would show up as a polyline deviating or `notices`). Confirm with the first real response by decoding the polyline and checking it passes within about 30 m of each via.

## 7. Other gotchas for direct-from-browser use

- **Auth**: the API key goes in the **query string** (`apiKey`, OpenAPI `securitySchemes.ApiKey: in: query, name: apiKey`; lowercase `apikey` is accepted, per the live 401). The `Authorization: Bearer` scheme in the OpenAPI is for OAuth JWTs from a HERE service-account (token flow), not for API keys. Using it needs a preflight and a server-held secret; not applicable here.
- **No required User-Agent**: browsers can't set it anyway; the live tests above used curl's default UA and got normal responses. (Nominatim, unrelated, does require an identifying UA.)
- **Keep requests "simple"**: GET with no custom headers means no preflight. If a preflight does occur, HERE answers it (headers listed in Q1), allowing `authorization` and `content-type` only.
- **Rate limits**: no per-second number found in the Routing docs or OpenAPI (it defines a `429 Too many requests` response, error code E605501). HERE's knowledge base says per-account limits are shown in the platform portal under Organization Details, and per-app limits under Access Manager, app, **Rate Limits** tab (search snippet; page 404 on direct fetch). A third-party R package doc quotes about 10 RPS for Routing on freemium, undated. Three parallel calls per refresh is far below any plausible limit. Handle 429 with an error card plus retry.
- **Errors**: 401 body is `{"error":"Unauthorized","error_description":"apiKey invalid. apiKey not found."}`; v8 errors elsewhere use `{title, status, code, cause, action, correlationId}`. Show `X-Request-Id`/`correlationId` in the error card (exposed via `Access-Control-Expose-Headers` for `X-Request-Id`).
- **Key exposure**: query-string keys land in browser history, referrers to other hosts (none here), and any proxy logs. The PWA stores it in IndexedDB; trusted domains are only a soft limit (Q3). Two keys per app are allowed, so rotate by creating the second, switching, then deleting the first.
- **Service worker**: do not cache HERE responses blindly (live traffic) and don't precache the URL that includes the key. Use network-only for `router.hereapi.com`.
- **`departureTime`**: omitted or `now` both mean live traffic (and "time aware" pricing). `departureTime=any` is planning mode and uses only long-term incidents, so it would defeat the purpose of the app.
- **Coverage**: `trafficSpeed` equals `baseSpeed` when `traffic[mode]=disabled`; for rural CT roads without live data HERE may still return `dynamicSpeedInfo` with the two equal, which the design's coverage % check should compare against (not just presence).
- **Not verified**: whether `spans=dynamicSpeedInfo` has any extra cost or extra response-size limit; response size with `polyline`+`spans` for a 40 km route (expected tens of KB; not measured since no key).

---

## Recommended defaults.js coordinates

```js
// lat, lng; checked against OSM way geometry on 2026-10-11 (see docs/research.md Q6)
// Use as: via=<lat>,<lng>!passThrough=true
export const DEFAULT_ORIGIN      = { lat: 41.7473, lng: -73.1887 }; // Litchfield town green
export const DEFAULT_DESTINATION = { lat: 41.7637, lng: -72.6851 }; // Hartford downtown

export const DEFAULT_CORRIDORS = [
  // CT 4 "Spielman Highway", Burlington. Two-lane undivided; valid both directions.
  { id: 'rt4',   name: 'Rt 4',            via: { lat: 41.7738, lng: -72.9495 } },
  // US 44 / US 202 "Albany Turnpike", Canton. Single centerline (undivided); valid both directions.
  { id: 'us44',  name: 'US 202 / Rt 44',  via: { lat: 41.8296, lng: -72.9023 } },
  // I-84 is two one-way carriageways ~47 m apart: pick the via by trip direction.
  { id: 'rt8i84', name: 'Rt 8 / I-84',
    viaByDirection: {
      toHartford:   { lat: 41.5380, lng: -73.0040 }, // I-84 eastbound, east of Rt 8 interchange
      toLitchfield: { lat: 41.5382, lng: -73.0040 }, // I-84 westbound, same stretch
    } },
];
```
