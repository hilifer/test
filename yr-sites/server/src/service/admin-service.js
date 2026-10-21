// 后台：客服。统一收件箱（在线对话、客户邮件、联系表单、售后申请）、邮件回复、快捷回复、知识库（AI 优先用它回答）、客服绩效与客户评价。
import { shell, esc, fmt } from '../admin.js';
import { config } from '../config.js';
import { currentUser } from '../auth.js';
import * as D from './desk.js';

const flash = (c) => `${c.req.query('m') ? `<div class="warn" style="background:#e8f5e9;border-color:#a5d6a7">${esc(c.req.query('m'))}</div>` : ''}${c.req.query('e') ? `<div class="warn" style="background:#fdecea;border-color:#f5b7b1">${esc(c.req.query('e'))}</div>` : ''}`;
const back = (c, path, k, v) => c.redirect(`${path}${path.includes('?') ? '&' : '?'}${k}=${encodeURIComponent(v)}`);
const SUB = '<p class="acts"><a href="/admin/service">收件箱</a> · <a href="/admin/conversations">在线对话</a> · <a href="/admin/service/quick-replies">快捷回复</a> · <a href="/admin/service/kb">知识库</a> · <a href="/admin/service/performance">客服绩效</a> · <a href="/admin/rma">售后</a></p>';
const view = (title, body) => shell(title, SUB + body);
const CHANNELS = { chat: '在线对话', email: '邮件', form: '联系表单', rma: '售后申请' };
const LANGS = { en: '英文', zh: '中文' };
const MAIL_STATUS = { open: '待回复', replied: '已回复', closed: '已关闭' };
const opt = (pairs, v) => pairs.map(([k, l]) => `<option value="${esc(k)}"${k === v ? ' selected' : ''}>${esc(l)}</option>`).join('');
const mins = (m) => (m == null ? '—' : m < 60 ? `${m} 分钟` : `${Math.round((m / 60) * 10) / 10} 小时`);
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

/** Quick-reply picker for a reply box: choosing one inserts it at the cursor and counts the use. */
export function quickReplyPicker(textarea = 'textarea[name=text]') {
  const list = D.listQuickReplies();
  if (!list.length) return '<span class="mute">还没有快捷回复，<a href="/admin/service/quick-replies">去添加</a></span>';
  return `<select data-quick aria-label="快捷回复"><option value="">快捷回复…</option>${list.map((q) => `<option value="${q.id}" data-body="${esc(q.body)}">${esc(q.title)}（${esc(LANGS[q.lang] || q.lang)}）</option>`).join('')}</select>
<script>(()=>{const s=document.currentScript.previousElementSibling;s.addEventListener('change',()=>{const t=(s.closest('form')||document).querySelector(${JSON.stringify(textarea)}),o=s.selectedOptions[0];if(!o||!o.value)return;const b=o.dataset.body,p=t.selectionStart??t.value.length;t.value=t.value.slice(0,p)+b+t.value.slice(t.selectionEnd??p);t.focus();t.selectionStart=t.selectionEnd=p+b.length;fetch('/admin/service/quick-replies/'+o.value+'/use',{method:'POST'});s.value='';});})();</script>`;
}

function inboxPage(c) {
  const me = currentUser();
  const f = { channel: c.req.query('channel') || '', mine: c.req.query('mine') === '1' };
  const all = D.inbox();
  const items = D.inbox({ channel: f.channel, mine: f.mine ? me.username : null });
  const count = (ch) => all.filter((i) => i.channel === ch).length;
  const r = D.ratingSummary(30);
  const tab = (ch, label, n) => `<a href="?channel=${ch}${f.mine ? '&mine=1' : ''}"${f.channel === ch ? ' style="font-weight:700"' : ''}>${label}${n != null ? ` ${n}` : ''}</a>`;
  return view('客服收件箱', `${flash(c)}<h2>客服收件箱</h2>
<div class="tiles"><a class="tile" href="?channel=chat"><span>在线对话待处理</span><strong>${count('chat')}</strong></a><a class="tile" href="?channel=email"><span>邮件未关闭</span><strong>${count('email')}</strong></a><a class="tile" href="?channel=form"><span>联系表单待处理</span><strong>${count('form')}</strong></a><a class="tile" href="?channel=rma"><span>售后待审核</span><strong>${count('rma')}</strong></a><a class="tile" href="/admin/service/performance"><span>近 30 天客户评分</span><strong>${r.avg ?? '—'}</strong></a></div>
<p class="acts">${tab('', '全部', all.length)} · ${Object.entries(CHANNELS).map(([k, l]) => tab(k, l, count(k))).join(' · ')} · <a href="?channel=${esc(f.channel)}${f.mine ? '' : '&mine=1'}">${f.mine ? '看全部人的' : '只看我的和未分配的'}</a></p>
<meta http-equiv="refresh" content="60"><div class="wrap"><table><thead><tr><th>时间</th><th>渠道</th><th>客户</th><th>内容</th><th>处理人</th><th></th></tr></thead><tbody>
${items.map((i) => `<tr${i.urgent ? ' style="background:#fff8e1"' : ''}><td>${fmt(i.ts)}</td><td><span class="pill">${esc(CHANNELS[i.channel])}</span></td><td translate="no">${esc(i.who)}</td><td><b>${esc(i.title)}</b><div class="mute" translate="no">${esc(i.preview)}</div></td><td>${esc(i.assignee || '—')}</td><td><a href="${esc(i.href)}">处理</a></td></tr>`).join('') || '<tr><td colspan="6" class="mute">收件箱是空的</td></tr>'}</tbody></table></div>
<p class="mute">客户邮件通过收信回调进入收件箱：在邮件服务（Mailgun / SendGrid / Postmark）把来信转发到 <code>${esc(config.publicBaseUrl)}/api/inbound/email?token=…</code>（口令在环境变量 INBOUND_EMAIL_TOKEN）。</p>`);
}

function mailPage(c, m) {
  return view('客户邮件', `${flash(c)}<p><a href="/admin/service?channel=email">← 返回收件箱</a></p><h2 translate="no">${esc(m.subject)}</h2>
<p><span translate="no">${esc(m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr)}</span> · ${fmt(m.received_at)} · <span class="pill">${esc(MAIL_STATUS[m.status] || m.status)}</span>${m.assignee ? ` · 处理人 ${esc(m.assignee)}` : ''}</p>
<div class="msg user" style="margin-left:0" translate="no">${esc(m.body).replace(/\n/g, '<br>')}</div>
${m.replies.map((r) => `<div class="msg agent"><div class="mute">${esc(r.by)} · ${fmt(r.ts)}${r.status && r.status !== 'sent' ? ` · ${esc(r.status)}` : ''}</div><span translate="no">${esc(r.text).replace(/\n/g, '<br>')}</span></div>`).join('')}
<form method="post" action="/admin/service/mail/${m.id}/reply" style="max-width:760px;display:grid;gap:8px;margin-top:12px"><div>${quickReplyPicker()}</div><textarea name="text" rows="6" required placeholder="回复内容（以邮件发给客户，自动附原文）"></textarea><div><button>发送回复</button></div></form>
<form method="post" action="/admin/service/mail/${m.id}/status" class="acts" style="margin-top:12px">${m.status !== 'closed' ? '<button name="status" value="closed">关闭（不需回复）</button>' : '<button name="status" value="open">重新打开</button>'}</form>`);
}

function quickPage(c) {
  const edit = c.req.query('edit') ? D.listQuickReplies().find((q) => q.id === Number(c.req.query('edit'))) : null;
  return view('快捷回复', `${flash(c)}<h2>快捷回复</h2><p class="mute">常用回复（交期、付款方式、样品、认证等），在对话和邮件回复框上方一键插入。按使用次数排序。</p>
<div class="wrap"><table><thead><tr><th>标题</th><th>语言</th><th>内容</th><th class="n">使用</th><th></th></tr></thead><tbody>
${D.listQuickReplies().map((q) => `<tr><td><b>${esc(q.title)}</b></td><td>${esc(LANGS[q.lang] || q.lang)}</td><td translate="no">${esc(q.body).replace(/\n/g, '<br>')}</td><td class="n">${q.uses}</td><td><a href="?edit=${q.id}">编辑</a> <form method="post" action="/admin/service/quick-replies/${q.id}/delete" style="display:inline" onsubmit="return confirm('删除这条快捷回复？')"><button>删除</button></form></td></tr>`).join('') || '<tr><td colspan="5" class="mute">还没有快捷回复</td></tr>'}</tbody></table></div>
<form method="post" action="/admin/service/quick-replies" class="msg" style="max-width:760px;display:grid;gap:8px"><b>${edit ? '编辑快捷回复' : '新增快捷回复'}</b>${edit ? `<input type="hidden" name="id" value="${edit.id}">` : ''}
<label>标题 <input name="title" value="${esc(edit?.title || '')}" maxlength="60" required></label><label>语言 <select name="lang">${opt(Object.entries(LANGS), edit?.lang || 'en')}</select></label>
<textarea name="body" rows="4" required placeholder="回复内容">${esc(edit?.body || '')}</textarea><div><button>保存</button>${edit ? ' <a href="/admin/service/quick-replies">取消</a>' : ''}</div></form>`);
}

function kbPage(c) {
  const f = { q: c.req.query('q') || '', lang: c.req.query('lang') || '' };
  const test = c.req.query('test') || '';
  const edit = c.req.query('edit') ? D.listKb().find((a) => a.id === Number(c.req.query('edit'))) : null;
  const hits = test ? D.searchKb(test) : [];
  return view('知识库', `${flash(c)}<h2>知识库</h2><p class="mute">客服团队审核过的问答。AI 回答客户时优先引用这里的答案；未配置大模型时，匹配度高的问题直接用这里的答案回复。关键词用逗号分隔，帮助匹配不同说法。</p>
<form method="get" class="acts"><input name="test" value="${esc(test)}" placeholder="输入一个客户问题，看会匹配到哪条" size="40"><button>试一试</button></form>
${test ? `<div class="msg" style="max-width:none">${hits.length ? hits.map((h) => `<div><b translate="no">${esc(h.article.question)}</b> <span class="mute">匹配度 ${pct(h.score)}${h.score >= 0.6 ? ' · 规则模式会直接回答' : ''}</span></div>`).join('') : '<span class="mute">没有匹配的条目，AI 会用通用知识和产品资料回答</span>'}</div>` : ''}
<form method="get" class="acts"><input name="q" value="${esc(f.q)}" placeholder="搜索问题、答案、关键词"><select name="lang"><option value="">全部语言</option>${opt(Object.entries(LANGS), f.lang)}</select><button>筛选</button></form>
<div class="wrap"><table><thead><tr><th>问题</th><th>答案</th><th>语言</th><th class="n">命中</th><th>状态</th><th></th></tr></thead><tbody>
${D.listKb(f).map((a) => `<tr><td><b translate="no">${esc(a.question)}</b>${a.keywords ? `<div class="mute" translate="no">${esc(a.keywords)}</div>` : ''}</td><td translate="no">${esc(a.answer).replace(/\n/g, '<br>')}</td><td>${esc(LANGS[a.lang] || a.lang)}</td><td class="n">${a.hits}</td><td>${a.active ? '启用' : '<span class="mute">停用</span>'}</td><td><a href="?edit=${a.id}">编辑</a> <form method="post" action="/admin/service/kb/${a.id}/delete" style="display:inline" onsubmit="return confirm('删除这条问答？')"><button>删除</button></form></td></tr>`).join('') || '<tr><td colspan="6" class="mute">知识库是空的</td></tr>'}</tbody></table></div>
<form method="post" action="/admin/service/kb" class="msg" style="max-width:760px;display:grid;gap:8px"><b>${edit ? '编辑问答' : '新增问答'}</b>${edit ? `<input type="hidden" name="id" value="${edit.id}">` : ''}
<label>问题 <input name="question" value="${esc(edit?.question || '')}" size="60" required></label><textarea name="answer" rows="4" required placeholder="答案">${esc(edit?.answer || '')}</textarea>
<label>关键词 <input name="keywords" value="${esc(edit?.keywords || '')}" size="50" placeholder="warranty, guarantee"></label><label>语言 <select name="lang">${opt(Object.entries(LANGS), edit?.lang || 'en')}</select></label>
<label><input type="checkbox" name="active" value="1"${!edit || edit.active ? ' checked' : ''}> 启用</label><div><button>保存</button>${edit ? ' <a href="/admin/service/kb">取消</a>' : ''}</div></form>`);
}

function performancePage(c) {
  const days = [7, 30, 90].includes(Number(c.req.query('days'))) ? Number(c.req.query('days')) : 30;
  const rows = D.performance(days);
  const r = D.ratingSummary(days);
  const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
  return view('客服绩效', `<h2>客服绩效</h2><p class="acts">${[7, 30, 90].map((d) => `<a href="?days=${d}"${d === days ? ' style="font-weight:700"' : ''}>近 ${d} 天</a>`).join(' · ')}</p>
<div class="tiles"><div class="tile"><span>客户评价数</span><strong>${r.count}</strong></div><div class="tile"><span>平均评分</span><strong>${r.avg ?? '—'}</strong></div><div class="tile"><span>问题解决率</span><strong>${pct(r.resolutionRate)}</strong></div></div>
<p class="mute">首次响应 = 客户发消息到这位客服第一次回复的时间。解决率来自客户在对话结束后的评价（“问题解决了吗”）。</p>
<div class="wrap"><table><thead><tr><th>客服</th><th class="n">接待对话</th><th class="n">平均首次响应</th><th class="n">评价数</th><th class="n">平均评分</th><th class="n">解决率</th><th class="n">回复邮件</th><th class="n">邮件平均首次回复</th></tr></thead><tbody>
${rows.map((p) => `<tr><td><b>${esc(p.username)}</b></td><td class="n">${p.chats}</td><td class="n">${mins(p.avgFirstResponseMin)}</td><td class="n">${p.ratings}</td><td class="n">${p.avgRating ?? '—'}</td><td class="n">${pct(p.resolutionRate)}</td><td class="n">${p.emails}</td><td class="n">${mins(p.avgEmailResponseMin)}</td></tr>`).join('') || '<tr><td colspan="8" class="mute">这段时间没有人工接待记录</td></tr>'}</tbody></table></div>
<h3>最近的客户评价</h3><div class="wrap"><table><thead><tr><th>时间</th><th>评分</th><th>解决了吗</th><th>留言</th><th>接待</th><th></th></tr></thead><tbody>
${r.recent.map((x) => `<tr${x.rating <= 2 ? ' style="background:#fdecea"' : ''}><td>${fmt(x.ts)}</td><td style="color:#ef8f00" title="${x.rating}">${stars(x.rating)}</td><td>${x.resolved == null ? '—' : x.resolved ? '已解决' : '未解决'}</td><td translate="no">${esc(x.comment || '')}</td><td>${esc(x.agent || 'AI')}</td><td><a href="/admin/conv/${esc(x.conv_id)}">看对话</a></td></tr>`).join('') || '<tr><td colspan="6" class="mute">还没有客户评价</td></tr>'}</tbody></table></div>`);
}

export function mountServiceAdmin(app) {
  app.get('/admin/service', (c) => c.html(inboxPage(c)));
  app.get('/admin/service/mail/:id', (c) => { const m = D.getMail(c.req.param('id')); return m ? c.html(mailPage(c, m)) : c.text('Not found', 404); });
  app.post('/admin/service/mail/:id/reply', async (c) => {
    const f = await c.req.parseBody();
    const path = `/admin/service/mail/${Number(c.req.param('id'))}`;
    try { const r = await D.replyMail(c.req.param('id'), f.text, currentUser()); return back(c, path, r.status === 'failed' ? 'e' : 'm', r.status === 'failed' ? '邮件发送失败，请检查邮件服务设置' : '已回复'); } catch (e) { return back(c, path, 'e', e.message); }
  });
  app.post('/admin/service/mail/:id/status', async (c) => {
    const f = await c.req.parseBody();
    try { D.setMailStatus(c.req.param('id'), String(f.status || ''), currentUser()); return c.redirect('/admin/service?channel=email'); } catch (e) { return back(c, `/admin/service/mail/${Number(c.req.param('id'))}`, 'e', e.message); }
  });
  app.get('/admin/service/quick-replies', (c) => c.html(quickPage(c)));
  app.post('/admin/service/quick-replies', async (c) => {
    const f = await c.req.parseBody();
    try { D.saveQuickReply(f); return back(c, '/admin/service/quick-replies', 'm', '已保存'); } catch (e) { return back(c, '/admin/service/quick-replies', 'e', e.message); }
  });
  app.post('/admin/service/quick-replies/:id/delete', (c) => { D.deleteQuickReply(c.req.param('id')); return back(c, '/admin/service/quick-replies', 'm', '已删除'); });
  app.post('/admin/service/quick-replies/:id/use', (c) => { D.usedQuickReply(c.req.param('id')); return c.json({ ok: true }); });
  app.get('/admin/service/kb', (c) => c.html(kbPage(c)));
  app.post('/admin/service/kb', async (c) => {
    const f = await c.req.parseBody();
    try { D.saveKb({ ...f, active: f.active === '1' }); return back(c, '/admin/service/kb', 'm', '已保存'); } catch (e) { return back(c, '/admin/service/kb', 'e', e.message); }
  });
  app.post('/admin/service/kb/:id/delete', (c) => { D.deleteKb(c.req.param('id')); return back(c, '/admin/service/kb', 'm', '已删除'); });
  app.get('/admin/service/performance', (c) => c.html(performancePage(c)));
}

/** Public: inbound e-mail webhook (token in the query) and the customer's chat rating. */
export function mountServicePublic(app, { limit }) {
  app.post('/api/inbound/email', limit, async (c) => {
    const token = process.env.INBOUND_EMAIL_TOKEN;
    if (!token || c.req.query('token') !== token) return c.json({ error: 'not_found' }, 404);
    const ct = c.req.header('content-type') || '';
    const b = ct.includes('json') ? await c.req.json().catch(() => ({})) : await c.req.parseBody().catch(() => ({}));
    try { return c.json({ ok: true, id: D.receiveMail(b) }); } catch (e) { return c.json({ error: e.message }, 400); }
  });
  app.post('/api/chat/rate', limit, async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (!/^[\w-]{8,64}$/.test(String(b.sessionId || ''))) return c.json({ error: 'bad_session' }, 400);
    try { D.rateChat(b.sessionId, { rating: b.rating, resolved: b.resolved == null ? null : Boolean(b.resolved), comment: b.comment }); return c.json({ ok: true }); } catch (e) { return c.json({ error: e.message }, e.message === 'not_found' ? 404 : 400); }
  });
}
