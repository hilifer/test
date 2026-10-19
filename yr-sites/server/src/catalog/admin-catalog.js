// 后台：商品中心（商品、规格/SKU、图片、批量导入导出、品类、站点设置、发布到网站）
import { randomBytes } from 'node:crypto';
import { bodyLimit } from 'hono/body-limit';
import { config } from '../config.js';
import { shell, esc, fmt } from '../admin.js';
import * as C from './store.js';
import { STATUSES, specsText, bandsText, productToRow, rowToProduct, toCsv, parseCsv, parseXlsx, validateProduct, parseBands } from './validate.js';
import { rebuild, indexNow, buildRunning } from '../content/publisher.js';
import { recentRuns } from '../content/store.js';
import { seedSkus, stockView } from '../ops/service.js';
import { publishAndPromote } from './autolist.js';
import * as AL from './autolist.js';
import { erpLabel } from '../ops/erp/index.js';
import { aiEnabled } from '../config.js';

const ILLUS = { led: ['ufo', 'linear-hb', 'shoebox', 'street', 'solar', 'flood', 'sports', 'wallpack', 'canopy', 'panel', 'triproof'], grid: ['cabinet', 'cabinet-small', 'home-battery', 'inverter', 'module', 'wallbox', 'dc-charger'] };
const MODES = { both: '在线购买 + 询价', shop: '仅在线购买', inquiry: '仅询价（不在线销售）' };
const zh = () => config.site === 'grid';
const CSS = `<style>
.card{background:#fff;border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-bottom:14px}.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.fl{display:grid;gap:4px;font-size:13px;color:#66717d}.fl input,.fl select,.fl textarea,td input{font:14px/1.4 inherit;padding:6px 8px;border:1px solid #cfd6dc;border-radius:6px;color:#1d2733;background:#fff;width:100%;box-sizing:border-box}
.fl textarea{min-height:90px}.btn{display:inline-block;padding:7px 14px;border-radius:6px;border:1px solid #1d2733;background:#1d2733;color:#fff;font:600 13px/1.4 inherit;cursor:pointer;text-decoration:none}.btn.l{background:#fff;color:#1d2733}.btn.g{background:#2e7d32;border-color:#2e7d32}.btn.r{background:#fff;color:#c62828;border-color:#c62828}
.acts{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}.flash{background:#e8f5e9;border:1px solid #a5d6a7;padding:10px 14px;border-radius:8px;margin-bottom:14px}.flash.err{background:#fdecea;border-color:#f5b7b1}.flash.warn{background:#fff4e5;border-color:#ffcc80}
.thumb{width:48px;height:48px;object-fit:cover;border-radius:6px;background:#eef1f4;display:block}.imgs{display:flex;gap:10px;flex-wrap:wrap}.imgs figure{margin:0;width:120px;font-size:12px}.imgs img{width:120px;height:120px;object-fit:cover;border-radius:8px;border:1px solid var(--line)}
.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.vt td{padding:4px}.vt input{min-width:70px}.sub{display:flex;gap:6px;flex-wrap:wrap;margin:-6px 0 16px}.sub a{padding:4px 10px;border:1px solid var(--line);border-radius:999px;background:#fff;text-decoration:none;color:#1d2733;font-size:13px}
.pub{display:flex;gap:12px;align-items:center;flex-wrap:wrap;background:#fff;border:1px solid var(--line);border-left:4px solid #2e7d32;border-radius:8px;padding:10px 14px;margin-bottom:14px}.pub.dirty{border-left-color:#ef8f00}
</style>`;
const SUB = `<div class="sub">${[['/admin/products', '商品列表'], ['/admin/products/new', '新增商品'], ['/admin/products/autolist', 'AI 自动上架'], ['/admin/products/import', '批量导入'], ['/admin/products/export.csv', '导出全部'], ['/admin/categories', '品类'], ['/admin/settings', '站点设置']].map(([h, l]) => `<a href="${h}">${l}</a>`).join('')}</div>`;
const view = (title, body, c) => shell(title, CSS + SUB + publishBar() + flashes(c) + body);
const flashes = (c) => `${c?.req.query('m') ? `<div class="flash">${esc(c.req.query('m'))}</div>` : ''}${c?.req.query('w') ? `<div class="flash warn">${esc(c.req.query('w'))}</div>` : ''}${c?.req.query('e') ? `<div class="flash err">${esc(c.req.query('e'))}</div>` : ''}`;
const back = (c, path, { m, e, w } = {}) => c.redirect(path + '?' + new URLSearchParams(Object.entries({ m, e, w }).filter(([, v]) => v)).toString());
const inp = (label, name, value = '', attrs = '') => `<label class="fl"><span>${label}</span><input name="${name}" value="${esc(value ?? '')}" ${attrs}></label>`;
const area = (label, name, value = '', attrs = '') => `<label class="fl"><span>${label}</span><textarea name="${name}" ${attrs}>${esc(value ?? '')}</textarea></label>`;
const sel = (label, name, pairs, v) => `<label class="fl"><span>${label}</span><select name="${name}">${pairs.map(([k, l]) => `<option value="${esc(k)}"${String(k) === String(v ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
const money = (n) => (n == null ? '—' : `${C.getSetting('catalog_meta', {}).currency || 'USD'} ${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);

function publishBar() {
  const dirty = C.isDirty();
  const last = C.getSetting('last_publish');
  const build = recentRuns(20).find((r) => r.kind === 'build');
  return `<div class="pub${dirty ? ' dirty' : ''}"><b>${dirty ? '有未发布的修改' : '网站已是最新'}</b><span class="mute">${last ? `上次发布：${fmt(last.ts)} · ${esc(last.actor)} · ${last.products} 个商品` : '尚未发布过'}${build ? ` · 网站构建：${build.status === 'ok' ? '成功' : '失败'} ${fmt(build.ts)}` : ''}${buildRunning() ? ' · <b>构建中…</b>' : ''}</span>
<form method="post" action="/admin/products/publish" style="margin-left:auto"><button class="btn g"${dirty ? '' : ' title="没有新修改也可以重新发布"'}>发布到网站</button></form></div>`;
}

// ---------------------------------------------------------------- list
function listPage(c) {
  const q = c.req.query('q') || '', category = c.req.query('category') || '', status = c.req.query('status') || '';
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const { total, rows } = C.listProducts({ q, category, status, page, pageSize: 50 });
  const cats = C.listCategories();
  const stock = new Map(stockView().map((s) => [s.sku, s]));
  const tr = rows.map((p) => {
    const vs = C.skusFor(p.id);
    const prices = vs.map((v) => v.price).filter((x) => x != null);
    const avail = vs.reduce((a, v) => a + (stock.get(v.sku)?.available || 0), 0);
    return `<tr><td>${p.image ? `<img class="thumb" src="${esc(p.image)}" alt="">` : '<span class="thumb"></span>'}</td><td><a href="/admin/products/${encodeURIComponent(p.id)}"><b>${esc(p.name)}</b></a><div class="mute">${esc(p.id)}${p.nameZh ? ' · ' + esc(p.nameZh) : ''}</div></td>
<td>${esc(cats.find((x) => x.id === p.category)?.name || p.category)}</td><td><span class="pill">${esc(STATUSES[p._status])}</span><div class="mute">${esc(MODES[p._salesMode])}</div></td>
<td class="n">${prices.length ? `${money(Math.min(...prices))}${prices.length > 1 && Math.max(...prices) !== Math.min(...prices) ? ' 起' : ''}` : '—'}</td><td class="n">${vs.length}</td><td class="n">${avail}</td><td class="mute">${fmt(p._updatedAt)}<br>${esc(p._updatedBy || '')}</td></tr>`;
  }).join('');
  const pages = Math.max(1, Math.ceil(total / 50));
  return view('商品', `<h2>商品（${total}）</h2><form class="acts" method="get"><input name="q" value="${esc(q)}" placeholder="型号 / 名称"><select name="category"><option value="">全部品类</option>${cats.map((x) => `<option value="${esc(x.id)}"${x.id === category ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
<select name="status"><option value="">全部状态</option>${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}"${k === status ? ' selected' : ''}>${v}</option>`).join('')}</select><button class="btn l">筛选</button><a class="btn" href="/admin/products/new">＋ 新增商品</a></form>
<div class="wrap"><table><thead><tr><th></th><th>商品</th><th>品类</th><th>状态</th><th class="n">售价</th><th class="n">规格数</th><th class="n">可售库存</th><th>最近修改</th></tr></thead><tbody>${tr || '<tr><td colspan="8" class="mute">没有符合条件的商品</td></tr>'}</tbody></table></div>
${pages > 1 ? `<p class="acts">${Array.from({ length: pages }, (_, i) => `<a class="btn ${i + 1 === page ? '' : 'l'}" href="?${new URLSearchParams({ q, category, status, page: i + 1 })}">${i + 1}</a>`).join('')}</p>` : ''}`, c);
}

// ---------------------------------------------------------------- edit
function editPage(c, p, { isNew = false, errors = [], warnings = [], variants = null } = {}) {
  const cats = C.listCategories();
  const meta = C.getSetting('catalog_meta', {});
  const vs = variants || (isNew ? [] : C.skusFor(p.id).map((s) => ({ ...s, options: C.optionsText(s.options), tier_prices: C.tiersText(s.tier_prices) })));
  const stock = new Map(stockView().map((s) => [s.sku, s]));
  const blank = Array.from({ length: Math.max(1, 2 - (vs.length ? 1 : 0)) }, () => ({}));
  const rows = [...vs, ...blank].map((v, i) => `<tr><td><input name="v_${i}_sku" value="${esc(v.sku)}" placeholder="${isNew && i === 0 ? '如 YR-HB-U2-150' : ''}"></td><td><input name="v_${i}_options" value="${esc(v.options)}" placeholder="功率=150W; 色温=5000K"></td>
<td><input name="v_${i}_price" value="${esc(v.price)}" inputmode="decimal"></td><td><input name="v_${i}_compare_at" value="${esc(v.compare_at)}" inputmode="decimal"></td><td><input name="v_${i}_tier_prices" value="${esc(v.tier_prices)}" placeholder="100:35 | 500:32"></td>
<td><input name="v_${i}_min_qty" value="${esc(v.min_qty ?? 1)}" inputmode="numeric"></td><td><input name="v_${i}_weight_kg" value="${esc(v.weight_kg)}" inputmode="decimal"></td>
<td><input name="v_${i}_stock_local" value="${esc(v.stock_local ?? 0)}" inputmode="numeric"${config.erp.mode === 'local' ? '' : ' title="已接 ERP，库存以金蝶同步为准"'}>${v.sku && stock.get(v.sku) ? `<div class="mute">可售 ${stock.get(v.sku).available}</div>` : ''}</td>
<td><input name="v_${i}_pcs_per_carton" value="${esc(v.pcs_per_carton)}"></td><td><input name="v_${i}_carton_cbm" value="${esc(v.carton_cbm)}"></td><td><input name="v_${i}_carton_gw" value="${esc(v.carton_gw)}"></td><td><input name="v_${i}_erp_number" value="${esc(v.erp_number)}"></td></tr>`).join('');
  const imgs = (p.images || []).map((u, i) => `<figure><img src="${esc(u)}" alt=""><label><input type="checkbox" name="img_remove" value="${esc(u)}"> 删除</label> <label>顺序 <input name="img_order_${i}" value="${i + 1}" style="width:40px"><input type="hidden" name="img_url_${i}" value="${esc(u)}"></label></figure>`).join('');
  const feat = meta.features ? `<div class="fl"><span>功能标签（用于产品筛选）</span><div>${Object.entries(meta.features).map(([k, l]) => `<label style="margin-right:12px"><input type="checkbox" name="features" value="${esc(k)}"${(p.features || []).includes(k) ? ' checked' : ''}> ${esc(l)}</label>`).join('')}</div></div>` : '';
  const revs = isNew ? '' : `<h3>修改记录</h3><table><tbody>${C.revisionsFor(p.id).map((r) => `<tr><td>${fmt(r.ts)}</td><td>${esc(r.actor)}</td><td>v${r.version}</td><td>${esc(r.summary)}</td></tr>`).join('') || '<tr><td class="mute">暂无</td></tr>'}</tbody></table>`;
  const action = isNew ? '/admin/products/new' : `/admin/products/${encodeURIComponent(p.id)}`;
  return view(isNew ? '新增商品' : p.name, `<p><a href="/admin/products">← 商品列表</a></p><h2>${isNew ? '新增商品' : esc(p.name)} ${isNew ? '' : `<span class="pill">${esc(STATUSES[p._status])}</span>`}</h2>
${errors.length ? `<div class="flash err"><b>请修正以下问题：</b><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}${warnings.length ? `<div class="flash warn"><ul>${warnings.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
<form method="post" action="${action}" enctype="multipart/form-data"><input type="hidden" name="_version" value="${esc(p._version ?? '')}">
<div class="card"><h3>基本信息</h3><div class="grid2">${inp('型号/编码 *', 'id', p.id, isNew ? 'required' : 'readonly')}${inp('名称 *', 'name', p.name, 'required maxlength="120"')}${zh() ? inp('中文名称', 'nameZh', p.nameZh) : ''}
${sel('品类 *', 'category', cats.map((x) => [x.id, x.name]), p.category)}${inp('网址别名（留空自动生成）', 'slug', p.slug)}${sel('状态', 'status', Object.entries(STATUSES), p._status || 'draft')}${sel('销售方式', 'salesMode', Object.entries(MODES), p._salesMode || 'both')}
${sel('示意图（无照片时显示）', 'illus', (ILLUS[config.site] || []).map((k) => [k, k]), p.illus)}</div>
${area('一句话简介 *', 'summary', p.summary, 'required maxlength="300" style="min-height:60px"')}${zh() ? area('中文简介', 'summaryZh', p.summaryZh, 'style="min-height:60px"') : ''}
<div class="grid2">${area('卖点（每行一条）', 'highlights', (p.highlights || []).join('\n'))}${zh() ? area('中文卖点（每行一条）', 'highlightsZh', (p.highlightsZh || []).join('\n')) : ''}${area('应用场景（每行一个）', 'applications', (p.applications || []).join('\n'))}${area('认证（每行一个）', 'certifications', (p.certifications || []).join('\n'))}${area('搜索关键词（每行一个）', 'keywords', (p.keywords || []).join('\n'))}</div>${feat}</div>
<div class="card"><h3>参数与交付</h3>${area('参数表 *（每行"参数名: 参数值"）', 'specs', specsText(p.specs), 'style="min-height:180px"')}
<div class="grid2">${inp('质保 *', 'warranty', p.warranty, 'placeholder="5 years"')}${inp('单位 *', 'unit', p.unit || 'pcs')}${inp('起订量 MOQ *', 'moq', p.moq, 'inputmode="numeric"')}${inp('生产交期 最短天数 *', 'lead_min', p.leadTimeDays?.[0])}${inp('生产交期 最长天数 *', 'lead_max', p.leadTimeDays?.[1])}${inp('样品 最短天数 *', 'sample_min', p.sampleDays?.[0])}${inp('样品 最长天数 *', 'sample_max', p.sampleDays?.[1])}${inp('最小功率 W（用于筛选）', 'wattMin', p.wattMin)}${inp('最大功率 W', 'wattMax', p.wattMax)}</div>
${inp('批量参考价档位（询价/AI 报价用，如 50-499:39-52 | 500-1999:35-46 | 2000+:32-42）', 'priceBands', bandsText(p.priceBands))}</div>
<div class="card"><h3>规格 / SKU（每行一个可售规格；留空的行会忽略）</h3><div class="wrap"><table class="vt"><thead><tr><th>SKU 编码</th><th>规格（名=值; 名=值）</th><th>售价</th><th>划线价</th><th>阶梯价（数量:单价）</th><th>起订</th><th>重量 kg</th><th>库存</th><th>每箱数量</th><th>箱体积 m³</th><th>箱毛重 kg</th><th>金蝶物料编码</th></tr></thead><tbody>${rows}</tbody></table></div><p class="mute">需要更多规格：先保存，页面会再给出空行。售价用于网站在线购买；阶梯价按购买数量自动生效。</p></div>
<div class="card"><h3>图片（JPG / PNG / WebP，每张 ≤5 MB，第一张为主图）</h3><div class="imgs">${imgs || '<span class="mute">还没有图片</span>'}</div><p><input type="file" name="upload" accept="image/jpeg,image/png,image/webp" multiple></p></div>
<div class="acts"><button class="btn" name="action" value="save">保存</button><button class="btn g" name="action" value="save_publish">保存并发布到网站</button></div></form>
${isNew ? '' : `<div class="acts">${p._status !== 'published' ? `<form method="post" action="/admin/products/${encodeURIComponent(p.id)}/status"><input type="hidden" name="to" value="published"><button class="btn g">上架</button></form>` : `<form method="post" action="/admin/products/${encodeURIComponent(p.id)}/status"><input type="hidden" name="to" value="archived"><button class="btn r">下架</button></form>`}
${!p._publishedAt ? `<form method="post" action="/admin/products/${encodeURIComponent(p.id)}/delete" onsubmit="return confirm('确定删除？')"><button class="btn r">删除</button></form>` : ''}<a class="btn l" href="${esc(config.publicBaseUrl)}/products/${esc(p.slug)}/" target="_blank">在网站上查看</a></div>`}${revs}`, c);
}

async function readForm(c) {
  const f = await c.req.parseBody({ all: true });
  const one = (k) => (Array.isArray(f[k]) ? f[k][0] : f[k]);
  const lines = (k) => String(one(k) ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const variants = [];
  for (let i = 0; i < 300; i++) {
    if (one(`v_${i}_sku`) == null) break;
    const v = Object.fromEntries(['sku', 'options', 'price', 'compare_at', 'tier_prices', 'min_qty', 'weight_kg', 'stock_local', 'pcs_per_carton', 'carton_cbm', 'carton_gw', 'erp_number'].map((k) => [k, String(one(`v_${i}_${k}`) ?? '').trim()]));
    if (Object.values(v).some((x) => x && x !== '1' && x !== '0')) variants.push(v);
  }
  // images: keep existing (minus removed) in the chosen order, then append uploads
  const remove = new Set([].concat(f.img_remove || []).map(String));
  const kept = [];
  for (let i = 0; i < 50 && one(`img_url_${i}`) != null; i++) if (!remove.has(String(one(`img_url_${i}`)))) kept.push({ u: String(one(`img_url_${i}`)), o: Number(one(`img_order_${i}`)) || i + 1 });
  kept.sort((a, b) => a.o - b.o);
  const uploads = [].concat(f.upload || []).filter((x) => x && typeof x === 'object' && x.size > 0);
  const input = {
    id: String(one('id') || '').trim(), name: one('name'), nameZh: one('nameZh'), category: one('category'), slug: one('slug'), illus: one('illus') || undefined,
    summary: one('summary'), summaryZh: one('summaryZh'), highlights: lines('highlights'), highlightsZh: zh() ? lines('highlightsZh') : undefined, applications: lines('applications'),
    certifications: lines('certifications'), keywords: lines('keywords'), specs: String(one('specs') || ''), warranty: one('warranty'), unit: one('unit'), moq: one('moq'),
    leadTimeDays: [one('lead_min'), one('lead_max')], sampleDays: [one('sample_min'), one('sample_max')], wattMin: one('wattMin'), wattMax: one('wattMax'), priceBands: String(one('priceBands') || ''),
    images: kept.map((x) => x.u),
  };
  if (C.getSetting('catalog_meta', {}).features) input.features = [].concat(f.features || []).map(String);
  if (input.highlightsZh === undefined) delete input.highlightsZh;
  return { input, variants, uploads, status: one('status'), salesMode: one('salesMode'), action: one('action'), version: one('_version') };
}

async function storeUploads(uploads) {
  const urls = [];
  for (const file of uploads.slice(0, 10)) urls.push(C.saveMedia(Buffer.from(await file.arrayBuffer()), file.name));
  return urls;
}

// Publish + rebuild + IndexNow; products going live for the first time are promoted (article, GEO questions).
async function publishNow() {
  return (await publishAndPromote()).snap;
}

// ---------------------------------------------------------------- AI auto-listing
const JOB_ST = { queued: '排队中', drafted: '待审核（草稿）', published: '已自动上架', failed: '失败', skipped: '已跳过' };
function autolistPage(c) {
  const s = AL.autolistSettings();
  const jobs = AL.listJobs(c.req.query('status') || '');
  const promos = AL.listPromotions(20);
  const chk = (n, v, l) => `<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="${n}" value="1"${v ? ' checked' : ''}> ${l}</label>`;
  return view('AI 自动上架', `<h2>AI 自动上架</h2>
<p class="mute">把金蝶物料、供应商规格表或产品资料交给 AI，自动写好中英文标题、简介、卖点、参数和搜索关键词。AI 只负责写文案：认证和参数数字必须能在原始资料里找到，找不到的会被删除并标出；价格、起订量、质保、交期只取原始资料或下面的默认值。
${aiEnabled() ? '' : '<b>当前未配置大模型，将按规则生成草稿，需要人工润色。</b>'}</p>
<div class="grid2">
<div class="card"><h3 style="margin-top:0">1. 从金蝶拉取新物料</h3><p class="mute">${esc(erpLabel())}。只拉取还没有建 SKU 的启用物料。</p><form method="post" action="/admin/products/autolist/erp"><button class="btn">拉取新物料</button></form></div>
<div class="card"><h3 style="margin-top:0">2. 上传规格表</h3><p class="mute">CSV 或 Excel，第一行是表头，任意列名都可以（能识别 型号/名称/售价/重量/起订量/质保 等）。每行一个产品。</p>
<form method="post" action="/admin/products/autolist/sheet" enctype="multipart/form-data" class="acts"><input type="file" name="file" accept=".csv,.xlsx" required><button class="btn">上传</button></form></div>
<div class="card"><h3 style="margin-top:0">3. 粘贴产品资料</h3><form method="post" action="/admin/products/autolist/text">${area('型号、名称、参数、认证等（一个产品）', 'text', '', 'rows="5" required')}<div class="acts"><button class="btn">加入队列</button></div></form></div>
</div>
<div class="acts"><form method="post" action="/admin/products/autolist/run"><button class="btn g">AI 处理队列（${jobs.filter((j) => j.status === 'queued').length} 个排队）</button></form>
${Object.entries(JOB_ST).map(([k, l]) => `<a href="/admin/products/autolist?status=${k}">${l}</a>`).join(' · ')} · <a href="/admin/products/autolist">全部</a></div>
<div class="wrap"><table><thead><tr><th>时间</th><th>来源</th><th>原始资料</th><th>状态</th><th>生成方式</th><th>需要核对</th><th></th></tr></thead><tbody>
${jobs.map((j) => `<tr><td>${fmt(j.created_at)}<div class="mute">${esc(j.created_by || '')}</div></td><td>${({ erp: '金蝶物料', sheet: '规格表', text: '粘贴资料' })[j.source] || esc(j.source)}<div class="mute">${esc(j.source_ref)}</div></td>
<td style="max-width:280px" class="mute">${esc(Object.entries(j.raw).map(([k, v]) => `${k}: ${v}`).join(' · ').slice(0, 220))}</td><td>${JOB_ST[j.status] || esc(j.status)}${j.error ? `<div style="color:#c62828">${esc(j.error)}</div>` : ''}</td><td>${j.mode === 'ai' ? 'AI' : j.mode === 'rules' ? '规则' : ''}</td>
<td style="max-width:320px">${j.issues.map((i) => `<div>· ${esc(i)}</div>`).join('') || (j.product_id ? '<span class="mute">无</span>' : '')}${j.notes.map((i) => `<div class="mute">（提示）${esc(i)}</div>`).join('')}</td>
<td>${j.product_id ? `<a href="/admin/products/${encodeURIComponent(j.product_id)}">${j.status === 'drafted' ? '审核并上架' : '查看商品'}</a>` : ''}${['queued', 'failed'].includes(j.status) ? `<form method="post" action="/admin/products/autolist/${j.id}/run" style="display:inline"><button class="btn l">${j.status === 'failed' ? '重试' : '立即处理'}</button></form> <form method="post" action="/admin/products/autolist/${j.id}/skip" style="display:inline"><button class="btn r">跳过</button></form>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="mute">队列是空的</td></tr>'}</tbody></table></div>
<h3>新品推广记录（GEO）</h3><p class="mute">商品第一次发布上线时自动执行：通知搜索引擎收录（IndexNow），把买家会问 AI 的问题加入 GEO 监测${config.content.promoteNew ? '，并让内容智能体写一篇产品文章（按内容设置决定直接发布或待审核）' : ''}。</p>
<div class="wrap"><table><thead><tr><th>时间</th><th>商品</th><th>执行内容</th><th>结果</th></tr></thead><tbody>${promos.map((r) => `<tr><td>${fmt(r.ts)}</td><td><a href="/admin/products/${encodeURIComponent(r.product_id)}">${esc(r.product_id)}</a></td><td>${r.actions.map((a) => `<div>${esc({ indexnow: a.skipped ? '搜索引擎收录通知（未配置 INDEXNOW_KEY，已跳过）' : '搜索引擎收录通知', geo_questions: `GEO 监测问题 ${a.count ?? ''} 个`, article: `产品文章（${a.lang}）${a.id ? `：${a.id}，${a.status === 'published' ? '已发布' : '草稿待审核'}` : ''}` }[a.kind] || a.kind)}${a.error ? ` <span style="color:#c62828">失败：${esc(a.error)}</span>` : ''}</div>`).join('')}</td><td>${r.status === 'ok' ? '完成' : '部分失败'}</td></tr>`).join('') || '<tr><td colspan="4" class="mute">暂无</td></tr>'}</tbody></table></div>
<h3>自动上架设置</h3><form method="post" action="/admin/products/autolist/settings" class="card">
${s.fromCatalog ? '<div class="flash warn">还没有保存过设置，下面的默认值取自现有商品，请确认后保存。</div>' : ''}
${chk('autoPublish', s.autoPublish, '<b>自动上架</b>：AI 生成且没有任何需要核对的问题时直接发布（否则留作草稿）')}
${chk('erpAuto', s.erpAuto, '每 6 小时自动从金蝶拉取新物料并处理')}
${chk('promote', s.promote, '新品上线后自动做 GEO 推广')}
<div class="grid2" style="margin-top:10px">${inp('默认质保', 'warranty', s.warranty)}${inp('默认单位', 'unit', s.unit)}${inp('默认起订量', 'moq', s.moq)}${inp('生产交期最短（天）', 'lead_min', s.leadTimeDays?.[0])}${inp('生产交期最长（天）', 'lead_max', s.leadTimeDays?.[1])}${inp('样品最短（天）', 'sample_min', s.sampleDays?.[0])}${inp('样品最长（天）', 'sample_max', s.sampleDays?.[1])}</div>
<div class="acts"><button class="btn">保存设置</button></div></form>`, c);
}

// ---------------------------------------------------------------- import
const pendingImports = new Map(); // token → { rows, at }
function importPage(c, preview = null) {
  const cats = C.listCategories().map((x) => `<code>${esc(x.id)}</code> ${esc(x.name)}`).join('、');
  let body = `<h2>批量导入商品</h2><div class="card"><p>1. 下载 <a href="/admin/products/template.csv">导入模板</a>（或先<a href="/admin/products/export.csv">导出现有商品</a>修改后再导入）。用 Excel / WPS 编辑后，直接上传 <b>.xlsx</b>，或另存为 <b>CSV UTF-8</b> 上传。</p>
<p>2. 按"型号/编码"匹配：已存在的商品会被更新（空单元格保持原值），不存在的会新建。多值字段用 <code>|</code> 分隔；参数写成 <code>功率: 150W | IP: IP65</code>；价格档位写成 <code>50-499:39-52 | 500+:35-46</code>。</p>
<p>3. 上传后先预览校验结果，确认无误再导入。新建的商品默认是草稿，可在表里用"状态"列直接设为 published。导入的商品会自动建一个与型号同名的 SKU，售价取第一档参考价的上限，请到商品页核对。</p><p class="mute">可用的品类编码：${cats}</p>
<form method="post" action="/admin/products/import" enctype="multipart/form-data" class="acts"><input type="file" name="file" accept=".csv,.xlsx" required><button class="btn">上传并预览</button></form></div>`;
  if (preview) {
    const ok = preview.rows.filter((r) => !r.errors.length);
    body += `<div class="card"><h3>预览：共 ${preview.rows.length} 行，${ok.length} 行可导入，${preview.rows.length - ok.length} 行有错误</h3><div class="wrap"><table><thead><tr><th>行</th><th>型号</th><th>名称</th><th>操作</th><th>结果</th></tr></thead><tbody>
${preview.rows.map((r) => `<tr><td>${r.line}</td><td>${esc(r.id)}</td><td>${esc(r.name)}</td><td>${r.isNew ? '新建' : '更新'}</td><td>${r.errors.length ? `<span style="color:#c62828">${r.errors.map(esc).join('<br>')}</span>` : `✓${r.warnings.length ? `<div class="mute">${r.warnings.map(esc).join('<br>')}</div>` : ''}`}</td></tr>`).join('')}</tbody></table></div>
${ok.length ? `<form method="post" action="/admin/products/import/confirm" class="acts"><input type="hidden" name="token" value="${preview.token}"><button class="btn g">导入 ${ok.length} 个商品${ok.length < preview.rows.length ? '（跳过有错误的行）' : ''}</button></form>` : ''}</div>`;
  }
  return view('批量导入', body, c);
}

function prepareImport(records) {
  const existing = new Map(C.listProducts({ pageSize: 100000 }).rows.map((p) => [p.id, p]));
  const cats = C.listCategories();
  const seenIds = new Set();
  return records.slice(0, 2000).map((rec, i) => {
    const { product, status } = rowToProduct(rec);
    const cur = existing.get(product.id);
    const merged = { ...(cur ? Object.fromEntries(Object.entries(cur).filter(([k]) => !k.startsWith('_'))) : {}), ...product };
    const others = new Map([...existing].filter(([id]) => id !== product.id).map(([id, p]) => [id, p]));
    const { errors, warnings } = validateProduct(merged, { categories: cats, existing: others, isNew: !cur });
    if (status && !STATUSES[status]) errors.push(`状态无效：${status}`);
    if (product.id && seenIds.has(product.id)) errors.push('文件中型号重复');
    seenIds.add(product.id);
    return { line: i + 2, id: product.id, name: merged.name, isNew: !cur, status, product, errors, warnings };
  });
}

// ---------------------------------------------------------------- categories & settings
function categoriesPage(c, edit = null, errors = []) {
  const cats = C.listCategories();
  const counts = new Map(C.listProducts({ pageSize: 100000 }).rows.map((p) => p.category).reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map()));
  const e = edit || {};
  return view('品类', `<h2>品类</h2><div class="wrap"><table><thead><tr><th>排序</th><th>编码</th><th>名称</th><th>品类页</th><th class="n">商品数</th><th></th></tr></thead><tbody>${cats.map((x) => `<tr><td>${x.sort}</td><td><code>${esc(x.id)}</code></td><td>${esc(x.name)}${x.nameZh ? ' · ' + esc(x.nameZh) : ''}</td><td>/${esc(x.slug || '')}/</td><td class="n">${counts.get(x.id) || 0}</td><td><a href="/admin/categories?edit=${encodeURIComponent(x.id)}">编辑</a></td></tr>`).join('')}</tbody></table></div>
<div class="card"><h3>${edit?.id && cats.some((x) => x.id === edit.id) && !edit._new ? `编辑品类 ${esc(edit.id)}` : '新增品类'}</h3>${errors.length ? `<div class="flash err">${errors.map(esc).join('<br>')}</div>` : ''}
<form method="post" action="/admin/categories/save"><input type="hidden" name="_new" value="${edit?.id && !edit._new && cats.some((x) => x.id === edit.id) ? '' : '1'}"><div class="grid2">${inp('品类编码（小写字母/横线）', 'id', e.id, edit?.id && !edit._new ? 'readonly' : 'required')}${inp('名称', 'name', e.name, 'required')}${zh() ? inp('中文名称', 'nameZh', e.nameZh) : ''}${inp('品类页标题', 'title', e.title)}${inp('品类页网址别名', 'slug', e.slug)}${inp('排序', 'sort', e.sort)}</div>
${area('简介', 'blurb', e.blurb, 'style="min-height:60px"')}${zh() ? area('中文简介', 'blurbZh', e.blurbZh, 'style="min-height:60px"') : ''}${inp('搜索关键词（用 | 分隔）', 'keywords', (e.keywords || []).join(' | '))}<div class="acts"><button class="btn">保存</button></div></form>
${edit?.id && !edit._new ? `<form method="post" action="/admin/categories/${encodeURIComponent(edit.id)}/delete" onsubmit="return confirm('删除品类？')"><button class="btn r">删除品类</button></form>` : ''}</div>`, c);
}

const CONTACT_FIELDS = [['email', '销售邮箱'], ['whatsapp', 'WhatsApp'], ['phone', '电话'], ['address', '地址'], ['salesHours', '销售工作时间']];
function settingsPage(c) {
  const meta = C.getSetting('catalog_meta', {});
  const site = C.getSetting('site', {});
  const contact = site.contact || site;
  return view('站点设置', `<h2>站点设置</h2><form method="post" action="/admin/settings"><div class="card"><h3>联系方式（网站页脚、报价单、客户中心都会使用）</h3><div class="grid2">${CONTACT_FIELDS.map(([k, l]) => inp(l, `c_${k}`, contact[k])).join('')}</div></div>
<div class="card"><h3>价格</h3><div class="grid2">${sel('网站价格显示', 'priceDisplay', [['ranges', '显示参考价区间'], ['hidden', '隐藏价格（按项目报价）']], meta.priceDisplay || 'ranges')}${inp('币种', 'currency', meta.currency)}${inp('贸易术语', 'priceTerm', meta.priceTerm, 'placeholder="FOB Shenzhen"')}${inp('价格说明（每个报价都会附上）', 'priceNote', meta.priceNote)}</div></div>
<div class="card"><h3>示例数据提示条</h3><label><input type="checkbox" name="sample" value="1"${meta.sample || site.demo ? ' checked' : ''}> 在网站顶部显示"示例数据"提示（真实数据替换完成后取消勾选）</label></div>
<div class="acts"><button class="btn">保存</button><span class="mute">保存后点上方"发布到网站"生效</span></div></form>`, c);
}

// ---------------------------------------------------------------- routes
export function mountCatalogAdmin(app) {
  const limit = bodyLimit({ maxSize: 60 * 1024 * 1024, onError: (c) => c.text('上传内容过大（单次最多 60 MB）', 413) });
  app.get('/admin/products', (c) => c.html(listPage(c)));
  app.get('/admin/products/new', (c) => c.html(editPage(c, { status: 'draft', unit: 'pcs', sampleDays: [5, 7] }, { isNew: true })));
  app.get('/admin/products/template.csv', (c) => {
    c.header('content-type', 'text/csv; charset=utf-8'); c.header('content-disposition', 'attachment; filename="product-import-template.csv"');
    const ex = C.publishedCatalog().products[0];
    return c.body(toCsv(ex ? [productToRow({ ...ex, id: 'NEW-MODEL-1', slug: '', images: [] }, 'draft')] : []));
  });
  app.get('/admin/products/export.csv', (c) => {
    c.header('content-type', 'text/csv; charset=utf-8'); c.header('content-disposition', `attachment; filename="products-${config.site}.csv"`);
    return c.body(toCsv(C.listProducts({ pageSize: 100000 }).rows.map((p) => productToRow(p, p._status))));
  });
  app.get('/admin/products/import', (c) => c.html(importPage(c)));
  app.post('/admin/products/import', limit, async (c) => {
    const f = await c.req.parseBody();
    const file = f.file;
    if (!file || typeof file !== 'object' || !file.size) return back(c, '/admin/products/import', { e: '请选择文件' });
    const buf = Buffer.from(await file.arrayBuffer());
    let records;
    try { records = /\.xlsx$/i.test(file.name) || buf.subarray(0, 2).toString() === 'PK' ? parseXlsx(buf) : parseCsv(buf.toString('utf8')); } catch (e) { return back(c, '/admin/products/import', { e: `无法读取文件：${e.message}` }); }
    if (!records.length) return back(c, '/admin/products/import', { e: '文件里没有数据行' });
    const rows = prepareImport(records);
    const token = randomBytes(12).toString('hex');
    pendingImports.set(token, { rows, at: Date.now() });
    for (const [k, v] of pendingImports) if (Date.now() - v.at > 3600e3) pendingImports.delete(k);
    return c.html(importPage(c, { token, rows }));
  });
  app.post('/admin/products/import/confirm', async (c) => {
    const f = await c.req.parseBody();
    const job = pendingImports.get(String(f.token || ''));
    if (!job) return back(c, '/admin/products/import', { e: '预览已过期，请重新上传' });
    pendingImports.delete(String(f.token));
    let created = 0, updated = 0;
    const failed = [];
    for (const r of job.rows.filter((x) => !x.errors.length)) {
      try {
        const cur = C.getProduct(r.id);
        let variants = null, salesMode;
        if (!cur) {
          // new products get one SKU named like the model; price = top of the first reference band (to be checked)
          const b = parseBands(r.product.priceBands || '').find((x) => !x.invalid);
          variants = [{ sku: r.id, price: b ? b.high : '', min_qty: r.product.moq || 1 }];
          salesMode = b ? 'both' : 'inquiry';
        }
        C.saveProduct(r.product, { isNew: !cur, status: r.status || (cur ? undefined : 'draft'), salesMode, variants });
        cur ? updated++ : created++;
      } catch (e) { failed.push(`${r.id}: ${e.message}`); }
    }
    return back(c, '/admin/products', { m: `导入完成：新建 ${created} 个，更新 ${updated} 个${failed.length ? `，失败 ${failed.length} 个` : ''}。点"发布到网站"后生效。`, e: failed.slice(0, 5).join('；') || undefined });
  });
  app.post('/admin/products/publish', async (c) => {
    const snap = await publishNow();
    return back(c, c.req.header('referer')?.includes('/admin/') ? new URL(c.req.header('referer')).pathname : '/admin/products', { m: `已发布 ${snap.products.length} 个商品：AI 销售和询价已立即使用新数据，网站正在重新构建，约 1 分钟后生效。` });
  });
  app.post('/admin/products/new', limit, async (c) => {
    const { input, variants, uploads, status, salesMode, action } = await readForm(c);
    try {
      input.images = [...input.images, ...(await storeUploads(uploads))];
      const { product, warnings } = C.saveProduct(input, { isNew: true, status, salesMode, variants });
      if (action === 'save_publish') await publishNow();
      return back(c, `/admin/products/${encodeURIComponent(product.id)}`, { m: action === 'save_publish' ? '已保存并发布' : '已创建（保存后点"发布到网站"生效）', w: warnings.join('；') || undefined });
    } catch (e) {
      return c.html(editPage(c, { ...input, _status: status, _salesMode: salesMode }, { isNew: true, errors: e.errors || [e.message], warnings: e.warnings || [], variants }), 400);
    }
  });
  app.get('/admin/products/autolist', (c) => c.html(autolistPage(c)));
  app.post('/admin/products/autolist/erp', async (c) => {
    try { const n = await AL.queueFromErp(); return back(c, '/admin/products/autolist', { m: n ? `已加入 ${n} 个新物料，点"AI 处理队列"生成商品` : '没有新的物料' }); } catch (e) { return back(c, '/admin/products/autolist', { e: `拉取失败：${e.message}` }); }
  });
  app.post('/admin/products/autolist/sheet', limit, async (c) => {
    const f = await c.req.parseBody();
    const file = f.file;
    if (!file || typeof file !== 'object' || !file.size) return back(c, '/admin/products/autolist', { e: '请选择文件' });
    const buf = Buffer.from(await file.arrayBuffer());
    let rows;
    try { rows = /\.xlsx$/i.test(file.name) || buf.subarray(0, 2).toString() === 'PK' ? parseXlsx(buf) : parseCsv(buf.toString('utf8')); } catch (e) { return back(c, '/admin/products/autolist', { e: `无法读取文件：${e.message}` }); }
    const n = AL.queueFromRows(rows, file.name);
    return back(c, '/admin/products/autolist', n ? { m: `已加入 ${n} 个产品，点"AI 处理队列"生成商品` } : { e: '文件里没有新的产品行（已排队或已处理过的型号会跳过）' });
  });
  app.post('/admin/products/autolist/text', async (c) => {
    const f = await c.req.parseBody();
    try { AL.queueFromText(f.text); return back(c, '/admin/products/autolist', { m: '已加入队列' }); } catch (e) { return back(c, '/admin/products/autolist', { e: e.message }); }
  });
  app.post('/admin/products/autolist/run', async (c) => {
    const out = await AL.runQueue();
    const n = (s) => out.filter((j) => j.status === s).length;
    return back(c, '/admin/products/autolist', { m: out.length ? `处理 ${out.length} 个：${n('published')} 个已自动上架，${n('drafted')} 个草稿待审核` : '队列是空的', e: n('failed') ? `${n('failed')} 个失败，见下表` : undefined });
  });
  app.post('/admin/products/autolist/:id/run', async (c) => {
    const j = await AL.draftJob(c.req.param('id'));
    if (j?.status === 'published') await publishAndPromote();
    return back(c, '/admin/products/autolist', j?.status === 'failed' ? { e: j.error } : { m: j?.status === 'published' ? '已自动上架' : '已生成草稿' });
  });
  app.post('/admin/products/autolist/:id/skip', (c) => { AL.skipJob(c.req.param('id')); return back(c, '/admin/products/autolist', { m: '已跳过' }); });
  app.post('/admin/products/autolist/settings', async (c) => {
    try { AL.saveAutolistSettings(await c.req.parseBody()); return back(c, '/admin/products/autolist', { m: '设置已保存' }); } catch (e) { return back(c, '/admin/products/autolist', { e: e.message }); }
  });
  app.get('/admin/products/:id', (c) => {
    const p = C.getProduct(c.req.param('id'));
    return p ? c.html(editPage(c, p)) : c.text('商品不存在', 404);
  });
  app.post('/admin/products/:id', limit, async (c) => {
    const id = c.req.param('id');
    const cur = C.getProduct(id);
    if (!cur) return c.text('商品不存在', 404);
    const { input, variants, uploads, status, salesMode, action, version } = await readForm(c);
    input.id = id;
    try {
      input.images = [...input.images, ...(await storeUploads(uploads))];
      const { warnings } = C.saveProduct(input, { expectVersion: version, status, salesMode, variants });
      if (action === 'save_publish') await publishNow();
      return back(c, `/admin/products/${encodeURIComponent(id)}`, { m: action === 'save_publish' ? '已保存并发布：AI 立即生效，网站约 1 分钟后更新' : '已保存（点"发布到网站"后生效）', w: warnings.join('；') || undefined });
    } catch (e) {
      return c.html(editPage(c, { ...cur, ...input, _status: status, _salesMode: salesMode, _version: cur._version }, { errors: e.errors || [e.message], warnings: e.warnings || [], variants }), e.conflict ? 409 : 400);
    }
  });
  app.post('/admin/products/:id/status', async (c) => {
    const f = await c.req.parseBody();
    try { C.setProductStatus(c.req.param('id'), String(f.to)); return back(c, `/admin/products/${encodeURIComponent(c.req.param('id'))}`, { m: `已${STATUSES[String(f.to)]}，点"发布到网站"后生效` }); } catch (e) { return back(c, `/admin/products/${encodeURIComponent(c.req.param('id'))}`, { e: e.message }); }
  });
  app.post('/admin/products/:id/delete', (c) => {
    try { C.deleteProduct(c.req.param('id')); return back(c, '/admin/products', { m: '已删除' }); } catch (e) { return back(c, `/admin/products/${encodeURIComponent(c.req.param('id'))}`, { e: e.message }); }
  });

  app.get('/admin/categories', (c) => { const id = c.req.query('edit'); return c.html(categoriesPage(c, id ? C.listCategories().find((x) => x.id === id) : null)); });
  app.post('/admin/categories/save', async (c) => {
    const f = await c.req.parseBody();
    const isNew = f._new === '1';
    const old = isNew ? {} : C.listCategories().find((x) => x.id === f.id) || {};
    try { C.saveCategory({ ...old, ...Object.fromEntries(Object.entries(f).filter(([k]) => k !== '_new')) }, { isNew }); return back(c, '/admin/categories', { m: '已保存（点"发布到网站"后生效）' }); } catch (e) { return c.html(categoriesPage(c, { ...f, _new: isNew }, e.errors || [e.message]), 400); }
  });
  app.post('/admin/categories/:id/delete', (c) => { try { C.deleteCategory(c.req.param('id')); return back(c, '/admin/categories', { m: '已删除' }); } catch (e) { return back(c, '/admin/categories', { e: e.message }); } });

  app.get('/admin/settings', (c) => c.html(settingsPage(c)));
  app.post('/admin/settings', async (c) => {
    const f = await c.req.parseBody();
    if (f.c_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(f.c_email))) return back(c, '/admin/settings', { e: '邮箱格式不正确' });
    if (!['ranges', 'hidden'].includes(String(f.priceDisplay))) return back(c, '/admin/settings', { e: '价格显示方式无效' });
    const meta = C.getSetting('catalog_meta', {});
    C.setSetting('catalog_meta', { ...meta, priceDisplay: String(f.priceDisplay), currency: String(f.currency || meta.currency || 'USD').toUpperCase().slice(0, 3), priceTerm: String(f.priceTerm || ''), priceNote: String(f.priceNote || ''), sample: f.sample === '1' });
    const site = C.getSetting('site', {});
    const contact = Object.fromEntries(CONTACT_FIELDS.map(([k]) => [k, String(f[`c_${k}`] || '').trim()]));
    if (site.contact) site.contact = { ...site.contact, ...contact }; else Object.assign(site, Object.fromEntries(Object.entries(contact).filter(([k]) => k in site || ['email', 'whatsapp', 'address'].includes(k))));
    site.demo = f.sample === '1';
    C.setSetting('site', site);
    C.setSetting('catalog_dirty', true);
    return back(c, '/admin/settings', { m: '已保存，点"发布到网站"后生效' });
  });
}
