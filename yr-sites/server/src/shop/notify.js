// E-mails the buyer when an online-shop shipment is created or its status changes.
import { hooks, getOrder, getCustomer } from '../ops/service.js';
import { label } from '../../../shared/dictionary.js';
import { config } from '../config.js';
import { sendMail } from './mailer.js';

hooks.shipment.push((kind, s) => {
  if (s.rma_id && kind === 'status' && s.status !== 'in_transit') return;
  const o = getOrder(s.order_id);
  if (!o || o.channel !== 'shop') return;
  if (kind === 'status' && !['in_transit', 'arrived', 'delivered', 'exception'].includes(s.status)) return;
  const c = getCustomer(o.customer_id);
  const link = `${config.publicBaseUrl}/shop/order/${encodeURIComponent(o.number)}?t=${encodeURIComponent(o.access_token)}`;
  const what = kind === 'created' ? 'is being prepared for shipment' : `is now: ${label('shipment', s.status, 'en')}`;
  const track = s.tracking_no ? `\nCarrier: ${s.carrier || '-'} · Tracking number: ${s.tracking_no}` : '';
  sendMail(c.email, `${config.profile.brand}: order ${o.number} ${kind === 'created' ? 'shipment created' : label('shipment', s.status, 'en').toLowerCase()}`, `Your order ${o.number} ${what}.${track}\n\nFollow it here: ${link}`).catch(() => {});
});
