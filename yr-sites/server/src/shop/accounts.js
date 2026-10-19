// Shop customer accounts: register, e-mail verification, login (with lockout), password reset, sessions, addresses.
// Existing B2B customers (created from leads / PIs) claim their account through an e-mailed link, so nobody can
// see someone else's orders just by registering with their address.
import { randomBytes } from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { hashPassword, verifyPassword } from '../auth.js';
import { findOrCreateCustomer, getCustomer } from '../ops/service.js';
import { sendMail } from './mailer.js';
import './schema.js';

const now = () => new Date().toISOString();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_IDLE_MS = 30 * 864e5;
const LOCK_FAILS = 5, LOCK_MS = 15 * 60e3;

const checkPw = verifyPassword;
export function passwordProblem(pw, lang = 'en') {
  const zh = lang === 'zh';
  if (String(pw).length < 8) return zh ? '密码至少 8 位' : 'Password must be at least 8 characters';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return zh ? '密码需包含字母和数字' : 'Password must contain letters and numbers';
  return null;
}
const byEmail = (email) => db.prepare('SELECT * FROM customers WHERE lower(email) = ?').get(String(email || '').trim().toLowerCase());

function issueToken(customerId, purpose, ttlMs) {
  const token = randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO customer_tokens (token, customer_id, purpose, expires_at) VALUES (?,?,?,?)').run(token, customerId, purpose, Date.now() + ttlMs);
  return token;
}
function useToken(token, purpose) {
  const t = db.prepare('SELECT * FROM customer_tokens WHERE token = ? AND purpose = ?').get(String(token || ''), purpose);
  if (!t || t.used || t.expires_at < Date.now()) return null;
  db.prepare('UPDATE customer_tokens SET used = 1 WHERE token = ?').run(t.token);
  return getCustomer(t.customer_id);
}
const link = (path) => `${config.publicBaseUrl}${path}`;

/** Returns { customer } for a new account, or { emailSent: true } when the address already belongs to a customer. */
export async function register({ email, password, name = '', company = '', country = '', marketing = false, lang = 'en' }) {
  const zh = lang === 'zh';
  email = String(email || '').trim().toLowerCase();
  if (!EMAIL.test(email)) throw new Error(zh ? '请填写有效的邮箱' : 'Please enter a valid e-mail address');
  const p = passwordProblem(password, lang);
  if (p) throw new Error(p);
  const existing = byEmail(email);
  if (existing) {
    // never reveal whether the address exists; the owner gets a link to (re)set the password
    const t = issueToken(existing.id, 'reset', 24 * 3600e3);
    await sendMail(email, `${config.profile.brand}: set your password`, `Someone asked to create an account for ${email}. If it was you, set your password here (valid 24 hours):\n${link(`/shop/account/reset?t=${t}`)}\n\nIf not, ignore this e-mail.`);
    return { emailSent: true };
  }
  const c = findOrCreateCustomer({ email, contact: name, company, country, lang });
  db.prepare("UPDATE customers SET pw_hash = ?, source = 'shop', marketing_opt_in = ?, email_verified = 0 WHERE id = ?").run(hashPassword(password), marketing ? 1 : 0, c.id);
  const t = issueToken(c.id, 'verify', 7 * 864e5);
  await sendMail(email, `${config.profile.brand}: confirm your e-mail`, `Welcome! Please confirm your e-mail address:\n${link(`/shop/account/verify?t=${t}`)}`);
  return { customer: getCustomer(c.id) };
}

export const verifyEmail = (token) => { const c = useToken(token, 'verify'); if (c) db.prepare('UPDATE customers SET email_verified = 1 WHERE id = ?').run(c.id); return c; };

function lockedFor(key) {
  const rows = db.prepare('SELECT ok, ts FROM login_attempts WHERE key = ? AND ts > ? ORDER BY id DESC').all(key, Date.now() - LOCK_MS);
  let fails = 0;
  for (const r of rows) { if (r.ok) break; fails++; }
  return fails >= LOCK_FAILS ? Math.max(0, rows[LOCK_FAILS - 1].ts + LOCK_MS - Date.now()) : 0;
}
export function login(email, password, ip, lang = 'en') {
  const zh = lang === 'zh';
  const keys = [`c:${String(email).toLowerCase()}`, `cip:${ip}`];
  const lock = Math.max(...keys.map(lockedFor));
  if (lock) return { error: zh ? `尝试次数过多，请 ${Math.ceil(lock / 60000)} 分钟后再试` : `Too many attempts. Try again in ${Math.ceil(lock / 60000)} min.`, locked: true };
  const c = byEmail(email);
  const ok = Boolean(c?.pw_hash && checkPw(password, c.pw_hash));
  for (const k of keys) db.prepare('INSERT INTO login_attempts (key, ts, ok) VALUES (?,?,?)').run(k, Date.now(), ok ? 1 : 0);
  return ok ? { customer: c } : { error: zh ? '邮箱或密码错误' : 'Wrong e-mail or password' };
}

export async function requestReset(email) {
  const c = byEmail(email);
  if (c) {
    const t = issueToken(c.id, 'reset', 3600e3);
    await sendMail(c.email, `${config.profile.brand}: reset your password`, `Reset your password here (valid 1 hour):\n${link(`/shop/account/reset?t=${t}`)}\n\nIf you did not ask for this, ignore this e-mail.`);
  }
  return true; // same answer whether or not the address exists
}
export function resetPassword(token, password, lang = 'en') {
  const p = passwordProblem(password, lang);
  if (p) throw new Error(p);
  const c = useToken(token, 'reset');
  if (!c) throw new Error(lang === 'zh' ? '链接无效或已过期' : 'This link is invalid or has expired');
  db.prepare("UPDATE customers SET pw_hash = ?, email_verified = 1, source = COALESCE(source, 'shop') WHERE id = ?").run(hashPassword(password), c.id);
  db.prepare('DELETE FROM customer_sessions WHERE customer_id = ?').run(c.id);
  return getCustomer(c.id);
}

export function createSession(customer) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO customer_sessions (token, customer_id, created_at, last_seen) VALUES (?,?,?,?)').run(token, customer.id, now(), Date.now());
  return token;
}
export function sessionCustomer(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM customer_sessions WHERE token = ?').get(token);
  if (!s || Date.now() - s.last_seen > SESSION_IDLE_MS) { if (s) db.prepare('DELETE FROM customer_sessions WHERE token = ?').run(token); return null; }
  db.prepare('UPDATE customer_sessions SET last_seen = ? WHERE token = ?').run(Date.now(), token);
  return getCustomer(s.customer_id);
}
export const endSession = (token) => db.prepare('DELETE FROM customer_sessions WHERE token = ?').run(token || '');

// ---- addresses (always scoped to the customer) ----
const ADDR = ['name', 'company', 'phone', 'line1', 'line2', 'city', 'state', 'postcode', 'country'];
export function validateAddress(a, lang = 'en') {
  const zh = lang === 'zh';
  const x = Object.fromEntries(ADDR.map((k) => [k, String(a[k] ?? '').trim().slice(0, 200)]));
  x.country = x.country.toUpperCase();
  const errors = [];
  if (!x.name) errors.push(zh ? '收件人必填' : 'Name is required');
  if (!x.line1) errors.push(zh ? '地址必填' : 'Address is required');
  if (!x.city) errors.push(zh ? '城市必填' : 'City is required');
  if (!/^[A-Z]{2}$/.test(x.country)) errors.push(zh ? '请选择国家' : 'Please choose a country');
  if (!x.phone) errors.push(zh ? '电话必填（物流公司需要）' : 'Phone is required by the carrier');
  if (errors.length) throw Object.assign(new Error(errors.join(zh ? '；' : '; ')), { errors });
  return x;
}
export const listAddresses = (cid) => db.prepare('SELECT * FROM addresses WHERE customer_id = ? ORDER BY is_default DESC, id DESC').all(cid);
export const getAddress = (cid, id) => db.prepare('SELECT * FROM addresses WHERE customer_id = ? AND id = ?').get(cid, Number(id));
export function saveAddress(cid, a, lang) {
  const x = validateAddress(a, lang);
  if (a.is_default || !listAddresses(cid).length) db.prepare('UPDATE addresses SET is_default = 0 WHERE customer_id = ?').run(cid);
  const def = a.is_default || !listAddresses(cid).length ? 1 : 0;
  if (a.id) {
    if (!getAddress(cid, a.id)) throw new Error('not found');
    db.prepare(`UPDATE addresses SET ${ADDR.map((k) => `${k} = @${k}`).join(', ')}, is_default = MAX(is_default, @def) WHERE id = @id AND customer_id = @cid`).run({ ...x, def, id: Number(a.id), cid });
    return getAddress(cid, a.id);
  }
  const r = db.prepare(`INSERT INTO addresses (customer_id, ${ADDR.join(', ')}, is_default, created_at) VALUES (@cid, ${ADDR.map((k) => '@' + k).join(', ')}, @def, @ts)`).run({ ...x, cid, def, ts: now() });
  return getAddress(cid, r.lastInsertRowid);
}
export const deleteAddress = (cid, id) => db.prepare('DELETE FROM addresses WHERE customer_id = ? AND id = ?').run(cid, Number(id));
