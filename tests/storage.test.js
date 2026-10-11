import test from 'node:test';
import assert from 'node:assert/strict';
import { historyToCsv, mergeSettings, CSV_COLUMNS } from '../src/storage.js';
import { DEFAULT_SETTINGS, FASTEST_ID } from '../src/defaults.js';

test('importing storage.js in Node does not throw; defaults exported', () => {
  assert.equal(FASTEST_ID, 'fastest');
  assert.equal(DEFAULT_SETTINGS.corridors.length, 4);
  assert.equal(DEFAULT_SETTINGS.alternatives, 1);
});

test('mergeSettings returns defaults (cloned) when nothing stored', () => {
  const m = mergeSettings(DEFAULT_SETTINGS, undefined);
  assert.deepEqual(m, DEFAULT_SETTINGS);
  assert.notEqual(m, DEFAULT_SETTINGS);
  m.home.name = 'x';
  assert.equal(DEFAULT_SETTINGS.home.name, 'Litchfield');
});

test('mergeSettings deep-merges nested objects', () => {
  const m = mergeSettings(DEFAULT_SETTINGS, { apiKey: 'abc', home: { lat: 1 } });
  assert.equal(m.apiKey, 'abc');
  assert.deepEqual(m.home, { name: 'Litchfield', lat: 1, lng: -73.1887 });
  assert.deepEqual(m.work, DEFAULT_SETTINGS.work);
  assert.equal(m.maxPenaltyMin, 10);
});

test('mergeSettings replaces corridors array wholesale', () => {
  const stored = [{ id: 'x', name: 'X', enabled: true, vias: [{ lat: 1, lng: 2 }], avoidHighways: false }];
  const m = mergeSettings(DEFAULT_SETTINGS, { corridors: stored });
  assert.deepEqual(m.corridors, stored);
  const empty = mergeSettings(DEFAULT_SETTINGS, { corridors: [] });
  assert.deepEqual(empty.corridors, []);
});

test('mergeSettings preserves a stored corridor with viasReturn', () => {
  const stored = [{ id: 'r', name: 'R', enabled: true, vias: [{ lat: 1, lng: 2 }], viasReturn: [{ lat: 3, lng: 4 }], avoidHighways: false }];
  const m = mergeSettings(DEFAULT_SETTINGS, { corridors: stored });
  assert.deepEqual(m.corridors, stored);
  assert.deepEqual(m.corridors[0].viasReturn, [{ lat: 3, lng: 4 }]);
  assert.deepEqual(DEFAULT_SETTINGS.corridors.find((c) => c.id === 'rt8').viasReturn, [{ lat: 41.5382, lng: -73.004 }]);
});

test('mergeSettings migrates a legacy via/viaReturn corridor to vias/viasReturn', () => {
  const legacy = { id: 'r', name: 'R', enabled: true, via: { lat: 1, lng: 2 }, viaReturn: { lat: 3, lng: 4 }, note: 'n' };
  const input = { corridors: [legacy, { id: 'p', name: 'P', enabled: false, via: { lat: 5, lng: 6 } }, { id: 'q', name: 'Q', enabled: true }] };
  const snapshot = JSON.parse(JSON.stringify(input));
  const m = mergeSettings(DEFAULT_SETTINGS, input);
  assert.deepEqual(m.corridors[0], {
    id: 'r', name: 'R', enabled: true, note: 'n',
    vias: [{ lat: 1, lng: 2 }], viasReturn: [{ lat: 3, lng: 4 }], avoidHighways: false,
  });
  assert.ok(!('via' in m.corridors[0]) && !('viaReturn' in m.corridors[0]));
  assert.deepEqual(m.corridors[1], { id: 'p', name: 'P', enabled: false, vias: [{ lat: 5, lng: 6 }], avoidHighways: false });
  assert.ok(!('viasReturn' in m.corridors[1]));
  assert.deepEqual(m.corridors[2].vias, []);
  assert.equal(m.corridors[2].avoidHighways, false);
  assert.deepEqual(input, snapshot, 'input not mutated');
});

test('mergeSettings passes an already-new corridor through untouched', () => {
  const c = { id: 'n', name: 'N', enabled: true, vias: [{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }], viasReturn: [{ lat: 5, lng: 6 }], avoidHighways: true, note: '' };
  const m = mergeSettings(DEFAULT_SETTINGS, { corridors: [c] });
  assert.deepEqual(m.corridors, [c]);
  const noHwy = { id: 'h', name: 'H', enabled: true, vias: [], avoidHighways: true };
  assert.deepEqual(mergeSettings(DEFAULT_SETTINGS, { corridors: [noHwy] }).corridors, [noHwy]);
});

test('mergeSettings alternatives: default, passthrough, rounding and clamp 0..3', () => {
  assert.equal(mergeSettings(DEFAULT_SETTINGS, undefined).alternatives, 1);
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { apiKey: 'k' }).alternatives, 1);
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { alternatives: 0 }).alternatives, 0);
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { alternatives: 3 }).alternatives, 3);
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { alternatives: 7 }).alternatives, 3);
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { alternatives: -2 }).alternatives, 0);
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { alternatives: 1.6 }).alternatives, 2);
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { alternatives: '2' }).alternatives, 2);
  for (const bad of ['abc', null, NaN, {}, '']) {
    assert.equal(mergeSettings(DEFAULT_SETTINGS, { alternatives: bad }).alternatives, 1);
  }
});

test('mergeSettings keeps unknown stored keys and ignores undefined', () => {
  const m = mergeSettings(DEFAULT_SETTINGS, { extra: 5, apiKey: undefined });
  assert.equal(m.extra, 5);
  assert.equal(m.apiKey, '');
});

test('historyToCsv emits header for empty input', () => {
  assert.equal(historyToCsv([]), CSV_COLUMNS.join(',') + '\r\n');
  assert.equal(CSV_COLUMNS.join(','), 'ts,direction,corridorId,name,S,badge,etaSec,slowShare,coverage');
});

test('historyToCsv writes rows in column order', () => {
  const csv = historyToCsv([
    { ts: 1700000000000, direction: 'toWork', corridorId: 'rt4', name: 'Rt 4', S: 0.12, badge: 88, etaSec: 2400, slowShare: 0.05, coverage: 0.9 },
  ]);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[1], '1700000000000,toWork,rt4,Rt 4,0.12,88,2400,0.05,0.9');
});

test('historyToCsv quotes commas, quotes and newlines', () => {
  const csv = historyToCsv([
    { ts: 1, direction: 'toHome', corridorId: 'a', name: 'US 202, "Rt 44"\nloop', S: 0, badge: 100, etaSec: 1, slowShare: 0, coverage: 1 },
  ]);
  assert.ok(csv.includes('"US 202, ""Rt 44""\nloop"'));
});

test('historyToCsv blanks null/NaN/missing values', () => {
  const csv = historyToCsv([{ ts: 2, direction: 'toWork', corridorId: 'a', name: 'A', S: NaN, badge: null, etaSec: 5 }]);
  assert.equal(csv.trim().split('\r\n')[1], '2,toWork,a,A,,,5,,');
});
