// Shared helpers for the demo videos: on-screen captions that survive page loads, a title card at the start of each
// video, slow scrolling through a page, and staff sessions (HTTP Basic, so no login screen in every video).
import { test as base, expect } from '@playwright/test';

export const LED = 'http://127.0.0.1:4311';
export const GRID = 'http://127.0.0.1:4312';
export const PW = 'Str0ngPassw0rd';
export const ADMIN = { username: 'admin', password: 'e2e-pass' };

// Caption bar at the bottom of the window; the text is kept in sessionStorage so it is shown again after navigation.
const CAPTION = () => {
  const css = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483647;background:rgba(17,24,39,.9);color:#fff;font:600 18px/1.45 system-ui,"Noto Sans CJK SC","WenQuanYi Micro Hei",sans-serif;padding:10px 18px;border-radius:10px;max-width:88vw;text-align:center;pointer-events:none;box-shadow:0 8px 24px rgba(0,0,0,.35)';
  const show = () => {
    const t = sessionStorage.getItem('demo-cap');
    let d = document.getElementById('demo-cap');
    if (!t) { d?.remove(); return; }
    if (!d) { d = document.createElement('div'); d.id = 'demo-cap'; d.setAttribute('aria-hidden', 'true'); d.style.cssText = css; document.documentElement.appendChild(d); }
    d.textContent = t;
  };
  window.__demoCap = (t) => { sessionStorage.setItem('demo-cap', t || ''); show(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
};
const TITLE = (t) => {
  const d = document.createElement('div');
  d.id = 'demo-title';
  d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgba(15,23,42,.92);color:#fff;font:700 34px/1.4 system-ui,"Noto Sans CJK SC","WenQuanYi Micro Hei",sans-serif;text-align:center;padding:40px';
  d.textContent = t;
  document.documentElement.appendChild(d);
};

/** Fixtures: every context gets the caption script; `staff(role)` opens a page logged in as that user. */
export const test = base.extend({
  context: async ({ context }, use) => { await context.addInitScript(CAPTION); await use(context); },
  staff: async ({ browser }, use, info) => {
    const opened = [];
    await use(async (user = ADMIN) => {
      // the admin answers browsers with its login page (no auth challenge), so the credentials go in a header
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, extraHTTPHeaders: { authorization: 'Basic ' + Buffer.from(`${user.username}:${user.password}`).toString('base64') }, recordVideo: { dir: info.outputPath('videos'), size: { width: 1280, height: 800 } } });
      await ctx.addInitScript(CAPTION);
      opened.push(ctx);
      return ctx.newPage();
    });
    for (const c of opened) {
      const videos = c.pages().map((pg) => pg.video()).filter(Boolean);
      await c.close(); // closing writes the video
      for (const v of videos) await info.attach('video', { path: await v.path(), contentType: 'video/webm' });
    }
  },
});
export { expect };

export async function caption(page, text) {
  await page.evaluate((t) => window.__demoCap?.(t), text).catch(() => {});
  await page.waitForTimeout(Number(process.env.DEMO_PAUSE || 900));
}
export async function titleCard(page, text, ms = 1600) {
  await page.evaluate(TITLE, text).catch(() => {});
  await page.waitForTimeout(ms);
  await page.evaluate(() => document.getElementById('demo-title')?.remove()).catch(() => {});
}
/** Scroll to the bottom in steps (so the whole page is seen in the video), then back to the top. */
export async function tour(page, { steps = 6, pause = 350 } = {}) {
  const h = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  for (let i = 1; i <= steps && h > 0; i++) { await page.evaluate((y) => scrollTo({ top: y, behavior: 'smooth' }), (h * i) / steps); await page.waitForTimeout(pause); }
  if (h > 0) { await page.evaluate(() => scrollTo({ top: 0, behavior: 'smooth' })); await page.waitForTimeout(pause); }
}
/** Create staff accounts through the admin (idempotent: an existing user is left as it is). */
export async function ensureStaff(request, base, users) {
  const auth = { authorization: 'Basic ' + Buffer.from(`${ADMIN.username}:${ADMIN.password}`).toString('base64') };
  for (const [username, role] of users) await request.post(`${base}/admin/users/new`, { headers: auth, form: { username, name: username.toUpperCase(), role, password: PW }, maxRedirects: 0 });
}
