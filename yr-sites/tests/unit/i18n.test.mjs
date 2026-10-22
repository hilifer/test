// Module: server/src/i18n — admin English. Completeness of the dictionary and the safety rules of the translator. IDs IN-xx.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { fragments } from '../../server/src/i18n/extract.mjs';
import { EN } from '../../server/src/i18n/en.js';
import { toEnglish, translate } from '../../server/src/i18n/index.js';

test('IN-01 every Chinese text in the admin code has an English translation (run node server/src/i18n/extract.mjs to list gaps)', () => {
  const missing = [...fragments(fileURLToPath(new URL('../../server/src', import.meta.url)))].filter(([k]) => !(k in EN)).map(([k, f]) => `${f}: ${k}`);
  assert.deepEqual(missing, []);
});

test('IN-02a a page is translated with English punctuation and <html lang> switched to en', () => {
  assert.equal(toEnglish('<html lang="zh-CN"><h2>商品（13）</h2>'), '<html lang="en"><h2>Products (13)</h2>');
});

test('IN-02b a phrase with a number is translated with English spacing', () => {
  assert.equal(translate('有 3 位客户正在等待人工回复', 'en').trim(), '3 customer(s) waiting for a staff reply');
});

test('IN-02c a phrase with Chinese parentheses is translated with English punctuation', () => {
  assert.equal(translate('已更新 2 个排序号（发布后网站生效）', 'en'), 'Updated 2 sort numbers (live after publishing)');
});

test('IN-02d translating to Chinese leaves the text unchanged', () => {
  assert.equal(translate('保存', 'zh'), '保存');
});

const html3 = '<input name="nameZh" value="保存 防爆灯"><textarea name="t">## 保存\n已发货</textarea><div>客户说：我们已发货了吗</div><button>保存</button>';
test('IN-03a form field values are never translated', () => {
  assert.match(toEnglish(html3), /value="保存 防爆灯"/);
});

test('IN-03b textarea contents are never translated', () => {
  assert.match(toEnglish(html3), /<textarea name="t">## 保存\n已发货<\/textarea>/);
});

test('IN-03c known phrases inside a longer Chinese sentence are left alone', () => {
  assert.match(toEnglish(html3), /我们已发货了吗/);
});

test('IN-03d a standalone phrase in an element is translated', () => {
  assert.match(toEnglish(html3), /<button>Save<\/button>/);
});

test('IN-04 status labels come from the shared data dictionary (one source for both languages)', () => {
  assert.equal(EN['待付定金'], 'Awaiting deposit');
  assert.equal(EN['30% 定金，70% 发货前付清'], '30% T/T deposit, 70% before shipment');
  assert.equal(translate('生产/备货中', 'en'), 'In production');
});
