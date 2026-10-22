// 后台：品牌资产与排版模板（美工）。品牌资产：Logo、品牌色（含对比度检查）、字体、口号、使用规范；排版模板：选商品一键生成主图角标、促销横幅、卖点图、社媒方图，保存到素材库或批量生成。
import { shell, esc } from '../admin.js';
import * as C from '../catalog/store.js';
import * as A from './store.js';
import * as B from './brand.js';

const flash = (c) => `${c.req.query('m') ? `<div class="warn" style="background:#e8f5e9;border-color:#a5d6a7">${esc(c.req.query('m'))}</div>` : ''}${c.req.query('e') ? `<div class="warn" style="background:#fdecea;border-color:#f5b7b1">${esc(c.req.query('e'))}</div>` : ''}`;
const back = (c, path, k, v) => c.redirect(`${path}${path.includes('?') ? '&' : '?'}${k}=${encodeURIComponent(v)}`);
const SUB = '<p class="acts"><a href="/admin/brand">品牌资产</a> · <a href="/admin/brand/templates">排版模板</a> · <a href="/admin/assets">素材仓库</a> · <a href="/admin/tasks">任务中心</a></p>';
const view = (title, body) => shell(title, SUB + body);
const LANGS = { en: '英文', zh: '中文' };
const opt = (pairs, v) => pairs.map(([k, l]) => `<option value="${esc(k)}"${k === v ? ' selected' : ''}>${esc(l)}</option>`).join('');
const sampleProduct = () => C.listProducts({ pageSize: 1 }).rows[0]?.id || '';
const previewUrl = (id, q = {}) => `/admin/brand/templates/${encodeURIComponent(id)}/preview.png?${new URLSearchParams(Object.entries(q).filter(([, v]) => v != null && v !== ''))}`;

function kitPage(c) {
  const k = B.brandKit();
  const checks = B.contrastChecks(k);
  const logo = (key) => { const a = k.logos[key] && A.getAsset(k.logos[key]); return `<label style="display:grid;gap:4px">${esc(B.LOGO_KEYS[key])}<span style="display:flex;gap:8px;align-items:center">${a ? `<img src="/admin/assets/thumb/${esc(a.id)}" alt="" style="height:48px;background:${key === 'reversed' ? k.colors.primary : '#f1f3f5'};padding:4px;border-radius:6px">` : '<span class="mute">未设置</span>'}<input name="logo_${key}" value="${esc(k.logos[key])}" size="38" placeholder="素材编号（素材详情页地址中的编号）"></span></label>`; };
  return view('品牌资产', `${flash(c)}<h2>品牌资产</h2><p class="mute">全站统一的 Logo、品牌色、字体和口号。排版模板会自动使用这里的设置；改了品牌色，之后生成的图片都会跟着变。</p>
<form method="post" action="/admin/brand" style="display:grid;gap:14px;max-width:900px">
<section class="msg" style="max-width:none;display:grid;gap:8px"><b>品牌</b><label>品牌名称 <input name="name" value="${esc(k.name)}" size="30" required></label>
<label>英文口号 <input name="slogan_en" value="${esc(k.slogan.en)}" size="60" placeholder="Light that works as hard as you do"></label><label>中文口号 <input name="slogan_zh" value="${esc(k.slogan.zh)}" size="40"></label></section>
<section class="msg" style="max-width:none;display:grid;gap:10px"><b>Logo</b><span class="mute">先把 Logo 上传到<a href="/admin/assets">素材仓库</a>（建议透明 PNG），再把素材编号填在这里。</span>${Object.keys(B.LOGO_KEYS).map(logo).join('')}</section>
<section class="msg" style="max-width:none;display:grid;gap:8px"><b>品牌色</b><div style="display:flex;gap:14px;flex-wrap:wrap">${Object.entries(B.COLOR_KEYS).map(([key, l]) => `<label style="display:grid;gap:4px;justify-items:start">${esc(l)}<span style="display:flex;gap:6px;align-items:center"><input type="color" value="${esc(k.colors[key])}" oninput="this.nextElementSibling.value=this.value" aria-label="${esc(l)}"><input name="color_${key}" value="${esc(k.colors[key])}" size="8" pattern="#[0-9a-fA-F]{6}" translate="no"></span></label>`).join('')}</div>
<table><thead><tr><th>搭配</th><th>示例</th><th class="n">对比度</th><th>结论</th></tr></thead><tbody>${checks.map((x) => `<tr><td>${esc(x.pair)}</td><td><span style="display:inline-block;padding:4px 12px;border-radius:4px;background:${x.bg};color:${x.fg};font-weight:600">Aa 示例</span></td><td class="n">${x.ratio} : 1</td><td>${x.ok ? '<span style="color:#2e7d32">清晰</span>' : `<b style="color:#c62828">偏低（建议 ≥ ${x.min}）</b>`}</td></tr>`).join('')}</tbody></table></section>
<section class="msg" style="max-width:none;display:grid;gap:8px"><b>字体</b><span class="mute">模板生成图片时使用（服务器上没有的字体会自动用通用字体代替）。</span>
<label>标题字体 <input name="font_heading" value="${esc(k.fonts.heading)}" list="fonts" translate="no"></label><label>正文字体 <input name="font_body" value="${esc(k.fonts.body)}" list="fonts" translate="no"></label><datalist id="fonts">${B.FONTS.map((f) => `<option value="${esc(f)}">`).join('')}</datalist></section>
<section class="msg" style="max-width:none;display:grid;gap:8px"><b>使用规范</b><textarea name="rules" rows="5" placeholder="例如：Logo 四周留白不少于 Logo 高度的一半；不得拉伸、变色；深色背景用反白 Logo">${esc(k.rules)}</textarea></section>
<div><button>保存品牌资产</button></div></form>`);
}

function templatesPage(c) {
  const pid = sampleProduct();
  return view('排版模板', `${flash(c)}<h2>排版模板</h2><p class="mute">选一个模板，再选商品，就能用品牌色、字体和 Logo 生成图片，保存到商品的素材文件夹。内置模板不能修改，可以复制成自定义模板后调整图层。下面是用 ${esc(pid)} 生成的预览。</p>
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px">${B.templates().map((t) => `<section class="msg" style="max-width:none;margin:0;display:grid;gap:8px"><img src="${esc(previewUrl(t.id, { product: pid, w: 560 }))}" alt="${esc(t.name)}" loading="lazy" style="width:100%;aspect-ratio:${t.width}/${t.height};object-fit:contain;background:#eef1f4;border-radius:6px">
<b>${esc(t.name)}</b><span class="mute">${esc(B.KINDS[t.kind])} · ${t.width} × ${t.height}${t.builtin ? ' · 内置' : ' · 自定义'}</span>
<span><a href="/admin/brand/templates/${esc(t.id)}">使用</a> · <form method="post" action="/admin/brand/templates/${esc(t.id)}/copy" style="display:inline"><button>复制为自定义</button></form>${t.builtin ? '' : ` · <a href="/admin/brand/templates/${esc(t.id)}/edit">编辑</a> · <form method="post" action="/admin/brand/templates/${esc(t.id)}/delete" style="display:inline" onsubmit="return confirm('删除这个模板？')"><button>删除</button></form>`}</span></section>`).join('')}</div>`);
}

function usePage(c, t) {
  const q = { product: c.req.query('product') || sampleProduct(), lang: c.req.query('lang') || 'en', asset: c.req.query('asset') || '' };
  const p = C.getProduct(q.product);
  const def = p ? B.productFields(p, q.lang) : {};
  const ov = Object.fromEntries(Object.keys(B.FIELDS).map((k) => [k, c.req.query(k) || '']));
  const products = C.listProducts({ pageSize: 500 }).rows;
  const field = (k) => k === 'highlights'
    ? `<label style="display:grid;gap:4px">${esc(B.FIELDS[k])}<textarea name="${k}" rows="3" placeholder="${esc((def[k] || []).join('\n'))}">${esc(ov[k])}</textarea></label>`
    : `<label style="display:grid;gap:4px">${esc(B.FIELDS[k])}<input name="${k}" value="${esc(ov[k])}" placeholder="${esc(def[k] || '')}"></label>`;
  const used = new Set(t.layers.map((l) => l.field).filter(Boolean));
  return view(t.name, `${flash(c)}<p><a href="/admin/brand/templates">← 返回模板</a></p><h2>${esc(t.name)} <span class="mute" style="font-size:14px">${t.width} × ${t.height}</span></h2>
<div style="display:grid;grid-template-columns:minmax(260px,360px) 1fr;gap:18px;align-items:start">
<form method="get" style="display:grid;gap:8px" data-tpl-form><label style="display:grid;gap:4px">商品<select name="product">${opt(products.map((x) => [x.id, `${x.id} · ${x.name}`]), q.product)}</select></label>
<label style="display:grid;gap:4px">语言<select name="lang">${opt(Object.entries(LANGS), q.lang)}</select></label>
<label style="display:grid;gap:4px">商品图（素材编号，留空 = 自动用商品主图）<input name="asset" value="${esc(q.asset)}"></label>
<b>文字</b><span class="mute">留空使用商品资料（灰色提示）。</span>${Object.keys(B.FIELDS).filter((k) => used.has(k)).map(field).join('')}
<div><button>刷新预览</button></div>
<button formmethod="post" formaction="/admin/brand/templates/${esc(t.id)}/render">保存到素材库</button></form>
<div><img src="${esc(previewUrl(t.id, { ...q, ...ov, w: 1000 }))}" alt="预览" style="width:100%;max-width:${Math.min(t.width, 1000)}px;background:#eef1f4;border:1px solid var(--line);border-radius:8px"></div></div>
<form method="post" action="/admin/brand/templates/${esc(t.id)}/batch" class="msg" style="max-width:none;display:grid;gap:8px;margin-top:18px"><b>批量生成</b><span class="mute">给多个商品各生成一张（文字取各自的商品资料；角标、按钮、口号、价格、副标题按左边填写的统一使用）。在任务中心查看进度。</span>
<select name="products" multiple size="6" aria-label="商品">${opt(products.map((x) => [x.id, `${x.id} · ${x.name}`]), '')}</select>
<input type="hidden" name="lang" value="${esc(q.lang)}">${['badge', 'cta', 'slogan', 'price', 'subtitle'].map((k) => `<input type="hidden" name="${k}" value="${esc(ov[k])}">`).join('')}<div><button>批量生成</button></div></form>`);
}

function editPage(c, t, json = null, errors = []) {
  return view(`编辑模板`, `${flash(c)}<p><a href="/admin/brand/templates">← 返回模板</a></p><h2>编辑模板：${esc(t.name)}</h2>
${errors.length ? `<div class="warn" style="background:#fdecea;border-color:#f5b7b1"><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
<p class="mute">图层从下到上叠加。坐标和尺寸按像素，颜色可以写品牌色名称（primary / secondary / accent / text / background）或 #RRGGBB。图层类型：image（商品图）、logo（variant: primary / reversed / icon）、rect、circle、text、bullets；文字字段：${Object.keys(B.FIELDS).join(' / ')}。</p>
<form method="post" action="/admin/brand/templates/${esc(t.id)}/edit" style="display:grid;gap:8px"><textarea name="json" rows="28" style="font:13px/1.4 ui-monospace,monospace" translate="no">${esc(json ?? JSON.stringify({ name: t.name, kind: t.kind, width: t.width, height: t.height, background: t.background, layers: t.layers }, null, 2))}</textarea><div><button>保存</button> <a href="/admin/brand/templates/${esc(t.id)}">预览和使用</a></div></form>`);
}

export function mountBrandAdmin(app) {
  app.get('/admin/brand', (c) => c.html(kitPage(c)));
  app.post('/admin/brand', async (c) => {
    const f = await c.req.parseBody();
    const pick = (prefix, keys) => Object.fromEntries(keys.map((k) => [k, f[`${prefix}_${k}`]]).filter(([, v]) => v != null));
    try {
      B.saveBrandKit({ name: f.name, slogan: { en: f.slogan_en, zh: f.slogan_zh }, rules: f.rules, colors: pick('color', Object.keys(B.COLOR_KEYS)), fonts: pick('font', ['heading', 'body']), logos: pick('logo', Object.keys(B.LOGO_KEYS)) });
      const low = B.contrastChecks().filter((x) => !x.ok);
      return back(c, '/admin/brand', 'm', `已保存${low.length ? `；注意：${low.map((x) => x.pair).join('、')} 对比度偏低` : ''}`);
    } catch (e) { return back(c, '/admin/brand', 'e', e.message); }
  });
  app.get('/admin/brand/templates', (c) => c.html(templatesPage(c)));
  app.get('/admin/brand/templates/:id/preview.png', async (c) => {
    const q = c.req.query();
    const fields = Object.fromEntries(Object.keys(B.FIELDS).map((k) => [k, q[k]]));
    try {
      const r = await B.render({ templateId: c.req.param('id'), productId: q.product || sampleProduct(), lang: q.lang === 'zh' ? 'zh' : 'en', fields, assetId: q.asset || '' });
      const w = Math.min(Number(q.w) || 800, 1600);
      const { default: sharp } = await import('sharp');
      const out = await sharp(r.buffer).resize({ width: Math.min(w, r.template.width) }).webp({ quality: 82 }).toBuffer();
      return c.body(out, 200, { 'content-type': 'image/webp', 'cache-control': 'no-store', 'x-warnings': encodeURIComponent(r.warnings.join('；')) });
    } catch (e) { return c.text(e.message, 400); }
  });
  app.get('/admin/brand/templates/:id', (c) => { const t = B.getTemplate(c.req.param('id')); return t ? c.html(usePage(c, t)) : c.text('Not found', 404); });
  app.post('/admin/brand/templates/:id/render', async (c) => {
    const f = await c.req.parseBody();
    const path = `/admin/brand/templates/${encodeURIComponent(c.req.param('id'))}?product=${encodeURIComponent(f.product || '')}&lang=${encodeURIComponent(f.lang || 'en')}`;
    try {
      const { asset, warnings } = await B.renderToAsset({ templateId: c.req.param('id'), productId: String(f.product || ''), lang: f.lang === 'zh' ? 'zh' : 'en', assetId: String(f.asset || ''), fields: Object.fromEntries(Object.keys(B.FIELDS).map((k) => [k, f[k]])) });
      return c.redirect(`/admin/assets/${asset.id}?m=${encodeURIComponent(`已保存到素材库${warnings.length ? `（${warnings.join('；')}）` : ''}`)}`);
    } catch (e) { return back(c, path, 'e', e.message); }
  });
  app.post('/admin/brand/templates/:id/batch', async (c) => {
    const f = await c.req.parseBody({ all: true });
    const ids = [].concat(f.products || []).map(String);
    try { const task = B.queueTemplate(c.req.param('id'), ids, { lang: f.lang === 'zh' ? 'zh' : 'en', fields: Object.fromEntries(['badge', 'cta', 'slogan', 'price', 'subtitle'].map((k) => [k, [].concat(f[k] ?? '')[0]])) }); return c.redirect(`/admin/tasks/${task}`); } catch (e) { return back(c, `/admin/brand/templates/${encodeURIComponent(c.req.param('id'))}`, 'e', e.message); }
  });
  app.post('/admin/brand/templates/:id/copy', (c) => { try { const t = B.copyTemplate(c.req.param('id')); return back(c, `/admin/brand/templates/${t.id}/edit`, 'm', '已复制，可以调整图层'); } catch (e) { return back(c, '/admin/brand/templates', 'e', e.message); } });
  app.post('/admin/brand/templates/:id/delete', (c) => { try { B.deleteTemplate(c.req.param('id')); return back(c, '/admin/brand/templates', 'm', '已删除'); } catch (e) { return back(c, '/admin/brand/templates', 'e', e.message); } });
  app.get('/admin/brand/templates/:id/edit', (c) => { const t = B.getTemplate(c.req.param('id')); if (!t) return c.text('Not found', 404); if (t.builtin) return back(c, '/admin/brand/templates', 'e', '内置模板不能修改，请先复制为自定义模板'); return c.html(editPage(c, t)); });
  app.post('/admin/brand/templates/:id/edit', async (c) => {
    const t = B.getTemplate(c.req.param('id'));
    if (!t || t.builtin) return c.text('Not found', 404);
    const f = await c.req.parseBody();
    let data;
    try { data = JSON.parse(String(f.json || '')); } catch (e) { return c.html(editPage(c, t, String(f.json || ''), [`JSON 格式错误：${e.message}`]), 400); }
    try { B.saveTemplate({ ...data, id: t.id }); return back(c, `/admin/brand/templates/${t.id}/edit`, 'm', '已保存'); } catch (e) { return c.html(editPage(c, t, String(f.json), e.errors || [e.message]), 400); }
  });
}
