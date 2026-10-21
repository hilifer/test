// Asset library (素材仓库): product images, videos and design source files.
// Files: <MEDIA_DIR>/assets/<assetId>/v<version>.<ext>, plus thumb.webp and preview (webp image / low-bitrate mp4).
// Every change (re-upload, processing, rollback) is a new version; one version is marked "official" (正式版) and is what
// gets listed on the website. Deleting moves to the recycle bin; files are removed only after the retention period or
// when deleted permanently.
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { db } from '../db.js';
import { config } from '../config.js';
import { migrate } from '../migrate.js';
import { actorName } from '../auth.js';
import { alertOps } from '../alerts.js';
import { getSetting } from '../catalog/store.js';

const run = promisify(execFile);
migrate([{
  id: '2026-10-30-assets',
  up: () => db.exec(`
    CREATE TABLE asset_folders (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL, product_id TEXT, sub TEXT, created_at TEXT, created_by TEXT);
    CREATE INDEX idx_folder_parent ON asset_folders(parent_id);
    CREATE TABLE assets (id TEXT PRIMARY KEY, folder_id TEXT, product_id TEXT, kind TEXT, mime TEXT, ext TEXT, original_name TEXT, title TEXT,
      tags TEXT DEFAULT '[]', auto_tags TEXT DEFAULT '[]', width INTEGER, height INTEGER, duration REAL, bytes INTEGER, hash TEXT, dhash TEXT,
      version INTEGER DEFAULT 1, official INTEGER DEFAULT 1, status TEXT DEFAULT 'active', trashed_at TEXT, created_at TEXT, created_by TEXT, updated_at TEXT, updated_by TEXT);
    CREATE INDEX idx_assets_folder ON assets(folder_id, status); CREATE INDEX idx_assets_product ON assets(product_id, status); CREATE INDEX idx_assets_hash ON assets(hash);
    CREATE TABLE asset_versions (asset_id TEXT, version INTEGER, file TEXT, bytes INTEGER, width INTEGER, height INTEGER, hash TEXT, source TEXT, note TEXT,
      title TEXT, prompt TEXT, created_at TEXT, created_by TEXT, PRIMARY KEY (asset_id, version));`),
}]);

export const KIND = { image: '图片', video: '视频', source: '设计源文件' };
export const SUBFOLDERS = ['主图', '副图', 'SKU 图', '详情图', '视频', '源文件'];
export const MAX_BYTES = { image: 25 * 1048576, video: 500 * 1048576, source: 300 * 1048576 };
const now = () => new Date().toISOString();
const J = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const sha = (b) => createHash('sha256').update(b).digest('hex');
export const assetsDir = () => join(config.mediaDir, 'assets');
const dirOf = (id) => join(assetsDir(), id);
export const settings = () => ({ quotaGb: 30, trashDays: 30, quality: 85, maxEdge: 2000, ...(getSetting('asset_settings') || {}) });
let ffmpegOk = null;
export async function hasFfmpeg() { if (ffmpegOk == null) ffmpegOk = await run('ffmpeg', ['-version']).then(() => true, () => false); return ffmpegOk; }

// ---------------------------------------------------------------- type detection (magic bytes, never the file name alone)
export function detect(buf, name = '') {
  if (!buf?.length) return null;
  const a = (s, e) => buf.toString('ascii', s, e);
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'image', ext: 'jpg', mime: 'image/jpeg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: 'image', ext: 'png', mime: 'image/png' };
  if (a(0, 4) === 'RIFF' && a(8, 12) === 'WEBP') return { kind: 'image', ext: 'webp', mime: 'image/webp' };
  if (a(4, 8) === 'ftyp') { const brand = a(8, 12); return brand === 'qt  ' ? { kind: 'video', ext: 'mov', mime: 'video/quicktime' } : { kind: 'video', ext: 'mp4', mime: 'video/mp4' }; }
  if (a(0, 4) === '8BPS') return { kind: 'source', ext: 'psd', mime: 'image/vnd.adobe.photoshop' };
  if (/\.ai$/i.test(name) && (a(0, 4) === '%PDF' || a(0, 10) === '%!PS-Adobe')) return { kind: 'source', ext: 'ai', mime: 'application/postscript' };
  return null;
}

// ---------------------------------------------------------------- analysis: size, perceptual hash, automatic tags
/** 64-bit difference hash (for "search by image"). */
export async function dhash(buf) {
  const px = await sharp(buf).flatten({ background: '#fff' }).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += px[y * 9 + x] > px[y * 9 + x + 1] ? '1' : '0';
  return BigInt('0b' + bits).toString(16).padStart(16, '0');
}
export const hamming = (a, b) => { let x = BigInt('0x' + a) ^ BigInt('0x' + b), n = 0; while (x) { n += Number(x & 1n); x >>= 1n; } return n; };

/** Tags we can tell from the pixels: white background, transparent, square main-image candidate, long detail image, banner, low resolution. */
export async function imageTags(buf) {
  const img = sharp(buf);
  const m = await img.metadata();
  const tags = [];
  const w = m.width, h = m.height;
  if (m.hasAlpha) {
    const { data, info } = await sharp(buf).ensureAlpha().resize(64, 64, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
    let transparent = 0;
    for (let i = info.channels - 1; i < data.length; i += info.channels) if (data[i] < 250) transparent++;
    if (transparent > 64 * 64 * 0.05) tags.push('透明图');
  }
  if (!tags.includes('透明图')) {
    const { data, info } = await sharp(buf).flatten({ background: '#fff' }).removeAlpha().resize(64, 64, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
    let white = 0, edge = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      if (x > 2 && x < 61 && y > 2 && y < 61) continue;
      edge++;
      const i = (y * 64 + x) * info.channels;
      if (data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240) white++;
    }
    if (white / edge > 0.9) tags.push('白底图');
  }
  if (Math.abs(w - h) / Math.max(w, h) < 0.02 && Math.min(w, h) >= 800) tags.push('方图（主图候选）');
  if (h / w >= 2) tags.push('长图（详情图）');
  if (w / h >= 2) tags.push('横幅');
  if (Math.min(w, h) < 800) tags.push('低分辨率');
  return { width: w, height: h, tags };
}

async function probeVideo(file) {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file], { timeout: 30000 });
    const j = JSON.parse(stdout);
    return { width: j.streams?.[0]?.width || null, height: j.streams?.[0]?.height || null, duration: Number(j.format?.duration) || null };
  } catch { return { width: null, height: null, duration: null }; }
}

/** PSD files carry a JPEG thumbnail (image resource 1036); Illustrator files an XMP thumbnail. */
export function sourceThumbnail(buf, ext) {
  if (ext === 'psd') {
    let p = 26;
    p += 4 + buf.readUInt32BE(p); // colour mode data
    const end = p + 4 + buf.readUInt32BE(p);
    p += 4;
    while (p + 12 < end && buf.toString('ascii', p, p + 4) === '8BIM') {
      const id = buf.readUInt16BE(p + 4);
      let q = p + 6;
      const nameLen = buf[q]; q += 1 + nameLen + ((nameLen + 1) % 2);
      const size = buf.readUInt32BE(q); q += 4;
      if (id === 1036 || id === 1033) return buf.subarray(q + 28, q + size); // 28-byte thumbnail header, then JPEG
      p = q + size + (size % 2);
    }
    return null;
  }
  if (ext === 'ai') {
    const m = buf.toString('latin1').match(/<xmpGImg:image>([A-Za-z0-9+/=\s&#;x]+)<\/xmpGImg:image>/);
    return m ? Buffer.from(m[1].replace(/&#xA;|\s/g, ''), 'base64') : null;
  }
  return null;
}

// ---------------------------------------------------------------- folders
export const getFolder = (id) => db.prepare('SELECT * FROM asset_folders WHERE id = ?').get(id) || null;
export const childFolders = (parentId = null) => db.prepare(`SELECT * FROM asset_folders WHERE ${parentId ? 'parent_id = ?' : 'parent_id IS NULL'} ORDER BY name`).all(...(parentId ? [parentId] : []));
export function folderPath(id) { const out = []; let f = getFolder(id); while (f) { out.unshift(f); f = f.parent_id ? getFolder(f.parent_id) : null; } return out; }
export function createFolder(parentId, name, extra = {}) {
  const n = String(name || '').trim();
  if (!n || n.length > 60 || /[\\/]/.test(n)) throw new Error('文件夹名称：1–60 个字，不能含 / 或 \\');
  if (parentId && !getFolder(parentId)) throw new Error('上级文件夹不存在');
  if (db.prepare(`SELECT 1 FROM asset_folders WHERE ${parentId ? 'parent_id = ?' : 'parent_id IS NULL'} AND name = ?`).get(...(parentId ? [parentId, n] : [n]))) throw new Error(`已有同名文件夹：${n}`);
  const id = randomUUID();
  db.prepare('INSERT INTO asset_folders (id, parent_id, name, product_id, sub, created_at, created_by) VALUES (?,?,?,?,?,?,?)').run(id, parentId || null, n, extra.productId || null, extra.sub || null, now(), actorName('system'));
  return id;
}
export function renameFolder(id, name) {
  const f = getFolder(id);
  if (!f) throw new Error('文件夹不存在');
  const n = String(name || '').trim();
  if (!n || n.length > 60 || /[\\/]/.test(n)) throw new Error('文件夹名称：1–60 个字，不能含 / 或 \\');
  db.prepare('UPDATE asset_folders SET name = ? WHERE id = ?').run(n, id);
}
export function deleteFolder(id) {
  if (!getFolder(id)) throw new Error('文件夹不存在');
  if (childFolders(id).length || db.prepare("SELECT 1 FROM assets WHERE folder_id = ? AND status = 'active'").get(id)) throw new Error('文件夹不是空的');
  db.prepare("UPDATE assets SET folder_id = NULL WHERE folder_id = ?").run(id); // trashed items keep working after restore
  db.prepare('DELETE FROM asset_folders WHERE id = ?').run(id);
}
/** 网站 / 产品文件夹 / 子分类 — created on demand for a product. Returns { productFolder, subs: {主图: id, …} }. */
export function ensureProductFolders(productId) {
  let root = db.prepare('SELECT * FROM asset_folders WHERE parent_id IS NULL AND sub = ?').get('site');
  if (!root) root = getFolder(createFolder(null, config.profile.brand || config.site, { sub: 'site' }));
  let pf = db.prepare('SELECT * FROM asset_folders WHERE product_id = ? AND sub IS NULL').get(productId);
  if (!pf) pf = getFolder(createFolder(root.id, productId, { productId }));
  const subs = {};
  for (const s of SUBFOLDERS) {
    let f = db.prepare('SELECT * FROM asset_folders WHERE parent_id = ? AND sub = ?').get(pf.id, s);
    if (!f) f = getFolder(createFolder(pf.id, s, { productId, sub: s }));
    subs[s] = f.id;
  }
  return { productFolder: pf.id, subs };
}
/** Shared folder for brand / reusable material (logos, transparent PNGs, common video clips). */
export function sharedFolder() {
  const f = db.prepare("SELECT id FROM asset_folders WHERE parent_id IS NULL AND sub = 'shared'").get();
  return f ? f.id : createFolder(null, '公共素材', { sub: 'shared' });
}

// ---------------------------------------------------------------- usage / quota
function dirBytes(d) { if (!existsSync(d)) return 0; let n = 0; for (const f of readdirSync(d)) { const p = join(d, f); const s = statSync(p); n += s.isDirectory() ? dirBytes(p) : s.size; } return n; }
export function usage() {
  const total = dirBytes(assetsDir());
  const quota = settings().quotaGb * 1073741824;
  const byProduct = db.prepare("SELECT COALESCE(a.product_id, '') product_id, SUM(v.bytes) bytes, COUNT(DISTINCT a.id) n FROM assets a JOIN asset_versions v ON v.asset_id = a.id GROUP BY a.product_id ORDER BY bytes DESC").all();
  const byKind = db.prepare('SELECT a.kind, SUM(v.bytes) bytes, COUNT(DISTINCT a.id) n FROM assets a JOIN asset_versions v ON v.asset_id = a.id GROUP BY a.kind').all();
  return { total, quota, pct: quota ? Math.round((total / quota) * 1000) / 10 : 0, byProduct, byKind, trashed: db.prepare("SELECT COUNT(*) n FROM assets WHERE status = 'trashed'").get().n };
}
let lastQuotaAlert = 0;
function checkQuota(extra) {
  const u = usage();
  if (u.total + extra > u.quota) throw new Error(`素材仓库空间不足：已用 ${(u.total / 1073741824).toFixed(2)} GB / ${settings().quotaGb} GB，请清理回收站或在设置中调整上限`);
  if ((u.total + extra) / u.quota > 0.8 && Date.now() - lastQuotaAlert > 12 * 3600e3) { lastQuotaAlert = Date.now(); alertOps('素材仓库空间即将用完', [`已用 ${u.pct}%（上限 ${settings().quotaGb} GB）`]).catch(() => {}); }
}

// ---------------------------------------------------------------- previews
async function makeDerivatives(id, file, kind, ext, buf) {
  const d = dirOf(id);
  rmSync(join(d, 'thumb.webp'), { force: true });
  try {
    if (kind === 'image') {
      await sharp(buf).rotate().resize(480, 480, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toFile(join(d, 'thumb.webp'));
      await sharp(buf).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toFile(join(d, 'preview.webp'));
    } else if (kind === 'source') {
      const t = sourceThumbnail(buf, ext);
      if (t?.length) await sharp(t).resize(480, 480, { fit: 'inside' }).webp({ quality: 78 }).toFile(join(d, 'thumb.webp'));
    } else if (kind === 'video' && (await hasFfmpeg())) {
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '1', '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', join(d, 'thumb.webp')], { timeout: 60000 }).catch(() => run('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', join(d, 'thumb.webp')], { timeout: 60000 }));
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-vf', 'scale=-2:480', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', join(d, 'preview.mp4')], { timeout: 600000 });
    }
  } catch (e) { console.error('[assets] preview', id, e.message); }
}

// ---------------------------------------------------------------- ingest / versions
export const getAsset = (id) => { const a = db.prepare('SELECT * FROM assets WHERE id = ?').get(id); return a && { ...a, tags: J(a.tags, []), auto_tags: J(a.auto_tags, []) }; };
export const versionsOf = (id) => db.prepare('SELECT * FROM asset_versions WHERE asset_id = ? ORDER BY version DESC').all(id);
export const versionFile = (id, version) => { const v = db.prepare('SELECT file FROM asset_versions WHERE asset_id = ? AND version = ?').get(id, Number(version)); return v ? join(dirOf(id), v.file) : null; };
export const officialFile = (a) => versionFile(a.id, a.official || a.version);
export const thumbFile = (id) => { const f = join(dirOf(id), 'thumb.webp'); return existsSync(f) ? f : null; };
export const previewFile = (id) => { for (const f of ['preview.webp', 'preview.mp4']) if (existsSync(join(dirOf(id), f))) return join(dirOf(id), f); return null; };

/** Add a file to the library. opts: { name, folderId, productId, sub, title, tags, note }. Returns the asset. */
export async function ingest(buf, opts = {}) {
  const t = detect(buf, opts.name);
  if (!t) throw new Error(`不支持的文件类型：${opts.name || ''}（图片 JPG/PNG/WebP，视频 MP4/MOV，源文件 PSD/AI）`);
  if (buf.length > MAX_BYTES[t.kind]) throw new Error(`${KIND[t.kind]}不能超过 ${MAX_BYTES[t.kind] / 1048576} MB：${opts.name || ''}`);
  checkQuota(buf.length);
  let folderId = opts.folderId || null;
  if (opts.productId && !folderId) folderId = ensureProductFolders(opts.productId).subs[opts.sub || (t.kind === 'video' ? '视频' : t.kind === 'source' ? '源文件' : '主图')];
  if (folderId && !getFolder(folderId)) throw new Error('文件夹不存在');
  const productId = opts.productId || (folderId ? folderPath(folderId).map((f) => f.product_id).filter(Boolean).pop() : null) || null;
  const id = randomUUID();
  mkdirSync(dirOf(id), { recursive: true });
  const file = join(dirOf(id), `v1.${t.ext}`);
  writeFileSync(file, buf);
  let meta = { width: null, height: null, tags: [] }, duration = null, dh = null;
  if (t.kind === 'image') { meta = await imageTags(buf); dh = await dhash(buf); }
  else if (t.kind === 'video') { const p = await probeVideo(file); meta = { width: p.width, height: p.height, tags: ['商品视频'] }; duration = p.duration; }
  else meta.tags = ['设计源文件'];
  const tags = [...new Set([].concat(opts.tags || []).map((x) => String(x).trim()).filter(Boolean))];
  const ts = now(), actor = actorName('system');
  db.prepare(`INSERT INTO assets (id, folder_id, product_id, kind, mime, ext, original_name, title, tags, auto_tags, width, height, duration, bytes, hash, dhash, version, official, created_at, created_by, updated_at, updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1,?,?,?,?)`).run(id, folderId, productId, t.kind, t.mime, t.ext, String(opts.name || '').slice(0, 200), String(opts.title || '').slice(0, 200),
    JSON.stringify(tags), JSON.stringify(meta.tags), meta.width, meta.height, duration, buf.length, sha(buf), dh, ts, actor, ts, actor);
  db.prepare('INSERT INTO asset_versions (asset_id, version, file, bytes, width, height, hash, source, note, title, prompt, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, 1, `v1.${t.ext}`, buf.length, meta.width, meta.height, sha(buf), opts.source || 'upload', String(opts.note || '').slice(0, 300), opts.title || null, opts.prompt || null, ts, actor);
  await makeDerivatives(id, file, t.kind, t.ext, buf);
  return getAsset(id);
}

/** New version of an existing asset (re-upload, AI processing, resize…). The new version becomes official unless keepOfficial. */
export async function addVersion(id, buf, { source = 'upload', note = '', title = null, prompt = null, keepOfficial = false } = {}) {
  const a = getAsset(id);
  if (!a || a.status !== 'active') throw new Error('素材不存在');
  const t = detect(buf, a.original_name);
  if (!t || t.kind !== a.kind) throw new Error('新版本必须与原素材类型相同');
  if (buf.length > MAX_BYTES[t.kind]) throw new Error(`${KIND[t.kind]}不能超过 ${MAX_BYTES[t.kind] / 1048576} MB`);
  checkQuota(buf.length);
  const v = a.version + 1;
  const file = join(dirOf(id), `v${v}.${t.ext}`);
  writeFileSync(file, buf);
  let meta = { width: a.width, height: a.height, tags: a.auto_tags }, dh = a.dhash;
  if (t.kind === 'image') { meta = await imageTags(buf); dh = await dhash(buf); meta.tags = [...meta.tags, ...a.auto_tags.filter((x) => x.startsWith('AI:'))]; } // AI tags survive; re-checked below
  const ts = now(), actor = actorName('system');
  db.prepare('INSERT INTO asset_versions (asset_id, version, file, bytes, width, height, hash, source, note, title, prompt, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, v, `v${v}.${t.ext}`, buf.length, meta.width, meta.height, sha(buf), source, String(note).slice(0, 300), title, prompt, ts, actor);
  db.prepare('UPDATE assets SET version = ?, official = ?, ext = ?, mime = ?, width = ?, height = ?, bytes = ?, hash = ?, dhash = ?, auto_tags = ?, updated_at = ?, updated_by = ? WHERE id = ?')
    .run(v, keepOfficial ? a.official : v, t.ext, t.mime, meta.width, meta.height, buf.length, sha(buf), dh, JSON.stringify(meta.tags), ts, actor, id);
  if (!keepOfficial) await makeDerivatives(id, file, t.kind, t.ext, buf);
  if (t.kind === 'image') aiTag(id).catch(() => {});
  return getAsset(id);
}
/** Roll back = a new version with the content of an older one (history is never rewritten). */
export async function rollback(id, version, note = '') {
  const f = versionFile(id, version);
  if (!f) throw new Error('版本不存在');
  return addVersion(id, readFileSync(f), { source: 'rollback', note: note || `回滚到 v${version}` });
}
export async function setOfficial(id, version) {
  const a = getAsset(id);
  const f = versionFile(id, version);
  if (!a || !f) throw new Error('版本不存在');
  db.prepare('UPDATE assets SET official = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(Number(version), now(), actorName('system'), id);
  await makeDerivatives(id, f, a.kind, a.ext, readFileSync(f));
}

// ---------------------------------------------------------------- edit, move, tag, trash
export function updateAsset(id, { title, tags, folderId } = {}) {
  const a = getAsset(id);
  if (!a) throw new Error('素材不存在');
  if (folderId !== undefined && folderId && !getFolder(folderId)) throw new Error('文件夹不存在');
  const productId = folderId !== undefined ? (folderId ? folderPath(folderId).map((f) => f.product_id).filter(Boolean).pop() || null : null) : a.product_id;
  db.prepare('UPDATE assets SET title = ?, tags = ?, folder_id = ?, product_id = ?, updated_at = ?, updated_by = ? WHERE id = ?')
    .run(title !== undefined ? String(title).slice(0, 200) : a.title, JSON.stringify(tags !== undefined ? [...new Set(tags.map((x) => String(x).trim()).filter(Boolean))].slice(0, 30) : a.tags),
      folderId !== undefined ? folderId || null : a.folder_id, productId, now(), actorName('system'), id);
  return getAsset(id);
}
export function bulkTag(ids, add = [], remove = []) {
  for (const id of ids) { const a = getAsset(id); if (!a) continue; updateAsset(id, { tags: [...a.tags.filter((t) => !remove.includes(t)), ...add] }); }
}
export function bulkMove(ids, folderId) { if (folderId && !getFolder(folderId)) throw new Error('文件夹不存在'); for (const id of ids) updateAsset(id, { folderId }); }
export function trash(ids) { db.prepare(`UPDATE assets SET status = 'trashed', trashed_at = ?, updated_by = ? WHERE id IN (${ids.map(() => '?').join(',')}) AND status = 'active'`).run(now(), actorName('system'), ...ids); }
export function restore(ids) { db.prepare(`UPDATE assets SET status = 'active', trashed_at = NULL, updated_by = ? WHERE id IN (${ids.map(() => '?').join(',')}) AND status = 'trashed'`).run(actorName('system'), ...ids); }
/** Permanent delete: only from the recycle bin. */
export function purge(ids) {
  let n = 0;
  for (const id of ids) {
    const a = getAsset(id);
    if (!a || a.status !== 'trashed') continue;
    rmSync(dirOf(id), { recursive: true, force: true });
    db.prepare('DELETE FROM asset_versions WHERE asset_id = ?').run(id);
    db.prepare('DELETE FROM assets WHERE id = ?').run(id);
    n++;
  }
  return n;
}
export function purgeExpired() {
  const cutoff = new Date(Date.now() - settings().trashDays * 864e5).toISOString();
  return purge(db.prepare("SELECT id FROM assets WHERE status = 'trashed' AND trashed_at < ?").all(cutoff).map((r) => r.id));
}

// ---------------------------------------------------------------- search
export function search({ folderId = '', productId = '', kind = '', tag = '', ext = '', q = '', uploader = '', from = '', to = '', minWidth = '', status = 'active', sort = 'new', limit = 120, offset = 0, recursive = true } = {}) {
  const where = ['status = ?'], args = [status];
  if (folderId) {
    const ids = [folderId];
    if (recursive) for (let i = 0; i < ids.length; i++) ids.push(...childFolders(ids[i]).map((f) => f.id));
    where.push(`folder_id IN (${ids.map(() => '?').join(',')})`); args.push(...ids);
  }
  if (productId) { where.push('product_id = ?'); args.push(productId); }
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (ext) { where.push('ext = ?'); args.push(ext); }
  if (tag) { where.push('(tags LIKE ? OR auto_tags LIKE ?)'); args.push(`%"${tag}"%`, `%"${tag}"%`); }
  if (q) { where.push('(original_name LIKE ? OR title LIKE ? OR product_id LIKE ? OR tags LIKE ?)'); args.push(...Array(4).fill(`%${q}%`)); }
  if (uploader) { where.push('created_by = ?'); args.push(uploader); }
  if (from) { where.push('created_at >= ?'); args.push(from); }
  if (to) { where.push('created_at <= ?'); args.push(`${to}T23:59:59.999Z`); }
  if (minWidth) { where.push('width >= ?'); args.push(Number(minWidth)); }
  const order = { new: 'created_at DESC', old: 'created_at', name: 'original_name', size: 'bytes DESC' }[sort] || 'created_at DESC';
  const w = `WHERE ${where.join(' AND ')}`;
  return { total: db.prepare(`SELECT COUNT(*) n FROM assets ${w}`).get(...args).n, rows: db.prepare(`SELECT * FROM assets ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset).map((a) => ({ ...a, tags: J(a.tags, []), auto_tags: J(a.auto_tags, []) })) };
}
/** Search by image: nearest perceptual hashes (0 = identical, ≤10 = very similar). */
export async function similar(buf, { limit = 24, maxDistance = 16 } = {}) {
  const h = await dhash(buf);
  return db.prepare("SELECT * FROM assets WHERE status = 'active' AND dhash IS NOT NULL").all()
    .map((a) => ({ ...a, tags: J(a.tags, []), auto_tags: J(a.auto_tags, []), distance: hamming(h, a.dhash) })).filter((a) => a.distance <= maxDistance).sort((a, b) => a.distance - b.distance).slice(0, limit);
}
export const allTags = () => [...new Set(db.prepare("SELECT tags, auto_tags FROM assets WHERE status = 'active'").all().flatMap((r) => [...J(r.tags, []), ...J(r.auto_tags, [])]))].sort();
export const uploaders = () => db.prepare('SELECT DISTINCT created_by FROM assets ORDER BY created_by').all().map((r) => r.created_by);

// ---------------------------------------------------------------- batch download (zip, stored)
export function zip(ids) {
  const files = [], central = [];
  let offset = 0;
  const used = new Set();
  for (const id of ids) {
    const a = getAsset(id);
    if (!a) continue;
    const f = officialFile(a);
    if (!f || !existsSync(f)) continue;
    const data = readFileSync(f);
    let name = (a.original_name || `${a.id}.${a.ext}`).replace(/[\\/:*?"<>|]/g, '_');
    if (!/\.\w+$/.test(name)) name += `.${a.ext}`;
    for (let i = 2; used.has(name); i++) name = name.replace(/(\.\w+)$/, `-${i}$1`);
    used.add(name);
    const nb = Buffer.from(name, 'utf8'), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nb.length, 26);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nb.length, 28); cen.writeUInt32LE(offset, 42);
    files.push(local, nb, data); central.push(cen, nb);
    offset += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, cd, end]);
}

// ---------------------------------------------------------------- AI tags (vision), optional
export const AI_TAGS = ['白底图', '场景图', '生活方式图', '信息图', '尺寸图', 'SKU 图', '细节图', '包装图', '安装图'];
/** Ask the vision model what kind of e-commerce image this is. Adds tags from AI_TAGS only; never fails the upload. */
export async function aiTag(id) {
  const { aiEnabled } = await import('../config.js');
  if (!aiEnabled()) return null;
  const a = getAsset(id);
  const f = a && a.kind === 'image' && (thumbFile(id) || officialFile(a));
  if (!f) return null;
  try {
    const { completeWithImage, parseJson } = await import('../llm.js');
    const reply = await completeWithImage({ system: 'You classify e-commerce product images. Reply with JSON only.', user: `Which of these apply to the image? ${JSON.stringify(AI_TAGS)} (白底图=plain white background product shot, 场景图=product in a scene, 生活方式图=people using it, 信息图=features/specs graphic with text, 尺寸图=dimensions drawing, SKU 图=colour/variant swatch, 细节图=close-up detail, 包装图=packaging, 安装图=installation). Reply {"tags":[...]}`, image: { data: readFileSync(f), mime: f.endsWith('.webp') ? 'image/webp' : a.mime } });
    const tags = (parseJson(reply).tags || []).filter((t) => AI_TAGS.includes(t));
    const cur = getAsset(id);
    db.prepare('UPDATE assets SET auto_tags = ? WHERE id = ?').run(JSON.stringify([...new Set([...cur.auto_tags, ...tags.map((t) => `AI:${t}`)])]), id);
    return tags;
  } catch (e) { console.error('[assets] ai tag', e.message); return null; }
}

export function startAssetJobs() {
  setInterval(() => { try { const n = purgeExpired(); if (n) console.log(`[assets] purged ${n} from the recycle bin`); } catch (e) { console.error('[assets]', e.message); } }, 6 * 3600e3).unref();
}
