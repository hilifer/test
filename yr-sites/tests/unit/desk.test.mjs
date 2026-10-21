// Module: server/src/service/desk.js — quick replies, knowledge base matching (AI context and rules-mode answers), inbound
// e-mail and replies, the unified inbox, chat ratings and per-person service performance. IDs SD-xx.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempEnv } from '../helpers/env.mjs';
import { mockServer } from '../helpers/mock-http.mjs';

const hooks = [];
const wecom = await mockServer((call) => { hooks.push(call.body); return { json: { errcode: 0 } }; });
useTempEnv({ site: 'led', WECOM_WEBHOOK_URL: wecom.url });
const D = await import('../../server/src/service/desk.js');
const Live = await import('../../server/src/livechat.js');
const { db, ensureConversation, addMessage } = await import('../../server/src/db.js');
after(() => wecom.close());
const settle = () => new Promise((r) => setTimeout(r, 150));
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();

describe('quick replies', () => {
  test('SD-01 save, edit, validate, count uses (most used first), delete', () => {
    const a = D.saveQuickReply({ title: 'Lead time', body: 'Standard lead time is 15–20 days.' });
    const b = D.saveQuickReply({ title: '付款方式', lang: 'zh', body: '30% 定金，70% 发货前付清。' });
    D.usedQuickReply(b); D.usedQuickReply(b);
    assert.deepEqual(D.listQuickReplies().map((q) => q.id), [b, a]);
    assert.deepEqual(D.listQuickReplies('en').map((q) => q.id), [a]);
    D.saveQuickReply({ id: a, title: 'Lead time', body: 'Usually 15 days.' });
    assert.equal(D.listQuickReplies('en')[0].body, 'Usually 15 days.');
    assert.throws(() => D.saveQuickReply({ title: '', body: 'x' }), /标题/);
    assert.throws(() => D.saveQuickReply({ title: 'x', body: '' }), /回复内容/);
    assert.throws(() => D.saveQuickReply({ title: 'x', body: 'y', lang: 'fr' }), /语言/);
    D.deleteQuickReply(a);
    assert.equal(D.listQuickReplies('en').length, 0);
  });
});

describe('knowledge base', () => {
  let warranty;
  test('SD-02 terms: latin words without stop words, Chinese two-character pieces', () => {
    assert.deepEqual([...D.terms('What is the warranty for UFO high-bay?')].sort(), ['high-bay', 'ufo', 'warranty']);
    assert.deepEqual([...D.terms('质保多久')], ['质保', '保多', '多久']);
  });
  test('SD-03 search matches by question and keywords in the right language; inactive entries never match', () => {
    warranty = D.saveKb({ question: 'How long is the warranty?', answer: 'All fixtures carry a 5-year warranty.', keywords: 'guarantee, years' });
    D.saveKb({ question: 'Do you ship samples?', answer: 'Yes, samples ship in 3 days.', keywords: 'sample order' });
    D.saveKb({ question: '质保多久？', answer: '所有灯具质保 5 年。', lang: 'zh' });
    D.saveKb({ question: 'Secret price list', answer: 'no', active: false });
    assert.equal(D.searchKb('what warranty do you give?')[0].article.id, warranty);
    assert.equal(D.searchKb('Is there a guarantee, how many years?')[0].article.id, warranty);
    assert.match(D.searchKb('你们的灯质保多久')[0].article.answer, /质保 5 年/);
    assert.equal(D.searchKb('secret price list').length, 0);
    assert.equal(D.searchKb('hello').length, 0);
    assert.throws(() => D.saveKb({ question: '', answer: 'x' }), /问题/);
  });
  test('SD-04 AI context lists the matching entries and counts hits; rules mode answers only a confident match', () => {
    const ctx = D.kbContext('How long is your warranty?');
    assert.match(ctx, /COMPANY KNOWLEDGE BASE/);
    assert.match(ctx, /5-year warranty/);
    assert.equal(D.kbContext('hello there'), '');
    assert.equal(D.kbAnswer('How long is the warranty?'), 'All fixtures carry a 5-year warranty.');
    assert.equal(D.kbAnswer('warranty'), null, 'one word of three is not confident');
    assert.equal(D.listKb().find((a) => a.id === warranty).hits, 2);
    assert.equal(D.listKb({ q: 'samples' }).length, 1);
  });
});

describe('inbox', () => {
  test('SD-05 inbound e-mail: common webhook shapes, sender parsed, alert sent; bad sender refused', async () => {
    hooks.length = 0;
    const id = D.receiveMail({ from: '"Ann Buyer" <Ann@Buyer.test>', subject: 'Question about MOQ', 'stripped-text': 'What is your MOQ?' });
    const m = D.getMail(id);
    assert.deepEqual([m.from_addr, m.from_name, m.subject, m.body, m.status], ['ann@buyer.test', 'Ann Buyer', 'Question about MOQ', 'What is your MOQ?', 'open']);
    const p = D.getMail(D.receiveMail({ FromFull: { Email: 'bob@x.test' }, Subject: 'Hi', TextBody: 'Postmark body' }));
    assert.deepEqual([p.from_addr, p.subject, p.body], ['bob@x.test', 'Hi', 'Postmark body']);
    assert.throws(() => D.receiveMail({ from: 'nobody', text: 'x' }), /invalid sender/);
    await settle();
    assert.match(hooks.map((h) => h.markdown.content).find((t) => t.includes('ann@')) || '', /收到客户邮件[\s\S]*ann@buyer\.test：Question about MOQ/);
  });
  test('SD-06 reply: sent with Re: and the original quoted, first reply time and assignee kept; close and reopen', async () => {
    const id = D.receiveMail({ from: 'carl@x.test', subject: 'Samples', text: 'Can I get samples?' });
    db.prepare('UPDATE inbox_mails SET received_at = ? WHERE id = ?').run(ago(30), id);
    const r = await D.replyMail(id, 'Yes, samples ship in 3 days.', { username: 'sue', name: 'Sue' });
    assert.ok(['logged', 'sent'].includes(r.status));
    const m = D.getMail(id);
    assert.equal(m.status, 'replied');
    assert.equal(m.assignee, 'sue');
    assert.equal(m.replies[0].text, 'Yes, samples ship in 3 days.');
    assert.ok(m.first_reply_at);
    await assert.rejects(D.replyMail(id, '  ', { username: 'sue' }), /请输入/);
    await assert.rejects(D.replyMail(99999, 'x', { username: 'sue' }), /不存在/);
    D.setMailStatus(id, 'closed', { username: 'sue' });
    assert.ok(!D.inbox({ channel: 'email' }).some((i) => i.id === id), 'closed mail leaves the inbox');
    assert.throws(() => D.setMailStatus(id, 'lost'), /状态/);
  });
  test('SD-07 unified inbox: waiting chats, unclaimed hand-offs, open e-mails and contact forms, newest first; "mine" filter', () => {
    const waiting = ensureConversation('conv-waiting-01', {});
    addMessage(waiting, 'user', 'Hello?');
    Live.takeOver(waiting, { username: 'sue', name: 'Sue' });
    Live.customerWrote(waiting, 'Hello?');
    const handoff = ensureConversation('conv-handoff-01', {});
    addMessage(handoff, 'user', 'I want a person');
    db.prepare("UPDATE conversations SET handoff = 1, handoff_reason = 'requested' WHERE id = ?").run(handoff);
    db.prepare("INSERT INTO leads (id, created_at, source, status, email, company, needs) VALUES ('lead-form-1', ?, 'contact', 'new', 'dan@x.test', 'Dan Co', 'Need 500 high-bays')").run(new Date().toISOString());
    const all = D.inbox();
    const chats = all.filter((i) => i.channel === 'chat');
    assert.deepEqual(chats.map((c) => c.id).sort(), [handoff, waiting].sort());
    assert.equal(chats.find((c) => c.id === waiting).title, '客户等待回复');
    assert.equal(chats.find((c) => c.id === waiting).preview, 'Hello?');
    assert.match(chats.find((c) => c.id === handoff).title, /转人工：requested/);
    assert.ok(all.some((i) => i.channel === 'form' && i.title === 'Dan Co' && i.href === '/admin/lead/lead-form-1'));
    assert.ok(all.some((i) => i.channel === 'email' && i.who.includes('ann@buyer.test')));
    assert.ok(all.every((x, i) => !i || String(all[i - 1].ts) >= String(x.ts)), 'newest first');
    assert.ok(!D.inbox({ mine: 'tom' }).some((i) => i.id === waiting), 'someone else\'s chat is hidden');
    assert.ok(D.inbox({ mine: 'tom' }).some((i) => i.id === handoff), 'unassigned stays visible');
  });
});

describe('ratings & performance', () => {
  test('SD-08 rating: goes to the person who handled the chat, can be changed, bad rating alerts; bad input refused', async () => {
    const id = ensureConversation('conv-rated-01', {});
    db.prepare('INSERT INTO messages (conv_id, role, content, meta, ts) VALUES (?,?,?,?,?)').run(id, 'user', 'Need a quote', null, ago(20));
    db.prepare('INSERT INTO messages (conv_id, role, content, meta, ts) VALUES (?,?,?,?,?)').run(id, 'agent', 'Sure!', JSON.stringify({ by: 'sue', name: 'Sue' }), ago(16));
    hooks.length = 0;
    D.rateChat(id, { rating: 2, resolved: false, comment: 'slow' });
    await settle();
    assert.match(hooks.map((h) => h.markdown.content).find((t) => t.includes('差评')) || '', /客户给了差评[\s\S]*2 星：slow[\s\S]*接待：sue/);
    D.rateChat(id, { rating: 5, resolved: true });
    const r = db.prepare('SELECT * FROM chat_ratings WHERE conv_id = ?').get(id);
    assert.deepEqual([r.rating, r.resolved, r.agent], [5, 1, 'sue']);
    assert.throws(() => D.rateChat(id, { rating: 6 }), /bad_rating/);
    assert.throws(() => D.rateChat('nope-nope-nope', { rating: 5 }), /not_found/);
  });
  test('SD-09 performance per person: chats, average first response, ratings, resolution, e-mails; summary', () => {
    const p = D.performance(30);
    const sue = p.find((x) => x.username === 'sue');
    assert.ok(sue.chats >= 1);
    assert.equal(sue.ratings, 1);
    assert.equal(sue.avgRating, 5);
    assert.equal(sue.resolutionRate, 1);
    assert.ok(sue.avgFirstResponseMin >= 3.9 && sue.avgFirstResponseMin <= 4.1, String(sue.avgFirstResponseMin));
    assert.equal(sue.emails, 1);
    assert.ok(sue.avgEmailResponseMin >= 29 && sue.avgEmailResponseMin <= 31);
    const s = D.ratingSummary(30);
    assert.deepEqual([s.count, s.avg, s.resolutionRate], [1, 5, 1]);
    assert.equal(s.recent[0].conv_id, 'conv-rated-01');
  });
  test('SD-10 releasing a chat leaves a note the widget turns into a rating prompt', () => {
    const id = ensureConversation('conv-release-01', {});
    Live.agentReply(id, { username: 'sue', name: 'Sue Lee' }, 'Hi, Sue here');
    Live.release(id, 'rate');
    const notes = Live.poll(id, 0).messages.filter((m) => m.role === 'note');
    assert.equal(notes.at(-1).rate, true);
    assert.match(notes.at(-1).content, /how did we do/);
    assert.equal(notes[0].rate, undefined, 'the join note does not ask');
  });
});
