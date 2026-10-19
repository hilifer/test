// Shared sales logic used by BOTH the server (Node) and the browser chat widget
// (offline/demo mode). Pure functions only — no I/O.
//
// Golden rules enforced here (mirrors BRD red lines):
//  - prices are always ranges from the published reference bands, never a commitment
//  - floor prices / costs are never part of the catalog, so they cannot leak
//  - every price answer carries the "reference only, subject to formal PI" note

export const FREE_MAIL = /@(gmail|yahoo|hotmail|outlook|live|icloud|aol|mail|proton(mail)?|qq|163|126|yandex|gmx)\./i;

/** Price display switch (catalog.priceDisplay): 'ranges' (default) or 'hidden'. */
export const pricesHidden = (catalog) => catalog?.priceDisplay === 'hidden';
/** Catalog as published to the public (site JSON, offline widget): no price bands when prices are hidden. */
export function publicCatalog(catalog) {
  if (!pricesHidden(catalog)) return catalog;
  return { ...catalog, products: catalog.products.map(({ priceBands, ...p }) => p) };
}

const norm = (s) => String(s || '').toLowerCase();
// Words that say nothing about which product is meant (would otherwise match every summary).
const STOP = new Set('a an and are as at be can do does for from have how i in is it me much my need of on or our please price prices quote quotation send the to we what with you your pcs pc units unit sets set nos qty quantity want looking buy order cost'.split(' '));
export const isCJK = (s) => /[㐀-鿿]/.test(String(s || ''));

/** Search products by free text + structured filters. Returns scored list. */
export function searchProducts(catalog, f = {}) {
  const q = norm(f.query);
  const words = q.split(/[^a-z0-9㐀-鿿.]+/).filter((w) => w.length > 1 && !STOP.has(w));
  const out = [];
  for (const p of catalog.products) {
    if (f.category && p.category !== f.category) continue;
    if (f.minWatt && p.wattMax && p.wattMax < f.minWatt) continue;
    if (f.maxWatt && p.wattMin && p.wattMin > f.maxWatt) continue;
    if (f.certification && !p.certifications.some((c) => norm(c).includes(norm(f.certification)))) continue;
    if (f.application && !p.applications.some((a) => norm(a).includes(norm(f.application)))) continue;
    const cat = catalog.categories.find((c) => c.id === p.category) || {};
    const hay = norm([p.name, p.nameZh, p.summary, p.category, cat.name, cat.nameZh, ...(cat.keywords || []), ...(p.keywords || []), ...p.applications, ...p.certifications].join(' '));
    const title = norm(`${p.id} ${p.name} ${p.nameZh || ''}`);
    let score = 0;
    for (const w of words) if (title.includes(w)) score += 3; else if (hay.includes(w)) score += 1;
    if (f.watt && p.wattMin <= f.watt && p.wattMax >= f.watt) score += 3;
    if (!words.length && !f.watt) score = 1;
    if (score > 0) out.push({ p, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, f.limit || 5).map((x) => x.p);
}

export function getProduct(catalog, idOrSlug) {
  const k = norm(idOrSlug);
  return catalog.products.find((p) => norm(p.id) === k || norm(p.slug) === k) || null;
}

/** Public, AI-safe product view (what tools / MCP return). */
export function productView(catalog, p, baseUrl = '') {
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    summary: p.summary,
    url: `${baseUrl}/products/${p.slug}/`,
    markdown: `${baseUrl}/products/${p.slug}.md`,
    specs: p.specs,
    certifications: p.certifications,
    moq: p.moq,
    moqUnit: p.unit || 'pcs',
    leadTimeDays: p.leadTimeDays,
    sampleDays: p.sampleDays,
    warranty: p.warranty,
    referencePrice: p.priceBands?.length && !pricesHidden(catalog)
      ? {
          currency: catalog.currency,
          term: catalog.priceTerm,
          bands: p.priceBands,
          note: catalog.priceNote,
        }
      : null,
  };
}

/** Reference quote from published bands. Never a commitment. */
export function estimateQuote(catalog, p, quantity) {
  const qty = Math.max(1, Math.round(Number(quantity) || 0));
  if (pricesHidden(catalog) || !p.priceBands?.length) return { ok: false, reason: 'price_on_request', handoff: true, moq: p.moq, note: 'Pricing is quoted per project by a sales engineer (formal PI).' };
  if (qty < p.moq)
    return { ok: false, reason: 'below_moq', moq: p.moq, sampleDays: p.sampleDays, note: `MOQ is ${p.moq} ${p.unit || 'pcs'}. Samples are available.` };
  const band = p.priceBands.find((b) => qty >= b.minQty && (!b.maxQty || qty <= b.maxQty)) || p.priceBands[p.priceBands.length - 1];
  if (band.maxQty == null && qty > band.minQty * 10)
    return { ok: false, reason: 'volume_project', handoff: true, note: 'Volume beyond public price bands — a sales engineer will quote.' };
  return {
    ok: true,
    productId: p.id,
    productName: p.name,
    quantity: qty,
    unit: p.unit || 'pcs',
    currency: catalog.currency,
    term: catalog.priceTerm,
    unitPrice: { low: band.low, high: band.high },
    total: { low: round(band.low * qty), high: round(band.high * qty) },
    leadTimeDays: p.leadTimeDays,
    note: catalog.priceNote,
  };
}
const round = (n) => Math.round(n);

/** Deterministic A/B/C/D lead grade — the model only fills fields, it never grades. */
export function scoreLead(lead = {}) {
  let s = 0;
  const why = [];
  if (lead.email && !FREE_MAIL.test(lead.email)) (s += 2), why.push('company email');
  if (lead.company) (s += 1), why.push('company named');
  const q = Number(lead.quantity) || 0;
  if (q >= 1000) (s += 3), why.push('qty ≥1000');
  else if (q >= 200) (s += 2), why.push('qty ≥200');
  else if (q > 0) (s += 1), why.push('qty given');
  const t = norm(lead.timeline);
  if (/(asap|urgent|now|week|1 ?month|this month|立即|马上|本月|一个月|两周)/.test(t)) (s += 2), why.push('buying within 1 month');
  else if (/(2|3|two|three) ?month|quarter|季度|三个月|两个月/.test(t)) (s += 1), why.push('buying within 3 months');
  if (/(oem|odm|project|tender|distribut|wholesale|epc|工程|项目|代理|招标)/i.test(`${lead.type || ''} ${lead.needs || ''}`)) (s += 2), why.push('project / channel buyer');
  if (lead.phone || lead.whatsapp) (s += 1), why.push('phone/WhatsApp');
  if (/^(lighting-design|wholesale)$/.test(lead.source || '')) (s += 2), why.push(lead.source === 'wholesale' ? 'wholesale/distributor application' : 'lighting layout request');
  if (Number(lead.lines) >= 2) (s += 1), why.push(`quote list with ${lead.lines} items`);
  const grade = s >= 7 ? 'A' : s >= 4 ? 'B' : s >= 2 ? 'C' : 'D';
  return { grade, score: s, reasons: why };
}

/** Pull rough intent out of a message (demo mode + server hints). */
export function parseIntent(text) {
  const t = norm(text);
  const watt = t.match(/(\d{2,4})\s?w(att)?\b/);
  const kwh = t.match(/(\d{1,4}(?:\.\d+)?)\s?kwh/);
  const kw = t.match(/(\d{1,4}(?:\.\d+)?)\s?kw\b/);
  const qty = t.match(/(\d[\d,]{0,7})\s?(pcs|pieces|units|sets|nos|个|台|套|只|盏)/) || t.match(/(?:qty|quantity|need|order|数量)\D{0,6}(\d[\d,]{0,7})/);
  return {
    watt: watt ? Number(watt[1]) : null,
    kwh: kwh ? Number(kwh[1]) : null,
    kw: kw ? Number(kw[1]) : null,
    qty: qty ? Number(String(qty[1]).replace(/,/g, '')) : null,
    price: /(price|cost|quote|quotation|how much|fob|报价|价格|多少钱)/.test(t),
    cert: /(certif|certs?\b|认证|证书)/.test(t) || (/\b(ce|ul|etl|dlc|rohs|saa|iec|tuv)\b/.test(t) && /\?|do you|does it|have|有没有|吗/.test(t)),
    moq: /(moq|minimum order|起订)/.test(t),
    lead: /(lead time|delivery|deliver|交期|货期|多久)/.test(t),
    sample: /(sample|样品)/.test(t),
    oem: /(oem|odm|private label|custom|定制|贴牌)/.test(t),
    human: /(human|real person|sales ?rep|agent|call me|talk to|人工|业务员|联系我)/.test(t),
    roi: /(payback|roi|saving|回本|收益|测算)/.test(t),
    email: (t.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0] || null,
  };
}

const money = (c, n) => `${c === 'USD' ? 'US$' : c + ' '}${Number(n).toLocaleString('en-US')}`;

/**
 * Rule-based reply used when no LLM key is configured, or in the static preview.
 * Keeps the same red lines as the AI agent.
 */
export function demoReply(catalog, profile, history, text) {
  const zh = isCJK(text);
  const L = (en, cn) => (zh ? cn : en);
  const it = parseIntent(text);
  const prior = history.filter((m) => m.role === 'user').map((m) => m.content).join(' ');
  const ctx = parseIntent(prior);
  const watt = it.watt || ctx.watt;
  const qty = it.qty || ctx.qty;

  if (it.human || it.oem) {
    return {
      reply: it.oem
        ? L(`OEM/ODM projects are handled by our engineering sales team directly. Leave your email or WhatsApp and a project manager will contact you within one business day with capability details and the sampling process.`,
            `OEM/ODM 定制项目由我们的工程销售团队直接负责。请留下邮箱或 WhatsApp，项目经理会在一个工作日内联系您，介绍定制能力和打样流程。`)
        : L(`Sure — I'll pass this conversation to a sales engineer. Please leave your email or WhatsApp so they can reach you.`, `好的，我会把对话转给业务工程师。请留下邮箱或 WhatsApp 方便联系。`),
      askLead: true,
      handoff: true,
    };
  }

  let found = searchProducts(catalog, { query: text + ' ' + (prior.slice(-200) || ''), watt, limit: 3 });
  if (it.email) {
    return { reply: L(`Thanks — got your email. A sales engineer will follow up shortly with a formal quotation.`, `收到您的邮箱，业务工程师会尽快跟进并发送正式报价。`), askLead: true, capturedEmail: it.email };
  }

  if (it.roi && profile.site === 'grid') {
    return { reply: L(`Our ROI calculator estimates system size, investment and payback from your bill and roof area — it takes about a minute.`, `收益测算器可以根据电费和屋顶面积估算装机容量、投资额和回本周期，大约一分钟。`), link: { href: profile.calculatorPath || '/calculator/', label: L('Open the ROI calculator', '打开收益测算器') } };
  }

  const p = found[0];
  const wantsPrice = it.price || (it.qty && ctx.price);
  if (wantsPrice && p) {
    if (!qty) {
      return { reply: L(`I can give a reference price range for the ${p.name}. How many units do you need, and which destination port?`, `可以为您提供 ${p.nameZh || p.name} 的参考价区间。请问需要多少数量、目的港是哪里？`), products: [p] };
    }
    const q = estimateQuote(catalog, p, qty);
    if (q.ok) {
      return {
        reply: L(`Reference price for ${q.quantity} × ${p.name}: ${money(q.currency, q.unitPrice.low)}–${money(q.currency, q.unitPrice.high)} per unit (${q.term}), about ${money(q.currency, q.total.low)}–${money(q.currency, q.total.high)} in total. Lead time ${q.leadTimeDays[0]}–${q.leadTimeDays[1]} days. ${q.note} Want me to have a formal PI sent to your email?`,
                 `${q.quantity} ${q.unit} ${p.nameZh || p.name} 参考单价 ${money(q.currency, q.unitPrice.low)}–${money(q.currency, q.unitPrice.high)}（${q.term}），合计约 ${money(q.currency, q.total.low)}–${money(q.currency, q.total.high)}，交期 ${q.leadTimeDays[0]}–${q.leadTimeDays[1]} 天。以上仅供参考，以正式 PI 为准。需要把正式报价发到您的邮箱吗？`),
        quote: q,
        products: [p],
        askLead: true,
      };
    }
    if (q.reason === 'price_on_request')
      return { reply: L(`We quote the ${p.name} per project, based on quantity, configuration and destination. Leave your email or WhatsApp and a sales engineer will send a formal quotation, normally within one business day. MOQ is ${p.moq} ${p.unit || 'pcs'}.`, `${p.nameZh || p.name} 按项目报价（取决于数量、配置和目的地）。请留下邮箱或 WhatsApp，业务工程师通常会在一个工作日内发送正式报价。起订量 ${p.moq}。`), products: [p], askLead: true };
    if (q.reason === 'below_moq')
      return { reply: L(`The MOQ for ${p.name} is ${p.moq} ${p.unit || 'pcs'}. For smaller quantities we can send samples in ${p.sampleDays[0]}–${p.sampleDays[1]} days — shall I arrange that?`, `${p.nameZh || p.name} 起订量为 ${p.moq}，数量较少可以先寄样品（${p.sampleDays[0]}–${p.sampleDays[1]} 天），需要安排吗？`), products: [p], askLead: true };
    return { reply: L(`That volume is beyond our public price bands, so a sales engineer will prepare a project quote. Please leave your email or WhatsApp.`, `该数量超出公开价格档位，将由业务工程师为您出项目报价，请留下邮箱或 WhatsApp。`), askLead: true, handoff: true, products: [p] };
  }
  if (it.cert && p) {
    return { reply: L(`${p.name} certifications: ${p.certifications.join(', ')}. Certificate copies are on the product page and can be emailed on request.`, `${p.nameZh || p.name} 的认证：${p.certifications.join('、')}。证书可以在产品页查看，也可以发到您的邮箱。`), products: [p] };
  }
  if ((it.moq || it.lead || it.sample) && p) {
    return { reply: L(`${p.name}: MOQ ${p.moq} ${p.unit || 'pcs'}, production lead time ${p.leadTimeDays[0]}–${p.leadTimeDays[1]} days, samples in ${p.sampleDays[0]}–${p.sampleDays[1]} days.`, `${p.nameZh || p.name}：起订量 ${p.moq}，生产交期 ${p.leadTimeDays[0]}–${p.leadTimeDays[1]} 天，样品 ${p.sampleDays[0]}–${p.sampleDays[1]} 天。`), products: [p] };
  }
  if (found.length) {
    return {
      reply: L(`These look like a match. Tell me the quantity and destination and I'll give you a reference price range right away.`, `这几款比较匹配。告诉我数量和目的地，我可以马上给出参考价区间。`),
      products: found,
    };
  }
  return {
    reply: L(profile.greetingFollowup || `Tell me what you're lighting (warehouse, street, sports field…), the wattage or lumens you need, and the quantity — I'll recommend models and a reference price.`,
             profile.greetingFollowupZh || `请告诉我应用场景、功率需求和数量，我来推荐型号并给出参考价。`),
  };
}
