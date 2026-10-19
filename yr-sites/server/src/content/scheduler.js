// In-process scheduler (checked every minute). Runs inside the sales server, so there is
// one thing to deploy per site. Times are evaluated in CONTENT_TZ (default Asia/Shanghai).
import { config } from '../config.js';
import { generateArticle } from './writer.js';
import { rebuild, indexNow } from './publisher.js';
import { runGeoCheck } from './geo.js';
import { articleUrl, logRun } from './store.js';

const done = new Set();
function nowIn(tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { dow, hour: Number(parts.hour) % 24, date: `${parts.year}-${parts.month}-${parts.day}` };
}

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
  if (!content.enabled && !geo.enabled) return;
  console.log(`[scheduler] content ${content.enabled ? `on: days ${content.days} @ ${content.hour}:00 ${content.tz}, auto-publish ${content.autoPublish}` : 'off'}; geo ${geo.enabled ? 'on' : 'off'}`);
  setInterval(async () => {
    const n = nowIn(content.tz);
    const slotC = `c:${n.date}:${n.hour}`;
    if (content.enabled && content.days.includes(n.dow) && n.hour === content.hour && !done.has(slotC)) { done.add(slotC); contentJob(); }
    const slotG = `g:${n.date}`;
    if (geo.enabled && n.dow === geo.day && n.hour === geo.hour && !done.has(slotG)) { done.add(slotG); runGeoCheck().catch(() => {}); }
  }, 60000).unref();
}
