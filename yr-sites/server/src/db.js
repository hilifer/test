import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, site TEXT, started_at TEXT, updated_at TEXT,
  page TEXT, lang TEXT, ip_hash TEXT, handoff INTEGER DEFAULT 0, handoff_reason TEXT,
  lead_id TEXT, msg_count INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conv_id TEXT, role TEXT, content TEXT, meta TEXT, ts TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conv_id);
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY, site TEXT, created_at TEXT, source TEXT,
  name TEXT, company TEXT, email TEXT, phone TEXT, whatsapp TEXT, country TEXT,
  buyer_type TEXT, needs TEXT, product_id TEXT, quantity INTEGER, timeline TEXT,
  grade TEXT, score INTEGER, reasons TEXT, consent INTEGER, conv_id TEXT, extra TEXT,
  status TEXT DEFAULT 'new', owner TEXT
);
`);

const now = () => new Date().toISOString();
export const hashIp = (ip) => createHash('sha256').update(String(ip) + config.site).digest('hex').slice(0, 16);

export function ensureConversation(id, { page, lang, ip }) {
  const cid = id && /^[\w-]{8,64}$/.test(id) ? id : randomUUID();
  const row = db.prepare('SELECT id FROM conversations WHERE id = ?').get(cid);
  if (!row) db.prepare('INSERT INTO conversations (id, site, started_at, updated_at, page, lang, ip_hash) VALUES (?,?,?,?,?,?,?)').run(cid, config.site, now(), now(), page || '', lang || '', hashIp(ip));
  return cid;
}

export function addMessage(convId, role, content, meta) {
  db.prepare('INSERT INTO messages (conv_id, role, content, meta, ts) VALUES (?,?,?,?,?)').run(convId, role, content, meta ? JSON.stringify(meta) : null, now());
  db.prepare('UPDATE conversations SET updated_at = ?, msg_count = msg_count + 1 WHERE id = ?').run(now(), convId);
}

export function history(convId, limit = 20) {
  return db.prepare('SELECT role, content FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT ?').all(convId, limit).reverse();
}

export function markHandoff(convId, reason) {
  db.prepare('UPDATE conversations SET handoff = 1, handoff_reason = ? WHERE id = ?').run(reason || '', convId);
}

export function insertLead(lead) {
  const id = randomUUID();
  db.prepare(`INSERT INTO leads (id, site, created_at, source, name, company, email, phone, whatsapp, country, buyer_type, needs, product_id, quantity, timeline, grade, score, reasons, consent, conv_id, extra)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, config.site, now(), lead.source || 'chat', lead.name || '', lead.company || '', lead.email || '', lead.phone || '', lead.whatsapp || '',
    lead.country || '', lead.buyer_type || '', lead.needs || '', lead.product_id || '', Number(lead.quantity) || 0, lead.timeline || '',
    lead.grade, lead.score, JSON.stringify(lead.reasons || []), lead.consent ? 1 : 0, lead.conv_id || '', JSON.stringify(lead.extra || {})
  );
  if (lead.conv_id) db.prepare('UPDATE conversations SET lead_id = ? WHERE id = ?').run(id, lead.conv_id);
  return id;
}

export const listLeads = (limit = 200) => db.prepare('SELECT * FROM leads ORDER BY created_at DESC LIMIT ?').all(limit);
export const listConversations = (limit = 100) => db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?').all(limit);
export const conversationMessages = (id) => db.prepare('SELECT role, content, meta, ts FROM messages WHERE conv_id = ? ORDER BY id').all(id);
export const setLeadStatus = (id, status) => db.prepare('UPDATE leads SET status = ? WHERE id = ?').run(status, id);
export function stats() {
  const g = (sql) => db.prepare(sql).get();
  return {
    conversations: g('SELECT COUNT(*) n FROM conversations').n,
    conversations7d: g("SELECT COUNT(*) n FROM conversations WHERE started_at >= datetime('now','-7 days')").n,
    leads: g('SELECT COUNT(*) n FROM leads').n,
    byGrade: db.prepare('SELECT grade, COUNT(*) n FROM leads GROUP BY grade').all(),
    handoffs: g('SELECT COUNT(*) n FROM conversations WHERE handoff = 1').n,
  };
}
