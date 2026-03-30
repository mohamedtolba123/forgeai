// ── Constants ────────────────────────────────────────────────────────────────
const USER_NS   = ‘nouromar1’;
const CORS      = {
‘Access-Control-Allow-Origin’:  ‘*’,
‘Access-Control-Allow-Methods’: ‘GET, POST, OPTIONS’,
‘Access-Control-Allow-Headers’: ‘Content-Type, X-User’,
‘Content-Type’:                 ‘application/json’,
};

// Data retention policy (days)
const RETENTION = {
‘market:daily’:      365,
‘portfolio:snapshot’: 365,
‘brief:archive’:      90,
‘scanner:results’:    30,
‘alerts:history’:     90,
};

// Stooq symbols
const STOOQ_SYMBOLS = {
‘%5Espx’: ‘SPX’,  ‘%5Endq’: ‘NDX’,  ‘%5Edji’: ‘DJI’,
‘%5Erut’: ‘RUT’,  ‘%5Evix’: ‘VIX’,  ‘cl.f’:   ‘OIL’,
‘gc.f’:   ‘GOLD’, ‘si.f’:   ‘SILVER’,‘ng.f’:   ‘NATGAS’,
‘hg.f’:   ‘COPPER’,‘bz.f’:  ‘BRENT’,
};

// ── Helpers ──────────────────────────────────────────────────────────────────
const json  = (data, status=200) => new Response(JSON.stringify(data), { status, headers: CORS });
const err   = (msg, status=400) => json({ error: msg }, status);
const today = () => new Date().toISOString().split(‘T’)[0];
const key   = (type, suffix=’’) => `${USER_NS}:${type}${suffix ? ':'+suffix : ''}`;

// ── KV Storage helpers ───────────────────────────────────────────────────────
async function kvGet(kv, type, suffix=’’) {
try {
const val = await kv.get(key(type, suffix), ‘json’);
return val;
} catch(e) { return null; }
}

async function kvPut(kv, type, suffix=’’, data, ttlDays=null) {
const k = key(type, suffix);
const payload = { ts: Date.now(), data };
const opts = ttlDays ? { expirationTtl: ttlDays * 86400 } : {};
await kv.put(k, JSON.stringify(payload), opts);
}

async function kvList(kv, prefix) {
try {
const result = await kv.list({ prefix: `${USER_NS}:${prefix}` });
return result.keys || [];
} catch(e) { return []; }
}

// ── Auto-cleanup engine ───────────────────────────────────────────────────────
async function runCleanup(kv) {
const now = Date.now();
let deleted = 0;

for (const [prefix, days] of Object.entries(RETENTION)) {
const keys = await kvList(kv, prefix);
for (const { name } of keys) {
try {
const val = await kv.get(name, ‘json’);
if (val && val.ts) {
const ageDays = (now - val.ts) / 86400000;
if (ageDays > days) {
await kv.delete(name);
deleted++;
}
}
} catch(e) {}
}
}
return deleted;
}

// ── Market data (Stooq proxy) ─────────────────────────────────────────────────
async function fetchMarket(kv) {
const results = {};
const errors  = [];

await Promise.allSettled(
Object.entries(STOOQ_SYMBOLS).map(async ([sym, key_]) => {
try {
const r = await fetch(`https://stooq.com/q/l/?s=${sym}&f=sd2t2ohlcv&h&e=csv`, {
headers: { ‘User-Agent’: ‘Mozilla/5.0 (compatible; ForgeAI/2.0)’ },
cf: { cacheTtl: 300 },
});
if (!r.ok) { errors.push(`${key_}: HTTP ${r.status}`); return; }
const text  = await r.text();
const lines = text.trim().split(’\n’);
if (lines.length < 2) { errors.push(`${key_}: no data`); return; }
const parts = lines[1].split(’,’);
const open  = parseFloat(parts[3]);
const close = parseFloat(parts[6]);
if (!close || isNaN(close) || close <= 0) { errors.push(`${key_}: invalid`); return; }
const pct = open > 0 ? ((close - open) / open * 100) : 0;
results[key_] = {
price:  close,
open,
high:   parseFloat(parts[4]),
low:    parseFloat(parts[5]),
pct:    parseFloat(pct.toFixed(4)),
change: parseFloat((close - open).toFixed(4)),
date:   parts[1],
};
} catch(e) { errors.push(`${key_}: ${e.message}`); }
})
);

// Save to KV
if (Object.keys(results).length > 0 && kv) {
await kvPut(kv, ‘market:last’, ‘’, results, 7);
await kvPut(kv, ‘market:daily’, today(), results, RETENTION[‘market:daily’]);
// Run cleanup ~10% of the time to avoid slowing every request
if (Math.random() < 0.1) runCleanup(kv).catch(() => {});
}

return { ts: Date.now(), source: ‘stooq’, data: results, errors: errors.length ? errors : undefined };
}

// ── Yahoo Finance fallback ────────────────────────────────────────────────────
async function fetchYahoo(kv) {
const syms = [’^GSPC’,’^IXIC’,’^DJI’,’^RUT’,’^VIX’,‘GC=F’,‘CL=F’,‘SI=F’,‘NG=F’];
const map  = { ‘^GSPC’:‘SPX’,’^IXIC’:‘NDX’,’^DJI’:‘DJI’,’^RUT’:‘RUT’,’^VIX’:‘VIX’,
‘GC=F’:‘GOLD’,‘CL=F’:‘OIL’,‘SI=F’:‘SILVER’,‘NG=F’:‘NATGAS’ };
try {
const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${syms.map(s=>encodeURIComponent(s)).join('%2C')}`;
const r = await fetch(url, { headers: { ‘User-Agent’: ‘Mozilla/5.0’ } });
if (!r.ok) throw new Error(’Yahoo HTTP ’ + r.status);
const d = await r.json();
const results = {};
(d?.quoteResponse?.result || []).forEach(q => {
const k = map[q.symbol];
if (k && q.regularMarketPrice) {
results[k] = {
price:  q.regularMarketPrice,
pct:    q.regularMarketChangePercent || 0,
change: q.regularMarketChange || 0,
open:   q.regularMarketOpen || q.regularMarketPrice,
high:   q.regularMarketDayHigh || q.regularMarketPrice,
low:    q.regularMarketDayLow  || q.regularMarketPrice,
date:   today(),
};
}
});
if (Object.keys(results).length > 0 && kv) {
await kvPut(kv, ‘market:last’, ‘’, results, 7);
await kvPut(kv, ‘market:daily’, today(), results, RETENTION[‘market:daily’]);
}
return { ts: Date.now(), source: ‘yahoo’, data: results };
} catch(e) {
return { ts: Date.now(), source: ‘yahoo’, data: {}, error: e.message };
}
}

// ── Finnhub proxy ─────────────────────────────────────────────────────────────
async function proxyFinnhub(path, env) {
const key_ = env.FINNHUB_KEY;
if (!key_) return err(‘Finnhub key not configured’);
const sep = path.includes(’?’) ? ‘&’ : ‘?’;
const url = `https://finnhub.io/api/v1/${path}${sep}token=${key_}`;
try {
const r = await fetch(url, { cf: { cacheTtl: 60 } });
const d = await r.json();
return json(d);
} catch(e) { return err(’Finnhub: ’ + e.message); }
}

// ── Anthropic proxy ───────────────────────────────────────────────────────────
async function proxyAnthropic(body, env) {
const key_ = env.ANTHROPIC_KEY;
if (!key_) return err(‘Anthropic key not configured’);
try {
const r = await fetch(‘https://api.anthropic.com/v1/messages’, {
method:  ‘POST’,
headers: {
‘Content-Type’:      ‘application/json’,
‘x-api-key’:         key_,
‘anthropic-version’: ‘2023-06-01’,
},
body: JSON.stringify(body),
});
const d = await r.json();
return json(d, r.status);
} catch(e) { return err(’Anthropic: ’ + e.message); }
}

// ── FRED proxy ────────────────────────────────────────────────────────────────
async function proxyFRED(series, env) {
const key_ = env.FRED_KEY;
if (!key_) return err(‘FRED key not configured’);
const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${series}&api_key=${key_}&file_type=json&sort_order=desc&limit=5`;
try {
const r = await fetch(url, { cf: { cacheTtl: 3600 } });
const d = await r.json();
return json(d);
} catch(e) { return err(’FRED: ’ + e.message); }
}

// ── Twelve Data proxy ─────────────────────────────────────────────────────────
async function proxyTwelveData(path, env) {
const key_ = env.TWELVEDATA_KEY;
if (!key_) return err(‘TwelveData key not configured’);
const sep = path.includes(’?’) ? ‘&’ : ‘?’;
const url = `https://api.twelvedata.com/${path}${sep}apikey=${key_}`;
try {
const r = await fetch(url, { cf: { cacheTtl: 60 } });
const d = await r.json();
return json(d);
} catch(e) { return err(’TwelveData: ’ + e.message); }
}

// ── KV Storage endpoints ──────────────────────────────────────────────────────
async function handleStorage(method, type, suffix, body, kv) {
if (!kv) return err(‘KV not configured — add FORGEAI_KV binding in Cloudflare dashboard’);

if (method === ‘GET’) {
// Special: get market history for chart
if (type === ‘market:history’) {
const keys = await kvList(kv, ‘market:daily’);
const history = [];
for (const { name } of keys.slice(-90)) { // last 90 days
const val = await kv.get(name, ‘json’);
if (val) history.push({ date: name.split(’:’).pop(), data: val.data });
}
return json({ history: history.sort((a,b) => a.date.localeCompare(b.date)) });
}
const val = await kvGet(kv, type, suffix);
return json(val || { data: null });
}

if (method === ‘POST’) {
const ttl = RETENTION[type] || 90;
await kvPut(kv, type, suffix || today(), body, ttl);
// Cleanup ~5% of writes
if (Math.random() < 0.05) runCleanup(kv).catch(() => {});
return json({ ok: true, key: key(type, suffix || today()) });
}

if (method === ‘DELETE’) {
const deleted = await runCleanup(kv);
return json({ ok: true, deleted });
}

return err(‘Method not allowed’, 405);
}

// ── Main router ───────────────────────────────────────────────────────────────
export default {
async fetch(request, env, ctx) {
if (request.method === ‘OPTIONS’) return new Response(null, { status: 204, headers: CORS });

```
const url  = new URL(request.url);
const path = url.pathname.replace(/^\//, '');
const kv   = env.FORGEAI_KV || null;

// ── Health check ─────────────────────────────────────────────────────────
if (path === 'health') {
  const kvOk = kv ? 'connected' : 'not configured';
  return json({ status: 'ok', ts: Date.now(), user: USER_NS, kv: kvOk, version: '2.0' });
}

// ── Market data ──────────────────────────────────────────────────────────
if (path === 'market') {
  // Try Stooq first, fall back to Yahoo
  const stooq = await fetchMarket(kv);
  if (Object.keys(stooq.data).length >= 5) return json(stooq);
  const yahoo = await fetchYahoo(kv);
  return json({ ...yahoo, stooqErrors: stooq.errors });
}

if (path === 'market/last') {
  // Return last known from KV (for weekend/after-hours)
  const last = await kvGet(kv, 'market:last');
  return json(last || { data: {} });
}

if (path === 'market/history') {
  return handleStorage('GET', 'market:history', '', null, kv);
}

// ── Finnhub proxy ─────────────────────────────────────────────────────────
if (path.startsWith('finnhub/')) {
  const fhPath = path.replace('finnhub/', '') + (url.search || '');
  return proxyFinnhub(fhPath, env);
}

// ── Anthropic proxy ───────────────────────────────────────────────────────
if (path === 'ai' && request.method === 'POST') {
  const body = await request.json().catch(() => null);
  if (!body) return err('Invalid JSON body');
  return proxyAnthropic(body, env);
}

// ── FRED proxy ────────────────────────────────────────────────────────────
if (path.startsWith('fred/')) {
  const series = path.replace('fred/', '');
  return proxyFRED(series, env);
}

// ── Twelve Data proxy ─────────────────────────────────────────────────────
if (path.startsWith('td/')) {
  const tdPath = path.replace('td/', '') + (url.search || '');
  return proxyTwelveData(tdPath, env);
}

// ── KV Storage ────────────────────────────────────────────────────────────
if (path.startsWith('store/')) {
  const parts   = path.replace('store/', '').split('/');
  const type    = parts[0];
  const suffix  = parts[1] || '';
  const body    = request.method === 'POST'
    ? await request.json().catch(() => null)
    : null;
  return handleStorage(request.method, type, suffix, body, kv);
}

// ── Storage stats ─────────────────────────────────────────────────────────
if (path === 'storage/stats') {
  if (!kv) return err('KV not configured');
  const stats = {};
  for (const prefix of Object.keys(RETENTION)) {
    const keys = await kvList(kv, prefix);
    stats[prefix] = { count: keys.length, retentionDays: RETENTION[prefix] };
  }
  return json({ user: USER_NS, stats });
}

// ── Manual cleanup trigger ────────────────────────────────────────────────
if (path === 'storage/cleanup' && request.method === 'POST') {
  if (!kv) return err('KV not configured');
  const deleted = await runCleanup(kv);
  return json({ ok: true, deleted });
}

return err('Not found', 404);
```

},
};