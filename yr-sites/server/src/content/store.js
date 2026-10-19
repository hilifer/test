// Articles are plain Markdown files with YAML front matter in NEWS_DIR (the site's content
// collection). The content agent writes them; the admin edits them; the Astro build renders them.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import YAML from 'yaml';
import { config } from '../config.js';
import { db } from '../db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS content_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, kind TEXT, status TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS content_seen (link TEXT PRIMARY KEY, ts TEXT);
CREATE TABLE IF NOT EXISTS geo_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, question TEXT, lang TEXT, mentioned INTEGER, competitors TEXT, answer TEXT, model TEXT);
`);

const dir = () => config.content.newsDir;

function walk(d, out = []) {
  if (!existsSync(d)) return out;
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (f.endsWith('.md')) out.push(p);
  }
  return out;
}

export function parse(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: text };
  return { data: YAML.parse(m[1]) || {}, body: m[2] };
}
export const serialize = (data, body) => `---\n${YAML.stringify(data, { lineWidth: 0 }).trim()}\n---\n\n${body.trim()}\n`;

export function listArticles() {
  return walk(dir())
    .map((file) => {
      const { data, body } = parse(readFileSync(file, 'utf8'));
      return { id: relative(dir(), file).replace(/\.md$/, '').replace(/\\/g, '/'), file, data, body, words: body.split(/\s+/).length };
    })
    .sort((a, b) => String(b.data.date).localeCompare(String(a.data.date)));
}

export function readArticle(id) {
  if (!/^[\w/-]+$/.test(id)) return null;
  const file = join(dir(), id + '.md');
  if (!existsSync(file)) return null;
  const { data, body } = parse(readFileSync(file, 'utf8'));
  return { id, file, data, body };
}

export function saveArticle(id, data, body) {
  if (!/^[\w/-]+$/.test(id)) throw new Error('bad id');
  const file = join(dir(), id + '.md');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serialize(data, body));
  return file;
}

export function setStatus(id, status) {
  const a = readArticle(id);
  if (!a) return null;
  a.data.status = status;
  if (status === 'published' && !a.data.publishedAt) a.data.publishedAt = new Date().toISOString();
  saveArticle(id, a.data, a.body);
  return a;
}

export const articleUrl = (id) => (id.startsWith('zh/') ? `/zh/news/${id.slice(3)}/` : `/news/${id}/`);

export function logRun(kind, status, detail) {
  db.prepare('INSERT INTO content_runs (ts, kind, status, detail) VALUES (?,?,?,?)').run(new Date().toISOString(), kind, status, typeof detail === 'string' ? detail : JSON.stringify(detail));
}
export const recentRuns = (n = 30) => db.prepare('SELECT * FROM content_runs ORDER BY id DESC LIMIT ?').all(n);
export const markSeen = (link) => db.prepare('INSERT OR IGNORE INTO content_seen (link, ts) VALUES (?,?)').run(link, new Date().toISOString());
export const isSeen = (link) => !!db.prepare('SELECT 1 FROM content_seen WHERE link = ?').get(link);
