// AI negotiation & e-contracts.
//
// Negotiation: the model never sees our limits. It calls prepare_offer with what the buyer asked for; the server prices
// every line from the public list price, applies the discount authority finance has set (per trust grade, per SKU floor,
// order-value cap, allowed payment terms / incoterms), concedes in steps over a limited number of rounds, and returns
// only the resulting offer. Anything outside the authority waits for a person (approval queue).
//
// Contracts: an offer (within authority, or approved) becomes a PI + a sales contract rendered from the template. The
// contract text is frozen and hashed; the signing link is sent only by e-mail (so the signer controls that address). The
// buyer signs in the portal (typed name, title, consent) — we record time, IP, user agent and a signature hash over the
// document hash — then the PI is accepted and the order created (and pushed to Kingdee when enabled).
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { migrate } from '../migrate.js';
import { actorName } from '../auth.js';
import { alertOps } from '../alerts.js';
import { getProduct } from '../../../shared/sales-engine.js';
import { DICT } from '../../../shared/dictionary.js';
import { getSetting, setSetting } from '../catalog/store.js';
import { getSku, findOrCreateCustomer, getCustomer, createQuote, getQuote, setQuoteStatus, acceptQuote, quoteExpired, logEvent, getOrder } from './service.js';
import { brand } from './brand.js';
import { sendMail } from '../shop/mailer.js';

migrate([{
  id: '2026-10-25-deals',
  up: () => db.exec(`
    CREATE TABLE deal_offers (id TEXT PRIMARY KEY, number TEXT UNIQUE, conv_id TEXT, source TEXT, email TEXT, buyer TEXT, grade TEXT, round INTEGER,
      lines TEXT, list_total REAL, total REAL, currency TEXT, incoterm TEXT, port TEXT, payment_terms TEXT, discount_pct REAL, status TEXT, reasons TEXT,
      valid_until TEXT, created_at TEXT, decided_by TEXT, decided_at TEXT, decision_note TEXT, quote_id TEXT, contract_id TEXT);
    CREATE INDEX idx_offers_email ON deal_offers(email, created_at);
    CREATE TABLE contracts (id TEXT PRIMARY KEY, number TEXT UNIQUE, quote_id TEXT, customer_id TEXT, offer_id TEXT, status TEXT, body TEXT, hash TEXT,
      token TEXT UNIQUE, created_at TEXT, created_by TEXT, seller_signed_by TEXT, sent_at TEXT, signed_at TEXT, signer_name TEXT, signer_title TEXT,
      signer_email TEXT, signer_ip TEXT, signer_ua TEXT, signature_hash TEXT, voided_at TEXT, void_reason TEXT);
    CREATE INDEX idx_contracts_quote ON contracts(quote_id);`),
}]);

const now = () => new Date().toISOString();
const J = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const ymd = () => { const d = new Date(); return `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; };
const seq = (table, prefix) => `${prefix}-${ymd()}-${String(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE number LIKE ?`).get(`${prefix}-${ymd()}-%`).n + 1).padStart(3, '0')}`;

// ---------------------------------------------------------------- policy (finance)
export const DEFAULT_POLICY = {
  enabled: true,
  maxDiscountPct: { A: 10, B: 6, C: 3 }, // off the list price, by trust grade
  maxOrderValue: 30000, // above this, a person approves
  maxRounds: 3,
  validityDays: 7,
  paymentTerms: ['tt30', 'tt100'], // terms the AI may offer on its own
  incoterms: ['EXW', 'FOB'],
};
export const dealPolicy = () => ({ ...DEFAULT_POLICY, ...(getSetting('deal_policy') || {}) });
export function saveDealPolicy(f) {
  const pct = (v) => Number(v);
  const p = {
    enabled: f.enabled === true || f.enabled === '1',
    maxDiscountPct: { A: pct(f.pct_A), B: pct(f.pct_B), C: pct(f.pct_C) },
    maxOrderValue: Number(f.maxOrderValue), maxRounds: Number(f.maxRounds), validityDays: Number(f.validityDays),
    paymentTerms: [].concat(f.paymentTerms || []).filter((t) => DICT.paymentTerms.some((x) => x.id === t)),
    incoterms: [].concat(f.incoterms || []).filter((t) => DICT.incoterms.includes(t)),
  };
  const errors = [];
  for (const g of ['A', 'B', 'C']) if (!(p.maxDiscountPct[g] >= 0 && p.maxDiscountPct[g] <= 30)) errors.push(`${g} 级最大折扣须在 0–30% 之间`);
  if (!(p.maxOrderValue >= 0)) errors.push('AI 可成交的最大订单金额必须是数字');
  if (!(Number.isInteger(p.maxRounds) && p.maxRounds >= 1 && p.maxRounds <= 10)) errors.push('议价轮数须为 1–10');
  if (!(Number.isInteger(p.validityDays) && p.validityDays >= 1 && p.validityDays <= 60)) errors.push('报价有效期须为 1–60 天');
  if (!p.paymentTerms.length) errors.push('至少允许一种付款方式');
  if (!p.incoterms.length) errors.push('至少允许一种价格条款');
  if (errors.length) throw Object.assign(new Error(errors.join('；')), { errors });
  setSetting('deal_policy', p);
  logEvent('policy', 'deal', 'updated', { actor: actorName('admin'), note: JSON.stringify(p.maxDiscountPct) });
  return p;
}
/** Per-SKU floor price (finance only). Stored apart from the catalog so it never reaches the site, the AI or MCP. */
export const floorPrices = () => getSetting('floor_prices', {});
export function setFloorPrice(sku, value) {
  if (!getSku(sku)) throw new Error('SKU 不存在');
  const all = floorPrices();
  if (value === '' || value == null) delete all[sku];
  else { const v = Number(value); if (!(v > 0)) throw new Error('底价必须大于 0'); all[sku] = r2(v); }
  setSetting('floor_prices', all);
  logEvent('policy', 'floor', 'updated', { actor: actorName('admin'), note: `${sku} → ${value || '（清除）'}` });
}

// ---------------------------------------------------------------- trust grade (verifiable signals only)
const FREE_MAIL = /@(gmail|googlemail|yahoo|hotmail|outlook|live|msn|aol|icloud|me|mail|gmx|proton|protonmail|yandex|qq|163|126|sina|foxmail|zoho)\./i;
/** A = repeat buyer who has paid before; B = company e-mail domain; C = free webmail. Claims in chat do not count. */
export function trustGrade(email) {
  const paid = db.prepare("SELECT COUNT(*) n FROM orders o JOIN customers c ON c.id = o.customer_id WHERE lower(c.email) = lower(?) AND o.paid > 0 AND o.status != 'cancelled'").get(email).n;
  if (paid) return 'A';
  return FREE_MAIL.test(email) ? 'C' : 'B';
}

// ---------------------------------------------------------------- list prices
function listUnitPrice(p, sku, qty) {
  const s = getSku(sku);
  if (s?.price > 0) {
    const tiers = (Array.isArray(s.tier_prices) ? s.tier_prices : J(s.tier_prices, [])).filter((t) => qty >= t.minQty).sort((a, b) => b.minQty - a.minQty);
    return { price: tiers[0]?.price ?? s.price, basis: 'sku' };
  }
  const bands = p.priceBands || [];
  const band = bands.find((b) => qty >= b.minQty && (!b.maxQty || qty <= b.maxQty));
  if (!band) return null;
  return { price: band.high, basis: 'band' };
}

const recentOffers = (email) => db.prepare("SELECT COUNT(*) n FROM deal_offers WHERE lower(email) = lower(?) AND created_at > ?").get(email, new Date(Date.now() - 14 * 864e5).toISOString()).n;

/**
 * Price a buyer's request within our authority. input: { email, company, name, country, lines: [{product_id, sku?, qty, target_price?}],
 * target_discount_pct?, incoterm, port, payment_terms }. Returns the public view for the model (no limits, no floors).
 */
export function prepareOffer(input, { convId = null, source = 'chat' } = {}) {
  const pol = dealPolicy();
  const email = String(input.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'email_required', tell_customer: 'Ask for the business e-mail address the offer and contract should go to.' };
  if (!pol.enabled) return { error: 'negotiation_disabled', tell_customer: 'A sales engineer will prepare the offer. Hand off to a human.' };
  const reqLines = (Array.isArray(input.lines) ? input.lines : []).slice(0, 20);
  if (!reqLines.length) return { error: 'lines_required', tell_customer: 'Ask which products and quantities.' };
  const grade = trustGrade(email);
  const round = recentOffers(email) + 1;
  const share = round === 1 ? 0.5 : 1; // concede in steps: half the authority in the first round
  const maxPct = (pol.maxDiscountPct[grade] || 0) / 100;
  const floors = floorPrices();
  const reasons = [];
  const lines = [];
  for (const l of reqLines) {
    const p = getProduct(config.catalog, l.product_id || l.sku);
    const qty = Math.round(Number(l.qty));
    if (!p) return { error: 'unknown_product', product: l.product_id || l.sku, hint: 'Use search_products for valid ids.' };
    if (!(qty >= 1)) return { error: 'bad_quantity', product: p.id };
    if (qty < p.moq) return { error: 'below_moq', product: p.id, moq: p.moq };
    const sku = (l.sku && (p.variants || []).some((v) => v.sku === l.sku)) ? l.sku : (p.variants?.[0]?.sku || p.id);
    const list = listUnitPrice(p, sku, qty);
    if (!list) { reasons.push(`no_list_price:${p.id}`); lines.push({ product_id: p.id, sku, name: p.name, qty, list_price: null, unit_price: null, amount: null }); continue; }
    const floor = floors[sku] ?? 0;
    const minNow = r2(Math.max(floor, list.price * (1 - maxPct * share)));
    const target = l.target_price != null ? Number(l.target_price) : input.target_discount_pct != null ? r2(list.price * (1 - Number(input.target_discount_pct) / 100)) : null;
    let unit = list.price;
    // below our authority → counter-offer (not an escalation); persistent haggling hits the round limit instead
    if (target != null && target > 0 && target < list.price) unit = Math.max(target, minNow);
    unit = r2(Math.min(unit, list.price));
    lines.push({ product_id: p.id, sku, name: p.name, unit: p.unit || 'pcs', qty, list_price: r2(list.price), unit_price: unit, amount: r2(unit * qty), target: target != null ? r2(target) : null });
  }
  const priced = lines.filter((l) => l.unit_price != null);
  const listTotal = r2(priced.reduce((a, l) => a + l.list_price * l.qty, 0));
  const total = r2(priced.reduce((a, l) => a + l.amount, 0));
  const incoterm = DICT.incoterms.includes(String(input.incoterm || '').toUpperCase()) ? String(input.incoterm).toUpperCase() : pol.incoterms[0];
  const payment = DICT.paymentTerms.some((t) => t.id === input.payment_terms) ? input.payment_terms : pol.paymentTerms[0];
  if (total > pol.maxOrderValue) reasons.push('over_value_cap');
  if (!pol.paymentTerms.includes(payment)) reasons.push(`payment_terms:${payment}`);
  if (!pol.incoterms.includes(incoterm)) reasons.push(`incoterm:${incoterm}`);
  if (round > pol.maxRounds) reasons.push('max_rounds');
  const status = reasons.length ? 'needs_approval' : 'offered';
  const id = randomUUID();
  const number = seq('deal_offers', 'OF');
  const validUntil = new Date(Date.now() + pol.validityDays * 864e5).toISOString();
  const buyer = { email, company: String(input.company || '').slice(0, 120), name: String(input.name || '').slice(0, 80), country: String(input.country || '').slice(0, 60) };
  db.prepare(`INSERT INTO deal_offers (id, number, conv_id, source, email, buyer, grade, round, lines, list_total, total, currency, incoterm, port, payment_terms, discount_pct, status, reasons, valid_until, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, number, convId, source, email, JSON.stringify(buyer), grade, round, JSON.stringify(lines), listTotal, total, config.catalog.currency || 'USD',
    incoterm, String(input.port || '').slice(0, 80), payment, listTotal ? r2((1 - total / listTotal) * 100) : 0, status, JSON.stringify(reasons), validUntil, now());
  logEvent('offer', id, 'created', { to: status, actor: `ai:${source}`, note: `${number} ${config.catalog.currency} ${total}${reasons.length ? ` · ${reasons.join(',')}` : ''}` });
  if (status === 'needs_approval') alertOps('AI 议价需要审批', [`${number} · ${buyer.company || email}（${grade} 级）`, `报价 ${config.catalog.currency} ${total}（标价 ${listTotal}）`, `原因：${reasons.join('，')}`, `${config.publicBaseUrl}/admin/deals/${id}`]).catch(() => {});
  return publicOffer(getOffer(id));
}

/** What the model / buyer may see. */
export function publicOffer(o) {
  const counter = o.lines.some((l) => l.target != null && l.unit_price > l.target);
  return {
    offer_id: o.number, status: o.status === 'offered' ? (counter ? 'counter_offer' : 'offer') : o.status,
    currency: o.currency, incoterm: o.incoterm, port: o.port || null, payment_terms: DICT.paymentTerms.find((t) => t.id === o.payment_terms)?.en,
    lines: o.lines.map((l) => ({ product_id: l.product_id, sku: l.sku, name: l.name, qty: l.qty, list_price: l.list_price, unit_price: l.unit_price, amount: l.amount })),
    total: o.total, saving_vs_list: r2(o.list_total - o.total), valid_until: o.valid_until.slice(0, 10), freight: o.incoterm === 'EXW' || o.incoterm === 'FOB' ? 'not included' : 'to be confirmed',
    tell_customer: o.status === 'needs_approval'
      ? 'This request needs approval from our sales manager. Tell the customer we will confirm by e-mail, normally within one business day. Do not promise the requested price.'
      : counter ? 'This is the best price available now for these terms. Present it as our offer; if they accept, call issue_contract.' : 'Present this offer. If the customer accepts, call issue_contract.',
  };
}

export const getOffer = (idOrNumber) => { const o = db.prepare('SELECT * FROM deal_offers WHERE id = ? OR number = ?').get(idOrNumber, idOrNumber); return o && { ...o, lines: J(o.lines, []), buyer: J(o.buyer, {}), reasons: J(o.reasons, []) }; };
export const listOffers = (status = '') => db.prepare(`SELECT id FROM deal_offers ${status ? 'WHERE status = ?' : ''} ORDER BY created_at DESC LIMIT 300`).all(...(status ? [status] : [])).map((r) => getOffer(r.id));

/** Staff decision on an offer outside the AI's authority. Approve may adjust unit prices. */
export async function decideOffer(id, { approve, note = '', prices = {} }) {
  const o = getOffer(id);
  if (!o) throw new Error('报价不存在');
  if (o.status !== 'needs_approval') throw new Error('只有待审批的报价可以审批');
  if (!approve) {
    db.prepare("UPDATE deal_offers SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?").run(actorName('admin'), now(), String(note).slice(0, 500), id);
    logEvent('offer', id, 'status', { from: o.status, to: 'rejected', actor: actorName('admin'), note });
    await sendMail(o.email, `${config.profile.brand}: about your request ${o.number}`, `Hello ${o.buyer.name || ''},\n\nThank you for your interest. We cannot confirm the requested terms for ${o.number}${note ? `: ${note}` : '.'}\nOur sales engineer will contact you with alternatives.\n\n${config.profile.brand}`).catch(() => {});
    return getOffer(id);
  }
  const lines = o.lines.map((l) => {
    const v = prices[l.sku] ?? prices[l.product_id];
    const unit = v === undefined || v === '' ? l.unit_price : r2(v);
    if (!(unit > 0)) throw new Error(`${l.name}：请填写单价`);
    return { ...l, unit_price: unit, amount: r2(unit * l.qty) };
  });
  const total = r2(lines.reduce((a, l) => a + l.amount, 0));
  db.prepare("UPDATE deal_offers SET status = 'approved', lines = ?, total = ?, discount_pct = ?, decided_by = ?, decided_at = ?, decision_note = ?, valid_until = ? WHERE id = ?")
    .run(JSON.stringify(lines), total, o.list_total ? r2((1 - total / o.list_total) * 100) : 0, actorName('admin'), now(), String(note).slice(0, 500), new Date(Date.now() + dealPolicy().validityDays * 864e5).toISOString(), id);
  logEvent('offer', id, 'status', { from: o.status, to: 'approved', actor: actorName('admin'), note: `${o.currency} ${total}` });
  return issueContract(o.number, { email: o.email, actor: actorName('admin') });
}

// ---------------------------------------------------------------- contracts
export const DEFAULT_TEMPLATE = `## 1. Goods, quantity and price
{{goods_table}}
Total contract value: **{{currency}} {{total}}** ({{incoterm}} {{port}}, Incoterms® 2020). Freight and insurance are not included unless the price term includes them.

## 2. Payment
{{payment_terms}}. Bank details are those printed on the Proforma Invoice {{pi_number}}; the Buyer shall verify any change of bank details by phone with the Seller before paying.

## 3. Delivery
Production lead time: {{lead_time}} after receipt of the deposit and approval of samples (if any). Partial shipments are allowed. The Seller notifies the Buyer of the shipping date and documents.

## 4. Packing and marking
Standard export cartons suitable for sea or air freight. Special packing or marking only as agreed in writing.

## 5. Quality and warranty
Goods conform to the specifications published for each model on the Seller's website at the date of this contract. Warranty: {{warranty}} from the date of shipment, covering manufacturing defects under normal use and installation.

## 6. Inspection and claims
The Buyer may inspect the goods before shipment. Claims for quantity shortage or visible damage must be made within 15 days, and quality claims within the warranty period, with photos or an inspection report.

## 7. Force majeure
Neither party is liable for delay or non-performance caused by events beyond its reasonable control. The affected party notifies the other promptly.

## 8. Governing law and disputes
This contract is governed by the United Nations Convention on Contracts for the International Sale of Goods (CISG). Disputes are first settled by friendly negotiation, then by arbitration at the China International Economic and Trade Arbitration Commission (CIETAC), Shenzhen, in English. The award is final.

## 9. Entire agreement and electronic signature
This contract and Proforma Invoice {{pi_number}} form the entire agreement. Changes are valid only in writing. The parties agree that electronic signatures and electronic records of this contract are legally binding.`;
export const contractTemplate = () => getSetting('contract_template') || DEFAULT_TEMPLATE;
export function saveContractTemplate(text) {
  const t = String(text || '').trim();
  if (t.length < 200) throw new Error('合同模板太短');
  for (const k of ['{{goods_table}}', '{{total}}', '{{payment_terms}}']) if (!t.includes(k)) throw new Error(`模板必须包含 ${k}`);
  setSetting('contract_template', t);
  logEvent('policy', 'contract_template', 'updated', { actor: actorName('admin'), note: sha(t).slice(0, 12) });
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtMoney = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function leadTimeOf(lines) {
  const ps = lines.map((l) => config.catalog.products.find((p) => p.id === l.sku || (p.variants || []).some((v) => v.sku === l.sku) || l.sku.startsWith(p.id))).filter(Boolean);
  if (!ps.length) return 'as stated on the Proforma Invoice';
  return `${Math.max(...ps.map((p) => p.leadTimeDays[0]))}–${Math.max(...ps.map((p) => p.leadTimeDays[1]))} days`;
}
function warrantyOf(lines) {
  const ps = lines.map((l) => config.catalog.products.find((p) => p.id === l.sku || (p.variants || []).some((v) => v.sku === l.sku) || l.sku.startsWith(p.id))).filter(Boolean);
  return [...new Set(ps.map((p) => p.warranty))].join(' / ') || 'as stated for each model';
}

/** Render the frozen contract body (HTML) from the template. Every value is escaped; the template itself is plain text. */
function renderBody(number, q, cust) {
  const b = brand();
  const goods = `<table class="goods"><thead><tr><th>Item</th><th>Description</th><th>Qty</th><th>Unit price (${esc(q.currency)})</th><th>Amount</th></tr></thead><tbody>${q.lines.map((l) => `<tr><td>${esc(l.sku)}</td><td>${esc(l.name)} ${esc(l.variant || '')}</td><td>${l.qty} ${esc(l.unit || 'pcs')}</td><td>${fmtMoney(l.unit_price)}</td><td>${fmtMoney(l.amount)}</td></tr>`).join('')}${q.freight ? `<tr><td colspan="4">Freight</td><td>${fmtMoney(q.freight)}</td></tr>` : ''}${q.discount ? `<tr><td colspan="4">Discount</td><td>−${fmtMoney(q.discount)}</td></tr>` : ''}</tbody></table>`;
  const vals = {
    contract_number: number, date: now().slice(0, 10), pi_number: q.number, seller_company: b.company, seller_address: b.address || '', buyer_company: cust.company || cust.contact || cust.email,
    buyer_contact: cust.contact || '', buyer_email: cust.email, buyer_country: cust.country || '', currency: q.currency, total: fmtMoney(q.total), incoterm: q.incoterm, port: q.port || '',
    payment_terms: DICT.paymentTerms.find((t) => t.id === q.payment_terms)?.en || q.payment_terms, lead_time: leadTimeOf(q.lines), warranty: warrantyOf(q.lines), validity: `${q.validity_days} days`,
  };
  const text = contractTemplate();
  const html = text.split(/\n{2,}/).map((block) => {
    const filled = esc(block).replace(/\{\{(\w+)\}\}/g, (m, k) => (k === 'goods_table' ? '\u0000GOODS\u0000' : k in vals ? esc(vals[k]) : m)).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    if (filled.includes('\u0000GOODS\u0000')) return filled.split('\u0000GOODS\u0000').map((s, i) => (i ? goods : '') + (s.trim() ? `<p>${s.trim().replace(/\n/g, '<br>')}</p>` : '')).join('');
    if (filled.startsWith('## ')) { const [h, ...rest] = filled.split('\n'); return `<h2>${h.slice(3)}</h2>${rest.length ? `<p>${rest.join('<br>')}</p>` : ''}`; }
    return `<p>${filled.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');
  return `<header class="parties"><h1>Sales Contract</h1><p>Contract No. <b>${esc(number)}</b> · Date ${esc(vals.date)} · Related PI ${esc(q.number)}</p>
<div class="two"><div><h3>Seller</h3><p><b>${esc(b.company)}</b><br>${esc(b.address || '')}<br>${esc(b.email || '')}</p></div><div><h3>Buyer</h3><p><b>${esc(vals.buyer_company)}</b><br>${esc(cust.contact || '')}<br>${esc(cust.email)}<br>${esc(cust.country || '')}${cust.address ? `<br>${esc(cust.address)}` : ''}</p></div></div></header>
${html}`;
}

export const getContract = (idOrNumber) => db.prepare('SELECT * FROM contracts WHERE id = ? OR number = ?').get(idOrNumber, idOrNumber) || null;
export const contractByToken = (t) => (t ? db.prepare('SELECT * FROM contracts WHERE token = ?').get(t) : null);
export const contractForQuote = (qid) => db.prepare("SELECT * FROM contracts WHERE quote_id = ? AND status != 'void' ORDER BY created_at DESC").get(qid) || null;
export const listContracts = () => db.prepare('SELECT k.*, c.company, c.email FROM contracts k LEFT JOIN customers c ON c.id = k.customer_id ORDER BY k.created_at DESC LIMIT 300').all();
export const signUrl = (k) => `${config.publicBaseUrl}/portal/contract/${k.token}`;

/** Create (or return the open) contract for a quote; the quote is sent if it was a draft. E-mails the signing link. */
export async function createContractForQuote(quoteId, { offerId = null, actor = actorName('admin') } = {}) {
  let q = getQuote(quoteId);
  if (!q) throw new Error('报价不存在');
  const open = contractForQuote(q.id);
  if (open) return open;
  if (q.status === 'draft') q = setQuoteStatus(q.id, 'sent', actor);
  if (q.status !== 'sent' || quoteExpired(q)) throw new Error('只有有效的已发送报价可以生成合同');
  const cust = getCustomer(q.customer_id);
  const id = randomUUID();
  const number = seq('contracts', 'SC');
  const body = renderBody(number, q, cust);
  const token = randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO contracts (id, number, quote_id, customer_id, offer_id, status, body, hash, token, created_at, created_by, seller_signed_by, sent_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, number, q.id, cust.id, offerId, 'sent', body, sha(body), token, now(), actor, actor, now());
  logEvent('contract', id, 'created', { to: 'sent', actor, note: `${number} ← ${q.number}` });
  const k = getContract(id);
  await sendMail(cust.email, `${config.profile.brand}: sales contract ${number} for your signature`,
    `Hello ${cust.contact || ''},\n\nPlease review and sign sales contract ${number} (Proforma Invoice ${q.number}, total ${q.currency} ${fmtMoney(q.total)}, ${q.incoterm}${q.port ? ' ' + q.port : ''}).\n\nSign online: ${signUrl(k)}\n\nThe offer is valid until ${new Date(new Date(q.sent_at).getTime() + q.validity_days * 864e5).toISOString().slice(0, 10)}. After signing you will receive the deposit instructions.\n\n${config.profile.brand}`).catch(() => {});
  return k;
}

/** Turn an offer (within authority or approved) into PI + contract. The contract link goes only to the offer's e-mail. */
export async function issueContract(offerNumber, { email, actor = 'ai' } = {}) {
  const o = getOffer(offerNumber);
  if (!o) return { error: 'unknown_offer' };
  if (email && String(email).toLowerCase() !== o.email) return { error: 'email_mismatch', tell_customer: 'The contract can only be sent to the e-mail address the offer was made for.' };
  if (o.status === 'contracted') { const k = getContract(o.contract_id); return { issued: true, contract_number: k.number, sent_to: o.email, already: true }; }
  if (o.status === 'needs_approval') return { error: 'awaiting_approval', tell_customer: 'This offer is waiting for approval by our sales manager; we will e-mail the customer.' };
  if (!['offered', 'approved'].includes(o.status)) return { error: `offer_${o.status}` };
  if (new Date(o.valid_until) < new Date()) { db.prepare("UPDATE deal_offers SET status = 'expired' WHERE id = ?").run(o.id); return { error: 'offer_expired', tell_customer: 'The offer has expired; prepare a new one.' }; }
  if (o.lines.some((l) => l.unit_price == null)) return { error: 'unpriced_lines' };
  const cust = findOrCreateCustomer({ email: o.email, company: o.buyer.company, contact: o.buyer.name, country: o.buyer.country });
  const q = createQuote({ customer: cust, lines: o.lines.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty, unit_price: l.unit_price })), currency: o.currency, incoterm: o.incoterm, port: o.port, payment_terms: o.payment_terms,
    validity_days: Math.max(1, Math.ceil((new Date(o.valid_until) - Date.now()) / 864e5)), notes: `Agreed in offer ${o.number}${o.decided_by ? ` (approved by ${o.decided_by})` : ' (within sales authority)'}.` });
  const k = await createContractForQuote(q.id, { offerId: o.id, actor: o.decided_by || `ai:${o.source}` });
  db.prepare("UPDATE deal_offers SET status = 'contracted', quote_id = ?, contract_id = ? WHERE id = ?").run(q.id, k.id, o.id);
  logEvent('offer', o.id, 'status', { from: o.status, to: 'contracted', actor, note: k.number });
  alertOps('合同已发送，待客户签署', [`${k.number} / ${q.number} · ${cust.company || cust.email}`, `${o.currency} ${q.total}`, `${config.publicBaseUrl}/admin/contracts/${k.id}`]).catch(() => {});
  return { issued: true, contract_number: k.number, pi_number: q.number, sent_to: o.email, tell_customer: `The contract has been e-mailed to ${o.email} for electronic signature. After signing, deposit instructions follow.` };
}

/** Buyer signs. Returns the order created from the PI. */
export async function signContract(token, { name, title = '', agree, ip = '', ua = '' }) {
  const k = contractByToken(token);
  if (!k) throw Object.assign(new Error('not_found'), { status: 404 });
  if (k.status === 'signed') throw new Error('This contract has already been signed.');
  if (k.status !== 'sent') throw new Error('This contract is no longer open for signature.');
  if (sha(k.body) !== k.hash) throw new Error('Document integrity check failed. Please contact us.');
  const signer = String(name || '').trim();
  if (signer.length < 2) throw new Error('Please type your full name as your signature.');
  if (!(agree === true || agree === '1' || agree === 'on')) throw new Error('Please confirm that you have read and agree to the contract.');
  const q = getQuote(k.quote_id);
  if (quoteExpired(q)) throw new Error('The offer in this contract has expired. Please ask us for an updated contract.');
  const cust = getCustomer(k.customer_id);
  const ts = now();
  const sig = sha([k.hash, signer, title, cust.email, ts, ip].join('|'));
  db.exec('BEGIN IMMEDIATE');
  let order;
  try {
    const r = db.prepare("UPDATE contracts SET status = 'signed', signed_at = ?, signer_name = ?, signer_title = ?, signer_email = ?, signer_ip = ?, signer_ua = ?, signature_hash = ? WHERE id = ? AND status = 'sent'")
      .run(ts, signer.slice(0, 120), String(title).slice(0, 80), cust.email, String(ip).slice(0, 64), String(ua).slice(0, 300), sig, k.id);
    if (!r.changes) throw new Error('This contract is no longer open for signature.');
    order = acceptQuote(q.id, 'customer');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  logEvent('contract', k.id, 'status', { from: 'sent', to: 'signed', actor: `customer:${cust.email}`, note: `${signer} · ${ip}` });
  db.prepare('UPDATE orders SET notes = COALESCE(notes, \'\') || ? WHERE id = ?').run(`Contract ${k.number} signed ${ts.slice(0, 10)}. `, order.id);
  const { pushOrder } = await import('./erp/index.js');
  if (config.erp.autoPushOrders) pushOrder(order.id).catch(() => {});
  await sendMail(cust.email, `${config.profile.brand}: contract ${k.number} signed — order ${order.number}`,
    `Thank you, ${signer}. Contract ${k.number} is signed (document fingerprint ${k.hash.slice(0, 16)}…).\nOrder ${order.number}: ${order.currency} ${fmtMoney(order.total)}. Deposit due: ${order.currency} ${fmtMoney(order.deposit_due)}.\n\nYour signed copy: ${signUrl(k)}\nOrder status: ${config.publicBaseUrl}/portal/c/${cust.portal_token}/o/${encodeURIComponent(order.number)}\n\n${config.profile.brand}`).catch(() => {});
  alertOps('客户已签署合同，订单已生成', [`${k.number} → ${order.number}`, `${cust.company || cust.email} · 签署人 ${signer}${title ? `（${title}）` : ''}`, `待收定金 ${order.currency} ${order.deposit_due}`, `${config.publicBaseUrl}/admin/orders/${order.id}`]).catch(() => {});
  return getOrder(order.id);
}

export function voidContract(id, reason) {
  const k = getContract(id);
  if (!k) throw new Error('合同不存在');
  if (k.status !== 'sent') throw new Error('只有待签署的合同可以作废');
  if (!String(reason || '').trim()) throw new Error('请填写作废原因');
  db.prepare("UPDATE contracts SET status = 'void', voided_at = ?, void_reason = ? WHERE id = ?").run(now(), String(reason).slice(0, 500), id);
  logEvent('contract', id, 'status', { from: 'sent', to: 'void', actor: actorName('admin'), note: reason });
}
export const verifyContract = (k) => ({ intact: sha(k.body) === k.hash, hash: k.hash, signature: k.signature_hash ? sha([k.hash, k.signer_name, k.signer_title || '', k.signer_email, k.signed_at, k.signer_ip].join('|')) === k.signature_hash : null });

export function expireOffers() {
  return db.prepare("UPDATE deal_offers SET status = 'expired' WHERE status IN ('offered','approved') AND valid_until < ?").run(now()).changes;
}
