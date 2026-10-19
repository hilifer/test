// Make a static, relative-link copy of a built site for previews hosted under any path.
// The chat widget falls back to its built-in rule engine because there is no API.
// Usage: node scripts/make-preview.mjs <dist> <out>
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join, relative, dirname, posix } from 'node:path';
const [src, out] = process.argv.slice(2);
rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });
// some static hosts reserve names starting with "_"
import { renameSync, existsSync } from 'node:fs';
if (existsSync(join(out, '_astro'))) renameSync(join(out, '_astro'), join(out, 'astro-assets'));
const files = [];
(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } })(out);
const exists = new Set(files.map((f) => '/' + relative(out, f).split('\\').join('/')));
function rel(fromFile, target) {
  const [path, rest = ''] = target.split(/(?=[?#])/);
  let t = path;
  if (t.endsWith('/')) t += 'index.html';
  else if (!exists.has(t) && exists.has(t + '/index.html')) t += '/index.html';
  const fromDir = posix.dirname('/' + relative(out, fromFile).split('\\').join('/'));
  let r = posix.relative(fromDir, t) || 'index.html';
  if (!r.startsWith('.')) r = './' + r;
  return r + rest;
}
for (const f of files) {
  if (f.endsWith('.html')) {
    let s = readFileSync(f, 'utf8').replaceAll('/_astro/', '/astro-assets/');
    s = s.replace(/(href|src|action)="(\/(?!\/)[^"]*)"/g, (m, a, u) => `${a}="${rel(f, u)}"`);
    s = s.replace(/url\((['"]?)(\/(?!\/)[^)'"]+)\1\)/g, (m, q, u) => `url(${q}${rel(f, u)}${q})`);
    // internal paths inside inline JSON / config scripts
    s = s.replace(/(<script[^>]*>)([\s\S]*?)(<\/script>)/g, (m, o, body, c) => {
      if (!/application\/json|YR_CHAT/.test(o + body)) return m;
      body = body.replace(/"productBase":"(\/[^"]*\/)"/g, (mm, u) => { const d = posix.dirname('/' + relative(out, f).split('\\').join('/')); return `"productBase":"${posix.relative(d, u) || '.'}/"`; });
      return o + body.replace(/"(\/(?:products|news|zh|calculator|assets)[a-z0-9_\-./]*)"/g, (mm, u) => `"${rel(f, u)}"`) + c;
    });
    s = s.replace('window.YR_CHAT = chatCfg;', 'window.YR_CHAT = Object.assign(chatCfg, { api: "./__no_api__", leadsApi: "./__no_api__", linkSuffix: "index.html" });');
    writeFileSync(f, s);
  } else if (f.endsWith('.css')) {
    let s = readFileSync(f, 'utf8');
    s = s.replace(/url\((['"]?)(\/(?!\/)[^)'"]+)\1\)/g, (m, q, u) => `url(${q}${rel(f, u)}${q})`);
    writeFileSync(f, s);
  }
}
console.log(`preview: ${files.length} files in ${out}`);
