// 后台：运营。经营数据（访客 → 浏览 → 加购 → 下单，趋势、来源、热门页面）、商品数据（可排序、导出）、推广活动（UTM 链接、
// 花费、ROI、获客成本）、自动促销（限时折扣 / 满减）。导出的表格列名跟随后台语言。
import { shell, esc, fmt } from '../admin.js';
import { config } from '../config.js';
import { currentUser } from '../auth.js';
import * as A from './analytics.js';
import * as P from './promotions.js';
import * as E from './email.js';
import * as SEO from './seo.js';
import * as C from '../catalog/store.js';
import { TIERS, customerTags } from '../sales/crm.js';

const flash = (c) => `${c.req.query('m') ? `<div class="warn" style="background:#e8f5e9;border-color:#a5d6a7">${esc(c.req.query('m'))}</div>` : ''}${c.req.query('e') ? `<div class="warn" style="background:#fdecea;border-color:#f5b7b1">${esc(c.req.query('e'))}</div>` : ''}`;
const back = (c, path, k, v) => c.redirect(`${path}${path.includes('?') ? '&' : '?'}${k}=${encodeURIComponent(v)}`);
const SUB = '<p class="acts"><a href="/admin/marketing">经营数据</a> · <a href="/admin/marketing/products">商品数据</a> · <a href="/admin/marketing/campaigns">推广活动</a> · <a href="/admin/marketing/promotions">限时折扣 / 满减</a> · <a href="/admin/marketing/zones">首页专区</a> · <a href="/admin/marketing/emails">邮件营销</a> · <a href="/admin/marketing/seo">关键词与 AI 提及</a> · <a href="/admin/coupons">优惠券</a> · <a href="/admin/reviews">评价</a></p>';
const view = (title, body) => shell(title, SUB + body);
const money = (x) => `${config.catalog.currency || 'USD'} ${(Math.round((Number(x) || 0) * 100) / 100).toLocaleString('en-US')}`;
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
// formula characters at the start are neutralised (CSV injection), but plain numbers such as -12.5% stay numbers
const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?%?$/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (c, name, cols, rows) => { // cols: [[key, 中文, English]] — headers follow the admin language
  const en = currentUser()?.lang === 'en';
  c.header('content-type', 'text/csv; charset=utf-8');
  c.header('content-disposition', `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`);
  return c.body('﻿' + [cols.map((x) => (en ? x[2] : x[1])).join(','), ...rows.map((r) => cols.map(([k]) => csvCell(r[k])).join(','))].join('\r\n') + '\r\n');
};
const PERIODS = [[1, '今天'], [7, '近 7 天'], [30, '近 30 天'], [90, '近 90 天']];
const period = (c, d = 30) => { const n = Number(c.req.query('days')); return PERIODS.some(([k]) => k === n) ? n : d; };
const periodLinks = (days, path) => PERIODS.map(([k, l]) => `<a href="${path}?days=${k}" style="margin-right:10px;${k === days ? 'font-weight:700;color:var(--ink);text-decoration:none' : ''}">${l}</a>`).join('');

/** Small inline bar chart (one series) with a line for a second series. */
function chart(series, bar, line) {
  const W = 760, H = 160, n = series.length, bw = W / n;
  const maxB = Math.max(1, ...series.map((r) => r[bar])), maxL = Math.max(1, ...series.map((r) => r[line]));
  const pts = series.map((r, i) => `${(i + 0.5) * bw},${H - 18 - (r[line] / maxL) * (H - 30)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;background:#fff;border:1px solid var(--line);border-radius:8px" role="img" aria-label="趋势图">
${series.map((r, i) => `<rect x="${i * bw + 2}" y="${H - 18 - (r[bar] / maxB) * (H - 30)}" width="${Math.max(1, bw - 4)}" height="${(r[bar] / maxB) * (H - 30)}" fill="#90caf9"><title>${r.day}：${r[bar]}</title></rect>`).join('')}
<polyline points="${pts}" fill="none" stroke="#c62828" stroke-width="2"/>${series.map((r, i) => (i % Math.ceil(n / 6) === 0 ? `<text x="${i * bw + 2}" y="${H - 4}" font-size="10" fill="#66717d">${r.day.slice(5)}</text>` : '')).join('')}</svg>`;
}

function overviewPage(c) {
  const days = period(c, 1);
  const f = A.funnel(days);
  const series = A.dailySeries(30);
  const tile = (l, v) => `<div class="tile"><span>${l}</span><strong>${v}</strong></div>`;
  return view('经营数据', `<h2>经营数据</h2><p>${periodLinks(days, '/admin/marketing')}</p>
<div class="tiles">${tile('访客', f.visitors)}${tile('页面浏览', f.views)}${tile('商品浏览', f.productViews)}${tile('加入购物车', f.carts)}${tile('网店订单', f.orders)}${tile('下单转化率', pct(f.conversion))}${tile('询价', f.leads)}${tile('询价率', pct(f.inquiryRate))}${tile('在线成交额（已付款）', money(f.revenue))}</div>
<h3>近 30 天趋势 <span class="mute" style="font-size:13px">蓝色柱：访客；红线：网店订单</span></h3>${chart(series, 'visitors', 'orders')}
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;margin-top:16px">
<div><h3>访客来源（近 30 天）</h3><div class="wrap"><table><thead><tr><th>来源</th><th class="n">访客</th></tr></thead><tbody>${A.topSources(30).map((r) => `<tr><td>${esc(r.src)}</td><td class="n">${r.visitors}</td></tr>`).join('') || '<tr><td colspan="2" class="mute">暂无数据</td></tr>'}</tbody></table></div></div>
<div><h3>热门页面（近 30 天）</h3><div class="wrap"><table><thead><tr><th>页面</th><th class="n">浏览</th><th class="n">访客</th></tr></thead><tbody>${A.topPages(30).map((r) => `<tr><td translate="no">${esc(r.path)}</td><td class="n">${r.views}</td><td class="n">${r.visitors}</td></tr>`).join('') || '<tr><td colspan="3" class="mute">暂无数据</td></tr>'}</tbody></table></div></div></div>
<p class="mute">数据来自网站自己的统计（不使用第三方统计代码，不记录个人信息）：访客按"当天 + 网络地址 + 浏览器"去重；机器人和后台页面不计入。</p>`);
}

const SORTS = { views: '浏览', carts: '加购', orders: '订单', conversion: '转化率', revenue: '销售额', cartRate: '加购率' };
function productsPage(c) {
  const days = period(c, 30);
  const sort = SORTS[c.req.query('sort')] ? c.req.query('sort') : 'views';
  const stats = A.productStats(days);
  const rows = config.catalog.products.map((p) => ({ id: p.id, name: p.name, ...(stats.get(p.id) || { views: 0, carts: 0, orders: 0, units: 0, revenue: 0, cartRate: null, conversion: null }) }))
    .sort((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1));
  const th = (k, l) => `<th class="n"><a href="?days=${days}&sort=${k}"${k === sort ? ' style="font-weight:700;color:var(--ink)"' : ''}>${l}</a></th>`;
  const hint = (r) => (r.views >= 30 && !r.carts ? '浏览多但没人加购：检查价格、主图和详情' : r.carts >= 5 && !r.orders ? '加购多但没下单：检查运费和结算' : '');
  return view('商品数据', `<h2>商品数据</h2><p>${periodLinks(days, '/admin/marketing/products')} · <a href="/admin/marketing/products.csv?days=${days}&sort=${sort}">导出表格</a></p>
<div class="wrap"><table><thead><tr><th>商品</th>${th('views', '浏览')}${th('carts', '加购')}${th('cartRate', '加购率')}${th('orders', '订单')}${th('conversion', '转化率')}<th class="n">件数</th>${th('revenue', '销售额')}<th>提示</th></tr></thead><tbody>
${rows.map((r) => `<tr><td><a href="/admin/products/${encodeURIComponent(r.id)}"><b>${esc(r.name)}</b></a><div class="mute">${esc(r.id)}</div></td><td class="n">${r.views}</td><td class="n">${r.carts}</td><td class="n">${pct(r.cartRate)}</td><td class="n">${r.orders}</td><td class="n">${pct(r.conversion)}</td><td class="n">${r.units}</td><td class="n">${money(r.revenue)}</td><td class="mute">${hint(r)}</td></tr>`).join('')}</tbody></table></div>
<p class="mute">"浏览"来自网站商品页，"加购"是加入购物车次数，"订单"包括网店订单和报价转成的订单（取消的不算）。</p>`);
}

function campaignsPage(c) {
  const list = A.listCampaigns().map((x) => ({ ...x, s: A.campaignStats(x.code, x.spend) }));
  const edit = c.req.query('edit') ? A.getCampaign(c.req.query('edit')) : null;
  const unreg = A.unregisteredCodes();
  const inp = (n, l, v = '', a = '') => `<label class="fl2" style="display:inline-flex;flex-direction:column;margin:0 10px 8px 0;font-size:12px;color:var(--mute)">${l}<input name="${n}" value="${esc(v ?? '')}" ${a}></label>`;
  return view('推广活动', `${flash(c)}<h2>推广活动</h2><p class="mute">每个推广渠道（谷歌广告、Facebook、展会二维码、邮件、合作伙伴…）建一个活动，把生成的链接用在广告或二维码里。通过链接进来的访客在 30 天内的询价和下单都算在这个活动上；填写花费后自动计算投入产出比和获客成本。</p>
<div class="wrap"><table><thead><tr><th>活动</th><th>推广链接</th><th class="n">访客</th><th class="n">询价</th><th class="n">订单</th><th class="n">成交额（已收款）</th><th class="n">花费</th><th class="n">投入产出比</th><th class="n">单个询价成本</th><th class="n">获客成本</th><th></th></tr></thead><tbody>
${list.map((x) => `<tr><td><b>${esc(x.name)}</b><div class="mute">${esc(x.code)}${x.source ? ` · ${esc(x.source)}` : ''}${x.medium ? ` / ${esc(x.medium)}` : ''}${x.starts_at ? ` · ${esc(x.starts_at)}` : ''}${x.ends_at ? ` – ${esc(x.ends_at)}` : ''}</div></td><td><input readonly value="${esc(A.campaignLink(x))}" style="width:260px" onclick="this.select()" aria-label="推广链接"></td>
<td class="n">${x.s.visitors}</td><td class="n">${x.s.leads}</td><td class="n">${x.s.orders}</td><td class="n">${money(x.s.revenue)}</td><td class="n">${money(x.spend)}</td><td class="n">${x.s.roi == null ? '—' : pct(x.s.roi)}</td><td class="n">${x.s.costPerLead == null ? '—' : money(x.s.costPerLead)}</td><td class="n">${x.s.cac == null ? '—' : money(x.s.cac)}</td>
<td><a href="?edit=${x.id}#form">编辑</a> <form method="post" action="/admin/marketing/campaigns/${x.id}/delete" style="display:inline" onsubmit="return confirm('删除这个活动？已记录的访问数据保留。')"><button>删除</button></form></td></tr>`).join('') || '<tr><td colspan="11" class="mute">还没有推广活动</td></tr>'}</tbody></table></div>
<p><a href="/admin/marketing/campaigns.csv">导出表格</a></p>
${unreg.length ? `<h3>未登记的推广代码</h3><p class="mute">这些代码出现在访问链接里，但还没有建活动：</p><p>${unreg.map((u) => `<span class="pill" translate="no">${esc(u.code)}</span> ${u.visitors}`).join('　')}</p>` : ''}
<form method="post" action="/admin/marketing/campaigns" id="form" class="msg" style="max-width:none"><h3 style="margin-top:0">${edit ? `编辑「${esc(edit.name)}」` : '新建推广活动'}</h3>${edit ? `<input type="hidden" name="id" value="${edit.id}">` : ''}
${inp('name', '活动名称 *', edit?.name, 'required')}${inp('code', '活动代码 *（链接里的 utm_campaign）', edit?.code, 'required placeholder="google-uk-2026q4"')}${inp('source', '来源（utm_source）', edit?.source, 'placeholder="google"')}${inp('medium', '方式（utm_medium）', edit?.medium, 'placeholder="cpc"')}
${inp('landing', '落地页', edit?.landing || '/', 'placeholder="/products/ufo-high-bay-u2/"')}${inp('spend', '投放花费', edit?.spend ?? 0, 'inputmode="decimal"')}${inp('starts_at', '开始日期', edit?.starts_at, 'type="date"')}${inp('ends_at', '结束日期', edit?.ends_at, 'type="date"')}${inp('notes', '备注', edit?.notes)}<div><button>${edit ? '保存' : '创建并生成链接'}</button></div></form>`);
}

function promotionsPage(c) {
  const list = P.listPromotions();
  const edit = c.req.query('edit') ? P.getPromotion(c.req.query('edit')) : null;
  const local = (iso) => (iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60e3).toISOString().slice(0, 16) : '');
  const inp = (n, l, v = '', a = '') => `<label style="display:inline-flex;flex-direction:column;margin:0 10px 8px 0;font-size:12px;color:var(--mute)">${l}<input name="${n}" value="${esc(v ?? '')}" ${a}></label>`;
  const COL = { running: '#e3f2e5', scheduled: '#e3f2fd', ended: '#eceff1', off: '#eceff1' };
  return view('限时折扣 / 满减', `${flash(c)}<h2>限时折扣 / 满减</h2><p class="mute">到开始时间自动生效、到结束时间自动结束，客户不需要输入优惠码。购物车和结算按当时最划算的一个活动自动减价（可以和优惠码同时使用，但优惠总额不超过商品金额）；商品页显示促销标签，网站首页显示"正在促销"专区。</p>
<div class="wrap"><table><thead><tr><th>活动</th><th>优惠</th><th>适用范围</th><th>时间</th><th>状态</th><th></th></tr></thead><tbody>
${list.map((p) => { const s = P.promoState(p); return `<tr><td><b>${esc(p.name)}</b>${p.name_en ? `<div class="mute" translate="no">${esc(p.name_en)}</div>` : ''}</td><td>${p.kind === 'percent' ? `减 ${p.value}%` : `满 ${p.threshold} 减 ${p.value}`}</td><td>${p.products.length ? esc(p.products.join('、')) : ''}${p.categories.length ? `品类 ${esc(p.categories.join('、'))}` : ''}${!p.products.length && !p.categories.length ? '全部商品' : ''}</td>
<td>${fmt(p.starts_at)}<br>${fmt(p.ends_at)}</td><td><span class="pill" style="background:${COL[s]}">${P.STATES[s]}</span></td><td><a href="?edit=${p.id}#form">编辑</a> <form method="post" action="/admin/marketing/promotions/${p.id}/${p.active ? 'stop' : 'start'}" style="display:inline"><button>${p.active ? '停用' : '启用'}</button></form></td></tr>`; }).join('') || '<tr><td colspan="6" class="mute">还没有促销活动</td></tr>'}</tbody></table></div>
<form method="post" action="/admin/marketing/promotions" id="form" class="msg" style="max-width:none"><h3 style="margin-top:0">${edit ? `编辑「${esc(edit.name)}」` : '新建促销活动'}</h3>${edit ? `<input type="hidden" name="id" value="${edit.id}">` : ''}
${inp('name', '名称（中文）*', edit?.name, 'required placeholder="双十一大促"')}${inp('name_en', '名称（英文，客户看到的）', edit?.name_en, 'placeholder="Black Friday"')}
<label style="display:inline-flex;flex-direction:column;margin:0 10px 8px 0;font-size:12px;color:var(--mute)">类型<select name="kind">${Object.entries(P.KINDS).map(([k, l]) => `<option value="${k}"${(edit?.kind || 'percent') === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
${inp('value', '折扣 %（打折）或减免金额（满减）*', edit?.value, 'required inputmode="decimal"')}${inp('threshold', '满减门槛金额', edit?.threshold || '', 'inputmode="decimal"')}<br>
${inp('products', '指定商品（型号，逗号分隔，可留空）', edit?.products?.join(', '), 'size="30"')}${inp('categories', '或指定品类（编码，逗号分隔）', edit?.categories?.join(', '))}<br>
${inp('starts_at', '开始时间 *', local(edit?.starts_at), 'type="datetime-local" required')}${inp('ends_at', '结束时间 *', local(edit?.ends_at), 'type="datetime-local" required')}<div><button>${edit ? '保存' : '创建'}</button></div></form>`);
}

/** Line chart of 0–1 rates (or positions when `invert`), with labels. points: [{ x, y }] */
function lineChart(points, { invert = false, max = 1, label = (v) => `${Math.round(v * 100)}%` } = {}) {
  if (!points.length) return '<p class="mute">还没有数据</p>';
  const W = 520, H = 140, n = points.length, step = n > 1 ? (W - 40) / (n - 1) : 0;
  const y = (v) => (invert ? 10 + ((v - 1) / Math.max(1, max - 1)) * (H - 40) : H - 30 - (v / max) * (H - 40));
  const pts = points.filter((p) => p.y != null).map((p) => `${20 + points.indexOf(p) * step},${y(p.y)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;background:#fff;border:1px solid var(--line);border-radius:8px" role="img" aria-label="趋势图"><polyline points="${pts}" fill="none" stroke="#1565c0" stroke-width="2"/>
${points.map((p, i) => (p.y == null ? '' : `<circle cx="${20 + i * step}" cy="${y(p.y)}" r="3" fill="#1565c0"><title>${esc(p.x)}：${label(p.y)}</title></circle>`)).join('')}${points.map((p, i) => (i % Math.ceil(n / 6) === 0 ? `<text x="${20 + i * step - 14}" y="${H - 8}" font-size="10" fill="#66717d">${esc(String(p.x).slice(5))}</text>` : '')).join('')}</svg>`;
}

function zonesPage(c) {
  const na = C.newArrivalsSettings();
  const ids = C.newArrivalIds();
  const name = (id) => C.getProduct(id)?.name || id;
  const promos = P.running();
  return view('首页专区', `${flash(c)}<h2>首页专区</h2><p class="mute">网站首页依次显示：正在促销（自动）、新品上市、推荐产品。修改新品区和推荐区后点商品页的"发布到网站"生效。</p>
<h3>正在促销</h3><p>${promos.length ? promos.map((p) => `<span class="pill" style="background:#fdecea">${esc(p.name)}</span>`).join(' ') : '<span class="mute">现在没有进行中的促销，首页不显示这个专区</span>'} · <a href="/admin/marketing/promotions">管理促销</a></p>
<h3>新品上市</h3><form method="post" action="/admin/marketing/zones" class="msg" style="max-width:none;display:grid;gap:8px">
<label><input type="radio" name="mode" value="auto"${na.mode === 'auto' ? ' checked' : ''}> 自动：最近上架的商品</label><label><input type="radio" name="mode" value="manual"${na.mode === 'manual' ? ' checked' : ''}> 手动指定（按填写顺序）</label><label><input type="radio" name="mode" value="off"${na.mode === 'off' ? ' checked' : ''}> 不显示</label>
<label>显示数量 <input name="count" value="${na.count}" size="3"></label><label>手动指定的型号（逗号或换行分隔）<textarea name="ids" rows="2">${esc(na.ids.join(', '))}</textarea></label><div><button>保存</button></div></form>
<p>当前新品区：${ids.length ? ids.map((id) => `<a href="/admin/products/${encodeURIComponent(id)}">${esc(name(id))}</a>`).join('、') : '<span class="mute">无</span>'}</p>
<h3>推荐产品</h3><p>${C.featuredIds().map((id) => `<a href="/admin/products/${encodeURIComponent(id)}">${esc(name(id))}</a>`).join('、') || '<span class="mute">无</span>'} · <a href="/admin/products?featured=1">在商品列表里设置推荐和顺序</a></p>`);
}

function emailsPage(c) {
  const list = E.listEmailCampaigns();
  const edit = c.req.query('edit') ? E.getEmailCampaign(c.req.query('edit')) : null;
  const a = edit?.audience || {};
  const count = E.audienceOf(a).length;
  return view('邮件营销', `${flash(c)}<h2>邮件营销</h2><p class="mute">只发给同意接收营销邮件的客户（注册时勾选），每封邮件都带一键退订链接；退订后不会再收到。发送在任务中心逐封进行，可以查看进度和失败原因。${process.env.SMTP_URL ? '' : ' <b>未配置 SMTP_URL：邮件只会记录，不会真正发出。</b>'}</p>
<div class="wrap"><table><thead><tr><th>邮件</th><th>收件范围</th><th>状态</th><th class="n">收件人</th><th class="n">已发送</th><th class="n">打开</th><th class="n">打开率</th><th class="n">退订</th><th></th></tr></thead><tbody>
${list.map((m) => { const st = E.emailStats(m.id); const au = [m.audience.tags?.length ? `标签 ${m.audience.tags.join('、')}` : '', m.audience.tier ? TIERS[m.audience.tier] : '', m.audience.vip ? 'VIP' : '', m.audience.lang ? (m.audience.lang === 'zh' ? '中文客户' : '英文客户') : ''].filter(Boolean).join(' · ') || '全部同意接收的客户';
    return `<tr><td><b translate="no">${esc(m.subject)}</b><div class="mute">${esc(m.created_by)} ${fmt(m.created_at)}</div></td><td>${esc(au)}</td><td>${m.status === 'draft' ? '草稿' : `已发送 ${fmt(m.sent_at)}${m.task_id ? ` · <a href="/admin/tasks/${m.task_id}">发送进度</a>` : ''}`}</td><td class="n">${m.status === 'draft' ? E.audienceOf(m.audience).length : `<a href="/admin/marketing/emails/${m.id}">${st.total}</a>`}</td><td class="n">${st.sent}</td><td class="n">${st.opened}</td><td class="n">${pct(st.openRate)}</td><td class="n">${st.unsubscribed}</td>
<td>${m.status === 'draft' ? `<a href="?edit=${m.id}#form">编辑</a> <form method="post" action="/admin/marketing/emails/${m.id}/send" style="display:inline" onsubmit="return confirm('确定发送？发送后不能撤回。')"><button>发送</button></form> <form method="post" action="/admin/marketing/emails/${m.id}/delete" style="display:inline"><button>删除</button></form>` : ''}</td></tr>`; }).join('') || '<tr><td colspan="9" class="mute">还没有邮件</td></tr>'}</tbody></table></div>
<form method="post" action="/admin/marketing/emails" id="form" class="msg" style="max-width:none;display:grid;gap:8px"><h3 style="margin:0">${edit ? '编辑邮件' : '写一封营销邮件'}</h3>${edit ? `<input type="hidden" name="id" value="${edit.id}">` : ''}
<label>标题 <input name="subject" value="${esc(edit?.subject || '')}" required style="width:100%"></label><label>内容（纯文本，空行分段，网址自动变成链接，{{name}} 替换为客户称呼）<textarea name="body" rows="8">${esc(edit?.body || '')}</textarea></label>
<div style="display:flex;gap:10px;flex-wrap:wrap"><label>标签 <input name="tags" value="${esc((a.tags || []).join(', '))}" list="etags"><datalist id="etags">${customerTags().map((t) => `<option value="${esc(t)}">`).join('')}</datalist></label>
<label>客户类型 <select name="tier"><option value="">全部</option>${Object.entries(TIERS).map(([k, l]) => `<option value="${k}"${a.tier === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
<label>语言 <select name="lang"><option value="">全部</option><option value="en"${a.lang === 'en' ? ' selected' : ''}>English</option><option value="zh"${a.lang === 'zh' ? ' selected' : ''}>中文</option></select></label><label><input type="checkbox" name="vip" value="1"${a.vip ? ' checked' : ''}> 只发 VIP</label></div>
${edit ? `<p class="mute">按当前条件，有 <b>${count}</b> 位同意接收的客户。</p>` : ''}<div><button>保存草稿</button></div></form>
${edit ? `<form method="post" action="/admin/marketing/emails/${edit.id}/test" class="acts"><input name="to" type="email" placeholder="测试邮箱" required> <button>发一封测试邮件</button></form>` : ''}`);
}

function seoPage(c) {
  const engine = SEO.ENGINES[c.req.query('engine')] ? c.req.query('engine') : 'google';
  const rows = SEO.keywordTable(engine);
  const trend = SEO.aiMentionTrend(12);
  const today = new Date().toISOString().slice(0, 10);
  const spark = (hist) => lineChart(hist.map((h) => ({ x: h.day, y: h.position })), { invert: true, max: 100, label: (v) => `#${v}` });
  return view('关键词与 AI 提及', `${flash(c)}<h2>关键词与 AI 提及</h2>
<h3>AI 搜索提及率（每周）</h3><p class="mute">来自 GEO 监测：大模型回答客户常见问题时提到我们的比例。<a href="/admin/geo">查看每个问题的回答</a></p>${lineChart(trend.map((w) => ({ x: w.week, y: w.rate })))}
${trend.length ? `<p class="mute">${trend.map((w) => `${w.week.slice(5)}：${w.mentioned}/${w.checks}`).join(' · ')}</p>` : ''}
<h3>关键词排名 <span class="mute" style="font-size:13px">${Object.entries(SEO.ENGINES).map(([k, l]) => `<a href="?engine=${k}"${k === engine ? ' style="font-weight:700;color:var(--ink)"' : ''}>${l}</a>`).join(' · ')}</span></h3>
<form method="post" action="/admin/marketing/seo/ranks" id="ranks"><input type="hidden" name="engine" value="${engine}"><input type="hidden" name="day" value="${today}">
<div class="wrap"><table><thead><tr><th>关键词</th><th>目标页面</th><th class="n">最新排名</th><th class="n">变化</th><th>记录日期</th><th>今天的排名</th><th></th></tr></thead><tbody>
${rows.map((k) => `<tr><td><b translate="no">${esc(k.keyword)}</b> <span class="mute">${k.lang === 'zh' ? '中文' : 'EN'}</span></td><td class="mute" translate="no">${esc(k.target_url || '')}</td><td class="n">${k.last ? (k.last.position ?? '100+') : '—'}</td>
<td class="n">${k.change == null ? '' : k.change > 0 ? `<b style="color:#2e7d32">↑${k.change}</b>` : k.change < 0 ? `<b style="color:#c62828">↓${-k.change}</b>` : '—'}</td><td>${k.last ? esc(k.last.day) : ''}</td><td><input name="pos_${k.id}" size="4" placeholder="1–100" aria-label="今天的排名"></td>
<td><details><summary>趋势</summary>${spark(k.hist)}</details></td></tr>`).join('') || '<tr><td colspan="7" class="mute">还没有关键词</td></tr>'}</tbody></table></div>
${rows.length ? '<p><button>保存今天的排名</button> <span class="mute">没进前 100 的留空</span></p>' : ''}</form>
<form method="post" action="/admin/marketing/seo/keywords" class="acts"><input name="keyword" placeholder="关键词，如 ufo high bay light" required size="30"> <select name="lang" aria-label="语言"><option value="en">English</option><option value="zh">中文</option></select> <input name="target_url" placeholder="目标页面（可选）" size="24"> <button>添加关键词</button></form>
<form method="post" action="/admin/marketing/seo/import" class="msg" style="max-width:none;display:grid;gap:6px"><b>从排名工具导入</b><span class="mute">每行：关键词, 排名, 网址, 搜索引擎（google / bing / baidu）, 日期——从 Ahrefs、Semrush、站长工具等导出后粘贴即可。</span><textarea name="csv" rows="4" placeholder="ufo high bay light, 8, https://…, google, ${today}"></textarea><div><button>导入</button></div></form>`);
}

export function mountGrowthAdmin(app) {
  app.get('/admin/marketing', (c) => c.html(overviewPage(c)));
  app.get('/admin/marketing/products', (c) => c.html(productsPage(c)));
  app.get('/admin/marketing/products.csv', (c) => {
    const days = period(c, 30);
    const stats = A.productStats(days);
    const rows = config.catalog.products.map((p) => { const s = stats.get(p.id) || {}; return { id: p.id, name: p.name, views: s.views || 0, carts: s.carts || 0, orders: s.orders || 0, units: s.units || 0, revenue: Math.round((s.revenue || 0) * 100) / 100, conversion: s.conversion == null ? '' : (s.conversion * 100).toFixed(1) + '%' }; });
    return csv(c, 'product-data', [['id', '型号', 'Model'], ['name', '名称', 'Name'], ['views', '浏览', 'Views'], ['carts', '加购', 'Add to cart'], ['orders', '订单', 'Orders'], ['units', '件数', 'Units'], ['revenue', '销售额', 'Revenue'], ['conversion', '转化率', 'Conversion']], rows);
  });
  app.get('/admin/marketing/campaigns', (c) => c.html(campaignsPage(c)));
  app.get('/admin/marketing/campaigns.csv', (c) => csv(c, 'campaigns', [['name', '活动', 'Campaign'], ['code', '代码', 'Code'], ['visitors', '访客', 'Visitors'], ['leads', '询价', 'Inquiries'], ['orders', '订单', 'Orders'], ['revenue', '成交额', 'Revenue'], ['spend', '花费', 'Spend'], ['roi', '投入产出比', 'ROI'], ['cac', '获客成本', 'Cost per customer']],
    A.listCampaigns().map((x) => { const s = A.campaignStats(x.code, x.spend); return { ...x, ...s, roi: s.roi == null ? '' : (s.roi * 100).toFixed(1) + '%', cac: s.cac == null ? '' : Math.round(s.cac * 100) / 100 }; })));
  app.post('/admin/marketing/campaigns', async (c) => {
    const f = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]));
    try { A.saveCampaign(f); return back(c, '/admin/marketing/campaigns', 'm', f.id ? '已保存' : '活动已创建，复制下面的推广链接使用'); } catch (e) { return back(c, `/admin/marketing/campaigns${f.id ? `?edit=${f.id}` : ''}`, 'e', e.message); }
  });
  app.post('/admin/marketing/campaigns/:id/delete', (c) => { A.deleteCampaign(c.req.param('id')); return back(c, '/admin/marketing/campaigns', 'm', '已删除'); });
  app.get('/admin/marketing/promotions', (c) => c.html(promotionsPage(c)));
  app.post('/admin/marketing/promotions', async (c) => {
    const f = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]));
    try { P.savePromotion(f); return back(c, '/admin/marketing/promotions', 'm', '促销活动已保存，到时间自动生效'); } catch (e) { return back(c, `/admin/marketing/promotions${f.id ? `?edit=${f.id}` : ''}`, 'e', e.message); }
  });
  app.get('/admin/marketing/zones', (c) => c.html(zonesPage(c)));
  app.post('/admin/marketing/zones', async (c) => { const f = await c.req.parseBody(); try { C.saveNewArrivals({ mode: String(f.mode || 'auto'), count: f.count, ids: String(f.ids || '') }); return back(c, '/admin/marketing/zones', 'm', '新品区已保存，发布网站后生效'); } catch (e) { return back(c, '/admin/marketing/zones', 'e', e.message); } });
  app.get('/admin/marketing/emails', (c) => c.html(emailsPage(c)));
  app.post('/admin/marketing/emails', async (c) => {
    const f = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]));
    try { const id = E.saveEmailCampaign({ id: f.id, subject: f.subject, body: f.body, audience: { tags: f.tags, tier: f.tier, vip: f.vip, lang: f.lang } }); return back(c, `/admin/marketing/emails?edit=${id}`, 'm', '草稿已保存'); } catch (e) { return back(c, `/admin/marketing/emails${f.id ? `?edit=${f.id}` : ''}`, 'e', e.message); }
  });
  app.get('/admin/marketing/emails/:id', (c) => {
    const m = E.getEmailCampaign(c.req.param('id'));
    if (!m) return c.html(view('邮件营销', '<p>邮件不存在</p>'), 404);
    const ST = { queued: '等待', sent: '已发送', failed: '失败', skipped: '已退订，跳过' };
    return c.html(view('收件人', `<p><a href="/admin/marketing/emails">← 邮件营销</a></p><h2 translate="no">${esc(m.subject)}</h2><div class="wrap"><table><thead><tr><th>邮箱</th><th>状态</th><th>发送时间</th><th>首次打开</th><th class="n">打开次数</th><th>退订</th></tr></thead><tbody>
${E.recipientsOf(m.id).map((r) => `<tr><td>${esc(r.email)}</td><td>${ST[r.status] || esc(r.status)}${r.error ? ` <span class="mute">${esc(r.error)}</span>` : ''}</td><td>${fmt(r.sent_at)}</td><td>${fmt(r.opened_at)}</td><td class="n">${r.opens}</td><td>${fmt(r.unsubscribed_at)}</td></tr>`).join('') || '<tr><td colspan="6" class="mute">还没有发送</td></tr>'}</tbody></table></div>`));
  });
  app.post('/admin/marketing/emails/:id/test', async (c) => { try { const r = await E.sendTest(c.req.param('id'), String((await c.req.parseBody()).to || '')); return back(c, `/admin/marketing/emails?edit=${c.req.param('id')}`, r.status === 'failed' ? 'e' : 'm', r.status === 'failed' ? '测试邮件发送失败' : r.status === 'logged' ? '测试邮件已记录（未配置 SMTP，未真正发出）' : '测试邮件已发送'); } catch (e) { return back(c, `/admin/marketing/emails?edit=${c.req.param('id')}`, 'e', e.message); } });
  app.post('/admin/marketing/emails/:id/send', (c) => { try { const r = E.sendEmailCampaign(c.req.param('id')); return c.redirect(`/admin/tasks/${r.taskId}?m=${encodeURIComponent(`开始发送给 ${r.recipients} 位客户`)}`); } catch (e) { return back(c, '/admin/marketing/emails', 'e', e.message); } });
  app.post('/admin/marketing/emails/:id/delete', (c) => { try { E.deleteEmailCampaign(c.req.param('id')); return back(c, '/admin/marketing/emails', 'm', '已删除'); } catch (e) { return back(c, '/admin/marketing/emails', 'e', e.message); } });
  app.get('/admin/marketing/seo', (c) => c.html(seoPage(c)));
  app.post('/admin/marketing/seo/keywords', async (c) => { const f = await c.req.parseBody(); try { SEO.addKeyword({ keyword: f.keyword, lang: String(f.lang || 'en'), target_url: String(f.target_url || '') }); return back(c, '/admin/marketing/seo', 'm', '已添加'); } catch (e) { return back(c, '/admin/marketing/seo', 'e', e.message); } });
  app.post('/admin/marketing/seo/ranks', async (c) => {
    const f = await c.req.parseBody();
    try {
      let n = 0;
      for (const [k, v] of Object.entries(f)) { const m = k.match(/^pos_(\d+)$/); if (m && String(v).trim() !== '') { SEO.recordRank(m[1], { day: String(f.day), engine: String(f.engine), position: String(v).trim() }); n++; } }
      return back(c, `/admin/marketing/seo?engine=${f.engine}`, 'm', `已保存 ${n} 个排名`);
    } catch (e) { return back(c, '/admin/marketing/seo', 'e', e.message); }
  });
  app.post('/admin/marketing/seo/import', async (c) => { const r = SEO.importRanks((await c.req.parseBody()).csv); return back(c, '/admin/marketing/seo', r.errors.length ? 'e' : 'm', `导入 ${r.recorded} 条排名，新增 ${r.added} 个关键词${r.errors.length ? `；${r.errors.slice(0, 3).join('；')}` : ''}`); });
  app.post('/admin/marketing/promotions/:id/stop', (c) => { P.setPromotionActive(c.req.param('id'), false); return back(c, '/admin/marketing/promotions', 'm', '已停用'); });
  app.post('/admin/marketing/promotions/:id/start', (c) => { P.setPromotionActive(c.req.param('id'), true); return back(c, '/admin/marketing/promotions', 'm', '已启用'); });
}
