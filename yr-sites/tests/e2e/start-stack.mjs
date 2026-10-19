// Starts both sites the way production runs them: built static site + sales server behind one origin.
//   LED : site :4311 → api :8791      GRID: site :4312 → api :8792
// Each API gets a fresh temp DB. Requires `pnpm build` first.
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const STACK = { led: { site: 4311, api: 8791 }, grid: { site: 4312, api: 8792 } };
const procs = [];

for (const [name, p] of Object.entries(STACK)) {
  const dist = join(ROOT, `sites/${name}/dist`);
  if (!existsSync(dist)) { console.error(`missing ${dist} — run "pnpm build" first`); process.exit(1); }
  const dir = mkdtempSync(join(tmpdir(), `yr-e2e-${name}-`));
  cpSync(join(ROOT, `sites/${name}/src/content/news`), join(dir, 'news'), { recursive: true });
  const env = { ...process.env, SITE: name, PORT: String(p.api), DB_PATH: join(dir, 'db.sqlite'), NEWS_DIR: join(dir, 'news'), PUBLIC_BASE_URL: `http://127.0.0.1:${p.site}`, ADMIN_PASSWORD: 'e2e-pass', ERP_MODE: 'mock', RATE_LIMIT_PER_MIN: '1000', LLM_PROVIDER: '', LLM_API_KEY: '', LLM_MODEL: '', CONTENT_ENABLED: 'false', GEO_ENABLED: 'false', BUILD_CMD: 'true' };
  procs.push(spawn(process.execPath, [join(ROOT, 'server/src/index.js')], { env, stdio: 'inherit' }));
  procs.push(spawn(process.execPath, [join(ROOT, 'scripts/serve-local.mjs'), dist, String(p.site), String(p.api)], { stdio: 'inherit' }));
}
const stop = () => { for (const c of procs) c.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
