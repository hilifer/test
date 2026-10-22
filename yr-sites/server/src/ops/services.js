// External services (服务连通性): one-click test of every service the site depends on — language model, Kingdee,
// Stripe, PayPal, 17TRACK, e-mail, WeCom / Feishu alerts, the HTTPS certificate, and the other site. Each check records
// its result, so the page shows the last success and the last failure. A daily job re-checks everything and alerts
// when a service that worked starts failing.
import tls from 'node:tls';
import { db } from '../db.js';
import { config, aiEnabled } from '../config.js';
import { migrate } from '../migrate.js';
import { alertOps } from '../alerts.js';
import { complete } from '../llm.js';
import { adapter, testConnection, erpLabel } from './erp/index.js';
import { registerJob, dailyAt } from '../jobs.js';

migrate([{
  id: '2026-11-04-service-checks',
  up: () => db.exec(`CREATE TABLE service_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, service TEXT NOT NULL, ts TEXT, ok INTEGER, level TEXT, ms INTEGER, detail TEXT, by TEXT);
    CREATE INDEX service_checks_service ON service_checks(service, id);`),
}]);
const env = (k, d = '') => process.env[k] || d;
const T = 15000;
async function http(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(T) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, ok: r.ok, json, text };
}

/** Other sites to watch, e.g. PEER_SITES="grid|https://yrgrid.com,led|https://yaorong-led.com" (same OPS_TOKEN on each). */
export const peerSites = () => env('PEER_SITES').split(',').map((s) => s.trim()).filter(Boolean).map((s) => { const [name, url] = s.includes('|') ? s.split('|') : [s, s]; return { name: name.trim(), url: url.trim().replace(/\/$/, '') }; });
/** Health details of a site (ours or a peer) — needs the shared OPS_TOKEN for the details. */
export async function peerHealth(url) {
  const t0 = Date.now();
  const r = await http(`${url}/api/health?detail=1`, { headers: env('OPS_TOKEN') ? { 'x-ops-token': env('OPS_TOKEN') } : {} });
  if (!r.ok || !r.json?.ok) throw new Error(`HTTP ${r.status}`);
  return { ...r.json, ms: Date.now() - t0 };
}

export const SERVICES = [
  { id: 'llm', name: '大模型', configured: aiEnabled, setting: 'LLM_PROVIDER / LLM_API_KEY / LLM_MODEL',
    check: async () => { const out = await complete({ system: 'Reply with the single word OK.', user: 'ping', maxTokens: 5 }); return `${config.llm.provider} / ${config.llm.model} 回复：${String(out).trim().slice(0, 20) || '（空）'}`; } },
  { id: 'erp', name: '金蝶 ERP', configured: () => Boolean(adapter()) && config.erp.mode !== 'local', setting: 'ERP_MODE / KD_*',
    check: async () => { const r = await testConnection(); if (r && r.ok === false) throw new Error(r.message || r.error || '连接失败'); return `${erpLabel()}：${typeof r === 'string' ? r : r?.message || '连接成功'}`; } },
  { id: 'stripe', name: 'Stripe', configured: () => Boolean(env('STRIPE_SECRET_KEY')), setting: 'STRIPE_SECRET_KEY',
    check: async () => { const r = await http(`${env('STRIPE_API_BASE', 'https://api.stripe.com')}/v1/balance`, { headers: { authorization: `Bearer ${env('STRIPE_SECRET_KEY')}` } }); if (!r.ok) throw new Error(`HTTP ${r.status} ${r.json?.error?.message || ''}`.trim()); return `密钥有效（${r.json?.livemode ? '正式' : '测试'}模式）${env('STRIPE_WEBHOOK_SECRET') ? '' : '；未配置 STRIPE_WEBHOOK_SECRET，付款结果无法回传'}`; } },
  { id: 'paypal', name: 'PayPal', configured: () => Boolean(env('PAYPAL_CLIENT_ID') && env('PAYPAL_CLIENT_SECRET')), setting: 'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET',
    check: async () => { const base = env('PAYPAL_API_BASE', 'https://api-m.sandbox.paypal.com'); const r = await http(`${base}/v1/oauth2/token`, { method: 'POST', body: 'grant_type=client_credentials', headers: { authorization: 'Basic ' + Buffer.from(`${env('PAYPAL_CLIENT_ID')}:${env('PAYPAL_CLIENT_SECRET')}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' } }); if (!r.ok || !r.json?.access_token) throw new Error(`HTTP ${r.status} ${r.json?.error_description || ''}`.trim()); return `授权成功（${/sandbox/.test(base) ? '沙箱' : '正式'}环境）`; } },
  { id: 'track17', name: '17TRACK 物流', configured: () => Boolean(env('TRACK17_KEY')), setting: 'TRACK17_KEY',
    check: async () => { const r = await http(`${env('TRACK17_API_BASE', 'https://api.17track.net').replace(/\/$/, '')}/track/v2.2/getquota`, { method: 'POST', body: '{}', headers: { '17token': env('TRACK17_KEY'), 'content-type': 'application/json' } }); if (!r.ok || (r.json && r.json.code !== 0 && r.json.code != null)) throw new Error(`HTTP ${r.status} ${r.json?.data?.errors?.[0]?.message || ''}`.trim()); const d = r.json?.data || {}; return d.quota_remain != null ? `剩余查询额度 ${d.quota_remain} / ${d.quota_total ?? '?'}` : '密钥有效'; } },
  { id: 'mail', name: '邮件发送（SMTP）', configured: () => Boolean(env('SMTP_URL')), setting: 'SMTP_URL',
    check: async () => { const { default: nodemailer } = await import('nodemailer'); const t = nodemailer.createTransport(env('SMTP_URL'), { connectionTimeout: T, greetingTimeout: T }); try { await t.verify(); } finally { t.close(); } return `已连接 ${new URL(env('SMTP_URL')).hostname}`; } },
  { id: 'wecom', name: '企业微信提醒', configured: () => Boolean(config.alerts.wecomWebhook), setting: 'WECOM_WEBHOOK_URL',
    check: async () => { const r = await http(config.alerts.wecomWebhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msgtype: 'text', text: { content: `【${config.profile.brand}】后台连通性测试，收到即正常` } }) }); if (!r.ok || (r.json && r.json.errcode !== 0)) throw new Error(`HTTP ${r.status} ${r.json?.errmsg || ''}`.trim()); return '测试消息已发送到群'; } },
  { id: 'feishu', name: '飞书提醒', configured: () => Boolean(config.alerts.feishuWebhook), setting: 'FEISHU_WEBHOOK_URL',
    check: async () => { const r = await http(config.alerts.feishuWebhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msg_type: 'text', content: { text: `【${config.profile.brand}】后台连通性测试` } }) }); if (!r.ok || (r.json && (r.json.code ?? r.json.StatusCode ?? 0) !== 0)) throw new Error(`HTTP ${r.status} ${r.json?.msg || ''}`.trim()); return '测试消息已发送'; } },
  { id: 'https', name: 'HTTPS 证书', configured: () => config.publicBaseUrl.startsWith('https://'), setting: 'PUBLIC_BASE_URL（https）',
    check: () => new Promise((resolve, reject) => {
      const u = new URL(config.publicBaseUrl);
      const s = tls.connect({ host: u.hostname, port: Number(u.port || 443), servername: u.hostname, timeout: T }, () => {
        const c = s.getPeerCertificate(); s.end();
        if (!c?.valid_to) return reject(new Error('读不到证书'));
        const days = Math.floor((Date.parse(c.valid_to) - Date.now()) / 86400e3);
        const msg = `${u.hostname} 证书到期 ${new Date(c.valid_to).toISOString().slice(0, 10)}（剩 ${days} 天）`;
        if (days < 0) reject(new Error(`证书已过期：${msg}`)); else resolve(days < 14 ? { warn: true, text: msg } : msg);
      });
      s.on('error', (e) => reject(new Error(`连接失败：${e.message}`))); s.on('timeout', () => { s.destroy(); reject(new Error('连接超时')); });
    }) },
  ...peerSites().map((p) => ({ id: `peer:${p.name}`, name: `站点 ${p.name}`, configured: () => true, setting: 'PEER_SITES',
    check: async () => { const h = await peerHealth(p.url); return `在线 · ${h.version ? `版本 ${h.version} · ` : ''}${h.ms} ms${h.backup ? ` · 最近备份 ${h.backup.ok ? '成功' : '失败'}` : ''}${h.errors24h != null ? ` · 24 小时错误 ${h.errors24h}` : ''}`; } })),
];

export function lastChecks(id) {
  const last = db.prepare('SELECT * FROM service_checks WHERE service = ? ORDER BY id DESC LIMIT 1').get(id) || null;
  const lastOk = db.prepare('SELECT * FROM service_checks WHERE service = ? AND ok = 1 ORDER BY id DESC LIMIT 1').get(id) || null;
  const lastFail = db.prepare('SELECT * FROM service_checks WHERE service = ? AND ok = 0 ORDER BY id DESC LIMIT 1').get(id) || null;
  return { last, lastOk, lastFail };
}
export const serviceList = () => SERVICES.map((s) => ({ id: s.id, name: s.name, setting: s.setting, configured: Boolean(s.configured()), ...lastChecks(s.id) }));

/** Check one service; records and returns { ok, level, ms, detail }. */
export async function checkService(id, by = 'system') {
  const s = SERVICES.find((x) => x.id === id);
  if (!s) throw new Error('未知的服务');
  if (!s.configured()) throw new Error(`${s.name}未配置（${s.setting}）`);
  const before = lastChecks(id).last;
  const t0 = Date.now();
  let ok = 1, level = 'ok', detail;
  try { const r = await s.check(); if (r && typeof r === 'object') { level = r.warn ? 'warn' : 'ok'; detail = r.text; } else detail = String(r ?? 'ok'); }
  catch (e) { ok = 0; level = 'fail'; detail = String(e?.cause?.code || e?.message || e).slice(0, 300); }
  const ms = Date.now() - t0;
  db.prepare('INSERT INTO service_checks (service, ts, ok, level, ms, detail, by) VALUES (?,?,?,?,?,?,?)').run(id, new Date().toISOString(), ok, level, ms, detail, by);
  if (!ok && (!before || before.ok)) alertOps(`外部服务异常：${s.name}`, [detail], { event: 'service_down' }).catch(() => {});
  if (level === 'warn' && before?.level !== 'warn') alertOps(`需要处理：${s.name}`, [detail], { event: 'service_down' }).catch(() => {});
  return { ok: Boolean(ok), level, ms, detail };
}
export async function checkAll(by = 'system') {
  const out = {};
  for (const s of SERVICES) if (s.configured()) out[s.id] = await checkService(s.id, by);
  return out;
}
/** Services whose latest check failed or warns (for the workbench). */
export const failingServices = () => serviceList().filter((s) => s.configured && s.last && s.last.level !== 'ok');

export function startServiceChecks() {
  registerJob({ id: 'service-checks', name: '外部服务连通性检查', schedule: dailyAt(8), run: async () => { const r = await checkAll(); const bad = Object.entries(r).filter(([, v]) => !v.ok); return bad.length ? `异常：${bad.map(([k]) => k).join('、')}` : `全部正常（${Object.keys(r).length} 项）`; } });
}
