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

test('IN-02 phrases, punctuation and spacing; <html lang> switched', () => {
  assert.equal(toEnglish('<html lang="zh-CN"><h2>商品（13）</h2>'), '<html lang="en"><h2>Products (13)</h2>');
  assert.equal(translate('有 3 位客户正在等待人工回复', 'en').trim(), '3 customer(s) waiting for a staff reply');
  assert.equal(translate('已更新 2 个排序号（发布后网站生效）', 'en'), 'Updated 2 sort numbers (live after publishing)');
  assert.equal(translate('保存', 'zh'), '保存');
});

test('IN-03 safety: form values and textareas are never translated; phrases inside Chinese sentences are left alone', () => {
  const html = '<input name="nameZh" value="保存 防爆灯"><textarea name="t">## 保存\n已发货</textarea><div>客户说：我们已发货了吗</div><button>保存</button>';
  const out = toEnglish(html);
  assert.match(out, /value="保存 防爆灯"/);
  assert.match(out, /<textarea name="t">## 保存\n已发货<\/textarea>/);
  assert.match(out, /我们已发货了吗/);
  assert.match(out, /<button>Save<\/button>/);
});

test('IN-04 status labels come from the shared data dictionary (one source for both languages)', () => {
  assert.equal(EN['待付定金'], 'Awaiting deposit');
  assert.equal(EN['30% 定金，70% 发货前付清'], '30% T/T deposit, 70% before shipment');
  assert.equal(translate('生产/备货中', 'en'), 'In production');
});
