// Cockpit Creatikk — service de pilotage (Stripe live).
// Tire les données Stripe en direct, calcule aujourd'hui / 7j / 30j + état live,
// met en cache (rafraîchi en fond), sert le dashboard.
// Clés en LECTURE SEULE, jamais exposées au navigateur.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3200;
// Clé Stripe restreinte lecture seule : env en prod, fichier scratch en local.
let STRIPE_KEY = process.env.STRIPE_KEY || '';
if (!STRIPE_KEY) {
  try { STRIPE_KEY = fs.readFileSync('/private/tmp/claude-501/-Users-julien-Dev-Creatikk/5a7315b3-ef28-4ecf-8333-cabac36b6206/scratchpad/stripe_key.txt', 'utf8').trim(); } catch (e) {}
}
let PH_KEY = process.env.POSTHOG_KEY || '';
if (!PH_KEY) {
  try { PH_KEY = fs.readFileSync('/private/tmp/claude-501/-Users-julien-Dev-Creatikk/5a7315b3-ef28-4ecf-8333-cabac36b6206/scratchpad/posthog_key.txt', 'utf8').trim(); } catch (e) {}
}
const PH_PROJECT = process.env.POSTHOG_PROJECT || '219725';
const PH_HOST = process.env.POSTHOG_HOST || 'eu.posthog.com';
let ANTHROPIC_ADMIN_KEY = process.env.ANTHROPIC_ADMIN_KEY || '';
if (!ANTHROPIC_ADMIN_KEY) {
  try { ANTHROPIC_ADMIN_KEY = fs.readFileSync('/private/tmp/claude-501/-Users-julien-Dev-Creatikk/5a7315b3-ef28-4ecf-8333-cabac36b6206/scratchpad/anthropic_admin_key.txt', 'utf8').trim(); } catch (e) {}
}
let FAL_KEY = process.env.FAL_KEY || '';
if (!FAL_KEY) {
  try { FAL_KEY = fs.readFileSync('/private/tmp/claude-501/-Users-julien-Dev-Creatikk/5a7315b3-ef28-4ecf-8333-cabac36b6206/scratchpad/fal_key.txt', 'utf8').trim(); } catch (e) {}
}
let OPENAI_ADMIN_KEY = process.env.OPENAI_ADMIN_KEY || '';
if (!OPENAI_ADMIN_KEY) {
  try { OPENAI_ADMIN_KEY = fs.readFileSync('/private/tmp/claude-501/-Users-julien-Dev-Creatikk/5a7315b3-ef28-4ecf-8333-cabac36b6206/scratchpad/openai_admin_key.txt', 'utf8').trim(); } catch (e) {}
}
// Whop : dépenses créateurs (Content Rewards) via le journal financier. Clé lecture "company:balance:read".
let WHOP_KEY = process.env.WHOP_KEY || '';
if (!WHOP_KEY) {
  try { WHOP_KEY = fs.readFileSync('/private/tmp/claude-501/-Users-julien-Dev-Creatikk/5a7315b3-ef28-4ecf-8333-cabac36b6206/scratchpad/whop_key.txt', 'utf8').trim(); } catch (e) {}
}
const WHOP_ACCOUNT = process.env.WHOP_ACCOUNT || 'biz_X18qG1YimL74yO';
const WHOP_RATE_PER_1K = +(process.env.WHOP_RATE_PER_1K || 1); // $ payé aux créateurs pour 1000 vues
// Supabase : compte les créations de compte (auth.users). URL projet + clé secrète (server-side only, lecture).
let SUPABASE_URL = process.env.SUPABASE_URL || '';
if (!SUPABASE_URL) {
  try { SUPABASE_URL = fs.readFileSync('/private/tmp/claude-501/-Users-julien-Dev-Creatikk/5a7315b3-ef28-4ecf-8333-cabac36b6206/scratchpad/supabase_url.txt', 'utf8').trim(); } catch (e) {}
}
let SUPABASE_KEY = process.env.SUPABASE_KEY || '';
if (!SUPABASE_KEY) {
  try { SUPABASE_KEY = fs.readFileSync('/private/tmp/claude-501/-Users-julien-Dev-Creatikk/5a7315b3-ef28-4ecf-8333-cabac36b6206/scratchpad/supabase_key.txt', 'utf8').trim(); } catch (e) {}
}
const EUR_PER_USD = +(process.env.EUR_PER_USD || 0.92); // conversion coûts IA (USD) → € pour la marge
// Coûts fixes mensuels (€/mois) : env JSON, ex {"Render":7,"Vercel":20,"Loops":49}.
// Défaut = Google/Gemini (moyenne factures Google Cloud mars-juin ≈ 34€/mois ; Google n'a pas d'API de coût simple). Surchargeable via env.
let MONTHLY_COSTS = {};
try { MONTHLY_COSTS = JSON.parse(process.env.MONTHLY_COSTS || '{"Google/Gemini":34}'); } catch (e) { MONTHLY_COSTS = { 'Google/Gemini': 34 }; }
const MONTHLY_TOTAL = Object.values(MONTHLY_COSTS).reduce((a, b) => a + (+b || 0), 0);
const DAYS_MO = 30.44;
const PARIS_OFFSET_H = 2; // été (CEST). Simplification assumée pour le découpage "jour".
const HISTORY_DAYS = +(process.env.HISTORY_DAYS || 45); // profondeur d'historique (jours) : détail jour-par-jour + sélecteur de date (au-delà, la zone trial avril-mai ralentit)

// --- Appel Stripe (GET, pagination) ---
function stripeGet(pathq) {
  return new Promise((resolve, reject) => {
    const opts = {
      host: 'api.stripe.com', path: '/v1/' + pathq, method: 'GET',
      headers: { Authorization: 'Bearer ' + STRIPE_KEY },
    };
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}
async function paginate(resource, extra = '') {
  let out = [], after = '';
  for (let i = 0; i < 60; i++) {
    const q = `${resource}?limit=100${extra}${after ? '&starting_after=' + after : ''}`;
    const d = await stripeGet(q);
    if (!d.data) break;
    out = out.concat(d.data);
    if (!d.has_more) break;
    after = d.data[d.data.length - 1].id;
  }
  return out;
}

// --- Requête PostHog (HogQL) ---
function phQuery(hogql) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } });
    const opts = {
      host: PH_HOST, path: `/api/projects/${PH_PROJECT}/query/`, method: 'POST',
      headers: { Authorization: 'Bearer ' + PH_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { try { const j = JSON.parse(d); resolve(j.results || []); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => req.destroy(new Error('ph timeout')));
    req.end(body);
  });
}
// Ne compter QUE le vrai site (creatikk.io) — exclut dev.creatikk.io / localhost (tests de Joseph & Julien qui gonflaient les chiffres).
const PH_HOST_FILTER = `properties.$host IN ('creatikk.io','www.creatikk.io')`;
async function phTraffic(windowClause) {
  const q = `SELECT
      countIf(event='$pageview') AS visits,
      uniqIf(person_id, event='$pageview') AS visitors,
      countIf(event='tunnel_started') AS tunnelStart,
      countIf(event='dashboard_opened') AS reachedProduct,
      countIf(event='first_video_created') AS firstVideo
    FROM events WHERE ${PH_HOST_FILTER} AND (${windowClause})`;
  const r = await phQuery(q);
  const row = (r && r[0]) || [0, 0, 0, 0, 0];
  return { visits: +row[0] || 0, visitors: +row[1] || 0, tunnelStart: +row[2] || 0, reachedProduct: +row[3] || 0, firstVideo: +row[4] || 0 };
}

// --- D'où viennent les visiteurs : domaine référent + utm_source (les liens créateurs Whop).
// Sert à mesurer le canal créateurs : même sans UTM, un clic depuis TikTok donne $referring_domain=tiktok.com.
async function phSources(windowClause) {
  const base = `event='$pageview' AND ${PH_HOST_FILTER} AND (${windowClause})`;
  const refs = await phQuery(`SELECT
      if(properties.$referring_domain IS NULL OR properties.$referring_domain = '' OR properties.$referring_domain LIKE '%creatikk.io%', 'direct / interne', properties.$referring_domain) AS src,
      uniq(person_id) AS visitors, count() AS views
    FROM events WHERE ${base} GROUP BY src ORDER BY visitors DESC LIMIT 12`);
  const utm = await phQuery(`SELECT concat(toString(properties.utm_source), if(properties.utm_campaign IS NOT NULL AND toString(properties.utm_campaign) != '', concat(' · ', toString(properties.utm_campaign)), '')) AS src,
      uniq(person_id) AS visitors
    FROM events WHERE ${base} AND properties.utm_source IS NOT NULL AND toString(properties.utm_source) != '' GROUP BY src ORDER BY visitors DESC LIMIT 12`);
  return {
    referrers: (refs || []).map((r) => ({ src: r[0], visitors: +r[1] || 0, views: +r[2] || 0 })),
    utm: (utm || []).map((r) => ({ src: r[0], visitors: +r[1] || 0 })),
  };
}

// --- Funnel tunnel : chaque écran dans son ordre RÉEL (mesuré : temps moyen depuis l'entrée),
// combien le voient (total + par parcours debutant/pro), et où chaque personne S'ARRÊTE (dernier écran vu).
async function phTunnel(windowClause) {
  const base = `event='tunnel_step_viewed' AND ${PH_HOST_FILTER} AND (${windowClause})`;
  const seen = await phQuery(`SELECT s.step AS step, uniq(s.pid) AS people,
      uniqIf(s.pid, s.path='debutant') AS deb, uniqIf(s.pid, s.path='pro') AS pro,
      round(avg(s.ts - st.start)) AS ord
    FROM (SELECT person_id AS pid, properties.step AS step, any(properties.path) AS path, min(timestamp) AS ts
          FROM events WHERE ${base} GROUP BY person_id, properties.step) AS s
    JOIN (SELECT person_id AS pid, min(timestamp) AS start FROM events WHERE ${base} GROUP BY person_id) AS st
      ON s.pid = st.pid
    GROUP BY s.step ORDER BY ord`);
  const drop = await phQuery(`SELECT t.last_step AS step, count() AS n,
      countIf(t.path='debutant') AS deb, countIf(t.path='pro') AS pro
    FROM (SELECT person_id, argMax(properties.step, timestamp) AS last_step, argMax(properties.path, timestamp) AS path
          FROM events WHERE ${base} GROUP BY person_id) AS t
    GROUP BY t.last_step`);
  const steps = (seen || []).map((r) => ({ step: r[0], people: +r[1] || 0, deb: +r[2] || 0, pro: +r[3] || 0, drop: 0, dropDeb: 0, dropPro: 0 }));
  const idx = {}; steps.forEach((s) => (idx[s.step] = s));
  let pathDeb = 0, pathPro = 0;
  for (const r of (drop || [])) {
    pathDeb += +r[2] || 0; pathPro += +r[3] || 0;
    const s = idx[r[0]];
    if (s) { s.drop = +r[1] || 0; s.dropDeb = +r[2] || 0; s.dropPro = +r[3] || 0; }
  }
  return { steps, pathDeb, pathPro };
}

// --- « Quand ça fuit » : pour chaque personne, son JOUR d'entrée (Paris) + le dernier écran vu (= où elle a abandonné).
// 14 jours → permet au front de comparer 7 derniers jours vs 7 précédents, écran par écran.
async function phDropsByDay() {
  const base = `event='tunnel_step_viewed' AND ${PH_HOST_FILTER} AND timestamp > now() - interval 14 day`;
  const rows = await phQuery(`SELECT toString(toDate(toTimeZone(t.start, 'Europe/Paris'))) AS d, t.last_step AS step, count() AS n
    FROM (SELECT person_id, min(timestamp) AS start, argMax(properties.step, timestamp) AS last_step
          FROM events WHERE ${base} GROUP BY person_id) AS t
    GROUP BY d, step ORDER BY d LIMIT 5000`); // sans LIMIT explicite, HogQL tronque à 100 lignes (jours × écrans > 100)
  return (rows || []).map((r) => ({ d: r[0], step: r[1], n: +r[2] || 0 }));
}

// --- Coût Claude (usage_report Anthropic × prix — FIABLE, isole le produit de Claude Code) ---
function anthropicGet(pathq) {
  return new Promise((resolve, reject) => {
    const opts = { host: 'api.anthropic.com', path: '/v1/' + pathq, method: 'GET', headers: { 'x-api-key': ANTHROPIC_ADMIN_KEY, 'anthropic-version': '2023-06-01' } };
    const req = https.request(opts, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.setTimeout(30000, () => req.destroy(new Error('timeout'))); req.end();
  });
}
// prix $/MTok : [input, output, cache_read, cache_write]
const PRICES = {
  'claude-opus-4-8': [5, 25, .5, 6.25], 'claude-opus-4-7': [5, 25, .5, 6.25], 'claude-opus-4-6': [5, 25, .5, 6.25],
  'claude-sonnet-4-6': [3, 15, .3, 3.75], 'claude-sonnet-4-5': [3, 15, .3, 3.75], 'claude-sonnet-5': [3, 15, .3, 3.75],
  'claude-haiku-4-5': [1, 5, .1, 1.25], 'claude-fable-5': [10, 50, 1, 12.5],
};
function priceFor(model) { for (const k in PRICES) if (model && model.startsWith(k)) return PRICES[k]; return [5, 25, .5, 6.25]; }
async function claudeCostByDay(startISO) {
  if (!ANTHROPIC_ADMIN_KEY) return null;
  const byDay = {}; let page = '';
  for (let i = 0; i < 8; i++) {
    const d = await anthropicGet(`organizations/usage_report/messages?starting_at=${encodeURIComponent(startISO)}&group_by[]=model&bucket_width=1d&limit=31${page ? '&page=' + encodeURIComponent(page) : ''}`);
    if (!d || !d.data) break;
    for (const b of d.data) {
      const day = (b.starting_at || '').slice(0, 10); let c = 0;
      for (const r of (b.results || [])) {
        const [pi, po, pcr, pcw] = priceFor(r.model);
        let cw = 0; for (const k in r) if (k.includes('cache_creation') && typeof r[k] === 'number') cw += r[k];
        c += ((r.uncached_input_tokens || 0) * pi + (r.output_tokens || 0) * po + (r.cache_read_input_tokens || 0) * pcr + cw * pcw) / 1e6;
      }
      byDay[day] = (byDay[day] || 0) + c; // USD
    }
    if (!d.has_more) break; page = d.next_page;
  }
  return byDay;
}

// --- Coût fal.ai (models/usage, champ cost = facturation fal) ---
function falGet(pathq) {
  return new Promise((resolve, reject) => {
    const opts = { host: 'api.fal.ai', path: '/v1/' + pathq, method: 'GET', headers: { Authorization: 'Key ' + FAL_KEY } };
    const req = https.request(opts, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.setTimeout(30000, () => req.destroy(new Error('fal timeout'))); req.end();
  });
}
async function falCostByDay(start, end) {
  if (!FAL_KEY) return null;
  const d = await falGet(`models/usage?start=${start}&end=${end}&timeframe=day&expand=time_series`);
  const byDay = {};
  for (const b of (d.time_series || [])) {
    const day = (b.bucket || '').slice(0, 10); let c = 0;
    for (const r of (b.results || [])) c += parseFloat(r.cost || 0);
    byDay[day] = (byDay[day] || 0) + c; // USD
  }
  return byDay;
}

// --- Coût OpenAI (organization/costs, champ amount.value) ---
function openaiGet(pathq) {
  return new Promise((resolve, reject) => {
    const opts = { host: 'api.openai.com', path: '/v1/' + pathq, method: 'GET', headers: { Authorization: 'Bearer ' + OPENAI_ADMIN_KEY } };
    const req = https.request(opts, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.setTimeout(30000, () => req.destroy(new Error('openai timeout'))); req.end();
  });
}
async function openaiCostByDay(startUnix) {
  if (!OPENAI_ADMIN_KEY) return null;
  const byDay = {}; let page = '';
  for (let i = 0; i < 6; i++) {
    const d = await openaiGet(`organization/costs?start_time=${startUnix}&bucket_width=1d&limit=62${page ? '&page=' + page : ''}`);
    if (!d || !d.data) break;
    for (const b of d.data) {
      const day = new Date((b.start_time || 0) * 1000).toISOString().slice(0, 10); let c = 0;
      for (const r of (b.results || [])) c += parseFloat((r.amount || {}).value || 0);
      byDay[day] = (byDay[day] || 0) + c; // USD
    }
    if (!d.has_more) break; page = d.next_page;
  }
  return byDay;
}

// --- Créations de compte (Supabase Auth, auth.users) ---
function supabaseGet(pathq) {
  return new Promise((resolve, reject) => {
    const host = SUPABASE_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const opts = { host, path: pathq, method: 'GET', headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } };
    const req = https.request(opts, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.setTimeout(30000, () => req.destroy(new Error('supabase timeout'))); req.end();
  });
}
// Compte les users créés par jour (Paris), en paginant du plus récent au plus ancien, jusqu'à histTs.
async function supabaseSignupsByDay(histTs) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const byDay = {};
  for (let page = 1; page <= 80; page++) {
    const d = await supabaseGet(`/auth/v1/admin/users?page=${page}&per_page=200`);
    const users = (d && d.users) || [];
    if (!users.length) break;
    let oldest = Infinity;
    for (const u of users) {
      const ts = Date.parse(u.created_at) / 1000;
      if (!ts) continue;
      if (ts < oldest) oldest = ts;
      if (ts >= histTs) {
        const key = new Date((ts + PARIS_OFFSET_H * 3600) * 1000).toISOString().slice(0, 10);
        byDay[key] = (byDay[key] || 0) + 1;
      }
    }
    if (oldest < histTs || users.length < 200) break; // fenêtre couverte / dernière page
  }
  return byDay;
}

// --- Dépenses créateurs Whop (Content Rewards) : journal financier → sorties d'argent par jour (USD) ---
function whopGet(pathq) {
  return new Promise((resolve, reject) => {
    const opts = { host: 'api.whop.com', path: '/api/v1/' + pathq, method: 'GET', headers: { Authorization: 'Bearer ' + WHOP_KEY } };
    const req = https.request(opts, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.setTimeout(30000, () => req.destroy(new Error('whop timeout'))); req.end();
  });
}
async function whopSpendByDay(sinceISO) {
  if (!WHOP_KEY) return null;
  const byDay = {}; let funded = 0, spent = 0, cursor = '';
  for (let i = 0; i < 20; i++) {
    const d = await whopGet(`financial-activity?account_id=${WHOP_ACCOUNT}&limit=100&posted_after=${encodeURIComponent(sinceISO)}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
    const rows = (d && d.data) || [];
    for (const r of rows) {
      const prec = (r.currency && r.currency.precision != null) ? r.currency.precision : 2;
      const usd = (+r.amount || 0) / Math.pow(10, prec);
      if (usd < 0) { // sortie d'argent = paiement créateur (ou frais)
        spent += -usd;
        const day = String(r.posted_at || '').slice(0, 10);
        if (day) byDay[day] = (byDay[day] || 0) + -usd;
      } else { funded += usd; }
    }
    const pi = (d && d.page_info) || {};
    if (!pi.has_next_page || !pi.end_cursor) break;
    cursor = pi.end_cursor;
  }
  return { byDay, spent, funded };
}

// --- Bornes de temps (jour Paris) ---
function dayStartsUTC() {
  const now = Date.now() / 1000;
  const parisNow = new Date((now + PARIS_OFFSET_H * 3600) * 1000);
  const y = parisNow.getUTCFullYear(), m = parisNow.getUTCMonth(), d = parisNow.getUTCDate();
  const todayParisMidnight = Date.UTC(y, m, d) / 1000 - PARIS_OFFSET_H * 3600;
  return { now, today: todayParisMidnight, d7: now - 7 * 86400, d30: now - 30 * 86400 };
}

function computeMRR(subs) {
  let mrr = 0;
  for (const s of subs) for (const it of (s.items?.data || [])) {
    const pr = it.price || {}; const amt = (pr.unit_amount || 0) * (it.quantity || 1) / 100;
    mrr += (pr.recurring?.interval === 'year') ? amt / 12 : amt;
  }
  return mrr;
}

let CACHE = { loading: true, error: null, at: 0, data: null };

async function refresh() {
  try {
    const T = dayStartsUTC();
    const HIST = T.now - HISTORY_DAYS * 86400; // début de l'historique
    const gte = Math.floor(HIST - 5 * 86400);
    const fmtD = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
    const r2 = (x) => Math.round(x * 100) / 100; // arrondi au centime
    // Tous les appels indépendants EN PARALLÈLE (temps = le plus lent, pas la somme)
    const [subs, charges, disputes, invoices, bts, claudeUsd, falUsd, openaiUsd, supaSignups, whopData] = await Promise.all([
      paginate('subscriptions', '&status=all'),
      paginate('charges', `&created[gte]=${gte}`),
      paginate('disputes', `&created[gte]=${Math.floor(HIST)}`),
      paginate('invoices', `&status=paid&created[gte]=${gte}`),
      paginate('balance_transactions', `&created[gte]=${gte}`),
      claudeCostByDay(new Date(HIST * 1000).toISOString()).catch((e) => { console.log('claude cost ERR', e && e.message); return null; }),
      falCostByDay(fmtD(HIST), fmtD(T.now + 2 * 86400)).catch((e) => { console.log('fal cost ERR', e && e.message); return null; }),
      openaiCostByDay(Math.floor(HIST)).catch((e) => { console.log('openai cost ERR', e && e.message); return null; }),
      supabaseSignupsByDay(HIST).catch((e) => { console.log('supabase ERR', e && e.message); return null; }),
      whopSpendByDay(new Date(HIST * 1000).toISOString()).catch((e) => { console.log('whop ERR', e && e.message); return null; }),
    ]);

    // --- Abonnements / état live ---
    const active = subs.filter((s) => s.status === 'active' && !s.cancel_at_period_end);
    const canceling = subs.filter((s) => s.status === 'active' && s.cancel_at_period_end);
    const pastDue = subs.filter((s) => s.status === 'past_due');
    const mrr = computeMRR(active);
    const arpu = active.length ? mrr / active.length : 0;

    const inWin = (ts, from) => ts && ts >= from;
    // Un abo « nouvel abonné » = réellement démarré. On exclut incomplete/incomplete_expired (1er paiement jamais passé = carte refusée) : ça compterait un abonné qui n'a jamais payé.
    const started = (s) => s.status !== 'incomplete' && s.status !== 'incomplete_expired';
    const newCount = (from) => subs.filter((s) => inWin(s.created, from) && started(s)).length;
    const cancelCount = (from) => subs.filter((s) => inWin(s.canceled_at, from)).length;

    // --- Paiements (revenu, échecs, remboursements par fenêtre) ---
    const W = { today: T.today, d7: T.d7, d30: T.d30 };
    const zero = () => ({ ok: 0, rev: 0, fail: 0, refund: 0 });
    const pay = { today: zero(), d7: zero(), d30: zero() };
    const dayBuckets = {};
    for (const c of charges) {
      if (c.currency !== 'eur') continue;
      const amt = c.amount / 100, ref = (c.amount_refunded || 0) / 100;
      if (c.status === 'succeeded' && c.paid) {
        for (const k of Object.keys(W)) if (c.created >= W[k]) { pay[k].ok++; pay[k].rev += amt; pay[k].refund += ref; }
        const dk = new Date((c.created + PARIS_OFFSET_H * 3600) * 1000).toISOString().slice(0, 10);
        dayBuckets[dk] = (dayBuckets[dk] || 0) + amt;
      } else if (c.status === 'failed') {
        for (const k of Object.keys(W)) if (c.created >= W[k]) pay[k].fail++;
      }
    }
    const failRate = (w) => (w.ok + w.fail) ? Math.round(w.fail / (w.ok + w.fail) * 100) : 0;
    // série 30 jours
    const spark = [];
    for (let i = 29; i >= 0; i--) {
      const dk = new Date((T.now - i * 86400 + PARIS_OFFSET_H * 3600) * 1000).toISOString().slice(0, 10);
      spark.push({ d: dk, v: Math.round(dayBuckets[dk] || 0) });
    }

    // --- Litiges / chargebacks (par fenêtre) — disputes déjà chargé en parallèle ---
    const disp = { today: { n: 0, amt: 0 }, d7: { n: 0, amt: 0 }, d30: { n: 0, amt: 0 } };
    for (const d of disputes) {
      const a = (d.amount || 0) / 100;
      for (const k of Object.keys(W)) if (d.created >= W[k]) { disp[k].n++; disp[k].amt += a; }
    }

    // --- Factures : nouvelles ventes vs renouvellements (par fenêtre) — invoices déjà chargé ---
    // Date de PAIEMENT de la facture (= quand l'argent rentre), pas sa création → aligne le détail sur les recettes.
    const invPaid = (inv) => (inv.status_transitions && inv.status_transitions.paid_at) || inv.created;
    const split = { today: { newN: 0, newRev: 0, renN: 0, renRev: 0 }, d7: { newN: 0, newRev: 0, renN: 0, renRev: 0 }, d30: { newN: 0, newRev: 0, renN: 0, renRev: 0 } };
    for (const inv of invoices) {
      if (inv.currency !== 'eur') continue;
      const amt = (inv.amount_paid || 0) / 100;
      if (amt <= 0) continue; // une facture à 0€ n'est pas une vente (coupon/prorata/downsell)
      const isNew = inv.billing_reason === 'subscription_create';
      const paidTs = invPaid(inv);
      for (const k of Object.keys(W)) if (paidTs >= W[k]) {
        if (isNew) { split[k].newN++; split[k].newRev += amt; }
        else { split[k].renN++; split[k].renRev += amt; } // cycle + update + autres = un client existant qui re-paie
      }
    }

    // --- Frais Stripe (via balance transactions, en EUR) — bts déjà chargé ---
    const feeWin = { today: 0, d7: 0, d30: 0 };
    const feeByDay = {};
    for (const bt of bts) {
      if (bt.currency !== 'eur') continue;
      const fee = (bt.fee || 0) / 100;
      for (const k of Object.keys(W)) if (bt.created >= W[k]) feeWin[k] += fee;
      const key = new Date((bt.created + PARIS_OFFSET_H * 3600) * 1000).toISOString().slice(0, 10);
      feeByDay[key] = (feeByDay[key] || 0) + fee;
    }

    // --- Coûts IA (Claude/fal/OpenAI déjà chargés) → € par jour. Fenêtres calculées plus bas, par jour Paris (comme signups & le détail par jour) → pas de double-comptage. ---
    const claudeEurByDay = {}, falEurByDay = {}, openaiEurByDay = {}, whopEurByDay = {};
    if (claudeUsd) for (const [day, v] of Object.entries(claudeUsd)) claudeEurByDay[day] = v * EUR_PER_USD;
    if (falUsd) for (const [day, v] of Object.entries(falUsd)) falEurByDay[day] = v * EUR_PER_USD;
    if (openaiUsd) for (const [day, v] of Object.entries(openaiUsd)) openaiEurByDay[day] = v * EUR_PER_USD;
    if (whopData && whopData.byDay) for (const [day, v] of Object.entries(whopData.byDay)) whopEurByDay[day] = v * EUR_PER_USD;
    const claudeWin = { today: 0, d7: 0, d30: 0 }, falWin = { today: 0, d7: 0, d30: 0 }, openaiWin = { today: 0, d7: 0, d30: 0 }, whopWin = { today: 0, d7: 0, d30: 0 };

    // --- Coûts fixes mensuels répartis par jour/fenêtre ---
    const fixedDay = MONTHLY_TOTAL / DAYS_MO;
    const fixedWin = { today: fixedDay, d7: fixedDay * 7, d30: MONTHLY_TOTAL };

    // --- Détail JOUR PAR JOUR (35 derniers jours) pour le sélecteur de date ---
    const dk = (ts) => new Date((ts + PARIS_OFFSET_H * 3600) * 1000).toISOString().slice(0, 10);
    // --- Créations de compte (Supabase) → fenêtres (par jour calendaire Paris) ---
    const signupsByDay = supaSignups || null;
    const signupsWin = { today: 0, d7: 0, d30: 0 };
    for (let i = 0; i < 30; i++) {
      const key = dk(T.now - i * 86400);
      const sv = signupsByDay ? (signupsByDay[key] || 0) : 0;
      const cv = claudeEurByDay[key] || 0, fv = falEurByDay[key] || 0, ov = openaiEurByDay[key] || 0, wv = whopEurByDay[key] || 0;
      if (i === 0) { signupsWin.today += sv; claudeWin.today += cv; falWin.today += fv; openaiWin.today += ov; whopWin.today += wv; }
      if (i < 7) { signupsWin.d7 += sv; claudeWin.d7 += cv; falWin.d7 += fv; openaiWin.d7 += ov; whopWin.d7 += wv; }
      signupsWin.d30 += sv; claudeWin.d30 += cv; falWin.d30 += fv; openaiWin.d30 += ov; whopWin.d30 += wv;
    }
    const dayAgg = {};
    const dget = (k) => (dayAgg[k] || (dayAgg[k] = { rev: 0, sales: 0, fails: 0, refund: 0, newSales: 0, newRev: 0, renews: 0, renRev: 0, disputes: 0, disputeAmt: 0, news: 0, cancels: 0 }));
    for (const c of charges) {
      if (c.currency !== 'eur') continue;
      const amt = c.amount / 100, ref = (c.amount_refunded || 0) / 100;
      if (c.status === 'succeeded' && c.paid) { const g = dget(dk(c.created)); g.rev += amt; g.sales++; g.refund += ref; }
      else if (c.status === 'failed') { dget(dk(c.created)).fails++; }
    }
    for (const inv of invoices) {
      if (inv.currency !== 'eur') continue;
      const amt = (inv.amount_paid || 0) / 100;
      if (amt <= 0) continue; // facture à 0€ = pas une vente
      const g = dget(dk(invPaid(inv)));
      if (inv.billing_reason === 'subscription_create') { g.newSales++; g.newRev += amt; }
      else { g.renews++; g.renRev += amt; } // cycle + update + autres = client existant qui re-paie
    }
    for (const dd of disputes) { const g = dget(dk(dd.created)); g.disputes++; g.disputeAmt += (dd.amount || 0) / 100; }
    for (const s of subs) {
      if (s.created >= HIST && started(s)) dget(dk(s.created)).news++;
      if (s.canceled_at && s.canceled_at >= HIST) dget(dk(s.canceled_at)).cancels++;
    }
    const days = {};
    for (let i = 0; i < HISTORY_DAYS; i++) {
      const key = dk(T.now - i * 86400), g = dayAgg[key] || {};
      const rev = g.rev || 0, refund = g.refund || 0, dispAmt = g.disputeAmt || 0, fails = g.fails || 0, sales = g.sales || 0;
      days[key] = {
        rev: r2(rev), sales, news: g.news || 0, cancels: g.cancels || 0, fails,
        signups: (signupsByDay && signupsByDay[key]) || 0,
        failRate: (sales + fails) ? Math.round(fails / (sales + fails) * 100) : 0,
        refund: r2(refund), net: r2(rev - refund - dispAmt),
        newSales: g.newSales || 0, newRev: r2(g.newRev || 0),
        renews: g.renews || 0, renRev: r2(g.renRev || 0),
        disputes: g.disputes || 0, disputeAmt: r2(dispAmt),
        stripeFee: r2(feeByDay[key] || 0),
        aiClaude: r2(claudeEurByDay[key] || 0),
        aiFal: r2(falEurByDay[key] || 0),
        aiOpenai: r2(openaiEurByDay[key] || 0),
        whopCost: r2(whopEurByDay[key] || 0),
        fixedCost: r2(fixedDay),
        margin: r2(rev - refund - dispAmt - (feeByDay[key] || 0) - (claudeEurByDay[key] || 0) - (falEurByDay[key] || 0) - (openaiEurByDay[key] || 0) - (whopEurByDay[key] || 0) - fixedDay),
      };
    }

    // --- Détail des ventes (pour l'ouverture au clic) : une ligne par facture payée ---
    const cleanPlan = (s) => (s || '').replace(/^\s*\d+\s*×\s*/, '').trim(); // "1 × Creator (at €39.00 / month)" → "Creator (at €39.00 / month)"
    const tx = [];
    for (const inv of invoices) {
      if (inv.currency !== 'eur') continue;
      const amt = (inv.amount_paid || 0) / 100;
      if (amt <= 0) continue;
      const t = invPaid(inv);
      const ln = ((inv.lines || {}).data || [])[0] || {};
      tx.push({
        t, d: dk(t),
        email: inv.customer_email || '',
        amt: r2(amt),
        type: inv.billing_reason === 'subscription_create' ? 'new' : 'renew',
        reason: inv.billing_reason || '',
        plan: cleanPlan(ln.description) || (amt + ' €'),
      });
    }
    tx.sort((a, b) => b.t - a.t);

    // --- Rétention par cohorte (abonnés MENSUELS : mois d'inscription → % encore abonné à M1, M2…) ---
    const MONTHK = 30.44 * 86400;
    const isMonthly = (s) => ((s.items && s.items.data && s.items.data[0] && s.items.data[0].price && s.items.data[0].price.recurring || {}).interval === 'month');
    const cohortMap = {};
    for (const s of subs) {
      if (!s.created || !isMonthly(s)) continue;
      const dt = new Date(s.created * 1000);
      const cm = dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0');
      const end = s.canceled_at || T.now; // encore abonné → jusqu'à maintenant
      const life = (end - s.created) / MONTHK;
      const c = cohortMap[cm] || (cohortMap[cm] = { size: 0, life: [] });
      c.size++; c.life.push(life);
    }
    const cohorts = [];
    for (const m of Object.keys(cohortMap).sort().slice(-7)) {
      const c = cohortMap[m];
      const [yy, mm] = m.split('-').map(Number);
      const ageM = (T.now - Date.UTC(yy, mm - 1, 1) / 1000) / MONTHK;
      const ret = [];
      for (let k = 0; k <= 6 && k <= ageM + 0.02; k++) ret.push(Math.round(c.life.filter((l) => l >= k).length / c.size * 100));
      cohorts.push({ month: m, size: c.size, ret });
    }

    // --- Tendance : 7 derniers jours vs 7 précédents (direction pour l'agent IA) ---
    const trendOf = (field) => {
      let cur = 0, prev = 0;
      for (let i = 0; i < 14; i++) { const g = days[dk(T.now - i * 86400)] || {}; const v = +g[field] || 0; if (i < 7) cur += v; else prev += v; }
      return { cur: r2(cur), prev: r2(prev), delta: prev ? Math.round((cur - prev) / prev * 100) : (cur > 0 ? 100 : 0) };
    };
    const trends = { rev: trendOf('rev'), newSales: trendOf('newSales'), signups: trendOf('signups'), cancels: trendOf('cancels') };
    const cvp = (a, b) => (b ? +(a / b * 100).toFixed(1) : 0);
    trends.conv = { cur: cvp(trends.newSales.cur, trends.signups.cur), prev: cvp(trends.newSales.prev, trends.signups.prev) };
    trends.conv.delta = trends.conv.prev ? Math.round((trends.conv.cur - trends.conv.prev) / trends.conv.prev * 100) : 0;

    // --- Répartition par formule (abonnés actifs) : où se concentre le MRR ---
    const planMap = {};
    for (const s of active) {
      const it = (s.items && s.items.data && s.items.data[0]) || {}; const pr = it.price || {};
      const amt = (pr.unit_amount || 0) / 100, intv = (pr.recurring && pr.recurring.interval) || '?';
      const label = pr.nickname || `${amt}€/${intv === 'year' ? 'an' : intv === 'month' ? 'mois' : intv}`;
      const m = planMap[label] || (planMap[label] = { label, count: 0, mrr: 0 });
      m.count++; m.mrr += intv === 'year' ? amt / 12 : amt;
    }
    const planMix = Object.values(planMap).sort((a, b) => b.mrr - a.mrr).map((p) => ({ label: p.label, count: p.count, mrr: Math.round(p.mrr) }));

    // --- Trafic PostHog (non bloquant : si ça échoue, Stripe reste servi) ---
    let traffic = null, trafficDays = null, tunnelFunnel = null, dropsByDay = null, sources = null;
    if (PH_KEY) {
      try {
        const [tToday, t7, t30, fToday, f7, f30, dbd, srcToday, src7] = await Promise.all([
          phTraffic("timestamp >= toStartOfDay(now(), 'Europe/Paris')"),
          phTraffic('timestamp > now() - interval 7 day'),
          phTraffic('timestamp > now() - interval 30 day'),
          phTunnel("timestamp >= toStartOfDay(now(), 'Europe/Paris')").catch((e) => { console.log('funnel today ERR', String(e && e.message || e)); return null; }),
          phTunnel('timestamp > now() - interval 7 day').catch((e) => { console.log('funnel d7 ERR', String(e && e.message || e)); return null; }),
          phTunnel('timestamp > now() - interval 30 day').catch((e) => { console.log('funnel d30 ERR', String(e && e.message || e)); return null; }),
          phDropsByDay().catch((e) => { console.log('dropsByDay ERR', String(e && e.message || e)); return null; }),
          phSources("timestamp >= toStartOfDay(now(), 'Europe/Paris')").catch((e) => { console.log('sources today ERR', String(e && e.message || e)); return null; }),
          phSources('timestamp > now() - interval 7 day').catch((e) => { console.log('sources d7 ERR', String(e && e.message || e)); return null; }),
        ]);
        traffic = { today: tToday, d7: t7, d30: t30 };
        tunnelFunnel = { today: fToday, d7: f7, d30: f30 };
        dropsByDay = dbd;
        sources = { today: srcToday, d7: src7 };
        const rows = await phQuery(`SELECT toString(toDate(toTimeZone(timestamp, 'Europe/Paris'))) AS d,
            countIf(event='$pageview') AS v, uniqIf(person_id, event='$pageview') AS vi,
            countIf(event='tunnel_started') AS ts, countIf(event='dashboard_opened') AS rp, countIf(event='first_video_created') AS fv
          FROM events WHERE ${PH_HOST_FILTER} AND timestamp > now() - interval ${HISTORY_DAYS + 1} day GROUP BY d`);
        trafficDays = {};
        for (const r of rows) trafficDays[r[0]] = { visits: +r[1] || 0, visitors: +r[2] || 0, tunnelStart: +r[3] || 0, reachedProduct: +r[4] || 0, firstVideo: +r[5] || 0 };
      } catch (e) { console.log('posthog ERR', String(e && e.message || e)); }
    }

    // Couverture PostHog = écran "création de compte" vu (PostHog) ÷ vrais comptes (Supabase).
    // Mesure l'angle mort des bloqueurs de pub — sert aux audits : les % PostHog ne couvrent que cette fraction du réel.
    const quality = {};
    for (const k of ['today', 'd7', 'd30']) {
      const fu = tunnelFunnel && tunnelFunnel[k];
      const seen = fu && fu.steps ? ((fu.steps.find((s) => s.step === 'signup') || {}).people || 0) : 0;
      const real = signupsWin[k] || 0;
      quality[k] = { phSignupSeen: seen, supaSignups: real, coveragePct: seen && real ? Math.min(100, Math.round((seen / real) * 100)) : null };
    }

    const winData = (k, from) => ({
      rev: r2(pay[k].rev),
      sales: pay[k].ok,
      signups: signupsWin[k],
      news: newCount(from),
      cancels: cancelCount(from),
      fails: pay[k].fail,
      failRate: failRate(pay[k]),
      refund: r2(pay[k].refund),
      net: r2(pay[k].rev - pay[k].refund - disp[k].amt),
      newSales: split[k].newN, newRev: r2(split[k].newRev),
      renews: split[k].renN, renRev: r2(split[k].renRev),
      disputes: disp[k].n, disputeAmt: r2(disp[k].amt),
      stripeFee: r2(feeWin[k]),
      aiClaude: r2(claudeWin[k]),
      aiFal: r2(falWin[k]),
      aiOpenai: r2(openaiWin[k]),
      whopCost: r2(whopWin[k]),
      fixedCost: r2(fixedWin[k]),
      margin: r2(pay[k].rev - pay[k].refund - disp[k].amt - feeWin[k] - claudeWin[k] - falWin[k] - openaiWin[k] - whopWin[k] - fixedWin[k]),
    });

    CACHE = {
      loading: false, error: null, at: Date.now(),
      data: {
        traffic,
        trafficDays,
        tunnelFunnel,
        dropsByDay,
        sources,
        quality,
        phConnected: !!PH_KEY,
        supaConnected: !!(SUPABASE_URL && SUPABASE_KEY),
        whop: whopData ? {
          connected: true,
          spentUsd: r2(whopData.spent), fundedUsd: r2(whopData.funded),
          spentEur: r2(whopData.spent * EUR_PER_USD),
          views: Math.round(whopData.spent / WHOP_RATE_PER_1K * 1000),
          ratePer1k: WHOP_RATE_PER_1K,
        } : { connected: !!WHOP_KEY },
        live: {
          mrr: Math.round(mrr), arr: Math.round(mrr * 12), arpu: +arpu.toFixed(2),
          active: active.length, canceling: canceling.length, pastDue: pastDue.length,
          totalSubs: subs.length,
        },
        today: winData('today', T.today),
        d7: winData('d7', T.d7),
        d30: winData('d30', T.d30),
        days,
        tx,
        cohorts,
        trends,
        planMix,
        nowSec: Math.floor(T.now),
        monthlyCosts: MONTHLY_COSTS,
        monthlyTotal: MONTHLY_TOTAL,
        minDay: dk(T.now - (HISTORY_DAYS - 1) * 86400),
        maxDay: dk(T.now),
        spark,
        mrrLost: Math.round(computeMRR(canceling)),
      },
    };
    console.log(new Date().toISOString(), 'refresh OK — actifs', active.length, 'MRR', Math.round(mrr), 'ventes/j', pay.today.ok);
  } catch (e) {
    CACHE.error = String(e && e.message || e);
    CACHE.loading = false;
    console.log('refresh ERR', CACHE.error);
  }
}

// premier chargement + toutes les 3 min
refresh();
setInterval(refresh, 3 * 60 * 1000);

// --- 🤖 JARVIS : briefing vocal du matin + questions, propulsé par Claude ---
const CLAUDE_KEY = process.env.CLAUDE_KEY || ''; // clé API Anthropic standard (env Render) — PAS la clé admin
const JARVIS_LABELS = {
  hook: "l'accueil (1er écran)", q_level: 'le 1er écran du quiz', q_content: 'le quiz contenu', q_blocker: 'le quiz blocage',
  q_goal: 'le quiz objectif', q_niche: 'le quiz niche', signup: 'la création de compte', teaser: 'le teaser du plan',
  loading: "l'analyse en cours", diagnostic: 'le diagnostic', potential: 'le potentiel', trends: 'les tendances',
  q_mindset: "le quiz état d'esprit", reassure: 'la réassurance', manque: '« ce qui te manque »', pipeline: 'la machine à contenu',
  payoff: 'le récap du plan', projection: 'la projection', revenue: 'les revenus possibles', testimonials: 'les témoignages',
  pacte: "l'engagement", compare: "l'avant/après", plan_ready: '« ton plan est prêt »', paywall: "l'écran des prix", downsell: "l'offre -50%",
};
function jarvisContext() {
  const d = CACHE.data || {};
  const pickW = (k) => { const w = d[k] || {}; return { ventesEUR: w.rev, nouvellesVentes: w.newSales, renouvellements: w.renews, inscrits: w.signups, resiliations: w.cancels, paiementsEchoues: w.fails, margeEUR: w.margin, litiges: w.disputes }; };
  let fuites = [];
  const fu = d.tunnelFunnel && d.tunnelFunnel.d7;
  if (fu && fu.steps) {
    const SKIP = new Set(['installapp', 'notifs', 'q_frequency', 'q_plateau', 'connect', 'account_analysis', 'niche_help', 'niche_q2', 'niche_q3', 'niche_loading', 'niche_suggest']);
    fuites = fu.steps.filter((s) => !SKIP.has(s.step) && s.drop > 0 && s.people > 0)
      .map((s) => ({ ecran: JARVIS_LABELS[s.step] || s.step, partis: s.drop, tauxFuitePct: Math.round((s.drop / s.people) * 100) }))
      .sort((a, b) => b.partis - a.partis).slice(0, 3);
  }
  return {
    date: new Date().toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' }),
    aujourdhui: pickW('today'), sept_derniers_jours: pickW('d7'), trente_derniers_jours: pickW('d30'),
    tendances_7j_vs_7_precedents_pct: d.trends,
    abonnesActifs: d.live && d.live.active, mrrEUR: d.live && d.live.mrr, dejaEnResiliation: d.live && d.live.canceling,
    trafic7j: d.traffic && d.traffic.d7, couverturePostHogPct: d.quality && d.quality.d7 && d.quality.d7.coveragePct,
    topFuitesTunnel7j: fuites,
    whopCreateurs: d.whop,
    repartitionFormules: (d.planMix || []).slice(0, 6),
    retentionCohortesMensuellesPct: d.cohorts,
    ventesParJour_30j: Object.fromEntries(Object.entries(d.days || {}).slice(-30).map(([k, v]) => [k, { ventesEUR: v.rev, nouvelles: v.newSales, inscrits: v.signups }])),
    baselineV1_avant_v2: { conversionInscritPayePct: 2.4, churnMensuelPct: 41, ltvEUR: 15, revenus6moisEUR: 115000, note: 'mesures Stripe/cockpit de juillet 2026 — la v2 (lancée le 29/07) doit faire mieux' },
  };
}
const JARVIS_SYSTEM = `Tu es Jarvis, l'analyste business personnel de Julien, fondateur de Creatikk (creatikk.io, SaaS IA de création de contenu TikTok, ~30-50€/mois).
Contexte : la v2 est lancée depuis le 29/07/2026. Objectif de la phase : prouver la conversion (référence V1 : 2,4% inscrit→payé) et la rétention AVANT de scaler. Levier n°1 du moment : lancer les créateurs payés aux vues (Whop, 1$/1000 vues) — tant que whopCreateurs.spentUsd = 0, ils n'ont rien posté. Le mailing (Loops) et le dunning tournent. PostHog ne voit que ~60% du trafic (adblockers) : ça ne concerne QUE les chiffres d'écrans du tunnel (à comparer entre eux). Les inscrits (Supabase), les ventes (Stripe) et donc la conversion inscrit→payé sont EXHAUSTIFS — la couverture PostHog ne les biaise pas, ne dis jamais le contraire.
Tu disposes de TOUT l'historique utile : fenêtres aujourd'hui/7j/30j, ventes jour par jour sur 30 jours, rétention par cohorte mensuelle, répartition des formules, la baseline V1 complète (avant la v2), et ton JOURNAL persistant (tes briefings passés + ce que Julien t'a demandé de retenir). Ne dis JAMAIS que tu es limité à deux semaines ou que tu manques d'historique — si une donnée précise manque vraiment, nomme-la et propose de la brancher au cockpit.
Tu parles À L'ORAL, en tutoyant, comme un bras droit brillant : direct, chaleureux, zéro jargon, zéro liste à puces. Arrondis les chiffres. Tout est en euros. Ta mission : faire gagner de l'argent à Julien — chaque réponse finit sur ce qui a le plus d'impact.`;
function claudeAsk(userMsg, maxTokens) {
  return new Promise((resolve, reject) => {
    if (!CLAUDE_KEY) return reject(new Error('CLAUDE_KEY manquante (env Render)'));
    const body = JSON.stringify({
      model: 'claude-opus-4-8', max_tokens: maxTokens || 2500, thinking: { type: 'adaptive' },
      system: JARVIS_SYSTEM, messages: [{ role: 'user', content: userMsg }],
    });
    const req2 = https.request({ host: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }, (r) => {
      let b = ''; r.on('data', (c) => (b += c));
      r.on('end', () => {
        try {
          const j = JSON.parse(b);
          if (j.error) return reject(new Error(j.error.message || 'erreur Claude'));
          const txt = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
          resolve(txt || '(réponse vide)');
        } catch (e) { reject(e); }
      });
    });
    req2.on('error', reject); req2.setTimeout(120000, () => req2.destroy(new Error('timeout Claude'))); req2.end(body);
  });
}
// --- Mémoire perpétuelle de Jarvis (table Supabase jarvis_memory — créée par Julien via le SQL fourni).
// Robuste : si la table n'existe pas encore, tout continue sans mémoire.
function supaReq(method, pathq, payload) {
  return new Promise((resolve, reject) => {
    if (!SUPABASE_URL || !SUPABASE_KEY) return resolve(null);
    const u = new URL(SUPABASE_URL + pathq);
    const req2 = https.request({ host: u.host, path: u.pathname + u.search, method, headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' } }, (r) => {
      let b = ''; r.on('data', (c) => (b += c));
      r.on('end', () => { if (r.statusCode >= 400) return resolve(null); try { resolve(b ? JSON.parse(b) : true); } catch (e) { resolve(true); } });
    });
    req2.on('error', () => resolve(null)); req2.setTimeout(15000, () => req2.destroy()); req2.end(payload ? JSON.stringify(payload) : undefined);
  });
}
const memGet = (limit) => supaReq('GET', `/rest/v1/jarvis_memory?select=day,kind,content&order=created_at.desc&limit=${limit || 20}`);
const memAdd = (kind, content) => supaReq('POST', '/rest/v1/jarvis_memory', { kind, content: String(content).slice(0, 2000) });

let BRIEF_CACHE = { day: null, text: null, audioUrl: null }; // 1 briefing par jour (coût maîtrisé) — ?force=1 pour regénérer
async function jarvisBrief(force) {
  const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
  if (!force && BRIEF_CACHE.day === day && BRIEF_CACHE.text) return BRIEF_CACHE;
  // Garde anti-redémarrage : au boot Render, Stripe met ~1 min à charger — ne JAMAIS briefer sur du vide
  if (!CACHE.data || !CACHE.data.live || CACHE.loading) throw new Error('Je finis de charger tes chiffres (redémarrage du serveur) — redemande-moi dans une minute.');
  const ctx = jarvisContext();
  const journal = await memGet(15);
  const txt = await claudeAsk(`Voici les chiffres du cockpit ce matin :\n${JSON.stringify(ctx, null, 1)}\n\nTon journal (tes derniers briefings et ce que Julien t'a demandé de retenir — assure le SUIVI : si tu avais pointé un problème, dis s'il est réglé ou pas) :\n${JSON.stringify(journal || 'journal pas encore branché', null, 1)}\n\nFais-moi mon briefing du matin, à l'oral, en 60 à 90 secondes (180-250 mots) : 1 phrase d'état général, ce qui a bougé (ventes, inscrits, tendances), le suivi de ce que tu surveillais, une alerte SEULEMENT si un chiffre le justifie vraiment, puis les 2-3 priorités concrètes du jour. Uniquement le texte à lire, sans titre ni puces.`);
  // Voix pré-générée : prête AVANT que Julien touche l'orbe (sinon le navigateur retombe sur la voix robot)
  let audioUrl = null;
  try { audioUrl = await falTTS(txt); } catch (e) { console.log('tts brief ERR', String(e && e.message || e)); }
  BRIEF_CACHE = { day, text: txt, audioUrl };
  memAdd('brief', `[${day}] ${txt}`.slice(0, 1200)); // fire-and-forget
  return BRIEF_CACHE;
}

// --- Voix premium : ElevenLabs via fal.ai (la FAL_KEY déjà en env) — fallback = voix du navigateur côté client.
const TTS_CACHE = new Map(); // hash du texte → url audio (évite de payer 2 fois la même lecture)
function falTTSModel(text, model) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text: text.slice(0, 4800), voice: process.env.JARVIS_VOICE || 'Daniel', stability: 0.45, similarity_boost: 0.8, style: 0.25 });
    const req2 = https.request({ host: 'fal.run', path: model, method: 'POST', headers: { Authorization: 'Key ' + FAL_KEY, 'Content-Type': 'application/json' } }, (r) => {
      let b = ''; r.on('data', (c) => (b += c));
      r.on('end', () => {
        try {
          const j = JSON.parse(b);
          const url = j && j.audio && j.audio.url;
          if (!url) return reject(new Error(JSON.stringify(j.detail || j.error || j).slice(0, 200)));
          resolve(url);
        } catch (e) { reject(e); }
      });
    });
    req2.on('error', reject); req2.setTimeout(90000, () => req2.destroy(new Error('timeout TTS'))); req2.end(body);
  });
}
async function falTTS(text) {
  if (!FAL_KEY) throw new Error('FAL_KEY absente');
  const key = require('crypto').createHash('md5').update(text).digest('hex');
  if (TTS_CACHE.has(key)) return TTS_CACHE.get(key);
  let url;
  try { url = await falTTSModel(text, '/fal-ai/elevenlabs/tts/multilingual-v2'); } // la meilleure qualité ElevenLabs
  catch (e) { console.log('tts multilingual ERR → turbo', String(e && e.message || e)); url = await falTTSModel(text, '/fal-ai/elevenlabs/tts/turbo-v2.5'); }
  if (TTS_CACHE.size > 40) TTS_CACHE.clear();
  TTS_CACHE.set(key, url);
  return url;
}

// --- Serveur ---
const COCKPIT_PASSWORD = process.env.COCKPIT_PASSWORD || '';
const COCKPIT_TOKEN = process.env.COCKPIT_TOKEN || ''; // accès machine (digest quotidien) : /api/data?token=...
const server = http.createServer((req, res) => {
  const q = new URL(req.url, 'http://x');
  const tokenOk = COCKPIT_TOKEN && q.searchParams.get('token') === COCKPIT_TOKEN;
  // Protection par mot de passe (si COCKPIT_PASSWORD défini). User = "creatikk". Le jeton machine contourne.
  if (COCKPIT_PASSWORD && !tokenOk) {
    const expected = 'Basic ' + Buffer.from('creatikk:' + COCKPIT_PASSWORD).toString('base64');
    if ((req.headers.authorization || '') !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Cockpit Creatikk"' });
      res.end('Accès protégé'); return;
    }
  }
  if (q.pathname === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ...CACHE, ageMs: Date.now() - CACHE.at, hasKey: !!STRIPE_KEY }));
    return;
  }
  const J = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (q.pathname === '/api/brief') {
    jarvisBrief(q.searchParams.get('force') === '1')
      .then((b) => { res.writeHead(200, J); res.end(JSON.stringify({ text: b.text, audioUrl: b.audioUrl })); })
      .catch((e) => { res.writeHead(500, J); res.end(JSON.stringify({ error: String(e && e.message || e) })); });
    return;
  }
  if (q.pathname === '/api/ask' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', async () => {
      let qq = ''; try { qq = String(JSON.parse(body).q || '').slice(0, 500); } catch (e) {}
      if (!qq) { res.writeHead(400, J); res.end(JSON.stringify({ error: 'question vide' })); return; }
      if (!CACHE.data || !CACHE.data.live) { res.writeHead(503, J); res.end(JSON.stringify({ error: 'Je finis de charger tes chiffres (redémarrage du serveur) — redemande-moi dans une minute.' })); return; }
      const isMem = /^\s*(retiens|souviens[- ]toi|note)\b/i.test(qq);
      if (isMem) memAdd('fact', qq.replace(/^\s*(retiens( que)?|souviens[- ]toi( que)?|note( que)?)\s*:?\s*/i, ''));
      const journal = await memGet(15);
      claudeAsk(`Chiffres actuels du cockpit :\n${JSON.stringify(jarvisContext(), null, 1)}\n\nTon journal (briefings passés + faits que Julien t'a demandé de retenir) :\n${JSON.stringify(journal || 'journal pas encore branché', null, 1)}\n\n${isMem ? "Julien vient de te demander de RETENIR quelque chose — c'est enregistré dans ton journal, confirme-le en une phrase puis commente si utile." : "Question de Julien — réponds à l'oral, 120 mots max, chiffres à l'appui :"} ${qq}`, 1500)
        .then((text) => { res.writeHead(200, J); res.end(JSON.stringify({ text })); })
        .catch((e) => { res.writeHead(500, J); res.end(JSON.stringify({ error: String(e && e.message || e) })); });
    });
    return;
  }
  if (q.pathname === '/api/tts' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 30000) req.destroy(); });
    req.on('end', () => {
      let t = ''; try { t = String(JSON.parse(body).text || ''); } catch (e) {}
      if (!t) { res.writeHead(400, J); res.end(JSON.stringify({ error: 'texte vide' })); return; }
      falTTS(t)
        .then((url) => { res.writeHead(200, J); res.end(JSON.stringify({ url })); })
        .catch((e) => { res.writeHead(500, J); res.end(JSON.stringify({ error: String(e && e.message || e) })); });
    });
    return;
  }
  let file = req.url === '/' ? 'index.html' : req.url.replace(/^\//, '').split('?')[0];
  const fp = path.join(__dirname, 'public', file);
  if (!fp.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); res.end(); return; }
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(fp);
    const ct = ext === '.html' ? 'text/html' : ext === '.json' ? 'application/json' : ext === '.js' ? 'text/javascript' : 'text/plain';
    res.writeHead(200, { 'Content-Type': ct + '; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});
server.listen(PORT, '0.0.0.0', () => console.log('Cockpit sur http://0.0.0.0:' + PORT, '| clé:', STRIPE_KEY ? 'OK' : 'MANQUANTE'));
