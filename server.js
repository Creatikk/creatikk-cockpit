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
const PARIS_OFFSET_H = 2; // été (CEST). Simplification assumée pour le découpage "jour".

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
    const subs = await paginate('subscriptions', '&status=all');
    const T = dayStartsUTC();
    const charges = await paginate('charges', `&created[gte]=${Math.floor(T.d30 - 5 * 86400)}`);

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

    // --- Litiges / chargebacks (par fenêtre) ---
    const disputes = await paginate('disputes', `&created[gte]=${Math.floor(T.d30)}`);
    const disp = { today: { n: 0, amt: 0 }, d7: { n: 0, amt: 0 }, d30: { n: 0, amt: 0 } };
    for (const d of disputes) {
      const a = (d.amount || 0) / 100;
      for (const k of Object.keys(W)) if (d.created >= W[k]) { disp[k].n++; disp[k].amt += a; }
    }

    // --- Factures : nouvelles ventes vs renouvellements (par fenêtre) ---
    const invoices = await paginate('invoices', `&status=paid&created[gte]=${Math.floor(T.d30 - 5 * 86400)}`);
    const split = { today: { newN: 0, newRev: 0, renN: 0, renRev: 0 }, d7: { newN: 0, newRev: 0, renN: 0, renRev: 0 }, d30: { newN: 0, newRev: 0, renN: 0, renRev: 0 } };
    for (const inv of invoices) {
      if (inv.currency !== 'eur') continue;
      const amt = (inv.amount_paid || 0) / 100;
      const isNew = inv.billing_reason === 'subscription_create' || inv.billing_reason === 'manual';
      const isRenew = inv.billing_reason === 'subscription_cycle';
      for (const k of Object.keys(W)) if (inv.created >= W[k]) {
        if (isNew) { split[k].newN++; split[k].newRev += amt; }
        else if (isRenew) { split[k].renN++; split[k].renRev += amt; }
      }
    }

    // --- Trafic PostHog (non bloquant : si ça échoue, Stripe reste servi) ---
    let traffic = null;
    if (PH_KEY) {
      try {
        const [tToday, t7, t30] = await Promise.all([
          phTraffic("timestamp >= toStartOfDay(now(), 'Europe/Paris')"),
          phTraffic('timestamp > now() - interval 7 day'),
          phTraffic('timestamp > now() - interval 30 day'),
        ]);
        traffic = { today: tToday, d7: t7, d30: t30 };
      } catch (e) { console.log('posthog ERR', String(e && e.message || e)); }
    }

    const winData = (k, from) => ({
      rev: Math.round(pay[k].rev),
      sales: pay[k].ok,
      news: newCount(from),
      cancels: cancelCount(from),
      fails: pay[k].fail,
      failRate: failRate(pay[k]),
      refund: Math.round(pay[k].refund),
      net: Math.round(pay[k].rev - pay[k].refund - disp[k].amt),
      newSales: split[k].newN, newRev: Math.round(split[k].newRev),
      renews: split[k].renN, renRev: Math.round(split[k].renRev),
      disputes: disp[k].n, disputeAmt: Math.round(disp[k].amt),
    });

    CACHE = {
      loading: false, error: null, at: Date.now(),
      data: {
        traffic,
        phConnected: !!PH_KEY,
        live: {
          mrr: Math.round(mrr), arr: Math.round(mrr * 12), arpu: +arpu.toFixed(2),
          active: active.length, canceling: canceling.length, pastDue: pastDue.length,
          totalSubs: subs.length,
        },
        today: winData('today', T.today),
        d7: winData('d7', T.d7),
        d30: winData('d30', T.d30),
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
const server = http.createServer((req, res) => {
  // Protection par mot de passe (si COCKPIT_PASSWORD défini). User = "creatikk".
  if (COCKPIT_PASSWORD) {
    const expected = 'Basic ' + Buffer.from('creatikk:' + COCKPIT_PASSWORD).toString('base64');
    if ((req.headers.authorization || '') !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Cockpit Creatikk"' });
      res.end('Accès protégé'); return;
    }
  }
  if (req.url.startsWith('/api/data')) {
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
    res.writeHead(200, { 'Content-Type': ct + '; charset=utf-8' });
    res.end(buf);
  });
});
server.listen(PORT, '0.0.0.0', () => console.log('Cockpit sur http://0.0.0.0:' + PORT, '| clé:', STRIPE_KEY ? 'OK' : 'MANQUANTE'));
