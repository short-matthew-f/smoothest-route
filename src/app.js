// Controller: hash router, state, refresh pipeline, event wiring. Browser only.
import { scoreRoute, rankRoutes } from './metric.js';
import { fetchRoute, parseRouteResponse, polylineOverlap, HereSchemaError, HereApiError } from './here.js';
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
};

// ---------- helpers ----------
const latlng = (p) => [p.lat, p.lng];
const endpoints = () => {
  const { home, work } = state.settings;
  return state.direction === 'toWork' ? { origin: home, destination: work } : { origin: work, destination: home };
};
state.mapsUrlFor = (route) => {
  const { origin, destination } = endpoints();
  const via = state.settings.corridors?.find((c) => c.id === route.corridorId)?.via;
  const args = { origin, destination, ...(route.isFastest || !via ? {} : { via }) };
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
  if (e instanceof HereApiError) return `HTTP ${e.status}: ${e.message}`;
  if (e instanceof TypeError) return 'Network/CORS error — see docs';
  return e?.message || 'Unknown error';
}

// ---------- refresh ----------
function candidates() {
  const cs = (state.settings.corridors ?? []).filter((c) => c.enabled && c.via)
    .map((c) => ({ corridorId: c.id, name: c.name, isFastest: false, via: c.via }));
  cs.push({ corridorId: FASTEST_ID, name: 'Fastest route', isFastest: true, via: null });
  return cs;
}

const DEMO_FIXTURES = { fastest: 'fixture-fastest.json', corridors: ['fixture-rt4.json', 'fixture-malformed.json'], extra: 'fixture-rt4.json' };

async function fetchDemo(c, corridorIndex) {
  const file = c.isFastest ? DEMO_FIXTURES.fastest : (DEMO_FIXTURES.corridors[corridorIndex] ?? DEMO_FIXTURES.extra);
  const res = await fetch(`tests/fixtures/${file}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}: fixture ${file} missing`);
  return parseRouteResponse(await res.json());
}

async function refresh() {
  if (state.loading) return;
  if (!DEMO && !state.settings.apiKey) { location.hash = '#/settings'; return; }
  state.loading = true;
  state.expandedId = null;
  render();
  const direction = state.direction;
  const { origin, destination } = endpoints();
  const cands = candidates();
  let ci = 0;
  const jobs = cands.map((c) => {
    const idx = c.isFastest ? -1 : ci++;
    if (DEMO) return fetchDemo(c, idx);
    return fetchRoute({
      origin: latlng(origin), destination: latlng(destination),
      via: c.via ? latlng(c.via) : null, apiKey: state.settings.apiKey,
    });
  });
  const settled = await Promise.allSettled(jobs);
  const results = settled.map((s, i) => {
    const c = cands[i];
    const base = { corridorId: c.corridorId, name: c.name, isFastest: c.isFastest };
    if (s.status === 'rejected') {
      return { ...base, score: null, etaSec: 0, lengthM: 0, polyline: [], error: errorMessage(s.reason) };
    }
    try {
      const p = s.value;
      return { ...base, score: scoreRoute(p.spans), etaSec: p.etaSec, lengthM: p.lengthM, polyline: p.polyline ?? [], error: null };
    } catch (e) {
      return { ...base, score: null, etaSec: 0, lengthM: 0, polyline: [], error: errorMessage(e) };
    }
  });
  try {
    state.results = rankRoutes(results, { maxPenaltySec: (state.settings.maxPenaltyMin ?? 10) * 60, overlap: (a, b) => polylineOverlap(a.polyline ?? [], b.polyline ?? []) });
  } catch (e) {
    console.error(e);
    state.results = { ranked: [], hidden: [], errors: results.map((r) => ({ ...r, error: r.error ?? errorMessage(e) })) };
  }
  state.lastChecked = new Date();
  state.loading = false;
  if (!DEMO) {
    const ts = Date.now();
    const records = results.filter((r) => r.score && r.score.badge != null).map((r) => ({
      ts, direction, corridorId: r.corridorId, name: r.name, S: r.score.S, badge: r.score.badge,
      etaSec: r.etaSec, slowShare: r.score.slowShare, coverage: r.score.coverage,
    }));
    try { if (records.length) await appendHistory(records); } catch (e) { console.warn('history append failed', e); }
  }
  render();
}

// ---------- settings form ----------
function readForm(form) {
  const f = form.elements;
  const num = (n) => Number.parseFloat(f[n]?.value);
  const val = (n) => f[n]?.value ?? '';
  const corridors = [];
  for (let i = 0; f[`c.${i}.name`]; i++) {
    corridors.push({
      id: val(`c.${i}.id`) || `c${Date.now()}${i}`,
      name: val(`c.${i}.name`).trim() || `Corridor ${i + 1}`,
      enabled: f[`c.${i}.enabled`].checked,
      via: { lat: num(`c.${i}.lat`), lng: num(`c.${i}.lng`) },
      note: val(`c.${i}.note`),
    });
  }
  return {
    ...state.settings,
    home: { name: val('home.name').trim(), lat: num('home.lat'), lng: num('home.lng') },
    work: { name: val('work.name').trim(), lat: num('work.lat'), lng: num('work.lng') },
    maxPenaltyMin: Number.isFinite(num('maxPenaltyMin')) ? num('maxPenaltyMin') : DEFAULT_SETTINGS.maxPenaltyMin,
    apiKey: val('apiKey').trim(),
    corridors,
  };
}

function validate(s) {
  const bad = (p) => !Number.isFinite(p?.lat) || !Number.isFinite(p?.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180;
  if (bad(s.home)) return 'Home coordinates are invalid';
  if (bad(s.work)) return 'Work coordinates are invalid';
  const c = s.corridors.find((x) => bad(x.via));
  return c ? `Via coordinates for "${c.name}" are invalid` : null;
}

// ---------- routing / render ----------
const routePath = () => (location.hash.replace(/^#/, '') || '/');

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
      if (state.direction !== el.dataset.dir) { state.direction = el.dataset.dir; state.results = null; state.expandedId = null; state.lastChecked = null; }
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
      state.draft.corridors.push({ id: `c${Date.now()}`, name: 'New corridor', enabled: true, via: { lat: NaN, lng: NaN }, note: '' });
      return render();
    case 'remove-corridor':
      state.draft = readForm(form);
      state.draft.corridors.splice(Number(el.dataset.index), 1);
      return render();
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
    render();
    toast('Saved');
  } catch (ex) {
    toast(`Save failed: ${ex.message}`);
  }
});

window.addEventListener('hashchange', onRoute);

(async function init() {
  try { state.settings = await loadSettings(); } catch (e) { console.warn('loadSettings failed', e); }
  if (!location.hash) history.replaceState(null, '', '#/');
  await onRoute();
  if (routePath() === '/' && (DEMO || state.settings.apiKey)) refresh();
})();
