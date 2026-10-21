// In-process scheduler (checked every minute). Runs inside the sales server, so there is
// one thing to deploy per site. Times are evaluated in CONTENT_TZ (default Asia/Shanghai).
import { config } from '../config.js';
import { generateArticle } from './writer.js';
import { rebuild, indexNow } from './publisher.js';
import { runGeoCheck } from './geo.js';
import { articleUrl, logRun } from './store.js';
import { registerJob, dailyAt } from '../jobs.js';


export async function contentJob() {
  const out = [];
  for (const lang of config.content.langs) {
    for (let i = 0; i < config.content.postsPerRun; i++) {
      try { out.push(await generateArticle({ lang })); } catch (e) { logRun('article', 'error', e.message); out.push({ error: e.message }); }
    }
  }
  const published = out.filter((r) => r.status === 'published');
  if (published.length) {
    try {
      await rebuild();
      await indexNow([...published.map((r) => articleUrl(r.id)), '/news/', '/llms.txt', '/sitemap.xml']);
    } catch {}
  }
  return out;
}

export function startScheduler() {
  const { content, geo } = config;
  registerJob({ id: 'content', name: '内容智能体写稿', schedule: dailyAt(content.hour, { days: content.days, tz: content.tz }), enabled: () => content.enabled, note: 'CONTENT_ENABLED',
    run: async () => { const out = await contentJob(); return `写了 ${out.filter((r) => !r.error).length} 篇，失败 ${out.filter((r) => r.error).length} 篇`; } });
  registerJob({ id: 'geo', name: 'GEO 监测', schedule: dailyAt(geo.hour, { days: [geo.day], tz: content.tz }), enabled: () => geo.enabled, note: 'GEO_ENABLED', run: async () => { await runGeoCheck(); return 'ok'; } });
}
