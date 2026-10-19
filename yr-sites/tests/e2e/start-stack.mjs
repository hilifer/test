// Starts both sites the way production runs them: built static site + sales server behind one origin.
//   LED : site :4311 → api :8791      GRID: site :4312 → api :8792
// Each stack works on a throw-away copy of the site (so "publish" really rebuilds it without touching the
// repository), with a fresh database. Requires `pnpm build` first.
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, existsSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const STACK = { led: { site: 4311, api: 8791 }, grid: { site: 4312, api: 8792 } };
const procs = [];

for (const [name, p] of Object.entries(STACK)) {
  if (!existsSync(join(ROOT, `sites/${name}/dist`))) { console.error(`missing sites/${name}/dist — run "pnpm build" first`); process.exit(1); }
  const work = mkdtempSync(join(tmpdir(), `yr-e2e-${name}-`));
  // workspace copy: shared/ + sites/<name>/ (node_modules linked, not copied)
  cpSync(join(ROOT, 'shared'), join(work, 'shared'), { recursive: true });
  const site = join(work, 'sites', name);
  cpSync(join(ROOT, `sites/${name}`), site, { recursive: true, filter: (src) => basename(src) !== 'node_modules' && !src.includes(`${name}/.astro`) });
  symlinkSync(join(ROOT, `sites/${name}/node_modules`), join(site, 'node_modules'), 'dir');
  symlinkSync(join(ROOT, 'node_modules'), join(work, 'node_modules'), 'dir');
  mkdirSync(join(work, 'data'), { recursive: true });
  cpSync(join(ROOT, `sites/${name}/src/content/news`), join(work, 'data/news'), { recursive: true });
  const env = {
    ...process.env, SITE: name, PORT: String(p.api), DB_PATH: join(work, 'data/db.sqlite'), NEWS_DIR: join(work, 'data/news'), MEDIA_DIR: join(work, 'data/media'),
    SITE_DIR: site, SITE_JSON: join(site, 'src/data/site.json'), PUBLIC_BASE_URL: `http://127.0.0.1:${p.site}`, SITE_URL: `http://127.0.0.1:${p.site}`,
    ADMIN_PASSWORD: 'e2e-pass', ERP_MODE: 'mock', RATE_LIMIT_PER_MIN: '1000', TRUSTED_PROXY_HOPS: '0',
    LLM_PROVIDER: '', LLM_API_KEY: '', LLM_MODEL: '', CONTENT_ENABLED: 'false', GEO_ENABLED: 'false',
    BUILD_CMD: 'node scripts/sync-shared.mjs && npx astro build',
  };
  procs.push(spawn(process.execPath, [join(ROOT, 'server/src/index.js')], { env, stdio: 'inherit' }));
  procs.push(spawn(process.execPath, [join(ROOT, 'scripts/serve-local.mjs'), join(site, 'dist'), String(p.site), String(p.api)], { stdio: 'inherit' }));
}
const stop = () => { for (const c of procs) c.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
