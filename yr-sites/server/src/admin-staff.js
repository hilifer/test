// Login page, 403 page, staff accounts (admin only) and "change my password".
import { config } from './config.js';
import { shell, esc, fmt } from './admin.js';
import { ROLES, listStaff, getStaff, saveStaff, currentUser, verifyLogin, passwordProblem } from './auth.js';

const page = (title, body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7f9;font:15px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1d2733}
form,.box{background:#fff;border:1px solid #e2e6ea;border-radius:12px;padding:28px;width:min(360px,calc(100vw - 32px));display:grid;gap:14px}
h1{font-size:20px;margin:0}label{display:grid;gap:6px;font-size:14px}input{font:inherit;padding:10px 12px;border:1px solid #cfd6dc;border-radius:8px}
button{font:600 15px/1 inherit;padding:12px;border:0;border-radius:8px;background:#1d2733;color:#fff;cursor:pointer}.err{background:#fdecea;border:1px solid #f5b7b1;padding:10px 12px;border-radius:8px;font-size:14px}.mute{color:#66717d;font-size:13px}</style></head><body>${body}</body></html>`;

export function loginPage({ next = '/admin', error = '', username = '' } = {}) {
  return page('登录', `<form method="post" action="/admin/login"><h1>${esc(config.profile.brand)} 后台登录</h1>${error ? `<div class="err">${esc(error)}</div>` : ''}
<input type="hidden" name="next" value="${esc(next)}"><label>用户名<input name="username" value="${esc(username)}" autocomplete="username" required autofocus></label>
<label>密码<input name="password" type="password" autocomplete="current-password" required></label><button>登录</button><p class="mute">连续输错 5 次将锁定 15 分钟。</p></form>`);
}

export function forbiddenPage(user) {
  return page('无权限', `<div class="box"><h1>没有权限</h1><p>当前账号 ${esc(user.username)}（${esc(ROLES[user.role]?.zh || user.role)}）不能访问这个页面或执行这个操作。如需开通请联系管理员。</p><p><a href="/admin/ops">返回后台</a></p></div>`);
}

const roleOpts = (v) => Object.entries(ROLES).map(([k, r]) => `<option value="${k}"${k === v ? ' selected' : ''}>${r.zh}</option>`).join('');
const back = (c, path, msg, err = false) => c.redirect(`${path}?${err ? 'e' : 'm'}=${encodeURIComponent(msg)}`);
const flash = (c) => `${c.req.query('m') ? `<div class="warn" style="background:#e8f5e9;border-color:#a5d6a7">${esc(c.req.query('m'))}</div>` : ''}${c.req.query('e') ? `<div class="warn" style="background:#fdecea;border-color:#f5b7b1">${esc(c.req.query('e'))}</div>` : ''}`;

export function mountStaffAdmin(app) {
  app.get('/admin/users', (c) => {
    const rows = listStaff().map((u) => `<tr><td><b>${esc(u.username)}</b></td><td>${esc(u.name)}</td><td>${esc(ROLES[u.role]?.zh || u.role)}</td><td>${u.active ? '启用' : '<span class="mute">已停用</span>'}</td><td>${fmt(u.last_login_at)}</td><td><a href="/admin/users/${u.id}">编辑</a></td></tr>`).join('');
    const perms = Object.entries(ROLES).map(([, r]) => `<li><b>${r.zh}</b>：${r.perms.includes('*') ? '全部功能' : r.perms.join('、')}</li>`).join('');
    return c.html(shell('账号权限', `${flash(c)}<h2>账号与权限</h2><div class="wrap"><table><thead><tr><th>用户名</th><th>姓名</th><th>角色</th><th>状态</th><th>最近登录</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
<h3>新增账号</h3><form method="post" action="/admin/users/new" style="display:grid;gap:8px;max-width:420px"><input name="username" placeholder="用户名（小写字母/数字）" required><input name="name" placeholder="姓名"><select name="role">${roleOpts('sales')}</select><input name="password" type="password" placeholder="初始密码（≥10 位，含字母和数字）" required><button>创建</button></form>
<h3>角色说明</h3><ul>${perms}</ul>`));
  });
  app.post('/admin/users/new', async (c) => {
    const f = await c.req.parseBody();
    try { const u = saveStaff({ username: String(f.username || '').trim().toLowerCase(), name: String(f.name || ''), role: String(f.role), password: String(f.password || '') }); return back(c, '/admin/users', `已创建账号 ${u.username}`); } catch (e) { return back(c, '/admin/users', e.message, true); }
  });
  app.get('/admin/users/:id', (c) => {
    const u = getStaff(Number(c.req.param('id')));
    if (!u) return c.text('not found', 404);
    return c.html(shell('编辑账号', `${flash(c)}<p><a href="/admin/users">← 账号列表</a></p><h2>${esc(u.username)}</h2><form method="post" action="/admin/users/${u.id}" style="display:grid;gap:8px;max-width:420px">
<label>姓名 <input name="name" value="${esc(u.name)}"></label><label>角色 <select name="role">${roleOpts(u.role)}</select></label><label><input type="checkbox" name="active" value="1"${u.active ? ' checked' : ''}> 启用</label>
<label>重置密码（留空不改）<input name="password" type="password"></label><button>保存</button></form>`));
  });
  app.post('/admin/users/:id', async (c) => {
    const f = await c.req.parseBody();
    const id = Number(c.req.param('id'));
    try { saveStaff({ id, name: String(f.name || ''), role: String(f.role), active: f.active === '1', password: String(f.password || '') || null }); return back(c, `/admin/users/${id}`, '已保存'); } catch (e) { return back(c, `/admin/users/${id}`, e.message, true); }
  });
  app.get('/admin/me', (c) => c.html(shell('修改密码', `${flash(c)}<h2>修改我的密码</h2><form method="post" action="/admin/me" style="display:grid;gap:8px;max-width:360px"><input name="old" type="password" placeholder="当前密码" required><input name="password" type="password" placeholder="新密码（≥10 位，含字母和数字）" required><button>保存</button></form>`)));
  app.post('/admin/me', async (c) => {
    const f = await c.req.parseBody();
    const me = currentUser();
    if (me.username === config.adminUser) return back(c, '/admin/me', '初始管理员的密码由服务器环境变量 ADMIN_PASSWORD 管理', true);
    if (!verifyLogin(me.username, String(f.old || ''), 'self:' + me.id).user) return back(c, '/admin/me', '当前密码不正确', true);
    const p = passwordProblem(String(f.password || ''));
    if (p) return back(c, '/admin/me', p, true);
    saveStaff({ ...getStaff(me.id), password: String(f.password), active: true });
    return c.redirect('/admin/login');
  });
}
