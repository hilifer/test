import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { config, aiEnabled } from './config.js';
import { ensureConversation, insertLead, setLeadStatus } from './db.js';
import { chat } from './agent.js';
import { handleMcp } from './mcp.js';
import { scoreLead } from '../../shared/sales-engine.js';
import { alertLead } from './alerts.js';
import { leadsPage, conversationsPage, conversationPage, leadsCsv, LEAD_STATUS } from './admin.js';
import { ensureBootstrapAdmin, verifyLogin, createSession, sessionUser, endSession, permissionFor, can, runAs } from './auth.js';
import { loginPage, forbiddenPage, mountStaffAdmin } from './admin-staff.js';
import { mountContentAdmin } from './content/admin-content.js';
import { startScheduler } from './content/scheduler.js';
import { mountOpsAdmin } from './ops/admin-ops.js';
import { mountPortal } from './ops/portal.js';
import { mountCatalogAdmin } from './catalog/admin-catalog.js';
import { mountShop } from './shop/storefront.js';
import { startShopJobs } from './shop/checkout.js';
import { mountShopAdmin } from './shop/admin-shop.js';
import { mediaDir } from './catalog/store.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startErpSync } from './ops/erp/index.js';

const app = new Hono();

// --- CORS (only needed if the static site and API live on different origins) ---
app.use('/api/*', async (c, next) => {
  const origin = c.req.header('origin');
  if (origin && config.allowedOrigins.includes(origin)) {
    c.header('access-control-allow-origin', origin);
    c.header('vary', 'origin');
    c.header('access-control-allow-headers', 'content-type');
    c.header('access-control-allow-methods', 'POST, GET, OPTIONS');
  }
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
});

// --- simple per-IP rate limit for public endpoints ---
const hits = new Map();
// Client IP: only the entries our own proxies appended are trusted. Caddy appends the real client IP as the
// LAST X-Forwarded-For entry, so with TRUSTED_PROXY_HOPS=1 (default) anything a client forges in front is ignored.
const ipOf = (c) => {
  const sock = c.env?.incoming?.socket?.remoteAddress || 'unknown';
  if (config.trustedProxyHops < 1) return sock;
  const xff = (c.req.header('x-forwarded-for') || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff[xff.length - config.trustedProxyHops] || sock;
};
const limit = async (c, next) => {
  const ip = ipOf(c);
  const t = Date.now();
  const arr = (hits.get(ip) || []).filter((x) => t - x < 60000);
  if (arr.length >= config.rateLimitPerMin) return c.json({ error: 'rate_limited', message: 'Too many messages. Please wait a minute.' }, 429);
  arr.push(t);
  hits.set(ip, arr);
  await next();
};
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (!v.some((x) => t - x < 60000)) hits.delete(k); }, 120000).unref();

app.get('/api/health', (c) => c.json({ ok: true, site: config.site, mode: aiEnabled() ? 'ai' : 'rules' }));

app.post('/api/chat', limit, async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!b.message || typeof b.message !== 'string') return c.json({ error: 'message_required' }, 400);
  const convId = ensureConversation(b.sessionId, { page: String(b.page || '').slice(0, 200), lang: b.lang, ip: ipOf(c) });
  const res = await chat({ convId, message: b.message, page: b.page });
  return c.json({ sessionId: convId, ...res });
});

// Contact form, quote form, calculator report request, chat lead card
app.post('/api/leads', limit, async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (b.website) return c.json({ ok: true }); // honeypot
  if (!b.email && !b.whatsapp && !b.phone) return c.json({ error: 'contact_required', message: 'Please enter an email or WhatsApp number.' }, 400);
  if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return c.json({ error: 'invalid_email', message: 'Please check the email address.' }, 400);
  if (!b.consent) return c.json({ error: 'consent_required', message: 'Please agree to be contacted.' }, 400);
  const clean = Object.fromEntries(['name', 'company', 'email', 'phone', 'whatsapp', 'country', 'buyer_type', 'needs', 'product_id', 'quantity', 'timeline', 'source'].map((k) => [k, String(b[k] ?? '').slice(0, 2000)]));
  const s = scoreLead({ ...clean, lines: Array.isArray(b.extra?.lines) ? b.extra.lines.length : 0 });
  const lead = { ...clean, ...s, consent: true, conv_id: b.sessionId || '', extra: typeof b.extra === 'object' ? b.extra : {} };
  insertLead(lead);
  alertLead(lead).catch(() => {});
  return c.json({ ok: true });
});

// MCP for external AI agents
app.post('/mcp', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  const res = await handleMcp(body);
  if (!res) return c.body(null, 202);
  return c.json(res);
});
app.get('/mcp', (c) => c.text('MCP endpoint: POST JSON-RPC 2.0 (Streamable HTTP, JSON responses).', 405));

// Product images uploaded in the admin (public, immutable file names)
app.get('/media/:file', (c) => {
  const f = c.req.param('file');
  const m = f.match(/^[a-f0-9]{24}\.(jpg|png|webp)$/);
  const path = m && join(mediaDir(), f);
  if (!path || !existsSync(path)) return c.text('Not found', 404);
  c.header('content-type', { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[m[1]]);
  c.header('cache-control', 'public, max-age=31536000, immutable');
  c.header('x-content-type-options', 'nosniff');
  return c.body(readFileSync(path));
});

// Online shop: cart, checkout, payments, customer accounts
// (mounted below, after the same-origin guard is defined)

// Customer self-service portal (public, token links)
mountPortal(app);

// Admin
// CSRF: browsers re-send Basic-auth credentials on cross-site form posts, so admin writes must come
// from our own origin. (Requests without an Origin header — curl, scripts — are not browser-forged.)
const sameOrigin = async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('origin');
    const host = c.req.header('x-forwarded-host') || c.req.header('host');
    let ok = !origin;
    try { ok ||= new URL(origin).host === host || new URL(origin).origin === config.publicBaseUrl; } catch { ok = false; }
    if (!ok) return c.text('Cross-site request refused.', 403);
  }
  await next();
};
app.use('/admin/*', sameOrigin);
app.use('/shop/*', sameOrigin); // customer forms (cart, checkout, account)
app.use('/api/shop/*', sameOrigin);
app.use('/admin', sameOrigin);
// Staff login (sessions) — Basic auth is also accepted for scripts, with the same users and lockout.
ensureBootstrapAdmin();
const SESSION_COOKIE = 'yr_staff';
app.get('/admin/login', (c) => c.html(loginPage({ next: c.req.query('next') || '/admin' })));
app.post('/admin/login', async (c) => {
  const f = await c.req.parseBody();
  const next = /^\/admin(\/|$)/.test(String(f.next || '')) ? String(f.next) : '/admin';
  const r = verifyLogin(String(f.username || ''), String(f.password || ''), ipOf(c));
  if (r.error) return c.html(loginPage({ next, error: r.error, username: String(f.username || '') }), r.lockedMs ? 429 : 401);
  setCookie(c, SESSION_COOKIE, createSession(r.user, ipOf(c)), { httpOnly: true, sameSite: 'Lax', secure: config.publicBaseUrl.startsWith('https://'), path: '/admin' });
  return c.redirect(next);
});
app.post('/admin/logout', (c) => { endSession(getCookie(c, SESSION_COOKIE)); deleteCookie(c, SESSION_COOKIE, { path: '/admin' }); return c.redirect('/admin/login'); });
const staffGate = async (c, next) => {
  if (c.req.path === '/admin/login') return next();
  let user = sessionUser(getCookie(c, SESSION_COOKIE));
  const basic = c.req.header('authorization');
  if (!user && basic?.startsWith('Basic ')) {
    const [u, ...pw] = Buffer.from(basic.slice(6), 'base64').toString().split(':');
    const r = verifyLogin(u, pw.join(':'), ipOf(c));
    if (r.user) user = r.user;
    else if (r.lockedMs) return c.text(r.error, 429);
  }
  if (!user) return c.html(loginPage({ next: c.req.method === 'GET' ? c.req.path : '/admin' }), 401);
  if (!can(user, permissionFor(c.req.path, c.req.method))) return c.html(forbiddenPage(user), 403);
  c.set('user', user);
  return runAs(user, () => next());
};
app.use('/admin/*', staffGate);
app.use('/admin', staffGate);
mountStaffAdmin(app);
app.get('/admin', (c) => c.html(leadsPage()));
app.get('/admin/conversations', (c) => c.html(conversationsPage()));
app.get('/admin/conv/:id', (c) => c.html(conversationPage(c.req.param('id'))));
app.get('/admin/leads.csv', (c) => { c.header('content-type', 'text/csv; charset=utf-8'); c.header('content-disposition', `attachment; filename="leads-${config.site}.csv"`); return c.body(leadsCsv()); });
mountContentAdmin(app);
mountOpsAdmin(app);
mountCatalogAdmin(app);
mountShop(app, { ipOf });
mountShopAdmin(app);
app.post('/admin/lead/:id/status', async (c) => {
  const f = await c.req.parseBody();
  const status = String(f.status || '');
  if (!LEAD_STATUS[status]) return c.text('invalid status', 400);
  setLeadStatus(c.req.param('id'), status);
  return c.redirect('/admin');
});

startScheduler();
startErpSync();
startShopJobs();
serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`[${config.site}] sales server on :${config.port} — mode: ${aiEnabled() ? `AI (${config.llm.provider}/${config.llm.model})` : 'rules (no LLM key)'}`);
});
