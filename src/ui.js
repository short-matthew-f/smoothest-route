// Pure render helpers: take data, return HTML strings. No DOM access, importable in Node.

const BAND_FILL = { green: '#1f9d55', amber: '#f0a81c', red: '#d64545', none: '#9aa3b0' };
const FLAG_LABELS = {
  'estimated': 'Estimated limits',
  'low-confidence': 'Low confidence',
  'long-detour': 'Long detour',
};
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS = [['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5]];

/** Escape a value for use in HTML text or attribute context. */
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export function fmtMin(sec) { return isNum(sec) ? `${Math.round(sec / 60)} min` : '–'; }
export function fmtPct(frac) { return isNum(frac) ? `${Math.round(frac * 100)}%` : '–'; }
export function msToMph(ms) { return isNum(ms) ? ms * 2.236936 : NaN; }
export function fmtTime(d) {
  if (d == null) return '';
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return '';
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}
function fmtDelta(sec) {
  if (!isNum(sec)) return '';
  if (sec <= 0) return 'fastest ETA';
  if (sec < 30) return '+<1 min vs fastest';
  return `+${Math.round(sec / 60)} min vs fastest`;
}

export function bandOfBadge(badge) {
  if (!isNum(badge)) return 'none';
  return badge >= 80 ? 'green' : badge >= 50 ? 'amber' : 'red';
}

export function renderBadge(badge, small = false) {
  const band = bandOfBadge(badge);
  const label = isNum(badge) ? `Smoothness ${badge} out of 100` : 'No smoothness score';
  return `<span class="badge band-${band}${small ? ' sm' : ''}" role="img" aria-label="${label}">${isNum(badge) ? badge : '–'}</span>`;
}

/** Inline SVG strip chart; one <rect> per segment, width proportional to length. */
export function renderStripChart(segments) {
  const segs = Array.isArray(segments) ? segments : [];
  const total = segs.reduce((a, s) => a + (isNum(s?.len) && s.len > 0 ? s.len : 0), 0);
  let x = 0;
  const rects = total > 0 ? segs.map((s) => {
    const len = isNum(s?.len) && s.len > 0 ? s.len : 0;
    const band = BAND_FILL[s?.band] ? s.band : 'none';
    const w = (len / total) * 100;
    const r = `<rect class="seg-${band}" x="${x.toFixed(3)}%" y="0" width="${w.toFixed(3)}%" height="18" fill="${BAND_FILL[band]}"${band === 'none' ? ' fill-opacity="0.5"' : ''}/>`;
    x += w;
    return r;
  }).join('') : '';
  return `<svg class="strip" width="100%" height="18" role="img" aria-label="Speed relative to limit along the route" shape-rendering="crispEdges" preserveAspectRatio="none">${rects}</svg>`;
}

const LEGEND = `<div class="legend" aria-hidden="true"><span><i class="dot green"></i>≥80% of limit</span><span><i class="dot amber"></i>50–80%</span><span><i class="dot red"></i>&lt;50%</span><span><i class="dot none"></i>no data</span></div>`;

function chips(r) {
  const out = [];
  for (const f of r?.flags ?? []) {
    if (f === 'merged') {
      const names = (r.mergedWith ?? []).map(esc).join(', ');
      out.push(`<span class="chip">Same road as ${names || 'another route'}</span>`);
    } else {
      out.push(`<span class="chip warn">${esc(FLAG_LABELS[f] ?? f)}</span>`);
    }
  }
  return out.length ? `<span class="chips">${out.join('')}</span>` : '';
}

/**
 * @param {object} ranked RankedRoute
 * @param {{expanded?: boolean, mapsUrl?: string}} opts
 */
export function renderRouteCard(ranked, { expanded = false, mapsUrl = '' } = {}) {
  const r = ranked ?? {};
  const sc = r.score;
  const id = esc(r.corridorId);
  const meta = [fmtMin(r.etaSec), fmtDelta(r.etaDeltaSec), isNum(sc?.slowShare) ? `${fmtPct(sc.slowShare)} slow` : '']
    .filter(Boolean).join(' · ');
  let body = '';
  if (expanded) {
    const miles = isNum(r.lengthM) ? `${(r.lengthM / 1609.344).toFixed(1)} mi` : '–';
    body = `<div class="card-body">
      ${renderStripChart(sc?.segments)}${LEGEND}
      <dl>
        <dt>Live-data coverage</dt><dd>${fmtPct(sc?.coverage)}</dd>
        <dt>Delay vs free flow</dt><dd>${fmtMin(sc?.delaySec)}</dd>
        <dt>Distance</dt><dd>${miles}</dd>
      </dl>
      ${mapsUrl ? `<a class="btn primary" href="${esc(mapsUrl)}" target="_blank" rel="noopener">Open in Maps</a>` : ''}
    </div>`;
  }
  return `<article class="card${expanded ? ' open' : ''}" data-card="${id}">
    <button type="button" class="card-head" data-action="toggle-card" data-id="${id}" aria-expanded="${expanded}">
      ${renderBadge(sc?.badge)}
      <span class="card-main"><span class="card-title">${esc(r.name)}</span><span class="card-meta">${esc(meta)}</span>${chips(r)}</span>
      <span class="chevron" aria-hidden="true">▾</span>
    </button>${body}
  </article>`;
}

export function renderErrorCard(result) {
  return `<article class="card error" data-card="${esc(result?.corridorId)}">
    <h3>${esc(result?.name)}</h3>
    <div class="muted">${esc(result?.error ?? 'Unknown error')}</div>
  </article>`;
}

/**
 * state: { settings, direction, loading, lastChecked, results: {ranked,hidden,errors}|null,
 *          expandedId, demo, mapsUrlFor?(route) -> string }
 */
export function renderRankingView(state) {
  const s = state ?? {};
  const res = s.results;
  const card = (r) => renderRouteCard(r, { expanded: s.expandedId === r.corridorId, mapsUrl: s.mapsUrlFor?.(r) ?? '' });
  const toggle = (dir, label) => `<button type="button" data-action="set-direction" data-dir="${dir}" aria-pressed="${s.direction === dir}">${label}</button>`;
  let h = `<div class="toolbar">
    <div class="seg" role="group" aria-label="Direction">${toggle('toWork', 'To work')}${toggle('toHome', 'To home')}</div>
    <span class="grow"></span>
    <button type="button" class="primary" data-action="refresh"${s.loading ? ' disabled' : ''}>${s.loading ? 'Checking…' : 'Refresh'}</button>
  </div>`;
  if (s.demo) h += `<div class="banner">Demo mode: using bundled sample responses.</div>`;
  else if (!s.settings?.apiKey) h += `<div class="banner">Add your HERE API key in <a href="#/settings">Settings</a> to check live routes.</div>`;
  if (s.lastChecked) h += `<p class="muted small">Last checked ${esc(fmtTime(s.lastChecked))}</p>`;
  if (!res) {
    h += `<p class="muted pad">${s.loading ? 'Checking routes…' : 'Tap Refresh to check routes.'}</p>`;
    return h;
  }
  if (!res.ranked?.length && !res.errors?.length && !res.hidden?.length) h += `<p class="muted pad">No routes to show.</p>`;
  h += (res.ranked ?? []).map(card).join('');
  if (res.hidden?.length) {
    h += `<details class="hidden-routes"${s.hiddenOpen ? ' open' : ''}><summary>Hidden (${res.hidden.length}) — over +${esc(s.settings?.maxPenaltyMin ?? 10)} min</summary>${res.hidden.map(card).join('')}</details>`;
  }
  h += (res.errors ?? []).map(renderErrorCard).join('');
  return h;
}

function numField(label, name, val, extra = '') {
  return `<div class="field"><label>${label}<input type="number" step="any" inputmode="decimal" name="${name}" value="${isNum(val) ? val : ''}" ${extra}></label></div>`;
}
function textField(label, name, val) {
  return `<div class="field"><label>${label}<input type="text" name="${name}" value="${esc(val)}" autocomplete="off"></label></div>`;
}
function place(key, title, p) {
  return `<fieldset><legend>${title}</legend>${textField('Name', `${key}.name`, p?.name)}
    <div class="row">${numField('Latitude', `${key}.lat`, p?.lat)}${numField('Longitude', `${key}.lng`, p?.lng)}</div></fieldset>`;
}

export function renderSettingsView(settings) {
  const s = settings ?? {};
  const corridors = (s.corridors ?? []).map((c, i) => `<div class="corridor" data-index="${i}">
      <input type="hidden" name="c.${i}.id" value="${esc(c?.id)}">
      <input type="hidden" name="c.${i}.note" value="${esc(c?.note)}">
      ${textField('Corridor name', `c.${i}.name`, c?.name)}
      <div class="row">${numField('Via latitude', `c.${i}.lat`, c?.via?.lat)}${numField('Via longitude', `c.${i}.lng`, c?.via?.lng)}</div>
      <div class="row">${numField('Return via latitude', `c.${i}.rlat`, c?.viaReturn?.lat)}${numField('Return via longitude', `c.${i}.rlng`, c?.viaReturn?.lng)}</div>
      <p class="muted">Return via (optional, for divided highways): used instead of the via point when going to home.</p>
      <div class="actions"><label class="check"><input type="checkbox" name="c.${i}.enabled"${c?.enabled ? ' checked' : ''}> Enabled</label>
      <span class="grow"></span><button type="button" class="danger" data-action="remove-corridor" data-index="${i}">Remove</button></div>
    </div>`).join('');
  return `<h2>Settings</h2>
  <form id="settings-form" autocomplete="off">
    ${place('home', 'Home', s.home)}
    ${place('work', 'Work', s.work)}
    <fieldset><legend>Options</legend>
      ${numField('Hide routes slower than fastest by (minutes)', 'maxPenaltyMin', s.maxPenaltyMin, 'min="0"')}
      <div class="row key"><div class="field"><label>HERE API key<input type="password" name="apiKey" value="${esc(s.apiKey)}" autocomplete="off" autocapitalize="off" spellcheck="false"></label></div>
      <div class="field"><button type="button" data-action="toggle-key">Show</button></div></div>
    </fieldset>
    <fieldset><legend>Corridors</legend>${corridors || '<p class="muted">No corridors yet.</p>'}
      <div class="actions"><button type="button" data-action="add-corridor">Add corridor</button></div></fieldset>
    <div class="actions"><button type="submit" class="primary">Save</button>
      <button type="button" class="danger" data-action="reset-defaults">Reset to defaults</button></div>
  </form>`;
}

function median(xs) {
  const a = xs.filter(isNum).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
const recBadge = (r) => (isNum(r?.badge) ? r.badge : isNum(r?.S) ? Math.round(100 * (1 - r.S)) : NaN);

/** Median badge per weekday (Mon..Fri) for a set of records. Exported for tests. */
export function weekdayMedians(records) {
  return WEEKDAYS.map(([label, dow]) => ({
    label,
    median: median(records.filter((r) => new Date(r.ts).getDay() === dow).map(recBadge)),
  }));
}

export function renderHistoryView(records, { filter = 'all' } = {}) {
  const all = Array.isArray(records) ? records : [];
  const recs = filter === 'all' ? all : all.filter((r) => r?.direction === filter);
  const btn = (v, label) => `<button type="button" data-action="hist-filter" data-filter="${v}" aria-pressed="${filter === v}">${label}</button>`;
  let h = `<h2>History</h2><div class="toolbar">
    <div class="seg" role="group" aria-label="Filter">${btn('all', 'All')}${btn('toWork', 'To work')}${btn('toHome', 'To home')}</div></div>`;
  if (!recs.length) {
    h += `<p class="muted pad">No history yet. Records are saved each time you refresh.</p>`;
  } else {
    const groups = new Map();
    for (const r of [...recs].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))) {
      if (!groups.has(r.corridorId)) groups.set(r.corridorId, []);
      groups.get(r.corridorId).push(r);
    }
    for (const [, rs] of groups) {
      const med = median(rs.map(recBadge));
      const wd = weekdayMedians(rs);
      h += `<article class="card" style="padding:12px">
        <div class="hist-head">${renderBadge(isNum(med) ? Math.round(med) : null, true)}
          <h3>${esc(rs[0].name)}</h3><span class="muted small">${rs.length} check${rs.length === 1 ? '' : 's'}</span></div>
        <table class="mini"><thead><tr>${wd.map((d) => `<th>${d.label}</th>`).join('')}</tr></thead>
          <tbody><tr>${wd.map((d) => `<td>${isNum(d.median) ? Math.round(d.median) : '–'}</td>`).join('')}</tr></tbody></table>
        <table class="mini"><tbody>${rs.slice(0, 5).map((r) => {
          const d = new Date(r.ts);
          const when = Number.isNaN(d.getTime()) ? '' : `${DAY_NAMES[d.getDay()]} ${fmtTime(d)}`;
          return `<tr><td>${esc(when)}</td><td>${esc(r.direction === 'toWork' ? 'to work' : 'to home')}</td><td>${isNum(recBadge(r)) ? recBadge(r) : '–'}</td><td>${fmtMin(r.etaSec)}</td></tr>`;
        }).join('')}</tbody></table>
      </article>`;
    }
  }
  h += `<div class="actions"><button type="button" data-action="export-csv">Export CSV</button>
    <button type="button" class="danger" data-action="clear-history">Clear history</button></div>`;
  return h;
}
