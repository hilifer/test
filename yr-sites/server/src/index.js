import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { config, aiEnabled } from './config.js';
import { ensureConversation, insertLead, setLeadStatus } from './db.js';
import { chat } from './agent.js';
import { handleMcp } from './mcp.js';
import { scoreLead } from '../../shared/sales-engine.js';
import { alertLead } from './alerts.js';
import { conversationsPage, conversationPage, leadsCsv, LEAD_STATUS, messageHtml } from './admin.js';
import * as Live from './livechat.js';
import { currentUser } from './auth.js';
import { ensureBootstrapAdmin, verifyLogin, createSession, sessionUser, endSession, permissionFor, can, runAs, adminLang, setStaffLang } from './auth.js';
import { toEnglish } from './i18n/index.js';
import * as Audit from './audit.js';
import { mountAuditAdmin } from './admin-audit.js';
import { mountTasksAdmin } from './admin-tasks.js';
import { mountCopyAdmin } from './catalog/admin-copy.js';
import { startTasks } from './tasks.js';
import { mountAssetsAdmin } from './assets/admin-assets.js';
import { startAssetJobs } from './assets/store.js';
import { workbench } from './workbench.js';
import { loginPage, forbiddenPage, mountStaffAdmin } from './admin-staff.js';
import { mountContentAdmin } from './content/admin-content.js';
import { startScheduler } from './content/scheduler.js';
import { mountOpsAdmin } from './ops/admin-ops.js';
import { mountPortal } from './ops/portal.js';
import { mountDeals } from './ops/admin-deals.js';
import { mountSystemAdmin } from './ops/admin-system.js';
import { startBackupJob } from './ops/backup.js';
import { mountCatalogAdmin } from './catalog/admin-catalog.js';
import { mountShop } from './shop/storefront.js';
import { startShopJobs } from './shop/checkout.js';
import { mountShopAdmin } from './shop/admin-shop.js';
import { startTrackingJob } from './shop/tracking.js';
import { mountMarketingAdmin } from './shop/admin-marketing.js';
import { startMarketingJobs } from './shop/marketing.js';
import { startAutolistJobs } from './catalog/autolist.js';
import { mediaDir } from './catalog/store.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startErpSync } from './ops/erp/index.js';
import { startJobs } from './jobs.js';
import { mountOpsCenter, healthDetail } from './ops/admin-opscenter.js';
import { recordError } from './ops/errors.js';
import { onLoginAttempt, startOpsWatch } from './ops/security.js';
import { startServiceChecks } from './ops/services.js';
import { onJobFailure } from './jobs.js';
import { mountCrmAdmin } from './sales/admin-crm.js';
import { startCrmJobs, getLead, canSeeLead, listLeadsFor } from './sales/crm.js';

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

app.get('/api/health', (c) => {
  const base = { ok: true, site: config.site, mode: aiEnabled() ? 'ai' : 'rules' };
  // details for the other site's "two sites" page — only with the shared OPS_TOKEN
  const token = process.env.OPS_TOKEN;
  if (c.req.query('detail') && token && c.req.header('x-ops-token') === token) return c.json({ ...base, ...healthDetail() });
  return c.json(base);
});
if (process.env.ERROR_TEST_ROUTE === 'true') app.get('/api/__error', (c) => { throw new Error(`test error ${c.req.query('n') || ''}`.trim()); }); // tests only
app.onError((err, c) => {
  if (err?.getResponse) return err.getResponse(); // HTTPException (e.g. body too large) is not a server error
  console.error('[error]', c.req.method, c.req.path, err);
  try { recordError(err, { method: c.req.method, path: c.req.path }); } catch { /* never fail the error page */ }
  return c.text('Internal Server Error', 500);
});
process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e); try { recordError(e, { source: 'process' }); } catch { /* ignore */ } });
onJobFailure((job, detail) => recordError(new Error(detail || 'failed'), { source: 'job', path: job.id }));

app.post('/api/chat', limit, async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!b.message || typeof b.message !== 'string') return c.json({ error: 'message_required' }, 400);
  const convId = ensureConversation(b.sessionId, { page: String(b.page || '').slice(0, 200), lang: b.lang, ip: ipOf(c) });
  const res = await chat({ convId, message: b.message, page: b.page });
  return c.json({ sessionId: convId, ...res });
});

// The widget polls for staff replies while a person may be handling the chat
app.get('/api/chat/poll', (c) => {
  const id = String(c.req.query('sessionId') || '');
  if (!/^[\w-]{8,64}$/.test(id)) return c.json({ error: 'bad_session' }, 400);
  return c.json(Live.poll(id, c.req.query('after')));
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
app.use('/portal/contract/*', sameOrigin); // e-signature
// Staff login (sessions) — Basic auth is also accepted for scripts, with the same users and lockout.
ensureBootstrapAdmin();
const SESSION_COOKIE = 'yr_staff';
// Admin language: pages are rendered in Chinese and translated to English for staff who chose English.
const LANG_COOKIE = 'yr_admin_lang';
const adminI18n = async (c, next) => {
  await next();
  const lang = adminLang(c.get('user'), getCookie(c, LANG_COOKIE));
  if (lang !== 'en' || !/text\/html/.test(c.res.headers.get('content-type') || '')) return;
  const html = await c.res.text();
  const headers = new Headers(c.res.headers);
  headers.delete('content-length');
  c.res = new Response(toEnglish(html), { status: c.res.status, headers });
};
app.use('/admin/*', adminI18n);
app.use('/admin', adminI18n);
app.post('/admin/lang', async (c) => {
  const f = await c.req.parseBody();
  const lang = f.lang === 'en' ? 'en' : 'zh';
  setCookie(c, LANG_COOKIE, lang, { sameSite: 'Lax', path: '/admin', maxAge: 365 * 864e2 });
  const user = sessionUser(getCookie(c, SESSION_COOKIE));
  if (user) setStaffLang(user.id, lang);
  if (/fetch/.test(c.req.header('x-requested-with') || '')) return c.body(null, 204);
  const ref = c.req.header('referer');
  return c.redirect(ref && new URL(ref).pathname.startsWith('/admin') ? new URL(ref).pathname + new URL(ref).search : '/admin');
});


app.get('/admin/login', (c) => c.html(loginPage({ next: c.req.query('next') || '/admin/home' })));
app.post('/admin/login', async (c) => {
  const f = await c.req.parseBody();
  const next = /^\/admin(\/|$)/.test(String(f.next || '')) ? String(f.next) : '/admin/home';
  const r = verifyLogin(String(f.username || ''), String(f.password || ''), ipOf(c));
  if (!r.lockedMs) onLoginAttempt(String(f.username || ''), ipOf(c), !r.error);
  Audit.record({ username: String(f.username || '').slice(0, 40), roles: r.user?.role || '', path: '/admin/login', action: r.error ? 'login_failed' : 'login', status: r.error ? (r.lockedMs ? 429 : 401) : 302, message: r.error || '', ip: ipOf(c) });
  if (r.error) return c.html(loginPage({ next, error: r.error, username: String(f.username || '') }), r.lockedMs ? 429 : 401);
  setCookie(c, SESSION_COOKIE, createSession(r.user, ipOf(c)), { httpOnly: true, sameSite: 'Lax', secure: config.publicBaseUrl.startsWith('https://'), path: '/admin' });
  return c.redirect(next);
});
app.post('/admin/logout', (c) => { const u = sessionUser(getCookie(c, SESSION_COOKIE)); if (u) Audit.record({ username: u.username, roles: u.role, path: '/admin/logout', action: 'logout', status: 302, ip: ipOf(c) }); endSession(getCookie(c, SESSION_COOKIE)); deleteCookie(c, SESSION_COOKIE, { path: '/admin' }); return c.redirect('/admin/login'); });
const staffGate = async (c, next) => {
  if (c.req.path === '/admin/login' || c.req.path === '/admin/lang') return next();
  let user = sessionUser(getCookie(c, SESSION_COOKIE));
  const basic = c.req.header('authorization');
  if (!user && basic?.startsWith('Basic ')) {
    const [u, ...pw] = Buffer.from(basic.slice(6), 'base64').toString().split(':');
    const r = verifyLogin(u, pw.join(':'), ipOf(c));
    if (r.user) user = r.user;
    else if (r.lockedMs) return c.text(r.error, 429);
  }
  if (!user) return c.html(loginPage({ next: c.req.method === 'GET' ? c.req.path : '/admin' }), 401);
  const write = !['GET', 'HEAD'].includes(c.req.method);
  if (!can(user, permissionFor(c.req.path, c.req.method))) {
    if (write) Audit.record({ username: user.username, roles: user.role, method: c.req.method, path: c.req.path, status: 403, message: '无权限', ip: ipOf(c) });
    return c.html(forbiddenPage(user), 403);
  }
  user.lang = adminLang(user, getCookie(c, LANG_COOKIE)); // effective language for this request
  c.set('user', user);
  if (!write) return runAs(user, () => next());
  // operation log: what was submitted (no secrets) and how it ended (status + the message shown to the user)
  let fields = {};
  if (/form-data|x-www-form-urlencoded/.test(c.req.header('content-type') || '')) fields = await c.req.parseBody({ all: true }).catch(() => ({}));
  await runAs(user, () => next());
  const loc = c.res.headers.get('location') || '';
  const q = loc.includes('?') ? new URLSearchParams(loc.split('?')[1]) : null;
  const message = q?.get('e') ? `e=${q.get('e')}` : q?.get('m') || '';
  try { Audit.record({ username: user.username, roles: user.role, method: c.req.method, path: c.req.path, status: c.res.status, message, fields, ip: ipOf(c) }); } catch (e) { console.error('[audit]', e.message); }
};
app.use('/admin/*', staffGate);
app.use('/admin', staffGate);
mountStaffAdmin(app);
app.get('/admin/conversations', (c) => c.html(conversationsPage()));
app.get('/admin/conv/:id', (c) => c.html(conversationPage(c.req.param('id'), { e: c.req.query('e') })));
app.get('/admin/conv/:id/messages', (c) => { const ms = Live.messagesAfter(c.req.param('id'), c.req.query('after')); return c.json({ html: ms.map(messageHtml).join(''), lastId: ms.at(-1)?.id || Number(c.req.query('after')) || 0 }); });
const convBack = (c, e) => c.redirect(`/admin/conv/${encodeURIComponent(c.req.param('id'))}${e ? `?e=${encodeURIComponent(e)}` : ''}`);
app.post('/admin/conv/:id/reply', async (c) => { const f = await c.req.parseBody(); try { Live.agentReply(c.req.param('id'), currentUser(), f.text); return convBack(c); } catch (e) { return convBack(c, e.message); } });
app.post('/admin/conv/:id/takeover', (c) => { try { Live.takeOver(c.req.param('id'), currentUser()); return convBack(c); } catch (e) { return convBack(c, e.message); } });
app.post('/admin/conv/:id/release', (c) => { Live.release(c.req.param('id')); return convBack(c); });
app.get('/admin/leads.csv', (c) => { c.header('content-type', 'text/csv; charset=utf-8'); c.header('content-disposition', `attachment; filename="leads-${config.site}.csv"`); return c.body(leadsCsv(listLeadsFor(c.get('user'), { scope: 'all', limit: 10000 }))); });
mountContentAdmin(app);
mountCrmAdmin(app); // before the ops routes: /admin/quotes/templates must win over /admin/quotes/:id
mountOpsAdmin(app);
mountCatalogAdmin(app);
mountShop(app, { ipOf });
mountShopAdmin(app);
mountMarketingAdmin(app);
mountDeals(app, { ipOf });
mountSystemAdmin(app);
mountAuditAdmin(app);
mountTasksAdmin(app);
mountOpsCenter(app);
mountCopyAdmin(app);
mountAssetsAdmin(app);
app.get('/admin/home', (c) => c.html(workbench()));
app.post('/admin/lead/:id/status', async (c) => {
  const f = await c.req.parseBody();
  const status = String(f.status || '');
  if (!LEAD_STATUS[status]) return c.text('invalid status', 400);
  const lead = getLead(c.req.param('id'));
  if (!canSeeLead(c.get('user'), lead)) return c.text('Not found', 404);
  setLeadStatus(lead.id, status);
  const ref = c.req.header('referer') || '';
  return c.redirect(/\/admin\/lead\//.test(ref) ? `/admin/lead/${lead.id}?m=${encodeURIComponent('状态已更新')}` : '/admin');
});

startScheduler();
startErpSync();
startShopJobs();
startTrackingJob();
startMarketingJobs();
startAutolistJobs();
startBackupJob();
startAssetJobs();
startTasks();
startCrmJobs();
startServiceChecks();
startOpsWatch();
startJobs();
serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`[${config.site}] sales server on :${config.port} — mode: ${aiEnabled() ? `AI (${config.llm.provider}/${config.llm.model})` : 'rules (no LLM key)'}`);
});
