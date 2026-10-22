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
  let n1 = 0, t1;
  test('JB-01a an interval job runs once its initial delay has passed', async () => {
    Jobs.registerJob({ id: 't-every', name: '测试', schedule: Jobs.every(1000, { initialDelay: 0 }), run: () => `run ${++n1}` });
    t1 = Date.now();
    Jobs.tick(t1); await settle();
    assert.equal(n1, 1);
  });
  test('JB-01b an interval job does not run again before the interval', async () => {
    Jobs.tick(t1 + 500); await settle();
    assert.equal(n1, 1, 'not due yet');
  });
  test('JB-01c an interval job runs again after the interval', async () => {
    Jobs.tick(Date.now() + 1100); await settle();
    assert.equal(n1, 2);
  });
  test('JB-01d job runs are recorded, newest first', () => {
    assert.deepEqual(Jobs.jobRuns('t-every').map((r) => r.detail), ['run 2', 'run 1']);
  });
  let n2 = 0;
  test('JB-02a a daily job runs only once in its hour on a chosen day (time zone aware)', async () => {
    Jobs.registerJob({ id: 't-daily', name: '每日', schedule: Jobs.dailyAt(9, { days: [1, 3], tz: 'Asia/Shanghai' }), run: () => { n2++; return 'ok'; } });
    const wed0905 = Date.parse('2026-10-21T01:05:00Z'); // Wednesday 09:05 in Shanghai
    Jobs.tick(wed0905); await settle();
    Jobs.tick(wed0905 + 60e3); await settle();
    assert.equal(n2, 1, 'once per day');
  });
  test('JB-02b a daily job does not run on a day that is not chosen', async () => {
    Jobs.tick(Date.parse('2026-10-22T01:05:00Z')); await settle();
    assert.equal(n2, 1, 'Thursday is not a chosen day');
  });
  test('JB-02c the next run of a daily job is the next chosen day at its hour', () => {
    const job = Jobs.listJobs().find((j) => j.id === 't-daily');
    assert.equal(new Date(Jobs.nextRun({ id: 't-daily', schedule: job.schedule }, Date.parse('2026-10-22T01:05:00Z'))).toISOString(), '2026-10-26T01:00:00.000Z', 'next Monday 09:00 Shanghai');
  });
  test('JB-02d schedules are described in words (weekly days with time zone; every N hours)', () => {
    const job = Jobs.listJobs().find((j) => j.id === 't-daily');
    assert.equal(Jobs.describeSchedule(job.schedule), '每周 周一、周三 9:00（Asia/Shanghai）');
    assert.equal(Jobs.describeSchedule(Jobs.every(2 * 3600e3)), '每 2 小时');
  });
  let failed = null, n3 = 0;
  test('JB-03a a paused job does not run and has no next run', async () => {
    Jobs.onJobFailure((job, detail) => { failed = [job.id, detail]; });
    Jobs.registerJob({ id: 't-pause', name: '暂停', schedule: Jobs.every(10, { initialDelay: 0 }), run: () => { n3++; } });
    Jobs.registerJob({ id: 't-off', name: '未配置', schedule: Jobs.every(10, { initialDelay: 0 }), enabled: () => false, run: () => { throw new Error('should not run'); } });
    Jobs.registerJob({ id: 't-fail', name: '失败', schedule: Jobs.every(3600e3, { initialDelay: 3600e3 }), run: () => { throw new Error('ERP down'); } });
    Jobs.setPaused('t-pause', true);
    Jobs.tick(); await settle();
    assert.equal(n3, 0);
    assert.equal(Jobs.listJobs().find((j) => j.id === 't-pause').next, null);
  });
  test('JB-03b run now works on a paused job and records who ran it', async () => {
    const r = await Jobs.runJob('t-pause', { manual: 'ops1' });
    assert.equal(r.ok, true);
    assert.equal(Jobs.jobRuns('t-pause')[0].manual, 'ops1');
    Jobs.setPaused('t-pause', false);
  });
  test('JB-03c a failing job returns the error, is reported and keeps the last failure', async () => {
    const f = await Jobs.runJob('t-fail', { manual: 'ops1' });
    assert.deepEqual(f, { ok: false, detail: 'ERP down' });
    await settle();
    assert.deepEqual(failed, ['t-fail', 'ERP down']);
    assert.equal(Jobs.listJobs().find((j) => j.id === 't-fail').lastFail.detail, 'ERP down');
  });
  test('JB-03d a job that is not configured is listed as disabled and skipped', () => {
    assert.equal(Jobs.listJobs().find((j) => j.id === 't-off').enabled, false);
  });
  test('JB-03e pausing or running an unknown job is refused', async () => {
    assert.throws(() => Jobs.setPaused('nope', true), /不存在/);
    await assert.rejects(Jobs.runJob('nope'), /不存在/);
  });
  let out4 = '0';
  test('JB-04a a quiet job that did nothing records no run', async () => {
    Jobs.registerJob({ id: 't-quiet', name: '安静', schedule: Jobs.every(3600e3), quiet: true, run: () => out4 });
    await Jobs.runJob('t-quiet');
    assert.equal(Jobs.jobRuns('t-quiet').length, 0);
  });
  test('JB-04b a quiet job that did something records its run', async () => {
    out4 = '3';
    await Jobs.runJob('t-quiet');
    assert.equal(Jobs.jobRuns('t-quiet')[0].detail, '3');
  });
});

describe('error log', () => {
  test('ER-01a the same error at different ids is one entry with a count and the latest message', () => {
    hooks.length = 0;
    const a = E.recordError(new Error('order 123 not found'), { method: 'GET', path: '/admin/orders/9f1c2d3e-aaaa-bbbb-cccc-111122223333' });
    const b = E.recordError(new Error('order 456 not found'), { method: 'GET', path: '/admin/orders/1a2b3c4d-aaaa-bbbb-cccc-444455556666' });
    assert.equal(a, b);
    const row = E.getError(a);
    assert.equal(row.count, 2);
    assert.equal(row.message, 'order 456 not found');
  });
  test('ER-01b a new error alerts WeCom once with the request and the first message', async () => {
    await settle();
    assert.equal(hooks.length, 1);
    assert.match(hooks[0].markdown.content, /服务器新错误[\s\S]*GET \/admin\/orders\/[\s\S]*order 123 not found/);
  });
  let id2;
  test('ER-02a resolving an error removes it from the open list and records who resolved it', () => {
    id2 = E.searchErrors({ q: 'not found' })[0].id;
    E.resolveErrors([id2], 'ops1');
    assert.equal(E.searchErrors({ status: 'open', q: 'not found' }).length, 0);
    assert.equal(E.getError(id2).resolved_by, 'ops1');
  });
  test('ER-02b a resolved error that comes back is reopened and alerted again after an hour', async () => {
    hooks.length = 0;
    db.prepare('UPDATE app_errors SET alerted_at = ? WHERE id = ?').run(new Date(Date.now() - 2 * 3600e3).toISOString(), id2);
    E.recordError(new Error('order 789 not found'), { method: 'GET', path: '/admin/orders/5e6f7a8b-aaaa-bbbb-cccc-777788889999' });
    await settle();
    assert.equal(E.getError(id2).resolved, 0);
    assert.match(hooks[0].markdown.content, /错误再次出现/);
  });
  test('ER-02c error stats count distinct and open errors', () => {
    E.recordError(new Error('backup failed'), { source: 'job', path: 'backup' });
    const st = E.errorStats(24);
    assert.ok(st.distinct >= 2 && st.open >= 2);
  });
  test('ER-02d search finds errors by text and keeps their source', () => {
    assert.equal(E.searchErrors({ q: 'backup' })[0].source, 'job');
  });
});

describe('services', () => {
  test('OS-01a the configured services are listed', () => {
    const list = S.serviceList();
    assert.deepEqual(list.filter((s) => s.configured).map((s) => s.id).sort(), ['https', 'paypal', 'peer:down', 'peer:grid', 'stripe', 'track17', 'wecom'].sort());
  });
  test('OS-01b the Stripe check reports a valid test key and a missing webhook secret', async () => {
    assert.match((await S.checkService('stripe', 'ops1')).detail, /密钥有效（测试模式）；未配置 STRIPE_WEBHOOK_SECRET/);
  });
  test('OS-01c the PayPal check reports a successful authorisation', async () => {
    assert.match((await S.checkService('paypal')).detail, /授权成功/);
  });
  test('OS-01d the 17TRACK check reports the remaining quota', async () => {
    assert.equal((await S.checkService('track17')).detail, '剩余查询额度 42 / 100');
  });
  test('OS-01e the peer site check reports version, latency, backup and errors', async () => {
    assert.match((await S.checkService('peer:grid')).detail, /在线 · 版本 1\.2\.3 · \d+ ms · 最近备份 成功 · 24 小时错误 0/);
  });
  test('OS-01f the WeCom check sends a connectivity test message', async () => {
    hooks.length = 0;
    assert.equal((await S.checkService('wecom')).ok, true);
    assert.match(hooks[0].text.content, /连通性测试/);
  });
  test('OS-01g the last successful check is recorded with who ran it', () => {
    assert.equal(S.lastChecks('stripe').lastOk.by, 'ops1');
  });
  test('OS-01h checking a service that is not configured is refused', async () => {
    await assert.rejects(S.checkService('llm'), /未配置/);
  });
  test('OS-02a a failing service is recorded as failed with the reason', async () => {
    hooks.length = 0;
    process.env.STRIPE_SECRET_KEY = 'sk_test_bad';
    const r = await S.checkService('stripe');
    assert.deepEqual([r.ok, r.level], [false, 'fail']);
    assert.match(r.detail, /HTTP 401 Invalid API Key provided/);
  });
  test('OS-02b a service that keeps failing is alerted only once', async () => {
    await S.checkService('stripe'); // still failing: no second alert
    await settle();
    assert.equal(hooks.filter((h) => /外部服务异常：Stripe/.test(h.markdown?.content || '')).length, 1);
  });
  test('OS-02c the failing service is listed among failing services', () => {
    assert.deepEqual(S.failingServices().map((s) => s.id), ['stripe']);
  });
  test('OS-02d an unreachable peer site fails its check', async () => {
    const down = await S.checkService('peer:down');
    assert.equal(down.ok, false);
  });
  test('OS-02e after recovery the last check is OK and the last failure is kept', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_ok';
    await S.checkService('stripe');
    assert.equal(S.lastChecks('stripe').lastFail.level, 'fail');
    assert.equal(S.lastChecks('stripe').last.ok, 1);
  });
  test('OS-03a a peer returns details with the shared token', async () => {
    assert.equal((await S.peerHealth(svc.url)).version, '1.2.3');
  });
  test('OS-03b a peer returns no details with a wrong token', async () => {
    process.env.OPS_TOKEN = 'wrong';
    try {
      assert.equal((await S.peerHealth(svc.url)).version, undefined);
    } finally { process.env.OPS_TOKEN = 'shared'; }
  });
});

describe('security, configuration, drills', () => {
  let sid;
  test('SC-01a the login summary shows last IP, failures, IPs and sessions per user', async () => {
    const { saveStaff, createSession } = await import('../../server/src/auth.js');
    const Audit = await import('../../server/src/audit.js');
    const u = saveStaff({ username: 'ops1', role: 'ops', password: 'Str0ngPassw0rd' });
    Audit.record({ username: 'ops1', path: '/admin/login', action: 'login', ip: '1.1.1.1' });
    Audit.record({ username: 'ops1', path: '/admin/login', action: 'login_failed', ip: '6.6.6.6', status: 401 });
    createSession(u, '1.1.1.1');
    const s = Sec.loginSummary().find((x) => x.username === 'ops1');
    assert.deepEqual([s.last_ip, s.fails24h, s.ips, s.sessions], ['1.1.1.1', 1, 1, 1]);
  });
  test('SC-01b login events are listed newest first and filter by result', () => {
    assert.deepEqual(Sec.loginEvents({ user: 'ops1' }).map((e) => e.action), ['login_failed', 'login']);
    assert.deepEqual(Sec.loginEvents({ user: 'ops1', result: 'fail' }).map((e) => e.ip), ['6.6.6.6']);
  });
  test('SC-01c force logout ends the online session', () => {
    sid = Sec.onlineSessions().find((x) => x.username === 'ops1').sid;
    assert.equal(Sec.kickSession(sid), 'ops1');
    assert.equal(Sec.onlineSessions().some((x) => x.username === 'ops1'), false);
  });
  test('SC-01d forcing out a session that no longer exists is refused', () => {
    assert.throws(() => Sec.kickSession(sid), /不存在/);
  });
  test('SC-02a the first login ever does not alert', () => {
    hooks.length = 0;
    assert.equal(Sec.onLoginAttempt('newbie', '9.9.9.9', true), null, 'first login ever: nothing to compare with');
  });
  test('SC-02b a login from a known IP does not alert', () => {
    assert.equal(Sec.onLoginAttempt('ops1', '1.1.1.1', true), null, 'known IP');
  });
  test('SC-02c a login from a new IP is flagged', () => {
    assert.equal(Sec.onLoginAttempt('ops1', '2.2.2.2', true), 'new_ip');
  });
  test('SC-02d 5 failures within 15 minutes lock the account', async () => {
    const Audit = await import('../../server/src/audit.js');
    for (let i = 0; i < 3; i++) Audit.record({ username: 'ops1', path: '/admin/login', action: 'login_failed', ip: '6.6.6.6', status: 401 });
    assert.equal(Sec.onLoginAttempt('ops1', '6.6.6.6', false), 'locked'); // 1 earlier + 3 + this one = 5
  });
  test('SC-02e the new IP and the repeated failures are alerted', async () => {
    await settle();
    assert.ok(hooks.some((h) => /新的 IP 登录[\s\S]*ops1[\s\S]*2\.2\.2\.2/.test(h.markdown.content)));
    assert.ok(hooks.some((h) => /后台登录多次失败/.test(h.markdown.content)));
  });
  let r3;
  const item = (k) => r3.groups.flatMap((g) => g.items).find((i) => i.key === k);
  test('SC-03a the configuration check shows which settings are set', () => {
    r3 = Sec.configCheck();
    assert.equal(item('STRIPE_SECRET_KEY').set, true);
    assert.equal(item('SMTP_URL').set, false);
  });
  test('SC-03b the configuration check never shows secret values', () => {
    assert.ok(!JSON.stringify(r3).includes('sk_test_ok'), 'secret values never appear');
  });
  test('SC-03c the configuration check warns about risky settings', () => {
    for (const w of [/Stripe 使用的是测试密钥/, /STRIPE_WEBHOOK_SECRET/, /PayPal 仍在沙箱/, /异地备份/]) assert.ok(r3.warnings.some((x) => w.test(x)), String(w));
  });
  let b4;
  test('SC-04a without backups or drills, both are detected as overdue', () => {
    assert.equal(Sec.drillOverdue(), true);
    assert.equal(Sec.backupOverdue(), true);
  });
  test('SC-04b a fresh backup clears the backup overdue flag', async () => {
    b4 = await B.backupNow();
    assert.equal(b4.ok, true);
    assert.equal(Sec.backupOverdue(), false);
  });
  test('SC-04c a restore drill restores the real backup, counts tables and records who ran it', async () => {
    const d = await Sec.restoreDrill(b4.file, 'ops1');
    assert.equal(d.ok, true);
    assert.ok(d.detail.tables.products > 0);
    assert.equal(Sec.restoreDrills()[0].by, 'ops1');
  });
  test('SC-04d a recent drill clears the drill overdue flag', () => {
    assert.equal(Sec.drillOverdue(), false);
  });
  test('SC-04e a drill on a file that is not a backup is refused', async () => {
    await assert.rejects(Sec.restoreDrill('../../etc/passwd'), /不存在/);
  });
});

describe('website versions', () => {
  test('RL-01a the kept builds are listed newest first with the live one marked', () => {
    for (const n of ['2026-10-19T08-00-00-000Z', '2026-10-20T08-00-00-000Z', '2026-10-21T08-00-00-000Z']) { mkdirSync(join(rel, 'releases', n), { recursive: true }); writeFileSync(join(rel, 'releases', n, 'index.html'), n); }
    symlinkSync(join('releases', '2026-10-21T08-00-00-000Z'), join(rel, 'current'));
    const list = P.listReleases();
    assert.deepEqual(list.map((r) => [r.name.slice(0, 10), r.current]), [['2026-10-21', true], ['2026-10-20', false], ['2026-10-19', false]]);
  });
  test('RL-01b rolling back swaps the live link to the chosen build', () => {
    P.rollbackRelease('2026-10-20T08-00-00-000Z');
    assert.equal(readlinkSync(join(rel, 'current')), join('releases', '2026-10-20T08-00-00-000Z'));
    assert.equal(P.listReleases()[1].current, true);
  });
  test('RL-01c rolling back to the build already live is refused', () => {
    assert.throws(() => P.rollbackRelease('2026-10-20T08-00-00-000Z'), /已经在线上/);
  });
  test('RL-01d rolling back to an unknown build is refused', () => {
    assert.throws(() => P.rollbackRelease('../x'), /不存在/);
  });
});
