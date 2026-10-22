// Publishes every test case as a GitHub check run ("yr-sites test cases"): module table and failures in the summary,
// every case in the details (GitHub allows 65 535 characters there; the full list is also in the run summary), and an
// annotation per failing case. Needs GITHUB_TOKEN with checks:write, GITHUB_REPOSITORY and HEAD_SHA.
// Usage: node scripts/publish-check.mjs report1.xml [report2.xml …]
import { parseJunit, MODULES } from './junit.mjs';

const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, HEAD_SHA: sha, GITHUB_SERVER_URL: server = 'https://github.com', GITHUB_RUN_ID: runId } = process.env;
const r = parseJunit(process.argv.slice(2));
const icon = { pass: '✅', fail: '❌', skip: '⏭️' };
const title = `${r.pass} passed, ${r.fail} failed, ${r.skip} skipped`;
const summary = [`**${title}** (${r.pass + r.fail + r.skip} test cases)${r.missing.length ? ` · report not produced: ${r.missing.join(', ')}` : ''}`, '',
  '| ID | Module | Passed | Failed | Skipped |', '|---|---|---|---|---|',
  ...r.keys.map((k) => { const g = r.groups.get(k); return `| ${k} | ${MODULES[k] || k} | ${g.pass} | ${g.fail || 0} | ${g.skip || 0} |`; }),
  runId ? `\nDemo videos and the full list: ${server}/${repo}/actions/runs/${runId}` : ''].join('\n');
let text = '';
for (const k of r.keys) {
  const g = r.groups.get(k);
  const block = `### ${k} · ${MODULES[k] || k}\n${g.cases.map((c) => `${icon[c.status]} ${c.name}${c.msg && c.status === 'fail' ? ` — ${c.msg}` : ''}`).join('\n')}\n\n`;
  if (text.length + block.length > 64000) { text += `… (list truncated — see the run summary for every case)\n`; break; }
  text += block;
}
const annotations = [];
for (const k of r.keys) for (const c of r.groups.get(k).cases.filter((x) => x.status === 'fail')) annotations.push({ path: '.github/workflows/yr-sites-ci.yml', start_line: 1, end_line: 1, annotation_level: 'failure', title: c.name.slice(0, 250), message: c.msg || 'failed' });
const body = { name: 'yr-sites test cases', head_sha: sha, status: 'completed', conclusion: r.fail ? 'failure' : 'success', output: { title, summary: summary.slice(0, 65000), text, annotations: annotations.slice(0, 50) } };
if (!token || !repo || !sha) { console.log(JSON.stringify({ ...body, output: { ...body.output, text: `${text.length} chars` } }, null, 2).slice(0, 2000)); process.exit(0); }
const res = await fetch(`https://api.github.com/repos/${repo}/check-runs`, { method: 'POST', headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' }, body: JSON.stringify(body) });
const j = await res.json();
if (!res.ok) { console.error('check run not created:', res.status, j.message); process.exit(1); }
console.log(`check run created: ${j.html_url} (${title})`);
