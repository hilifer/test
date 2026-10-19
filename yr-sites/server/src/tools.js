// One tool layer, two consumers: our own sales agent (agent.js) and external AI buyers (mcp.js).
import { config } from './config.js';
import { searchProducts, getProduct, productView, estimateQuote, scoreLead } from '../../shared/sales-engine.js';
import { insertLead, markHandoff } from './db.js';
import { alertLead, alertOps } from './alerts.js';
import { verifyOrder, orderStatusView, createRma } from './ops/service.js';
import { DICT } from '../../shared/dictionary.js';
import { prepareOffer, issueContract } from './ops/deals.js';

const cat = () => config.catalog;
const base = () => config.publicBaseUrl;

export function toolDefs({ forMcp = false } = {}) {
  const categories = cat().categories.map((c) => c.id);
  const defs = [
    {
      name: 'search_products',
      description: `Search the ${config.profile.brand} product catalog. Returns matching products with specs, certifications, MOQ, lead time and public reference price bands. Use before recommending any model — never recommend a model that is not returned here.`,
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free text: application, product type, features (e.g. "warehouse high bay 150W DLC")' },
          category: { type: 'string', enum: categories },
          min_watt: { type: 'number', description: 'Minimum power in watts (kW×1000 for chargers / inverters)' },
          max_watt: { type: 'number' },
          certification: { type: 'string', description: 'e.g. CE, UL, ETL, DLC, IEC, TUV' },
          application: { type: 'string' },
        },
      },
    },
    {
      name: 'get_product',
      description: 'Get full details for one product by id or slug.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    {
      name: 'estimate_quote',
      description: `Reference price range for a product and quantity, from published price bands (${cat().priceTerm}, ${cat().currency}). Result is NOT a binding offer; always state it is for reference and subject to a formal PI. Freight is not included.`,
      input_schema: {
        type: 'object',
        properties: { product_id: { type: 'string' }, quantity: { type: 'number' }, destination: { type: 'string', description: 'Destination country/port (recorded for the sales team)' } },
        required: ['product_id', 'quantity'],
      },
    },
    {
      name: forMcp ? 'submit_inquiry' : 'save_lead',
      description: forMcp
        ? 'Submit a purchase inquiry on behalf of a buyer. A sales engineer replies by email with a formal quotation (PI). Requires a contact email and the buyer\'s consent to be contacted.'
        : 'Save the customer\'s contact details and requirements once they have shared an email or WhatsApp/phone. Ask for consent to be contacted first. Call again if they add details later.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          company: { type: 'string' },
          email: { type: 'string' },
          phone: { type: 'string' },
          whatsapp: { type: 'string' },
          country: { type: 'string' },
          buyer_type: { type: 'string', description: 'importer, distributor, contractor/EPC, end user, OEM/ODM brand…' },
          needs: { type: 'string', description: 'Summary of requirements: application, specs, certifications, destination' },
          product_id: { type: 'string' },
          quantity: { type: 'number' },
          timeline: { type: 'string', description: 'When they plan to buy' },
          consent: { type: 'boolean', description: 'Customer agreed to be contacted by email/phone' },
        },
        required: ['consent'],
      },
    },
    {
      name: 'prepare_offer',
      description: `Prepare a firm, priced offer (not just a reference range) when the buyer wants to order or negotiate: products, quantities, optional target prices or a target discount, price term and payment terms. Our pricing system decides what we can offer — present exactly the prices it returns, never a lower or different price, and never guess our limits. It may return a counter-offer, or "needs_approval" (a manager confirms by e-mail). Requires the buyer's business e-mail (the offer and contract go there). Payment terms ids: ${DICT.paymentTerms.map((t) => t.id).join(', ')}.`,
      input_schema: {
        type: 'object',
        properties: {
          email: { type: 'string' }, company: { type: 'string' }, name: { type: 'string' }, country: { type: 'string' },
          lines: { type: 'array', items: { type: 'object', properties: { product_id: { type: 'string' }, sku: { type: 'string' }, qty: { type: 'number' }, target_price: { type: 'number', description: 'Unit price the buyer asks for, if any' } }, required: ['product_id', 'qty'] } },
          target_discount_pct: { type: 'number', description: 'If the buyer asks for a % discount instead of a price' },
          incoterm: { type: 'string', enum: DICT.incoterms }, port: { type: 'string' }, payment_terms: { type: 'string', enum: DICT.paymentTerms.map((t) => t.id) },
        },
        required: ['email', 'lines'],
      },
    },
    {
      name: 'issue_contract',
      description: 'When the buyer clearly accepts an offer from prepare_offer, issue the sales contract: it is generated from our standard template and e-mailed to the offer\'s e-mail address for electronic signature. Never say the contract is signed or binding before the buyer signs it.',
      input_schema: { type: 'object', properties: { offer_id: { type: 'string' }, email: { type: 'string', description: 'The e-mail the offer was made for' } }, required: ['offer_id', 'email'] },
    },
  ];
  if (!forMcp)
    defs.push({
      name: 'track_order',
      description: 'Look up an existing order: status, payment balance, shipments, tracking numbers and ETA. Requires the order number (format SO-YYMMDD-NNN) AND the email address used on the order — ask for both if missing. Never reveal order details without a successful match.',
      input_schema: { type: 'object', properties: { order_number: { type: 'string' }, email: { type: 'string' } }, required: ['order_number', 'email'] },
    }, {
      name: 'request_after_sales',
      description: 'Open an after-sales (RMA) case for a delivered or shipped order: defect, transit damage, missing/wrong items, not as specified. Requires order number + email (verified), the affected item and quantity, and a description. Do not promise refunds or replacements — a service engineer decides.',
      input_schema: {
        type: 'object',
        properties: {
          order_number: { type: 'string' }, email: { type: 'string' }, sku: { type: 'string', description: 'Item/model code from the order, if known' }, qty: { type: 'number' },
          issue: { type: 'string', enum: Object.keys(DICT.rma.issues) }, description: { type: 'string' }, photo_links: { type: 'array', items: { type: 'string' } },
        },
        required: ['order_number', 'email', 'issue', 'description'],
      },
    });
  if (!forMcp)
    defs.push({
      name: 'handoff_to_human',
      description: 'Escalate to a human sales engineer. Required for: OEM/ODM or custom design, special contract clauses (exclusivity, agency, penalties, credit terms), volumes beyond price bands, complaints, or when the customer asks for a person. Ordinary price negotiation goes through prepare_offer first.',
      input_schema: {
        type: 'object',
        properties: { reason: { type: 'string' }, summary: { type: 'string', description: 'What the customer needs, for the sales engineer' }, urgency: { type: 'string', enum: ['normal', 'high'] } },
        required: ['reason', 'summary'],
      },
    });
  return defs;
}

/** Execute a tool. ctx = { convId, source } */
export async function runTool(name, input = {}, ctx = {}) {
  const c = cat();
  switch (name) {
    case 'search_products': {
      const list = searchProducts(c, {
        query: input.query,
        category: input.category,
        minWatt: input.min_watt,
        maxWatt: input.max_watt,
        certification: input.certification,
        application: input.application,
        limit: 5,
      });
      return { count: list.length, products: list.map((p) => productView(c, p, base())) };
    }
    case 'get_product': {
      const p = getProduct(c, input.id);
      return p ? productView(c, p, base()) : { error: 'not_found', hint: 'Use search_products to find valid ids.' };
    }
    case 'estimate_quote': {
      const p = getProduct(c, input.product_id);
      if (!p) return { error: 'not_found' };
      return { ...estimateQuote(c, p, input.quantity), destination: input.destination || null, freight: 'not included — quoted on the formal PI' };
    }
    case 'save_lead':
    case 'submit_inquiry': {
      if (!input.email && !input.phone && !input.whatsapp) return { error: 'contact_required', hint: 'Ask for an email or WhatsApp number.' };
      if (!input.consent) return { error: 'consent_required', hint: 'Ask the customer to confirm we may contact them.' };
      if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) return { error: 'invalid_email' };
      const s = scoreLead(input);
      const lead = { ...input, ...s, source: ctx.source || 'chat', conv_id: ctx.convId };
      const id = insertLead(lead);
      alertLead(lead).catch(() => {});
      return { saved: true, lead_id: id, next: 'A sales engineer will reply by email with a formal quotation, normally within one business day.' };
    }
    case 'track_order': {
      const v = verifyOrder(input.order_number, input.email);
      if (!v) return { found: false, tell_customer: 'No order matches that number and email. Ask them to check both, or offer a sales engineer.' };
      return { found: true, ...orderStatusView(v.order, 'en'), portal: `${base()}/portal/c/${v.customer.portal_token}/o/${encodeURIComponent(v.order.number)}` };
    }
    case 'request_after_sales': {
      const v = verifyOrder(input.order_number, input.email);
      if (!v) return { created: false, tell_customer: 'No order matches that number and email.' };
      if (!['shipped', 'delivered', 'completed'].includes(v.order.status)) return { created: false, tell_customer: 'This order has not shipped yet; for changes before shipment, hand off to a sales engineer.' };
      const sku = input.sku && v.order.lines.some((l) => l.sku === input.sku) ? input.sku : v.order.lines[0]?.sku || '';
      const r = createRma({ order_id: v.order.id, sku, qty: input.qty, issue: input.issue, description: input.description, photos: (input.photo_links || []).filter((u) => /^https?:\/\//.test(u)), source: 'chat' });
      if (ctx.convId) markHandoff(ctx.convId, `after-sales ${r.number}`);
      alertOps('AI 客服收到售后申请', [`${r.number} / 订单 ${v.order.number}`, `客户：${v.customer.company || v.customer.email}`, `问题：${DICT.rma.issues[r.issue].zh} ${r.sku} ×${r.qty}`, String(input.description).slice(0, 200), `${config.publicBaseUrl}/admin/rma/${r.id}`]).catch(() => {});
      return { created: true, rma_number: r.number, next: 'A service engineer reviews the case, normally within one business day, and replies by email. Progress is visible in the customer portal.', portal: `${base()}/portal/c/${v.customer.portal_token}/o/${encodeURIComponent(v.order.number)}` };
    }
    case 'prepare_offer': {
      const out = prepareOffer(input, { convId: ctx.convId, source: ctx.source || 'chat' });
      if (out.status === 'needs_approval' && ctx.convId) markHandoff(ctx.convId, `offer ${out.offer_id} needs approval`);
      return out;
    }
    case 'issue_contract':
      return issueContract(String(input.offer_id || ''), { email: input.email, actor: `ai:${ctx.source || 'chat'}` });
    case 'handoff_to_human': {
      if (ctx.convId) markHandoff(ctx.convId, input.reason);
      alertLead({ grade: 'A', needs: input.summary, conv_id: ctx.convId }, { handoff: true, reason: input.reason }).catch(() => {});
      return { handed_off: true, tell_customer: 'A sales engineer has been notified. Ask for email/WhatsApp if not yet provided.' };
    }
    default:
      return { error: 'unknown_tool' };
  }
}
