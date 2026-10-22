// Module: server/src/notify/subscriptions.js with server/src/alerts.js — per-person event subscriptions, WeCom @-mentions
// (account or mobile), e-mail, group push modes, alerts narrowed to the people concerned, push log. A mock WeCom webhook
// records what is sent. IDs NT-xx.
import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempEnv } from '../helpers/env.mjs';
import { mockServer } from '../helpers/mock-http.mjs';

const sent = [];
const wecom = await mockServer((call) => { sent.push(call.body); return { json: { errcode: 0 } }; });
useTempEnv({ site: 'led', WECOM_WEBHOOK_URL: wecom.url });
const N = await import('../../server/src/notify/subscriptions.js');
const { alertOps, alertLead } = await import('../../server/src/alerts.js');
const { saveStaff, listStaff } = await import('../../server/src/auth.js');
after(() => wecom.close());
beforeEach(() => { sent.length = 0; });

const PW = 'Str0ngPassw0rd';
for (const [username, role] of [['sam', 'sales'], ['sue', 'service'], ['fay', 'finance'], ['wes', 'warehouse'], ['ozz', 'ops'], ['old', 'sales']]) saveStaff({ username, name: username.toUpperCase(), role, password: PW, active: true });
const staff = (u) => listStaff().find((s) => s.username === u);
const texts = () => sent.filter((b) => b.msgtype === 'text');
const mds = () => sent.filter((b) => b.msgtype === 'markdown');

describe('subscriptions', () => {
  test('NT-01a each role may subscribe only to the events it may see (approvals open to all)', () => {
    assert.ok(N.allowedEvents(staff('wes')).includes('shipment_exception'));
    assert.ok(!N.allowedEvents(staff('wes')).includes('payment'));
    assert.ok(N.allowedEvents(staff('wes')).includes('approval'), 'anyone may be an approver');
  });
  test('NT-01b saving drops events the person may not see and unknown events', () => {
    const p = N.savePrefs(staff('wes'), { events: ['shipment_exception', 'payment', 'nonsense'], wecom_id: 'wes.li' });
    assert.deepEqual(p.events, ['shipment_exception']);
  });
  test('NT-01c subscribing without a WeCom account or mobile is refused', () => {
    assert.throws(() => N.savePrefs(staff('wes'), { events: ['shipment_exception'] }), /至少填写企业微信账号/);
  });
  test('NT-01d a malformed mobile number is refused', () => {
    assert.throws(() => N.savePrefs(staff('wes'), { events: [], mobile: 'abc' }), /手机号格式/);
  });
  test('NT-01e a WeCom account with invalid characters is refused', () => {
    assert.throws(() => N.savePrefs(staff('wes'), { events: [], wecom_id: 'a b' }), /企业微信账号只能/);
  });
  test('NT-01f turning e-mail on without an address is refused', () => {
    assert.throws(() => N.savePrefs(staff('wes'), { events: [], email_on: true }), /请填写邮箱/);
  });
  test('NT-01g a malformed e-mail address is refused', () => {
    assert.throws(() => N.savePrefs(staff('wes'), { events: [], email: 'x@' }), /邮箱格式/);
  });
});

describe('delivery', () => {
  test('NT-02a an event alert is posted to the group and @-mentions subscribers by WeCom account', async () => {
    N.savePrefs(staff('fay'), { events: ['payment'], wecom_id: 'fay01' });
    N.savePrefs(staff('ozz'), { events: ['backup_failed'], mobile: '13800000000' });
    await alertOps('网店订单已付款', ['SO-1 · USD 100'], { event: 'payment' });
    assert.equal(mds().length, 1);
    assert.match(mds()[0].markdown.content, /网店订单已付款[\s\S]*SO-1/);
    assert.deepEqual(texts()[0].text.mentioned_list, ['fay01']);
    assert.deepEqual(texts()[0].text.mentioned_mobile_list, []);
  });
  test('NT-02b a subscriber with only a mobile number is @-mentioned by mobile', async () => {
    await alertOps('数据库备份失败', ['disk full'], { event: 'backup_failed' });
    assert.deepEqual(texts()[0].text.mentioned_mobile_list, ['13800000000']);
  });
  test('NT-02c the push is logged with event, group post and mentioned people', () => {
    const [log] = N.recentLog(1);
    assert.deepEqual([log.event, log.grouped, log.mentioned], ['backup_failed', 1, ['ozz']]);
  });
  test('NT-03a an alert without an event is a plain group message', async () => {
    await alertOps('新的商品评价待审核', ['x']);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].msgtype, 'markdown');
  });
  test('NT-03b an event without subscribers is a group message with no mention', async () => {
    await alertOps('服务器新错误', ['boom'], { event: 'server_error' });
    assert.deepEqual(sent.map((b) => b.msgtype), ['markdown']);
  });
  test('NT-04a an invalid group push mode is refused', () => {
    N.saveGroupModes({ server_error: 'subscribers', backup_failed: 'off' });
    assert.throws(() => N.saveGroupModes({ payment: 'loud' }), /群推送方式无效/);
  });
  test('NT-04b "only when subscribed" stays quiet without subscribers', async () => {
    await alertOps('服务器新错误', ['boom'], { event: 'server_error' });
    assert.equal(sent.length, 0);
  });
  test('NT-04c "only when subscribed" posts and mentions once someone subscribes', async () => {
    N.savePrefs(staff('ozz'), { events: ['backup_failed', 'server_error'], mobile: '13800000000', email: 'ozz@x.test', email_on: true });
    await alertOps('服务器新错误', ['boom'], { event: 'server_error' });
    assert.deepEqual(sent.map((b) => b.msgtype), ['markdown', 'text']);
  });
  test('NT-04d "off" never posts to the group but still e-mails the subscribers', async () => {
    try {
      await alertOps('数据库备份失败', ['disk full'], { event: 'backup_failed' });
      assert.equal(sent.length, 0, 'not to the group');
      const [log] = N.recentLog(1);
      assert.deepEqual([log.grouped, log.mentioned, log.emailed], [0, [], ['ozz']]);
    } finally { N.saveGroupModes({ server_error: 'all', backup_failed: 'all' }); }
  });
  test('NT-05a "to" narrows the mentions to the people concerned (the agent of a chat)', async () => {
    N.savePrefs(staff('sue'), { events: ['chat_waiting'], wecom_id: 'sue01' });
    N.savePrefs(staff('sam'), { events: ['chat_waiting', 'lead_a'], wecom_id: 'sam01' });
    await alertOps('在线客户发来新消息（人工接待中）', ['hi'], { event: 'chat_waiting', to: ['sue'] });
    assert.deepEqual(texts()[0].text.mentioned_list, ['sue01']);
  });
  test('NT-05b inactive staff are not mentioned', async () => {
    N.savePrefs(staff('old'), { events: ['lead_a'], wecom_id: 'old01' });
    saveStaff({ id: staff('old').id, username: 'old', name: 'OLD', role: 'sales', active: false });
    await alertLead({ grade: 'A', company: 'Big Buyer' });
    assert.deepEqual(texts()[0].text.mentioned_list, ['sam01']);
  });
  test('NT-06a a grade-B lead is its own event: posted to the group, grade-A subscribers not mentioned', async () => {
    await alertLead({ grade: 'B', company: 'Mid Buyer' });
    assert.equal(texts().length, 0, 'nobody subscribed to grade B');
    assert.match(mds()[0].markdown.content, /新B级线索/);
  });
  test('NT-06b a hand-off is its own event and mentions its subscribers', async () => {
    N.savePrefs(staff('sue'), { events: ['chat_waiting', 'handoff'], wecom_id: 'sue01' });
    await alertLead({ grade: 'A' }, { handoff: true, reason: 'price' });
    assert.deepEqual(texts()[0].text.mentioned_list, ['sue01']);
  });
  test('NT-07a the overview lists subscribers and the group mode per event', () => {
    const o = N.overview();
    assert.deepEqual(o.find((x) => x.event === 'chat_waiting').people.sort(), ['sam', 'sue']);
    assert.equal(o.find((x) => x.event === 'payment').mode, 'all');
  });
  test('NT-07b a test message is posted and @-mentions oneself', async () => {
    await N.sendTest(staff('fay'));
    assert.match(mds()[0].markdown.content, /测试提醒[\s\S]*这是发给 FAY 的测试消息/);
    assert.deepEqual(texts()[0].text.mentioned_list, ['fay01']);
  });
});
