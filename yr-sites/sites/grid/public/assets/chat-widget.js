// YR AI sales chat widget — framework-free ES module shared by both sites.
// Config: window.YR_CHAT = { api, leadsApi, catalogUrl, lang, brand, greeting, suggestions, quotePath }
// Open from anywhere: <button data-chat-open data-chat-prompt="...">.
// If the API is unreachable (static preview / outage) it falls back to the rule engine in the browser.

const cfg = Object.assign({ api: '/api/chat', leadsApi: '/api/leads', catalogUrl: '/products.json', lang: 'en', brand: 'Sales', suggestions: [] }, window.YR_CHAT || {});
const zh = cfg.lang === 'zh';
const T = zh
  ? { title: `${cfg.brand} 销售助手`, sub: 'AI 助手 · 7×24 在线', placeholder: '输入您的需求，例如功率、数量、目的地…', send: '发送', close: '关闭', disclose: '您正在与 AI 助手对话。价格均为参考区间，以正式 PI 为准。', human: '转人工', moq: '起订', view: '查看产品', ref: '参考价', total: '合计约', lead: '留下联系方式，业务工程师会发送正式报价', name: '姓名', company: '公司', email: '邮箱', wa: 'WhatsApp / 电话', country: '国家/地区', consent: '我同意贵司通过邮箱或电话与我联系', submit: '提交', thanks: '已收到，业务工程师会尽快联系您。', err: '网络不稳定，请稍后再试。', preview: '预览模式：使用内置规则答复', need: '请填写邮箱或 WhatsApp，并勾选同意。', typing: '正在输入', qty: '数量', unitp: '单价', term: '贸易条款', lt: '交期', days: '天', staff: '人工客服', staffOn: '人工客服在线' }
  : { title: `${cfg.brand} Sales Assistant`, sub: 'AI assistant · replies 24/7', placeholder: 'Describe what you need — wattage, quantity, destination…', send: 'Send', close: 'Close', disclose: "You're chatting with an AI assistant. Prices are reference ranges, subject to a formal PI.", human: 'Talk to a person', moq: 'MOQ', view: 'View product', ref: 'Reference price', total: 'Total approx.', lead: 'Leave your details and a sales engineer will send a formal quotation', name: 'Name', company: 'Company', email: 'Email', wa: 'WhatsApp / phone', country: 'Country', consent: 'I agree to be contacted by email or phone', submit: 'Send my details', thanks: 'Thanks — a sales engineer will be in touch shortly.', err: 'Connection problem. Please try again.', preview: 'Preview mode: answering with built-in rules', need: 'Add an email or WhatsApp number and tick the consent box.', typing: 'Typing', qty: 'Qty', unitp: 'Unit price', term: 'Term', lt: 'Lead time', days: 'days', staff: 'sales team (human)', staffOn: 'a person is replying' };

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('yrchat:' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('yrchat:' + k, JSON.stringify(v)); } catch {} },
};

let sessionId = store.get('sid');
let transcript = store.get('log') || [];
let offline = null; // {engine, catalog} once loaded
let busy = false;
let lastSeen = store.get('last') || 0; // last staff message shown
let pollTimer = null;

const css = `
.yrc-launch{position:fixed;right:20px;bottom:20px;z-index:9998;display:flex;align-items:center;gap:10px;padding:12px 18px 12px 14px;border:0;border-radius:999px;background:var(--chat-accent,#123);color:var(--chat-on-accent,#fff);font:600 15px/1 var(--chat-font,system-ui);box-shadow:0 6px 24px rgba(10,20,30,.25);cursor:pointer}
.yrc-launch:focus-visible,.yrc button:focus-visible,.yrc input:focus-visible,.yrc textarea:focus-visible{outline:3px solid var(--chat-focus,#4a90e2);outline-offset:2px}
.yrc-dot{width:10px;height:10px;border-radius:50%;background:var(--chat-live,#4caf50);box-shadow:0 0 0 3px rgba(255,255,255,.25)}
.yrc{position:fixed;right:20px;bottom:20px;z-index:9999;width:min(400px,calc(100vw - 24px));height:min(640px,calc(100vh - 40px));display:none;flex-direction:column;background:var(--chat-bg,#fff);color:var(--chat-ink,#1b2430);border-radius:16px;box-shadow:0 18px 60px rgba(10,20,30,.3);overflow:hidden;font:15px/1.5 var(--chat-font,system-ui)}
.yrc.open{display:flex}
.yrc.inline{position:relative;right:auto;bottom:auto;width:100%;height:560px;display:flex;box-shadow:none;border:1px solid var(--chat-line,#dde3e8);z-index:1}
.yrc-head{display:flex;align-items:center;gap:10px;padding:14px 16px;background:var(--chat-accent,#123);color:var(--chat-on-accent,#fff)}
.yrc-head b{display:block;font-size:15px}.yrc-head small{opacity:.8;font-size:12px}
.yrc-head .yrc-x{margin-left:auto;background:transparent;border:0;color:inherit;font-size:22px;line-height:1;cursor:pointer;padding:4px 8px;border-radius:6px}
.yrc.inline .yrc-x{display:none}
.yrc-log{flex:1;overflow-y:auto;padding:14px 14px 4px;display:flex;flex-direction:column;gap:10px;background:var(--chat-log,#f6f8fa)}
.yrc-note{font-size:12px;color:var(--chat-mute,#5f6b77);text-align:center;padding:2px 10px}
.yrc-m{max-width:88%;padding:9px 12px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}
.yrc-m.bot{background:var(--chat-bg,#fff);border:1px solid var(--chat-line,#dde3e8);border-top-left-radius:4px;align-self:flex-start}
.yrc-m.agent{background:#eaf6ec;border:1px solid #b9dfc0;border-top-left-radius:4px;align-self:flex-start}.yrc-m.agent b{display:block;font-size:12px;color:#2e6b3a;margin-bottom:2px}
.yrc-m.me{background:var(--chat-accent,#123);color:var(--chat-on-accent,#fff);border-top-right-radius:4px;align-self:flex-end}
.yrc-cards{display:flex;flex-direction:column;gap:8px;align-self:stretch}
.yrc-card{display:block;background:var(--chat-bg,#fff);border:1px solid var(--chat-line,#dde3e8);border-left:4px solid var(--chat-accent2,var(--chat-accent,#123));border-radius:10px;padding:10px 12px;text-decoration:none;color:inherit}
.yrc-card b{display:block}.yrc-card span{display:block;font-size:13px;color:var(--chat-mute,#5f6b77)}
.yrc-card em{font-style:normal;font-size:13px;font-weight:600;color:var(--chat-link,#0b5cad)}
.yrc-quote{background:var(--chat-bg,#fff);border:1px solid var(--chat-line,#dde3e8);border-radius:10px;padding:10px 12px;font-size:14px;align-self:stretch}
.yrc-quote dl{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:6px 0 0}.yrc-quote dt{color:var(--chat-mute,#5f6b77)}.yrc-quote dd{margin:0;font-weight:600;font-variant-numeric:tabular-nums}
.yrc-lead{background:var(--chat-bg,#fff);border:1px solid var(--chat-line,#dde3e8);border-radius:10px;padding:12px;display:grid;gap:8px;align-self:stretch}
.yrc-lead p{margin:0;font-size:14px;font-weight:600}
.yrc-lead input[type=text],.yrc-lead input[type=email]{width:100%;padding:8px 10px;border:1px solid var(--chat-line,#cfd6dc);border-radius:8px;font:inherit;font-size:14px;background:var(--chat-bg,#fff);color:inherit}
.yrc-lead label.c{display:flex;gap:8px;font-size:13px;align-items:flex-start}
.yrc-lead .row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.yrc-btn{padding:9px 14px;border:0;border-radius:8px;background:var(--chat-accent,#123);color:var(--chat-on-accent,#fff);font:600 14px/1.2 var(--chat-font,system-ui);cursor:pointer}
.yrc-chips{display:flex;flex-wrap:wrap;gap:6px;padding:4px 14px 8px;background:var(--chat-log,#f6f8fa)}
.yrc-chip{border:1px solid var(--chat-line,#cfd6dc);background:var(--chat-bg,#fff);color:inherit;border-radius:999px;padding:5px 11px;font:13px/1.3 var(--chat-font,system-ui);cursor:pointer;text-align:left}
.yrc-foot{display:flex;gap:8px;padding:10px;border-top:1px solid var(--chat-line,#dde3e8);background:var(--chat-bg,#fff)}
.yrc-foot textarea{flex:1;resize:none;border:1px solid var(--chat-line,#cfd6dc);border-radius:10px;padding:9px 11px;font:inherit;font-size:14px;max-height:120px;background:var(--chat-bg,#fff);color:inherit}
.yrc-typing{align-self:flex-start;color:var(--chat-mute,#5f6b77);font-size:13px;padding:4px 8px}
.yrc-typing i{display:inline-block;width:5px;height:5px;margin-left:3px;border-radius:50%;background:currentColor;animation:yrcb 1s infinite}.yrc-typing i:nth-child(2){animation-delay:.15s}.yrc-typing i:nth-child(3){animation-delay:.3s}
@keyframes yrcb{0%,80%,100%{opacity:.25}40%{opacity:1}}
@media (prefers-reduced-motion:reduce){.yrc-typing i{animation:none}}
@media (max-width:520px){.yrc:not(.inline){right:0;bottom:0;width:100vw;height:100dvh;border-radius:0}.yrc-launch{right:12px;bottom:12px}}
`;

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(String(k)));
  return n;
}
const money = (c, n) => `${c === 'USD' ? 'US$' : c + ' '}${Number(n).toLocaleString('en-US')}`;

function build(container) {
  const inline = !!container;
  const box = el('section', { class: 'yrc' + (inline ? ' inline' : ''), role: inline ? 'region' : 'dialog', 'aria-label': T.title });
  const log = el('div', { class: 'yrc-log', 'aria-live': 'polite' });
  const chips = el('div', { class: 'yrc-chips' });
  const sub = el('small', {}, T.sub);
  const ta = el('textarea', { rows: 1, placeholder: T.placeholder, 'aria-label': T.placeholder });
  const sendBtn = el('button', { class: 'yrc-btn', type: 'submit' }, T.send);
  const form = el('form', { class: 'yrc-foot' }, ta, sendBtn);
  box.append(
    el('header', { class: 'yrc-head' }, el('span', { class: 'yrc-dot', 'aria-hidden': 'true' }), el('div', {}, el('b', {}, T.title), sub), el('button', { class: 'yrc-x', type: 'button', 'aria-label': T.close, onclick: () => close() }, '×')),
    log, chips, form
  );
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', (e) => { e.preventDefault(); const v = ta.value.trim(); if (v) { ta.value = ''; send(v); } });
  if (!inline) box.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  (container || document.body).append(box);
  return { box, log, chips, ta, sub };
}

let ui; // the active widget (launcher dialog or inline instance)
let launcher;

function renderChips() {
  ui.chips.replaceChildren(...(transcript.length > 2 ? [] : cfg.suggestions).map((s) => el('button', { class: 'yrc-chip', type: 'button', onclick: () => send(s) }, s)), el('button', { class: 'yrc-chip', type: 'button', onclick: () => send(zh ? '我想和业务员沟通' : 'I would like to talk to a sales engineer') }, T.human));
}

function addBot(r, save = true) {
  if (r.human) { live(true); return; } // a person is handling the chat: their replies arrive by polling
  if (r.handoff) live(true);
  if (!r.reply) return;
  ui.log.append(el('div', { class: 'yrc-m bot' }, r.reply));
  if (r.products?.length)
    ui.log.append(el('div', { class: 'yrc-cards' }, r.products.map((p) => el('a', { class: 'yrc-card', href: p.url }, el('b', {}, p.name), el('span', {}, p.summary), p.highlights?.length ? el('span', {}, p.highlights.join(' · ')) : null, el('em', {}, `${T.moq} ${p.moq} ${p.unit} — ${T.view}`)))));
  if (r.quote?.ok) {
    const q = r.quote;
    ui.log.append(el('div', { class: 'yrc-quote' }, el('b', {}, `${T.ref}: ${(zh && r.products?.[0]?.name) || q.productName}`), el('dl', {},
      el('dt', {}, T.qty), el('dd', {}, `${q.quantity} ${q.unit}`),
      el('dt', {}, T.unitp), el('dd', {}, `${money(q.currency, q.unitPrice.low)} – ${money(q.currency, q.unitPrice.high)}`),
      el('dt', {}, T.total), el('dd', {}, `${money(q.currency, q.total.low)} – ${money(q.currency, q.total.high)}`),
      el('dt', {}, T.term), el('dd', {}, q.term),
      el('dt', {}, T.lt), el('dd', {}, `${q.leadTimeDays[0]}–${q.leadTimeDays[1]} ${T.days}`)), el('span', { class: 'yrc-note', style: 'display:block;text-align:left;padding:4px 0 0' }, zh ? '以上仅供参考，以正式 PI 为准。' : q.note)));
  }
  if (r.link) ui.log.append(el('a', { class: 'yrc-card', href: r.link.href }, el('em', {}, r.link.label)));
  if (r.askLead && !store.get('leadSent')) ui.log.append(leadCard(r));
  if (save) { transcript.push({ role: 'assistant', content: r.reply, r }); persist(); }
  ui.log.scrollTop = ui.log.scrollHeight;
}

function leadCard(r) {
  const f = el('form', { class: 'yrc-lead' });
  const inp = (name, ph, type = 'text', req) => el('input', { name, placeholder: ph, type, 'aria-label': ph, autocomplete: { name: 'name', email: 'email', company: 'organization', country: 'country-name', whatsapp: 'tel' }[name] || 'off', required: req });
  const msg = el('span', { class: 'yrc-note', style: 'text-align:left' });
  f.append(el('p', {}, T.lead), el('div', { class: 'row' }, inp('name', T.name), inp('company', T.company)), inp('email', T.email, 'email'), el('div', { class: 'row' }, inp('whatsapp', T.wa), inp('country', T.country)),
    el('label', { class: 'c' }, el('input', { type: 'checkbox', name: 'consent' }), T.consent), el('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', style: 'position:absolute;left:-9999px', 'aria-hidden': 'true' }), el('button', { class: 'yrc-btn', type: 'submit' }, T.submit), msg);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    d.consent = !!d.consent;
    if ((!d.email && !d.whatsapp) || !d.consent) { msg.textContent = T.need; return; }
    const needs = transcript.filter((m) => m.role === 'user').map((m) => m.content).join(' | ').slice(0, 1500);
    const body = { ...d, needs, sessionId, source: 'chat-form', product_id: r.quote?.productId || r.products?.[0]?.id || '', quantity: r.quote?.quantity || '', extra: { page: location.pathname } };
    try {
      const res = await fetch(cfg.leadsApi, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok && res.status !== 400) throw new Error();
      const j = await res.json().catch(() => ({}));
      if (j.error) { msg.textContent = j.message || T.need; return; }
    } catch {
      if (!offline) { msg.textContent = T.err; return; }
    }
    store.set('leadSent', true);
    f.replaceWith(el('div', { class: 'yrc-m bot' }, T.thanks));
  });
  return f;
}

async function loadOffline() {
  if (offline) return offline;
  const base = new URL('.', import.meta.url).href;
  const [engine, catalog] = await Promise.all([import(base + 'sales-engine.js'), fetch(cfg.catalogUrl).then((r) => r.json())]);
  offline = { engine, catalog };
  ui.log.append(el('div', { class: 'yrc-note' }, T.preview));
  return offline;
}

async function send(text) {
  if (busy) return;
  busy = true;
  ui.log.append(el('div', { class: 'yrc-m me' }, text));
  const typing = el('div', { class: 'yrc-typing' }, T.typing, el('i'), el('i'), el('i'));
  ui.log.append(typing);
  ui.log.scrollTop = ui.log.scrollHeight;
  const hist = transcript.map((m) => ({ role: m.role, content: m.content }));
  transcript.push({ role: 'user', content: text });
  persist();
  let r;
  try {
    if (offline) throw new Error('offline');
    const res = await fetch(cfg.api, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, message: text, page: location.pathname, lang: cfg.lang }) });
    if (res.status === 429) r = { reply: (await res.json()).message };
    else if (!res.ok) throw new Error('http ' + res.status);
    else { r = await res.json(); if (r.sessionId) { sessionId = r.sessionId; store.set('sid', sessionId); } }
  } catch {
    try {
      const o = await loadOffline();
      r = o.engine.demoReply(o.catalog, { site: cfg.site, calculatorPath: cfg.calculatorPath, greetingFollowup: cfg.followup, greetingFollowupZh: cfg.followupZh }, hist, text);
      if (r.products) r.products = r.products.map((p) => ({ id: p.id, name: zh && p.nameZh ? p.nameZh : p.name, url: `${cfg.productBase || '/products/'}${p.slug}/${cfg.linkSuffix || ''}`, summary: zh && p.summaryZh ? p.summaryZh : p.summary, highlights: (zh && p.highlightsZh ? p.highlightsZh : p.highlights || []).slice(0, 3), moq: p.moq, unit: p.unit || 'pcs' }));
    } catch { r = { reply: T.err }; }
  }
  typing.remove();
  addBot(r);
  renderChips();
  busy = false;
}

// Staff replies (live takeover): poll while a person may be handling the chat (after a hand-off, for 30 minutes).
function live(on) { if (on) store.set('liveUntil', Date.now() + 30 * 60e3); startPolling(); }
function addStaff(m, save = true) {
  if (m.role === 'note') ui.log.append(el('div', { class: 'yrc-note' }, m.content));
  else ui.log.append(el('div', { class: 'yrc-m agent' }, el('b', {}, `${m.name} · ${T.staff}`), m.content));
  if (save) { transcript.push({ role: m.role, content: m.content, name: m.name }); persist(); }
  ui.log.scrollTop = ui.log.scrollHeight;
}
async function pollOnce() {
  if (!sessionId || offline) return;
  try {
    const r = await fetch(`${cfg.api}/poll?sessionId=${encodeURIComponent(sessionId)}&after=${lastSeen}`);
    if (!r.ok) return;
    const j = await r.json();
    for (const m of j.messages) if (m.id > lastSeen) addStaff(m);
    if (j.messages.length) { lastSeen = j.messages.at(-1).id; store.set('last', lastSeen); }
    if (j.human) store.set('liveUntil', Date.now() + 30 * 60e3);
    ui.sub.textContent = j.human ? `${j.agent} · ${T.staffOn}` : T.sub;
  } catch { /* network blip */ }
}
function startPolling() {
  if (pollTimer || !(store.get('liveUntil') > Date.now())) return;
  pollOnce();
  pollTimer = setInterval(() => { if (!(store.get('liveUntil') > Date.now())) { clearInterval(pollTimer); pollTimer = null; return; } pollOnce(); }, 4000);
}

function persist() { transcript = transcript.slice(-40); store.set('log', transcript.map(({ role, content, r, name }) => ({ role, content, name, r: r ? { reply: r.reply, products: r.products, quote: r.quote, link: r.link } : undefined }))); }

function hydrate() {
  ui.log.append(el('div', { class: 'yrc-note' }, T.disclose));
  if (!transcript.length) addBot({ reply: cfg.greeting || (zh ? '您好！我可以帮您选型、查认证和交期，并给出参考价。请问您在找什么产品？' : "Hi! I can help you choose models, check certifications and lead times, and give a reference price. What are you looking for?") }, false);
  for (const m of transcript) {
    if (m.role === 'user') ui.log.append(el('div', { class: 'yrc-m me' }, m.content));
    else if (m.role === 'agent' || m.role === 'note') addStaff(m, false);
    else addBot({ ...(m.r || { reply: m.content }), askLead: false }, false);
  }
  renderChips();
  startPolling();
}

function open(prompt) {
  if (!ui || ui.box.classList.contains('inline')) {
    if (!launcher?._ui) { launcher._ui = build(); }
    ui = launcher._ui;
    if (!ui.hydrated) { hydrate(); ui.hydrated = true; }
  }
  ui.box.classList.add('open');
  launcher.hidden = true;
  if (prompt) send(prompt);
  setTimeout(() => ui.ta.focus(), 30);
}
function close() { ui.box.classList.remove('open'); launcher.hidden = false; launcher.focus(); }

function init() {
  document.head.append(el('style', {}, css));
  launcher = el('button', { class: 'yrc-launch', type: 'button', 'aria-haspopup': 'dialog', onclick: () => open() }, el('span', { class: 'yrc-dot', 'aria-hidden': 'true' }), zh ? '在线咨询 · AI 即时报价' : 'Chat · instant quote');
  document.body.append(launcher);
  const host = document.querySelector('[data-chat-inline]');
  if (host) { ui = build(host); hydrate(); ui.hydrated = true; launcher.hidden = true; }
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-chat-open]');
    if (!t) return;
    e.preventDefault();
    const prompt = t.getAttribute('data-chat-prompt');
    if (host && ui === host.firstChild?._ui) {}
    if (host) { ui.ta.focus(); if (prompt) send(prompt); host.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    else open(prompt);
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
