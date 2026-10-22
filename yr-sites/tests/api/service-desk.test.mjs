// Black-box: customer service over HTTP — roles, unified inbox, inbound e-mail webhook and replies, quick replies in the
// chat reply box, knowledge base answering in the chat, customer rating after a person hands the chat back, performance,
// service workbench, English. IDs CS-xx.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, flash } from '../helpers/server.mjs';

let api;
const TOKEN = 'inbound-secret-123';
before(async () => {
  api = await startServer({ site: 'led', env: { INBOUND_EMAIL_TOKEN: TOKEN } });
  for (const [u, role] of [['sue', 'service'], ['wes', 'warehouse']]) await api.form('/admin/users/new', { username: u, name: u === 'sue' ? 'Sue Lee' : u, role, password: PW });
});
after(() => api.stop());

const PW = 'Str0ngPassw0rd';
const auth = (u) => ({ authorization: 'Basic ' + Buffer.from(`${u}:${PW}`).toString('base64') });
const form = (u, path, data) => fetch(api.url + path, { method: 'POST', redirect: 'manual', headers: { ...auth(u), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
const page = async (path, h = auth('sue')) => (await fetch(api.url + path, { headers: h })).text();
const chat = async (message, sessionId) => (await api.json('/api/chat', { message, sessionId })).json();

const ctx = {};

test('CS-01a the service role opens the inbox, quick replies, knowledge base and performance', async () => {
  for (const p of ['/admin/service', '/admin/service/quick-replies', '/admin/service/kb', '/admin/service/performance']) assert.equal((await fetch(api.url + p, { headers: auth('sue') })).status, 200, p);
});

test('CS-01b the warehouse role is refused the service pages (403)', async () => {
  for (const p of ['/admin/service', '/admin/service/quick-replies', '/admin/service/kb', '/admin/service/performance']) assert.equal((await fetch(api.url + p, { headers: auth('wes') })).status, 403, p);
});

test('CS-01c the service role has a 客服 entry in the navigation', async () => {
  assert.match(await page('/admin/service'), /<a href="\/admin\/service">客服<\/a>/);
});

const inbound = (q, body, type = 'json') => fetch(`${api.url}/api/inbound/email${q}`, { method: 'POST', headers: { 'content-type': type === 'json' ? 'application/json' : 'application/x-www-form-urlencoded' }, body: type === 'json' ? JSON.stringify(body) : new URLSearchParams(body) });

test('CS-02a the inbound e-mail webhook answers 404 without the token or with a wrong one', async () => {
  assert.equal((await inbound('', { from: 'a@b.test', text: 'x' })).status, 404);
  assert.equal((await inbound('?token=wrong', { from: 'a@b.test', text: 'x' })).status, 404);
});

test('CS-02b the inbound e-mail webhook rejects an invalid sender address (400)', async () => {
  assert.equal((await inbound(`?token=${TOKEN}`, { from: 'not-an-address', text: 'x' })).status, 400);
});

test('CS-02c an inbound e-mail posted as JSON is stored and its id returned', async () => {
  ctx.mail = (await (await inbound(`?token=${TOKEN}`, { from: 'Ann Buyer <ann@buyer.test>', subject: 'MOQ question', text: 'What is your MOQ for UFO high-bays?' })).json()).id;
  assert.ok(ctx.mail);
});

test('CS-02d an inbound e-mail posted as a form (Mailgun fields) is accepted', async () => {
  assert.equal((await inbound(`?token=${TOKEN}`, { sender: 'bob@x.test', subject: 'Mailgun form', 'body-plain': 'Hello' }, 'form')).status, 200);
});

test('CS-02e the e-mail inbox lists both e-mails and counts 2 open', async () => {
  const inbox = await page('/admin/service?channel=email');
  assert.match(inbox, /Ann Buyer &lt;ann@buyer\.test&gt;/);
  assert.match(inbox, /Mailgun form/);
  assert.match(inbox, /邮件未关闭<\/span><strong>2<\/strong>/);
});

test('CS-02f the e-mail page shows the message body', async () => {
  assert.match(await page(`/admin/service/mail/${ctx.mail}`), /What is your MOQ for UFO high-bays\?/);
});

test('CS-02g a reply to an e-mail is saved and shown with the staff name', async () => {
  assert.match(flash(await form('sue', `/admin/service/mail/${ctx.mail}/reply`, { text: 'Our MOQ is 50 pcs.' })).ok, /已回复/);
  assert.match(await page(`/admin/service/mail/${ctx.mail}`), /sue ·[\s\S]*Our MOQ is 50 pcs\./);
});

test('CS-02h an empty e-mail reply is refused', async () => {
  assert.match(flash(await form('sue', `/admin/service/mail/${ctx.mail}/reply`, { text: ' ' })).err, /请输入回复内容/);
});

test('CS-02i closing an e-mail removes it from the inbox', async () => {
  assert.equal((await form('sue', `/admin/service/mail/${ctx.mail}/status`, { status: 'closed' })).status, 302);
  assert.doesNotMatch(await page('/admin/service?channel=email'), /MOQ question/);
});

test('CS-02j an e-mail that does not exist answers 404', async () => {
  assert.equal((await fetch(`${api.url}/admin/service/mail/99999`, { headers: auth('sue') })).status, 404);
});

test('CS-03a a knowledge base entry is saved', async () => {
  assert.match(flash(await form('sue', '/admin/service/kb', { question: 'How long is the warranty?', answer: 'All YAORONG fixtures carry a 5-year warranty.', keywords: 'guarantee', lang: 'en', active: '1' })).ok, /已保存/);
});

test('CS-03b a knowledge base entry without a question is refused', async () => {
  assert.match(flash(await form('sue', '/admin/service/kb', { question: '', answer: 'x' })).err, /问题须为/);
});

test('CS-03c the chat answers from the knowledge base first (rules mode)', async () => {
  const r = await chat('How long is the warranty on your lights?');
  assert.equal(r.reply, 'All YAORONG fixtures carry a 5-year warranty.');
});

test('CS-03d the try-it box shows the match and the entry\'s hit count', async () => {
  const kb = await page('/admin/service/kb?test=how%20long%20is%20the%20warranty');
  assert.match(kb, /匹配度 100% · 规则模式会直接回答/);
  assert.match(kb, /<td class="n">1<\/td>/, 'one hit counted');
});

test('CS-04a a quick reply is saved', async () => {
  assert.match(flash(await form('sue', '/admin/service/quick-replies', { title: 'Lead time', lang: 'en', body: 'Standard lead time is 15–20 days.' })).ok, /已保存/);
});

test('CS-04b a quick reply without a title is refused', async () => {
  assert.match(flash(await form('sue', '/admin/service/quick-replies', { title: '', body: 'x' })).err, /标题须为/);
});

test('CS-04c the chat reply box offers the quick reply', async () => {
  const { sessionId } = await chat('Hi, I need 200 high-bays');
  const conv = await page(`/admin/conv/${sessionId}`);
  assert.match(conv, /<select data-quick[\s\S]*data-body="Standard lead time is 15–20 days\.">Lead time（英文）<\/option>/);
  ctx.quick = conv.match(/<option value="(\d+)" data-body=/)[1];
});

test('CS-04d using a quick reply is counted', async () => {
  await form('sue', `/admin/service/quick-replies/${ctx.quick}/use`, {});
  assert.match(await page('/admin/service/quick-replies'), /<td class="n">1<\/td>/);
});

test('CS-05a after a person replies the chat page offers "end and ask for a rating"', async () => {
  const { sessionId } = await chat('I want to talk to a person about a project');
  ctx.sid = sessionId;
  await form('sue', `/admin/conv/${sessionId}/reply`, { text: 'Hi, Sue here. How can I help?' });
  const conv = await page(`/admin/conv/${sessionId}`);
  assert.match(conv, /<button name="rate" value="1">结束并请客户评价<\/button>/);
});

test('CS-05b handing back with a rating request puts the rating prompt in the widget poll', async () => {
  await form('sue', `/admin/conv/${ctx.sid}/release`, { rate: '1' });
  const poll = await (await api.get(`/api/chat/poll?sessionId=${ctx.sid}&after=0`)).json();
  assert.equal(poll.human, false);
  assert.ok(poll.messages.some((m) => m.role === 'note' && m.rate === true && /how did we do/.test(m.content)));
});

const rate = (b) => api.json('/api/chat/rate', b);

test('CS-05c a rating outside 1–5 is rejected (400)', async () => {
  assert.equal((await rate({ sessionId: ctx.sid, rating: 9 })).status, 400);
});

test('CS-05d rating an unknown session answers 404', async () => {
  assert.equal((await rate({ sessionId: 'no-such-session-1', rating: 5 })).status, 404);
});

test('CS-05e rating with a malformed session id is rejected (400)', async () => {
  assert.equal((await rate({ sessionId: 'x', rating: 5 })).status, 400);
});

test('CS-05f a valid customer rating is recorded', async () => {
  assert.equal((await rate({ sessionId: ctx.sid, rating: 4, resolved: true, comment: 'Quick and helpful' })).status, 200);
});

test('CS-05g the performance page counts chats per person, ratings and the average score', async () => {
  ctx.perf = await page('/admin/service/performance');
  assert.match(ctx.perf, /<td><b>sue<\/b><\/td><td class="n">1<\/td>/);
  assert.match(ctx.perf, /客户评价数<\/span><strong>1<\/strong>/);
  assert.match(ctx.perf, /平均评分<\/span><strong>4<\/strong>/);
});

test('CS-05h the performance page lists the rating with resolved, comment and staff', async () => {
  assert.match(ctx.perf, /已解决<\/td><td translate="no">Quick and helpful<\/td><td>sue<\/td>/);
});

test('CS-06a the inbox shows chats waiting for a person with the customer message', async () => {
  const { sessionId } = await chat('Can I speak to someone?');
  await form('sue', `/admin/conv/${sessionId}/takeover`, {});
  await chat('Hello, are you there?', sessionId);
  assert.match(await page('/admin/service'), /客户等待回复[\s\S]*Hello, are you there\?/);
});

test('CS-06b the inbox shows website contact forms', async () => {
  await api.json('/api/leads', { email: 'form@buyer.test', company: 'Form Buyer Ltd', needs: 'Please call me', consent: true, source: 'contact' });
  assert.match(await page('/admin/service'), /Form Buyer Ltd/);
});

test('CS-06c the service workbench shows inbox, waiting chats, open e-mails, RMAs to review and ratings', async () => {
  const home = await page('/admin/home');
  for (const k of ['客服：收件箱与对话', '等待人工回复', '未关闭邮件', '售后待审核', '近 7 天客户评分', '对话：客户等待回复']) assert.ok(home.includes(k), k);
});

test('CS-07 English service pages', async () => {
  const EN = { ...auth('sue'), cookie: 'yr_admin_lang=en' };
  for (const p of ['/admin/service', '/admin/service/quick-replies', '/admin/service/kb?test=warranty', '/admin/service/performance']) {
    const text = (await page(p, EN)).replace(/<textarea[\s\S]*?<\/textarea>|<script[\s\S]*?<\/script>|<[^>]+translate="no"[^>]*>[\s\S]*?<\/[a-z]+>|<[^>]+>/g, ' ');
    const left = text.match(/[^\s]{0,20}[\u3400-\u9fff]+[^\s]{0,20}/);
    assert.equal(left, null, `${p}: ${left?.[0]}`);
  }
});
