// Lists the Chinese text fragments in the admin code (used by the i18n completeness test and to update en.js).
// Customer-facing modules have their own EN/ZH texts and are excluded.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const EXCLUDE = /(storefront|portal|pi|mailer|agent|tools|mcp|notify|writer|geo|feeds|extract|en|alerts|copy-data)\.js$/;
export const FRAGMENT = /[\u4e00-\u9fff][^\x00-\x1f`'"<>${}=\\]*[\u4e00-\u9fff）」】]|[\u4e00-\u9fff]/g;

export function fragments(root) {
  const files = [];
  (function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js') && !EXCLUDE.test(p)) files.push(p); } })(root);
  const out = new Map();
  for (const f of files) {
    const text = readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n'); // skip comments
    for (const m of text.matchAll(FRAGMENT)) { const k = m[0].trim(); if (!out.has(k)) out.set(k, relative(root, f)); }
  }
  return out;
}

if (process.argv[1]?.endsWith('extract.mjs')) {
  const { EN } = await import('./en.js').catch(() => ({ EN: {} }));
  const missing = [...fragments(new URL('..', import.meta.url).pathname)].filter(([k]) => !(k in EN));
  console.log(JSON.stringify(Object.fromEntries(missing), null, 0));
  console.error(`${missing.length} missing`);
}
