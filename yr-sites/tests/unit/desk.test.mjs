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
  const qr = {};
  test('SD-01a quick replies are listed most used first', () => {
    qr.a = D.saveQuickReply({ title: 'Lead time', body: 'Standard lead time is 15–20 days.' });
    qr.b = D.saveQuickReply({ title: '付款方式', lang: 'zh', body: '30% 定金，70% 发货前付清。' });
    D.usedQuickReply(qr.b); D.usedQuickReply(qr.b);
    assert.deepEqual(D.listQuickReplies().map((q) => q.id), [qr.b, qr.a]);
  });
  test('SD-01b quick replies can be filtered by language', () => {
    assert.deepEqual(D.listQuickReplies('en').map((q) => q.id), [qr.a]);
  });
  test('SD-01c a quick reply can be edited', () => {
    D.saveQuickReply({ id: qr.a, title: 'Lead time', body: 'Usually 15 days.' });
    assert.equal(D.listQuickReplies('en')[0].body, 'Usually 15 days.');
  });
  test('SD-01d a quick reply without a title is refused', () => {
    assert.throws(() => D.saveQuickReply({ title: '', body: 'x' }), /标题/);
  });
  test('SD-01e a quick reply without a body is refused', () => {
    assert.throws(() => D.saveQuickReply({ title: 'x', body: '' }), /回复内容/);
  });
  test('SD-01f a quick reply in an unsupported language is refused', () => {
    assert.throws(() => D.saveQuickReply({ title: 'x', body: 'y', lang: 'fr' }), /语言/);
  });
  test('SD-01g a quick reply can be deleted', () => {
    D.deleteQuickReply(qr.a);
    assert.equal(D.listQuickReplies('en').length, 0);
  });
});

describe('knowledge base', () => {
  let warranty;
  test('SD-02a terms: Latin words without stop words', () => {
    assert.deepEqual([...D.terms('What is the warranty for UFO high-bay?')].sort(), ['high-bay', 'ufo', 'warranty']);
  });
  test('SD-02b terms: Chinese text becomes two-character pieces', () => {
    assert.deepEqual([...D.terms('质保多久')], ['质保', '保多', '多久']);
  });
  test('SD-03a search matches an entry by its question', () => {
    warranty = D.saveKb({ question: 'How long is the warranty?', answer: 'All fixtures carry a 5-year warranty.', keywords: 'guarantee, years' });
    D.saveKb({ question: 'Do you ship samples?', answer: 'Yes, samples ship in 3 days.', keywords: 'sample order' });
    D.saveKb({ question: '质保多久？', answer: '所有灯具质保 5 年。', lang: 'zh' });
    D.saveKb({ question: 'Secret price list', answer: 'no', active: false });
    assert.equal(D.searchKb('what warranty do you give?')[0].article.id, warranty);
  });
  test('SD-03b search matches an entry by its keywords', () => {
    assert.equal(D.searchKb('Is there a guarantee, how many years?')[0].article.id, warranty);
  });
  test('SD-03c a Chinese question matches the Chinese entry', () => {
    assert.match(D.searchKb('你们的灯质保多久')[0].article.answer, /质保 5 年/);
  });
  test('SD-03d inactive entries never match', () => {
    assert.equal(D.searchKb('secret price list').length, 0);
  });
  test('SD-03e an unrelated question matches nothing', () => {
    assert.equal(D.searchKb('hello').length, 0);
  });
  test('SD-03f an entry without a question is refused', () => {
    assert.throws(() => D.saveKb({ question: '', answer: 'x' }), /问题/);
  });
  test('SD-04a the AI context lists the matching entries', () => {
    const ctx = D.kbContext('How long is your warranty?');
    assert.match(ctx, /COMPANY KNOWLEDGE BASE/);
    assert.match(ctx, /5-year warranty/);
  });
  test('SD-04b the AI context is empty when nothing matches', () => {
    assert.equal(D.kbContext('hello there'), '');
  });
  test('SD-04c rules mode answers a confident match', () => {
    assert.equal(D.kbAnswer('How long is the warranty?'), 'All fixtures carry a 5-year warranty.');
  });
  test('SD-04d rules mode gives no answer for a weak match', () => {
    assert.equal(D.kbAnswer('warranty'), null, 'one word of three is not confident');
  });
  test('SD-04e entries count how often they were used', () => {
    assert.equal(D.listKb().find((a) => a.id === warranty).hits, 2);
  });
  test('SD-04f the knowledge base list can be searched', () => {
    assert.equal(D.listKb({ q: 'samples' }).length, 1);
  });
});

describe('inbox', () => {
  test('SD-05a inbound e-mail with a "From" header: sender name and address parsed, saved as open', () => {
    hooks.length = 0;
    const id = D.receiveMail({ from: '"Ann Buyer" <Ann@Buyer.test>', subject: 'Question about MOQ', 'stripped-text': 'What is your MOQ?' });
    const m = D.getMail(id);
    assert.deepEqual([m.from_addr, m.from_name, m.subject, m.body, m.status], ['ann@buyer.test', 'Ann Buyer', 'Question about MOQ', 'What is your MOQ?', 'open']);
  });
  test('SD-05b inbound e-mail in the Postmark webhook shape is parsed', () => {
    const p = D.getMail(D.receiveMail({ FromFull: { Email: 'bob@x.test' }, Subject: 'Hi', TextBody: 'Postmark body' }));
    assert.deepEqual([p.from_addr, p.subject, p.body], ['bob@x.test', 'Hi', 'Postmark body']);
  });
  test('SD-05c inbound e-mail with an invalid sender is refused', () => {
    assert.throws(() => D.receiveMail({ from: 'nobody', text: 'x' }), /invalid sender/);
  });
  test('SD-05d an alert is sent for inbound e-mail', async () => {
    await settle();
    assert.match(hooks.map((h) => h.markdown.content).find((t) => t.includes('ann@')) || '', /收到客户邮件[\s\S]*ann@buyer\.test：Question about MOQ/);
  });
  const rp = {};
  test('SD-06a replying to an e-mail sends (or logs) the reply and keeps its text', async () => {
    rp.id = D.receiveMail({ from: 'carl@x.test', subject: 'Samples', text: 'Can I get samples?' });
    db.prepare('UPDATE inbox_mails SET received_at = ? WHERE id = ?').run(ago(30), rp.id);
    const r = await D.replyMail(rp.id, 'Yes, samples ship in 3 days.', { username: 'sue', name: 'Sue' });
    assert.ok(['logged', 'sent'].includes(r.status));
    assert.equal(D.getMail(rp.id).replies[0].text, 'Yes, samples ship in 3 days.');
  });
  test('SD-06b a replied e-mail is marked replied with the assignee and first reply time', () => {
    const m = D.getMail(rp.id);
    assert.equal(m.status, 'replied');
    assert.equal(m.assignee, 'sue');
    assert.ok(m.first_reply_at);
  });
  test('SD-06c an empty reply is refused', async () => {
    await assert.rejects(D.replyMail(rp.id, '  ', { username: 'sue' }), /请输入/);
  });
  test('SD-06d a reply to an unknown e-mail is refused', async () => {
    await assert.rejects(D.replyMail(99999, 'x', { username: 'sue' }), /不存在/);
  });
  test('SD-06e a closed e-mail leaves the inbox', () => {
    D.setMailStatus(rp.id, 'closed', { username: 'sue' });
    assert.ok(!D.inbox({ channel: 'email' }).some((i) => i.id === rp.id), 'closed mail leaves the inbox');
  });
  test('SD-06f an unknown e-mail status is refused', () => {
    assert.throws(() => D.setMailStatus(rp.id, 'lost'), /状态/);
  });
  const ib = {};
  test('SD-07a the unified inbox lists waiting chats and unclaimed hand-offs', () => {
    const waiting = ib.waiting = ensureConversation('conv-waiting-01', {});
    addMessage(waiting, 'user', 'Hello?');
    Live.takeOver(waiting, { username: 'sue', name: 'Sue' });
    Live.customerWrote(waiting, 'Hello?');
    const handoff = ib.handoff = ensureConversation('conv-handoff-01', {});
    addMessage(handoff, 'user', 'I want a person');
    db.prepare("UPDATE conversations SET handoff = 1, handoff_reason = 'requested' WHERE id = ?").run(handoff);
    db.prepare("INSERT INTO leads (id, created_at, source, status, email, company, needs) VALUES ('lead-form-1', ?, 'contact', 'new', 'dan@x.test', 'Dan Co', 'Need 500 high-bays')").run(new Date().toISOString());
    ib.all = D.inbox();
    ib.chats = ib.all.filter((i) => i.channel === 'chat');
    assert.deepEqual(ib.chats.map((c) => c.id).sort(), [handoff, waiting].sort());
  });
  test('SD-07b a waiting chat shows "客户等待回复" and the last customer message', () => {
    assert.equal(ib.chats.find((c) => c.id === ib.waiting).title, '客户等待回复');
    assert.equal(ib.chats.find((c) => c.id === ib.waiting).preview, 'Hello?');
  });
  test('SD-07c a hand-off shows its reason', () => {
    assert.match(ib.chats.find((c) => c.id === ib.handoff).title, /转人工：requested/);
  });
  test('SD-07d new contact forms are listed with a link to the lead', () => {
    assert.ok(ib.all.some((i) => i.channel === 'form' && i.title === 'Dan Co' && i.href === '/admin/lead/lead-form-1'));
  });
  test('SD-07e open e-mails are listed', () => {
    assert.ok(ib.all.some((i) => i.channel === 'email' && i.who.includes('ann@buyer.test')));
  });
  test('SD-07f the unified inbox is sorted newest first', () => {
    const { all } = ib;
    assert.ok(all.every((x, i) => !i || String(all[i - 1].ts) >= String(x.ts)), 'newest first');
  });
  test('SD-07g the "mine" filter hides chats taken by someone else', () => {
    assert.ok(!D.inbox({ mine: 'tom' }).some((i) => i.id === ib.waiting), 'someone else\'s chat is hidden');
  });
  test('SD-07h the "mine" filter keeps unassigned items visible', () => {
    assert.ok(D.inbox({ mine: 'tom' }).some((i) => i.id === ib.handoff), 'unassigned stays visible');
  });
});

describe('ratings & performance', () => {
  const rt = {};
  test('SD-08a a bad rating sends an alert naming the agent who handled the chat', async () => {
    const id = rt.id = ensureConversation('conv-rated-01', {});
    db.prepare('INSERT INTO messages (conv_id, role, content, meta, ts) VALUES (?,?,?,?,?)').run(id, 'user', 'Need a quote', null, ago(20));
    db.prepare('INSERT INTO messages (conv_id, role, content, meta, ts) VALUES (?,?,?,?,?)').run(id, 'agent', 'Sure!', JSON.stringify({ by: 'sue', name: 'Sue' }), ago(16));
    hooks.length = 0;
    D.rateChat(id, { rating: 2, resolved: false, comment: 'slow' });
    await settle();
    assert.match(hooks.map((h) => h.markdown.content).find((t) => t.includes('差评')) || '', /客户给了差评[\s\S]*2 星：slow[\s\S]*接待：sue/);
  });
  test('SD-08b a rating can be changed and is credited to the agent who handled the chat', () => {
    D.rateChat(rt.id, { rating: 5, resolved: true });
    const r = db.prepare('SELECT * FROM chat_ratings WHERE conv_id = ?').get(rt.id);
    assert.deepEqual([r.rating, r.resolved, r.agent], [5, 1, 'sue']);
  });
  test('SD-08c a rating outside 1–5 is refused', () => {
    assert.throws(() => D.rateChat(rt.id, { rating: 6 }), /bad_rating/);
  });
  test('SD-08d rating an unknown conversation is refused', () => {
    assert.throws(() => D.rateChat('nope-nope-nope', { rating: 5 }), /not_found/);
  });
  const sue = () => D.performance(30).find((x) => x.username === 'sue');
  test('SD-09a performance per person counts chats, ratings, average rating and resolution rate', () => {
    const s = sue();
    assert.ok(s.chats >= 1);
    assert.equal(s.ratings, 1);
    assert.equal(s.avgRating, 5);
    assert.equal(s.resolutionRate, 1);
  });
  test('SD-09b performance per person shows the average first chat response time', () => {
    const s = sue();
    assert.ok(s.avgFirstResponseMin >= 3.9 && s.avgFirstResponseMin <= 4.1, String(s.avgFirstResponseMin));
  });
  test('SD-09c performance per person counts e-mails replied and the average e-mail response time', () => {
    const s = sue();
    assert.equal(s.emails, 1);
    assert.ok(s.avgEmailResponseMin >= 29 && s.avgEmailResponseMin <= 31);
  });
  test('SD-09d the rating summary shows count, average, resolution rate and recent ratings', () => {
    const s = D.ratingSummary(30);
    assert.deepEqual([s.count, s.avg, s.resolutionRate], [1, 5, 1]);
    assert.equal(s.recent[0].conv_id, 'conv-rated-01');
  });
  const rl = {};
  test('SD-10a releasing a chat leaves a note the widget turns into a rating prompt', () => {
    const id = ensureConversation('conv-release-01', {});
    Live.agentReply(id, { username: 'sue', name: 'Sue Lee' }, 'Hi, Sue here');
    Live.release(id, 'rate');
    rl.notes = Live.poll(id, 0).messages.filter((m) => m.role === 'note');
    assert.equal(rl.notes.at(-1).rate, true);
    assert.match(rl.notes.at(-1).content, /how did we do/);
  });
  test('SD-10b the note when an agent joins does not ask for a rating', () => {
    assert.equal(rl.notes[0].rate, undefined, 'the join note does not ask');
  });
});
