// Rebuild the static site after content changes and tell search engines.
// Production layout (RELEASES_DIR=/srv/site):  /srv/site/releases/<timestamp>/  +  /srv/site/current → symlink
// Caddy serves /srv/site/current, so a new build goes live atomically and a failed build changes nothing.
import { spawn } from 'node:child_process';
import { writeFileSync, symlinkSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { logRun } from './store.js';

let running = null;
let again = false;

function run(cmd, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, { ...opts, shell: true });
    let log = '';
    p.stdout.on('data', (d) => (log += d));
    p.stderr.on('data', (d) => (log += d));
    p.on('close', (code) => (code === 0 ? resolve(log) : reject(new Error(`build exited ${code}\n${log.slice(-2000)}`))));
  });
}

async function buildOnce() {
  const c = config.content;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const out = c.releasesDir ? join(c.releasesDir, 'releases', ts) : join(c.siteDir, 'dist');
  const started = Date.now();
  await run(c.buildCmd, { cwd: c.siteDir, env: { ...process.env, NEWS_DIR: c.newsDir, OUT_DIR: out, SITE_URL: process.env.SITE_URL || config.publicBaseUrl } });
  if (c.indexNowKey) writeFileSync(join(out, `${c.indexNowKey}.txt`), c.indexNowKey);
  if (c.releasesDir) {
    const cur = join(c.releasesDir, 'current');
    const tmp = join(c.releasesDir, `.current-${ts}`);
    symlinkSync(join('releases', ts), tmp);
    renameSync(tmp, cur); // atomic swap
    const rels = readdirSync(join(c.releasesDir, 'releases')).sort();
    for (const r of rels.slice(0, -3)) rmSync(join(c.releasesDir, 'releases', r), { recursive: true, force: true });
  }
  logRun('build', 'ok', { out, seconds: Math.round((Date.now() - started) / 1000) });
}

/** Queue-safe rebuild: concurrent calls coalesce into one extra build. */
export async function rebuild() {
  if (running) { again = true; return running; }
  running = (async () => {
    try {
      do { again = false; await buildOnce(); } while (again);
    } catch (e) {
      logRun('build', 'error', e.message);
      throw e;
    } finally { running = null; }
  })();
  return running;
}

/** IndexNow (Bing, Yandex, Seznam, Naver…). Bing's index feeds Copilot and ChatGPT search. */
export async function indexNow(paths) {
  const key = config.content.indexNowKey;
  if (!key || !paths.length) return { skipped: true };
  const base = config.publicBaseUrl;
  const host = new URL(base).host;
  try {
    const r = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host, key, keyLocation: `${base}/${key}.txt`, urlList: paths.map((p) => base + p) }),
      signal: AbortSignal.timeout(15000),
    });
    logRun('indexnow', r.ok ? 'ok' : 'error', { status: r.status, paths });
    return { status: r.status };
  } catch (e) { logRun('indexnow', 'error', e.message); return { error: e.message }; }
}

export const buildRunning = () => Boolean(running);
