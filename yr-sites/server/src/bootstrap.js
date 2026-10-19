// Container entrypoint: seed the article volume on first run, start the server,
// then build the site once so a new code version is always live after a restart.
import { existsSync, readdirSync, cpSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));
const c = config.content;
const seed = resolve(here, `../../sites/${config.site}/src/content/news`);
if (resolve(c.newsDir) !== seed) {
  mkdirSync(c.newsDir, { recursive: true });
  if (!readdirSync(c.newsDir).length && existsSync(seed)) {
    cpSync(seed, c.newsDir, { recursive: true });
    console.log(`[bootstrap] seeded articles into ${c.newsDir}`);
  }
}
await import('./index.js');
// The database is the source of truth for products and contacts: write them into the site before building,
// so a container restart or a new image never brings back the catalog.json baked into the image.
const { exportSite } = await import('./catalog/store.js');
exportSite();
if (c.releasesDir) {
  const { rebuild } = await import('./content/publisher.js');
  console.log('[bootstrap] building site…');
  rebuild().then(() => console.log('[bootstrap] site is live')).catch((e) => console.error('[bootstrap] build failed', e.message));
}
