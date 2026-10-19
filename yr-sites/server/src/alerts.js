import { config } from './config.js';

const ORDER = { A: 4, B: 3, C: 2, D: 1 };

async function post(url, body) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    if (!r.ok) console.warn('[alert] webhook', r.status);
  } catch (e) {
    console.warn('[alert] failed', e.message);
  }
}

/** Notify sales when a lead is at/above the configured grade, or when a human is requested. */
export async function alertLead(lead, { handoff = false, reason = '' } = {}) {
  const a = config.alerts;
  if (!handoff && (ORDER[lead.grade] || 0) < (ORDER[a.minGrade] || 3)) return;
  const brand = config.profile.brand;
  const title = handoff ? `【${brand}】客户请求人工` : `【${brand}】新${lead.grade}级线索`;
  const lines = [
    `**${title}**`,
    lead.company || lead.name ? `> 客户：${[lead.name, lead.company].filter(Boolean).join(' / ')}` : '',
    lead.country ? `> 国家：${lead.country}` : '',
    lead.email ? `> 邮箱：${lead.email}` : '',
    lead.whatsapp || lead.phone ? `> 电话/WhatsApp：${lead.whatsapp || lead.phone}` : '',
    lead.product_id ? `> 产品：${lead.product_id}` : '',
    lead.quantity ? `> 数量：${lead.quantity}` : '',
    lead.timeline ? `> 采购时间：${lead.timeline}` : '',
    lead.needs ? `> 需求：${String(lead.needs).slice(0, 300)}` : '',
    reason ? `> 转人工原因：${reason}` : '',
    lead.reasons?.length ? `> 评级依据：${lead.reasons.join('，')}` : '',
    `> 后台：${config.publicBaseUrl}/admin`,
  ].filter(Boolean);
  const md = lines.join('\n');
  const jobs = [];
  if (a.wecomWebhook) jobs.push(post(a.wecomWebhook, { msgtype: 'markdown', markdown: { content: md } }));
  if (a.feishuWebhook) jobs.push(post(a.feishuWebhook, { msg_type: 'text', content: { text: md.replace(/\*\*|> /g, '') } }));
  if (a.genericWebhook) jobs.push(post(a.genericWebhook, { type: handoff ? 'handoff' : 'lead', site: config.site, lead, reason }));
  await Promise.all(jobs);
}

/** Operational alerts for the sales-to-delivery loop (PI accepted, after-sales request, ERP errors…). */
export async function alertOps(title, lines = []) {
  const a = config.alerts;
  const md = [`**【${config.profile.brand}】${title}**`, ...lines.filter(Boolean).map((l) => `> ${l}`)].join('\n');
  const jobs = [];
  if (a.wecomWebhook) jobs.push(post(a.wecomWebhook, { msgtype: 'markdown', markdown: { content: md } }));
  if (a.feishuWebhook) jobs.push(post(a.feishuWebhook, { msg_type: 'text', content: { text: md.replace(/\*\*|> /g, '') } }));
  if (a.genericWebhook) jobs.push(post(a.genericWebhook, { type: 'ops', site: config.site, title, lines }));
  await Promise.all(jobs);
}
