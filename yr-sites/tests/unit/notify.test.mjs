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
  test('NT-01 each person only gets the events they may see; contact details checked', () => {
    assert.ok(N.allowedEvents(staff('wes')).includes('shipment_exception'));
    assert.ok(!N.allowedEvents(staff('wes')).includes('payment'));
    assert.ok(N.allowedEvents(staff('wes')).includes('approval'), 'anyone may be an approver');
    const p = N.savePrefs(staff('wes'), { events: ['shipment_exception', 'payment', 'nonsense'], wecom_id: 'wes.li' });
    assert.deepEqual(p.events, ['shipment_exception']);
    assert.throws(() => N.savePrefs(staff('wes'), { events: ['shipment_exception'] }), /至少填写企业微信账号/);
    assert.throws(() => N.savePrefs(staff('wes'), { events: [], mobile: 'abc' }), /手机号格式/);
    assert.throws(() => N.savePrefs(staff('wes'), { events: [], wecom_id: 'a b' }), /企业微信账号只能/);
    assert.throws(() => N.savePrefs(staff('wes'), { events: [], email_on: true }), /请填写邮箱/);
    assert.throws(() => N.savePrefs(staff('wes'), { events: [], email: 'x@' }), /邮箱格式/);
  });
});

describe('delivery', () => {
  test('NT-02 an event alert goes to the group and @-mentions the subscribers (WeCom account or mobile); logged', async () => {
    N.savePrefs(staff('fay'), { events: ['payment'], wecom_id: 'fay01' });
    N.savePrefs(staff('ozz'), { events: ['backup_failed'], mobile: '13800000000' });
    await alertOps('网店订单已付款', ['SO-1 · USD 100'], { event: 'payment' });
    assert.equal(mds().length, 1);
    assert.match(mds()[0].markdown.content, /网店订单已付款[\s\S]*SO-1/);
    assert.deepEqual(texts()[0].text.mentioned_list, ['fay01']);
    assert.deepEqual(texts()[0].text.mentioned_mobile_list, []);
    sent.length = 0;
    await alertOps('数据库备份失败', ['disk full'], { event: 'backup_failed' });
    assert.deepEqual(texts()[0].text.mentioned_mobile_list, ['13800000000']);
    const [log] = N.recentLog(1);
    assert.deepEqual([log.event, log.grouped, log.mentioned], ['backup_failed', 1, ['ozz']]);
  });
  test('NT-03 no subscribers: a plain group message, no mention; alerts without an event unchanged', async () => {
    await alertOps('新的商品评价待审核', ['x']);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].msgtype, 'markdown');
    sent.length = 0;
    await alertOps('服务器新错误', ['boom'], { event: 'server_error' });
    assert.deepEqual(sent.map((b) => b.msgtype), ['markdown']);
  });
  test('NT-04 group modes: "only when subscribed" stays quiet without subscribers; "off" never posts but still e-mails', async () => {
    N.saveGroupModes({ server_error: 'subscribers', backup_failed: 'off' });
    assert.throws(() => N.saveGroupModes({ payment: 'loud' }), /群推送方式无效/);
    await alertOps('服务器新错误', ['boom'], { event: 'server_error' });
    assert.equal(sent.length, 0);
    N.savePrefs(staff('ozz'), { events: ['backup_failed', 'server_error'], mobile: '13800000000', email: 'ozz@x.test', email_on: true });
    await alertOps('服务器新错误', ['boom'], { event: 'server_error' });
    assert.deepEqual(sent.map((b) => b.msgtype), ['markdown', 'text']);
    sent.length = 0;
    await alertOps('数据库备份失败', ['disk full'], { event: 'backup_failed' });
    assert.equal(sent.length, 0, 'not to the group');
    const [log] = N.recentLog(1);
    assert.deepEqual([log.grouped, log.mentioned, log.emailed], [0, [], ['ozz']]);
    N.saveGroupModes({ server_error: 'all', backup_failed: 'all' });
  });
  test('NT-05 "to" narrows to the people concerned (the agent of a chat, the approvers); inactive staff are skipped', async () => {
    N.savePrefs(staff('sue'), { events: ['chat_waiting'], wecom_id: 'sue01' });
    N.savePrefs(staff('sam'), { events: ['chat_waiting', 'lead_a'], wecom_id: 'sam01' });
    await alertOps('在线客户发来新消息（人工接待中）', ['hi'], { event: 'chat_waiting', to: ['sue'] });
    assert.deepEqual(texts()[0].text.mentioned_list, ['sue01']);
    sent.length = 0;
    N.savePrefs(staff('old'), { events: ['lead_a'], wecom_id: 'old01' });
    saveStaff({ id: staff('old').id, username: 'old', name: 'OLD', role: 'sales', active: false });
    await alertLead({ grade: 'A', company: 'Big Buyer' });
    assert.deepEqual(texts()[0].text.mentioned_list, ['sam01']);
  });
  test('NT-06 leads: grade A and B are separate events; a hand-off is its own event', async () => {
    await alertLead({ grade: 'B', company: 'Mid Buyer' });
    assert.equal(texts().length, 0, 'nobody subscribed to grade B');
    assert.match(mds()[0].markdown.content, /新B级线索/);
    sent.length = 0;
    N.savePrefs(staff('sue'), { events: ['chat_waiting', 'handoff'], wecom_id: 'sue01' });
    await alertLead({ grade: 'A' }, { handoff: true, reason: 'price' });
    assert.deepEqual(texts()[0].text.mentioned_list, ['sue01']);
  });
  test('NT-07 overview and test message to oneself', async () => {
    const o = N.overview();
    assert.deepEqual(o.find((x) => x.event === 'chat_waiting').people.sort(), ['sam', 'sue']);
    assert.equal(o.find((x) => x.event === 'payment').mode, 'all');
    await N.sendTest(staff('fay'));
    assert.match(mds()[0].markdown.content, /测试提醒[\s\S]*这是发给 FAY 的测试消息/);
    assert.deepEqual(texts()[0].text.mentioned_list, ['fay01']);
  });
});
