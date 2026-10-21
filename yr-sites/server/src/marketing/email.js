// E-mail marketing (邮件营销): campaigns to customers who agreed to receive marketing e-mail, chosen by tags / type / VIP /
// language. Sending runs in the task center (one message at a time, retry on failure). Every message has a one-click
// unsubscribe link (also as a List-Unsubscribe header) and an open-tracking pixel, so the campaign shows sent, opened,
// open rate and unsubscribes. Customers who unsubscribed are never mailed again.
import { randomBytes } from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { migrate, addColumn } from '../migrate.js';
import { actorName } from '../auth.js';
import { registerHandler, createTask } from '../tasks.js';
import { sendMail } from '../shop/mailer.js';
import '../shop/schema.js'; // customers.marketing_opt_in
import '../sales/crm.js'; // customers.tags / tier / vip

migrate([{
  id: '2026-11-07-email-marketing',
  up: () => {
    db.exec(`CREATE TABLE email_campaigns (id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, body TEXT NOT NULL, audience TEXT DEFAULT '{}', status TEXT DEFAULT 'draft',
        created_by TEXT, created_at TEXT, sent_at TEXT, task_id TEXT);
      CREATE TABLE email_recipients (id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL, customer_id TEXT, email TEXT, token TEXT UNIQUE, status TEXT DEFAULT 'queued',
        error TEXT, sent_at TEXT, opened_at TEXT, opens INTEGER DEFAULT 0, unsubscribed_at TEXT);
      CREATE INDEX email_recipients_campaign ON email_recipients(campaign_id);`);
    addColumn('customers', 'unsubscribed_at', 'TEXT');
  },
}]);
const now = () => new Date().toISOString();
const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const listEmailCampaigns = () => db.prepare('SELECT * FROM email_campaigns ORDER BY created_at DESC').all().map((c) => ({ ...c, audience: J(c.audience, {}) }));
export const getEmailCampaign = (id) => { const c = db.prepare('SELECT * FROM email_campaigns WHERE id = ?').get(Number(id)); return c && { ...c, audience: J(c.audience, {}) }; };
function normAudience(a = {}) {
  return { tags: [].concat(a.tags || []).flatMap((t) => String(t).split(/[,，]/)).map((t) => t.trim()).filter(Boolean), tier: String(a.tier || ''), vip: a.vip === true || a.vip === '1', lang: ['en', 'zh'].includes(a.lang) ? a.lang : '' };
}
export function saveEmailCampaign({ id, subject, body, audience }) {
  const s = String(subject || '').trim(), b = String(body || '').trim();
  if (!s || s.length > 150) throw new Error('邮件标题须为 1–150 个字符');
  if (b.length < 10) throw new Error('邮件内容至少 10 个字符');
  const a = JSON.stringify(normAudience(audience));
  if (id) {
    const cur = getEmailCampaign(id);
    if (!cur) throw new Error('邮件不存在');
    if (cur.status !== 'draft') throw new Error('已发送的邮件不能修改');
    db.prepare('UPDATE email_campaigns SET subject = ?, body = ?, audience = ? WHERE id = ?').run(s, b.slice(0, 20000), a, Number(id));
    return Number(id);
  }
  return Number(db.prepare('INSERT INTO email_campaigns (subject, body, audience, created_by, created_at) VALUES (?,?,?,?,?)').run(s, b.slice(0, 20000), a, actorName('system'), now()).lastInsertRowid);
}
export function deleteEmailCampaign(id) {
  const c = getEmailCampaign(id);
  if (c && c.status !== 'draft') throw new Error('已发送的邮件不能删除');
  db.prepare('DELETE FROM email_campaigns WHERE id = ?').run(Number(id));
}
/** Customers who agreed to marketing e-mail and match the audience. */
export function audienceOf(a) {
  const f = normAudience(a);
  return db.prepare("SELECT id, email, contact, company, tags, tier, vip, lang FROM customers WHERE marketing_opt_in = 1 AND unsubscribed_at IS NULL AND email IS NOT NULL AND email != ''").all()
    .filter((c) => (!f.tier || c.tier === f.tier) && (!f.vip || Number(c.vip) === 1) && (!f.lang || (c.lang || 'en') === f.lang) && (!f.tags.length || f.tags.some((t) => J(c.tags, []).includes(t))));
}
const link = (path) => `${config.publicBaseUrl}${path}`;
/** Text and HTML for one recipient. The body is plain text; blank lines make paragraphs and URLs become links. */
export function renderEmail(c, r) {
  const name = r.contact || r.company || '';
  const body = c.body.replaceAll('{{name}}', name || (r.lang === 'zh' ? '您好' : 'there'));
  const unsub = link(`/m/u/${r.token}`);
  const zh = r.lang === 'zh';
  const footer = zh ? `不想再收到此类邮件？退订：${unsub}` : `Don't want these e-mails? Unsubscribe: ${unsub}`;
  const text = `${body}\n\n—\n${config.profile.brand}\n${footer}`;
  const html = `<div style="font:15px/1.6 -apple-system,Segoe UI,Arial,sans-serif;color:#1d2733;max-width:620px">${body.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>').replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`)}</p>`).join('')}
<hr style="border:0;border-top:1px solid #e2e6ea"><p style="font-size:12px;color:#66717d">${esc(config.profile.brand)} · <a href="${unsub}">${zh ? '退订' : 'Unsubscribe'}</a></p><img src="${link(`/m/o/${r.token}.gif`)}" width="1" height="1" alt=""></div>`;
  return { subject: c.subject, text, html, headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
}

registerHandler('email.campaign', {
  label: '邮件营销发送',
  run: async (rid) => {
    const r = db.prepare('SELECT r.*, c.contact, c.company, c.lang, c.unsubscribed_at cu FROM email_recipients r LEFT JOIN customers c ON c.id = r.customer_id WHERE r.id = ?').get(Number(rid));
    if (!r) throw new Error('收件人不存在');
    if (r.status === 'sent') return '已发送';
    if (r.cu || r.unsubscribed_at) { db.prepare("UPDATE email_recipients SET status = 'skipped' WHERE id = ?").run(r.id); return '已退订，跳过'; }
    const c = getEmailCampaign(r.campaign_id);
    const m = renderEmail(c, r);
    const res = await sendMail(r.email, m.subject, m.text, { html: m.html, headers: m.headers });
    if (res.status === 'failed') { db.prepare("UPDATE email_recipients SET status = 'failed', error = ? WHERE id = ?").run('SMTP', r.id); throw new Error('发送失败（SMTP）'); }
    db.prepare("UPDATE email_recipients SET status = 'sent', sent_at = ?, error = NULL WHERE id = ?").run(now(), r.id);
    return res.status === 'logged' ? '已记录（未配置 SMTP，未真正发出）' : '已发送';
  },
});

/** Send a campaign: freeze the recipient list and queue it in the task center. Returns { taskId, recipients }. */
export function sendEmailCampaign(id) {
  const c = getEmailCampaign(id);
  if (!c) throw new Error('邮件不存在');
  if (c.status !== 'draft') throw new Error('这封邮件已经发送过');
  const people = audienceOf(c.audience);
  if (!people.length) throw new Error('没有符合条件、且同意接收营销邮件的客户');
  const ids = people.map((p) => Number(db.prepare('INSERT INTO email_recipients (campaign_id, customer_id, email, token) VALUES (?,?,?,?)').run(c.id, p.id, p.email, randomBytes(16).toString('base64url')).lastInsertRowid));
  const taskId = createTask({ kind: 'email.campaign', title: `邮件：${c.subject.slice(0, 40)}（${ids.length} 人）`, items: ids.map((rid, i) => ({ key: String(rid), label: people[i].email })) });
  db.prepare("UPDATE email_campaigns SET status = 'sent', sent_at = ?, task_id = ? WHERE id = ?").run(now(), taskId, c.id);
  return { taskId, recipients: ids.length };
}
/** A test message to one address (not counted). */
export async function sendTest(id, to) {
  const c = getEmailCampaign(id);
  if (!c) throw new Error('邮件不存在');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to || ''))) throw new Error('请填写有效的测试邮箱');
  const m = renderEmail(c, { token: 'test', contact: '', lang: c.audience.lang || 'en' });
  return sendMail(to, `[测试] ${m.subject}`, m.text, { html: m.html });
}
export const recipientsOf = (id) => db.prepare('SELECT email, status, error, sent_at, opened_at, opens, unsubscribed_at FROM email_recipients WHERE campaign_id = ? ORDER BY id').all(Number(id));
export function emailStats(id) {
  const r = db.prepare("SELECT COUNT(*) total, SUM(status = 'sent') sent, SUM(status = 'failed') failed, SUM(status = 'skipped') skipped, SUM(opened_at IS NOT NULL) opened, SUM(unsubscribed_at IS NOT NULL) unsub FROM email_recipients WHERE campaign_id = ?").get(Number(id));
  const sent = r.sent || 0;
  return { total: r.total || 0, sent, failed: r.failed || 0, skipped: r.skipped || 0, opened: r.opened || 0, unsubscribed: r.unsub || 0, openRate: sent ? (r.opened || 0) / sent : null };
}

// ---------------------------------------------------------------- public: open pixel and unsubscribe
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
export function recordOpen(token) { db.prepare('UPDATE email_recipients SET opens = opens + 1, opened_at = COALESCE(opened_at, ?) WHERE token = ?').run(now(), token); }
export function unsubscribe(token) {
  const r = db.prepare('SELECT * FROM email_recipients WHERE token = ?').get(token);
  if (!r) return null;
  db.prepare('UPDATE email_recipients SET unsubscribed_at = COALESCE(unsubscribed_at, ?) WHERE id = ?').run(now(), r.id);
  db.prepare('UPDATE customers SET marketing_opt_in = 0, unsubscribed_at = COALESCE(unsubscribed_at, ?) WHERE id = ?').run(now(), r.customer_id);
  return db.prepare('SELECT lang FROM customers WHERE id = ?').get(r.customer_id)?.lang || 'en';
}
export function mountEmailPublic(app) {
  app.get('/m/o/:file', (c) => {
    const token = c.req.param('file').replace(/\.gif$/, '');
    try { recordOpen(token); } catch { /* never break an image */ }
    c.header('content-type', 'image/gif');
    c.header('cache-control', 'no-store');
    return c.body(GIF);
  });
  const done = (c) => {
    const lang = unsubscribe(c.req.param('token'));
    const zh = lang === 'zh';
    const msg = lang == null ? (zh ? '链接无效。' : 'This link is not valid.') : zh ? '已退订，您不会再收到我们的营销邮件。订单和发货通知不受影响。' : 'You have been unsubscribed and will not receive marketing e-mails from us again. Order and shipping e-mails are not affected.';
    return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(config.profile.brand)}</title><body style="font:16px/1.6 sans-serif;max-width:560px;margin:60px auto;padding:0 16px"><h1>${esc(config.profile.brand)}</h1><p>${msg}</p></body>`, lang == null ? 404 : 200);
  };
  app.get('/m/u/:token', done);
  app.post('/m/u/:token', done); // RFC 8058 one-click
}
