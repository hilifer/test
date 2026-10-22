// Black-box: live human takeover of website chats — staff reply from the admin, the AI pauses, the visitor's widget polls
// for staff messages, waiting indicator, release / 30-minute lapse, roles and CSRF. IDs LC-xx.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, flash } from '../helpers/server.mjs';

let api;
before(async () => { api = await startServer({ site: 'led' }); });
after(async () => { await api.stop(); });

const PW = 'Str0ngPassw0rd';
const as = (u) => ({
  get: (p) => fetch(api.url + p, { redirect: 'manual', headers: { authorization: 'Basic ' + Buffer.from(`${u}:${PW}`).toString('base64') } }),
  form: (p, d, h = {}) => fetch(api.url + p, { method: 'POST', redirect: 'manual', headers: { authorization: 'Basic ' + Buffer.from(`${u}:${PW}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded', ...h }, body: new URLSearchParams(d) }),
});
const chat = async (sessionId, message) => (await api.json('/api/chat', { sessionId, message })).json();
const poll = async (sid, after = 0) => (await api.get(`/api/chat/poll?sessionId=${sid}&after=${after}`)).json();
const ctx = {};

test('LC-01a visitor asks for a person → the chat is flagged in the admin list', async () => {
  for (const [u, role, name] of [['anna', 'sales', 'Anna Chen'], ['bob01', 'sales', 'Bob Li'], ['cnt1', 'content', 'C']]) await api.form('/admin/users/new', { username: u, name, role, password: PW });
  const r = await chat(undefined, 'Hi, I need 300 UFO high bays');
  ctx.sid = r.sessionId;
  await chat(ctx.sid, 'Can I talk to a person please?');
  const list = await (await as('anna').get('/admin/conversations')).text();
  assert.match(list, new RegExp(`/admin/conv/${ctx.sid}">接待`));
});

test('LC-01b the conversation page shows the AI is handling it and the visitor\'s messages', async () => {
  const page = await (await as('anna').get(`/admin/conv/${ctx.sid}`)).text();
  assert.match(page, /当前由 AI 接待/);
  assert.match(page, /300 UFO high bays/);
});

test('LC-02a a staff reply takes the chat over; the widget poll reports a human with the staff first name', async () => {
  assert.deepEqual(flash(await as('anna').form(`/admin/conv/${ctx.sid}/reply`, { text: 'Hello, this is Anna from sales. Where will the lights ship to?' })).err, null);
  ctx.p = await poll(ctx.sid);
  assert.equal(ctx.p.human, true);
  assert.equal(ctx.p.agent, 'Anna');
});

test('LC-02b the widget poll returns a join note then the staff reply with the first name', async () => {
  const p = ctx.p;
  assert.deepEqual(p.messages.map((m) => m.role), ['note', 'agent']);
  assert.equal(p.messages[1].name, 'Anna');
  assert.match(p.messages[1].content, /Where will the lights ship/);
});

test('LC-02c the widget poll does not expose staff usernames', async () => {
  assert.doesNotMatch(JSON.stringify(ctx.p), /anna@|"by"/);
});

test('LC-02d polling after the last id returns no messages', async () => {
  ctx.last = ctx.p.lastId;
  assert.deepEqual((await poll(ctx.sid, ctx.last)).messages, []);
});

test('LC-03a while a person is handling the chat the AI stays silent', async () => {
  const r = await chat(ctx.sid, 'To Houston, Texas.');
  assert.equal(r.reply, null);
  assert.equal(r.human, true);
  assert.equal(r.mode, 'human');
  assert.equal(r.agent, 'Anna');
});

test('LC-03b the admin list shows who handles the chat and that the customer is waiting', async () => {
  const list = await (await as('anna').get('/admin/conversations')).text();
  assert.match(list, /Anna Chen 接待中/);
  assert.match(list, /客户等待回复/);
  assert.match(list, /有 1 位客户正在等待人工回复/);
});

test('LC-03c staff sees the customer message live through the messages endpoint', async () => {
  const live = await (await as('anna').get(`/admin/conv/${ctx.sid}/messages?after=${ctx.last}`)).json();
  assert.match(live.html, /To Houston, Texas\./);
  assert.ok(live.lastId > ctx.last);
});

test('LC-03d a staff reply clears the waiting flag', async () => {
  await as('anna').form(`/admin/conv/${ctx.sid}/reply`, { text: 'Thanks — I will send a DDP Houston quote by e-mail today.' });
  assert.doesNotMatch(await (await as('anna').get('/admin/conversations')).text(), /客户等待回复/);
});

test('LC-04a a second colleague cannot reply to a chat someone else is handling', async () => {
  assert.match(flash(await as('bob01').form(`/admin/conv/${ctx.sid}/reply`, { text: 'Hi from Bob' })).err, /Anna Chen 正在接待/);
  assert.match(flash(await as('bob01').form(`/admin/conv/${ctx.sid}/reply`, { text: '' })).err, /请输入回复内容|正在接待/);
});

test('LC-04b release hands the chat back to the AI and the widget is told', async () => {
  await as('anna').form(`/admin/conv/${ctx.sid}/release`, {});
  const p = await poll(ctx.sid, ctx.last);
  assert.equal(p.human, false);
  assert.match(p.messages.at(-1).content, /AI assistant is back/);
});

test('LC-04c after release the AI answers the customer again', async () => {
  const r = await chat(ctx.sid, 'What is the MOQ for UFO high bays?');
  assert.ok(r.reply && r.mode !== 'human');
});

test('LC-04d after release another colleague can take the chat over', async () => {
  assert.match(flash(await as('bob01').form(`/admin/conv/${ctx.sid}/takeover`, {})).path, new RegExp(ctx.sid));
  assert.match(await (await as('bob01').get(`/admin/conv/${ctx.sid}`)).text(), /Bob Li<\/b> 正在人工接待/);
});

test('LC-05a after 30 minutes without a staff reply the takeover lapses and the AI answers', async () => {
  const db = new DatabaseSync(join(api.dir, 'db.sqlite'));
  db.prepare('UPDATE conversations SET agent_at = ? WHERE id = ?').run(new Date(Date.now() - 31 * 60e3).toISOString(), ctx.sid);
  db.close();
  const r = await chat(ctx.sid, 'Hello? Anyone there?');
  assert.notEqual(r.mode, 'human');
  assert.ok(r.reply);
});

test('LC-05b after the lapse the widget poll shows no human and a follow-up-by-e-mail note', async () => {
  const p = await poll(ctx.sid);
  assert.equal(p.human, false);
  assert.match(p.messages.at(-1).content, /follow up by e-mail/);
});

test('LC-06a the content role cannot reply to or read live chat messages (403)', async () => {
  assert.equal((await as('cnt1').form(`/admin/conv/${ctx.sid}/reply`, { text: 'x' })).status, 403);
  assert.equal((await as('cnt1').get(`/admin/conv/${ctx.sid}/messages`)).status, 403);
});

test('LC-06b anonymous visitors cannot open a conversation (401)', async () => {
  assert.equal((await api.get(`/admin/conv/${ctx.sid}`)).status, 401);
});

test('LC-06c a cross-site staff reply is refused (403)', async () => {
  assert.equal((await as('anna').form(`/admin/conv/${ctx.sid}/reply`, { text: 'x' }, { origin: 'https://evil.test' })).status, 403);
});

test('LC-06d the widget poll rejects a malformed session id (400)', async () => {
  assert.equal((await api.get('/api/chat/poll?sessionId=../../etc')).status, 400);
});

test('LC-06e the widget poll for an unknown session returns an empty state', async () => {
  assert.deepEqual(await poll('no-such-session-123'), { human: false, messages: [], lastId: 0 });
});

test('LC-06f taking over a conversation that does not exist is reported', async () => {
  assert.match(flash(await as('anna').form('/admin/conv/no-such-conv/takeover', {})).err, /对话不存在/);
});

test('LC-06g a staff reply over 4000 characters is rejected as too long', async () => {
  assert.match(flash(await as('anna').form(`/admin/conv/${ctx.sid}/reply`, { text: 'x'.repeat(4001) })).err, /太长/);
});
