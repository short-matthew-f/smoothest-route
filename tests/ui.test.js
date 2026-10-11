import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtMin, fmtPct, msToMph, renderStripChart, renderRouteCard, renderErrorCard,
  renderRankingView, renderSettingsView, renderHistoryView,
} from '../src/ui.js';

const segs = [
  { r: 1, t: 60, len: 1000, cum: 1000, band: 'green' },
  { r: 0.6, t: 60, len: 500, cum: 1500, band: 'amber' },
  { r: 0.2, t: 60, len: 500, cum: 2000, band: 'red' },
  { r: NaN, t: 60, len: 1000, cum: 3000, band: 'none' },
];
const route = (over = {}) => ({
  corridorId: 'x', name: 'Rt 4', isFastest: false, etaSec: 1800, lengthM: 30000, polyline: [], error: null,
  etaDeltaSec: 120, flags: ['low-confidence'], mergedWith: [],
  score: { S: 0.1, badge: 90, slowShare: 0.12, coverage: 0.9, estimated: false, lowConfidence: false, durationSec: 1800, freeFlowSec: 1700, delaySec: 100, segments: segs },
  ...over,
});

test('formatters', () => {
  assert.equal(fmtMin(1800), '30 min');
  assert.equal(fmtMin(89), '1 min');
  assert.equal(fmtMin(NaN), '–');
  assert.equal(fmtPct(0.126), '13%');
  assert.equal(fmtPct(undefined), '–');
  assert.ok(Math.abs(msToMph(26.8224) - 60) < 0.01);
});

test('delta label: fastest only when delta <= 0', () => {
  const card = (d) => renderRouteCard(route({ etaDeltaSec: d }));
  assert.match(card(0), /fastest ETA/);
  assert.match(card(-5), /fastest ETA/);
  assert.match(card(10), /\+&lt;1 min vs fastest/);
  assert.equal(card(10).includes('fastest ETA'), false);
  assert.match(card(29), /\+&lt;1 min/);
  assert.match(card(30), /\+1 min vs fastest/);
  assert.match(card(120), /\+2 min vs fastest/);
});

test('strip chart: one rect per segment, proportional widths, band fills', () => {
  const svg = renderStripChart(segs);
  assert.match(svg, /^<svg/);
  const rects = svg.match(/<rect [^>]*>/g);
  assert.equal(rects.length, 4);
  assert.match(rects[0], /fill="#1f9d55"/);
  assert.match(rects[1], /fill="#f0a81c"/);
  assert.match(rects[2], /fill="#d64545"/);
  assert.match(rects[3], /fill="#9aa3b0"/);
  assert.match(rects[0], /width="33\.333%"/);
  assert.match(rects[1], /width="16\.667%"/);
  assert.equal(renderStripChart([]).includes('<rect'), false);
});

test('route card escapes names and shows badge band', () => {
  const html = renderRouteCard(route({ name: '<script>alert(1)</script>', mergedWith: ['<img onerror=x>'], flags: ['merged'] }), { expanded: true, mapsUrl: 'https://m/?a=1&b=2' });
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('<img onerror'), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /band-green/);
  assert.match(html, /Open in Maps/);
  assert.match(html, /a=1&amp;b=2/);
  assert.match(html, /<svg/);
  const collapsed = renderRouteCard(route());
  assert.equal(collapsed.includes('<svg'), false);
  assert.match(renderRouteCard(route({ score: { ...route().score, badge: 60 } })), /band-amber/);
  assert.match(renderRouteCard(route({ score: { ...route().score, badge: 20 } })), /band-red/);
});

test('error card never shows a badge; missing fields do not throw', () => {
  const html = renderErrorCard({ corridorId: 'e', name: 'A<b>', error: 'HTTP 401: bad' });
  assert.equal(html.includes('badge'), false);
  assert.match(html, /A&lt;b&gt;/);
  assert.doesNotThrow(() => renderRouteCard({}));
  assert.doesNotThrow(() => renderRankingView({}));
  assert.doesNotThrow(() => renderSettingsView(undefined));
  assert.doesNotThrow(() => renderHistoryView(undefined));
});

test('ranking view: hidden section, banner, errors', () => {
  const html = renderRankingView({
    settings: { apiKey: '', maxPenaltyMin: 10 }, direction: 'toWork', loading: false, lastChecked: new Date(2026, 0, 5, 7, 42),
    results: { ranked: [route()], hidden: [route({ corridorId: 'h', name: 'Slow' })], errors: [{ corridorId: 'e', name: 'Bad', error: 'boom' }] },
    expandedId: null,
  });
  assert.match(html, /href="#\/settings"/);
  assert.match(html, /Hidden \(1\) — over \+10 min/);
  assert.match(html, /Last checked 07:42/);
  assert.match(html, /boom/);
  assert.equal(renderRankingView({ settings: {}, demo: true }).includes('#/settings'), false);
  assert.match(renderRankingView({ settings: { apiKey: 'k' }, loading: true }), /data-action="refresh" disabled/);
});

test('history view groups by corridor with median', () => {
  const mon = new Date(2026, 0, 5, 7, 40).getTime(); // a Monday
  const recs = [10, 20, 30].map((b, i) => ({ ts: mon + i * 1000, direction: 'toWork', corridorId: 'a', name: 'A', S: 0.5, badge: 90 - b * 3, etaSec: 1800 }));
  const html = renderHistoryView(recs);
  assert.match(html, /3 checks/);
  assert.equal(html.match(/<article/g).length, 1);
  assert.equal(renderHistoryView(recs, { filter: 'toHome' }).includes('<article'), false);
});

test('settings view: return-via inputs are emitted and prefilled from viaReturn', () => {
  const html = renderSettingsView({
    corridors: [
      { id: 'a', name: 'A', enabled: true, via: { lat: 1, lng: 2 } },
      { id: 'b', name: 'B', enabled: true, via: { lat: 41.538, lng: -73.004 }, viaReturn: { lat: 41.5382, lng: -73.004 } },
    ],
  });
  for (const n of ['c.0.rlat', 'c.0.rlng', 'c.1.rlat', 'c.1.rlng']) assert.match(html, new RegExp(`name="${n.replace(/\./g, '\\.')}"`));
  assert.match(html, /Return via latitude/);
  assert.match(html, /Return via longitude/);
  assert.match(html, /name="c\.1\.rlat" value="41\.5382"/);
  assert.match(html, /name="c\.1\.rlng" value="-73\.004"/);
  assert.match(html, /name="c\.0\.rlat" value=""/);
});
