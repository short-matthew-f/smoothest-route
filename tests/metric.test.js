import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRoute, rankRoutes } from '../src/metric.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
// span helper: v, L, base in m/s
const sp = (t, len, v, L, base = L) => ({ t, len, v, L, base });

test('route exactly at the limit: S = 0, badge 100', () => {
  const s = scoreRoute([sp(60, 1000, 20, 20, 25), sp(120, 2400, 20, 20, 25)]);
  assert.equal(s.S, 0);
  assert.equal(s.badge, 100);
  assert.equal(s.slowShare, 0);
});

test('steady 50% of limit: S = 0.5 (std dev of r would be 0)', () => {
  const s = scoreRoute([sp(100, 1000, 10, 20, 25), sp(200, 2000, 10, 20, 25)]);
  near(s.S, 0.5);
  assert.equal(s.badge, 50);
  const rs = s.segments.map((g) => g.r);
  const mean = rs.reduce((a, b) => a + b) / rs.length;
  near(Math.sqrt(rs.reduce((a, r) => a + (r - mean) ** 2, 0) / rs.length), 0);
});

test('above-limit spans do not lower S (r capped at 1)', () => {
  const jam = sp(100, 500, 5, 20, 25); // r = 0.25
  const base = scoreRoute([jam, sp(100, 2000, 20, 20, 25)]);
  const fast = scoreRoute([jam, sp(100, 2000, 40, 20, 25)]);
  near(fast.S, base.S);
  assert.equal(fast.segments[1].r, 1);
});

test('time weighting: short slow span outweighs long fast one, hand-computed', () => {
  // A: 10 km in 400 s at the limit (r=1). B: 500 m in 100 s at 5 m/s vs limit 20 (r=0.25).
  const s = scoreRoute([sp(400, 10000, 25, 25, 30), sp(100, 500, 5, 20, 25)]);
  near(s.S, Math.sqrt((100 * 0.75 ** 2) / 500)); // 0.33541...
  // distance weighting would give sqrt(500*0.5625/10500) ~ 0.164, so time weighting is clearly heavier
  assert.ok(s.S > Math.sqrt((500 * 0.5625) / 10500) * 2 - 1e-9);
  // doubling B's time (same r) raises weight proportionally: sqrt(200*.5625/600)
  near(scoreRoute([sp(400, 10000, 25, 25, 30), sp(200, 1000, 5, 20, 25)]).S, Math.sqrt((200 * 0.5625) / 600));
});

test('missing L falls back to base and sets estimated; neither is excluded', () => {
  const est = scoreRoute([sp(100, 1000, 10, null, 20)]);
  assert.equal(est.estimated, true);
  near(est.S, 0.5);
  assert.equal(scoreRoute([sp(100, 1000, 10, 20, 20)]).estimated, false);

  const s = scoreRoute([sp(100, 1000, 10, 20, 25), { t: 50, len: 400, v: 3, L: null, base: null }]);
  near(s.S, 0.5); // excluded span does not affect S
  assert.equal(s.durationSec, 150);
  assert.equal(s.segments.length, 2);
  assert.equal(s.segments[1].band, 'none');
  assert.ok(Number.isNaN(s.segments[1].r));
  assert.equal(s.segments[1].cum, 1400);
  assert.equal(s.coverage, 1);
});

test('all spans excluded: S NaN, badge null', () => {
  const s = scoreRoute([{ t: 10, len: 100, v: null, L: null, base: null }]);
  assert.ok(Number.isNaN(s.S));
  assert.equal(s.badge, null);
  assert.equal(s.durationSec, 10);
});

test('coverage: v === base is uncovered; null v is uncovered; lowConfidence below 0.7', () => {
  const s = scoreRoute([
    sp(60, 1000, 15, 20, 18),   // live reading differs from base: covered
    sp(40, 1000, 20, 20, 20),   // v === base: uncovered
  ]);
  near(s.coverage, 0.6);
  assert.equal(s.lowConfidence, true);
  const nullV = scoreRoute([sp(50, 500, null, 20, 20), sp(50, 500, 15, 20, 18)]);
  near(nullV.coverage, 0.5);
  assert.equal(nullV.segments[0].r, 1);
  const good = scoreRoute([sp(70, 700, 15, 20, 18), sp(30, 300, 20, 20, 20)]);
  near(good.coverage, 0.7);
  assert.equal(good.lowConfidence, false);
  // v present with no base counts as covered
  assert.equal(scoreRoute([{ t: 10, len: 100, v: 10, L: 20, base: null }]).coverage, 1);
});

test('slowShare and bands at 0.8 / 0.5 thresholds', () => {
  const s = scoreRoute([
    sp(10, 100, 20, 20, 25),   // r 1.0 green
    sp(10, 100, 16, 20, 25),   // r 0.8 green
    sp(10, 100, 15.9, 20, 25), // amber
    sp(10, 100, 10, 20, 25),   // r 0.5 amber (not slow)
    sp(20, 100, 9.9, 20, 25),  // red, slow
  ]);
  assert.deepEqual(s.segments.map((g) => g.band), ['green', 'green', 'amber', 'amber', 'red']);
  near(s.slowShare, 20 / 60);
  assert.deepEqual(s.segments.map((g) => g.cum), [100, 200, 300, 400, 500]);
});

test('freeFlowSec and delaySec', () => {
  // ref 20 m/s: 2000 m -> 100 s free flow; actual 150 s
  const s = scoreRoute([sp(150, 2000, 13.3, 20, 25)]);
  near(s.freeFlowSec, 100);
  near(s.delaySec, 50);
  // faster than free flow: delay clamps to 0
  assert.equal(scoreRoute([sp(50, 2000, 40, 20, 25)]).delaySec, 0);
});

test('TypeError on bad input', () => {
  assert.throws(() => scoreRoute(null), TypeError);
  assert.throws(() => scoreRoute({}), TypeError);
  assert.throws(() => scoreRoute([sp(0, 10, 1, 1)]), TypeError);
  assert.throws(() => scoreRoute([sp(-5, 10, 1, 1)]), TypeError);
  assert.throws(() => scoreRoute([{ t: '5', len: 1, v: 1, L: 1, base: 1 }]), TypeError);
  assert.throws(() => scoreRoute([null]), TypeError);
});

// ---------- rankRoutes ----------
const route = (name, S, etaSec, lengthM, extra = {}) => ({
  corridorId: name, name, isFastest: false, etaSec, lengthM, polyline: [], error: null,
  score: { S, badge: Math.round(100 * (1 - S)), slowShare: 0, coverage: 1, estimated: false, lowConfidence: false,
    durationSec: etaSec, freeFlowSec: etaSec, delaySec: 0, segments: [], ...(extra.score || {}) },
  ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'score')),
});

test('rankRoutes sorts by S, ties break on ETA', () => {
  const { ranked } = rankRoutes([
    route('c', 0.3, 1000, 1), route('a', 0.1, 1200, 1), route('b', 0.3 + 1e-12, 900, 1),
  ]);
  assert.deepEqual(ranked.map((r) => r.name), ['a', 'b', 'c']);
});

test('rankRoutes hides routes beyond maxPenaltySec, default 600, and respects opts', () => {
  const rs = [route('fast', 0.4, 1000, 1, { isFastest: true }), route('smooth', 0.1, 1600, 1), route('far', 0.0, 1601, 1)];
  const d = rankRoutes(rs);
  assert.deepEqual(d.ranked.map((r) => r.name), ['smooth', 'fast']);
  assert.deepEqual(d.hidden.map((r) => r.name), ['far']);
  const o = rankRoutes(rs, { maxPenaltySec: 100 });
  assert.deepEqual(o.ranked.map((r) => r.name), ['fast']);
  assert.deepEqual(o.hidden.map((r) => r.name), ['far', 'smooth']); // hidden still sorted by S
});

test('rankRoutes separates errors and computes etaDeltaSec vs min non-error ETA', () => {
  const bad = { ...route('bad', 0, 1, 1), score: null, error: 'boom', etaSec: 1 };
  const { ranked, errors } = rankRoutes([bad, route('a', 0.2, 1500, 1), route('b', 0.1, 1100, 1)]);
  assert.deepEqual(errors.map((r) => r.name), ['bad']);
  assert.equal(ranked.length, 2);
  assert.deepEqual(ranked.map((r) => r.etaDeltaSec), [0, 400]);
});

test('rankRoutes flags: long-detour at 1.4x fastest length, estimated, low-confidence', () => {
  const { ranked } = rankRoutes([
    route('fast', 0.5, 1000, 10000, { isFastest: true }),
    route('edge', 0.4, 1100, 14000),
    route('detour', 0.3, 1200, 14001),
    route('est', 0.2, 1300, 10000, { score: { estimated: true, lowConfidence: true } }),
  ]);
  const f = Object.fromEntries(ranked.map((r) => [r.name, r.flags]));
  assert.deepEqual(f.fast, []);
  assert.deepEqual(f.edge, []);
  assert.deepEqual(f.detour, ['long-detour']);
  assert.deepEqual(f.est, ['estimated', 'low-confidence']);
});

test('rankRoutes merges overlapping routes via opts.overlap, keeping lower S', () => {
  const rs = [route('A', 0.3, 1000, 1), route('B', 0.1, 1100, 1), route('C', 0.2, 1050, 1)];
  const overlap = (a, b) => ([a.name, b.name].sort().join() === 'A,B' ? 0.9 : 0.2);
  const { ranked } = rankRoutes(rs, { overlap });
  assert.deepEqual(ranked.map((r) => r.name), ['B', 'C']);
  assert.deepEqual(ranked[0].mergedWith, ['A']);
  assert.ok(ranked[0].flags.includes('merged'));
  assert.deepEqual(ranked[1].mergedWith, []);
  // threshold is strict (>) and configurable
  assert.equal(rankRoutes(rs, { overlap: () => 0.85 }).ranked.length, 3);
  assert.equal(rankRoutes(rs, { overlap: () => 0.85, overlapThreshold: 0.8 }).ranked.length, 1);
  // without opts.overlap nothing merges
  assert.equal(rankRoutes(rs).ranked.length, 3);
});

test('rankRoutes does not mutate inputs', () => {
  const r = route('a', 0.1, 100, 1);
  rankRoutes([r]);
  assert.equal(r.flags, undefined);
  assert.equal(r.etaDeltaSec, undefined);
});
