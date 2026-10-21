// 后台：标题与提示词。AI 优化标题（指定语言和方向，可参考别的页面）、应用到商品并保留历史；提示词模板库与 AI 优化提示词；
// 违禁词库（内置 + 自定义，禁止 / 提醒两级）与文本检查。
import { shell, esc, fmt } from '../admin.js';
import { aiEnabled } from '../config.js';
import * as C from './store.js';
import * as W from './copywriting.js';
import { safeFetch, extract } from '../assets/pull.js';

const flash = (c) => `${c.req.query('m') ? `<div class="warn" style="background:#e8f5e9;border-color:#a5d6a7">${esc(c.req.query('m'))}</div>` : ''}${c.req.query('e') ? `<div class="warn" style="background:#fdecea;border-color:#f5b7b1">${esc(c.req.query('e'))}</div>` : ''}`;
const back = (c, path, k, v) => c.redirect(`${path}${path.includes('?') ? '&' : '?'}${k}=${encodeURIComponent(v)}`);
const CSS = `<style>.cp{background:#fff;border:1px solid var(--line);border-radius:8px;padding:14px;margin-bottom:16px}.cp label{display:inline-flex;flex-direction:column;gap:2px;margin:0 10px 8px 0;font-size:12px;color:var(--mute)}
.cp textarea{width:100%;min-height:90px;font:inherit}.hit{background:#ffcdd2;border-radius:3px;padding:0 2px}.hit.warn{background:#ffe0b2}.tt{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid var(--line)}.tt b{flex:1;min-width:240px}</style>`;
const sub = '<p class="acts"><a href="/admin/copy">标题优化</a> · <a href="/admin/copy/prompts">提示词</a> · <a href="/admin/copy/banned">违禁词</a></p>';
const view = (title, body) => shell(title, CSS + sub + body);
const opt = (list, v) => list.map(([k, l]) => `<option value="${esc(k)}"${k === v ? ' selected' : ''}>${esc(l)}</option>`).join('');
const LANGS = [['en', 'English'], ['zh', '中文']];
/** Text with banned words highlighted. */
function marked(text, hits) {
  let out = '', i = 0;
  for (const h of hits) { if (h.index < i) continue; out += esc(text.slice(i, h.index)) + `<span class="hit ${h.level === 'warn' ? 'warn' : ''}" title="${esc(h.reason)}">${esc(h.found)}</span>`; i = h.index + h.found.length; }
  return out + esc(text.slice(i));
}
const hitList = (hits) => (hits.length ? `<span class="mute">${[...new Map(hits.map((h) => [h.found, `${h.level === 'block' ? '⛔' : '⚠'} <span translate="no">${esc(h.found)}</span>：${esc(h.reason)}`])).values()].join('；')}</span>` : '<span class="mute">✓ 无违禁词</span>');

function titlePage(c, result = null, f = {}) {
  const pid = f.product || c.req.query('product') || '';
  const p = pid ? C.getProduct(pid) : null;
  const products = C.listProducts({ pageSize: 2000 }).rows;
  const hist = p ? W.titleHistory(p.id) : [];
  const res = result ? `<div class="cp"><h3>建议标题 <span class="mute" style="font-size:12px">${result.source === 'ai' ? 'AI 生成' : '按商品资料生成（未配置大模型）'} · 模板：${esc(result.template)}</span></h3>
${result.titles.map((t) => `<div class="tt"><b translate="no">${marked(t.title, t.hits)}</b><span class="mute">${t.length} 字符</span>${hitList(t.hits)}<form method="post" action="/admin/copy/apply"><input type="hidden" name="product" value="${esc(pid)}"><input type="hidden" name="lang" value="${esc(f.lang)}"><input type="hidden" name="title" value="${esc(t.title)}"><input type="hidden" name="source" value="${result.source}"><button${t.hits.some((h) => h.level === 'block') ? ' disabled' : ''}>应用到商品</button></form></div>`).join('')}
<details><summary class="mute">查看发给 AI 的提示词</summary><pre translate="no" style="white-space:pre-wrap">${esc(result.prompt)}</pre></details></div>` : '';
  return view('标题优化', `${flash(c)}<h2>标题优化</h2><p class="mute">按指定语言和方向生成独立站商品标题，自动检查违禁词；应用后写入商品名称（英文名称或中文名称），保存历史，可随时改回。${aiEnabled() ? '' : '当前未配置大模型，按商品资料生成标题。'}</p>
<form method="post" action="/admin/copy/titles" class="cp"><label>商品<select name="product" required><option value="">选择商品</option>${opt(products.map((x) => [x.id, `${x.id} · ${x.name}`]), pid)}</select></label>
<label>语言<select name="lang">${opt(LANGS, f.lang || 'en')}</select></label><label>方向<select name="direction">${opt(Object.entries(W.DIRECTIONS), f.direction || 'seo')}</select></label>
<label>提示词模板<select name="template"><option value="">自动选择</option>${opt(W.listTemplates('title').map((t) => [t.id, t.name]), f.template || '')}</select></label>
<label>客户常搜的词（可选）<input name="keywords" value="${esc(f.keywords || '')}" placeholder="如 UFO high bay, warehouse light" size="30"></label>
<label>参考页面链接（可选，只读标题）<input name="reference" value="${esc(f.reference || '')}" placeholder="https://" size="30"></label><button>生成标题</button></form>
${res}
${p ? `<div class="cp"><h3>${esc(p.id)} 当前标题</h3><p>英文：<b translate="no">${esc(p.name)}</b> ${hitList(W.checkText(p.name))}</p><p>中文：<b translate="no">${esc(p.nameZh || '—')}</b> ${p.nameZh ? hitList(W.checkText(p.nameZh)) : ''}</p>
<form method="post" action="/admin/copy/apply" class="acts"><input type="hidden" name="product" value="${esc(p.id)}"><select name="lang" aria-label="语言">${opt(LANGS, 'en')}</select> <input name="title" placeholder="手动输入标题" size="50" required> <button>检查并应用</button></form>
<h3>标题历史</h3><div class="wrap"><table><thead><tr><th>时间</th><th>语言</th><th>新标题</th><th>原标题</th><th>来源</th><th>操作人</th><th></th></tr></thead><tbody>${hist.map((h) => `<tr><td>${fmt(h.ts)}</td><td>${h.lang === 'zh' ? '中文' : 'English'}</td><td translate="no">${esc(h.title)}</td><td class="mute" translate="no">${esc(h.previous)}</td><td>${esc({ ai: 'AI', rules: '按资料生成', manual: '手动', revert: '改回' }[h.source] || h.source)}</td><td>${esc(h.created_by)}</td>
<td>${h.previous ? `<form method="post" action="/admin/copy/apply"><input type="hidden" name="product" value="${esc(p.id)}"><input type="hidden" name="lang" value="${h.lang}"><input type="hidden" name="title" value="${esc(h.previous)}"><input type="hidden" name="source" value="revert"><button>改回原标题</button></form>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="mute">还没有修改记录</td></tr>'}</tbody></table></div></div>` : ''}`);
}

function promptsPage(c, result = null, f = {}) {
  const edit = c.req.query('edit') ? W.getTemplate(c.req.query('edit')) : null;
  return view('提示词', `${flash(c)}<h2>提示词</h2>
<form method="post" action="/admin/copy/prompt" class="cp"><h3>AI 优化提示词</h3><p class="mute">写下大致要求（如"白底，突出灯珠"），生成可以直接给图片或文案模型使用的完整提示词。</p>
<textarea name="text" required placeholder="大致要求">${esc(f.text || '')}</textarea><label>用途<select name="purpose">${opt(Object.entries(W.PURPOSES), f.purpose || 'image')}</select></label><label>语言<select name="lang">${opt([['zh', '中文'], ['en', 'English']], f.lang || 'zh')}</select></label><button>优化</button>
${result ? `<h4>优化结果 <span class="mute" style="font-size:12px">${result.source === 'ai' ? 'AI 生成' : '规则生成（未配置大模型）'}</span></h4><pre id="optimised" translate="no" style="white-space:pre-wrap;background:#f5f7f9;padding:10px;border-radius:6px">${esc(result.prompt)}</pre>
<button type="button" onclick="navigator.clipboard.writeText(document.getElementById('optimised').textContent)">复制</button>` : ''}</form>
${result ? `<form method="post" action="/admin/copy/templates" class="cp"><b>保存为模板</b><input type="hidden" name="body" value="${esc(result.prompt)}"><input type="hidden" name="kind" value="${esc(f.purpose)}"><input type="hidden" name="lang" value="${esc(f.lang)}"> <input name="name" placeholder="模板名称" required> <button>保存</button></form>` : ''}
<div class="cp"><h3>模板库</h3><p class="mute">可用变量：{{name}} {{model}} {{specs}} {{certifications}} {{keywords}} {{applications}} {{warranty}} {{direction}} {{count}} {{maxLength}} {{watt}}；图片模板另有 {{size}} {{scene}}。内置模板不能删除，编辑后另存为自己的模板。</p>
<div class="wrap"><table><thead><tr><th>名称</th><th>类型</th><th>语言</th><th>内容</th><th></th></tr></thead><tbody>${W.listTemplates().map((t) => `<tr><td><b>${esc(t.name)}</b>${t.builtin ? ' <span class="pill">内置</span>' : ''}<div class="mute">${esc(t.created_by || '')}</div></td><td>${esc(W.KINDS[t.kind])}</td><td>${t.lang === 'zh' ? '中文' : 'English'}</td><td style="max-width:520px" translate="no">${esc(t.body)}</td>
<td><a href="/admin/copy/prompts?edit=${encodeURIComponent(t.id)}#tpl">${t.builtin ? '复制并编辑' : '编辑'}</a>${t.builtin ? '' : ` <form method="post" action="/admin/copy/templates/${encodeURIComponent(t.id)}/delete" style="display:inline" onsubmit="return confirm('删除这个模板？')"><button>删除</button></form>`}</td></tr>`).join('')}</tbody></table></div></div>
<form method="post" action="/admin/copy/templates" class="cp" id="tpl"><h3>${edit ? (edit.builtin ? `复制「${esc(edit.name)}」` : `编辑「${esc(edit.name)}」`) : '新建模板'}</h3>${edit && !edit.builtin ? `<input type="hidden" name="id" value="${esc(edit.id)}">` : ''}
<label>名称<input name="name" value="${esc(edit ? (edit.builtin ? `${edit.name}（副本）` : edit.name) : '')}" required></label><label>类型<select name="kind">${opt(Object.entries(W.KINDS), edit?.kind || 'title')}</select></label><label>语言<select name="lang">${opt([['zh', '中文'], ['en', 'English']], edit?.lang || 'zh')}</select></label>
<textarea name="body" required placeholder="模板内容，可用 {{name}} 等变量">${esc(edit?.body || '')}</textarea><button>保存模板</button></form>`);
}

function bannedPage(c, check = null) {
  const words = W.bannedWords();
  const off = W.disabledBuiltins();
  return view('违禁词', `${flash(c)}<h2>违禁词</h2><p class="mute">保存商品时（后台编辑、表格导入、AI 自动上架）自动检查名称、简介、卖点、关键词和应用场景：<b>禁止</b>级的词不能保存，<b>提醒</b>级的词可以保存但会提示。英文按整词匹配、不区分大小写，中文按字匹配。</p>
<form method="post" action="/admin/copy/check" class="cp"><h3>检查一段文字</h3><textarea name="text" required placeholder="粘贴标题、卖点或描述">${esc(check?.text || '')}</textarea><button>检查</button>
${check ? `<div style="margin-top:8px">${check.hits.length ? `<div translate="no">${marked(check.text, check.hits)}</div>${hitList(check.hits)}` : '<p>✓ 没有发现违禁词</p>'}</div>` : ''}</form>
<form method="post" action="/admin/copy/banned" class="cp acts"><b>添加违禁词</b> <input name="word" placeholder="词语" required> <select name="lang" aria-label="语言">${opt(LANGS, 'en')}</select> <select name="level" aria-label="级别">${opt(Object.entries(W.LEVELS), 'warn')}</select> <input name="reason" placeholder="原因，如 广告法" size="16"> <button>添加</button></form>
<div class="wrap"><table><thead><tr><th>词语</th><th>语言</th><th>级别</th><th>原因</th><th>来源</th><th></th></tr></thead><tbody>${words.map((w) => `<tr><td translate="no"><b>${esc(w.word)}</b></td><td>${w.lang === 'zh' ? '中文' : 'English'}</td><td>${w.level === 'block' ? '<span class="pill" style="background:#fdecea">禁止</span>' : '<span class="pill" style="background:#fff4e5">提醒</span>'}</td><td${w.builtin ? "" : " translate=\"no\""}>${esc(w.reason)}</td><td>${w.builtin ? "内置" : "自定义"}</td>
<td><form method="post" action="/admin/copy/banned/delete" style="display:inline"><input type="hidden" name="word" value="${esc(w.word)}"><button>${w.builtin ? '停用' : '删除'}</button></form></td></tr>`).join('')}</tbody></table></div>
${off.length ? `<h3>已停用的内置词</h3><p>${off.map((w) => `<form method="post" action="/admin/copy/banned/restore" style="display:inline;margin-right:8px"><input type="hidden" name="word" value="${esc(w)}"><button>恢复「<span translate="no">${esc(w)}</span>」</button></form>`).join('')}</p>` : ''}`);
}

export function mountCopyAdmin(app) {
  app.get('/admin/copy', (c) => c.html(titlePage(c)));
  app.post('/admin/copy/titles', async (c) => {
    const f = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v).trim()]));
    try {
      let reference = null;
      if (f.reference) {
        try { const r = await safeFetch(f.reference); reference = extract(r.body.toString('utf8'), r.url); } catch (e) { throw new Error(`参考页面打不开：${e.reason || e.message}`); }
      }
      const result = await W.optimiseTitles({ productId: f.product, lang: f.lang, direction: f.direction, templateId: f.template, keywords: f.keywords, reference });
      return c.html(titlePage(c, result, f));
    } catch (e) { return back(c, `/admin/copy${f.product ? `?product=${encodeURIComponent(f.product)}` : ''}`, 'e', e.message); }
  });
  app.post('/admin/copy/apply', async (c) => {
    const f = await c.req.parseBody();
    const to = `/admin/copy?product=${encodeURIComponent(String(f.product || ''))}`;
    try { W.applyTitle(String(f.product), String(f.lang) === 'zh' ? 'zh' : 'en', String(f.title || ''), { source: ['ai', 'rules', 'revert'].includes(String(f.source)) ? String(f.source) : 'manual' }); return back(c, to, 'm', '标题已应用到商品（点"发布到网站"后生效）'); } catch (e) { return back(c, to, 'e', e.message); }
  });
  app.get('/admin/copy/prompts', (c) => c.html(promptsPage(c)));
  app.post('/admin/copy/prompt', async (c) => {
    const f = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]));
    try { return c.html(promptsPage(c, await W.optimisePrompt({ text: f.text, purpose: W.PURPOSES[f.purpose] ? f.purpose : 'image', lang: f.lang === 'en' ? 'en' : 'zh' }), f)); } catch (e) { return back(c, '/admin/copy/prompts', 'e', e.message); }
  });
  app.post('/admin/copy/templates', async (c) => { const f = await c.req.parseBody(); try { W.saveTemplate(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, String(v)]))); return back(c, '/admin/copy/prompts', 'm', '模板已保存'); } catch (e) { return back(c, '/admin/copy/prompts', 'e', e.message); } });
  app.post('/admin/copy/templates/:id/delete', (c) => { try { W.deleteTemplate(c.req.param('id')); return back(c, '/admin/copy/prompts', 'm', '已删除'); } catch (e) { return back(c, '/admin/copy/prompts', 'e', e.message); } });
  app.get('/admin/copy/banned', (c) => c.html(bannedPage(c)));
  app.post('/admin/copy/check', async (c) => { const text = String((await c.req.parseBody()).text || ''); return c.html(bannedPage(c, { text, hits: W.checkText(text) })); });
  app.post('/admin/copy/banned', async (c) => { const f = await c.req.parseBody(); try { W.saveBannedWord(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, String(v)]))); return back(c, '/admin/copy/banned', 'm', '已添加'); } catch (e) { return back(c, '/admin/copy/banned', 'e', e.message); } });
  app.post('/admin/copy/banned/delete', async (c) => { W.deleteBannedWord(String((await c.req.parseBody()).word || '')); return back(c, '/admin/copy/banned', 'm', '已删除 / 停用'); });
  app.post('/admin/copy/banned/restore', async (c) => { W.restoreBuiltin(String((await c.req.parseBody()).word || '')); return back(c, '/admin/copy/banned', 'm', '已恢复'); });
}
