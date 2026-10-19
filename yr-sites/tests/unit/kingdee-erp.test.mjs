// Modules: server/src/ops/erp/{kingdee.js, index.js} — Kingdee Cloud Galaxy WebAPI adapter against a mock
// Kingdee server (login cookie, Save, ExecuteBillQuery paging, error surfacing) + the ERP facade. IDs KD-xx.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempEnv } from '../helpers/env.mjs';
import { mockServer } from '../helpers/mock-http.mjs';

const state = { failSave: null, materials: 2500, loginFails: false };
const kd = await mockServer((call) => {
  const u = call.url;
  if (u.includes('AuthService.LoginByAppSecret') || u.includes('AuthService.ValidateUser')) {
    if (state.loginFails) return { json: { LoginResultType: 0, Message: '用户名或密码错误' } };
    return { json: { LoginResultType: 1 }, headers: { 'set-cookie': 'kdservice-sessionid=SID123; path=/' } };
  }
  if (call.headers.cookie !== 'kdservice-sessionid=SID123') return { status: 401, text: 'no session' };
  if (u.includes('DynamicFormService.Save')) {
    if (state.failSave) return { json: { Result: { ResponseStatus: { IsSuccess: false, Errors: [{ FieldName: 'FCustId', Message: state.failSave }] } } } };
    const n = call.body.formid === 'BD_Customer' ? 'CUST0001' : 'XSDD0001';
    return { json: { Result: { ResponseStatus: { IsSuccess: true }, Id: 1, Number: n } } };
  }
  if (u.includes('DynamicFormService.ExecuteBillQuery')) {
    const d = call.body.data;
    if (d.FormId === 'STK_Inventory') return { json: [['1.01.HBU2', '成品仓', 120], ['1.01.HBU2', '外贸仓', 30], ['UNKNOWN', '成品仓', 9]] };
    if (d.FormId === 'BD_MATERIAL') {
      const rows = [];
      for (let i = d.StartRow; i < Math.min(d.StartRow + d.Limit, state.materials); i++) rows.push([`M${i}`, `Name ${i}`, '']);
      return { json: rows };
    }
    return { json: [[{ Result: { ResponseStatus: { Errors: [{ Message: 'bad form' }] } } }]] };
  }
  return { status: 404, text: 'unknown' };
});
after(() => kd.close());

useTempEnv({ site: 'led', ERP_MODE: 'kingdee', KD_BASE_URL: kd.url, KD_ACCT_ID: 'ACC1', KD_USERNAME: 'api', KD_APP_ID: 'APP', KD_APP_SECRET: 'SECRET', KD_ORG_NUMBER: '100' });
const K = await import('../../server/src/ops/erp/kingdee.js');
const erp = await import('../../server/src/ops/erp/index.js');
const S = await import('../../server/src/ops/service.js');
const { config } = await import('../../server/src/config.js');

function makeOrder() {
  S.saveSku({ sku: 'YR-HB-U2', product_id: 'YR-HB-U2', name: 'UFO High Bay', ref_price: 45, pcs_per_carton: 4, carton_cbm: 0.06, carton_gw: 12, erp_number: '1.01.HBU2' });
  const q = S.createQuote({ customer: { email: 'buyer@acme.test', company: 'Acme Inc', country: 'USA' }, lines: [{ sku: 'YR-HB-U2', qty: 100, unit_price: 45 }], freight: 300, port: 'Los Angeles' });
  S.setQuoteStatus(q.id, 'sent');
  return S.acceptQuote(q.token);
}

describe('kingdee adapter', () => {
  test('KD-01 login uses AppSecret, keeps the session cookie and sends it on later calls', async () => {
    await K.login();
    const loginCall = kd.calls.find((c) => c.url.includes('LoginByAppSecret'));
    assert.deepEqual(loginCall.body, { acctID: 'ACC1', username: 'api', appId: 'APP', appSecret: 'SECRET', lcid: 2052 });
    const rows = await K.query('STK_Inventory', 'FMaterialId.FNumber,FStockId.FName,FBaseQty');
    assert.equal(rows.length, 3);
    assert.equal(kd.calls.at(-1).headers.cookie, 'kdservice-sessionid=SID123');
  });
  test('KD-02 query pages through results until a short page', async () => {
    const rows = await K.query('BD_MATERIAL', 'FNumber,FName,FSpecification', '', 1000);
    assert.equal(rows.length, 2500);
    const pages = kd.calls.filter((c) => c.body?.data?.FormId === 'BD_MATERIAL').map((c) => c.body.data.StartRow);
    assert.deepEqual(pages.slice(-3), [0, 1000, 2000]);
  });
  test('KD-03 query errors returned inside the array are raised', async () => {
    await assert.rejects(K.query('NOPE', 'x'), /金蝶查询失败/);
  });
  test('KD-04 buildCustomer / buildSalesOrder follow the standard data model', () => {
    const o = makeOrder();
    const c = S.getCustomer(o.customer_id);
    const bc = K.buildCustomer(c);
    assert.equal(bc.Model.FName, 'Acme Inc');
    assert.equal(bc.Model.FCreateOrgId.FNumber, '100');
    assert.equal(bc.IsAutoSubmitAndAudit, false);
    const so = K.buildSalesOrder({ ...o, quote_number: 'PI-1', freight: 300 }, { ...c, erp_number: 'CUST9' }, S.getSku);
    assert.equal(so.IsAutoSubmitAndAudit, false, 'orders are only saved, never auto-audited');
    assert.equal(so.Model.FBillTypeID.FNUMBER, 'XSDD01_SYS');
    assert.equal(so.Model.FCustId.FNumber, 'CUST9');
    assert.equal(so.Model.FSaleOrderFinance.FSettleCurrId.FNumber, 'PRE007');
    assert.deepEqual(so.Model.FSaleOrderEntry.map((e) => [e.FMaterialId.FNumber, e.FQty, e.FTaxPrice]), [['1.01.HBU2', 100, 45]]);
    assert.match(so.Model.FNote, /运费 USD 300/);
  });
  test('KD-05 failed login surfaces Kingdee\'s message', async () => {
    state.loginFails = true;
    try { await assert.rejects(K.login(), /金蝶登录失败：用户名或密码错误/); } finally { state.loginFails = false; }
  });
});

describe('ERP facade', () => {
  test('KD-06 pushOrder: creates the customer first, then saves the sales order; retry-safe', async () => {
    const o = makeOrder();
    const r = await erp.pushOrder(o.id);
    assert.deepEqual(r, { bill: 'XSDD0001' });
    assert.equal(S.getCustomer(o.customer_id).erp_number, 'CUST0001');
    assert.equal(S.getOrder(o.id).erp_bill_no, 'XSDD0001');
    const saves = kd.calls.filter((c) => c.url.includes('Save')).map((c) => c.body.formid);
    assert.deepEqual(saves.slice(-2), ['BD_Customer', 'SAL_SaleOrder']);
    assert.deepEqual(await erp.pushOrder(o.id), { already: 'XSDD0001' }, 'second push does nothing');
  });
  test('KD-07 Save errors are stored on the order and in the ERP log (shown to staff)', async () => {
    const o = makeOrder();
    state.failSave = '客户不存在';
    try {
      const r = await erp.pushOrder(o.id);
      assert.match(r.error, /金蝶保存失败：FCustId: 客户不存在/);
    } finally { state.failSave = null; }
    assert.match(S.getOrder(o.id).erp_error, /客户不存在/);
    assert.equal(erp.erpLog(1)[0].ok, 0);
  });
  test('KD-08 inventory sync maps materials to SKUs, drops unknown materials, sums warehouses', async () => {
    const r = await erp.syncInventory();
    assert.equal(r.rows, 2);
    const row = S.stockView().find((s) => s.sku === 'YR-HB-U2');
    assert.equal(row.on_hand, 150);
    assert.ok(row.synced_at);
  });
  test('KD-09 available-to-promise = on hand − open order reservations', () => {
    const row = S.stockView().find((s) => s.sku === 'YR-HB-U2');
    assert.ok(row.reserved >= 100);
    assert.equal(row.available, row.on_hand - row.reserved);
  });
  test('KD-10 mock and local modes', async () => {
    config.erp.mode = 'mock';
    assert.match(await erp.testConnection(), /模拟/);
    assert.ok((await erp.syncInventory()).rows > 0);
    config.erp.mode = 'local';
    assert.deepEqual(await erp.pushOrder('x'), { skipped: true });
    assert.match(await erp.testConnection(), /本地库存/);
    config.erp.mode = 'kingdee';
  });
});
