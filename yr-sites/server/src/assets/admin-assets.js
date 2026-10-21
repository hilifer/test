// 后台：素材仓库（美工）。目录树、拖拽 / 批量 / 整文件夹上传、筛选检索、以图搜图、卡片 / 列表视图、批量打标签 / 移动 / 打包下载 / 删除、
// 素材详情（缩放平移预览、视频播放与截帧、版本对比 / 回滚 / 设为正式版）、回收站、容量与设置。
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { bodyLimit } from 'hono/body-limit';
import { shell, esc, fmt } from '../admin.js';
import { currentUser, can } from '../auth.js';
import { config } from '../config.js';
import { setSetting } from '../catalog/store.js';
import * as A from './store.js';
import * as P from './publish.js';
import { pull, pullLogs, REASONS } from './pull.js';
import * as X from './process.js';
import * as C from '../catalog/store.js';

const MAX_UPLOAD_MB = Number(process.env.ASSET_UPLOAD_MAX_MB || 600);
const limit = bodyLimit({ maxSize: MAX_UPLOAD_MB * 1048576, onError: (c) => c.text(`上传内容过大（单次最多 ${MAX_UPLOAD_MB} MB）`, 413) });
const mb = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : `${(n / 1048576).toFixed(1)} MB`);
const flash = (c) => `${c.req.query('m') ? `<div class="warn" style="background:#e8f5e9;border-color:#a5d6a7">${esc(c.req.query('m'))}</div>` : ''}${c.req.query('e') ? `<div class="warn" style="background:#fdecea;border-color:#f5b7b1">${esc(c.req.query('e'))}</div>` : ''}`;
const back = (c, path, k, v) => c.redirect(`${path}${path.includes('?') ? '&' : '?'}${k}=${encodeURIComponent(v)}`);
const fromForm = (f, k) => String([].concat(f[k] ?? '')[0] ?? '');
const CSS = `<style>
.as-wrap{display:grid;grid-template-columns:240px 1fr;gap:16px}@media(max-width:800px){.as-wrap{grid-template-columns:1fr}}
.tree{background:#fff;border:1px solid var(--line);border-radius:8px;padding:10px;font-size:13px;align-self:start;max-height:80vh;overflow:auto}.tree ul{list-style:none;margin:0;padding-left:14px}.tree>ul{padding-left:0}.tree a{text-decoration:none;color:var(--ink)}.tree a.on{font-weight:700;color:#1565c0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px}.card{background:#fff;border:1px solid var(--line);border-radius:8px;overflow:hidden;position:relative;font-size:12px}
.card .th{display:block;aspect-ratio:1;background:#eef1f4 center/contain no-repeat}.card .meta{padding:6px 8px}.card .meta b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12.5px}
.card input[type=checkbox]{position:absolute;top:6px;left:6px;width:18px;height:18px}.card .ver{position:absolute;top:6px;right:6px;background:#1d2733;color:#fff;border-radius:4px;padding:0 5px}
.tag{display:inline-block;background:#eceff1;border-radius:9px;padding:0 6px;margin:1px;font-size:11px}.tag.ai{background:#e3f2fd}
.drop{border:2px dashed #b0bec5;border-radius:10px;padding:14px;text-align:center;background:#fafbfc;margin-bottom:12px}.drop.over{border-color:#1565c0;background:#e3f2fd}
.bar{position:sticky;top:0;z-index:3;background:var(--bg);padding:6px 0;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.stage{background:#263238;border-radius:8px;height:62vh;overflow:hidden;position:relative;cursor:grab}.stage img{position:absolute;left:50%;top:50%;max-width:none;transform-origin:center;user-select:none}
.cmp{display:grid;grid-template-columns:1fr 1fr;gap:10px}.cmp img{width:100%;background:#eef1f4;border:1px solid var(--line);border-radius:8px}
.fl2{display:grid;gap:4px;font-size:13px}.fl2 input,.fl2 select{padding:6px 8px;border:1px solid #cfd6dc;border-radius:6px}
</style>`;
const sub = `<p class="acts"><a href="/admin/assets">素材仓库</a> · <a href="/admin/assets/pull">链接拉取</a> · <a href="/admin/assets/watermarks">水印</a> · <a href="/admin/assets/similar">以图搜图</a> · <a href="/admin/assets/trash">回收站</a> · <a href="/admin/assets/settings">容量与设置</a> · <a href="/admin/tasks">任务中心</a></p>`;
const view = (title, body) => shell(title, CSS + sub + body);

function tree(active) {
  const node = (f) => { const kids = A.childFolders(f.id); return `<li><a href="/admin/assets?folder=${f.id}" class="${f.id === active ? 'on' : ''}">📁 ${esc(f.name)}</a>${kids.length ? `<ul>${kids.map(node).join('')}</ul>` : ''}</li>`; };
  return `<nav class="tree" aria-label="文件夹"><ul><li><a href="/admin/assets" class="${active ? '' : 'on'}">全部素材</a></li>${A.childFolders(null).map(node).join('')}</ul></nav>`;
}
const allFolders = () => { const out = []; const walk = (pid, depth) => { for (const f of A.childFolders(pid)) { out.push([f.id, `${'　'.repeat(depth)}${f.name}`]); walk(f.id, depth + 1); } }; walk(null, 0); return out; };
const tags = (a) => [...a.tags.map((t) => `<span class="tag">${esc(t)}</span>`), ...a.auto_tags.map((t) => `<span class="tag ${t.startsWith('AI:') ? 'ai' : ''}">${esc(t)}</span>`)].join('');
const thumb = (a) => (A.thumbFile(a.id) ? `/admin/assets/thumb/${a.id}?v=${a.official}` : '');
const kindIcon = { image: '🖼', video: '🎬', source: '🎨' };

function listPage(c) {
  const f = { productId: c.req.query('product') || '', folderId: c.req.query('folder') || '', q: c.req.query('q') || '', kind: c.req.query('kind') || '', tag: c.req.query('tag') || '', ext: c.req.query('ext') || '', uploader: c.req.query('uploader') || '', from: c.req.query('from') || '', to: c.req.query('to') || '', minWidth: c.req.query('minw') || '', sort: c.req.query('sort') || 'new' };
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const { total, rows } = A.search({ ...f, limit: 120, offset: (page - 1) * 120 });
  const mode = c.req.query('view') === 'list' ? 'list' : 'grid';
  const folder = f.folderId ? A.getFolder(f.folderId) : null;
  const crumbs = folder ? A.folderPath(folder.id).map((x) => `<a href="/admin/assets?folder=${x.id}">${esc(x.name)}</a>`).join(' / ') : '全部素材';
  const opt = (list, v) => list.map(([k, l]) => `<option value="${esc(k)}"${k === v ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const qs = (o) => new URLSearchParams(Object.entries({ product: f.productId, folder: f.folderId, q: f.q, kind: f.kind, tag: f.tag, ext: f.ext, uploader: f.uploader, from: f.from, to: f.to, minw: f.minWidth, sort: f.sort, view: mode, ...o }).filter(([, v]) => v)).toString();
  const items = mode === 'grid'
    ? `<div class="grid">${rows.map((a) => `<div class="card"><input type="checkbox" name="ids" value="${a.id}" form="bulk" aria-label="选择 ${esc(a.original_name)}"><span class="ver">v${a.official}${a.version > a.official ? `/${a.version}` : ''}</span><a class="th" href="/admin/assets/${a.id}" style="background-image:url('${thumb(a)}')">${thumb(a) ? '' : `<span style="font-size:42px;display:grid;place-items:center;height:100%">${kindIcon[a.kind]}</span>`}</a><div class="meta"><b title="${esc(a.original_name)}">${esc(a.title || a.original_name)}</b>${a.width ? `${a.width}×${a.height} · ` : ''}${a.duration ? `${a.duration.toFixed(1)}s · ` : ''}${esc(a.ext.toUpperCase())} · ${mb(a.bytes)}<div>${tags(a)}</div></div></div>`).join('') || '<p class="mute">这里还没有素材，拖拽文件到上方区域上传。</p>'}</div>`
    : `<div class="wrap"><table><thead><tr><th></th><th></th><th>名称</th><th>类型</th><th>尺寸</th><th>大小</th><th>标签</th><th>产品</th><th>上传</th></tr></thead><tbody>${rows.map((a) => `<tr><td><input type="checkbox" name="ids" value="${a.id}" form="bulk"></td><td>${thumb(a) ? `<img src="${thumb(a)}" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:4px">` : kindIcon[a.kind]}</td><td><a href="/admin/assets/${a.id}">${esc(a.title || a.original_name)}</a> <span class="mute">v${a.official}</span></td><td>${A.KIND[a.kind]} ${esc(a.ext)}</td><td>${a.width ? `${a.width}×${a.height}` : ''}</td><td>${mb(a.bytes)}</td><td>${tags(a)}</td><td>${esc(a.product_id || '')}</td><td>${esc(a.created_by)}<div class="mute">${fmt(a.created_at)}</div></td></tr>`).join('') || '<tr><td colspan="9" class="mute">没有素材</td></tr>'}</tbody></table></div>`;
  return view('素材仓库', `${flash(c)}<h2>素材仓库 <span class="mute" style="font-size:14px">${crumbs} · ${total} 个</span></h2>
<div class="as-wrap">${tree(f.folderId)}<div>
<form method="post" action="/admin/assets/upload" enctype="multipart/form-data" class="drop" id="drop"><input type="hidden" name="folder" value="${esc(f.folderId)}">
<b>拖拽文件到这里上传</b>，或 <input type="file" name="files" multiple accept=".jpg,.jpeg,.png,.webp,.mp4,.mov,.psd,.ai" aria-label="选择文件"> 或整个文件夹 <input type="file" name="files" webkitdirectory multiple aria-label="选择文件夹">
${folder ? '' : `<label>上传到产品 <input name="product" placeholder="型号，如 YR-HB-U2" size="14"></label> <select name="sub">${A.SUBFOLDERS.map((s) => `<option>${s}</option>`).join('')}</select>`} <button>上传</button>
<div class="mute">图片 JPG/PNG/WebP ≤25 MB，视频 MP4/MOV ≤500 MB，源文件 PSD/AI ≤300 MB。上传后自动生成缩略图并识别白底图、透明图、长图等。</div><div id="upmsg"></div></form>
<form method="get" class="acts" style="display:flex;flex-wrap:wrap;gap:6px">${f.folderId ? `<input type="hidden" name="folder" value="${esc(f.folderId)}">` : ''}<input name="q" value="${esc(f.q)}" placeholder="名称 / 型号 / 标签"><select name="kind"><option value="">全部类型</option>${opt(Object.entries(A.KIND), f.kind)}</select>
<select name="tag"><option value="">全部标签</option>${opt(A.allTags().map((t) => [t, t]), f.tag)}</select><select name="ext"><option value="">全部格式</option>${opt(['jpg', 'png', 'webp', 'mp4', 'mov', 'psd', 'ai'].map((x) => [x, x.toUpperCase()]), f.ext)}</select>
<select name="uploader"><option value="">全部上传人</option>${opt(A.uploaders().map((u) => [u, u]), f.uploader)}</select><input name="minw" value="${esc(f.minWidth)}" placeholder="最小宽度 px" size="10"><input type="date" name="from" value="${esc(f.from)}" aria-label="上传日期从"><input type="date" name="to" value="${esc(f.to)}" aria-label="上传日期到">
<select name="sort">${opt([['new', '最新上传'], ['old', '最早上传'], ['name', '按名称'], ['size', '按大小']], f.sort)}</select><button>筛选</button> <a href="?${qs({ view: mode === 'grid' ? 'list' : 'grid' })}">${mode === 'grid' ? '列表视图' : '卡片视图'}</a></form>
<form method="post" action="/admin/assets/bulk" id="bulk" class="bar"><label><input type="checkbox" id="all"> 全选</label>
<input name="tags" placeholder="标签，逗号分隔" size="14"><button name="action" value="tag">打标签</button><button name="action" value="untag">去标签</button>
<select name="folder" aria-label="目标文件夹"><option value="">（未分类）</option>${opt(allFolders(), '')}</select><button name="action" value="move">移动</button>
<button name="action" value="zip" formaction="/admin/assets/bulk-download">打包下载</button><button name="action" value="trash" onclick="return confirm('移到回收站？')">删除</button>
<span style="border-left:1px solid var(--line);padding-left:8px">上架到商品 <input name="product" list="plist" placeholder="型号" size="12" value="${esc(f.productId || folder?.product_id || '')}"><datalist id="plist">${C.listProducts({ pageSize: 1000 }).rows.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</datalist>
<select name="position" aria-label="位置"><option value="main">主图</option><option value="gallery" selected>副图（追加）</option><option value="detail">详情图</option><option value="sku">SKU 图</option></select><input name="index" placeholder="主图第几张" size="8" aria-label="主图第几张"><input name="sku" placeholder="SKU（SKU 图）" size="12" aria-label="SKU"><label><input type="checkbox" name="publish" value="1"> 同时发布网站</label>
<button name="action" value="publish" formaction="/admin/assets/publish">上架</button></span>
<span style="border-left:1px solid var(--line);padding-left:8px">批量处理 <select name="op" aria-label="批量处理方式"><option value="white">白底</option><option value="resize">改尺寸（选预设）</option><option value="sizes">导出多尺寸（另存）</option><option value="extend">扩图 1:1</option><option value="colour">自动色阶</option><option value="repair">去噪锐化</option>${X.aiImageConfigured() ? '<option value="cutout">AI 抠图</option><option value="background">AI 换白底背景</option>' : ''}</select>
<select name="preset" aria-label="尺寸预设">${presetOpts()}</select><button name="action" value="batch" formaction="/admin/assets/batch">加入任务</button></span></form>
${items}
${total > 120 ? `<p>${Array.from({ length: Math.min(40, Math.ceil(total / 120)) }, (_, i) => `<a href="?${qs({ page: i + 1 })}" style="margin-right:8px">${i + 1}</a>`).join('')}</p>` : ''}
<details style="margin-top:16px"><summary>文件夹管理</summary><form method="post" action="/admin/assets/folders/new" class="acts"><input type="hidden" name="parent" value="${esc(f.folderId)}"><input name="name" placeholder="新文件夹名称" required><button>${folder ? '在此新建子文件夹' : '新建文件夹'}</button></form>
${folder ? `<form method="post" action="/admin/assets/folders/${folder.id}/rename" class="acts"><input name="name" value="${esc(folder.name)}" required><button>重命名</button></form><form method="post" action="/admin/assets/folders/${folder.id}/delete" class="acts" onsubmit="return confirm('删除空文件夹？')"><button>删除这个文件夹（须为空）</button></form>` : ''}</details>
</div></div>
<script>(()=>{const all=document.getElementById('all');all&&all.addEventListener('change',()=>document.querySelectorAll('input[name=ids]').forEach((x)=>x.checked=all.checked));
const d=document.getElementById('drop');const msg=document.getElementById('upmsg');
d.addEventListener('dragover',(e)=>{e.preventDefault();d.classList.add('over');});d.addEventListener('dragleave',()=>d.classList.remove('over'));
d.addEventListener('drop',async(e)=>{e.preventDefault();d.classList.remove('over');const fd=new FormData(d);fd.delete('files');for(const f of e.dataTransfer.files)fd.append('files',f,f.name);msg.textContent='上传中…';
const r=await fetch(d.action,{method:'POST',body:fd,headers:{'x-requested-with':'fetch'}});const j=await r.json().catch(()=>({}));msg.textContent=j.message||('HTTP '+r.status);if(r.ok)setTimeout(()=>location.reload(),600);});})();</script>`);
}

const presetOpts = () => X.presets().map((p) => `<option value="${esc(p.id)}">${esc(p.name)} ${p.width}×${p.height || '自适应'}</option>`).join('');
const imagePick = (name, label) => `<label class="fl2">${label}<select name="${name}"><option value="">（不使用）</option>${A.search({ kind: 'image', limit: 300 }).rows.map((x) => `<option value="${x.id}">${esc(x.title || x.original_name)}</option>`).join('')}</select></label>`;
/** Form fields → processAsset params (shared by single and batch processing). */
function processParams(f) {
  const v = (k) => fromForm(f, k).trim();
  const num = (k, d) => (v(k) === '' ? d : Number(v(k)));
  const mask = v('mask');
  return {
    preset: v('preset') || undefined, width: num('width', undefined), height: num('height', 0), mode: v('mode') || 'contain', background: (v('op') === 'background' ? v('bgColour') : v('background')) || '#ffffff',
    margin: num('margin', 0.06), ratio: v('ratio') || '1:1', fill: v('fill') === 'colour' ? (v('fillColour') || '#ffffff') : 'blur',
    brightness: num('brightness', 1), saturation: num('saturation', 1), contrast: num('contrast', 1), normalise: v('normalise') === '1', referenceId: v('referenceId') || undefined,
    denoise: num('denoise', 3), sharpen: v('sharpen') !== '0', upscale: v('upscale') === '1', backgroundId: v('backgroundId') || undefined, scale: num('scale', 0.8),
    mask: mask.startsWith('data:image/png;base64,') ? Buffer.from(mask.slice(22), 'base64') : undefined,
  };
}
function processPanel(a) {
  const ai = X.aiImageConfigured();
  return `<details class="fl2" style="margin-top:12px;background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px" id="proc"><summary><b>图片处理</b></summary>
<form method="post" action="/admin/assets/${a.id}/process" class="fl2" id="procform"><input type="hidden" name="mask" id="mask">
<label class="fl2">处理方式<select name="op" id="op">${Object.entries(X.OPS).map(([k, l]) => `<option value="${k}"${(k === 'cutout' || k === 'background') && !ai ? ' disabled' : ''}>${l}${(k === 'cutout' || k === 'background') && !ai ? '（未配置 AI 图片服务）' : ''}</option>`).join('')}</select></label>
<fieldset data-op="resize"><legend>改尺寸</legend><select name="preset"><option value="">自定义尺寸</option>${presetOpts()}</select> <input name="width" placeholder="宽" size="5"> × <input name="height" placeholder="高（0 = 按比例）" size="12">
<select name="mode"><option value="contain">完整显示（留白）</option><option value="cover">铺满（裁切）</option><option value="inside">按比例缩放</option></select></fieldset>
<fieldset data-op="white"><legend>白底</legend><label>边距 <input name="margin" value="0.06" size="4"></label> <label>底色 <input type="color" name="background" value="#ffffff"></label></fieldset>
<fieldset data-op="extend"><legend>扩图</legend><label>比例 <input name="ratio" value="1:1" size="5"></label> <select name="fill"><option value="blur">模糊延展原图</option><option value="colour">纯色填充</option></select> <input type="color" name="fillColour" value="#ffffff" aria-label="填充颜色"></fieldset>
<fieldset data-op="colour"><legend>调色</legend><label>亮度 <input name="brightness" value="1" size="4"></label> <label>饱和度 <input name="saturation" value="1" size="4"></label> <label>对比度 <input name="contrast" value="1" size="4"></label> <label><input type="checkbox" name="normalise" value="1"> 自动色阶</label>${imagePick('referenceId', '统一色调：参考图')}</fieldset>
<fieldset data-op="repair"><legend>修复</legend><label>去噪强度（0–9） <input name="denoise" value="3" size="3"></label> <label><input type="checkbox" name="sharpen" value="0"> 不锐化</label> <label><input type="checkbox" name="upscale" value="1"> 放大 2 倍（低清图）</label></fieldset>
<fieldset data-op="retouch"><legend>局部修图</legend><span class="mute">在左侧图片上用鼠标涂抹要去掉的污点、划痕或杂物，再点"开始处理"。</span> <button type="button" id="clearmask">清除涂抹</button> <label>画笔 <input type="range" id="brush" min="4" max="80" value="24"></label></fieldset>
<fieldset data-op="background"><legend>AI 换背景</legend><label>背景色 <input type="color" name="bgColour" value="#ffffff"></label> ${imagePick('backgroundId', '或场景图')} <label>商品占比 <input name="scale" value="0.8" size="4"></label></fieldset>
<label class="fl2">提示词 / 说明（记录在版本里，便于复用）<input name="prompt" placeholder="如：白底、居中、留白 6%"></label>
<label><input type="radio" name="saveAs" value="version" checked> 保存为新版本（可回滚）</label> <label><input type="radio" name="saveAs" value="new"> 另存为新素材</label>
<button>开始处理</button></form>
<form method="post" action="/admin/assets/${a.id}/sizes" class="fl2" style="margin-top:10px"><b>一键导出多尺寸</b><div>${X.presets().map((p) => `<label style="margin-right:10px"><input type="checkbox" name="presets" value="${esc(p.id)}"> ${esc(p.name)} ${p.width}×${p.height || '自适应'}</label>`).join('')}</div><button>导出为新素材</button> <a href="/admin/assets/settings#presets">管理尺寸预设</a></form></details>`;
}
const PROCESS_JS = `<script>(()=>{const op=document.getElementById('op');if(!op)return;const sync=()=>document.querySelectorAll('#procform fieldset[data-op]').forEach((f)=>f.hidden=f.dataset.op!==op.value);op.onchange=()=>{sync();paint(op.value==='retouch');};sync();
const st=document.getElementById('stage'),im=document.getElementById('img');let cv,ctx,on=false;
function paint(yes){if(!st||!im)return;if(yes&&!cv){cv=document.createElement('canvas');cv.width=im.naturalWidth;cv.height=im.naturalHeight;cv.style.cssText='position:absolute;left:50%;top:50%;transform:'+im.style.transform+';transform-origin:center;opacity:.45;cursor:crosshair';st.appendChild(cv);ctx=cv.getContext('2d');new MutationObserver(()=>cv.style.transform=im.style.transform).observe(im,{attributes:true,attributeFilter:['style']});ctx.fillStyle='#000';ctx.fillRect(0,0,cv.width,cv.height);
const at=(e)=>{const r=cv.getBoundingClientRect();return[(e.clientX-r.left)*cv.width/r.width,(e.clientY-r.top)*cv.height/r.height];};
cv.addEventListener('mousedown',(e)=>{e.stopPropagation();on=true;dot(e);});cv.addEventListener('mousemove',(e)=>{e.stopPropagation();if(on)dot(e);});addEventListener('mouseup',()=>on=false);
function dot(e){const[x,y]=at(e);const b=Number(document.getElementById('brush').value)*cv.width/cv.getBoundingClientRect().width;ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(x,y,b/2,0,7);ctx.fill();}}
if(cv)cv.hidden=!yes;}
document.getElementById('clearmask').onclick=()=>{if(ctx){ctx.fillStyle='#000';ctx.fillRect(0,0,cv.width,cv.height);}};
document.getElementById('procform').addEventListener('submit',()=>{if(op.value==='retouch'&&cv)document.getElementById('mask').value=cv.toDataURL('image/png');});})();</script>`;

function detailPage(c) {
  const a = A.getAsset(c.req.param('id'));
  if (!a) return view('未找到', '<p>素材不存在</p>');
  const vs = A.versionsOf(a.id);
  const dl = can(currentUser(), ['assets.download']);
  const prev = A.previewFile(a.id);
  const stage = a.kind === 'image'
    ? `<div class="stage" id="stage"><img id="img" src="/admin/assets/preview/${a.id}?v=${a.official}" alt="${esc(a.original_name)}" draggable="false"></div><p class="mute">滚轮缩放，拖动平移，双击复位。</p>`
    : a.kind === 'video'
      ? (prev ? `<video id="vid" src="/admin/assets/preview/${a.id}" controls preload="metadata" style="width:100%;max-height:62vh;background:#000;border-radius:8px"></video><p><button type="button" id="cap">截取当前画面保存为图片</button> <span id="capmsg" class="mute"></span></p>` : '<p class="mute">没有可预览的视频（服务器未安装 ffmpeg 时无法生成预览，可下载原文件查看）。</p>')
      : (A.thumbFile(a.id) ? `<img src="/admin/assets/thumb/${a.id}" alt="" style="max-width:480px;border-radius:8px">` : '<p class="mute">此源文件没有内嵌缩略图。</p>');
  return view(a.original_name, `${flash(c)}<p><a href="/admin/assets${a.folder_id ? `?folder=${a.folder_id}` : ''}">← ${a.folder_id ? esc(A.folderPath(a.folder_id).map((f) => f.name).join(' / ')) : '全部素材'}</a></p>
<h2>${esc(a.title || a.original_name)} <span class="mute" style="font-size:14px">${A.KIND[a.kind]} · v${a.official}（共 ${a.version} 个版本）</span></h2>
<div style="display:grid;grid-template-columns:minmax(0,2fr) minmax(260px,1fr);gap:16px"><div>${stage}</div>
<div><form method="post" action="/admin/assets/${a.id}" class="fl2" style="background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px">
<label class="fl2">标题<input name="title" value="${esc(a.title || '')}"></label><label class="fl2">标签（逗号分隔）<input name="tags" value="${esc(a.tags.join(', '))}"></label>
<label class="fl2">文件夹<select name="folder"><option value="">（未分类）</option>${allFolders().map(([k, l]) => `<option value="${k}"${k === a.folder_id ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label><button>保存</button>
<div class="mute">自动标签：${tags({ tags: [], auto_tags: a.auto_tags }) || '无'}</div>
<div class="mute">${a.width ? `${a.width}×${a.height} px · ` : ''}${a.duration ? `${a.duration.toFixed(1)} 秒 · ` : ''}${esc(a.ext.toUpperCase())} · ${mb(a.bytes)}<br>产品：${esc(a.product_id || '—')}<br>上传：${esc(a.created_by)} ${fmt(a.created_at)}<br>原文件名：${esc(a.original_name)}</div>
${dl ? `<a href="/admin/assets/file/${a.id}/${a.official}">下载原图（正式版）</a>` : '<span class="mute">无下载原图权限</span>'}</form>
<form method="post" action="/admin/assets/${a.id}/version" enctype="multipart/form-data" class="fl2" style="margin-top:12px;background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px"><b>上传新版本</b><input type="file" name="file" required><input name="note" placeholder="修改说明"><button>上传为新版本</button></form>
${a.kind === 'image' ? processPanel(a) : ''}
<form method="post" action="/admin/assets/bulk" style="margin-top:12px"><input type="hidden" name="ids" value="${a.id}"><button name="action" value="trash" onclick="return confirm('移到回收站？')">删除（移到回收站）</button></form></div></div>
${(() => { const pubs = P.publicationsOf(a.id); return pubs.length ? `<h3>上架记录</h3><ul>${pubs.map((p) => `<li>${fmt(p.ts)} · v${p.version} → <a href="/admin/products/${encodeURIComponent(p.product_id)}">${esc(p.product_id)}</a> ${esc({ main: '主图', gallery: '副图', detail: '详情图', sku: `SKU 图 ${p.sku}` }[p.position] || p.position)} · ${esc(p.actor)}</li>`).join('')}</ul>` : ''; })()}<h3>版本记录</h3><form method="get" action="/admin/assets/compare"><input type="hidden" name="id" value="${a.id}"><div class="wrap"><table><thead><tr><th>对比</th><th>版本</th><th>来源</th><th>尺寸 / 大小</th><th>说明 / 提示词</th><th>操作人</th><th></th></tr></thead><tbody>
${vs.map((v) => `<tr><td><input type="checkbox" name="v" value="${v.version}" aria-label="对比 v${v.version}"></td><td><b>v${v.version}</b>${v.version === a.official ? ' <span class="tag" style="background:#c8e6c9">正式版</span>' : ''}</td><td>${esc({ upload: '上传', process: '处理', rollback: '回滚', capture: '截帧', pull: '链接拉取' }[v.source] || v.source)}</td><td>${v.width ? `${v.width}×${v.height} · ` : ''}${mb(v.bytes)}</td><td>${esc(v.note || '')}${v.prompt ? `<div class="mute">提示词：${esc(v.prompt)}</div>` : ''}${v.title ? `<div class="mute">标题：${esc(v.title)}</div>` : ''}</td><td>${esc(v.created_by)}<div class="mute">${fmt(v.created_at)}</div></td>
<td>${v.version !== a.official ? `<button formmethod="post" formaction="/admin/assets/${a.id}/official?version=${v.version}">设为正式版</button> <button formmethod="post" formaction="/admin/assets/${a.id}/rollback?version=${v.version}">回滚到此版本</button>` : ''} ${dl ? `<a href="/admin/assets/file/${a.id}/${v.version}">下载</a>` : ''}</td></tr>`).join('')}</tbody></table></div>${a.kind === 'image' && vs.length > 1 ? '<button>对比选中的两个版本</button>' : ''}</form>
<script>(()=>{const st=document.getElementById('stage'),im=document.getElementById('img');if(st&&im){let s=1,x=0,y=0,dx,dy,drag=false;const ap=()=>im.style.transform='translate(calc(-50% + '+x+'px),calc(-50% + '+y+'px)) scale('+s+')';
im.onload=()=>{s=Math.min(st.clientWidth/im.naturalWidth,st.clientHeight/im.naturalHeight,1);ap();};st.addEventListener('wheel',(e)=>{e.preventDefault();s=Math.max(.05,Math.min(8,s*(e.deltaY<0?1.15:1/1.15)));ap();},{passive:false});
st.addEventListener('mousedown',(e)=>{drag=true;dx=e.clientX-x;dy=e.clientY-y;st.style.cursor='grabbing';});addEventListener('mouseup',()=>{drag=false;st.style.cursor='grab';});addEventListener('mousemove',(e)=>{if(drag){x=e.clientX-dx;y=e.clientY-dy;ap();}});st.addEventListener('dblclick',()=>{x=y=0;im.onload();});}
const cap=document.getElementById('cap'),v=document.getElementById('vid');if(cap&&v)cap.onclick=async()=>{const cv=document.createElement('canvas');cv.width=v.videoWidth;cv.height=v.videoHeight;cv.getContext('2d').drawImage(v,0,0);const b=await new Promise((r)=>cv.toBlob(r,'image/png'));const fd=new FormData();fd.append('file',b,'frame-'+Math.round(v.currentTime*10)/10+'s.png');fd.append('t',String(v.currentTime));
const r=await fetch('/admin/assets/${a.id}/capture',{method:'POST',body:fd,headers:{'x-requested-with':'fetch'}});const j=await r.json().catch(()=>({}));document.getElementById('capmsg').innerHTML=j.id?'已保存：<a href="/admin/assets/'+j.id+'">查看截图</a>':(j.message||'失败');};})();</script>${a.kind === 'image' ? PROCESS_JS : ''}`);
}

/** Serve a file with HTTP range support (video seeking). */
function sendFile(c, file, type, download = '') {
  const size = statSync(file).size;
  c.header('content-type', type);
  c.header('accept-ranges', 'bytes');
  c.header('cache-control', 'private, max-age=300');
  if (download) c.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(download)}`);
  const m = (c.req.header('range') || '').match(/^bytes=(\d*)-(\d*)$/);
  if (m) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) { c.header('content-range', `bytes */${size}`); return c.body(null, 416); }
    c.header('content-range', `bytes ${start}-${end}/${size}`);
    c.header('content-length', String(end - start + 1));
    return c.body(Readable.toWeb(createReadStream(file, { start, end })), 206);
  }
  c.header('content-length', String(size));
  return c.body(Readable.toWeb(createReadStream(file)));
}

async function handleUpload(c) {
  const f = await c.req.parseBody({ all: true });
  const files = [].concat(f.files || f.file || []).filter((x) => x && typeof x === 'object' && x.size > 0);
  const product = fromForm(f, 'product').trim();
  let folderId = fromForm(f, 'folder') || null;
  const created = [], errors = [];
  const subdirs = new Map();
  for (const file of files) {
    try {
      let target = folderId;
      const parts = String(file.name).split('/').filter(Boolean);
      if (parts.length > 1) { // folder import: keep the relative folder structure under the target
        let parent = target;
        for (const seg of parts.slice(0, -1)) {
          const key = `${parent}|${seg}`;
          if (!subdirs.has(key)) subdirs.set(key, (A.childFolders(parent).find((x) => x.name === seg) || {}).id || A.createFolder(parent, seg));
          parent = subdirs.get(key);
        }
        target = parent;
      }
      const a = await A.ingest(Buffer.from(await file.arrayBuffer()), { name: parts.at(-1) || file.name, folderId: target, productId: target ? null : product || null, sub: fromForm(f, 'sub') || undefined });
      created.push(a.id);
      A.aiTag(a.id).catch(() => {});
    } catch (e) { errors.push(`${file.name}：${e.message}`); }
  }
  const message = `已上传 ${created.length} 个${errors.length ? `，${errors.length} 个失败：${errors.slice(0, 3).join('；')}` : ''}`;
  if (/fetch/.test(c.req.header('x-requested-with') || '')) return c.json({ created, errors, message }, created.length || !errors.length ? 200 : 400);
  return back(c, `/admin/assets${folderId ? `?folder=${folderId}` : ''}`, errors.length && !created.length ? 'e' : 'm', files.length ? message : '请选择文件');
}

export function mountAssetsAdmin(app) {
  app.get('/admin/assets', (c) => c.html(listPage(c)));
  app.post('/admin/assets/upload', limit, handleUpload);
  app.post('/admin/assets/publish', async (c) => {
    const f = await c.req.parseBody({ all: true });
    const ids = [].concat(f.ids || []).map(String);
    const productId = fromForm(f, 'product').trim();
    const ret = `/admin/assets${productId ? `?product=${encodeURIComponent(productId)}` : ''}`;
    if (!can(currentUser(), ['catalog'])) return back(c, ret, 'e', '上架到商品需要"商品：编辑、上下架"权限');
    try {
      const position = fromForm(f, 'position');
      const r = await P.publishToProduct({ productId, assetIds: ids, position, index: Math.max(0, Number(fromForm(f, 'index') || 1) - 1), sku: fromForm(f, 'sku').trim() });
      if (fromForm(f, 'publish') === '1') { const { publishAndPromote } = await import('../catalog/autolist.js'); await publishAndPromote(); }
      return c.redirect(`/admin/products/${encodeURIComponent(productId)}?m=${encodeURIComponent(`已上架 ${r.urls.length} 张到${{ main: '主图', gallery: '副图', detail: '详情图', sku: 'SKU 图' }[position]}${fromForm(f, 'publish') === '1' ? '，网站正在更新' : '（点"发布到网站"后生效）'}`)}${r.warnings.length ? `&w=${encodeURIComponent(r.warnings.join('；'))}` : ''}`);
    } catch (e) { return back(c, ret, 'e', e.message); }
  });
  app.get('/admin/assets/pull', (c) => {
    const logs = pullLogs(50);
    return c.html(view('链接拉取', `${flash(c)}<h2>商品链接拉取</h2><p class="mute">粘贴供应商 / 工厂 / 参考网站的商品页链接，读取页面公开的商品信息（标题、描述、型号）和图片，图片自动放进商品的主图 / 副图 / 详情图 / 视频文件夹。<b>竞品参考</b>只读取文案和关键词，不下载任何图片。</p>
<form method="post" action="/admin/assets/pull" class="fl2" style="max-width:640px;background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px"><label class="fl2">商品页链接<input name="url" type="url" required placeholder="https://"></label>
<label class="fl2">方式<select name="mode"><option value="own">拉取图片到商品（自有或供应商链接）</option><option value="reference">竞品参考（只读文案，不下载图片）</option></select></label><label class="fl2">放入商品（型号）<input name="product" list="plist2"><datalist id="plist2">${C.listProducts({ pageSize: 1000 }).rows.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</datalist></label><button>开始拉取</button></form>
<h3>拉取记录</h3><div class="wrap"><table><thead><tr><th>时间</th><th>链接</th><th>方式</th><th>商品</th><th>结果</th><th>读取到的信息</th></tr></thead><tbody>${logs.map((l) => `<tr><td>${fmt(l.ts)}<div class="mute">${esc(l.actor)}</div></td><td style="max-width:260px;word-break:break-all">${esc(l.url)}</td><td>${l.mode === 'reference' ? '竞品参考' : '拉取图片'}</td><td>${esc(l.product_id || '')}</td>
<td>${l.ok ? `<span class="tag" style="background:#c8e6c9">成功</span>${l.created.length ? ` 新增 ${l.created.length} 个素材` : ''}` : `<span class="tag" style="background:#fdecea">失败</span> ${esc(REASONS[l.reason] || l.reason || '')}`}</td><td class="mute" style="max-width:360px">${l.found ? esc([l.found.title, l.found.sku && `型号 ${l.found.sku}`, l.found.description?.slice(0, 120)].filter(Boolean).join(' · ')) : ''}${l.found?.errors?.length ? `<div>${esc(l.found.errors.slice(0, 3).join('；'))}</div>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="mute">暂无</td></tr>'}</tbody></table></div>`));
  });
  app.post('/admin/assets/pull', async (c) => {
    const f = await c.req.parseBody();
    const r = await pull(String(f.url || '').trim(), { mode: f.mode === 'reference' ? 'reference' : 'own', productId: String(f.product || '').trim() });
    return back(c, '/admin/assets/pull', r.ok ? 'm' : 'e', r.ok ? (f.mode === 'reference' ? `已读取：${r.found.title || ''}` : `已拉取 ${r.created.length} 个素材到 ${f.product}`) : `拉取失败：${REASONS[r.reason] || r.reason}`);
  });
  app.get('/admin/assets/watermarks', (c) => {
    const list = P.watermarks(), use = P.watermarkUse();
    const edit = list.find((w) => w.id === c.req.query('edit')) || {};
    const opts = (v) => `<option value="">不使用</option>${list.map((w) => `<option value="${w.id}"${w.id === v ? ' selected' : ''}>${esc(w.name)}</option>`).join('')}`;
    return c.html(view('水印', `${flash(c)}<h2>水印</h2><p class="mute"><b>预览水印</b>加在后台预览图上（原图不变）；<b>成品水印</b>在上架到网站时加到网站图片上。可保存多个模板，随时开关。</p>
<form method="post" action="/admin/assets/watermarks/use" class="acts"><label>预览水印 <select name="preview">${opts(use.preview)}</select></label> <label>成品水印 <select name="publish">${opts(use.publish)}</select></label> <button>保存</button></form>
<div class="wrap"><table><thead><tr><th>名称</th><th>类型</th><th>内容</th><th>位置</th><th>透明度 / 大小</th><th></th></tr></thead><tbody>${list.map((w) => `<tr><td>${esc(w.name)}</td><td>${w.type === 'text' ? '文字' : '图片'}</td><td>${w.type === 'text' ? esc(w.text) : `<a href="/admin/assets/${esc(w.assetId)}">素材</a>`}</td><td>${P.POSITIONS[w.position]}</td><td>${w.opacity} / ${w.scale}</td><td><a href="/admin/assets/watermarks?edit=${w.id}">编辑</a> <form method="post" action="/admin/assets/watermarks/${w.id}/delete" style="display:inline"><button>删除</button></form></td></tr>`).join('') || '<tr><td colspan="6" class="mute">还没有水印模板</td></tr>'}</tbody></table></div>
<h3>${edit.id ? '编辑水印' : '新建水印'}</h3><form method="post" action="/admin/assets/watermarks" class="fl2" style="max-width:480px">${edit.id ? `<input type="hidden" name="id" value="${edit.id}">` : ''}<label class="fl2">名称<input name="name" value="${esc(edit.name || '')}" required></label>
<label class="fl2">类型<select name="type"><option value="text"${edit.type !== 'image' ? ' selected' : ''}>文字</option><option value="image"${edit.type === 'image' ? ' selected' : ''}>图片（素材库中的透明 PNG）</option></select></label><label class="fl2">文字<input name="text" value="${esc(edit.text || config.profile.brand || '')}"></label><label class="fl2">图片素材编号<input name="assetId" value="${esc(edit.assetId || '')}"></label>
<label class="fl2">位置<select name="position">${Object.entries(P.POSITIONS).map(([k, l]) => `<option value="${k}"${k === (edit.position || 'br') ? ' selected' : ''}>${l}</option>`).join('')}</select></label><label class="fl2">透明度（0.05–1）<input name="opacity" value="${edit.opacity ?? 0.5}"></label><label class="fl2">大小（占图片宽度，0.05–0.8）<input name="scale" value="${edit.scale ?? 0.25}"></label><label class="fl2">文字颜色<input name="color" value="${esc(edit.color || '#ffffff')}"></label><button>保存水印</button></form>`));
  });
  app.post('/admin/assets/watermarks', async (c) => { const f = await c.req.parseBody(); try { P.saveWatermark(f); return back(c, '/admin/assets/watermarks', 'm', '水印已保存'); } catch (e) { return back(c, '/admin/assets/watermarks', 'e', e.message); } });
  app.post('/admin/assets/watermarks/use', async (c) => { const f = await c.req.parseBody(); try { P.setWatermarkUse({ preview: String(f.preview || '') || null, publish: String(f.publish || '') || null }); return back(c, '/admin/assets/watermarks', 'm', '已保存'); } catch (e) { return back(c, '/admin/assets/watermarks', 'e', e.message); } });
  app.post('/admin/assets/watermarks/:id/delete', (c) => { P.deleteWatermark(c.req.param('id')); return back(c, '/admin/assets/watermarks', 'm', '已删除'); });
  app.get('/admin/assets/thumb/:id', (c) => { const f = A.thumbFile(c.req.param('id')); return f ? sendFile(c, f, 'image/webp') : c.text('Not found', 404); });
  app.get('/admin/assets/preview/:id', async (c) => { const f = await P.watermarkedPreview(c.req.param('id')); return f ? sendFile(c, f, f.endsWith('.mp4') ? 'video/mp4' : 'image/webp') : c.text('Not found', 404); });
  app.get('/admin/assets/file/:id/:v', (c) => {
    const a = A.getAsset(c.req.param('id'));
    const f = a && A.versionFile(a.id, c.req.param('v'));
    return f ? sendFile(c, f, a.mime, (a.original_name || `${a.id}.${a.ext}`).replace(/\.\w+$/, '') + `-v${c.req.param('v')}.${a.ext}`) : c.text('Not found', 404);
  });
  app.post('/admin/assets/bulk-download', async (c) => {
    const f = await c.req.parseBody({ all: true });
    const ids = [].concat(f.ids || []).map(String);
    if (!ids.length) return back(c, '/admin/assets', 'e', '请先勾选素材');
    c.header('content-type', 'application/zip');
    c.header('content-disposition', `attachment; filename="assets-${new Date().toISOString().slice(0, 10)}.zip"`);
    return c.body(A.zip(ids));
  });
  app.post('/admin/assets/bulk', async (c) => {
    const f = await c.req.parseBody({ all: true });
    const ids = [].concat(f.ids || []).map(String);
    const action = fromForm(f, 'action');
    const go = (k, v) => back(c, c.req.header('referer') && new URL(c.req.header('referer')).pathname === '/admin/assets' ? '/admin/assets' + (new URL(c.req.header('referer')).search || '') : '/admin/assets', k, v);
    if (!ids.length) return go('e', '请先勾选素材');
    const tagList = fromForm(f, 'tags').split(/[,，]/).map((t) => t.trim()).filter(Boolean);
    try {
      if (action === 'tag') { if (!tagList.length) return go('e', '请输入标签'); A.bulkTag(ids, tagList, []); return go('m', `已为 ${ids.length} 个素材添加标签`); }
      if (action === 'untag') { A.bulkTag(ids, [], tagList); return go('m', `已为 ${ids.length} 个素材去掉标签`); }
      if (action === 'move') { A.bulkMove(ids, fromForm(f, 'folder') || null); return go('m', `已移动 ${ids.length} 个素材`); }
      if (action === 'trash') { A.trash(ids); return go('m', `已移到回收站：${ids.length} 个（${A.settings().trashDays} 天后自动清除）`); }
      return go('e', '未知操作');
    } catch (e) { return go('e', e.message); }
  });
  app.post('/admin/assets/folders/new', async (c) => { const f = await c.req.parseBody(); try { const id = A.createFolder(String(f.parent || '') || null, f.name); return back(c, `/admin/assets?folder=${id}`, 'm', '已新建文件夹'); } catch (e) { return back(c, `/admin/assets${f.parent ? `?folder=${f.parent}` : ''}`, 'e', e.message); } });
  app.post('/admin/assets/folders/:id/rename', async (c) => { const f = await c.req.parseBody(); try { A.renameFolder(c.req.param('id'), f.name); return back(c, `/admin/assets?folder=${c.req.param('id')}`, 'm', '已重命名'); } catch (e) { return back(c, `/admin/assets?folder=${c.req.param('id')}`, 'e', e.message); } });
  app.post('/admin/assets/folders/:id/delete', (c) => { const p = A.getFolder(c.req.param('id'))?.parent_id; try { A.deleteFolder(c.req.param('id')); return back(c, `/admin/assets${p ? `?folder=${p}` : ''}`, 'm', '已删除文件夹'); } catch (e) { return back(c, `/admin/assets?folder=${c.req.param('id')}`, 'e', e.message); } });
  app.get('/admin/assets/trash', (c) => {
    const { rows } = A.search({ status: 'trashed', limit: 500 });
    return c.html(view('回收站', `${flash(c)}<h2>回收站（${rows.length}）</h2><p class="mute">删除的素材保留 ${A.settings().trashDays} 天后自动彻底清除；彻底删除后无法找回。</p>
<form method="post" class="bar"><label><input type="checkbox" onclick="document.querySelectorAll('input[name=ids]').forEach((x)=>x.checked=this.checked)"> 全选</label><button formaction="/admin/assets/trash/restore">恢复</button>${can(currentUser(), ['assets.delete']) ? '<button formaction="/admin/assets/trash/purge" onclick="return confirm(\'彻底删除后无法找回，确定？\')">彻底删除</button>' : ''}
<div class="grid" style="width:100%">${rows.map((a) => `<div class="card"><input type="checkbox" name="ids" value="${a.id}"><span class="th" style="background-image:url('${thumb(a)}')"></span><div class="meta"><b>${esc(a.original_name)}</b>删除于 ${fmt(a.trashed_at)}<br>${esc(a.updated_by || '')}</div></div>`).join('') || '<p class="mute">回收站是空的</p>'}</div></form>`));
  });
  app.post('/admin/assets/trash/restore', async (c) => { const ids = [].concat((await c.req.parseBody({ all: true })).ids || []).map(String); if (ids.length) A.restore(ids); return back(c, '/admin/assets/trash', 'm', `已恢复 ${ids.length} 个`); });
  app.post('/admin/assets/trash/purge', async (c) => { const ids = [].concat((await c.req.parseBody({ all: true })).ids || []).map(String); return back(c, '/admin/assets/trash', 'm', `已彻底删除 ${A.purge(ids)} 个`); });
  app.get('/admin/assets/similar', (c) => c.html(view('以图搜图', `<h2>以图搜图</h2><p class="mute">上传一张图片，找出素材库里相同或相似的图片（例如查重、找原图）。</p><form method="post" action="/admin/assets/similar" enctype="multipart/form-data" class="acts"><input type="file" name="file" accept=".jpg,.jpeg,.png,.webp" required><button>搜索</button></form>`)));
  app.post('/admin/assets/similar', limit, async (c) => {
    const f = await c.req.parseBody();
    if (!f.file || typeof f.file !== 'object') return c.redirect('/admin/assets/similar');
    let hits;
    try { hits = await A.similar(Buffer.from(await f.file.arrayBuffer())); } catch { return c.html(view('以图搜图', '<p class="mute">无法读取这张图片</p>'), 400); }
    return c.html(view('以图搜图', `<h2>相似素材（${hits.length}）</h2><div class="grid">${hits.map((a) => `<div class="card"><a class="th" href="/admin/assets/${a.id}" style="background-image:url('${thumb(a)}')"></a><div class="meta"><b>${esc(a.original_name)}</b>${a.distance === 0 ? '完全相同' : `相似度 ${Math.round((1 - a.distance / 64) * 100)}%`}</div></div>`).join('') || '<p class="mute">没有找到相似的素材</p>'}</div>`));
  });
  app.get('/admin/assets/settings', (c) => {
    const s = A.settings();
    const u = A.usage();
    return c.html(view('素材设置', `${flash(c)}<h2>容量与设置</h2>
<div class="tiles"><div class="tile"><span>已用 / 上限</span><strong>${mb(u.total)} / ${s.quotaGb} GB</strong></div><div class="tile"><span>使用率</span><strong>${u.pct}%</strong></div><div class="tile"><span>回收站</span><strong>${u.trashed}</strong></div></div>
${u.pct >= 80 ? '<div class="warn">空间使用已超过 80%，请清理回收站或调整上限。</div>' : ''}
<h3>按产品统计</h3><div class="wrap"><table><thead><tr><th>产品</th><th>素材数</th><th>占用（含历史版本）</th></tr></thead><tbody>${u.byProduct.map((p) => `<tr><td>${esc(p.product_id || '（未关联产品）')}</td><td>${p.n}</td><td>${mb(p.bytes)}</td></tr>`).join('') || '<tr><td colspan="3" class="mute">暂无</td></tr>'}</tbody></table></div>
<h3>按类型统计</h3><p>${u.byKind.map((k) => `${A.KIND[k.kind] || k.kind}：${k.n} 个，${mb(k.bytes)}`).join('　') || '暂无'}</p>
<h3>设置</h3><form method="post" action="/admin/assets/settings" class="fl2" style="max-width:420px"><label class="fl2">素材仓库容量上限（GB）<input name="quotaGb" value="${s.quotaGb}"></label><label class="fl2">回收站保留天数<input name="trashDays" value="${s.trashDays}"></label>
<label class="fl2">上架到网站时的图片质量（50–100）<input name="quality" value="${s.quality}"></label><label class="fl2">上架到网站时的最大边长（px）<input name="maxEdge" value="${s.maxEdge}"></label><button>保存设置</button></form>
<h3 id="presets">尺寸预设</h3><p class="mute">改尺寸和多尺寸导出时使用；高度填 0 表示按原图比例。</p><div class="wrap"><table><thead><tr><th>名称</th><th>宽 × 高</th><th></th></tr></thead><tbody>${X.presets().map((p) => `<tr><td>${esc(p.name)}</td><td>${p.width} × ${p.height || '自适应'}</td><td><form method="post" action="/admin/assets/presets/${encodeURIComponent(p.id)}/delete" style="display:inline"><button>删除</button></form></td></tr>`).join('')}</tbody></table></div>
<form method="post" action="/admin/assets/presets" class="acts"><input name="name" placeholder="名称，如 亚马逊主图" required> <input name="width" placeholder="宽 px" size="6" required> × <input name="height" placeholder="高 px" size="6" value="0"> <button>添加尺寸</button></form>`));
  });
  app.post('/admin/assets/settings', async (c) => {
    const f = await c.req.parseBody();
    const s = { ...A.settings(), quotaGb: Number(f.quotaGb), trashDays: Number(f.trashDays), quality: Number(f.quality), maxEdge: Number(f.maxEdge) };
    if (!(s.quotaGb > 0 && s.quotaGb <= 2000)) return back(c, '/admin/assets/settings', 'e', '容量上限须在 0–2000 GB 之间');
    if (!(Number.isInteger(s.trashDays) && s.trashDays >= 1 && s.trashDays <= 365)) return back(c, '/admin/assets/settings', 'e', '回收站保留天数须为 1–365');
    if (!(Number.isInteger(s.quality) && s.quality >= 50 && s.quality <= 100)) return back(c, '/admin/assets/settings', 'e', '图片质量须为 50–100');
    if (!(Number.isInteger(s.maxEdge) && s.maxEdge >= 400 && s.maxEdge <= 8000)) return back(c, '/admin/assets/settings', 'e', '最大边长须为 400–8000');
    setSetting('asset_settings', s);
    return back(c, '/admin/assets/settings', 'm', '设置已保存');
  });
  app.post('/admin/assets/presets', async (c) => { const f = await c.req.parseBody(); try { X.savePreset(f); return back(c, '/admin/assets/settings', 'm', '尺寸预设已保存'); } catch (e) { return back(c, '/admin/assets/settings', 'e', e.message); } });
  app.post('/admin/assets/presets/:id/delete', (c) => { X.deletePreset(c.req.param('id')); return back(c, '/admin/assets/settings', 'm', '已删除'); });
  app.post('/admin/assets/batch', async (c) => {
    const f = await c.req.parseBody({ all: true });
    const ids = [].concat(f.ids || []).map(String);
    if (!ids.length) return back(c, '/admin/assets', 'e', '请先勾选素材');
    const op = fromForm(f, 'op'), preset = fromForm(f, 'preset');
    const params = op === 'resize' ? { preset } : op === 'extend' ? { ratio: '1:1', fill: 'blur' } : op === 'colour' ? { normalise: true } : op === 'background' ? { background: '#ffffff' } : {};
    try { const id = X.queueBatch(ids, { op, params, presetIds: [].concat(f.presets || preset || []).map(String) }); return c.redirect(`/admin/tasks/${id}?m=${encodeURIComponent('已加入任务中心，后台处理中')}`); } catch (e) { return back(c, '/admin/assets', 'e', e.message); }
  });
  app.get('/admin/assets/compare', (c) => {
    const a = A.getAsset(c.req.query('id'));
    const vs = c.req.queries('v') || [];
    if (!a || vs.length !== 2) return back(c, `/admin/assets/${c.req.query('id') || ''}`, 'e', '请勾选两个版本进行对比');
    const v = A.versionsOf(a.id).filter((x) => vs.includes(String(x.version))).sort((x, y) => x.version - y.version);
    return c.html(view('版本对比', `<p><a href="/admin/assets/${a.id}">← ${esc(a.original_name)}</a></p><h2>版本对比</h2><div class="cmp">${v.map((x) => `<figure style="margin:0"><img src="/admin/assets/file/${a.id}/${x.version}" alt="v${x.version}" loading="lazy"><figcaption>v${x.version} · ${x.width}×${x.height} · ${mb(x.bytes)} · ${esc(x.note || x.source)}</figcaption></figure>`).join('')}</div>`));
  });
  app.get('/admin/assets/:id', (c) => c.html(detailPage(c)));
  app.post('/admin/assets/:id', async (c) => {
    const f = await c.req.parseBody();
    try { A.updateAsset(c.req.param('id'), { title: String(f.title ?? ''), tags: String(f.tags || '').split(/[,，]/), folderId: String(f.folder || '') || null }); return back(c, `/admin/assets/${c.req.param('id')}`, 'm', '已保存'); } catch (e) { return back(c, `/admin/assets/${c.req.param('id')}`, 'e', e.message); }
  });
  app.post('/admin/assets/:id/version', limit, async (c) => {
    const f = await c.req.parseBody();
    try { if (!f.file || typeof f.file !== 'object' || !f.file.size) throw new Error('请选择文件'); const a = await A.addVersion(c.req.param('id'), Buffer.from(await f.file.arrayBuffer()), { note: String(f.note || '') }); return back(c, `/admin/assets/${a.id}`, 'm', `已上传 v${a.version}`); } catch (e) { return back(c, `/admin/assets/${c.req.param('id')}`, 'e', e.message); }
  });
  app.post('/admin/assets/:id/rollback', async (c) => { try { const a = await A.rollback(c.req.param('id'), c.req.query('version')); return back(c, `/admin/assets/${a.id}`, 'm', `已回滚，生成 v${a.version}`); } catch (e) { return back(c, `/admin/assets/${c.req.param('id')}`, 'e', e.message); } });
  app.post('/admin/assets/:id/official', async (c) => { try { await A.setOfficial(c.req.param('id'), c.req.query('version')); return back(c, `/admin/assets/${c.req.param('id')}`, 'm', `已将 v${c.req.query('version')} 设为正式版`); } catch (e) { return back(c, `/admin/assets/${c.req.param('id')}`, 'e', e.message); } });
  app.post('/admin/assets/:id/process', limit, async (c) => {
    const id = c.req.param('id');
    const f = await c.req.parseBody();
    try {
      const a = await X.processAsset(id, fromForm(f, 'op'), processParams(f), { saveAs: fromForm(f, 'saveAs') === 'new' ? 'new' : 'version', prompt: fromForm(f, 'prompt').trim() || null });
      return a.id === id ? back(c, `/admin/assets/${id}`, 'm', `处理完成，已生成 v${a.version}（可回滚）`) : back(c, `/admin/assets/${a.id}`, 'm', '处理完成，已另存为新素材');
    } catch (e) { return back(c, `/admin/assets/${id}`, 'e', e.message); }
  });
  app.post('/admin/assets/:id/sizes', async (c) => {
    const id = c.req.param('id');
    const ids = [].concat((await c.req.parseBody({ all: true })).presets || []).map(String);
    if (!ids.length) return back(c, `/admin/assets/${id}`, 'e', '请选择至少一个尺寸');
    try { const out = await X.exportSizes(id, ids); return back(c, `/admin/assets/${id}`, 'm', `已导出 ${out.length} 个尺寸，保存在同一文件夹`); } catch (e) { return back(c, `/admin/assets/${id}`, 'e', e.message); }
  });
  app.post('/admin/assets/:id/capture', limit, async (c) => {
    const src = A.getAsset(c.req.param('id'));
    const f = await c.req.parseBody();
    try {
      if (!src || src.kind !== 'video') throw new Error('只能从视频截帧');
      if (!f.file || typeof f.file !== 'object') throw new Error('没有图片');
      const folder = src.product_id ? A.ensureProductFolders(src.product_id).subs['副图'] : src.folder_id;
      const a = await A.ingest(Buffer.from(await f.file.arrayBuffer()), { name: f.file.name, folderId: folder, tags: ['视频截帧'], note: `来自 ${src.original_name} 第 ${Number(f.t || 0).toFixed(1)} 秒`, source: 'capture' });
      return c.json({ id: a.id });
    } catch (e) { return c.json({ message: e.message }, 400); }
  });
}
