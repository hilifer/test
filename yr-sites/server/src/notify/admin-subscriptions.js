// 后台：消息提醒。每个人在"修改密码"页选择要接收的重要事件和接收方式（企业微信 @ 我、邮件）；管理员在"账号权限 → 消息提醒"设置每类事件是否发到群里，并查看谁订阅了什么、最近推送。
import { shell, esc, fmt } from '../admin.js';
import { currentUser } from '../auth.js';
import * as N from './subscriptions.js';

const flash = (c) => `${c.req.query('m') ? `<div class="warn" style="background:#e8f5e9;border-color:#a5d6a7">${esc(c.req.query('m'))}</div>` : ''}${c.req.query('e') ? `<div class="warn" style="background:#fdecea;border-color:#f5b7b1">${esc(c.req.query('e'))}</div>` : ''}`;
const back = (c, path, k, v) => c.redirect(`${path}${path.includes('?') ? '&' : '?'}${k}=${encodeURIComponent(v)}`);

/** The "消息提醒" section of a person's own page. */
export function notifySection(user) {
  const p = N.prefsOf(user.username);
  const allowed = N.allowedEvents(user);
  const groups = [...new Set(allowed.map((k) => N.EVENTS[k].group))];
  return `<h2 id="notify">消息提醒</h2><p class="mute">勾选要接收的重要事件。企业微信群里会 @ 你（填企业微信账号或群成员绑定的手机号），也可以同时发邮件。只能选择你有权限查看的事件。</p>
<form method="post" action="/admin/me/notify" style="display:grid;gap:10px;max-width:760px">
${groups.map((g) => `<fieldset style="border:1px solid var(--line);border-radius:8px;padding:8px 12px"><legend>${esc(g)}</legend>${allowed.filter((k) => N.EVENTS[k].group === g).map((k) => `<label style="display:inline-flex;gap:6px;margin:4px 16px 4px 0"><input type="checkbox" name="events" value="${k}"${p.events.includes(k) ? ' checked' : ''}> ${esc(N.EVENTS[k].name)}</label>`).join('')}</fieldset>`).join('')}
<label style="display:grid;gap:4px">企业微信账号（成员 UserID，可在企业微信管理后台查看）<input name="wecom_id" value="${esc(p.wecom_id)}" translate="no"></label>
<label style="display:grid;gap:4px">或手机号（企业微信绑定的手机号）<input name="mobile" value="${esc(p.mobile)}" translate="no"></label>
<label style="display:grid;gap:4px">邮箱<input name="email" type="email" value="${esc(p.email)}" translate="no"></label>
<label><input type="checkbox" name="email_on" value="1"${p.email_on ? ' checked' : ''}> 同时发邮件</label>
<div><button>保存提醒设置</button> <button formaction="/admin/me/notify/test">给我发一条测试消息</button></div></form>`;
}

function adminPage(c) {
  const rows = N.overview();
  const log = N.recentLog(30);
  return shell('消息提醒', `${flash(c)}<p><a href="/admin/users">← 账号权限</a></p><h2>消息提醒</h2><p class="mute">每个人在"修改密码 → 消息提醒"里选择自己要接收的事件。这里设置每类事件是否发到企业微信 / 飞书群。没有人订阅时，"有人订阅时才发"的事件不会打扰群里。</p>
<form method="post" action="/admin/users/notify"><div class="wrap"><table><thead><tr><th>岗位</th><th>事件</th><th>群推送</th><th>订阅的人</th></tr></thead><tbody>
${rows.map((r) => `<tr><td>${esc(r.group)}</td><td><b>${esc(r.name)}</b></td><td><select name="mode_${r.event}" aria-label="群推送">${Object.entries(N.GROUP_MODES).map(([k, l]) => `<option value="${k}"${k === r.mode ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></td><td>${r.people.length ? r.people.map(esc).join('、') : '<span class="mute">没有人订阅</span>'}</td></tr>`).join('')}
</tbody></table></div><p><button>保存</button></p></form>
<h3>最近推送</h3><div class="wrap"><table><thead><tr><th>时间</th><th>事件</th><th>内容</th><th>发到群</th><th>@ 的人</th><th>邮件</th></tr></thead><tbody>
${log.map((l) => `<tr><td>${fmt(l.ts)}</td><td>${esc(N.EVENTS[l.event]?.name || (l.event === '_test' ? '测试' : l.event))}</td><td>${esc(l.title)}</td><td>${l.grouped ? '是' : '否'}</td><td>${esc(l.mentioned.join('、'))}</td><td>${esc(l.emailed.join('、'))}</td></tr>`).join('') || '<tr><td colspan="6" class="mute">还没有推送记录</td></tr>'}</tbody></table></div>`);
}

export function mountNotifyAdmin(app) {
  app.post('/admin/me/notify', async (c) => {
    const f = await c.req.parseBody({ all: true });
    try { N.savePrefs(currentUser(), { events: [].concat(f.events || []), wecom_id: f.wecom_id, mobile: f.mobile, email: f.email, email_on: f.email_on === '1' }); return back(c, '/admin/me', 'm', '提醒设置已保存'); } catch (e) { return back(c, '/admin/me', 'e', e.message); }
  });
  app.post('/admin/me/notify/test', async (c) => {
    const u = currentUser(), p = N.prefsOf(u.username);
    if (!p.wecom_id && !p.mobile && !(p.email_on && p.email)) return back(c, '/admin/me', 'e', '请先保存企业微信账号、手机号或邮箱');
    await N.sendTest(u);
    return back(c, '/admin/me', 'm', '测试消息已发送，请查看企业微信群或邮箱');
  });
  app.get('/admin/users/notify', (c) => c.html(adminPage(c)));
  app.post('/admin/users/notify', async (c) => {
    const f = await c.req.parseBody();
    try { N.saveGroupModes(Object.fromEntries(Object.keys(N.EVENTS).filter((k) => f[`mode_${k}`]).map((k) => [k, f[`mode_${k}`]]))); return back(c, '/admin/users/notify', 'm', '已保存'); } catch (e) { return back(c, '/admin/users/notify', 'e', e.message); }
  });
}
