// 后台：系统状态与数据库备份（仅管理员）
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { shell, esc, fmt } from '../admin.js';
import { config, aiEnabled } from '../config.js';
import { recentRuns } from '../content/store.js';
import { erpLog, erpLabel } from './erp/index.js';
import * as B from './backup.js';
import { defaultAdminLang } from '../auth.js';
import { setSetting } from '../catalog/store.js';

const mb = (n) => `${(Number(n || 0) / 1048576).toFixed(1)} MB`;
const dur = (s) => `${Math.floor(s / 86400)} 天 ${Math.floor((s % 86400) / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
const flash = (c) => `${c.req.query('m') ? `<div class="warn" style="background:#e8f5e9;border-color:#a5d6a7">${esc(c.req.query('m'))}</div>` : ''}${c.req.query('e') ? `<div class="warn" style="background:#fdecea;border-color:#f5b7b1">${esc(c.req.query('e'))}</div>` : ''}`;

function page(c) {
  const s = B.systemStatus();
  const bc = B.backupConfig();
  const backups = B.listBackups();
  const runs = B.backupRuns(10);
  const last = runs[0];
  const stale = !last || !last.ok || Date.now() - new Date(last.ts).getTime() > 36 * 3600e3;
  const tile = (l, v) => `<div class="tile"><span>${l}</span><strong style="font-size:17px">${v}</strong></div>`;
  return shell('系统', `${flash(c)}<h2>系统状态</h2>
${stale ? '<div class="warn">最近 36 小时没有成功的数据库备份，请检查。</div>' : ''}
${s.disk && s.disk.free < 2 * 1073741824 ? `<div class="warn">磁盘剩余空间不足 2 GB（剩余 ${mb(s.disk.free)}）。</div>` : ''}
<div class="tiles">${tile('版本', esc(s.version))}${tile('站点', esc(config.site))}${tile('运行时间', dur(s.uptimeSec))}${tile('内存', `${s.rssMb} MB`)}${tile('数据库', `${mb(s.db.bytes)}（WAL ${mb(s.db.wal)}）`)}${s.disk ? tile('磁盘剩余', `${mb(s.disk.free)} / ${mb(s.disk.total)}`) : ''}
${tile('大模型', aiEnabled() ? esc(`${config.llm.provider} / ${config.llm.model}`) : '规则模式')}${tile('ERP', esc(erpLabel()))}${tile('Node', esc(s.node))}</div>
<h3>默认后台语言</h3><form method="post" action="/admin/system/lang" class="acts" style="display:flex;gap:8px"><select name="lang" aria-label="默认后台语言">${[['zh', '中文'], ['en', 'English']].map(([k, l]) => `<option value="${k}"${defaultAdminLang() === k ? ' selected' : ''}>${l}</option>`).join('')}</select><button>保存</button><span class="mute">没有自己设置语言的账号使用这里的默认值</span></form>
<h3>数据库备份</h3>
<p class="mute">每天 ${bc.hour}:00 自动备份（在线快照，不影响网站访问），压缩后做恢复校验（PRAGMA integrity_check），保留最近 ${bc.keep} 份。备份目录：<code>${esc(bc.dir)}</code>。
${bc.cmd ? `异地复制命令：<code>${esc(bc.cmd)}</code>` : '<b>尚未配置异地复制（BACKUP_CMD）</b>——备份和数据库在同一块磁盘上，服务器损坏时会一起丢失。'}${bc.enabled ? '' : ' <b>自动备份已关闭（BACKUP_ENABLED=false）。</b>'}</p>
<form method="post" action="/admin/system/backup"><button>立即备份</button></form>
<div class="wrap" style="margin-top:10px"><table><thead><tr><th>备份文件</th><th>大小</th><th>时间</th><th></th></tr></thead><tbody>
${backups.map((b) => `<tr><td>${esc(b.file)}</td><td>${mb(b.bytes)}</td><td>${fmt(b.ts)}</td><td><a href="/admin/system/backups/${encodeURIComponent(b.file)}">下载</a></td></tr>`).join('') || '<tr><td colspan="4" class="mute">还没有备份</td></tr>'}</tbody></table></div>
<h3>备份记录</h3><div class="wrap"><table><thead><tr><th>时间</th><th>文件</th><th>结果</th><th>校验</th><th>用时</th></tr></thead><tbody>
${runs.map((r) => { const d = JSON.parse(r.detail || '{}'); return `<tr><td>${fmt(r.ts)}</td><td>${esc(r.file)}</td><td>${r.ok ? '成功' : `<b style="color:#c62828">失败</b> ${esc(d.error || d.offsite?.out || '')}`}</td><td>${d.verify ? `${esc(d.verify.integrity)} · 商品 ${d.verify.tables.products ?? '—'} · 订单 ${d.verify.tables.orders ?? '—'} · 客户 ${d.verify.tables.customers ?? '—'}${d.offsite ? ` · 异地 ${d.offsite.ok ? '成功' : '失败'}` : ''}` : ''}</td><td>${r.seconds.toFixed(1)}s</td></tr>`; }).join('') || '<tr><td colspan="5" class="mute">暂无</td></tr>'}</tbody></table></div>
<h3>后台任务（最近）</h3><div class="wrap"><table><thead><tr><th>时间</th><th>任务</th><th>结果</th><th>详情</th></tr></thead><tbody>
${[...recentRuns(15).map((r) => ({ ts: r.ts, kind: { build: '网站构建', article: '内容智能体', indexnow: 'IndexNow', geo: 'GEO 监测' }[r.kind] || r.kind, ok: r.status !== 'error', detail: r.detail })), ...erpLog(10).map((r) => ({ ts: r.ts, kind: `金蝶 ${r.action}`, ok: Boolean(r.ok), detail: r.detail }))]
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, 20).map((r) => `<tr><td>${fmt(r.ts)}</td><td>${esc(r.kind)}</td><td>${r.ok ? '成功' : '<b style="color:#c62828">失败</b>'}</td><td class="mute" style="max-width:520px">${esc(String(r.detail || '').slice(0, 200))}</td></tr>`).join('') || '<tr><td colspan="4" class="mute">暂无</td></tr>'}</tbody></table></div>
<h3>数据库版本（已执行的迁移）</h3><p class="mute">${s.migrations.map((m) => esc(m.id)).join(' · ')}</p>`);
}

export function mountSystemAdmin(app) {
  app.get('/admin/system', (c) => c.html(page(c)));
  app.post('/admin/system/lang', async (c) => {
    const f = await c.req.parseBody();
    if (!['zh', 'en'].includes(f.lang)) return c.redirect('/admin/system?e=' + encodeURIComponent('语言无效'));
    setSetting('admin_lang', f.lang);
    return c.redirect('/admin/system?m=' + encodeURIComponent('默认后台语言已保存'));
  });
  app.post('/admin/system/backup', async (c) => {
    const r = await B.backupNow();
    return c.redirect(`/admin/system?${r.ok ? `m=${encodeURIComponent(`备份完成：${r.file}（${mb(r.bytes)}），恢复校验通过`)}` : `e=${encodeURIComponent(`备份失败：${r.error || r.offsite?.out || ''}`)}`}`);
  });
  app.get('/admin/system/backups/:file', (c) => {
    const f = B.backupPath(c.req.param('file'));
    if (!f || !B.listBackups().some((b) => b.file === c.req.param('file'))) return c.text('Not found', 404);
    c.header('content-type', 'application/gzip');
    c.header('content-disposition', `attachment; filename="${c.req.param('file')}"`);
    return c.body(Readable.toWeb(createReadStream(f)));
  });
}
