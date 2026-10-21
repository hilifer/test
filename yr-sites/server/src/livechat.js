// Live human takeover of website chats. A salesperson replies from the admin; while a person is handling the chat
// the AI stays silent. The takeover lapses after 30 minutes without a staff reply, and the AI answers again.
// The visitor's widget polls for staff messages with its (unguessable) session id.
import { db, addMessage } from './db.js';
import { migrate, addColumn } from './migrate.js';
import { alertOps } from './alerts.js';
import { config } from './config.js';

migrate([{
  id: '2026-10-26-livechat',
  up: () => { for (const [c, t] of [['agent', 'TEXT'], ['agent_name', 'TEXT'], ['agent_at', 'TEXT'], ['waiting', 'INTEGER DEFAULT 0']]) addColumn('conversations', c, t); },
}]);

export const TAKEOVER_MS = 30 * 60e3;
const now = () => new Date().toISOString();
const conv = (id) => db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
const firstName = (s) => String(s || '').trim().split(/\s+/)[0] || 'Sales';

/** Is a person handling this chat right now? Lapsed takeovers are released here. */
export function humanActive(convId) {
  const c = conv(convId);
  if (!c?.agent) return null;
  if (Date.now() - new Date(c.agent_at).getTime() > TAKEOVER_MS) { release(convId, 'timeout'); return null; }
  return { username: c.agent, name: c.agent_name };
}

export function takeOver(convId, user) {
  const c = conv(convId);
  if (!c) throw new Error('对话不存在');
  if (c.agent && c.agent !== user.username && humanActive(convId)) throw new Error(`${c.agent_name || c.agent} 正在接待这位客户`);
  db.prepare('UPDATE conversations SET agent = ?, agent_name = ?, agent_at = ?, handoff = 1 WHERE id = ?').run(user.username, user.name || user.username, now(), convId);
  if (!c.agent) addMessage(convId, 'note', `${firstName(user.name || user.username)} joined the chat`, { by: user.username });
}

export function release(convId, why = 'manual') {
  const c = conv(convId);
  if (!c?.agent) return;
  db.prepare('UPDATE conversations SET agent = NULL, agent_name = NULL, agent_at = NULL, waiting = 0 WHERE id = ?').run(convId);
  const text = { timeout: 'The AI assistant is back. A sales engineer will follow up by e-mail.', rate: 'Thanks for chatting with us. The AI assistant is back — how did we do?' }[why] || 'The AI assistant is back. Ask anything.';
  addMessage(convId, 'note', text, { by: c.agent, why });
}

export function agentReply(convId, user, text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('请输入回复内容');
  if (t.length > 4000) throw new Error('回复太长');
  takeOver(convId, user);
  addMessage(convId, 'agent', t, { by: user.username, name: firstName(user.name || user.username) });
  db.prepare('UPDATE conversations SET agent_at = ?, waiting = 0 WHERE id = ?').run(now(), convId);
}

const lastAlert = new Map();
/** Called by the chat endpoint when the visitor writes while a person is handling the chat. */
export function customerWrote(convId, text) {
  db.prepare('UPDATE conversations SET waiting = 1 WHERE id = ?').run(convId);
  const t = lastAlert.get(convId) || 0;
  if (Date.now() - t > 60e3) {
    lastAlert.set(convId, Date.now());
    alertOps('在线客户发来新消息（人工接待中）', [String(text).slice(0, 200), `${config.publicBaseUrl}/admin/conv/${convId}`]).catch(() => {});
  }
}

/** Messages for the visitor's widget after a message id: staff replies and join/leave notes. */
export function poll(convId, after = 0) {
  const c = conv(convId);
  if (!c) return { human: false, messages: [], lastId: Number(after) || 0 };
  const h = humanActive(convId);
  const rows = db.prepare("SELECT id, role, content, meta, ts FROM messages WHERE conv_id = ? AND id > ? AND role IN ('agent','note') ORDER BY id LIMIT 50").all(convId, Number(after) || 0);
  const lastId = db.prepare('SELECT COALESCE(MAX(id), 0) n FROM messages WHERE conv_id = ?').get(convId).n;
  return {
    human: Boolean(h), agent: h ? firstName(h.name) : null, lastId,
    // a note that ends a person's turn asks the customer to rate the chat (the widget asks once)
    messages: rows.map((m) => { const meta = JSON.parse(m.meta || '{}'); return { id: m.id, role: m.role, content: m.content, ts: m.ts, name: m.role === 'agent' ? meta.name || 'Sales' : undefined, rate: m.role === 'note' && Boolean(meta.why) ? true : undefined }; }),
  };
}

/** For the admin page: everything after a message id. */
export const messagesAfter = (convId, after = 0) => db.prepare('SELECT id, role, content, meta, ts FROM messages WHERE conv_id = ? AND id > ? ORDER BY id').all(convId, Number(after) || 0);
export const waitingCount = () => db.prepare('SELECT COUNT(*) n FROM conversations WHERE waiting = 1 AND agent IS NOT NULL').get().n;
