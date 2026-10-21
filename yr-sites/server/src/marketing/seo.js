// Keywords & AI visibility (关键词与 AI 提及): the keywords we want to rank for, with positions recorded by hand or from a
// rank-tracking export (CSV: keyword, position, url, engine, date), and the weekly "mentioned by AI" rate taken from the
// GEO checks the content agent already runs.
import { db } from '../db.js';
import { migrate } from '../migrate.js';
import { actorName } from '../auth.js';
import '../content/store.js'; // geo_checks

migrate([{
  id: '2026-11-07-seo',
  up: () => db.exec(`CREATE TABLE seo_keywords (id INTEGER PRIMARY KEY AUTOINCREMENT, keyword TEXT NOT NULL, lang TEXT DEFAULT 'en', target_url TEXT, created_by TEXT, created_at TEXT, UNIQUE (keyword, lang));
    CREATE TABLE seo_ranks (id INTEGER PRIMARY KEY AUTOINCREMENT, keyword_id INTEGER NOT NULL, day TEXT NOT NULL, engine TEXT DEFAULT 'google', position INTEGER, url TEXT, by TEXT, UNIQUE (keyword_id, day, engine));`),
}]);
const now = () => new Date().toISOString();
export const ENGINES = { google: 'Google', bing: 'Bing', baidu: '百度' };

export function addKeyword({ keyword, lang = 'en', target_url = '' }) {
  const k = String(keyword || '').trim().toLowerCase();
  if (!k || k.length > 120) throw new Error('关键词须为 1–120 个字符');
  if (!['en', 'zh'].includes(lang)) throw new Error('语言无效');
  if (db.prepare('SELECT 1 FROM seo_keywords WHERE keyword = ? AND lang = ?').get(k, lang)) throw new Error(`关键词"${k}"已存在`);
  return Number(db.prepare('INSERT INTO seo_keywords (keyword, lang, target_url, created_by, created_at) VALUES (?,?,?,?,?)').run(k, lang, String(target_url || '').slice(0, 300), actorName('system'), now()).lastInsertRowid);
}
export function deleteKeyword(id) { db.prepare('DELETE FROM seo_ranks WHERE keyword_id = ?').run(Number(id)); db.prepare('DELETE FROM seo_keywords WHERE id = ?').run(Number(id)); }
/** Record a position (null / empty = not in the top 100). Same keyword, day and engine overwrites. */
export function recordRank(keywordId, { day = now().slice(0, 10), engine = 'google', position = null, url = '' }) {
  if (!db.prepare('SELECT 1 FROM seo_keywords WHERE id = ?').get(Number(keywordId))) throw new Error('关键词不存在');
  if (!ENGINES[engine]) throw new Error('搜索引擎无效');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('日期格式为 2026-11-07');
  const pos = position === '' || position == null ? null : Number(position);
  if (pos != null && !(Number.isInteger(pos) && pos >= 1 && pos <= 100)) throw new Error('排名须为 1–100 的整数（不在前 100 留空）');
  db.prepare('INSERT INTO seo_ranks (keyword_id, day, engine, position, url, by) VALUES (?,?,?,?,?,?) ON CONFLICT(keyword_id, day, engine) DO UPDATE SET position = excluded.position, url = excluded.url, by = excluded.by')
    .run(Number(keywordId), day, engine, pos, String(url || '').slice(0, 300), actorName('system'));
}
/** Import "keyword, position, url, engine, date" lines (header optional); unknown keywords are added. Returns counts. */
export function importRanks(text) {
  let added = 0, recorded = 0;
  const errors = [];
  for (const [i, line] of String(text || '').split(/\r?\n/).entries()) {
    const cols = line.split(/[,\t]/).map((x) => x.trim());
    if (!cols[0] || /^(keyword|关键词)$/i.test(cols[0])) continue;
    try {
      const kw = cols[0].toLowerCase();
      let k = db.prepare('SELECT id FROM seo_keywords WHERE keyword = ?').get(kw);
      if (!k) { k = { id: addKeyword({ keyword: kw, lang: /[\u3400-\u9fff]/.test(kw) ? 'zh' : 'en' }) }; added++; }
      recordRank(k.id, { position: cols[1] || null, url: cols[2] || '', engine: (cols[3] || 'google').toLowerCase(), day: cols[4] || now().slice(0, 10) });
      recorded++;
    } catch (e) { errors.push(`第 ${i + 1} 行：${e.message}`); }
  }
  return { added, recorded, errors };
}
/** Keywords with their latest position, the change since the previous record, and the history (oldest first). */
export function keywordTable(engine = 'google') {
  return db.prepare('SELECT * FROM seo_keywords ORDER BY lang, keyword').all().map((k) => {
    const hist = db.prepare('SELECT day, position, url FROM seo_ranks WHERE keyword_id = ? AND engine = ? ORDER BY day').all(k.id, engine);
    const last = hist.at(-1), prev = hist.at(-2);
    const change = last && prev && last.position != null && prev.position != null ? prev.position - last.position : null;
    return { ...k, last, prev, change, hist };
  });
}
/** Share of AI answers that mention us, per ISO week (oldest first), from the GEO checks. */
export function aiMentionTrend(weeks = 12) {
  const since = new Date(Date.now() - weeks * 7 * 86400e3).toISOString();
  const rows = db.prepare('SELECT ts, mentioned FROM geo_checks WHERE ts >= ? ORDER BY ts').all(since);
  const byWeek = new Map();
  for (const r of rows) {
    const d = new Date(r.ts);
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7))).toISOString().slice(0, 10);
    const w = byWeek.get(monday) || { week: monday, checks: 0, mentioned: 0 };
    w.checks++; if (r.mentioned) w.mentioned++;
    byWeek.set(monday, w);
  }
  return [...byWeek.values()].map((w) => ({ ...w, rate: w.checks ? w.mentioned / w.checks : null }));
}
