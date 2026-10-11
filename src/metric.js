// Smoothness metric: pure functions, no I/O, no imports. Works in Node and browsers.
// Units: speeds m/s, durations s, lengths m.

/** @typedef {{t:number, len:number, v:number|null, L:number|null, base:number|null}} Span */
/** @typedef {{S:number, badge:number|null, slowShare:number, coverage:number, estimated:boolean,
 *   lowConfidence:boolean, durationSec:number, freeFlowSec:number, delaySec:number,
 *   segments:Array<{r:number,t:number,len:number,cum:number,band:'green'|'amber'|'red'|'none'}>}} RouteScore */

const pos = (x) => typeof x === 'number' && x > 0 && Number.isFinite(x);
const bandOf = (r) => (r >= 0.8 ? 'green' : r >= 0.5 ? 'amber' : 'red');

/**
 * Score a route's smoothness: S = sqrt(sum t(1-r)^2 / sum t), r = min(v/ref, 1), ref = L else base.
 * Spans with no usable reference speed are excluded from S/slowShare/coverage/freeFlowSec/delaySec
 * but still count toward durationSec and appear in `segments` with band 'none'.
 * A live speed v of 0 is a real standstill reading (r = 0), not "missing".
 * @param {Span[]} spans
 * @returns {RouteScore}
 * @throws {TypeError} if spans is not an array or a span has non-positive/non-numeric t
 */
export function scoreRoute(spans) {
  if (!Array.isArray(spans)) throw new TypeError('spans must be an array');
  let durationSec = 0, inclT = 0, sq = 0, slowT = 0, covT = 0, freeFlowSec = 0, cum = 0;
  let estimated = false;
  const segments = spans.map((s, i) => {
    if (!s || !pos(s.t)) throw new TypeError(`span ${i}: t must be a positive number`);
    durationSec += s.t;
    cum += Number.isFinite(s.len) ? s.len : 0;
    const usesBase = !pos(s.L);
    const ref = usesBase ? s.base : s.L;
    const seg = { r: NaN, t: s.t, len: s.len, cum, band: 'none' };
    if (!pos(ref)) return seg;
    if (usesBase) estimated = true;
    const hasV = typeof s.v === 'number' && s.v >= 0 && Number.isFinite(s.v);
    const v = hasV ? s.v : s.base; // no live reading: fall back to base (r is then ~1)
    if (!(typeof v === 'number' && v >= 0)) return seg; // neither v nor base: nothing to measure
    const r = Math.min(v / ref, 1);
    inclT += s.t;
    sq += s.t * (1 - r) ** 2;
    if (r < 0.5) slowT += s.t;
    if (hasV && (!pos(s.base) || s.v !== s.base)) covT += s.t; // v === base means no live reading
    if (Number.isFinite(s.len)) freeFlowSec += s.len / ref;
    seg.r = r;
    seg.band = bandOf(r);
    return seg;
  });
  const S = inclT > 0 ? Math.sqrt(sq / inclT) : NaN;
  const coverage = inclT > 0 ? covT / inclT : 0;
  return {
    S,
    badge: inclT > 0 ? Math.round(100 * (1 - S)) : null,
    slowShare: inclT > 0 ? slowT / inclT : 0,
    coverage,
    estimated,
    lowConfidence: coverage < 0.7,
    durationSec,
    freeFlowSec,
    delaySec: Math.max(0, inclT - freeFlowSec), // compare like with like: excluded spans have no free-flow time
    segments,
  };
}

/**
 * Rank route results by smoothness (S ascending, ties on ETA), hide those too slow, merge near-duplicates.
 * @param {Array<object>} results RouteResult[] (see docs/CONTRACTS.md)
 * @param {{maxPenaltySec?:number, lengthRatioFlag?:number, overlapThreshold?:number,
 *   overlap?:(a:object,b:object)=>number}} [opts] defaults 600 / 1.6 / 0.85; `overlap` is optional
 * @returns {{ranked:Array<object>, hidden:Array<object>, errors:Array<object>}}
 *   Each ranked/hidden entry is a copy of its RouteResult plus etaDeltaSec, flags, mergedWith.
 */
export function rankRoutes(results, opts = {}) {
  const { maxPenaltySec = 600, lengthRatioFlag = 1.6, // Rt 8 / I-84 is ~47% longer than the direct route by design; 1.4 would flag it every time
    overlapThreshold = 0.85, overlap } = opts || {};
  const errors = results.filter((r) => r.error || !r.score);
  const ok = results.filter((r) => !(r.error || !r.score));
  const minEta = Math.min(...ok.map((r) => r.etaSec));
  const fastest = ok.find((r) => r.isFastest);
  const key = (r) => (Number.isNaN(r.score.S) ? Infinity : r.score.S); // unscorable routes sort last
  const cmp = (a, b) => (Math.abs(key(a) - key(b)) < 1e-9 || key(a) === key(b) ? a.etaSec - b.etaSec : key(a) - key(b));

  const all = ok.map((r) => {
    const flags = [];
    if (r.score.estimated) flags.push('estimated');
    if (r.score.lowConfidence) flags.push('low-confidence');
    if (fastest && r.lengthM > lengthRatioFlag * fastest.lengthM) flags.push('long-detour');
    return { ...r, etaDeltaSec: r.etaSec - minEta, flags, mergedWith: [] };
  }).sort(cmp);

  // Dedupe within each group; list is sorted, so the kept route always has the lower S (or ETA on ties).
  const dedupe = (list) => {
    if (typeof overlap !== 'function') return list;
    const kept = [];
    for (const r of list) {
      const twin = kept.find((k) => overlap(k, r) > overlapThreshold);
      if (!twin) { kept.push(r); continue; }
      twin.mergedWith.push(r.name);
      if (!twin.flags.includes('merged')) twin.flags.push('merged');
    }
    return kept;
  };
  return {
    ranked: dedupe(all.filter((r) => r.etaDeltaSec <= maxPenaltySec)),
    hidden: dedupe(all.filter((r) => r.etaDeltaSec > maxPenaltySec)),
    errors,
  };
}
