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

test('CS-01 roles: service opens the inbox, quick replies, knowledge base and performance; warehouse cannot', async () => {
  for (const p of ['/admin/service', '/admin/service/quick-replies', '/admin/service/kb', '/admin/service/performance']) {
    assert.equal((await fetch(api.url + p, { headers: auth('sue') })).status, 200, p);
    assert.equal((await fetch(api.url + p, { headers: auth('wes') })).status, 403, p);
  }
  assert.match(await page('/admin/service'), /<a href="\/admin\/service">客服<\/a>/);
});

test('CS-02 inbound e-mail: token required; JSON and form bodies land in the inbox; reply and close', async () => {
  const post = (q, body, type = 'json') => fetch(`${api.url}/api/inbound/email${q}`, { method: 'POST', headers: { 'content-type': type === 'json' ? 'application/json' : 'application/x-www-form-urlencoded' }, body: type === 'json' ? JSON.stringify(body) : new URLSearchParams(body) });
  assert.equal((await post('', { from: 'a@b.test', text: 'x' })).status, 404);
  assert.equal((await post('?token=wrong', { from: 'a@b.test', text: 'x' })).status, 404);
  assert.equal((await post(`?token=${TOKEN}`, { from: 'not-an-address', text: 'x' })).status, 400);
  const id = (await (await post(`?token=${TOKEN}`, { from: 'Ann Buyer <ann@buyer.test>', subject: 'MOQ question', text: 'What is your MOQ for UFO high-bays?' })).json()).id;
  assert.ok(id);
  assert.equal((await post(`?token=${TOKEN}`, { sender: 'bob@x.test', subject: 'Mailgun form', 'body-plain': 'Hello' }, 'form')).status, 200);
  const inbox = await page('/admin/service?channel=email');
  assert.match(inbox, /Ann Buyer &lt;ann@buyer\.test&gt;/);
  assert.match(inbox, /Mailgun form/);
  assert.match(inbox, /邮件未关闭<\/span><strong>2<\/strong>/);
  const mail = await page(`/admin/service/mail/${id}`);
  assert.match(mail, /What is your MOQ for UFO high-bays\?/);
  assert.match(flash(await form('sue', `/admin/service/mail/${id}/reply`, { text: 'Our MOQ is 50 pcs.' })).ok, /已回复/);
  assert.match(await page(`/admin/service/mail/${id}`), /sue ·[\s\S]*Our MOQ is 50 pcs\./);
  assert.match(flash(await form('sue', `/admin/service/mail/${id}/reply`, { text: ' ' })).err, /请输入回复内容/);
  assert.equal((await form('sue', `/admin/service/mail/${id}/status`, { status: 'closed' })).status, 302);
  assert.doesNotMatch(await page('/admin/service?channel=email'), /MOQ question/);
  assert.equal((await fetch(`${api.url}/admin/service/mail/99999`, { headers: auth('sue') })).status, 404);
});

test('CS-03 knowledge base: the chat answers from it first (rules mode); the try-it box shows the match', async () => {
  assert.match(flash(await form('sue', '/admin/service/kb', { question: 'How long is the warranty?', answer: 'All YAORONG fixtures carry a 5-year warranty.', keywords: 'guarantee', lang: 'en', active: '1' })).ok, /已保存/);
  assert.match(flash(await form('sue', '/admin/service/kb', { question: '', answer: 'x' })).err, /问题须为/);
  const r = await chat('How long is the warranty on your lights?');
  assert.equal(r.reply, 'All YAORONG fixtures carry a 5-year warranty.');
  const kb = await page('/admin/service/kb?test=how%20long%20is%20the%20warranty');
  assert.match(kb, /匹配度 100% · 规则模式会直接回答/);
  assert.match(kb, /<td class="n">1<\/td>/, 'one hit counted');
});

test('CS-04 quick replies: saved, offered in the chat reply box, use counted', async () => {
  assert.match(flash(await form('sue', '/admin/service/quick-replies', { title: 'Lead time', lang: 'en', body: 'Standard lead time is 15–20 days.' })).ok, /已保存/);
  assert.match(flash(await form('sue', '/admin/service/quick-replies', { title: '', body: 'x' })).err, /标题须为/);
  const { sessionId } = await chat('Hi, I need 200 high-bays');
  const conv = await page(`/admin/conv/${sessionId}`);
  assert.match(conv, /<select data-quick[\s\S]*data-body="Standard lead time is 15–20 days\.">Lead time（英文）<\/option>/);
  const id = conv.match(/<option value="(\d+)" data-body=/)[1];
  await form('sue', `/admin/service/quick-replies/${id}/use`, {});
  assert.match(await page('/admin/service/quick-replies'), /<td class="n">1<\/td>/);
});

test('CS-05 a person replies, hands the chat back asking for a rating; the widget poll carries the prompt; rating recorded; performance', async () => {
  const { sessionId } = await chat('I want to talk to a person about a project');
  await form('sue', `/admin/conv/${sessionId}/reply`, { text: 'Hi, Sue here. How can I help?' });
  const conv = await page(`/admin/conv/${sessionId}`);
  assert.match(conv, /<button name="rate" value="1">结束并请客户评价<\/button>/);
  await form('sue', `/admin/conv/${sessionId}/release`, { rate: '1' });
  const poll = await (await api.get(`/api/chat/poll?sessionId=${sessionId}&after=0`)).json();
  assert.equal(poll.human, false);
  assert.ok(poll.messages.some((m) => m.role === 'note' && m.rate === true && /how did we do/.test(m.content)));
  const rate = (b) => api.json('/api/chat/rate', b);
  assert.equal((await rate({ sessionId, rating: 9 })).status, 400);
  assert.equal((await rate({ sessionId: 'no-such-session-1', rating: 5 })).status, 404);
  assert.equal((await rate({ sessionId: 'x', rating: 5 })).status, 400);
  assert.equal((await rate({ sessionId, rating: 4, resolved: true, comment: 'Quick and helpful' })).status, 200);
  const perf = await page('/admin/service/performance');
  assert.match(perf, /<td><b>sue<\/b><\/td><td class="n">1<\/td>/);
  assert.match(perf, /客户评价数<\/span><strong>1<\/strong>/);
  assert.match(perf, /平均评分<\/span><strong>4<\/strong>/);
  assert.match(perf, /已解决<\/td><td translate="no">Quick and helpful<\/td><td>sue<\/td>/);
});

test('CS-06 inbox brings chats waiting for a person and contact forms together; service workbench', async () => {
  const { sessionId } = await chat('Can I speak to someone?');
  await form('sue', `/admin/conv/${sessionId}/takeover`, {});
  await chat('Hello, are you there?', sessionId);
  await api.json('/api/leads', { email: 'form@buyer.test', company: 'Form Buyer Ltd', needs: 'Please call me', consent: true, source: 'contact' });
  const inbox = await page('/admin/service');
  assert.match(inbox, /客户等待回复[\s\S]*Hello, are you there\?/);
  assert.match(inbox, /Form Buyer Ltd/);
  const home = await page('/admin/home');
  for (const k of ['客服：收件箱与对话', '等待人工回复', '未关闭邮件', '售后待审核', '近 7 天客户评分', '对话：客户等待回复']) assert.ok(home.includes(k), k);
});

test('CS-07 English service pages', async () => {
  const EN = { ...auth('sue'), cookie: 'yr_admin_lang=en' };
  for (const p of ['/admin/service', '/admin/service/quick-replies', '/admin/service/kb?test=warranty', '/admin/service/performance']) {
    const text = (await page(p, EN)).replace(/<textarea[\s\S]*?<\/textarea>|<script[\s\S]*?<\/script>|<[^>]+translate="no"[^>]*>[\s\S]*?<\/[a-z]+>|<[^>]+>/g, ' ');
    const left = text.match(/[^\s]{0,20}[㐀-鿿]+[^\s]{0,20}/);
    assert.equal(left, null, `${p}: ${left?.[0]}`);
  }
});
