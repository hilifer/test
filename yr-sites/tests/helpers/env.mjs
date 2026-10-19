// Isolated environment for in-process tests. The server modules read config from env at import
// time, so call useTempEnv() BEFORE dynamically importing anything under server/src.
import { mkdtempSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function tempDir(prefix = 'yr-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Writes an isolated DB / news dir and returns the env that was applied. */
export function useTempEnv({ site = 'led', seedNews = true, ...extra } = {}) {
  const dir = tempDir();
  const newsDir = join(dir, 'news');
  if (seedNews) cpSync(join(ROOT, `sites/${site}/src/content/news`), newsDir, { recursive: true });
  else mkdirSync(newsDir, { recursive: true });
  const env = {
    SITE: site,
    DB_PATH: join(dir, 'db.sqlite'),
    NEWS_DIR: newsDir,
    SITE_DIR: join(dir, 'site'),
    PUBLIC_BASE_URL: 'https://example.test',
    ERP_MODE: 'local',
    BUILD_CMD: `node -e "require('fs').mkdirSync(process.env.OUT_DIR,{recursive:true})"`,
    LLM_PROVIDER: '', LLM_API_KEY: '', LLM_MODEL: '',
    WECOM_WEBHOOK_URL: '', FEISHU_WEBHOOK_URL: '', ALERT_WEBHOOK_URL: '',
    CONTENT_ENABLED: 'false', GEO_ENABLED: 'false', INDEXNOW_KEY: '',
    ...extra,
  };
  mkdirSync(env.SITE_DIR, { recursive: true });
  Object.assign(process.env, env);
  return { dir, env };
}
