// API del panel (/panel): una sola interfaz para el dueño de un portal (todos sus locales)
// y para el encargado de un local (solo el suyo). Todo se filtra por los locales permitidos.
module.exports = function mountPanelApi(app, ctx) {
  const { db, whoIs, getSettings, setSettings, computeStats, baseUrl, clients, slugify, crypto, needLogin, DEFAULT_SETTINGS } = ctx;

  // ---------- Esquema: comentarios resueltos y consultas de IA ----------
  if (!db.prepare('PRAGMA table_info(events)').all().some((c) => c.name === 'resolved')) {
    db.exec('ALTER TABLE events ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS ai_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, venue_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    period TEXT, result TEXT)`);

  // ---------- Logos de los locales (se guardan en el volumen de datos) ----------
  const fs = require('fs'), path = require('path');
  const LOGO_DIR = path.resolve(ctx.DATA_DIR, 'logos');
  fs.mkdirSync(LOGO_DIR, { recursive: true });
  const LOGO_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
  function sniff(buf) {
    if (buf.length > 8 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'png';
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    return null;
  }
  function setKey(venueId, k, v) {
    if (v == null) db.prepare('DELETE FROM venue_settings WHERE venue_id = ? AND key = ?').run(venueId, k);
    else db.prepare('INSERT INTO venue_settings (venue_id, key, value) VALUES (?, ?, ?) ON CONFLICT(venue_id, key) DO UPDATE SET value = excluded.value').run(venueId, k, String(v));
  }
  function logoUrl(venue) {
    const s = getSettings(venue.id);
    return s.logo_file ? `/logo/${encodeURIComponent(venue.slug)}?v=${s.logo_ver || 1}` : null;
  }
  const removeLogoFiles = (id) => { for (const ext of Object.keys(LOGO_TYPES)) { const f = path.join(LOGO_DIR, `${id}.${ext}`); if (fs.existsSync(f)) fs.unlinkSync(f); } };

  const AI_MONTHLY_LIMIT = Number(process.env.AI_MONTHLY_LIMIT || 30);
  const AI_MODEL = process.env.AI_MODEL || 'claude-sonnet-4-5';

  // ---------- Acceso ----------
  function allowedVenues(who) {
    if (who.kind === 'venue') return db.prepare('SELECT id, name, slug, login, active FROM venues WHERE id = ?').all(who.venueId);
    return db.prepare('SELECT id, name, slug, login, active FROM venues WHERE account_id = ? ORDER BY active DESC, name').all(who.accountId);
  }
  function requirePanel(req, res, next) {
    const who = whoIs(req);
    if (!who) return needLogin(req, res);
    req.who = who;
    req.venues = allowedVenues(who);
    req.venueIds = new Set(req.venues.map((v) => v.id));
    next();
  }
  // Locales sobre los que actúa la petición: ?venue=<id> o todos los permitidos
  function scopeVenues(req) {
    const v = req.query.venue ?? req.body?.venue_id;
    if (v && v !== 'all') {
      const id = Number(v);
      if (!req.venueIds.has(id)) return null;
      return [id];
    }
    return req.venues.filter((x) => x.active).map((x) => x.id);
  }
  const canVenue = (req, id) => req.venueIds.has(Number(id));

  // ---------- Fechas ----------
  const pad = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  // Devuelve [desde, hasta) del periodo actual y del anterior de la misma duración
  function periodRange(q) {
    const now = new Date();
    let from, to = new Date(now.getTime() + 60000);
    switch (q.period) {
      case '7d': from = new Date(now.getTime() - 7 * 864e5); break;
      case 'today': from = new Date(now); from.setUTCHours(0, 0, 0, 0); break;
      case 'month': from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); break;
      case 'prev_month':
        from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
        to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        break;
      case 'all': from = new Date(Date.UTC(2020, 0, 1)); break;
      case '30d': default: from = new Date(now.getTime() - 30 * 864e5);
    }
    if (q.from) from = new Date(q.from + 'T00:00:00Z');
    if (q.to) to = new Date(new Date(q.to + 'T00:00:00Z').getTime() + 864e5);
    const len = to - from;
    return { from: pad(from), to: pad(to), prevFrom: pad(new Date(from - len)), prevTo: pad(from), days: Math.max(1, Math.round(len / 864e5)) };
  }

  // ---------- Agregados ----------
  function venueTotals(venueId, from, to) {
    const st = computeStats(venueId, from, to);
    const ratings = st.reduce((a, x) => a + x.ratings, 0);
    const starSum = st.reduce((a, x) => a + [1, 2, 3, 4, 5].reduce((b, n) => b + n * x.stars[n], 0), 0);
    const stars = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    st.forEach((x) => [1, 2, 3, 4, 5].forEach((n) => (stars[n] += x.stars[n])));
    const pending = db.prepare(`SELECT COUNT(*) AS n FROM events e JOIN waiters w ON w.id = e.waiter_id
      WHERE w.venue_id = ? AND e.type = 'rating' AND e.stars <= 3 AND e.comment IS NOT NULL AND e.comment <> '' AND e.resolved = 0
      AND e.created_at >= ? AND e.created_at < ?`).get(venueId, from, to).n;
    return {
      scans: st.reduce((a, x) => a + x.scans, 0),
      ratings,
      avg: ratings ? Math.round((starSum / ratings) * 100) / 100 : null,
      google_clicks: st.reduce((a, x) => a + x.google_clicks, 0),
      bonus: Math.round(st.reduce((a, x) => a + x.bonus, 0) * 100) / 100,
      stars,
      waiters: st.filter((x) => x.active).length,
      pending_comments: pending,
      ranking: st,
    };
  }
  const goalsOf = (s) => ({ goal_avg: Number(s.goal_avg) || null, goal_ratings: Number(s.goal_ratings) || null });

  function monthlySeries(venueIds, months = 6) {
    if (!venueIds.length) return [];
    const ph = venueIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT strftime('%Y-%m', e.created_at) AS m, COUNT(*) AS n, AVG(e.stars) AS avg
      FROM events e JOIN waiters w ON w.id = e.waiter_id
      WHERE w.venue_id IN (${ph}) AND e.type = 'rating' AND e.created_at >= date('now', 'start of month', '-${months - 1} months')
      GROUP BY m ORDER BY m`).all(...venueIds);
    const out = [];
    const d = new Date();
    for (let i = months - 1; i >= 0; i--) {
      const k = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7);
      const r = rows.find((x) => x.m === k);
      out.push({ month: k, n: r ? r.n : 0, avg: r && r.avg ? Math.round(r.avg * 100) / 100 : null });
    }
    return out;
  }

  // ---------- Rutas ----------
  app.get('/panel', (req, res, next) => {
    if (!whoIs(req)) return needLogin(req, res);
    res.sendFile(require('path').join(__dirname, 'public', 'panel.html'));
  });
  app.use('/api/panel', requirePanel);

  app.get('/api/panel/me', (req, res) => {
    const who = req.who;
    let name = '', isSuper = false;
    if (who.kind === 'account') {
      const a = db.prepare('SELECT name, is_super FROM accounts WHERE id = ?').get(who.accountId);
      name = a.name; isSuper = !!a.is_super;
    } else name = req.venues[0]?.name || '';
    res.json({ kind: who.kind, name, is_super: isSuper, venues: req.venues.map((v) => ({ ...v, active: !!v.active, logo: logoUrl(v) })),
      base: baseUrl(req), ai_enabled: !!process.env.ANTHROPIC_API_KEY });
  });

  // Inicio: una tarjeta por local con comparación con el periodo anterior
  app.get('/api/panel/summary', (req, res) => {
    const p = periodRange(req.query);
    const cards = req.venues.filter((v) => v.active || req.query.inactive).map((v) => {
      const cur = venueTotals(v.id, p.from, p.to);
      const prev = venueTotals(v.id, p.prevFrom, p.prevTo);
      const s = getSettings(v.id);
      delete cur.ranking; delete prev.ranking;
      return { id: v.id, name: v.name, slug: v.slug, logo: logoUrl(v), cur, prev: { ratings: prev.ratings, avg: prev.avg }, ...goalsOf(s), has_google: !!s.google_review_url };
    });
    res.json({ period: p, cards });
  });

  // Ficha de un local
  app.get('/api/panel/venue/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!canVenue(req, id)) return res.sendStatus(404);
    const p = periodRange(req.query);
    const v = req.venues.find((x) => x.id === id);
    const cur = venueTotals(id, p.from, p.to);
    const prev = venueTotals(id, p.prevFrom, p.prevTo);
    const all = venueTotals(id, '2000-01-01 00:00:00', pad(new Date(Date.now() + 60000)));
    const s = getSettings(id);
    res.json({ venue: { ...v, active: !!v.active, logo: logoUrl(v) }, period: p, cur, prev: { ratings: prev.ratings, avg: prev.avg, google_clicks: prev.google_clicks },
      global: { ratings: all.ratings, avg: all.avg }, ...goalsOf(s), monthly: monthlySeries([id]), settings: s });
  });

  // Camareros (de un local o de todos)
  app.get('/api/panel/waiters', (req, res) => {
    const ids = scopeVenues(req);
    if (!ids) return res.sendStatus(404);
    const p = periodRange(req.query);
    const rows = [];
    for (const id of ids) {
      const v = req.venues.find((x) => x.id === id);
      for (const w of computeStats(id, p.from, p.to)) rows.push({ ...w, venue_id: id, venue: v.name });
    }
    res.json({ period: p, waiters: rows, base: baseUrl(req) });
  });
  app.post('/api/panel/waiters', (req, res) => {
    const venueId = Number(req.body?.venue_id);
    if (!canVenue(req, venueId)) return res.status(403).json({ error: 'Sin permiso sobre ese local' });
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'Nombre obligatorio' });
    let slug = slugify(name), i = 1;
    while (db.prepare('SELECT 1 FROM waiters WHERE slug = ?').get(slug)) slug = `${slugify(name)}-${++i}`;
    const token = crypto.randomBytes(12).toString('hex');
    const r = db.prepare('INSERT INTO waiters (name, slug, token, venue_id) VALUES (?, ?, ?, ?)').run(name, slug, token, venueId);
    ctx.broadcast({ type: 'refresh' }, venueId);
    res.json({ id: Number(r.lastInsertRowid), name, slug, token, venue_id: venueId });
  });
  app.patch('/api/panel/waiters/:id', (req, res) => {
    const w = db.prepare('SELECT id, venue_id FROM waiters WHERE id = ?').get(Number(req.params.id));
    if (!w || !canVenue(req, w.venue_id)) return res.sendStatus(404);
    const { name, active } = req.body || {};
    if (name !== undefined && String(name).trim()) db.prepare('UPDATE waiters SET name = ? WHERE id = ?').run(String(name).trim().slice(0, 60), w.id);
    if (active !== undefined) db.prepare('UPDATE waiters SET active = ? WHERE id = ?').run(active ? 1 : 0, w.id);
    ctx.broadcast({ type: 'refresh' }, w.venue_id);
    res.json({ ok: true });
  });

  // Valoraciones con filtros
  function ratingsWhere(req, ids) {
    const p = periodRange(req.query);
    const where = [`w.venue_id IN (${ids.map(() => '?').join(',')})`, "e.type = 'rating'", 'e.created_at >= ?', 'e.created_at < ?'];
    const args = [...ids, p.from, p.to];
    if (req.query.waiter) { where.push('w.id = ?'); args.push(Number(req.query.waiter)); }
    if (req.query.stars) {
      const st = String(req.query.stars).split(',').map(Number).filter((n) => n >= 1 && n <= 5);
      if (st.length) { where.push(`e.stars IN (${st.map(() => '?').join(',')})`); args.push(...st); }
    }
    if (req.query.status === 'comments') where.push("e.comment IS NOT NULL AND e.comment <> ''");
    if (req.query.status === 'pending') where.push("e.stars <= 3 AND e.comment IS NOT NULL AND e.comment <> '' AND e.resolved = 0");
    if (req.query.status === 'resolved') where.push('e.resolved = 1');
    if (req.query.q) { where.push('(e.comment LIKE ? OR w.name LIKE ?)'); args.push(`%${req.query.q}%`, `%${req.query.q}%`); }
    return { p, sql: where.join(' AND '), args };
  }
  app.get('/api/panel/ratings', (req, res) => {
    const ids = scopeVenues(req);
    if (!ids) return res.sendStatus(404);
    if (!ids.length) return res.json({ items: [], total: 0, counts: {} });
    const { p, sql, args } = ratingsWhere(req, ids);
    const page = Math.max(1, Number(req.query.page) || 1), per = Math.min(100, Number(req.query.per) || 25);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM events e JOIN waiters w ON w.id = e.waiter_id WHERE ${sql}`).get(...args).n;
    const items = db.prepare(`SELECT e.id, e.stars, e.comment, e.created_at, e.resolved, w.id AS waiter_id, w.name AS waiter, v.name AS venue, v.id AS venue_id
      FROM events e JOIN waiters w ON w.id = e.waiter_id JOIN venues v ON v.id = w.venue_id
      WHERE ${sql} ORDER BY e.id DESC LIMIT ? OFFSET ?`).all(...args, per, (page - 1) * per);
    // Contadores para las pestañas (mismo filtro de local y fechas)
    const ph = ids.map(() => '?').join(',');
    const base = `FROM events e JOIN waiters w ON w.id = e.waiter_id WHERE w.venue_id IN (${ph}) AND e.type = 'rating' AND e.created_at >= ? AND e.created_at < ?`;
    const bargs = [...ids, p.from, p.to];
    const counts = {
      all: db.prepare(`SELECT COUNT(*) AS n ${base}`).get(...bargs).n,
      comments: db.prepare(`SELECT COUNT(*) AS n ${base} AND e.comment IS NOT NULL AND e.comment <> ''`).get(...bargs).n,
      pending: db.prepare(`SELECT COUNT(*) AS n ${base} AND e.stars <= 3 AND e.comment IS NOT NULL AND e.comment <> '' AND e.resolved = 0`).get(...bargs).n,
      resolved: db.prepare(`SELECT COUNT(*) AS n ${base} AND e.resolved = 1`).get(...bargs).n,
    };
    res.json({ period: p, items, total, page, per, counts });
  });
  app.post('/api/panel/ratings/:id/resolve', (req, res) => {
    const e = db.prepare('SELECT e.id, w.venue_id FROM events e JOIN waiters w ON w.id = e.waiter_id WHERE e.id = ?').get(Number(req.params.id));
    if (!e || !canVenue(req, e.venue_id)) return res.sendStatus(404);
    db.prepare('UPDATE events SET resolved = ? WHERE id = ?').run(req.body?.resolved === false ? 0 : 1, e.id);
    res.json({ ok: true });
  });
  app.get('/api/panel/ratings.csv', (req, res) => {
    const ids = scopeVenues(req);
    if (!ids) return res.sendStatus(404);
    const { sql, args } = ratingsWhere(req, ids.length ? ids : [0]);
    const rows = db.prepare(`SELECT e.created_at, v.name AS venue, w.name AS waiter, e.stars, e.comment, e.resolved
      FROM events e JOIN waiters w ON w.id = e.waiter_id JOIN venues v ON v.id = w.venue_id WHERE ${sql} ORDER BY e.id DESC`).all(...args);
    const q = (s) => '"' + String(s ?? '').replace(/"/g, '""') + '"';
    const csv = ['Fecha;Local;Camarero;Estrellas;Comentario;Resuelto']
      .concat(rows.map((r) => [r.created_at, q(r.venue), q(r.waiter), r.stars, q(r.comment), r.resolved ? 'Sí' : 'No'].join(';'))).join('\n');
    res.type('text/csv; charset=utf-8').attachment('topreview-valoraciones.csv').send('﻿' + csv);
  });

  // Resumen automático (sin IA): temas frecuentes en comentarios y reparto por camarero
  const STOP = new Set('de la que el en y a los se del las un por con no una su para es al lo como más pero sus le ya o fue este ha sí porque esta son entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mí antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros mi mis tú te ti tu tus ellas nosotras vosotros vosotras os mío mía míos mías tuyo tuya era fuimos estaba estuvo han he hemos muy bien mal'.split(' '));
  function quickSummary(ids, p) {
    const ph = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT e.stars, e.comment, w.name AS waiter FROM events e JOIN waiters w ON w.id = e.waiter_id
      WHERE w.venue_id IN (${ph}) AND e.type = 'rating' AND e.created_at >= ? AND e.created_at < ?`).all(...ids, p.from, p.to);
    const words = new Map();
    for (const r of rows) {
      if (!r.comment) continue;
      for (const raw of r.comment.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-zñ]+/)) {
        if (raw.length < 4 || STOP.has(raw)) continue;
        const k = words.get(raw) || { word: raw, n: 0, low: 0 };
        k.n++; if (r.stars <= 3) k.low++;
        words.set(raw, k);
      }
    }
    const byWaiter = new Map();
    for (const r of rows) {
      const k = byWaiter.get(r.waiter) || { waiter: r.waiter, n: 0, low: 0, sum: 0 };
      k.n++; k.sum += r.stars; if (r.stars <= 3) k.low++;
      byWaiter.set(r.waiter, k);
    }
    return {
      ratings: rows.length,
      comments: rows.filter((r) => r.comment).length,
      low: rows.filter((r) => r.stars <= 3).length,
      topics: [...words.values()].sort((a, b) => b.n - a.n).slice(0, 12),
      waiters: [...byWaiter.values()].map((x) => ({ ...x, avg: Math.round((x.sum / x.n) * 100) / 100 })).sort((a, b) => b.low - a.low),
    };
  }
  app.get('/api/panel/insights', (req, res) => {
    const ids = scopeVenues(req);
    if (!ids) return res.sendStatus(404);
    const p = periodRange(req.query);
    const summary = ids.length ? quickSummary(ids, p) : null;
    const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const used = ids.length ? db.prepare(`SELECT COUNT(*) AS n FROM ai_runs WHERE venue_id IN (${ids.map(() => '?').join(',')}) AND created_at >= ?`).get(...ids, pad(monthStart)).n : 0;
    const last = ids.length === 1 ? db.prepare('SELECT created_at, period, result FROM ai_runs WHERE venue_id = ? ORDER BY id DESC LIMIT 1').get(ids[0]) : null;
    res.json({ summary, ai_enabled: !!process.env.ANTHROPIC_API_KEY, ai_used: used, ai_limit: AI_MONTHLY_LIMIT, last });
  });

  // Análisis con IA (requiere ANTHROPIC_API_KEY). Solo un local por análisis.
  app.post('/api/panel/ai-analysis', async (req, res) => {
    const id = Number(req.body?.venue_id);
    if (!canVenue(req, id)) return res.status(403).json({ error: 'Sin permiso sobre ese local' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'El análisis con IA no está activado en este servidor.' });
    const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const used = db.prepare('SELECT COUNT(*) AS n FROM ai_runs WHERE venue_id = ? AND created_at >= ?').get(id, pad(monthStart)).n;
    if (used >= AI_MONTHLY_LIMIT) return res.status(429).json({ error: `Has usado los ${AI_MONTHLY_LIMIT} análisis de este mes.` });
    const p = periodRange(req.body || {});
    const v = req.venues.find((x) => x.id === id);
    const rows = db.prepare(`SELECT e.created_at, e.stars, e.comment, w.name AS waiter FROM events e JOIN waiters w ON w.id = e.waiter_id
      WHERE w.venue_id = ? AND e.type = 'rating' AND e.created_at >= ? AND e.created_at < ? ORDER BY e.id DESC LIMIT 600`).all(id, p.from, p.to);
    if (!rows.length) return res.status(400).json({ error: 'No hay valoraciones en este periodo.' });
    const lines = rows.map((r) => `${r.created_at.slice(0, 10)} | ${r.waiter} | ${r.stars}★${r.comment ? ' | ' + r.comment.replace(/\s+/g, ' ').slice(0, 400) : ''}`).join('\n');
    const prompt = `Eres analista de experiencia de cliente en hostelería. Abajo tienes las valoraciones internas (1-5 estrellas, con comentario opcional) que los clientes del local "${v.name}" han dejado a sus camareros entre ${p.from.slice(0, 10)} y ${p.to.slice(0, 10)}.

Escribe en español, claro y directo, para el dueño del local, con estos apartados:
1. Resumen en 3 frases.
2. Lo que más valoran los clientes.
3. Lo que más se repite en las quejas, con ejemplos breves.
4. Por camarero: quién destaca y quién necesita apoyo, con datos.
5. Tres acciones concretas para la próxima semana.

No inventes datos que no estén en las valoraciones.

Valoraciones (fecha | camarero | estrellas | comentario):
${lines}`;
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: AI_MODEL, max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }),
      });
      const j = await r.json();
      if (!r.ok) return res.status(502).json({ error: 'La IA no ha respondido: ' + (j?.error?.message || r.status) });
      const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      db.prepare('INSERT INTO ai_runs (venue_id, period, result) VALUES (?, ?, ?)').run(id, `${p.from.slice(0, 10)} → ${p.to.slice(0, 10)}`, text);
      res.json({ result: text, used: used + 1, limit: AI_MONTHLY_LIMIT });
    } catch (err) {
      res.status(502).json({ error: 'No se pudo conectar con la IA.' });
    }
  });

  // Objetivos y bonus
  app.get('/api/panel/rewards', (req, res) => {
    const id = Number(req.query.venue);
    if (!canVenue(req, id)) return res.sendStatus(404);
    const p = periodRange(req.query);
    const t = venueTotals(id, p.from, p.to);
    const s = getSettings(id);
    res.json({ period: p, settings: s, ...goalsOf(s), totals: { ratings: t.ratings, avg: t.avg, bonus: t.bonus, stars: t.stars }, waiters: t.ranking });
  });
  app.put('/api/panel/venue/:id/settings', (req, res) => {
    const id = Number(req.params.id);
    if (!canVenue(req, id)) return res.sendStatus(404);
    const body = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (req.body?.[k] !== undefined) body[k] = req.body[k];
    setSettings(id, body);
    ctx.broadcast({ type: 'refresh' }, id);
    res.json(getSettings(id));
  });

  // Logo del local: subir (PNG, JPG o WEBP, máx. 3 MB), borrar y servir
  const express = require('express');
  app.post('/api/panel/venue/:id/logo', express.raw({ type: () => true, limit: '3mb' }), (req, res) => {
    const id = Number(req.params.id);
    if (!canVenue(req, id)) return res.sendStatus(404);
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    const ext = buf && sniff(buf);
    if (!ext) return res.status(400).json({ error: 'El logo tiene que ser una imagen PNG, JPG o WEBP.' });
    removeLogoFiles(id);
    fs.writeFileSync(path.join(LOGO_DIR, `${id}.${ext}`), buf);
    setKey(id, 'logo_file', `${id}.${ext}`);
    setKey(id, 'logo_ver', Date.now());
    const v = req.venues.find((x) => x.id === id);
    res.json({ logo: logoUrl(v) });
  });
  app.delete('/api/panel/venue/:id/logo', (req, res) => {
    const id = Number(req.params.id);
    if (!canVenue(req, id)) return res.sendStatus(404);
    removeLogoFiles(id);
    setKey(id, 'logo_file', null);
    setKey(id, 'logo_ver', null);
    res.json({ ok: true });
  });
  app.get('/logo/:slug', (req, res) => {
    const v = db.prepare('SELECT id FROM venues WHERE slug = ?').get(req.params.slug);
    const file = v && getSettings(v.id).logo_file;
    const full = file && path.join(LOGO_DIR, path.basename(file));
    if (!full || !fs.existsSync(full)) return res.sendStatus(404);
    res.set({ 'Content-Type': LOGO_TYPES[path.extname(full).slice(1)], 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    res.sendFile(full);
  });

  // Tiempo real para todos los locales permitidos
  app.get('/api/panel/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const c = { res, venueIds: req.venueIds };
    clients.add(c);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(c); });
  });
};
