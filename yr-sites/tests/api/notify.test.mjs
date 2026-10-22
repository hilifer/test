// Black-box: important event notifications over HTTP — choosing events on one's own page (only allowed ones), contact
// details checked, test message, administrator's group push settings and overview, a real event (customer writes in a
// chat a salesperson took over) @-mentioning that person in the WeCom group, English. IDs NS-xx.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, flash, waitFor } from '../helpers/server.mjs';
import { mockServer } from '../helpers/mock-http.mjs';

let api, wecom;
const sent = [];
before(async () => {
  wecom = await mockServer((call) => { sent.push(call.body); return { json: { errcode: 0 } }; });
  api = await startServer({ site: 'led', env: { WECOM_WEBHOOK_URL: wecom.url } });
  for (const [u, role] of [['sue', 'service'], ['wes', 'warehouse']]) await api.form('/admin/users/new', { username: u, name: u.toUpperCase(), role, password: PW });
});
after(async () => { await api.stop(); await wecom.close(); });

const PW = 'Str0ngPassw0rd';
const auth = (u) => ({ authorization: 'Basic ' + Buffer.from(`${u}:${PW}`).toString('base64') });
const ADMIN = { authorization: 'Basic ' + Buffer.from('admin:test-pass').toString('base64') };
const form = (h, path, data) => fetch(api.url + path, { method: 'POST', redirect: 'manual', headers: { ...h, 'content-type': 'application/x-www-form-urlencoded' }, body: data instanceof URLSearchParams ? data : new URLSearchParams(data) });
const page = async (path, h) => (await fetch(api.url + path, { headers: h })).text();

test('NS-01a own page has the notifications section listing only events the role may see', async () => {
  const wes = await page('/admin/me', auth('wes'));
  assert.match(wes, /<h2 id="notify">消息提醒<\/h2>/);
  assert.match(wes, /value="shipment_exception"/);
  assert.doesNotMatch(wes, /value="payment"/);
});

test('NS-01b a test message is refused before the settings have been saved', async () => {
  assert.match(flash(await form(auth('wes'), '/admin/me/notify/test', {})).err, /请先保存/);
});

test('NS-01c saving events without any contact detail is refused', async () => {
  assert.match(flash(await form(auth('wes'), '/admin/me/notify', { events: 'shipment_exception' })).err, /至少填写企业微信账号/);
});

test('NS-01d saving events with a WeCom account succeeds and the page shows the saved choice', async () => {
  assert.match(flash(await form(auth('wes'), '/admin/me/notify', new URLSearchParams([['events', 'shipment_exception'], ['events', 'payment'], ['wecom_id', 'wes.li']]))).ok, /提醒设置已保存/);
  const after = await page('/admin/me', auth('wes'));
  assert.match(after, /value="shipment_exception" checked/);
  assert.match(after, /name="wecom_id" value="wes.li"/);
  assert.doesNotMatch(after, /value="payment"/);
});

test('NS-01e the test message reaches the group and @-mentions the saved WeCom account', async () => {
  sent.length = 0;
  assert.match(flash(await form(auth('wes'), '/admin/me/notify/test', {})).ok, /测试消息已发送/);
  await waitFor(() => sent.some((b) => b.msgtype === 'text'));
  assert.deepEqual(sent.find((b) => b.msgtype === 'text').text.mentioned_list, ['wes.li']);
});

test('NS-02a non-administrators cannot open the notification settings overview (403)', async () => {
  assert.equal((await fetch(`${api.url}/admin/users/notify`, { headers: auth('sue') })).status, 403);
});

test('NS-02b administrator overview lists each event with its group push mode and who subscribed', async () => {
  const html = await page('/admin/users/notify', ADMIN);
  assert.match(html, /<b>物流异常<\/b><\/td><td><select name="mode_shipment_exception"[\s\S]*?<\/select><\/td><td>wes<\/td>/);
});

test('NS-02c administrator overview lists recent pushes, including the test message', async () => {
  assert.match(await page('/admin/users/notify', ADMIN), /测试提醒/);
});

test('NS-02d administrator saves group push modes and the chosen mode is shown selected', async () => {
  assert.match(flash(await form(ADMIN, '/admin/users/notify', { mode_server_error: 'subscribers', mode_payment: 'off' })).ok, /已保存/);
  assert.match(await page('/admin/users/notify', ADMIN), /<option value="subscribers" selected>/);
});

test('NS-02e an unknown group push mode is rejected', async () => {
  assert.match(flash(await form(ADMIN, '/admin/users/notify', { mode_payment: 'loud' })).err, /群推送方式无效/);
});

test('NS-02f the users page links to the notification settings', async () => {
  assert.match(await page('/admin/users', ADMIN), /<a href="\/admin\/users\/notify">消息提醒设置<\/a>/);
});

test('NS-03a a real event: the customer writes in a chat Sue took over → the group gets a message with the customer text', async () => {
  await form(auth('sue'), '/admin/me/notify', { events: 'chat_waiting', mobile: '13900000000' });
  const { sessionId } = await (await api.json('/api/chat', { message: 'Can I talk to a person please?' })).json();
  await form(auth('sue'), `/admin/conv/${sessionId}/takeover`, {});
  sent.length = 0;
  await api.json('/api/chat', { message: 'Hello, are you there?', sessionId });
  await waitFor(() => sent.some((b) => b.msgtype === 'text'));
  assert.match(sent.find((b) => b.msgtype === 'markdown').markdown.content, /在线客户发来新消息[\s\S]*Hello, are you there\?/);
});

test('NS-03b the chat event @-mentions only Sue (by her mobile)', async () => {
  assert.deepEqual(sent.find((b) => b.msgtype === 'text').text.mentioned_mobile_list, ['13900000000']);
});

/** Visible text of a page in English with options, scripts and translate="no" parts removed; returns the first Chinese left. */
const chineseLeft = async (p, h) => {
  const text = (await page(p, { ...h, cookie: 'yr_admin_lang=en' })).replace(/<script[\s\S]*?<\/script>|<option[\s\S]*?<\/option>|<[^>]+translate="no"[^>]*>[\s\S]*?<\/[a-z]+>|<[^>]+>/g, ' ');
  return text.match(new RegExp('[^\\s]{0,20}[\\u3400-\\u9fff]+[^\\s]{0,20}'));
};

test('NS-04a the own notification page in English has no Chinese left', async () => {
  const left = await chineseLeft('/admin/me', auth('sue'));
  assert.equal(left, null, `/admin/me: ${left?.[0]}`);
});

test('NS-04b the administrator notification overview in English has no Chinese left', async () => {
  const left = await chineseLeft('/admin/users/notify', ADMIN);
  assert.equal(left, null, `/admin/users/notify: ${left?.[0]}`);
});
