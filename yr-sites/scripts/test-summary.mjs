// Turns JUnit XML reports into a Markdown summary for $GITHUB_STEP_SUMMARY: one row per module (test-case ID prefix,
// see docs/测试用例.md) and, under each module, every single test case with its result and time. Prints one ::error
// annotation per failing test, so failures are visible in the run's annotations even where the raw log is not.
// Usage: node scripts/test-summary.mjs <title> report1.xml [report2.xml …]
import { appendFileSync } from 'node:fs';
import { parseJunit, MODULES } from './junit.mjs';

const [title = 'Test results', ...files] = process.argv.slice(2);
const md = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const { groups, keys, missing, annotations, pass, fail, skip } = parseJunit(files);
const icon = { pass: '✅', fail: '❌', skip: '⏭️' };
const out = [`## ${title}`, '', `**${pass} passed, ${fail} failed, ${skip} skipped** (${pass + fail + skip} test cases)${missing.length ? `\n\n⚠️ report not produced: ${missing.join(', ')}` : ''}`, '',
  '| ID | Module | Passed | Failed | Skipped |', '|---|---|---|---|---|',
  ...keys.map((k) => { const g = groups.get(k); return `| ${k} | ${MODULES[k] || k} | ${g.pass} | ${g.fail ? `**${g.fail}** ❌` : 0} | ${g.skip || ''} |`; }), '',
  '### Every test case', '',
  ...keys.map((k) => { const g = groups.get(k); return `<details${g.fail ? ' open' : ''}><summary>${k} · ${MODULES[k] || k} — ${g.pass}/${g.cases.length} passed${g.fail ? `, ${g.fail} failed` : ''}</summary>\n\n| | Test case | Time |\n|---|---|---|\n${g.cases.map((c) => `| ${icon[c.status]} | ${md(c.name)}${c.msg ? `<br><sub>${md(c.msg)}</sub>` : ''} | ${c.time.toFixed(2)} s |`).join('\n')}\n\n</details>`; }),
  '', 'Test case catalogue: `yr-sites/docs/测试用例.md`', ''];
const summary = out.join('\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n'); else console.log(summary);
for (const a of annotations.slice(0, 50)) console.log(a);
