// Builds test-results/demo/index.html: every recorded video (demo page tour, feature walkthroughs, browser E2E flows)
// with its test name, result and duration, grouped by section, plus the video files next to it.
// Usage: node scripts/demo-index.mjs test-results/demo-report.json [test-results/e2e-report.json]
import { readFileSync, existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'test-results/demo';
mkdirSync(join(OUT, 'videos'), { recursive: true });
const SECTIONS = [[/^FT-/, '功能演示（按岗位）'], [/^PG-ADMIN/, '后台页面'], [/^PG-SHOP/, '网店与客户中心'], [/^PG-LED/, '网站页面 · YAORONG LED'], [/^PG-GRID/, '网站页面 · YR GRID'], [/^E2E-/, '端到端测试流程']];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const items = [];
let n = 0;
for (const file of process.argv.slice(2)) {
  if (!existsSync(file)) { console.warn(`skip ${file} (missing)`); continue; }
  const walk = (suite, trail = []) => {
    for (const s of suite.suites || []) walk(s, [...trail, s.title]);
    for (const spec of suite.specs || []) for (const t of spec.tests || []) {
      const r = t.results?.at(-1);
      if (!r) continue;
      const videos = (r.attachments || []).filter((a) => a.name === 'video' && a.path && existsSync(a.path));
      const files = videos.map((v, i) => { const name = `${String(++n).padStart(4, '0')}${i ? `-${i}` : ''}.webm`; copyFileSync(v.path, join(OUT, 'videos', name)); return `videos/${name}`; });
      items.push({ title: spec.title, project: t.projectName, status: r.status, ms: r.duration, files, error: r.error?.message?.split('\n')[0] || '' });
    }
  };
  walk(JSON.parse(readFileSync(file, 'utf8')));
}
const section = (t) => (SECTIONS.find(([re]) => re.test(t)) || [null, '其他'])[1];
const groups = new Map();
for (const it of items) { const k = section(it.title); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); }
const order = [...SECTIONS.map(([, l]) => l), '其他'].filter((l) => groups.has(l));
const total = items.length, failed = items.filter((i) => !['passed', 'skipped'].includes(i.status)).length, withVideo = items.filter((i) => i.files.length).length;
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>测试演示视频</title>
<style>body{font:15px/1.5 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;background:#f5f7f9;color:#1b2430}header{background:#0f172a;color:#fff;padding:18px 24px}main{max-width:1280px;margin:auto;padding:16px 24px}
nav a{margin-right:14px}h2{margin:28px 0 10px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:14px}.card{background:#fff;border:1px solid #e2e6ea;border-radius:10px;padding:10px 12px}
.card video{width:100%;border-radius:6px;background:#000}.ok{color:#2e7d32}.bad{color:#c62828}.skip{color:#8a96a3}.mute{color:#66717d;font-size:13px}input{padding:6px 10px;width:320px;max-width:100%}</style></head><body>
<header><b style="font-size:20px">测试演示视频</b><div class="mute" style="color:#cbd5e1">共 ${total} 个用例，${withVideo} 个有录像，${failed} 个失败 · 生成于 ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</div></header>
<main><p><input type="search" placeholder="搜索用例或页面…" oninput="for(const c of document.querySelectorAll('.card'))c.hidden=!c.dataset.t.toLowerCase().includes(this.value.toLowerCase())"></p>
<nav>${order.map((g) => `<a href="#${encodeURIComponent(g)}">${esc(g)}（${groups.get(g).length}）</a>`).join('')}</nav>
${order.map((g) => `<h2 id="${encodeURIComponent(g)}">${esc(g)}</h2><div class="grid">${groups.get(g).map((it) => `<div class="card" data-t="${esc(it.title)}"><b>${esc(it.title)}</b>
<div class="mute"><span class="${it.status === 'passed' ? 'ok' : it.status === 'skipped' ? 'skip' : 'bad'}">${esc({ passed: '通过', failed: '失败', timedOut: '超时', skipped: '跳过', interrupted: '中断' }[it.status] || it.status)}</span> · ${(it.ms / 1000).toFixed(1)} s${it.project ? ` · ${esc(it.project)}` : ''}</div>
${it.error ? `<div class="bad mute">${esc(it.error.slice(0, 200))}</div>` : ''}${it.files.map((f) => `<video controls preload="none" src="${f}"></video>`).join('')}</div>`).join('')}</div>`).join('')}
</main></body></html>`;
writeFileSync(join(OUT, 'index.html'), html);
console.log(`demo index: ${total} tests, ${withVideo} with video, ${failed} failed → ${OUT}/index.html`);
