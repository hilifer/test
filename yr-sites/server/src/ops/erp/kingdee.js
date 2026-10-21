// Kingdee Cloud Galaxy (金蝶云星空 / K/3 Cloud) WebAPI adapter.
// Uses the standard WebAPI service stubs: login (AppSecret or password), Save, ExecuteBillQuery.
// Orders are SAVED (创建状态) in Kingdee, not submitted/audited — staff review them in Kingdee.
//
// ⚠ Field keys below follow the standard (标准版) data model. Customised implementations may
//    rename fields or make extra fields mandatory — confirm with your Kingdee implementer and
//    adjust buildSalesOrder() / buildCustomer() if Save returns field errors.
import { config } from '../../config.js';

const K = () => config.erp.kingdee;
const STUB = 'Kingdee.BOS.WebApi.ServicesStub';
let cookie = '';
let loginAt = 0;

async function post(path, body, { auth = true } = {}) {
  if (auth && (!cookie || Date.now() - loginAt > 15 * 60e3)) await login();
  const r = await fetch(`${K().baseUrl}/${path}.common.kdsvc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie && auth ? { cookie } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Kingdee HTTP ${r.status}: ${text.slice(0, 200)}`);
  if (!auth) {
    const set = r.headers.getSetCookie?.() || [r.headers.get('set-cookie') || ''];
    const sid = set.join(';').match(/kdservice-sessionid=[^;]+/);
    if (sid) cookie = sid[0];
  }
  try { return JSON.parse(text); } catch { return text; }
}

export async function login() {
  const k = K();
  if (!k.baseUrl || !k.acctId || !k.username) throw new Error('金蝶未配置：需要 KD_BASE_URL / KD_ACCT_ID / KD_USERNAME');
  const res = k.appId && k.appSecret
    ? await post(`${STUB}.AuthService.LoginByAppSecret`, { acctID: k.acctId, username: k.username, appId: k.appId, appSecret: k.appSecret, lcid: k.lcid }, { auth: false })
    : await post(`${STUB}.AuthService.ValidateUser`, { acctID: k.acctId, username: k.username, password: k.password, lcid: k.lcid }, { auth: false });
  if (res?.LoginResultType !== 1 && res?.LoginResultType !== -5) throw new Error(`金蝶登录失败：${res?.Message || JSON.stringify(res).slice(0, 200)}`);
  loginAt = Date.now();
  return true;
}

function saveResult(res) {
  const st = res?.Result?.ResponseStatus;
  if (!st?.IsSuccess) {
    const errs = (st?.Errors || []).map((e) => `${e.FieldName ? e.FieldName + ': ' : ''}${e.Message}`).join('；');
    throw new Error(`金蝶保存失败：${errs || JSON.stringify(res).slice(0, 300)}`);
  }
  return { id: res.Result.Id, number: res.Result.Number };
}

export async function query(formId, fieldKeys, filter = '', limit = 2000) {
  const rows = [];
  for (let start = 0; ; start += limit) {
    const res = await post(`${STUB}.DynamicFormService.ExecuteBillQuery`, { data: { FormId: formId, FieldKeys: fieldKeys, FilterString: filter, OrderString: '', TopRowCount: 0, StartRow: start, Limit: limit } });
    if (!Array.isArray(res)) throw new Error(`金蝶查询失败：${JSON.stringify(res).slice(0, 300)}`);
    if (Array.isArray(res[0]) && res[0][0]?.Result) throw new Error(`金蝶查询失败：${JSON.stringify(res[0][0].Result.ResponseStatus?.Errors || res).slice(0, 300)}`);
    rows.push(...res);
    if (res.length < limit) break;
  }
  return rows;
}

export function buildCustomer(c) {
  const k = K();
  return {
    NeedUpDateFields: [], IsAutoSubmitAndAudit: false,
    Model: {
      FCustID: 0,
      FCreateOrgId: { FNumber: k.orgNumber },
      FUseOrgId: { FNumber: k.orgNumber },
      FName: c.company || c.contact || c.email,
      FShortName: (c.company || '').slice(0, 40),
      FTRADINGCURRID: { FNumber: k.currencyMap.USD },
      FDescription: [c.country, c.email, c.whatsapp || c.phone].filter(Boolean).join(' / ').slice(0, 255),
    },
  };
}

export function buildSalesOrder(order, customer, skuLookup) {
  const k = K();
  const date = new Date().toISOString().slice(0, 10);
  return {
    NeedUpDateFields: [], IsDeleteEntry: true, IsAutoSubmitAndAudit: false,
    Model: {
      FID: 0,
      FBillTypeID: { FNUMBER: k.saleOrderBillType },
      FDate: date,
      FSaleOrgId: { FNumber: k.orgNumber },
      FCustId: { FNumber: customer.erp_number },
      FReceiveId: { FNumber: customer.erp_number },
      FSettleId: { FNumber: customer.erp_number },
      FChargeId: { FNumber: customer.erp_number },
      FNote: [`独立站订单 ${order.number}（PI ${order.quote_number || ''}）${order.incoterm || ''} ${order.port || ''}`.trim(), order.freight ? `运费 ${order.currency} ${order.freight}` : '', order.discount ? `整单折扣 ${order.currency} ${order.discount}` : ''].filter(Boolean).join('；'),
      FSaleOrderFinance: { FSettleCurrId: { FNumber: k.currencyMap[order.currency] || k.currencyMap.USD }, FIsIncludedTax: true, FExchangeTypeId: { FNumber: 'HLTX01_SYS' } },
      FSaleOrderEntry: order.lines.map((l) => ({
        FMaterialId: { FNumber: skuLookup(l.sku)?.erp_number || l.sku },
        FQty: l.qty,
        FTaxPrice: l.unit_price,
        FEntryNote: [l.name, l.variant].filter(Boolean).join(' ').slice(0, 255),
        FDeliveryDate: order.promised_date || date,
      })),
    },
  };
}

/** Sales receipt (收款单, AR_RECEIVEBILL): one entry, T/T or online, against the customer; bill type and settlement codes are configurable. */
export function buildReceipt(p, customer) {
  const k = K();
  const online = /^(stripe|paypal) /.test(p.ref || '') || p.kind === 'online';
  return {
    NeedUpDateFields: [], IsDeleteEntry: true, IsAutoSubmitAndAudit: false,
    Model: {
      FID: 0,
      FBillTypeID: { FNUMBER: process.env.KD_RECEIPT_BILLTYPE || 'SKDLX01_SYS' },
      FDATE: String(p.ts || new Date().toISOString()).slice(0, 10),
      FCONTACTUNITTYPE: 'BD_Customer', FCONTACTUNIT: { FNumber: customer.erp_number },
      FPAYUNITTYPE: 'BD_Customer', FPAYUNIT: { FNumber: customer.erp_number },
      FCURRENCYID: { FNumber: k.currencyMap[p.currency] || k.currencyMap.USD },
      FSETTLEORGID: { FNumber: k.orgNumber }, FSALEORGID: { FNumber: k.orgNumber }, FPAYORGID: { FNumber: k.orgNumber },
      FREMARK: `独立站订单 ${p.order_number}${p.erp_order ? `（销售订单 ${p.erp_order}）` : ''} ${p.ref || ''}`.trim().slice(0, 255),
      FRECEIVEBILLENTRY: [{
        FSETTLETYPEID: { FNumber: online ? (process.env.KD_SETTLE_ONLINE || 'JSFS06_SYS') : (process.env.KD_SETTLE_TT || 'JSFS04_SYS') },
        FPURPOSEID: { FNumber: 'SFKYT01_SYS' },
        FRECTOTALAMOUNTFOR: p.amount,
        FNOTE: `${p.kind} ${p.ref || ''}`.trim().slice(0, 255),
      }],
    },
  };
}

export const kingdee = {
  mode: 'kingdee',
  async test() { await login(); const r = await query('BD_MATERIAL', 'FNumber', '', 1); return `登录成功，可读取物料（示例：${r[0]?.[0] || '无'}）`; },
  async pushCustomer(c) { return saveResult(await post(`${STUB}.DynamicFormService.Save`, { formid: 'BD_Customer', data: buildCustomer(c) })).number; },
  async pushReceipt(p, customer) { return saveResult(await post(`${STUB}.DynamicFormService.Save`, { formid: 'AR_RECEIVEBILL', data: buildReceipt(p, customer) })).number; },
  async pushSalesOrder(order, customer, skuLookup) { return saveResult(await post(`${STUB}.DynamicFormService.Save`, { formid: 'SAL_SaleOrder', data: buildSalesOrder(order, customer, skuLookup) })).number; },
  async pullInventory(materialToSku) {
    const k = K();
    const filter = [`FStockOrgId.FNumber = '${k.orgNumber.replace(/'/g, '')}'`, k.stockFilter].filter(Boolean).join(' AND ');
    const rows = await query('STK_Inventory', 'FMaterialId.FNumber,FStockId.FName,FBaseQty', filter);
    return rows.map(([mat, wh, qty]) => ({ sku: materialToSku(mat), material: mat, warehouse: wh || '默认仓', qty: Number(qty) || 0 })).filter((r) => r.sku);
  },
  async pullMaterials() {
    const rows = await query('BD_MATERIAL', 'FNumber,FName,FSpecification', `FUseOrgId.FNumber = '${K().orgNumber.replace(/'/g, '')}' AND FForbidStatus = 'A'`);
    return rows.map(([number, name, spec]) => ({ number, name, spec }));
  },
};
