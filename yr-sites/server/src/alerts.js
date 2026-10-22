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

// Who gets an alert besides the group: set by notify/subscriptions.js (per-person subscriptions). Returns
// { group: post to the group?, ids: WeCom user ids to @, mobiles: mobile numbers to @ }.
let routing = null;
export const setAlertRouting = (fn) => { routing = fn; };
async function route(event, info) {
  if (!event || !routing) return { group: true, ids: [], mobiles: [] };
  try { return await routing(event, info); } catch (e) { console.warn('[alert] routing', e.message); return { group: true, ids: [], mobiles: [] }; }
}
/** Group message (markdown) and, when people subscribed, a short text that @-mentions them (WeCom markdown cannot @). */
async function deliver(r, md, title, generic) {
  const a = config.alerts;
  const mention = r.ids.length || r.mobiles.length;
  if (!r.group && !mention) return;
  const jobs = [];
  if (a.wecomWebhook) {
    jobs.push(post(a.wecomWebhook, { msgtype: 'markdown', markdown: { content: md } }));
    if (mention) jobs.push(post(a.wecomWebhook, { msgtype: 'text', text: { content: `${title}（请查看上一条消息）`, mentioned_list: r.ids, mentioned_mobile_list: r.mobiles } }));
  }
  if (a.feishuWebhook) jobs.push(post(a.feishuWebhook, { msg_type: 'text', content: { text: md.replace(/\*\*|> /g, '') } }));
  if (a.genericWebhook) jobs.push(post(a.genericWebhook, { ...generic, recipients: [...r.ids, ...r.mobiles] }));
  await Promise.all(jobs);
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
  const event = handoff ? 'handoff' : `lead_${String(lead.grade || '').toLowerCase()}`;
  const r = await route(event, { title, lines: lines.slice(1), to: lead.owner ? [lead.owner] : null });
  await deliver(r, md, title, { type: handoff ? 'handoff' : 'lead', event, site: config.site, lead, reason });
}

/**
 * Operational alerts for the sales-to-delivery loop (PI accepted, after-sales request, ERP errors…). event names the kind of
 * alert (see notify/subscriptions.js) so people who subscribed are @-mentioned / e-mailed; to = only these people (e.g. the
 * salesperson handling a chat).
 */
export async function alertOps(title, lines = [], { event = null, to = null } = {}) {
  const md = [`**【${config.profile.brand}】${title}**`, ...lines.filter(Boolean).map((l) => `> ${l}`)].join('\n');
  const r = await route(event, { title, lines: lines.filter(Boolean), to });
  await deliver(r, md, `【${config.profile.brand}】${title}`, { type: 'ops', event, site: config.site, title, lines });
}
