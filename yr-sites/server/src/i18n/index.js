// Admin language (中文 / English). Pages are written in Chinese; for English the rendered HTML is translated phrase by
// phrase from en.js. Safety rules: form values and <textarea> contents are never touched (saving a page in English must
// not overwrite Chinese data), and a phrase is only replaced when it is not part of a longer Chinese run, so customers'
// Chinese messages and Chinese product names stay intact.
import { EN } from './en.js';

const CJK = '\\u3400-\\u9fff';
const keys = Object.keys(EN).filter((k) => EN[k] !== k).sort((a, b) => b.length - a.length);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PHRASE = new RegExp(`(?<![${CJK}])(?:${keys.map(esc).join('|')})(?![${CJK}])`, 'g');
const PUNCT = { '——': ' — ', '（': ' (', '）': ')', '：': ': ', '，': ', ', '。': '. ', '、': ', ', '；': '; ', '？': '?', '！': '!', '「': '"', '」': '"', '“': '"', '”': '"', '…': '…' };
const PUNCT_RE = new RegExp(`(?<![${CJK}])(?:——|[（）：，。、；？！「」“”])(?![${CJK}])`, 'g');
const PROTECT = /<textarea\b[\s\S]*?<\/textarea>|\svalue="[^"]*"/gi;
const alnum = /[A-Za-z0-9]/;

function translateText(t) {
  return t.replace(PHRASE, (m, off, all) => {
    let e = EN[m];
    if (!e) return e === '' ? '' : m;
    if (alnum.test(all[off - 1] || '') && alnum.test(e[0])) e = ' ' + e;
    const next = all[off + m.length] || '';
    if ((alnum.test(next) || (next === '"' && alnum.test(all[off + m.length + 1] || ''))) && alnum.test(e.at(-1))) e += ' '; // before a word or an opening quote
    return e;
  }).replace(PUNCT_RE, (m) => PUNCT[m]).replace(/(\S) +([),;!?])/g, '$1$2');
}

/** Translate a whole admin HTML page to English (protected parts left as they are). */
export function toEnglish(html) {
  let out = '', last = 0;
  for (const m of html.matchAll(PROTECT)) { out += translateText(html.slice(last, m.index)) + m[0]; last = m.index + m[0].length; }
  out += translateText(html.slice(last));
  return out.replace('<html lang="zh-CN">', '<html lang="en">');
}
export const translate = (s, lang) => (lang === 'en' ? translateText(String(s)) : String(s));
export const LANGS = { zh: '中文', en: 'English' };
