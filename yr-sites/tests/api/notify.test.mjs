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

test('NS-01 own page: only events the role may see; contact details required; saved; test message reaches the group with an @', async () => {
  const wes = await page('/admin/me', auth('wes'));
  assert.match(wes, /<h2 id="notify">消息提醒<\/h2>/);
  assert.match(wes, /value="shipment_exception"/);
  assert.doesNotMatch(wes, /value="payment"/);
  assert.match(flash(await form(auth('wes'), '/admin/me/notify/test', {})).err, /请先保存/);
  assert.match(flash(await form(auth('wes'), '/admin/me/notify', { events: 'shipment_exception' })).err, /至少填写企业微信账号/);
  assert.match(flash(await form(auth('wes'), '/admin/me/notify', new URLSearchParams([['events', 'shipment_exception'], ['events', 'payment'], ['wecom_id', 'wes.li']]))).ok, /提醒设置已保存/);
  const after = await page('/admin/me', auth('wes'));
  assert.match(after, /value="shipment_exception" checked/);
  assert.match(after, /name="wecom_id" value="wes.li"/);
  sent.length = 0;
  assert.match(flash(await form(auth('wes'), '/admin/me/notify/test', {})).ok, /测试消息已发送/);
  await waitFor(() => sent.some((b) => b.msgtype === 'text'));
  assert.deepEqual(sent.find((b) => b.msgtype === 'text').text.mentioned_list, ['wes.li']);
});

test('NS-02 administrator: group push per event and who subscribed; recent pushes; others cannot open it', async () => {
  assert.equal((await fetch(`${api.url}/admin/users/notify`, { headers: auth('sue') })).status, 403);
  const html = await page('/admin/users/notify', ADMIN);
  assert.match(html, /<b>物流异常<\/b><\/td><td><select name="mode_shipment_exception"[\s\S]*?<\/select><\/td><td>wes<\/td>/);
  assert.match(html, /测试提醒/);
  assert.match(flash(await form(ADMIN, '/admin/users/notify', { mode_server_error: 'subscribers', mode_payment: 'off' })).ok, /已保存/);
  assert.match(await page('/admin/users/notify', ADMIN), /<option value="subscribers" selected>/);
  assert.match(flash(await form(ADMIN, '/admin/users/notify', { mode_payment: 'loud' })).err, /群推送方式无效/);
  assert.match(await page('/admin/users', ADMIN), /<a href="\/admin\/users\/notify">消息提醒设置<\/a>/);
});

test('NS-03 a real event: the customer writes in a chat Sue took over → the group message @-mentions Sue only', async () => {
  await form(auth('sue'), '/admin/me/notify', { events: 'chat_waiting', mobile: '13900000000' });
  const { sessionId } = await (await api.json('/api/chat', { message: 'Can I talk to a person please?' })).json();
  await form(auth('sue'), `/admin/conv/${sessionId}/takeover`, {});
  sent.length = 0;
  await api.json('/api/chat', { message: 'Hello, are you there?', sessionId });
  await waitFor(() => sent.some((b) => b.msgtype === 'text'));
  assert.match(sent.find((b) => b.msgtype === 'markdown').markdown.content, /在线客户发来新消息[\s\S]*Hello, are you there\?/);
  assert.deepEqual(sent.find((b) => b.msgtype === 'text').text.mentioned_mobile_list, ['13900000000']);
});

test('NS-04 English notification pages', async () => {
  for (const [p, h] of [['/admin/me', auth('sue')], ['/admin/users/notify', ADMIN]]) {
    const text = (await page(p, { ...h, cookie: 'yr_admin_lang=en' })).replace(/<script[\s\S]*?<\/script>|<option[\s\S]*?<\/option>|<[^>]+translate="no"[^>]*>[\s\S]*?<\/[a-z]+>|<[^>]+>/g, ' ');
    const left = text.match(new RegExp('[^\\s]{0,20}[\\u3400-\\u9fff]+[^\\s]{0,20}'));
    assert.equal(left, null, `${p}: ${left?.[0]}`);
  }
});
