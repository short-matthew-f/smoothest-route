// Controller: hash router, state, refresh pipeline, event wiring. Browser only.
import { scoreRoute, rankRoutes } from './metric.js';
import { fetchRoutes, parseRoutesResponse, polylineOverlap, HereSchemaError, HereApiError } from './here.js';
import { loadSettings, saveSettings, appendHistory, listHistory, clearHistory, exportHistoryCsv } from './storage.js';
import { googleMapsUrl, appleMapsUrl, isApplePlatform } from './maps.js';
import { DEFAULT_SETTINGS, FASTEST_ID } from './defaults.js';
import { renderRankingView, renderSettingsView, renderHistoryView } from './ui.js';

const params = new URLSearchParams(location.search);
const DEMO = params.get('demo') === '1';
const viewEl = document.getElementById('view');

const state = {
  settings: structuredClone(DEFAULT_SETTINGS),
  direction: new Date().getHours() < 12 ? 'toWork' : 'toHome',
  results: null,
  loading: false,
  lastChecked: null,
  expandedId: null,
  hiddenOpen: false,
  demo: DEMO,
  historyFilter: 'all',
  history: [],
  draft: null, // unsaved settings while editing the form
  mapsUrlFor: null,
  gen: 0, // bumped on direction change / settings save to discard in-flight refresh results
};

// ---------- helpers ----------
const latlng = (p) => [p.lat, p.lng];
const endpoints = () => {
  const { home, work } = state.settings;
  return state.direction === 'toWork' ? { origin: home, destination: work } : { origin: work, destination: home };
};
/** Vias for a corridor in a direction: toHome uses viasReturn if non-empty, else vias reversed. */
const viasFor = (c, direction) => {
  const vias = Array.isArray(c?.vias) ? c.vias : [];
  if (direction !== 'toHome') return vias;
  const ret = Array.isArray(c?.viasReturn) ? c.viasReturn : [];
  return ret.length ? ret : [...vias].reverse();
};
state.mapsUrlFor = (route) => {
  const { origin, destination } = endpoints();
  const vias = route.vias ?? [];
  const args = { origin, destination, ...(vias.length ? { vias } : {}), ...(route.avoidHighways ? { avoidHighways: true } : {}) };
  return (isApplePlatform() ? appleMapsUrl : googleMapsUrl)(args);
};

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1800);
}

function errorMessage(e) {
  if (e instanceof HereSchemaError) return 'HERE response did not match expected schema (fields may have changed)';
  if (e instanceof HereApiError) return e.message;
  if (e instanceof TypeError && /fetch|network|Failed to fetch|NetworkError|Load failed/i.test(e.message)) {
    return 'Could not reach HERE (network or CORS blocked). See docs/research.md in the repo.';
  }
  return e?.message || 'Unknown error';
}

// ---------- refresh ----------
function candidates() {
  const cs = (state.settings.corridors ?? []).filter((c) => c.enabled)
    .map((c) => ({ corridorId: c.id, name: c.name, isFastest: false, avoidHighways: !!c.avoidHighways, vias: viasFor(c, state.direction) }));
  cs.push({ corridorId: FASTEST_ID, name: 'Fastest route', isFastest: true, avoidHighways: false, vias: [] });
  return cs;
}

const DEMO_FIXTURES = { fastest: 'fixture-fastest.json', corridors: ['fixture-rt4.json', 'fixture-malformed.json'], extra: 'fixture-rt4.json' };

async function fetchDemo(c, corridorIndex) {
  const file = c.isFastest ? DEMO_FIXTURES.fastest : (DEMO_FIXTURES.corridors[corridorIndex] ?? DEMO_FIXTURES.extra);
  const res = await fetch(`tests/fixtures/${file}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}: fixture ${file} missing`);
  return parseRoutesResponse(await res.json());
}

/** Expand one candidate's settled fetch into RouteResults: route i -> id/name with ~alt suffix. */
function toResults(c, s) {
  const base = { corridorId: c.corridorId, name: c.name, isFastest: c.isFastest, avoidHighways: c.avoidHighways, vias: c.vias };
  const fail = (b, e) => ({ ...b, score: null, etaSec: 0, lengthM: 0, polyline: [], error: errorMessage(e) });
  if (s.status === 'rejected') return [fail(base, s.reason)];
  const routes = Array.isArray(s.value) ? s.value : [s.value];
  if (!routes.length) return [fail(base, new Error('HERE returned no routes'))];
  return routes.map((p, i) => {
    const b = i === 0 ? base : { ...base, corridorId: `${c.corridorId}~alt${i}`, name: `${c.name} (alt ${i})`, isFastest: false };
    try {
      return { ...b, score: scoreRoute(p.spans), etaSec: p.etaSec, lengthM: p.lengthM, polyline: p.polyline ?? [], error: null };
    } catch (e) {
      return fail(b, e);
    }
  });
}

async function refresh() {
  if (state.loading) return;
  if (!DEMO && !state.settings.apiKey) { location.hash = '#/settings'; return; }
  const gen = ++state.gen;
  state.loading = true;
  state.expandedId = null;
  renderIfRanking();
  const direction = state.direction;
  const { origin, destination } = endpoints();
  const cands = candidates();
  const alternatives = Number.isInteger(state.settings.alternatives) ? state.settings.alternatives : 1;
  let ci = 0;
  const jobs = cands.map((c) => {
    const idx = c.isFastest ? -1 : ci++;
    if (DEMO) return fetchDemo(c, idx);
    return fetchRoutes({
      origin: latlng(origin), destination: latlng(destination),
      vias: c.vias.map(latlng), avoidHighways: c.avoidHighways, alternatives, apiKey: state.settings.apiKey,
    });
  });
  const settled = await Promise.allSettled(jobs);
  if (gen !== state.gen) { state.loading = false; renderIfRanking(); return; }
  const results = settled.flatMap((s, i) => toResults(cands[i], s));
  try {
    state.results = rankRoutes(results, { maxPenaltySec: (state.settings.maxPenaltyMin ?? 10) * 60, overlap: (a, b) => polylineOverlap(a.polyline ?? [], b.polyline ?? []) });
  } catch (e) {
    console.error(e);
    state.results = { ranked: [], hidden: [], errors: results.map((r) => ({ ...r, error: r.error ?? errorMessage(e) })) };
  }
  state.lastChecked = new Date();
  state.loading = false;
  renderIfRanking();
  if (!DEMO) {
    const ts = Date.now();
    const records = results.filter((r) => r.score && r.score.badge != null).map((r) => ({
      ts, direction, corridorId: r.corridorId, name: r.name, S: r.score.S, badge: r.score.badge,
      etaSec: r.etaSec, slowShare: r.score.slowShare, coverage: r.score.coverage,
    }));
    if (records.length) appendHistory(records).catch(console.warn);
  }
}

// ---------- settings form ----------
function readForm(form) {
  const f = form.elements;
  const num = (n) => Number.parseFloat(f[n]?.value);
  const val = (n) => f[n]?.value ?? '';
  // Rows are read in DOM order; a blank coordinate stays NaN so validate() can reject it.
  const readPts = (prefix) => {
    const pts = [];
    for (let j = 0; f[`${prefix}.${j}.lat`]; j++) pts.push({ lat: num(`${prefix}.${j}.lat`), lng: num(`${prefix}.${j}.lng`) });
    return pts;
  };
  const corridors = [];
  for (let i = 0; f[`c.${i}.name`]; i++) {
    const c = {
      id: val(`c.${i}.id`) || `c${Date.now()}${i}`,
      name: val(`c.${i}.name`).trim() || `Corridor ${i + 1}`,
      enabled: f[`c.${i}.enabled`].checked,
      vias: readPts(`c.${i}.v`),
      avoidHighways: !!f[`c.${i}.avoid`]?.checked,
      note: val(`c.${i}.note`),
    };
    const viasReturn = readPts(`c.${i}.rv`);
    if (viasReturn.length) c.viasReturn = viasReturn;
    corridors.push(c);
  }
  const alt = num('alternatives');
  return {
    ...state.settings,
    home: { name: val('home.name').trim(), lat: num('home.lat'), lng: num('home.lng') },
    work: { name: val('work.name').trim(), lat: num('work.lat'), lng: num('work.lng') },
    maxPenaltyMin: Number.isFinite(num('maxPenaltyMin')) ? num('maxPenaltyMin') : DEFAULT_SETTINGS.maxPenaltyMin,
    alternatives: Number.isFinite(alt) ? alt : (DEFAULT_SETTINGS.alternatives ?? 1),
    apiKey: val('apiKey').trim(),
    corridors,
  };
}

function validate(s) {
  const bad = (p) => !Number.isFinite(p?.lat) || !Number.isFinite(p?.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180;
  if (bad(s.home)) return 'Home coordinates are invalid';
  if (bad(s.work)) return 'Work coordinates are invalid';
  if (!Number.isInteger(s.alternatives) || s.alternatives < 0 || s.alternatives > 3) return 'Alternatives per request must be a whole number from 0 to 3';
  for (const c of s.corridors) {
    const v = (c.vias ?? []).findIndex(bad);
    if (v >= 0) return `Via ${v + 1} coordinates for "${c.name}" are invalid`;
    const r = (c.viasReturn ?? []).findIndex(bad);
    if (r >= 0) return `Return via ${r + 1} coordinates for "${c.name}" are invalid`;
  }
  return null;
}

// ---------- routing / render ----------
const routePath = () => (location.hash.replace(/^#/, '') || '/');

function renderIfRanking() { if (routePath() === '/') render(); }

function render() {
  const path = routePath();
  for (const a of document.querySelectorAll('.nav a')) {
    if (a.dataset.route === path || (path === '' && a.dataset.route === '/')) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (path === '/settings') viewEl.innerHTML = renderSettingsView(state.draft ?? state.settings);
  else if (path === '/history') viewEl.innerHTML = renderHistoryView(state.history, { filter: state.historyFilter });
  else viewEl.innerHTML = renderRankingView(state);
}

async function onRoute() {
  const path = routePath();
  if (path !== '/settings') state.draft = null;
  if (path === '/history') {
    try { state.history = await listHistory(); } catch (e) { console.warn(e); state.history = []; }
  }
  render();
}

viewEl.addEventListener('toggle', (e) => {
  if (e.target.matches?.('details.hidden-routes')) state.hiddenOpen = e.target.open;
}, true);

viewEl.addEventListener('click', async (e) => {
  if (e.target.closest('a')) return;
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action } = el.dataset;
  const form = viewEl.querySelector('#settings-form');
  switch (action) {
    case 'toggle-card':
      state.expandedId = state.expandedId === el.dataset.id ? null : el.dataset.id;
      return render();
    case 'set-direction':
      if (state.direction !== el.dataset.dir) { state.direction = el.dataset.dir; state.gen++; state.results = null; state.expandedId = null; state.lastChecked = null; }
      return render();
    case 'refresh': return refresh();
    case 'toggle-key': {
      const input = form.elements.apiKey;
      input.type = input.type === 'password' ? 'text' : 'password';
      el.textContent = input.type === 'password' ? 'Show' : 'Hide';
      return;
    }
    case 'add-corridor':
      state.draft = readForm(form);
      state.draft.corridors.push({ id: `c${Date.now()}`, name: 'New corridor', enabled: true, vias: [], viasReturn: [], avoidHighways: false, note: '' });
      return render();
    case 'remove-corridor':
      state.draft = readForm(form);
      state.draft.corridors.splice(Number(el.dataset.index), 1);
      return render();
    case 'add-via':
    case 'add-return-via': {
      state.draft = readForm(form);
      const c = state.draft.corridors[Number(el.dataset.index)];
      const key = action === 'add-via' ? 'vias' : 'viasReturn';
      c[key] = [...(c[key] ?? []), { lat: NaN, lng: NaN }];
      return render();
    }
    case 'remove-via':
    case 'remove-return-via': {
      state.draft = readForm(form);
      const c = state.draft.corridors[Number(el.dataset.index)];
      const key = action === 'remove-via' ? 'vias' : 'viasReturn';
      c[key]?.splice(Number(el.dataset.via), 1);
      if (key === 'viasReturn' && !c.viasReturn?.length) delete c.viasReturn;
      return render();
    }
    case 'reset-defaults':
      if (!confirm('Reset all settings to defaults? This clears your API key and corridors.')) return;
      state.settings = structuredClone(DEFAULT_SETTINGS);
      state.draft = null;
      await saveSettings(state.settings);
      render();
      return toast('Reset to defaults');
    case 'hist-filter': state.historyFilter = el.dataset.filter; return render();
    case 'export-csv':
      try { await exportHistoryCsv(); } catch (err) { toast(`Export failed: ${err.message}`); }
      return;
    case 'clear-history':
      if (!confirm('Delete all history records?')) return;
      await clearHistory();
      state.history = [];
      return render();
  }
});

viewEl.addEventListener('submit', async (e) => {
  if (e.target.id !== 'settings-form') return;
  e.preventDefault();
  const next = readForm(e.target);
  const err = validate(next);
  if (err) { state.draft = next; return toast(err); }
  try {
    await saveSettings(next);
    state.settings = next;
    state.draft = null;
    state.results = null;
    state.gen++;
    render();
    toast('Saved');
  } catch (ex) {
    toast(`Save failed: ${ex.message}`);
  }
});

window.addEventListener('hashchange', onRoute);

navigator.storage?.persist?.().catch(() => {});

(async function init() {
  try { state.settings = await loadSettings(); } catch (e) { console.warn('loadSettings failed', e); }
  if (!location.hash) history.replaceState(null, '', '#/');
  await onRoute();
  if (routePath() === '/' && (DEMO || state.settings.apiKey)) refresh();
})();
