// Transactional e-mail. Every message is written to mail_outbox first (so nothing is lost and staff can see
// what was sent); it is delivered over SMTP when SMTP_URL is configured, e.g. smtps://user:pass@smtp.example.com:465
import nodemailer from 'nodemailer';
import { db } from '../db.js';
import { config } from '../config.js';
import './schema.js';

let transport = null;
const smtp = () => process.env.SMTP_URL || '';
const from = () => process.env.MAIL_FROM || `${config.profile.brand} <no-reply@${new URL(config.publicBaseUrl).hostname}>`;

export async function sendMail(to, subject, text) {
  const id = db.prepare('INSERT INTO mail_outbox (to_addr, subject, body, status, created_at) VALUES (?,?,?,?,?)').run(to, subject, text, smtp() ? 'pending' : 'logged', new Date().toISOString()).lastInsertRowid;
  if (!smtp()) return { id, status: 'logged' };
  try {
    transport ||= nodemailer.createTransport(smtp());
    await transport.sendMail({ from: from(), to, subject, text });
    db.prepare("UPDATE mail_outbox SET status = 'sent', sent_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    return { id, status: 'sent' };
  } catch (e) {
    db.prepare("UPDATE mail_outbox SET status = 'failed', error = ? WHERE id = ?").run(String(e.message).slice(0, 500), id);
    return { id, status: 'failed' };
  }
}
export const outbox = (n = 50) => db.prepare('SELECT * FROM mail_outbox ORDER BY id DESC LIMIT ?').all(n);
