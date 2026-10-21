// Customer service (客服): quick replies, a knowledge base the AI answers from first, a unified inbox (website chats,
// e-mails received through an inbound webhook, contact-form messages, after-sales requests), chat ratings from customers
// and service performance per person (first response time, resolution, rating, e-mail replies).
import { db } from '../db.js';
import { config } from '../config.js';
import { migrate } from '../migrate.js';
import { actorName } from '../auth.js';
import { alertOps } from '../alerts.js';
import { sendMail } from '../shop/mailer.js';
import '../livechat.js'; // conversations.agent / waiting

migrate([{
  id: '2026-11-10-service-desk',
  up: () => db.exec(`CREATE TABLE quick_replies (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, lang TEXT DEFAULT 'en', body TEXT NOT NULL, uses INTEGER DEFAULT 0, created_by TEXT, updated_at TEXT);
    CREATE TABLE kb_articles (id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT NOT NULL, answer TEXT NOT NULL, lang TEXT DEFAULT 'en', keywords TEXT, active INTEGER DEFAULT 1, hits INTEGER DEFAULT 0, created_by TEXT, updated_at TEXT);
    CREATE TABLE inbox_mails (id INTEGER PRIMARY KEY AUTOINCREMENT, from_addr TEXT NOT NULL, from_name TEXT, subject TEXT, body TEXT, received_at TEXT, status TEXT DEFAULT 'open', assignee TEXT, replies TEXT DEFAULT '[]', first_reply_at TEXT);
    CREATE TABLE chat_ratings (conv_id TEXT PRIMARY KEY, rating INTEGER, resolved INTEGER, comment TEXT, agent TEXT, ts TEXT);`),
}]);
const now = () => new Date().toISOString();
const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

// ---------------------------------------------------------------- quick replies
export const listQuickReplies = (lang = '') => db.prepare(`SELECT * FROM quick_replies ${lang ? 'WHERE lang = ?' : ''} ORDER BY uses DESC, title`).all(...(lang ? [lang] : []));
export function saveQuickReply({ id, title, lang = 'en', body }) {
  const t = String(title || '').trim(), b = String(body || '').trim();
  if (!t || t.length > 60) throw new Error('标题须为 1–60 个字符');
  if (!b || b.length > 2000) throw new Error('回复内容须为 1–2000 个字符');
  if (!['en', 'zh'].includes(lang)) throw new Error('语言无效');
  if (id) { db.prepare('UPDATE quick_replies SET title = ?, lang = ?, body = ?, updated_at = ? WHERE id = ?').run(t, lang, b, now(), Number(id)); return Number(id); }
  return Number(db.prepare('INSERT INTO quick_replies (title, lang, body, created_by, updated_at) VALUES (?,?,?,?,?)').run(t, lang, b, actorName('system'), now()).lastInsertRowid);
}
export const deleteQuickReply = (id) => db.prepare('DELETE FROM quick_replies WHERE id = ?').run(Number(id));
export const usedQuickReply = (id) => db.prepare('UPDATE quick_replies SET uses = uses + 1 WHERE id = ?').run(Number(id));

// ---------------------------------------------------------------- knowledge base
const CJK = /[\u3400-\u9fff]/;
/** Words for matching: lowercase latin words (3+ letters, a few stop words removed) and Chinese two-character pieces. */
export function terms(text) {
  const t = String(text || '').toLowerCase();
  const latin = (t.match(/[a-z0-9][a-z0-9+.-]*/g) || []).filter((w) => w.length >= 3 && !STOP.has(w));
  const zh = [];
  for (const run of t.match(/[\u3400-\u9fff]+/g) || []) for (let i = 0; i < run.length - 1; i++) zh.push(run.slice(i, i + 2));
  return new Set([...latin, ...zh]);
}
const STOP = new Set(['the', 'and', 'for', 'you', 'your', 'are', 'can', 'what', 'how', 'does', 'with', 'this', 'that', 'have', 'from', 'about', 'please', 'any', 'our', 'will', 'there', 'which', 'when', 'where', 'who', 'why', 'is', 'do']);
export const listKb = ({ q = '', lang = '' } = {}) => db.prepare(`SELECT * FROM kb_articles WHERE 1=1 ${lang ? 'AND lang = ?' : ''} ${q ? 'AND (question LIKE ? OR answer LIKE ? OR keywords LIKE ?)' : ''} ORDER BY hits DESC, id DESC`).all(...(lang ? [lang] : []), ...(q ? Array(3).fill(`%${q}%`) : []));
export function saveKb({ id, question, answer, lang = 'en', keywords = '', active = true }) {
  const q = String(question || '').trim(), a = String(answer || '').trim();
  if (!q || q.length > 300) throw new Error('问题须为 1–300 个字符');
  if (!a || a.length > 4000) throw new Error('答案须为 1–4000 个字符');
  if (!['en', 'zh'].includes(lang)) throw new Error('语言无效');
  const vals = [q, a, lang, String(keywords || '').slice(0, 300), active === false || active === '0' ? 0 : 1, now()];
  if (id) { db.prepare('UPDATE kb_articles SET question = ?, answer = ?, lang = ?, keywords = ?, active = ?, updated_at = ? WHERE id = ?').run(...vals, Number(id)); return Number(id); }
  return Number(db.prepare('INSERT INTO kb_articles (question, answer, lang, keywords, active, updated_at, created_by) VALUES (?,?,?,?,?,?,?)').run(...vals, actorName('system')).lastInsertRowid);
}
export const deleteKb = (id) => db.prepare('DELETE FROM kb_articles WHERE id = ?').run(Number(id));
/**
 * Best matching active entries for a customer message: [{ article, score }]. Score 0–1 = words found (from the question or
 * its keywords) over the number of words in the question, so keywords add ways to match without diluting the score.
 */
export function searchKb(text, { lang = CJK.test(text) ? 'zh' : 'en', limit = 3 } = {}) {
  const msg = terms(text);
  if (!msg.size) return [];
  return db.prepare('SELECT * FROM kb_articles WHERE active = 1 AND lang = ?').all(lang).map((a) => {
    const q = terms(a.question), t = new Set([...q, ...terms(a.keywords)]);
    let hit = 0;
    for (const w of t) if (msg.has(w)) hit++;
    return { article: a, score: Math.min(1, hit / (q.size || t.size || 1)), hit };
  }).filter((x) => x.hit >= 2 || (x.hit >= 1 && x.score >= 0.5)).sort((a, b) => b.score - a.score || b.hit - a.hit).slice(0, limit);
}
export const kbHit = (id) => db.prepare('UPDATE kb_articles SET hits = hits + 1 WHERE id = ?').run(Number(id));
/** For the AI's system prompt: the most relevant entries, to be preferred over general knowledge. */
export function kbContext(text) {
  const hits = searchKb(text, { limit: 3 });
  for (const h of hits) kbHit(h.article.id);
  return hits.length ? `\n\nCOMPANY KNOWLEDGE BASE (answer from these first; they are approved by our team):\n${hits.map((h) => `Q: ${h.article.question}\nA: ${h.article.answer}`).join('\n\n')}` : '';
}
/** Rules mode: a confident match is answered directly. */
export function kbAnswer(text) {
  const [best] = searchKb(text, { limit: 1 });
  if (!best || best.score < 0.6) return null;
  kbHit(best.article.id);
  return best.article.answer;
}

// ---------------------------------------------------------------- inbound e-mail
/** Accepts the JSON or form body of common inbound-mail webhooks (Mailgun, SendGrid, Postmark, or plain {from, subject, text}). */
export function receiveMail(b) {
  const fromRaw = String(b.from || b.sender || b.From || b.FromFull?.Email || '').trim();
  const m = fromRaw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const email = (m ? m[2] : fromRaw).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('invalid sender');
  const subject = String(b.subject || b.Subject || '(no subject)').slice(0, 300);
  const body = String(b['stripped-text'] || b['body-plain'] || b.text || b.TextBody || b.body || '').slice(0, 20000);
  const id = Number(db.prepare('INSERT INTO inbox_mails (from_addr, from_name, subject, body, received_at) VALUES (?,?,?,?,?)').run(email, (m ? m[1] : b.FromName || '').trim().slice(0, 100), subject, body, now()).lastInsertRowid);
  alertOps('收到客户邮件', [`${email}：${subject}`, `${config.publicBaseUrl}/admin/service/mail/${id}`]).catch(() => {});
  return id;
}
export const getMail = (id) => { const r = db.prepare('SELECT * FROM inbox_mails WHERE id = ?').get(Number(id)); return r && { ...r, replies: J(r.replies, []) }; };
export async function replyMail(id, text, user) {
  const m = getMail(id);
  if (!m) throw new Error('邮件不存在');
  const t = String(text || '').trim();
  if (!t) throw new Error('请输入回复内容');
  const subject = /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`;
  const quoted = `${t}\n\n— ${user.name || user.username}, ${config.profile.brand}\n\n> ${String(m.body).split('\n').slice(0, 20).join('\n> ')}`;
  const r = await sendMail(m.from_addr, subject, quoted);
  const replies = [...m.replies, { ts: now(), by: user.username, text: t, status: r.status }];
  db.prepare("UPDATE inbox_mails SET replies = ?, status = 'replied', assignee = COALESCE(assignee, ?), first_reply_at = COALESCE(first_reply_at, ?) WHERE id = ?").run(JSON.stringify(replies), user.username, now(), m.id);
  return r;
}
export function setMailStatus(id, status, user) {
  if (!['open', 'replied', 'closed'].includes(status)) throw new Error('状态无效');
  db.prepare('UPDATE inbox_mails SET status = ?, assignee = COALESCE(assignee, ?) WHERE id = ?').run(status, user?.username || null, Number(id));
}

// ---------------------------------------------------------------- unified inbox
/**
 * Everything waiting for customer service, newest first: chats (customer waiting, or asked for a person and nobody took
 * it), e-mails not closed, contact-form messages not handled, after-sales requests not yet reviewed.
 */
export function inbox({ channel = '', mine = null } = {}) {
  const items = [];
  if (!channel || channel === 'chat') {
    for (const c of db.prepare("SELECT * FROM conversations WHERE (waiting = 1 AND agent IS NOT NULL) OR (handoff = 1 AND agent IS NULL AND updated_at >= ?) ORDER BY updated_at DESC LIMIT 100").all(new Date(Date.now() - 7 * 86400e3).toISOString())) {
      const last = db.prepare("SELECT content FROM messages WHERE conv_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(c.id);
      items.push({ channel: 'chat', id: c.id, ts: c.updated_at, who: c.lead_id ? db.prepare('SELECT company, name, email FROM leads WHERE id = ?').get(c.lead_id)?.email || '访客' : '访客', title: c.waiting ? '客户等待回复' : `转人工：${c.handoff_reason || ''}`, preview: last?.content || '', href: `/admin/conv/${c.id}`, assignee: c.agent || null, urgent: Boolean(c.waiting) });
    }
  }
  if (!channel || channel === 'email') {
    for (const m of db.prepare("SELECT * FROM inbox_mails WHERE status != 'closed' ORDER BY received_at DESC LIMIT 200").all())
      items.push({ channel: 'email', id: m.id, ts: m.received_at, who: m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr, title: m.subject, preview: String(m.body).slice(0, 140), href: `/admin/service/mail/${m.id}`, assignee: m.assignee, urgent: m.status === 'open' });
  }
  if (!channel || channel === 'form') {
    for (const l of db.prepare("SELECT * FROM leads WHERE source IN ('contact', 'partner') AND status = 'new' ORDER BY created_at DESC LIMIT 100").all())
      items.push({ channel: 'form', id: l.id, ts: l.created_at, who: l.email || l.whatsapp || l.name, title: l.company || l.name || '联系表单', preview: String(l.needs || '').slice(0, 140), href: `/admin/lead/${l.id}`, assignee: l.owner || null, urgent: false });
  }
  if (!channel || channel === 'rma') {
    for (const r of db.prepare("SELECT r.*, c.email FROM rmas r LEFT JOIN customers c ON c.id = r.customer_id WHERE r.status = 'submitted' ORDER BY r.created_at DESC LIMIT 100").all())
      items.push({ channel: 'rma', id: r.id, ts: r.created_at, who: r.email || '', title: `售后 ${r.number}`, preview: String(r.description || '').slice(0, 140), href: `/admin/rma/${r.id}`, assignee: null, urgent: true });
  }
  return items.filter((i) => !mine || i.assignee === mine || !i.assignee).sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}

// ---------------------------------------------------------------- ratings & performance
export function rateChat(convId, { rating, resolved = null, comment = '' }) {
  const c = db.prepare('SELECT id, agent FROM conversations WHERE id = ?').get(String(convId || ''));
  if (!c) throw new Error('not_found');
  const r = Number(rating);
  if (!(Number.isInteger(r) && r >= 1 && r <= 5)) throw new Error('bad_rating');
  // the person who replied last in this chat gets the rating (the AI if nobody did)
  const agent = c.agent || J(db.prepare("SELECT meta FROM messages WHERE conv_id = ? AND role = 'agent' ORDER BY id DESC LIMIT 1").get(c.id)?.meta, {}).by || null;
  db.prepare('INSERT INTO chat_ratings (conv_id, rating, resolved, comment, agent, ts) VALUES (?,?,?,?,?,?) ON CONFLICT(conv_id) DO UPDATE SET rating = excluded.rating, resolved = excluded.resolved, comment = excluded.comment, ts = excluded.ts')
    .run(c.id, r, resolved == null ? null : resolved ? 1 : 0, String(comment || '').slice(0, 500), agent, now());
  if (r <= 2) alertOps('客户给了差评', [`${r} 星${comment ? `：${String(comment).slice(0, 200)}` : ''}`, agent ? `接待：${agent}` : 'AI 接待', `${config.publicBaseUrl}/admin/conv/${c.id}`]).catch(() => {});
}
/**
 * Per person over the last N days: chats handled, average first response (customer message → first reply by that person),
 * ratings (average, count), resolution rate (rated "solved"), e-mails replied and average e-mail first reply time.
 */
export function performance(days = 30) {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const people = new Map();
  const row = (u) => { if (!people.has(u)) people.set(u, { username: u, chats: 0, responses: [], ratings: [], resolved: 0, ratedResolved: 0, emails: 0, emailResponses: [] }); return people.get(u); };
  for (const c of db.prepare("SELECT DISTINCT conv_id FROM messages WHERE role = 'agent' AND ts >= ?").all(since)) {
    const msgs = db.prepare('SELECT role, meta, ts FROM messages WHERE conv_id = ? ORDER BY id').all(c.conv_id);
    const first = new Map();
    let lastUser = null;
    for (const m of msgs) {
      if (m.role === 'user') lastUser = m.ts;
      if (m.role === 'agent') { const by = J(m.meta, {}).by; if (by && !first.has(by)) first.set(by, lastUser ? (Date.parse(m.ts) - Date.parse(lastUser)) / 60e3 : null); }
    }
    for (const [u, mins] of first) { const r = row(u); r.chats++; if (mins != null) r.responses.push(mins); }
  }
  for (const r of db.prepare('SELECT * FROM chat_ratings WHERE ts >= ? AND agent IS NOT NULL').all(since)) { const p = row(r.agent); p.ratings.push(r.rating); if (r.resolved != null) { p.ratedResolved++; if (r.resolved) p.resolved++; } }
  for (const m of db.prepare('SELECT * FROM inbox_mails WHERE first_reply_at IS NOT NULL AND first_reply_at >= ?').all(since)) { const p = row(m.assignee || '—'); p.emails++; p.emailResponses.push((Date.parse(m.first_reply_at) - Date.parse(m.received_at)) / 60e3); }
  const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);
  return [...people.values()].map((p) => ({ username: p.username, chats: p.chats, avgFirstResponseMin: avg(p.responses), ratings: p.ratings.length, avgRating: avg(p.ratings), resolutionRate: p.ratedResolved ? p.resolved / p.ratedResolved : null, emails: p.emails, avgEmailResponseMin: avg(p.emailResponses) }))
    .sort((a, b) => b.chats - a.chats || a.username.localeCompare(b.username));
}
export function ratingSummary(days = 30) {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const r = db.prepare('SELECT COUNT(*) n, AVG(rating) avg, SUM(resolved = 1) solved, SUM(resolved IS NOT NULL) asked FROM chat_ratings WHERE ts >= ?').get(since);
  return { count: r.n, avg: r.avg == null ? null : Math.round(r.avg * 10) / 10, resolutionRate: r.asked ? r.solved / r.asked : null, recent: db.prepare('SELECT * FROM chat_ratings ORDER BY ts DESC LIMIT 20').all() };
}
