// Login page, 403 page, staff accounts (admin only) and "change my password".
import { config } from './config.js';
import { shell, esc, fmt } from './admin.js';
import { PERMISSIONS, allRoles, roleNames, permsOf, can, saveRole, deleteRole, listStaff, getStaff, saveStaff, currentUser, verifyLogin, passwordProblem } from './auth.js';

const page = (title, body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7f9;font:15px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1d2733}
form,.box{background:#fff;border:1px solid #e2e6ea;border-radius:12px;padding:28px;width:min(360px,calc(100vw - 32px));display:grid;gap:14px}
h1{font-size:20px;margin:0}label{display:grid;gap:6px;font-size:14px}input{font:inherit;padding:10px 12px;border:1px solid #cfd6dc;border-radius:8px}
button{font:600 15px/1 inherit;padding:12px;border:0;border-radius:8px;background:#1d2733;color:#fff;cursor:pointer}.err{background:#fdecea;border:1px solid #f5b7b1;padding:10px 12px;border-radius:8px;font-size:14px}.mute{color:#66717d;font-size:13px}</style></head><body>${body}</body></html>`;

export function loginPage({ next = '/admin', error = '', username = '' } = {}) {
  return page('登录', `<form method="post" action="/admin/login"><h1>${esc(config.profile.brand)} 后台登录</h1>${error ? `<div class="err">${esc(error)}</div>` : ''}
<input type="hidden" name="next" value="${esc(next)}"><label>用户名<input name="username" value="${esc(username)}" autocomplete="username" required autofocus></label>
<label>密码<input name="password" type="password" autocomplete="current-password" required></label><button>登录</button><p class="mute">连续输错 5 次将锁定 15 分钟。</p></form>
<p style="text-align:center">${[['zh', '中文'], ['en', 'English']].map(([k, l]) => `<form method="post" action="/admin/lang" style="display:inline"><input type="hidden" name="lang" value="${k}"><button style="background:none;border:0;color:#1565c0;cursor:pointer;width:auto;padding:4px 8px">${l}</button></form>`).join(' | ')}</p>`);
}

export function forbiddenPage(user) {
  return page('无权限', `<div class="box"><h1>没有权限</h1><p>当前账号 ${esc(user.username)}（${esc(roleNames(user.role))}）不能访问这个页面或执行这个操作。如需开通请联系管理员。</p><p><a href="/admin/ops">返回后台</a></p></div>`);
}

// Roles as checkboxes: one person may hold several roles (permissions are combined).
const roleBoxes = (v = '') => { const on = new Set(String(v).split(',')); return `<fieldset style="border:1px solid #e2e6ea;border-radius:8px;padding:8px 12px"><legend>角色（可多选）</legend>${Object.entries(allRoles()).map(([k, r]) => `<label style="display:inline-flex;gap:4px;margin:2px 12px 2px 0"><input type="checkbox" name="role" value="${k}"${on.has(k) ? ' checked' : ''}> ${esc(r.zh)}</label>`).join('')}</fieldset>`; };
/** Non-admins may only hand out permissions they hold themselves (no self-promotion to admin). */
function assertCanGrant(roleKeys) {
  const me = currentUser();
  if (can(me, ['admin'])) return;
  const mine = new Set(permsOf(me));
  for (const k of [].concat(roleKeys)) { const r = allRoles()[k]; if (!r || r.perms.some((p) => !mine.has(p))) throw new Error(`不能授予超出自己权限的岗位：${r?.zh || k}`); }
}
const permList = (perms) => (perms.includes('*') ? '全部功能' : perms.map((p) => PERMISSIONS[p]?.[0] || p).join('、'));
const back = (c, path, msg, err = false) => c.redirect(`${path}?${err ? 'e' : 'm'}=${encodeURIComponent(msg)}`);
const flash = (c) => `${c.req.query('m') ? `<div class="warn" style="background:#e8f5e9;border-color:#a5d6a7">${esc(c.req.query('m'))}</div>` : ''}${c.req.query('e') ? `<div class="warn" style="background:#fdecea;border-color:#f5b7b1">${esc(c.req.query('e'))}</div>` : ''}`;

export function mountStaffAdmin(app) {
  app.get('/admin/users', (c) => {
    const rows = listStaff().map((u) => `<tr><td><b>${esc(u.username)}</b></td><td>${esc(u.name)}</td><td>${esc(roleNames(u.role))}</td><td>${u.active ? '启用' : '<span class="mute">已停用</span>'}</td><td>${fmt(u.last_login_at)}</td><td><a href="/admin/users/${u.id}">编辑</a></td></tr>`).join('');
    const perms = Object.entries(allRoles()).map(([, r]) => `<li><b>${esc(r.zh)}</b>${r.custom ? '（自定义）' : ''}：${esc(permList(r.perms))}</li>`).join('');
    return c.html(shell('账号权限', `${flash(c)}<h2>账号与权限</h2><div class="wrap"><table><thead><tr><th>用户名</th><th>姓名</th><th>角色</th><th>状态</th><th>最近登录</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
<h3>新增账号</h3><form method="post" action="/admin/users/new" style="display:grid;gap:8px;max-width:420px"><input name="username" placeholder="用户名（小写字母/数字）" required><input name="name" placeholder="姓名">${roleBoxes('sales')}<input name="password" type="password" placeholder="初始密码（≥10 位，含字母和数字）" required><button>创建</button></form>
<h3>角色说明</h3><p><a href="/admin/roles">管理岗位（新建岗位、勾选功能权限）</a></p><ul>${perms}</ul>`));
  });
  app.post('/admin/users/new', async (c) => {
    const f = await c.req.parseBody({ all: true });
    const one = (k) => String([].concat(f[k] ?? '')[0] ?? '');
    try { assertCanGrant([].concat(f.role || [])); const u = saveStaff({ username: one('username').trim().toLowerCase(), name: one('name'), role: [].concat(f.role || []), password: one('password') }); return back(c, '/admin/users', `已创建账号 ${u.username}`); } catch (e) { return back(c, '/admin/users', e.message, true); }
  });
  app.get('/admin/users/:id', (c) => {
    const u = getStaff(Number(c.req.param('id')));
    if (!u) return c.text('not found', 404);
    return c.html(shell('编辑账号', `${flash(c)}<p><a href="/admin/users">← 账号列表</a></p><h2>${esc(u.username)}</h2><form method="post" action="/admin/users/${u.id}" style="display:grid;gap:8px;max-width:420px">
<label>姓名 <input name="name" value="${esc(u.name)}"></label>${roleBoxes(u.role)}<label><input type="checkbox" name="active" value="1"${u.active ? ' checked' : ''}> 启用</label>
<label>重置密码（留空不改）<input name="password" type="password"></label><button>保存</button></form>`));
  });
  app.post('/admin/users/:id', async (c) => {
    const f = await c.req.parseBody({ all: true });
    const one = (k) => String([].concat(f[k] ?? '')[0] ?? '');
    const id = Number(c.req.param('id'));
    try {
      const cur = getStaff(id);
      if (cur) assertCanGrant(String(cur.role).split(',')); // cannot edit someone with more rights than you
      assertCanGrant([].concat(f.role || []));
      saveStaff({ id, name: one('name'), role: [].concat(f.role || []), active: one('active') === '1', password: one('password') || null });
      return back(c, `/admin/users/${id}`, '已保存');
    } catch (e) { return back(c, `/admin/users/${id}`, e.message, true); }
  });
  app.get('/admin/roles', (c) => {
    const roles = allRoles();
    const edit = roles[c.req.query('edit')]?.custom ? { key: c.req.query('edit'), ...roles[c.req.query('edit')] } : null;
    const copy = roles[c.req.query('copy')];
    const on = new Set(edit?.perms || copy?.perms || []);
    const groups = {};
    for (const [k, [label, g]] of Object.entries(PERMISSIONS)) (groups[g] ||= []).push([k, label]);
    const rows = Object.entries(roles).map(([k, r]) => `<tr><td><b>${esc(r.zh)}</b><div class="mute">${esc(k)}</div></td><td>${r.custom ? '自定义' : '内置'}</td><td style="max-width:640px">${esc(permList(r.perms))}</td><td>${r.custom ? `<a href="/admin/roles?edit=${encodeURIComponent(k)}">编辑</a> <form method="post" action="/admin/roles/${encodeURIComponent(k)}/delete" style="display:inline" onsubmit="return confirm('删除岗位？')"><button>删除</button></form>` : r.perms.includes('*') ? '' : `<a href="/admin/roles?copy=${encodeURIComponent(k)}">复制为新岗位</a>`}</td></tr>`).join('');
    return c.html(shell('岗位', `${flash(c)}<p><a href="/admin/users">← 账号权限</a></p><h2>岗位与权限</h2>
<p class="mute">内置岗位随系统更新；需要不同的权限组合时新建岗位（可从内置岗位复制后增减），再在账号里勾选。一个人可以有多个岗位，权限合并。"只看"表示只能查看不能修改；导出、删除需要单独勾选。</p>
<div class="wrap"><table><thead><tr><th>岗位</th><th>类型</th><th>权限</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
<h3>${edit ? `编辑岗位：${esc(edit.zh)}` : '新建岗位'}</h3><form method="post" action="/admin/roles" style="display:grid;gap:10px;max-width:900px">
<label>岗位编码 <input name="key" value="${esc(edit?.key || '')}" ${edit ? 'readonly' : 'required'} placeholder="sales_lead"></label><label>岗位名称 <input name="name" value="${esc(edit?.zh || (copy ? `${copy.zh}（自定义）` : ''))}" required></label>
${Object.entries(groups).map(([g, list]) => `<fieldset style="border:1px solid #e2e6ea;border-radius:8px;padding:8px 12px"><legend>${esc(g)}</legend>${list.map(([k, l]) => `<label style="display:inline-flex;gap:4px;margin:2px 14px 2px 0"><input type="checkbox" name="perms" value="${k}"${on.has(k) ? ' checked' : ''}> ${esc(l)}</label>`).join('')}</fieldset>`).join('')}
<div><button>保存岗位</button></div></form>`));
  });
  app.post('/admin/roles', async (c) => {
    const f = await c.req.parseBody({ all: true });
    const perms = [].concat(f.perms || []).map(String);
    try {
      const me = currentUser();
      if (!can(me, ['admin'])) { const mine = new Set(permsOf(me)); const extra = perms.filter((p) => !mine.has(p)); if (extra.length) throw new Error(`不能授予超出自己权限的功能：${extra.map((p) => PERMISSIONS[p]?.[0] || p).join('、')}`); }
      const k = saveRole({ key: String([].concat(f.key)[0] || ''), name: String([].concat(f.name)[0] || ''), perms }, me.username);
      return back(c, '/admin/roles', `已保存岗位 ${k}`);
    } catch (e) { return back(c, '/admin/roles', e.message, true); }
  });
  app.post('/admin/roles/:key/delete', (c) => { try { deleteRole(c.req.param('key')); return back(c, '/admin/roles', '已删除岗位'); } catch (e) { return back(c, '/admin/roles', e.message, true); } });
  app.get('/admin/me', (c) => c.html(shell('修改密码', `${flash(c)}<h2>界面语言</h2><form method="post" action="/admin/lang" class="acts" style="display:flex;gap:8px;margin-bottom:18px"><select name="lang" aria-label="界面语言">${[['zh', '中文'], ['en', 'English']].map(([k, l]) => `<option value="${k}"${currentUser()?.lang === k ? ' selected' : ''}>${l}</option>`).join('')}</select><button>保存</button><span class="mute">每个账号单独设置，下次登录自动使用</span></form><h2>修改我的密码</h2><form method="post" action="/admin/me" style="display:grid;gap:8px;max-width:360px"><input name="old" type="password" placeholder="当前密码" required><input name="password" type="password" placeholder="新密码（≥10 位，含字母和数字）" required><button>保存</button></form>`)));
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
