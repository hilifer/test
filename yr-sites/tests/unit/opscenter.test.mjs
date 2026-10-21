// Modules for ops: jobs.js (scheduled jobs), ops/errors.js (error log), ops/services.js (connectivity checks against
// mock services), ops/security.js (logins, sessions, config check, restore drills, backup watch), publisher releases
// (website rollback). IDs JB-xx, ER-xx, OS-xx, SC-xx, RL-xx.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTempEnv, tempDir } from '../helpers/env.mjs';
import { mockServer } from '../helpers/mock-http.mjs';

const hooks = []; // every alert sent to the (mock) WeCom webhook
const wecom = await mockServer((call) => { hooks.push(call.body); return { json: { errcode: 0, errmsg: 'ok' } }; });
const svc = await mockServer((call) => {
  if (call.url === '/v1/balance') return call.headers.authorization === 'Bearer sk_test_ok' ? { json: { livemode: false, available: [] } } : { status: 401, json: { error: { message: 'Invalid API Key provided' } } };
  if (call.url === '/v1/oauth2/token') return { json: { access_token: 'tok', expires_in: 300 } };
  if (call.url === '/track/v2.2/getquota') return { json: { code: 0, data: { quota_total: 100, quota_remain: 42 } } };
  if (call.url === '/api/health?detail=1') return call.headers['x-ops-token'] === 'shared' ? { json: { ok: true, site: 'grid', version: '1.2.3', errors24h: 0, backup: { ok: true, ts: '2026-10-21T00:00:00Z' } } } : { json: { ok: true, site: 'grid' } };
  return { status: 404, text: 'nope' };
});
const rel = tempDir('yr-rel-');
useTempEnv({ site: 'led', WECOM_WEBHOOK_URL: wecom.url, STRIPE_SECRET_KEY: 'sk_test_ok', STRIPE_API_BASE: svc.url, PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's', PAYPAL_API_BASE: svc.url,
  TRACK17_KEY: 'k', TRACK17_API_BASE: svc.url, PEER_SITES: `grid|${svc.url},down|http://127.0.0.1:1`, OPS_TOKEN: 'shared', RELEASES_DIR: rel, BACKUP_DIR: join(tempDir('yr-bk-'), 'b') });
const Jobs = await import('../../server/src/jobs.js');
const E = await import('../../server/src/ops/errors.js');
const S = await import('../../server/src/ops/services.js');
const Sec = await import('../../server/src/ops/security.js');
const B = await import('../../server/src/ops/backup.js');
const P = await import('../../server/src/content/publisher.js');
const { db } = await import('../../server/src/db.js');
after(async () => { await wecom.close(); await svc.close(); });
const settle = () => new Promise((r) => setTimeout(r, 150));

describe('scheduled jobs', () => {
  test('JB-01 interval jobs run after the initial delay and then every interval; runs are recorded', async () => {
    let n = 0;
    Jobs.registerJob({ id: 't-every', name: '测试', schedule: Jobs.every(1000, { initialDelay: 0 }), run: () => `run ${++n}` });
    const t = Date.now();
    Jobs.tick(t); await settle();
    assert.equal(n, 1);
    Jobs.tick(t + 500); await settle();
    assert.equal(n, 1, 'not due yet');
    Jobs.tick(Date.now() + 1100); await settle();
    assert.equal(n, 2);
    assert.deepEqual(Jobs.jobRuns('t-every').map((r) => r.detail), ['run 2', 'run 1']);
  });
  test('JB-02 daily jobs run once in their hour on the chosen days (time zone aware); next run is shown', async () => {
    let n = 0;
    Jobs.registerJob({ id: 't-daily', name: '每日', schedule: Jobs.dailyAt(9, { days: [1, 3], tz: 'Asia/Shanghai' }), run: () => { n++; return 'ok'; } });
    const wed0905 = Date.parse('2026-10-21T01:05:00Z'); // Wednesday 09:05 in Shanghai
    Jobs.tick(wed0905); await settle();
    Jobs.tick(wed0905 + 60e3); await settle();
    assert.equal(n, 1, 'once per day');
    Jobs.tick(Date.parse('2026-10-22T01:05:00Z')); await settle();
    assert.equal(n, 1, 'Thursday is not a chosen day');
    const job = Jobs.listJobs().find((j) => j.id === 't-daily');
    assert.equal(new Date(Jobs.nextRun({ id: 't-daily', schedule: job.schedule }, Date.parse('2026-10-22T01:05:00Z'))).toISOString(), '2026-10-26T01:00:00.000Z', 'next Monday 09:00 Shanghai');
    assert.equal(Jobs.describeSchedule(job.schedule), '每周 周一、周三 9:00（Asia/Shanghai）');
    assert.equal(Jobs.describeSchedule(Jobs.every(2 * 3600e3)), '每 2 小时');
  });
  test('JB-03 pause / resume, run now (manual), failures recorded and reported, not configured jobs skipped', async () => {
    let failed = null;
    Jobs.onJobFailure((job, detail) => { failed = [job.id, detail]; });
    let n = 0;
    Jobs.registerJob({ id: 't-pause', name: '暂停', schedule: Jobs.every(10, { initialDelay: 0 }), run: () => { n++; } });
    Jobs.registerJob({ id: 't-off', name: '未配置', schedule: Jobs.every(10, { initialDelay: 0 }), enabled: () => false, run: () => { throw new Error('should not run'); } });
    Jobs.registerJob({ id: 't-fail', name: '失败', schedule: Jobs.every(3600e3, { initialDelay: 3600e3 }), run: () => { throw new Error('ERP down'); } });
    Jobs.setPaused('t-pause', true);
    Jobs.tick(); await settle();
    assert.equal(n, 0);
    assert.equal(Jobs.listJobs().find((j) => j.id === 't-pause').next, null);
    const r = await Jobs.runJob('t-pause', { manual: 'ops1' });
    assert.equal(r.ok, true);
    assert.equal(Jobs.jobRuns('t-pause')[0].manual, 'ops1');
    Jobs.setPaused('t-pause', false);
    const f = await Jobs.runJob('t-fail', { manual: 'ops1' });
    assert.deepEqual(f, { ok: false, detail: 'ERP down' });
    await settle();
    assert.deepEqual(failed, ['t-fail', 'ERP down']);
    assert.equal(Jobs.listJobs().find((j) => j.id === 't-fail').lastFail.detail, 'ERP down');
    assert.equal(Jobs.listJobs().find((j) => j.id === 't-off').enabled, false);
    assert.throws(() => Jobs.setPaused('nope', true), /不存在/);
    await assert.rejects(Jobs.runJob('nope'), /不存在/);
  });
  test('JB-04 quiet jobs only record runs that did something or failed', async () => {
    let out = '0';
    Jobs.registerJob({ id: 't-quiet', name: '安静', schedule: Jobs.every(3600e3), quiet: true, run: () => out });
    await Jobs.runJob('t-quiet');
    assert.equal(Jobs.jobRuns('t-quiet').length, 0);
    out = '3';
    await Jobs.runJob('t-quiet');
    assert.equal(Jobs.jobRuns('t-quiet')[0].detail, '3');
  });
});

describe('error log', () => {
  test('ER-01 same error at different ids is one entry with a count; a new error alerts WeCom once', async () => {
    hooks.length = 0;
    const a = E.recordError(new Error('order 123 not found'), { method: 'GET', path: '/admin/orders/9f1c2d3e-aaaa-bbbb-cccc-111122223333' });
    const b = E.recordError(new Error('order 456 not found'), { method: 'GET', path: '/admin/orders/1a2b3c4d-aaaa-bbbb-cccc-444455556666' });
    assert.equal(a, b);
    const row = E.getError(a);
    assert.equal(row.count, 2);
    assert.equal(row.message, 'order 456 not found');
    await settle();
    assert.equal(hooks.length, 1);
    assert.match(hooks[0].markdown.content, /服务器新错误[\s\S]*GET \/admin\/orders\/[\s\S]*order 123 not found/);
  });
  test('ER-02 resolving, coming back (alert again after an hour), search, stats', async () => {
    const id = E.searchErrors({ q: 'not found' })[0].id;
    E.resolveErrors([id], 'ops1');
    assert.equal(E.searchErrors({ status: 'open', q: 'not found' }).length, 0);
    assert.equal(E.getError(id).resolved_by, 'ops1');
    hooks.length = 0;
    db.prepare('UPDATE app_errors SET alerted_at = ? WHERE id = ?').run(new Date(Date.now() - 2 * 3600e3).toISOString(), id);
    E.recordError(new Error('order 789 not found'), { method: 'GET', path: '/admin/orders/5e6f7a8b-aaaa-bbbb-cccc-777788889999' });
    await settle();
    assert.equal(E.getError(id).resolved, 0);
    assert.match(hooks[0].markdown.content, /错误再次出现/);
    E.recordError(new Error('backup failed'), { source: 'job', path: 'backup' });
    const st = E.errorStats(24);
    assert.ok(st.distinct >= 2 && st.open >= 2);
    assert.equal(E.searchErrors({ q: 'backup' })[0].source, 'job');
  });
});

describe('services', () => {
  test('OS-01 configured services are listed; checks record successes with details', async () => {
    const list = S.serviceList();
    assert.deepEqual(list.filter((s) => s.configured).map((s) => s.id).sort(), ['https', 'paypal', 'peer:down', 'peer:grid', 'stripe', 'track17', 'wecom'].sort());
    assert.match((await S.checkService('stripe', 'ops1')).detail, /密钥有效（测试模式）；未配置 STRIPE_WEBHOOK_SECRET/);
    assert.match((await S.checkService('paypal')).detail, /授权成功/);
    assert.equal((await S.checkService('track17')).detail, '剩余查询额度 42 / 100');
    assert.match((await S.checkService('peer:grid')).detail, /在线 · 版本 1\.2\.3 · \d+ ms · 最近备份 成功 · 24 小时错误 0/);
    hooks.length = 0;
    assert.equal((await S.checkService('wecom')).ok, true);
    assert.match(hooks[0].text.content, /连通性测试/);
    assert.equal(S.lastChecks('stripe').lastOk.by, 'ops1');
    await assert.rejects(S.checkService('llm'), /未配置/);
  });
  test('OS-02 a failing service is recorded with the reason and alerted once when it stops working', async () => {
    hooks.length = 0;
    process.env.STRIPE_SECRET_KEY = 'sk_test_bad';
    const r = await S.checkService('stripe');
    assert.deepEqual([r.ok, r.level], [false, 'fail']);
    assert.match(r.detail, /HTTP 401 Invalid API Key provided/);
    await S.checkService('stripe'); // still failing: no second alert
    await settle();
    assert.equal(hooks.filter((h) => /外部服务异常：Stripe/.test(h.markdown?.content || '')).length, 1);
    assert.deepEqual(S.failingServices().map((s) => s.id), ['stripe']);
    const down = await S.checkService('peer:down');
    assert.equal(down.ok, false);
    process.env.STRIPE_SECRET_KEY = 'sk_test_ok';
    await S.checkService('stripe');
    assert.equal(S.lastChecks('stripe').lastFail.level, 'fail');
    assert.equal(S.lastChecks('stripe').last.ok, 1);
  });
  test('OS-03 peers: details only with the shared token', async () => {
    assert.equal((await S.peerHealth(svc.url)).version, '1.2.3');
    process.env.OPS_TOKEN = 'wrong';
    assert.equal((await S.peerHealth(svc.url)).version, undefined);
    process.env.OPS_TOKEN = 'shared';
  });
});

describe('security, configuration, drills', () => {
  test('SC-01 login summary, events, sessions and force logout', async () => {
    const { saveStaff, createSession } = await import('../../server/src/auth.js');
    const Audit = await import('../../server/src/audit.js');
    const u = saveStaff({ username: 'ops1', role: 'ops', password: 'Str0ngPassw0rd' });
    Audit.record({ username: 'ops1', path: '/admin/login', action: 'login', ip: '1.1.1.1' });
    Audit.record({ username: 'ops1', path: '/admin/login', action: 'login_failed', ip: '6.6.6.6', status: 401 });
    createSession(u, '1.1.1.1');
    const s = Sec.loginSummary().find((x) => x.username === 'ops1');
    assert.deepEqual([s.last_ip, s.fails24h, s.ips, s.sessions], ['1.1.1.1', 1, 1, 1]);
    assert.deepEqual(Sec.loginEvents({ user: 'ops1' }).map((e) => e.action), ['login_failed', 'login']);
    assert.deepEqual(Sec.loginEvents({ user: 'ops1', result: 'fail' }).map((e) => e.ip), ['6.6.6.6']);
    const sid = Sec.onlineSessions().find((x) => x.username === 'ops1').sid;
    assert.equal(Sec.kickSession(sid), 'ops1');
    assert.equal(Sec.onlineSessions().some((x) => x.username === 'ops1'), false);
    assert.throws(() => Sec.kickSession(sid), /不存在/);
  });
  test('SC-02 unusual logins: a new IP alerts (not the first login ever); 5 failures in 15 minutes alert once', async () => {
    const Audit = await import('../../server/src/audit.js');
    hooks.length = 0;
    assert.equal(Sec.onLoginAttempt('newbie', '9.9.9.9', true), null, 'first login ever: nothing to compare with');
    assert.equal(Sec.onLoginAttempt('ops1', '1.1.1.1', true), null, 'known IP');
    assert.equal(Sec.onLoginAttempt('ops1', '2.2.2.2', true), 'new_ip');
    for (let i = 0; i < 3; i++) Audit.record({ username: 'ops1', path: '/admin/login', action: 'login_failed', ip: '6.6.6.6', status: 401 });
    assert.equal(Sec.onLoginAttempt('ops1', '6.6.6.6', false), 'locked'); // 1 earlier + 3 + this one = 5
    await settle();
    assert.ok(hooks.some((h) => /新的 IP 登录[\s\S]*ops1[\s\S]*2\.2\.2\.2/.test(h.markdown.content)));
    assert.ok(hooks.some((h) => /后台登录多次失败/.test(h.markdown.content)));
  });
  test('SC-03 configuration check shows what is set (never values) and warns about risky settings', () => {
    const r = Sec.configCheck();
    const item = (k) => r.groups.flatMap((g) => g.items).find((i) => i.key === k);
    assert.equal(item('STRIPE_SECRET_KEY').set, true);
    assert.equal(item('SMTP_URL').set, false);
    assert.ok(!JSON.stringify(r).includes('sk_test_ok'), 'secret values never appear');
    for (const w of [/Stripe 使用的是测试密钥/, /STRIPE_WEBHOOK_SECRET/, /PayPal 仍在沙箱/, /异地备份/]) assert.ok(r.warnings.some((x) => w.test(x)), String(w));
  });
  test('SC-04 restore drill restores a real backup and counts tables; overdue drills and backups are detected', async () => {
    assert.equal(Sec.drillOverdue(), true);
    assert.equal(Sec.backupOverdue(), true);
    const b = await B.backupNow();
    assert.equal(b.ok, true);
    assert.equal(Sec.backupOverdue(), false);
    const d = await Sec.restoreDrill(b.file, 'ops1');
    assert.equal(d.ok, true);
    assert.ok(d.detail.tables.products > 0);
    assert.equal(Sec.restoreDrills()[0].by, 'ops1');
    assert.equal(Sec.drillOverdue(), false);
    await assert.rejects(Sec.restoreDrill('../../etc/passwd'), /不存在/);
  });
});

describe('website versions', () => {
  test('RL-01 list the kept builds with the live one; roll back by swapping the link; refusals', () => {
    for (const n of ['2026-10-19T08-00-00-000Z', '2026-10-20T08-00-00-000Z', '2026-10-21T08-00-00-000Z']) { mkdirSync(join(rel, 'releases', n), { recursive: true }); writeFileSync(join(rel, 'releases', n, 'index.html'), n); }
    symlinkSync(join('releases', '2026-10-21T08-00-00-000Z'), join(rel, 'current'));
    const list = P.listReleases();
    assert.deepEqual(list.map((r) => [r.name.slice(0, 10), r.current]), [['2026-10-21', true], ['2026-10-20', false], ['2026-10-19', false]]);
    P.rollbackRelease('2026-10-20T08-00-00-000Z');
    assert.equal(readlinkSync(join(rel, 'current')), join('releases', '2026-10-20T08-00-00-000Z'));
    assert.equal(P.listReleases()[1].current, true);
    assert.throws(() => P.rollbackRelease('2026-10-20T08-00-00-000Z'), /已经在线上/);
    assert.throws(() => P.rollbackRelease('../x'), /不存在/);
  });
});
