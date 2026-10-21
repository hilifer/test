// 后台：仓库 / 物流。发货台（待发货订单、打印拣货单、批量录入运单号发货）、库存（安全库存、低库存、出入库记录）、物流商对比。
import { shell, esc, fmt } from '../admin.js';
import { config } from '../config.js';
import { actorName } from '../auth.js';
import { setSetting } from '../catalog/store.js';
import * as S from '../ops/service.js';
import * as W from './warehouse.js';
import { erpLabel } from '../ops/erp/index.js';

const flash = (c) => `${c.req.query('m') ? `<div class="warn" style="background:#e8f5e9;border-color:#a5d6a7">${esc(c.req.query('m'))}</div>` : ''}${c.req.query('e') ? `<div class="warn" style="background:#fdecea;border-color:#f5b7b1">${esc(c.req.query('e'))}</div>` : ''}`;
const back = (c, path, k, v) => c.redirect(`${path}${path.includes('?') ? '&' : '?'}${k}=${encodeURIComponent(v)}`);
const SUB = '<p class="acts"><a href="/admin/warehouse">发货台</a> · <a href="/admin/warehouse/stock">库存与出入库</a> · <a href="/admin/warehouse/carriers">物流商对比</a> · <a href="/admin/shipments">发货单</a> · <a href="/admin/shop/freight">运费模板</a></p>';
const view = (title, body) => shell(title, SUB + body);
const MODES = { express: '快递', air: '空运', sea: '海运', rail: '铁路', truck: '卡车' };
const opt = (pairs, v) => pairs.map(([k, l]) => `<option value="${esc(k)}"${k === v ? ' selected' : ''}>${esc(l)}</option>`).join('');

function deskPage(c, results = null) {
  const orders = W.readyToShip();
  return view('发货台', `${flash(c)}<h2>发货台</h2><p class="mute">待发货的订单（含部分已发的）。勾选后可以打印拣货单，或在右边填运单号批量发货——每单会生成发货单、标记为运输中并通知客户。</p>
${results ? `<div class="msg" style="max-width:none"><b>批量发货结果：成功 ${results.filter((r) => r.ok).length}，失败 ${results.filter((r) => !r.ok).length}</b><ul>${results.map((r) => `<li>${r.line ? `第 ${r.line} 行 ` : ''}${esc(r.order)}：${r.ok ? `已发货，发货单 ${esc(r.shipment)}` : `<b style="color:#c62828">${esc(r.error)}</b>`}</li>`).join('')}</ul></div>` : ''}
<form method="post" action="/admin/warehouse/ship"><div class="wrap"><table><thead><tr><th><input type="checkbox" onclick="document.querySelectorAll('input[name=ids]').forEach((x)=>x.checked=this.checked)" aria-label="全选"></th><th>订单</th><th>客户</th><th>待发</th><th>箱数 / 体积</th><th>物流商</th><th>运单号</th><th>方式</th></tr></thead><tbody>
${orders.map((o) => { const rem = S.shippedQty(o).filter((l) => l.remaining > 0); const p = S.packingFor(rem.map((l) => ({ sku: l.sku, qty: l.remaining }))); let addr = {}; try { addr = JSON.parse(o.shipping_address || '{}'); } catch { /* B2B */ }
    return `<tr><td><input type="checkbox" name="ids" value="${o.id}"></td><td><a href="/admin/orders/${o.id}"><b>${esc(o.number)}</b></a>${o.channel === 'shop' ? ' <span class="pill">网店</span>' : ''}<div class="mute">${fmt(o.created_at)}</div></td><td>${esc(o.company || addr.name || o.email || '')}<div class="mute">${esc(addr.country || o.country || '')}</div></td>
<td>${rem.map((l) => `${esc(l.sku)} × ${l.remaining}`).join('<br>')}</td><td>${p.cartons} 箱 · ${p.cbm} m³${p.missing_packing_data.length ? '<div class="mute">部分缺装箱数据</div>' : ''}</td>
<td><input name="carrier_${o.id}" size="10" placeholder="DHL" aria-label="物流商"></td><td><input name="tracking_${o.id}" size="16" aria-label="运单号"></td><td><select name="mode_${o.id}" aria-label="方式">${opt(Object.entries(MODES), o.channel === 'shop' ? 'express' : 'sea')}</select></td></tr>`; }).join('') || '<tr><td colspan="8" class="mute">没有待发货的订单</td></tr>'}</tbody></table></div>
${orders.length ? '<p><button formaction="/admin/warehouse/picking" formmethod="get" formtarget="_blank">打印选中订单的拣货单</button> <button>按填写的运单号批量发货</button> <span class="mute">没填运单号的订单不会发货</span></p>' : ''}</form>
<form method="post" action="/admin/warehouse/import" class="msg" style="max-width:none;display:grid;gap:6px"><b>粘贴导入运单号</b><span class="mute">每行：订单号, 物流商, 运单号, 方式（express / air / sea / rail / truck，可省略）。可以从物流商系统或表格复制。</span><textarea name="lines" rows="4" placeholder="SO-261108-001, DHL, 1234567890, express"></textarea><div><button>导入并发货</button></div></form>`);
}

function pickingPage(list) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>拣货单</title><style>body{font:13px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#18222d;max-width:960px;margin:20px auto;padding:0 16px}
h1{font-size:22px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin:8px 0 18px}th,td{border:1px solid #d9e0e6;padding:6px 8px;text-align:left}th{background:#f4f6f8}td.n,th.n{text-align:right}.chk{width:28px}.order{page-break-inside:avoid}.mute{color:#5f6b77}@media print{button{display:none}}</style></head><body>
<h1>拣货单</h1><p class="mute">${esc(config.profile.brand)} · 打印时间 ${fmt(new Date().toISOString())} · ${list.totals.orders} 个订单 · ${list.totals.units} 件 · ${list.totals.cartons} 箱 · ${list.totals.cbm} m³ <button onclick="print()">打印</button></p>
<h2>按 SKU 汇总</h2><table><thead><tr><th class="chk">✓</th><th>SKU</th><th>品名 / 规格</th><th class="n">数量</th><th class="n">每箱</th><th class="n">箱数</th><th class="n">库存</th><th class="n">订单数</th></tr></thead><tbody>
${list.skus.map((s) => `<tr><td class="chk"></td><td><b>${esc(s.sku)}</b></td><td>${esc(s.name || '')} <span class="mute">${esc(s.variant || '')}</span></td><td class="n"><b>${s.qty}</b></td><td class="n">${s.pcsPerCarton ?? '—'}</td><td class="n">${s.cartons ?? '—'}</td><td class="n">${s.onHand ?? '—'}</td><td class="n">${s.orders}</td></tr>`).join('')}</tbody></table>
<h2>按订单</h2>${list.orders.map((o) => `<div class="order"><b>${esc(o.number)}</b> ${esc(o.company)} <span class="mute">${o.packing.cartons} 箱 · ${o.packing.cbm} m³ · 毛重 ${o.packing.gw_kg} kg</span><table><thead><tr><th class="chk">✓</th><th>SKU</th><th>品名 / 规格</th><th class="n">数量</th></tr></thead><tbody>${o.lines.map((l) => `<tr><td class="chk"></td><td>${esc(l.sku)}</td><td>${esc(l.name || '')} <span class="mute">${esc(l.variant || '')}</span></td><td class="n">${l.qty}</td></tr>`).join('')}</tbody></table></div>`).join('')}
<p class="mute">拣货人：____________　复核人：____________</p></body></html>`;
}

function stockPage(c) {
  const f = { sku: c.req.query('sku') || '', kind: c.req.query('kind') || '' };
  const low = new Set(W.lowStock().map((s) => s.sku));
  const rows = S.stockView().filter((s) => s.active);
  const local = W.localStock();
  return view('库存与出入库', `${flash(c)}<h2>库存与出入库</h2><p class="mute">${local ? '本地库存模式：发货时自动扣减，入库、出库、盘点在下面登记。' : `已接 ${erpLabel()}：现有库存以金蝶同步为准，这里只设置安全库存。`}可售 = 现有 − 未发货订单占用。低于安全库存的 SKU 标红，并在每天 8:00 推送企业微信。</p>
<form method="post" action="/admin/warehouse/safety"><div class="wrap"><table><thead><tr><th>SKU</th><th>品名</th><th class="n">现有</th><th class="n">占用</th><th class="n">可售</th><th class="n">安全库存</th></tr></thead><tbody>
${rows.map((s) => `<tr${low.has(s.sku) ? ' style="background:#fdecea"' : ''}><td><a href="?sku=${encodeURIComponent(s.sku)}"><b>${esc(s.sku)}</b></a></td><td>${esc(s.name)} <span class="mute">${esc(s.variant || '')}</span></td><td class="n">${s.on_hand}</td><td class="n">${s.reserved}</td><td class="n"><b>${s.available}</b></td><td class="n"><input name="safety_${esc(s.sku)}" value="${s.safety_stock ?? ''}" size="5" placeholder="${W.defaultSafety()}" aria-label="安全库存"></td></tr>`).join('')}</tbody></table></div>
<p><button>保存安全库存</button> <label>默认安全库存 <input name="default" value="${W.defaultSafety()}" size="4"></label> <span class="mute">留空的 SKU 使用默认值</span></p></form>
${local ? `<form method="post" action="/admin/warehouse/move" class="msg" style="max-width:none;display:flex;gap:8px;flex-wrap:wrap;align-items:end"><b style="width:100%">登记出入库</b><label>SKU <select name="sku">${opt(rows.map((s) => [s.sku, `${s.sku} · ${s.name}`]), f.sku)}</select></label><label>类型 <select name="kind">${opt(Object.entries(W.KINDS).filter(([k]) => k !== 'ship'), 'in')}</select></label>
<label>数量（盘点填实际数量） <input name="qty" size="6" required></label><label>单号 / 来源 <input name="ref" size="12"></label><label>备注 <input name="note" size="18"></label><button>登记</button></form>` : ''}
<h3>出入库记录${f.sku ? `：${esc(f.sku)}` : ''}</h3><form method="get" class="acts"><input name="sku" value="${esc(f.sku)}" placeholder="SKU"><select name="kind"><option value="">全部类型</option>${opt(Object.entries(W.KINDS), f.kind)}</select><button>筛选</button></form>
<div class="wrap"><table><thead><tr><th>时间</th><th>SKU</th><th>类型</th><th class="n">数量</th><th class="n">结存</th><th>单号</th><th>备注</th><th>操作人</th></tr></thead><tbody>${W.stockMoves(f).map((m) => `<tr><td>${fmt(m.ts)}</td><td>${esc(m.sku)}</td><td>${esc(W.KINDS[m.kind] || m.kind)}</td><td class="n" style="color:${m.qty < 0 ? '#c62828' : '#2e7d32'}">${m.qty > 0 ? '+' : ''}${m.qty}</td><td class="n">${m.balance}</td><td>${esc(m.ref || '')}</td><td>${esc(m.note || '')}</td><td>${esc(m.by)}</td></tr>`).join('') || '<tr><td colspan="8" class="mute">暂无记录</td></tr>'}</tbody></table></div>`);
}

function carriersPage(c) {
  const f = { country: c.req.query('country') || '', weightKg: c.req.query('kg') || '', cbm: c.req.query('cbm') || '' };
  const r = W.carrierComparison(f);
  const pct = (x) => `${Math.round(x * 100)}%`;
  return view('物流商对比', `<h2>物流商对比</h2>
<form method="get" class="acts"><input name="country" value="${esc(f.country)}" placeholder="国家代码，如 US" size="10"> <input name="kg" value="${esc(f.weightKg)}" placeholder="重量 kg" size="8"> <input name="cbm" value="${esc(f.cbm)}" placeholder="体积 m³" size="8"> <button>报价对比</button></form>
${f.country ? `<h3>运费模板报价：${esc(f.country.toUpperCase())} · ${esc(f.weightKg || 0)} kg</h3><div class="wrap"><table><thead><tr><th>方式</th><th class="n">运费</th><th>时效（天）</th></tr></thead><tbody>${r.quotes.map((q) => `<tr><td>${esc(q.name)}</td><td class="n">${q.free ? '包邮' : `${config.catalog.currency || 'USD'} ${q.fee}`}</td><td>${q.days[0]}–${q.days[1]}</td></tr>`).join('') || '<tr><td colspan="3" class="mute">没有可用的运费模板</td></tr>'}</tbody></table></div>` : ''}
<h3>实际表现（全部发货单）</h3><div class="wrap"><table><thead><tr><th>物流商</th><th>方式</th><th class="n">发货单</th><th class="n">已签收</th><th class="n">平均运输天数</th><th class="n">异常</th><th class="n">异常率</th></tr></thead><tbody>
${r.carriers.map((x) => `<tr><td><b>${esc(x.carrier)}</b></td><td>${x.modes.map((m) => esc(MODES[m] || m)).join('、')}</td><td class="n">${x.shipments}</td><td class="n">${x.delivered}</td><td class="n">${x.avgDays ?? '—'}</td><td class="n">${x.exceptions}</td><td class="n" style="${x.exceptionRate > 0.1 ? 'color:#c62828;font-weight:700' : ''}">${pct(x.exceptionRate)}</td></tr>`).join('') || '<tr><td colspan="7" class="mute">还没有发货记录</td></tr>'}</tbody></table></div>
<p class="mute">平均运输天数 = 从"运输中"到"已签收"。运费模板在"网店 → 运费模板"维护。</p>`);
}

export function mountWarehouseAdmin(app) {
  app.get('/admin/warehouse', (c) => c.html(deskPage(c)));
  app.get('/admin/warehouse/picking', (c) => { try { return c.html(pickingPage(W.pickingList(c.req.queries('ids') || []))); } catch (e) { return back(c, '/admin/warehouse', 'e', e.message); } });
  app.post('/admin/warehouse/ship', async (c) => {
    const f = await c.req.parseBody({ all: true });
    const one = (k) => String([].concat(f[k] ?? '')[0]).trim();
    const rows = W.readyToShip().filter((o) => one(`tracking_${o.id}`)).map((o) => ({ order: o.id, carrier: one(`carrier_${o.id}`), tracking_no: one(`tracking_${o.id}`), mode: one(`mode_${o.id}`) || 'express' }));
    if (!rows.length) return back(c, '/admin/warehouse', 'e', '请至少填写一个运单号');
    return c.html(deskPage(c, W.bulkShip(rows, actorName())));
  });
  app.post('/admin/warehouse/import', async (c) => {
    const rows = W.parseShipLines((await c.req.parseBody()).lines);
    if (!rows.length) return back(c, '/admin/warehouse', 'e', '没有读到运单号，格式：订单号, 物流商, 运单号');
    return c.html(deskPage(c, W.bulkShip(rows, actorName())));
  });
  app.post('/admin/warehouse/safety', async (c) => {
    const f = await c.req.parseBody();
    try {
      const d = Number(f.default);
      if (!(Number.isInteger(d) && d >= 0)) throw new Error('默认安全库存须为不小于 0 的整数');
      setSetting('default_safety_stock', d);
      let n = 0;
      for (const [k, v] of Object.entries(f)) { const m = k.match(/^safety_(.+)$/); if (m) { W.setSafetyStock(m[1], String(v).trim()); n++; } }
      return back(c, '/admin/warehouse/stock', 'm', `已保存 ${n} 个 SKU 的安全库存`);
    } catch (e) { return back(c, '/admin/warehouse/stock', 'e', e.message); }
  });
  app.post('/admin/warehouse/move', async (c) => {
    const f = await c.req.parseBody();
    try { const r = W.moveStock(String(f.sku), { kind: String(f.kind), qty: String(f.qty).trim(), ref: String(f.ref || ''), note: String(f.note || '') }, actorName()); return back(c, `/admin/warehouse/stock?sku=${encodeURIComponent(r.sku)}`, 'm', `已登记，${r.sku} 结存 ${r.balance}`); } catch (e) { return back(c, '/admin/warehouse/stock', 'e', e.message); }
  });
  app.get('/admin/warehouse/stock', (c) => c.html(stockPage(c)));
  app.get('/admin/warehouse/carriers', (c) => c.html(carriersPage(c)));
}
