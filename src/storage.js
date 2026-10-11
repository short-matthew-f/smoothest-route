// IndexedDB wrapper (browser only at runtime; importing in Node is safe).
import { DEFAULT_SETTINGS } from './defaults.js';

const DB_NAME = 'smoothest-route';
const DB_VERSION = 1;
const SETTINGS_STORE = 'settings';
const HISTORY_STORE = 'history';
const SETTINGS_KEY = 'main';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

function deepMerge(defaults, stored) {
  if (!isPlainObject(defaults)) return stored === undefined ? clone(defaults) : clone(stored);
  const out = clone(defaults);
  if (!isPlainObject(stored)) return out;
  for (const [k, sv] of Object.entries(stored)) {
    if (sv === undefined) continue;
    if (isPlainObject(sv) && isPlainObject(out[k])) out[k] = deepMerge(out[k], sv);
    else out[k] = clone(sv);
  }
  return out;
}

/**
 * Upgrade a stored corridor to the v0.2 schema (in place on an already-cloned object):
 * legacy `via` -> `vias: [via]`, legacy `viaReturn` -> `viasReturn: [viaReturn]`, legacy keys
 * deleted; missing `vias` -> [], missing `avoidHighways` -> false. Already-new corridors are
 * left as they are (no `viasReturn` is invented).
 */
function migrateCorridor(c) {
  if (!isPlainObject(c)) return c;
  if (!Array.isArray(c.vias)) c.vias = isPlainObject(c.via) ? [c.via] : [];
  if ('viaReturn' in c && !Array.isArray(c.viasReturn) && isPlainObject(c.viaReturn)) {
    c.viasReturn = [c.viaReturn];
  }
  delete c.via;
  delete c.viaReturn;
  c.avoidHighways = Boolean(c.avoidHighways);
  return c;
}

function clampAlternatives(v, fallback) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(3, Math.max(0, Math.round(n)));
}

/**
 * Deep-merge stored values over defaults. Plain objects merge recursively;
 * arrays (e.g. corridors) and scalars from `stored` replace the default wholesale.
 * Then normalises: legacy corridor `via`/`viaReturn` migrate to `vias`/`viasReturn`
 * (see migrateCorridor) and `alternatives` becomes an integer 0..3 (default if unusable).
 * Pure; does not mutate inputs.
 */
export function mergeSettings(defaults, stored) {
  const out = deepMerge(defaults, stored);
  if (isPlainObject(out)) {
    if (Array.isArray(out.corridors)) out.corridors.forEach(migrateCorridor);
    if ('alternatives' in out || (isPlainObject(defaults) && 'alternatives' in defaults)) {
      const fallback = isPlainObject(defaults) ? clampAlternatives(defaults.alternatives, 1) : 1;
      out.alternatives = clampAlternatives(out.alternatives, fallback);
    }
  }
  return out;
}

function errMsg(e) {
  return (e && (e.message || e.name)) || String(e);
}

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this environment'));
      return;
    }
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(new Error(`Could not open local database: ${errMsg(e)}`));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) db.createObjectStore(SETTINGS_STORE);
      if (!db.objectStoreNames.contains(HISTORY_STORE)) {
        const h = db.createObjectStore(HISTORY_STORE, { autoIncrement: true });
        h.createIndex('ts', 'ts');
      }
    };
    const timer = setTimeout(() => reject(new Error('Timed out opening local database')), 10000);
    req.onsuccess = () => {
      clearTimeout(timer);
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { clearTimeout(timer); reject(new Error(`Could not open local database: ${errMsg(req.error)}`)); };
    req.onblocked = () => { clearTimeout(timer); reject(new Error('Local database is blocked by another open tab; close it and retry')); };
  }).catch((e) => { dbPromise = null; throw e; });
  return dbPromise;
}

/**
 * Run `fn(stores)` in one transaction; resolves with fn's return value (which may be
 * an IDBRequest, whose result is used) once the transaction completes.
 */
async function withStores(names, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let tx;
    let result;
    try {
      tx = db.transaction(names, mode);
      const stores = names.map((n) => tx.objectStore(n));
      result = fn(...stores);
    } catch (e) {
      reject(new Error(`Local database error: ${errMsg(e)}`));
      return;
    }
    tx.oncomplete = () => resolve(result && typeof result === 'object' && 'result' in result && 'readyState' in result ? result.result : result);
    tx.onerror = () => reject(new Error(`Local database error: ${errMsg(tx.error)}`));
    tx.onabort = () => reject(new Error(`Local database transaction aborted: ${errMsg(tx.error)}`));
  });
}

export async function loadSettings() {
  const stored = await withStores([SETTINGS_STORE], 'readonly', (s) => s.get(SETTINGS_KEY));
  return mergeSettings(DEFAULT_SETTINGS, stored);
}

export async function saveSettings(settings) {
  await withStores([SETTINGS_STORE], 'readwrite', (s) => { s.put(clone(settings), SETTINGS_KEY); });
}

export async function appendHistory(records) {
  if (!Array.isArray(records)) throw new TypeError('appendHistory expects an array');
  if (!records.length) return;
  await withStores([HISTORY_STORE], 'readwrite', (s) => { for (const r of records) s.add(r); });
}

export async function listHistory({ since } = {}) {
  return withStores([HISTORY_STORE], 'readonly', (s) => {
    const range = since == null ? undefined : IDBKeyRange.lowerBound(since);
    return s.index('ts').getAll(range);
  }).then((rows) => rows || []);
}

export async function clearHistory() {
  await withStores([HISTORY_STORE], 'readwrite', (s) => { s.clear(); });
}

export const CSV_COLUMNS = ['ts', 'direction', 'corridorId', 'name', 'S', 'badge', 'etaSec', 'slowShare', 'coverage'];

function csvField(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' && !Number.isFinite(v)) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Records -> CSV text (header row always emitted, CRLF line endings, RFC 4180 quoting). */
export function historyToCsv(records) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of records || []) {
    lines.push(CSV_COLUMNS.map((c) => csvField(r[c])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function yyyymmdd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** Build a CSV Blob of all history and trigger a browser download. */
export async function exportHistoryCsv() {
  if (typeof document === 'undefined' || typeof Blob === 'undefined') {
    throw new Error('CSV export requires a browser');
  }
  const records = await listHistory();
  const blob = new Blob([historyToCsv(records)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `smoothest-route-history-${yyyymmdd(new Date())}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
