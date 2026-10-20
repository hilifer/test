// Starts the real sales server (server/src/index.js) as a child process on a free port with an
// isolated database, for black-box HTTP tests.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { join } from 'node:path';
import { cpSync, mkdirSync } from 'node:fs';
import { ROOT, tempDir } from './env.mjs';

export const ADMIN = { user: 'admin', pass: 'test-pass' };
const AUTH = 'Basic ' + Buffer.from(`${ADMIN.user}:${ADMIN.pass}`).toString('base64');

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

export async function startServer({ site = 'led', env = {} } = {}) {
  const dir = tempDir('yr-api-');
  const newsDir = join(dir, 'news');
  cpSync(join(ROOT, `sites/${site}/src/content/news`), newsDir, { recursive: true });
  mkdirSync(join(dir, 'site'), { recursive: true });
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const childEnv = {
    ...process.env,
    SITE: site, PORT: String(port), DB_PATH: join(dir, 'db.sqlite'), NEWS_DIR: newsDir, SITE_DIR: join(dir, 'site'),
    PUBLIC_BASE_URL: url, ADMIN_USER: ADMIN.user, ADMIN_PASSWORD: ADMIN.pass, ERP_MODE: 'mock', RATE_LIMIT_PER_MIN: '1000',
    BUILD_CMD: `node -e "require('fs').mkdirSync(process.env.OUT_DIR,{recursive:true})"`,
    LLM_PROVIDER: '', LLM_API_KEY: '', LLM_MODEL: '', WECOM_WEBHOOK_URL: '', FEISHU_WEBHOOK_URL: '', ALERT_WEBHOOK_URL: '',
    CONTENT_ENABLED: 'false', GEO_ENABLED: 'false', INDEXNOW_KEY: '',
    ...env,
  };
  const child = spawn(process.execPath, [join(ROOT, 'server/src/index.js')], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    try { const r = await fetch(`${url}/api/health`); if (r.ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) { child.kill(); throw new Error(`server did not start:\n${log}`); }
    await new Promise((r) => setTimeout(r, 100));
  }

  const api = {
    url, dir, port, log: () => log,
    stop: () => new Promise((r) => { if (child.exitCode !== null) return r(); child.once('exit', r); child.kill(); }),
    get: (path, opts = {}) => fetch(url + path, { redirect: 'manual', ...opts }),
    json: (path, body, opts = {}) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(opts.headers || {}) }, body: JSON.stringify(body), redirect: 'manual' }),
    admin: (path, opts = {}) => fetch(url + path, { redirect: 'manual', ...opts, headers: { authorization: AUTH, ...(opts.headers || {}) } }),
    /** POST a form as the admin; returns the response (redirects are not followed). */
    form: (path, data, { auth = true } = {}) => fetch(url + path, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(auth ? { authorization: AUTH } : {}) },
      body: new URLSearchParams(data).toString(),
    }),
  };
  return api;
}

/** Decode the flash message of a redirect like /admin/x?m=… or ?e=… */
export function flash(res) {
  const loc = res.headers.get('location') || '';
  const u = new URL(loc, 'http://x');
  return { location: loc, path: u.pathname, ok: u.searchParams.get('m'), err: u.searchParams.get('e') };
}

/** Poll until fn() returns a truthy value (background jobs finish at their own pace on slow CI runners). */
export async function waitFor(fn, { timeout = 10000, every = 50 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, every));
  }
}
