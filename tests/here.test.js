import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  HereSchemaError,
  HereApiError,
  buildRouteUrl,
  parseRouteResponse,
  parseRoutesResponse,
  decodeFlexiblePolyline,
  polylineOverlap,
  fetchRoute,
  fetchRoutes,
} from '../src/here.js';

const fixture = (name) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));

// --- test-only flexible polyline encoder (kept out of src/) -----------------
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function encVar(n) {
  let s = '';
  while (n >= 0x20) {
    s += ALPHA[(n & 0x1f) | 0x20];
    n = Math.floor(n / 32);
  }
  return s + ALPHA[n];
}
const zigzag = (d) => (d < 0 ? -2 * d - 1 : 2 * d);
function encodeFlex(coords, { precision = 5, thirdDim = 0, thirdPrecision = 0 } = {}) {
  const f = 10 ** precision;
  const f3 = 10 ** thirdPrecision;
  const header = precision | (thirdDim << 4) | (thirdPrecision << 7);
  let out = encVar(1) + encVar(header);
  let pa = 0;
  let pb = 0;
  let pc = 0;
  for (const c of coords) {
    const a = Math.round(c[0] * f);
    const b = Math.round(c[1] * f);
    out += encVar(zigzag(a - pa)) + encVar(zigzag(b - pb));
    pa = a;
    pb = b;
    if (thirdDim) {
      const z = Math.round(c[2] * f3);
      out += encVar(zigzag(z - pc));
      pc = z;
    }
  }
  return out;
}

const KEY = 'TESTKEY';
const A = [41.7473, -73.1887];
const B = [41.7637, -72.6851];

// --- buildRouteUrl ----------------------------------------------------------
test('buildRouteUrl includes every parameter with apikey last', () => {
  const url = buildRouteUrl({
    origin: A,
    destination: B,
    via: [41.757, -72.887],
    departureTime: '2026-10-12T07:30:00-04:00',
    apiKey: KEY,
  });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://router.hereapi.com/v8/routes');
  assert.equal(u.searchParams.get('transportMode'), 'car');
  assert.equal(u.searchParams.get('origin'), '41.7473,-73.1887');
  assert.equal(u.searchParams.get('destination'), '41.7637,-72.6851');
  assert.equal(u.searchParams.get('via'), '41.757,-72.887!passThrough=true');
  assert.equal(u.searchParams.get('departureTime'), '2026-10-12T07:30:00-04:00');
  assert.equal(u.searchParams.get('return'), 'polyline,summary');
  assert.equal(u.searchParams.get('spans'), 'maxSpeed,dynamicSpeedInfo,length,duration');
  assert.equal(u.searchParams.get('apikey'), KEY);
  assert.ok(url.endsWith(`&apikey=${KEY}`));
  assert.ok(url.includes('+') === false, 'timezone plus must be percent-encoded');
});

test('buildRouteUrl omits via when null/undefined and departureTime when undefined', () => {
  for (const via of [null, undefined]) {
    const url = buildRouteUrl({ origin: A, destination: B, via, apiKey: KEY });
    const u = new URL(url);
    assert.equal(u.searchParams.has('via'), false);
    assert.equal(u.searchParams.has('departureTime'), false);
    assert.ok(url.endsWith(`&apikey=${KEY}`));
  }
  const any = new URL(buildRouteUrl({ origin: A, destination: B, departureTime: 'any', apiKey: KEY }));
  assert.equal(any.searchParams.get('departureTime'), 'any');
});

test('buildRouteUrl accepts {lat,lng} points and rejects bad ones', () => {
  const url = buildRouteUrl({
    origin: { lat: 41.7473, lng: -73.1887 },
    destination: { lat: 41.7637, lng: -72.6851 },
    via: { lat: 41.757, lng: -72.887 },
    apiKey: KEY,
  });
  assert.equal(new URL(url).searchParams.get('via'), '41.757,-72.887!passThrough=true');
  assert.throws(() => buildRouteUrl({ origin: null, destination: B, apiKey: KEY }), TypeError);
});

// --- decodeFlexiblePolyline -------------------------------------------------
test('buildRouteUrl emits one via param per point in order (vias array)', () => {
  const vias = [[41.1, -72.1], { lat: 41.2, lng: -72.2 }, [41.3, -72.3]];
  const url = buildRouteUrl({ origin: A, destination: B, vias, apiKey: KEY });
  const u = new URL(url);
  assert.deepEqual(u.searchParams.getAll('via'), [
    '41.1,-72.1!passThrough=true',
    '41.2,-72.2!passThrough=true',
    '41.3,-72.3!passThrough=true',
  ]);
  assert.ok(url.endsWith(`&apikey=${KEY}`));
  assert.equal(new URL(buildRouteUrl({ origin: A, destination: B, vias: [], apiKey: KEY })).searchParams.has('via'), false);
  assert.throws(() => buildRouteUrl({ origin: A, destination: B, vias: [[1, 2], null], apiKey: KEY }), TypeError);
});

test('buildRouteUrl: legacy via equals vias [via]; vias wins when both given', () => {
  const legacy = buildRouteUrl({ origin: A, destination: B, via: [41.1, -72.1], apiKey: KEY });
  const arr = buildRouteUrl({ origin: A, destination: B, vias: [[41.1, -72.1]], apiKey: KEY });
  assert.equal(legacy, arr);
  const both = new URL(buildRouteUrl({ origin: A, destination: B, via: [1, 2], vias: [[41.1, -72.1]], apiKey: KEY }));
  assert.deepEqual(both.searchParams.getAll('via'), ['41.1,-72.1!passThrough=true']);
});

test('buildRouteUrl avoidHighways adds encoded avoid[features] only when true', () => {
  const on = buildRouteUrl({ origin: A, destination: B, avoidHighways: true, apiKey: KEY });
  assert.ok(on.includes('avoid%5Bfeatures%5D=controlledAccessHighway'));
  assert.equal(new URL(on).searchParams.get('avoid[features]'), 'controlledAccessHighway');
  assert.ok(on.endsWith(`&apikey=${KEY}`));
  for (const v of [false, undefined, null]) {
    const off = buildRouteUrl({ origin: A, destination: B, avoidHighways: v, apiKey: KEY });
    assert.ok(!off.includes('avoid'));
  }
});

test('buildRouteUrl alternatives present only when >= 1, apikey still last', () => {
  for (const n of [0, undefined, null, -1, NaN]) {
    const url = buildRouteUrl({ origin: A, destination: B, alternatives: n, apiKey: KEY });
    assert.equal(new URL(url).searchParams.has('alternatives'), false);
  }
  const url = buildRouteUrl({
    origin: A, destination: B, vias: [[41.1, -72.1]], avoidHighways: true, alternatives: 2,
    departureTime: 'any', apiKey: KEY,
  });
  assert.equal(new URL(url).searchParams.get('alternatives'), '2');
  assert.ok(url.endsWith(`&apikey=${KEY}`));
});

test('decodeFlexiblePolyline matches the spec test vector', () => {
  assert.deepEqual(decodeFlexiblePolyline('BFoz5xJ67i1B1B7PzIhaxL7Y'), [
    [50.10228, 8.69821],
    [50.10201, 8.69567],
    [50.10063, 8.6915],
    [50.09878, 8.68752],
  ]);
});

test('decodeFlexiblePolyline discards a third dimension and honours precision', () => {
  const pts = [
    [41.7473, -73.1887, 12.5],
    [41.7501, -73.1702, 14.0],
    [41.7388, -73.1544, 9.25],
  ];
  const enc = encodeFlex(pts, { precision: 6, thirdDim: 2, thirdPrecision: 2 });
  assert.deepEqual(
    decodeFlexiblePolyline(enc),
    pts.map(([a, b]) => [a, b]),
  );
});

test('decodeFlexiblePolyline round-trips large and negative coordinates', () => {
  const pts = [
    [-33.86882, 151.20929],
    [-33.8, 151.3],
    [89.99999, -179.99999],
    [0, 0],
  ];
  assert.deepEqual(decodeFlexiblePolyline(encodeFlex(pts)), pts);
});

test('decodeFlexiblePolyline rejects invalid input', () => {
  assert.throws(() => decodeFlexiblePolyline(''), HereSchemaError);
  assert.throws(() => decodeFlexiblePolyline('BF!!'), HereSchemaError);
  assert.throws(() => decodeFlexiblePolyline('CFoz5xJ'), HereSchemaError); // version 2
  assert.throws(() => decodeFlexiblePolyline('BFoz5xJ6'), HereSchemaError); // odd coordinate count
  assert.throws(() => decodeFlexiblePolyline(null), HereSchemaError);
});

// --- parseRouteResponse -----------------------------------------------------
test('parseRouteResponse maps the rt4 fixture', () => {
  const json = fixture('fixture-rt4.json');
  const sec = json.routes[0].sections[0];
  const r = parseRouteResponse(json);

  assert.equal(r.spans.length, 25);
  assert.equal(r.etaSec, sec.summary.duration);
  assert.equal(r.lengthM, sec.summary.length);
  assert.deepEqual(r.polyline, decodeFlexiblePolyline(sec.polyline));
  assert.ok(Math.abs(r.polyline[0][0] - 41.747) < 0.01 && Math.abs(r.polyline[0][1] + 73.189) < 0.01);
  const end = r.polyline.at(-1);
  assert.ok(Math.abs(end[0] - 41.764) < 0.01 && Math.abs(end[1] + 72.685) < 0.01);

  // field mapping on the first span
  const s0 = sec.spans[0];
  assert.deepEqual(r.spans[0], {
    t: s0.duration,
    len: s0.length,
    v: s0.dynamicSpeedInfo.trafficSpeed,
    L: s0.maxSpeed,
    base: s0.dynamicSpeedInfo.baseSpeed,
    offset: s0.offset,
  });

  // spans are consistent with the summary and index valid polyline vertices
  assert.equal(r.spans.reduce((a, s) => a + s.t, 0), r.etaSec);
  assert.equal(r.spans.reduce((a, s) => a + s.len, 0), r.lengthM);
  for (const s of r.spans) {
    assert.ok(Number.isInteger(s.offset) && s.offset >= 0 && s.offset < r.polyline.length);
  }

  // missing maxSpeed -> L null, and at least two such spans
  assert.ok(r.spans.filter((s) => s.L === null).length >= 2);
  // jam spans: live speed under half the limit
  assert.ok(r.spans.filter((s) => s.L !== null && s.v < 0.5 * s.L).length >= 2);
  // spans with no live data: trafficSpeed === baseSpeed
  assert.ok(r.spans.filter((s) => s.v !== null && s.v === s.base).length >= 3);
});

test('parseRouteResponse maps the fastest fixture', () => {
  const rt4 = parseRouteResponse(fixture('fixture-rt4.json'));
  const fast = parseRouteResponse(fixture('fixture-fastest.json'));
  assert.equal(fast.spans.length, 20);
  assert.ok(fast.spans.every((s) => s.L !== null && s.v !== null && s.base !== null));
  assert.ok(fast.etaSec < rt4.etaSec);
  assert.ok(Math.abs(fast.lengthM - rt4.lengthM) / rt4.lengthM < 0.1);
});

test('parseRouteResponse yields nulls for absent speeds', () => {
  const json = {
    routes: [
      {
        sections: [
          {
            polyline: encodeFlex([
              [41.0, -73.0],
              [41.01, -73.0],
            ]),
            summary: { duration: 30, length: 1000 },
            spans: [{ offset: 0, length: 1000, duration: 30 }],
          },
        ],
      },
    ],
  };
  const r = parseRouteResponse(json);
  assert.deepEqual(r.spans, [{ t: 30, len: 1000, v: null, L: null, base: null, offset: 0 }]);
});

test('parseRouteResponse drops zero-duration spans but keeps summary totals', () => {
  const json = {
    routes: [
      {
        sections: [
          {
            polyline: encodeFlex([
              [41.0, -73.0],
              [41.01, -73.0],
              [41.02, -73.0],
            ]),
            summary: { duration: 30, length: 2000 },
            spans: [
              { offset: 0, length: 1000, duration: 30 },
              { offset: 1, length: 1000, duration: 0 },
            ],
          },
        ],
      },
    ],
  };
  const r = parseRouteResponse(json);
  assert.equal(r.spans.length, 1);
  assert.equal(r.spans[0].t, 30);
  assert.equal(r.etaSec, 30);
  assert.equal(r.lengthM, 2000);
});

test('parseRouteResponse concatenates sections and rebases offsets', () => {
  const sec = (pts, spans) => ({
    polyline: encodeFlex(pts),
    summary: { duration: 100, length: 2000 },
    spans,
  });
  const json = {
    routes: [
      {
        sections: [
          sec(
            [
              [41.0, -73.0],
              [41.01, -73.0],
              [41.02, -73.0],
            ],
            [{ offset: 0, length: 1000, duration: 50 }, { offset: 1, length: 1000, duration: 50 }],
          ),
          sec(
            [
              [41.02, -73.0],
              [41.03, -73.0],
            ],
            [{ offset: 0, length: 1000, duration: 100 }],
          ),
        ],
      },
    ],
  };
  const r = parseRouteResponse(json);
  assert.equal(r.polyline.length, 4); // duplicate junction vertex dropped
  assert.equal(r.etaSec, 200);
  assert.equal(r.lengthM, 4000);
  assert.deepEqual(
    r.spans.map((s) => s.offset),
    [0, 1, 2],
  );
});

test('parseRouteResponse throws HereSchemaError on malformed input', () => {
  assert.throws(() => parseRouteResponse(fixture('fixture-malformed.json')), HereSchemaError);
  assert.throws(() => parseRouteResponse({}), HereSchemaError);
  assert.throws(() => parseRouteResponse(null), HereSchemaError);
  assert.throws(() => parseRouteResponse({ routes: [] }), HereSchemaError);
  assert.throws(() => parseRouteResponse({ routes: [{ sections: [] }] }), HereSchemaError);

  const good = fixture('fixture-rt4.json');
  const noPoly = structuredClone(good);
  delete noPoly.routes[0].sections[0].polyline;
  assert.throws(() => parseRouteResponse(noPoly), HereSchemaError);
  const noSummary = structuredClone(good);
  delete noSummary.routes[0].sections[0].summary;
  assert.throws(() => parseRouteResponse(noSummary), HereSchemaError);
  const badSpan = structuredClone(good);
  badSpan.routes[0].sections[0].spans[3].duration = 'fast';
  assert.throws(() => parseRouteResponse(badSpan), HereSchemaError);
});

// --- parseRoutesResponse ----------------------------------------------------
test('parseRoutesResponse returns one parsed route per routes[i]', () => {
  const body = fixture('fixture-fastest.json');
  const all = parseRoutesResponse(body);
  assert.equal(all.length, 2);
  assert.equal(all[0].spans.length, 20);
  assert.equal(all[1].spans.length, 20);
  assert.equal(all[0].etaSec, body.routes[0].sections[0].summary.duration);
  assert.equal(all[1].etaSec, body.routes[1].sections[0].summary.duration);
  assert.ok(all[1].etaSec > all[0].etaSec);
  assert.notDeepEqual(all[0].spans, all[1].spans);
  assert.deepEqual(parseRouteResponse(body), all[0]);
});

test('parseRoutesResponse throws on empty routes; a bad alternative is skipped, a bad routes[0] throws', () => {
  assert.throws(() => parseRoutesResponse({ routes: [] }), HereSchemaError);
  assert.throws(() => parseRoutesResponse({}), HereSchemaError);
  const body = fixture('fixture-fastest.json');
  body.routes[1].sections = [];
  assert.equal(parseRoutesResponse(body).length, 1);
  body.routes[0].sections = [];
  assert.throws(() => parseRoutesResponse(body), HereSchemaError);
});

// --- fetchRoute -------------------------------------------------------------
const params = { origin: A, destination: B, via: [41.757, -72.887], apiKey: KEY };

test('fetchRoute returns parsed route plus raw on 200', async () => {
  const body = fixture('fixture-rt4.json');
  let seenUrl;
  const fakeFetch = async (url) => {
    seenUrl = url;
    return { ok: true, status: 200, json: async () => body };
  };
  const r = await fetchRoute(params, { fetch: fakeFetch });
  assert.equal(seenUrl, buildRouteUrl(params));
  assert.equal(r.spans.length, 25);
  assert.equal(r.raw, body);
  assert.equal(r.etaSec, body.routes[0].sections[0].summary.duration);
});

test('fetchRoutes returns an array of all routes, each with raw', async () => {
  const body = fixture('fixture-fastest.json');
  let seenUrl;
  const fakeFetch = async (url) => {
    seenUrl = url;
    return { ok: true, status: 200, json: async () => body };
  };
  const p = { origin: A, destination: B, vias: [[41.1, -72.1], [41.2, -72.2]], alternatives: 1, apiKey: KEY };
  const rs = await fetchRoutes(p, { fetch: fakeFetch });
  assert.equal(seenUrl, buildRouteUrl(p));
  assert.ok(Array.isArray(rs));
  assert.equal(rs.length, 2);
  assert.ok(rs.every((r) => r.raw === body));
  assert.equal(rs[1].etaSec, body.routes[1].sections[0].summary.duration);
  const one = await fetchRoute(p, { fetch: fakeFetch });
  assert.equal(one.etaSec, rs[0].etaSec);
  assert.ok(!Array.isArray(one));
});

test('fetchRoutes rejects with HereApiError on non-2xx', async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => '{"title":"Unauthorized"}' });
  await assert.rejects(fetchRoutes(params, { fetch: fakeFetch }), (e) => e instanceof HereApiError && e.status === 401);
});

test('fetchRoute throws HereApiError with status/title/cause on 401', async () => {
  const body = fixture('fixture-error-401.json');
  const fakeFetch = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
  await assert.rejects(fetchRoute(params, { fetch: fakeFetch }), (err) => {
    assert.ok(err instanceof HereApiError);
    assert.ok(err instanceof Error);
    assert.equal(err.status, 401);
    assert.equal(err.title, 'Unauthorized');
    assert.ok(err.message.includes('Unauthorized'));
    assert.ok(err.message.includes('401'));
    return true;
  });
});

test('fetchRoute copes with a non-JSON error body and json-only responses', async () => {
  const htmlFetch = async () => ({ ok: false, status: 502, text: async () => '<html>Bad gateway</html>' });
  await assert.rejects(fetchRoute(params, { fetch: htmlFetch }), (err) => {
    assert.ok(err instanceof HereApiError);
    assert.equal(err.status, 502);
    return true;
  });
  const jsonOnly = async () => ({ ok: false, status: 429, json: async () => ({ title: 'Too Many Requests' }) });
  await assert.rejects(fetchRoute(params, { fetch: jsonOnly }), (err) => {
    assert.equal(err.status, 429);
    assert.equal(err.title, 'Too Many Requests');
    return true;
  });
});

test('fetchRoute surfaces schema problems in a 200 body', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => fixture('fixture-malformed.json') });
  await assert.rejects(fetchRoute(params, { fetch: fakeFetch }), HereSchemaError);
});

// --- polylineOverlap --------------------------------------------------------
test('polylineOverlap: identical polylines overlap fully', () => {
  const p = parseRouteResponse(fixture('fixture-rt4.json')).polyline;
  assert.equal(polylineOverlap(p, p), 1);
});

test('polylineOverlap: disjoint polylines do not overlap', () => {
  const p = parseRouteResponse(fixture('fixture-rt4.json')).polyline;
  const shifted = p.map(([lat, lng]) => [lat + 0.1, lng]); // ~11 km north
  assert.equal(polylineOverlap(p, shifted), 0);
});

test('polylineOverlap: sharing the first half of a route gives about 0.5', () => {
  const p = parseRouteResponse(fixture('fixture-rt4.json')).polyline;
  // Cumulative length to find the midpoint vertex.
  const cum = [0];
  for (let i = 1; i < p.length; i++) {
    const dLat = (p[i][0] - p[i - 1][0]) * 111_000;
    const dLng = (p[i][1] - p[i - 1][1]) * 111_000 * Math.cos((p[i][0] * Math.PI) / 180);
    cum.push(cum[i - 1] + Math.hypot(dLat, dLng));
  }
  const mid = cum.findIndex((c) => c >= cum.at(-1) / 2);
  const firstHalf = p.slice(0, mid + 1);
  // b = same first half, then a detour ~5 km north for the second half.
  const detour = p.slice(mid + 1).map(([lat, lng]) => [lat + 0.05, lng]);
  const b = [...firstHalf, ...detour];

  const o = polylineOverlap(p, b);
  assert.ok(Math.abs(o - 0.5) < 0.05, `expected ~0.5, got ${o}`);
  assert.equal(polylineOverlap(p, b), polylineOverlap(b, p), 'symmetric');
});

test('polylineOverlap: tolerance matters and the two fixture routes differ', () => {
  const rt4 = parseRouteResponse(fixture('fixture-rt4.json')).polyline;
  const fast = parseRouteResponse(fixture('fixture-fastest.json')).polyline;
  const o = polylineOverlap(rt4, fast);
  assert.ok(o > 0.05 && o < 0.85, `fixtures should partly overlap, got ${o}`);
  assert.ok(polylineOverlap(rt4, fast, 5000) >= o);
});

test('polylineOverlap: parallel offset within tolerance counts, beyond does not', () => {
  const line = [
    [41.0, -73.0],
    [41.0, -72.99],
    [41.0, -72.98],
  ];
  const near = line.map(([lat, lng]) => [lat + 0.0001, lng]); // ~11 m
  const far = line.map(([lat, lng]) => [lat + 0.001, lng]); // ~111 m
  assert.equal(polylineOverlap(line, near, 30), 1);
  assert.equal(polylineOverlap(line, far, 30), 0);
});

test('polylineOverlap: degenerate input returns 0', () => {
  assert.equal(polylineOverlap([], []), 0);
  assert.equal(polylineOverlap([[41, -73]], [[41, -73]]), 0);
});
