// Minimal RSS 2.0 / Atom reader (no dependencies). Industry news is input for original
// commentary — the agent links to the source and never republishes the article itself.
import { isSeen } from './store.js';

// Tags are stripped again after entity decoding: many feeds put escaped HTML (&lt;p&gt;) in <description>.
const decode = (s = '') =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i')); return m ? decode(m[1]) : ''; };

export function parseFeed(xml, source) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    let link = tag(b, 'link');
    if (!link) { const m = b.match(/<link[^>]*href="([^"]+)"/i); link = m ? m[1] : ''; }
    const date = new Date(tag(b, 'pubDate') || tag(b, 'updated') || tag(b, 'published') || tag(b, 'dc:date') || Date.now());
    items.push({ source, title: tag(b, 'title'), link, date: isNaN(date) ? new Date() : date, summary: (tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')).slice(0, 600) });
  }
  return items;
}

/** Fresh, unseen items from all feeds, newest first. Failing feeds are skipped. */
export async function freshItems(feeds = [], { days = 10, limit = 25 } = {}) {
  const since = Date.now() - days * 864e5;
  const all = [];
  const errors = [];
  await Promise.all(feeds.map(async (f) => {
    try {
      const r = await fetch(f.url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; YRContentBot/1.0)' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      all.push(...parseFeed(await r.text(), f.name));
    } catch (e) { errors.push(`${f.name}: ${e.message}`); }
  }));
  const items = all.filter((i) => i.link && +i.date >= since && !isSeen(i.link)).sort((a, b) => b.date - a.date).slice(0, limit);
  return { items, errors };
}
