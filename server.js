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
async function phTraffic(windowClause) {
  const q = `SELECT
      countIf(event='$pageview') AS visits,
      uniqIf(person_id, event='$pageview') AS visitors,
      countIf(event='tunnel_started') AS tunnelStart,
      countIf(event='dashboard_opened') AS reachedProduct,
      countIf(event='first_video_created') AS firstVideo
    FROM events WHERE ${windowClause}`;
  const r = await phQuery(q);
  const row = (r && r[0]) || [0, 0, 0, 0, 0];
  return { visits: +row[0] || 0, visitors: +row[1] || 0, tunnelStart: +row[2] || 0, reachedProduct: +row[3] || 0, firstVideo: +row[4] || 0 };
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
    const [subs, charges, disputes, invoices, bts, claudeUsd, falUsd, openaiUsd, supaSignups] = await Promise.all([
      paginate('subscriptions', '&status=all'),
      paginate('charges', `&created[gte]=${gte}`),
      paginate('disputes', `&created[gte]=${Math.floor(HIST)}`),
      paginate('invoices', `&status=paid&created[gte]=${gte}`),
      paginate('balance_transactions', `&created[gte]=${gte}`),
      claudeCostByDay(new Date(HIST * 1000).toISOString()).catch((e) => { console.log('claude cost ERR', e && e.message); return null; }),
      falCostByDay(fmtD(HIST), fmtD(T.now + 2 * 86400)).catch((e) => { console.log('fal cost ERR', e && e.message); return null; }),
      openaiCostByDay(Math.floor(HIST)).catch((e) => { console.log('openai cost ERR', e && e.message); return null; }),
      supabaseSignupsByDay(HIST).catch((e) => { console.log('supabase ERR', e && e.message); return null; }),
    ]);

    // --- Abonnements / état live ---
    const active = subs.filter((s) => s.status === 'active' && !s.cancel_at_period_end);
    const canceling = subs.filter((s) => s.status === 'active' && s.cancel_at_period_end);
    const pastDue = subs.filter((s) => s.status === 'past_due');
    const mrr = computeMRR(active);
    const arpu = active.length ? mrr / active.length : 0;

    const inWin = (ts, from) => ts && ts >= from;
    const newCount = (from) => subs.filter((s) => inWin(s.created, from)).length;
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
    const claudeEurByDay = {}, falEurByDay = {}, openaiEurByDay = {};
    if (claudeUsd) for (const [day, v] of Object.entries(claudeUsd)) claudeEurByDay[day] = v * EUR_PER_USD;
    if (falUsd) for (const [day, v] of Object.entries(falUsd)) falEurByDay[day] = v * EUR_PER_USD;
    if (openaiUsd) for (const [day, v] of Object.entries(openaiUsd)) openaiEurByDay[day] = v * EUR_PER_USD;
    const claudeWin = { today: 0, d7: 0, d30: 0 }, falWin = { today: 0, d7: 0, d30: 0 }, openaiWin = { today: 0, d7: 0, d30: 0 };

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
      const cv = claudeEurByDay[key] || 0, fv = falEurByDay[key] || 0, ov = openaiEurByDay[key] || 0;
      if (i === 0) { signupsWin.today += sv; claudeWin.today += cv; falWin.today += fv; openaiWin.today += ov; }
      if (i < 7) { signupsWin.d7 += sv; claudeWin.d7 += cv; falWin.d7 += fv; openaiWin.d7 += ov; }
      signupsWin.d30 += sv; claudeWin.d30 += cv; falWin.d30 += fv; openaiWin.d30 += ov;
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
      if (s.created >= HIST) dget(dk(s.created)).news++;
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
        fixedCost: r2(fixedDay),
        margin: r2(rev - refund - dispAmt - (feeByDay[key] || 0) - (claudeEurByDay[key] || 0) - (falEurByDay[key] || 0) - (openaiEurByDay[key] || 0) - fixedDay),
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

    // --- Trafic PostHog (non bloquant : si ça échoue, Stripe reste servi) ---
    let traffic = null, trafficDays = null;
    if (PH_KEY) {
      try {
        const [tToday, t7, t30] = await Promise.all([
          phTraffic("timestamp >= toStartOfDay(now(), 'Europe/Paris')"),
          phTraffic('timestamp > now() - interval 7 day'),
          phTraffic('timestamp > now() - interval 30 day'),
        ]);
        traffic = { today: tToday, d7: t7, d30: t30 };
        const rows = await phQuery(`SELECT toString(toDate(toTimeZone(timestamp, 'Europe/Paris'))) AS d,
            countIf(event='$pageview') AS v, uniqIf(person_id, event='$pageview') AS vi,
            countIf(event='tunnel_started') AS ts, countIf(event='dashboard_opened') AS rp, countIf(event='first_video_created') AS fv
          FROM events WHERE timestamp > now() - interval ${HISTORY_DAYS + 1} day GROUP BY d`);
        trafficDays = {};
        for (const r of rows) trafficDays[r[0]] = { visits: +r[1] || 0, visitors: +r[2] || 0, tunnelStart: +r[3] || 0, reachedProduct: +r[4] || 0, firstVideo: +r[5] || 0 };
      } catch (e) { console.log('posthog ERR', String(e && e.message || e)); }
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
      fixedCost: r2(fixedWin[k]),
      margin: r2(pay[k].rev - pay[k].refund - disp[k].amt - feeWin[k] - claudeWin[k] - falWin[k] - openaiWin[k] - fixedWin[k]),
    });

    CACHE = {
      loading: false, error: null, at: Date.now(),
      data: {
        traffic,
        trafficDays,
        phConnected: !!PH_KEY,
        supaConnected: !!(SUPABASE_URL && SUPABASE_KEY),
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
