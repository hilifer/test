import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;

function readJSON(p, label) {
  const abs = resolve(p);
  if (!existsSync(abs)) throw new Error(`${label} not found at ${abs}`);
  return JSON.parse(readFileSync(abs, 'utf8'));
}

// SITE = led | grid. Each deployment runs its own server instance with its own data.
const SITE = env.SITE || 'led';
const defaultProfile = resolve(here, `../profiles/${SITE}.json`);
const defaultCatalog = resolve(here, `../../sites/${SITE}/src/data/catalog.json`);

export const config = {
  site: SITE,
  port: Number(env.PORT || 8787),
  dbPath: env.DB_PATH || resolve(here, `../data/${SITE}.sqlite`),
  publicBaseUrl: (env.PUBLIC_BASE_URL || 'http://localhost:4321').replace(/\/$/, ''),
  allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  adminUser: env.ADMIN_USER || 'admin',
  adminPassword: env.ADMIN_PASSWORD || '',
  llm: {
    provider: env.LLM_PROVIDER || '', // anthropic | openai (any OpenAI-compatible: OpenAI, DeepSeek, Qwen…)
    apiKey: env.LLM_API_KEY || '',
    baseUrl: env.LLM_BASE_URL || '',
    model: env.LLM_MODEL || '',
    maxTokens: Number(env.LLM_MAX_TOKENS || 4000), // thinking tokens count toward this on current Claude models
  },
  alerts: {
    wecomWebhook: env.WECOM_WEBHOOK_URL || '', // 企业微信群机器人
    feishuWebhook: env.FEISHU_WEBHOOK_URL || '',
    genericWebhook: env.ALERT_WEBHOOK_URL || '', // e.g. Zapier/Make → email, CRM
    minGrade: env.ALERT_MIN_GRADE || 'B',
  },
  rateLimitPerMin: Number(env.RATE_LIMIT_PER_MIN || 20),
  // --- ERP (Kingdee Cloud Galaxy / 金蝶云星空) ---
  // local  = no ERP: stock is kept on the SKU page in /admin
  // mock   = simulated Kingdee (for testing the whole flow)
  // kingdee = real K/3 Cloud WebAPI
  erp: {
    mode: env.ERP_MODE || 'local',
    syncMinutes: Number(env.ERP_SYNC_MINUTES || 60),
    autoPushOrders: env.ERP_AUTO_PUSH_ORDERS !== 'false',
    kingdee: {
      baseUrl: (env.KD_BASE_URL || '').replace(/\/$/, ''), // e.g. https://xxx.ik3cloud.com/k3cloud  or  http://your-server/k3cloud
      acctId: env.KD_ACCT_ID || '', // 数据中心 ID
      username: env.KD_USERNAME || '',
      appId: env.KD_APP_ID || '', // 第三方系统登录授权的应用 ID
      appSecret: env.KD_APP_SECRET || '',
      password: env.KD_PASSWORD || '', // only if not using AppSecret login
      lcid: Number(env.KD_LCID || 2052),
      orgNumber: env.KD_ORG_NUMBER || '100', // 销售组织 / 库存组织编码
      saleOrderBillType: env.KD_SO_BILLTYPE || 'XSDD01_SYS', // 标准销售订单
      currencyMap: { USD: env.KD_CUR_USD || 'PRE007', CNY: env.KD_CUR_CNY || 'PRE001', EUR: env.KD_CUR_EUR || 'PRE003' },
      stockFilter: env.KD_STOCK_FILTER || '', // optional FilterString for STK_Inventory, e.g. FStockId.FNumber IN ('CK001','CK002')
    },
  },
  // --- SEO/GEO content agent ---
  content: {
    enabled: env.CONTENT_ENABLED === 'true',
    // Days (0=Sun … 6=Sat) and hour, in CONTENT_TZ. Default: Mon/Wed/Fri at 09:00 Beijing time.
    days: (env.CONTENT_DAYS || '1,3,5').split(',').map(Number),
    hour: Number(env.CONTENT_HOUR ?? 9),
    tz: env.CONTENT_TZ || 'Asia/Shanghai',
    postsPerRun: Number(env.CONTENT_POSTS_PER_RUN || 1),
    autoPublish: env.CONTENT_AUTO_PUBLISH === 'true', // false = drafts wait for approval in /admin/content
    langs: (env.CONTENT_LANGS || (SITE === 'grid' ? 'en,zh' : 'en')).split(',').map((s) => s.trim()),
    newsDir: env.NEWS_DIR || resolve(here, `../../sites/${SITE}/src/content/news`),
    siteDir: env.SITE_DIR || resolve(here, `../../sites/${SITE}`),
    releasesDir: env.RELEASES_DIR || '', // e.g. /srv/site — builds go to releases/<ts>, "current" symlink is swapped
    buildCmd: env.BUILD_CMD || 'npx astro build',
    indexNowKey: env.INDEXNOW_KEY || '',
    llm: { provider: env.CONTENT_LLM_PROVIDER, apiKey: env.CONTENT_LLM_API_KEY, baseUrl: env.CONTENT_LLM_BASE_URL, model: env.CONTENT_LLM_MODEL },
  },
  geo: {
    enabled: env.GEO_ENABLED === 'true',
    day: Number(env.GEO_DAY ?? 1), // weekly, Monday
    hour: Number(env.GEO_HOUR ?? 10),
    // Ideally a search-grounded, OpenAI-compatible API (e.g. Perplexity) so answers reflect the live web.
    llm: { provider: env.GEO_LLM_PROVIDER, apiKey: env.GEO_LLM_API_KEY, baseUrl: env.GEO_LLM_BASE_URL, model: env.GEO_LLM_MODEL },
  },
  profile: readJSON(env.SITE_PROFILE || defaultProfile, 'Site profile'),
  catalog: readJSON(env.CATALOG_PATH || defaultCatalog, 'Catalog'),
};

export const aiEnabled = () => Boolean(config.llm.provider && config.llm.apiKey && config.llm.model);
