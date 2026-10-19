// 后台「内容」与「GEO 监测」页面
import YAML from 'yaml';
import { config } from '../config.js';
import { shell, esc, fmt } from '../admin.js';
import { listArticles, readArticle, saveArticle, setStatus, recentRuns, articleUrl } from './store.js';
import { generateArticle } from './writer.js';
import { rebuild, indexNow, buildRunning } from './publisher.js';
import { runGeoCheck, geoHistory } from './geo.js';

const ST = { draft: ['待审核', '#ef8f00'], published: ['已发布', '#2e7d32'], rejected: ['已退回', '#90a4ae'] };
const pill = (s) => { const [l, c] = ST[s] || [s, '#90a4ae']; return `<span class="pill" style="background:${c};color:#fff">${l}</span>`; };

export function contentPage(flash = '') {
  const c = config.content;
  const rows = listArticles().map((a) => {
    const r = a.data.review || {};
    return `<tr><td>${esc(String(a.data.date || '').slice(0, 10))}</td><td>${esc(a.data.lang || 'en')}</td><td>${pill(a.data.status)}</td>
<td><a href="/admin/content/edit?id=${encodeURIComponent(a.id)}"><b>${esc(a.data.title)}</b></a><div class="mute">${esc(a.data.targetQuestion || a.data.description || '')}</div></td>
<td>${esc(a.data.kind || (a.data.generatedBy === 'seed' ? '示例' : ''))}</td><td>${r.issues?.length ? `<span style="color:#c62828">${r.issues.length} 项需处理</span>` : '—'}</td>
<td>${a.data.status === 'published' ? `<a href="${articleUrl(a.id)}" target="_blank">查看</a>` : ''}</td></tr>`;
  }).join('');
  const runs = recentRuns(12).map((r) => `<tr><td>${fmt(r.ts)}</td><td>${esc(r.kind)}</td><td>${esc(r.status)}</td><td class="mute" style="max-width:640px;word-break:break-all">${esc(String(r.detail).slice(0, 300))}</td></tr>`).join('');
  return shell('内容', `${flash ? `<div class="warn">${esc(flash)}</div>` : ''}
<div class="tiles">
 <div class="tile"><span>自动写作</span><strong>${c.enabled ? '已开启' : '未开启'}</strong><span>${c.enabled ? `每周 ${c.days.map((d) => '日一二三四五六'[d]).join('、')} ${c.hour}:00（${esc(c.tz)}）· 语言 ${esc(c.langs.join('/'))}` : '设置 CONTENT_ENABLED=true 开启'}</span></div>
 <div class="tile"><span>发布方式</span><strong>${c.autoPublish ? '自动发布' : '人工审核'}</strong><span>${c.autoPublish ? '未通过校验的仍会留作草稿' : '草稿需在此点击发布'}</span></div>
 <div class="tile"><span>IndexNow</span><strong>${c.indexNowKey ? '已配置' : '未配置'}</strong><span>发布后通知 Bing 等搜索引擎</span></div>
 <div class="tile"><span>网站构建</span><strong>${buildRunning() ? '构建中…' : '空闲'}</strong></div>
</div>
<form method="post" action="/admin/content/generate" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;align-items:center">
 <b>立即生成一篇：</b><select name="lang">${c.langs.map((l) => `<option value="${l}">${l === 'zh' ? '中文' : 'English'}</option>`).join('')}</select>
 <input name="topic" placeholder="指定题目（可留空，由智能体选题）" style="flex:1;min-width:260px;padding:6px 8px">
 <button>生成</button></form>
<form method="post" action="/admin/content/rebuild" style="margin-bottom:20px"><button>重新构建网站</button> <span class="mute">修改文章后点此生效（发布操作会自动构建）</span></form>
<div class="wrap"><table><thead><tr><th>日期</th><th>语言</th><th>状态</th><th>标题 / 目标问题</th><th>类型</th><th>校验</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="mute">暂无文章</td></tr>'}</tbody></table></div>
<h3 style="margin-top:28px">运行记录</h3><div class="wrap"><table><tbody>${runs || '<tr><td class="mute">暂无</td></tr>'}</tbody></table></div>`);
}

export function editPage(id) {
  const a = readArticle(id);
  if (!a) return shell('未找到', '<p>文章不存在</p>');
  const { review = {}, ...front } = a.data;
  return shell('编辑文章', `<p><a href="/admin/content">← 返回内容列表</a></p>
<h2 style="margin:0 0 6px">${esc(a.data.title)}</h2><p>${pill(a.data.status)} <span class="mute">${esc(a.id)} · ${esc(a.data.generatedBy || '')}</span></p>
${review.issues?.length ? `<div class="warn"><b>发布前需处理：</b><ul>${review.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div>` : ''}
${review.notes?.length ? `<div class="msg"><b>提示：</b><ul>${review.notes.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div>` : ''}
<form method="post" action="/admin/content/save?id=${encodeURIComponent(a.id)}" style="display:grid;gap:10px">
<label><b>元数据（YAML：标题、摘要、FAQ、来源、关联产品）</b><textarea name="front" rows="16" style="width:100%;font:13px/1.5 ui-monospace,monospace">${esc(YAML.stringify(front, { lineWidth: 0 }))}</textarea></label>
<label><b>正文（Markdown）</b><textarea name="body" rows="28" style="width:100%;font:14px/1.6 ui-monospace,monospace">${esc(a.body)}</textarea></label>
<div style="display:flex;gap:8px;flex-wrap:wrap">
 <button name="action" value="save">保存</button>
 <button name="action" value="publish" style="background:#2e7d32;color:#fff;border:0;padding:6px 14px;border-radius:6px">保存并发布</button>
 ${a.data.status === 'published' ? '<button name="action" value="unpublish">撤回为草稿</button>' : '<button name="action" value="reject">退回（不发布）</button>'}
</div></form>`);
}

export function geoPage(flash = '') {
  const rows = geoHistory().map((g) => `<tr><td>${fmt(g.ts)}</td><td>${esc(g.question)}</td><td>${g.mentioned ? '<b style="color:#2e7d32">被提及</b>' : '<span class="mute">未提及</span>'}</td><td>${esc(g.competitors)}</td><td><details><summary>回答</summary><div style="max-width:620px;white-space:pre-wrap">${esc(g.answer)}</div></details></td></tr>`).join('');
  const qs = (config.profile.content.geo?.questions || []).map((q) => `<li>${esc(q.q)}</li>`).join('');
  return shell('GEO 监测', `${flash ? `<div class="warn">${esc(flash)}</div>` : ''}
<p>每周用 AI 回答引擎问一遍买家常问的问题，记录我们是否被提及。监测问题在站点配置 <code>content.geo.questions</code> 中维护。${config.geo.llm.apiKey ? '' : '<br><span class="mute">建议配置 GEO_LLM_*（如 Perplexity 等带联网搜索的模型），否则结果只反映模型训练数据。</span>'}</p>
<details><summary>当前监测问题</summary><ul>${qs}</ul></details>
<form method="post" action="/admin/geo/run" style="margin:12px 0"><button>立即运行一次</button></form>
<div class="wrap"><table><thead><tr><th>时间</th><th>问题</th><th>结果</th><th>出现的竞品</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="mute">暂无记录</td></tr>'}</tbody></table></div>`);
}

export function mountContentAdmin(app) {
  app.get('/admin/content', (c) => c.html(contentPage(c.req.query('m') || '')));
  app.get('/admin/content/edit', (c) => c.html(editPage(c.req.query('id') || '')));
  app.post('/admin/content/save', async (c) => {
    const id = c.req.query('id') || '';
    const f = await c.req.parseBody();
    const a = readArticle(id);
    if (!a) return c.text('not found', 404);
    let front;
    try { front = YAML.parse(String(f.front || '')) || {}; } catch (e) { return c.html(shell('YAML 错误', `<div class="warn">元数据 YAML 格式错误：${esc(e.message)}</div><p><a href="javascript:history.back()">返回修改</a></p>`)); }
    const action = String(f.action || 'save');
    if (action === 'publish') { front.status = 'published'; front.publishedAt ||= new Date().toISOString(); front.review = { ...(a.data.review || {}), approvedAt: new Date().toISOString(), issues: [] }; }
    else front.review = a.data.review;
    if (action === 'unpublish') front.status = 'draft';
    if (action === 'reject') front.status = 'rejected';
    front.updated = action === 'publish' && a.data.status === 'published' ? new Date().toISOString().slice(0, 10) : front.updated;
    if (!front.updated) delete front.updated;
    saveArticle(id, front, String(f.body || '').replace(/\r\n/g, '\n'));
    if (action === 'publish' || action === 'unpublish' || (a.data.status === 'published' && action === 'save')) {
      rebuild().then(() => action === 'publish' && indexNow([articleUrl(id), '/news/', '/llms.txt', '/sitemap.xml'])).catch(() => {});
      return c.redirect('/admin/content?m=' + encodeURIComponent('已保存，网站正在后台重新构建，约 1 分钟后生效。'));
    }
    return c.redirect('/admin/content?m=' + encodeURIComponent('已保存。'));
  });
  app.post('/admin/content/generate', async (c) => {
    const f = await c.req.parseBody();
    generateArticle({ lang: String(f.lang || 'en'), topic: String(f.topic || '').trim() })
      .then((r) => { if (r.status === 'published') rebuild().then(() => indexNow([articleUrl(r.id), '/news/'])).catch(() => {}); })
      .catch(() => {});
    return c.redirect('/admin/content?m=' + encodeURIComponent('已开始生成，约 1–2 分钟后刷新本页查看草稿（失败原因见下方运行记录）。'));
  });
  app.post('/admin/content/rebuild', (c) => { rebuild().catch(() => {}); return c.redirect('/admin/content?m=' + encodeURIComponent('已开始重新构建网站。')); });
  app.get('/admin/geo', (c) => c.html(geoPage(c.req.query('m') || '')));
  app.post('/admin/geo/run', (c) => { runGeoCheck().catch(() => {}); return c.redirect('/admin/geo?m=' + encodeURIComponent('已开始，稍后刷新查看结果。')); });
}
