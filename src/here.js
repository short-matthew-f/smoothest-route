// HERE Routing API v8 client: URL building, response parsing, flexible polyline
// decoding, polyline overlap, and a thin fetch wrapper. No dependencies; works in
// browsers and Node.

export class HereSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HereSchemaError';
  }
}

export class HereApiError extends Error {
  /**
   * @param {string} message
   * @param {number} status HTTP status
   * @param {{title?: string, cause?: string, body?: any}} [extra]
   */
  constructor(message, status, extra = {}) {
    super(message);
    this.name = 'HereApiError';
    this.status = status;
    this.title = extra.title ?? null;
    this.cause = extra.cause ?? null;
    this.body = extra.body ?? null;
  }
}

const ROUTES_ENDPOINT = 'https://router.hereapi.com/v8/routes';

function latLng(point, label) {
  let lat;
  let lng;
  if (Array.isArray(point)) {
    [lat, lng] = point;
  } else if (point && typeof point === 'object') {
    lat = point.lat;
    lng = point.lng;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new TypeError(`buildRouteUrl: ${label} must be [lat,lng] or {lat,lng}`);
  }
  return `${lat},${lng}`;
}

/**
 * Build the HERE v8 /routes request URL. Points may be [lat,lng] or {lat,lng}.
 * `via` is omitted when null/undefined; `departureTime` is omitted when undefined.
 * The apikey is always the last query parameter.
 */
export function buildRouteUrl({ origin, destination, via, departureTime, apiKey }) {
  const parts = [
    'transportMode=car',
    `origin=${latLng(origin, 'origin')}`,
    `destination=${latLng(destination, 'destination')}`,
  ];
  if (via != null) parts.push(`via=${latLng(via, 'via')}!passThrough=true`);
  if (departureTime !== undefined && departureTime !== null) {
    parts.push(`departureTime=${encodeURIComponent(departureTime)}`);
  }
  parts.push('return=polyline,summary');
  parts.push('spans=maxSpeed,dynamicSpeedInfo,length,duration');
  parts.push(`apikey=${encodeURIComponent(apiKey ?? '')}`);
  return `${ROUTES_ENDPOINT}?${parts.join('&')}`;
}

// ---------------------------------------------------------------------------
// Flexible polyline decoder (port of heremaps/flexible-polyline reference)
// ---------------------------------------------------------------------------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const DECODING_TABLE = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) DECODING_TABLE[ALPHABET.charCodeAt(i)] = i;

function decodeUnsignedVarints(str) {
  const out = [];
  let result = 0;
  let shift = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const v = code < 128 ? DECODING_TABLE[code] : -1;
    if (v < 0) throw new HereSchemaError(`Invalid flexible polyline character at index ${i}`);
    // Multiplication rather than << so values beyond 31 bits stay exact.
    result += (v & 0x1f) * 2 ** shift;
    if ((v & 0x20) === 0) {
      out.push(result);
      result = 0;
      shift = 0;
    } else {
      shift += 5;
    }
  }
  if (shift > 0) throw new HereSchemaError('Truncated flexible polyline');
  return out;
}

function zigzagDecode(n) {
  return n % 2 === 1 ? -(n + 1) / 2 : n / 2;
}

/**
 * Decode a HERE flexible polyline to [[lat,lng],...]. A third dimension
 * (level/altitude/elevation/custom) is decoded and discarded.
 */
export function decodeFlexiblePolyline(str) {
  if (typeof str !== 'string') throw new HereSchemaError('Flexible polyline must be a string');
  const values = decodeUnsignedVarints(str);
  if (values.length < 2) throw new HereSchemaError('Flexible polyline is missing its header');
  const version = values[0];
  if (version !== 1) throw new HereSchemaError(`Unsupported flexible polyline version ${version}`);
  const header = values[1];
  const precision = header % 16; // bits 0..3
  const thirdDim = Math.floor(header / 16) % 8; // bits 4..6
  const dims = thirdDim === 0 ? 2 : 3;
  const factor = 10 ** precision;

  const body = values.length - 2;
  if (body % dims !== 0) throw new HereSchemaError('Flexible polyline has a truncated coordinate');

  const coords = [];
  let lat = 0;
  let lng = 0;
  for (let i = 2; i < values.length; i += dims) {
    lat += zigzagDecode(values[i]);
    lng += zigzagDecode(values[i + 1]);
    // values[i + 2], when present, is the third-dimension delta: discarded.
    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Parse a HERE v8 /routes JSON body. Uses routes[0], concatenating all sections.
 * @returns {{ spans: Array, polyline: Array<[number,number]>, etaSec: number, lengthM: number }}
 */
export function parseRouteResponse(json) {
  if (!json || typeof json !== 'object') throw new HereSchemaError('Response is not a JSON object');
  const routes = json.routes;
  if (!Array.isArray(routes) || routes.length === 0) throw new HereSchemaError('Response has no routes');
  const sections = routes[0] && routes[0].sections;
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new HereSchemaError('Route has no sections');
  }

  const spans = [];
  const polyline = [];
  let etaSec = 0;
  let lengthM = 0;

  sections.forEach((sec, si) => {
    const where = `section ${si}`;
    if (!sec || typeof sec !== 'object') throw new HereSchemaError(`${where} is not an object`);
    if (typeof sec.polyline !== 'string' || sec.polyline === '') {
      throw new HereSchemaError(`${where} lacks a polyline`);
    }
    if (!sec.summary || !isNum(sec.summary.duration) || !isNum(sec.summary.length)) {
      throw new HereSchemaError(`${where} lacks a numeric summary`);
    }
    if (!Array.isArray(sec.spans)) throw new HereSchemaError(`${where} lacks spans`);

    const pts = decodeFlexiblePolyline(sec.polyline);

    // Sections share a junction vertex; drop the duplicate and rebase span offsets.
    let base = polyline.length;
    if (base > 0 && pts.length > 0) {
      const last = polyline[base - 1];
      if (last[0] === pts[0][0] && last[1] === pts[0][1]) {
        pts.shift();
        base -= 1;
      }
    }
    for (const p of pts) polyline.push(p);

    sec.spans.forEach((sp, i) => {
      if (!sp || !isNum(sp.duration) || !isNum(sp.length)) {
        throw new HereSchemaError(`${where} span ${i} lacks numeric duration/length`);
      }
      const dyn = sp.dynamicSpeedInfo;
      spans.push({
        t: sp.duration,
        len: sp.length,
        v: dyn && isNum(dyn.trafficSpeed) ? dyn.trafficSpeed : null,
        L: isNum(sp.maxSpeed) ? sp.maxSpeed : null,
        base: dyn && isNum(dyn.baseSpeed) ? dyn.baseSpeed : null,
        offset: isNum(sp.offset) ? sp.offset + base : null,
      });
    });

    etaSec += sec.summary.duration;
    lengthM += sec.summary.length;
  });

  return { spans, polyline, etaSec, lengthM };
}

// ---------------------------------------------------------------------------
// Polyline overlap
// ---------------------------------------------------------------------------

const EARTH_R = 6371008.8;

function project(poly) {
  let latSum = 0;
  for (const p of poly) latSum += p[0];
  return latSum / poly.length;
}

function toXY(poly, lat0Rad) {
  const k = Math.cos(lat0Rad);
  const xy = new Float64Array(poly.length * 2);
  for (let i = 0; i < poly.length; i++) {
    xy[2 * i] = (poly[i][1] * Math.PI / 180) * k * EARTH_R;
    xy[2 * i + 1] = (poly[i][0] * Math.PI / 180) * EARTH_R;
  }
  return xy;
}

function pointSegDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx - px;
  const cy = ay + t * dy - py;
  return cx * cx + cy * cy;
}

// Directed overlap on pre-projected coordinates.
function directedOverlap(axy, bxy, tol) {
  const cell = tol * 2; // 3x3 neighbourhood then covers every segment within tol
  const key = (cx, cy) => `${cx},${cy}`;
  const grid = new Map();
  const nb = bxy.length / 2;

  for (let i = 0; i < nb - 1; i++) {
    const ax = bxy[2 * i];
    const ay = bxy[2 * i + 1];
    const bx = bxy[2 * i + 2];
    const by = bxy[2 * i + 3];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(len / (tol / 2)));
    for (let s = 0; s <= n; s++) {
      const x = ax + ((bx - ax) * s) / n;
      const y = ay + ((by - ay) * s) / n;
      const k = key(Math.floor(x / cell), Math.floor(y / cell));
      let bucket = grid.get(k);
      if (!bucket) grid.set(k, (bucket = []));
      if (bucket[bucket.length - 1] !== i) bucket.push(i);
    }
  }

  const tol2 = tol * tol;
  let total = 0;
  let covered = 0;
  const na = axy.length / 2;
  for (let i = 0; i < na - 1; i++) {
    const ax = axy[2 * i];
    const ay = axy[2 * i + 1];
    const bx = axy[2 * i + 2];
    const by = axy[2 * i + 3];
    const len = Math.hypot(bx - ax, by - ay);
    if (len === 0) continue;
    const n = Math.max(1, Math.ceil(len / tol));
    const piece = len / n;
    for (let s = 0; s < n; s++) {
      const f = (s + 0.5) / n; // midpoint of the sub-interval
      const x = ax + (bx - ax) * f;
      const y = ay + (by - ay) * f;
      const cx = Math.floor(x / cell);
      const cy = Math.floor(y / cell);
      let hit = false;
      for (let gx = cx - 1; gx <= cx + 1 && !hit; gx++) {
        for (let gy = cy - 1; gy <= cy + 1 && !hit; gy++) {
          const bucket = grid.get(key(gx, gy));
          if (!bucket) continue;
          for (let q = 0; q < bucket.length; q++) {
            const j = bucket[q];
            if (
              pointSegDist2(x, y, bxy[2 * j], bxy[2 * j + 1], bxy[2 * j + 2], bxy[2 * j + 3]) <= tol2
            ) {
              hit = true;
              break;
            }
          }
        }
      }
      total += piece;
      if (hit) covered += piece;
    }
  }
  return total === 0 ? 0 : covered / total;
}

/**
 * Symmetric overlap of two [lat,lng] polylines: min(overlap(a,b), overlap(b,a)),
 * where overlap(x,y) is the fraction of x's length within `toleranceM` of y.
 * Returns 0 when either polyline has fewer than two vertices.
 */
export function polylineOverlap(a, b, toleranceM = 30) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 2 || b.length < 2) return 0;
  if (!(toleranceM > 0)) return 0;
  const lat0 = ((project(a) + project(b)) / 2) * Math.PI / 180;
  const axy = toXY(a, lat0);
  const bxy = toXY(b, lat0);
  return Math.min(directedOverlap(axy, bxy, toleranceM), directedOverlap(bxy, axy, toleranceM));
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Fetch and parse one route.
 * @param {Parameters<typeof buildRouteUrl>[0]} params
 * @param {{fetch?: typeof fetch, signal?: AbortSignal}} [opts]
 * @returns {Promise<ReturnType<typeof parseRouteResponse> & {raw: any}>}
 */
export async function fetchRoute(params, opts = {}) {
  const doFetch = opts.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') throw new TypeError('fetchRoute: no fetch implementation available');
  const url = buildRouteUrl(params);
  const res = await doFetch(url, opts.signal ? { signal: opts.signal } : undefined);

  if (!res.ok) {
    let body = null;
    try {
      if (typeof res.text === 'function') {
        const text = await res.text();
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      } else if (typeof res.json === 'function') {
        body = await res.json();
      }
    } catch {
      body = null;
    }
    const isObj = body && typeof body === 'object';
    const title = isObj && typeof body.title === 'string' ? body.title : null;
    const cause =
      isObj && typeof body.cause === 'string'
        ? body.cause
        : isObj && typeof body.error_description === 'string'
          ? body.error_description
          : null;
    let msg = `HERE API error ${res.status}`;
    if (title) msg += `: ${title}`;
    if (cause) msg += ` (${cause})`;
    throw new HereApiError(msg, res.status, { title, cause, body });
  }

  let raw;
  try {
    raw = await res.json();
  } catch (e) {
    throw new HereSchemaError(`Response was not valid JSON: ${e.message}`);
  }
  return { ...parseRouteResponse(raw), raw };
}
