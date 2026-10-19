// Turns JUnit XML reports into a Markdown summary grouped by module (test-case ID prefix, see
// docs/测试用例.md) for $GITHUB_STEP_SUMMARY.
// Usage: node scripts/test-summary.mjs test-results/node-junit.xml test-results/e2e-junit.xml
import { readFileSync, existsSync } from 'node:fs';

const MODULES = {
  SE: '销售规则引擎 shared/sales-engine', DI: '数据字典 shared/dictionary', ML: '机器可读层 llms.txt / .md / JSON-LD',
  CA: '内容智能体 SEO/GEO', KD: '金蝶适配器 + ERP', LL: '大模型调用', AL: '告警推送 企业微信/飞书',
  SV: '销售→交付核心 service', AP: '公开接口 chat / leads', MC: 'MCP 接口', AD: '后台',
  SF: '全流程 线索→报价→订单→发货→售后', AI: 'AI 模式 智能体', KF: '真实金蝶模式', GR: 'YR GRID 后端',
  'E2E-L': '浏览器 E2E · YAORONG LED', 'E2E-G': '浏览器 E2E · YR GRID',
};
const groups = new Map();
const missing = [];
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
for (const file of process.argv.slice(2)) {
  if (!existsSync(file)) { missing.push(file); continue; }
  const xml = readFileSync(file, 'utf8');
  for (const [, attrs, , inner = ''] of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = decode((attrs.match(/name="([^"]*)"/) || [])[1] || '');
    const id = (name.match(/(E2E-[A-Z]|[A-Z]{2})-?\d+/) || [])[0] || '';
    const key = id.startsWith('E2E') ? id.slice(0, 5) : id.slice(0, 2) || 'other';
    const g = groups.get(key) || { pass: 0, fail: 0, skip: 0, failures: [] };
    if (/<failure|<error/.test(inner)) { g.fail++; g.failures.push(name.split(' ')[0]); } else if (/<skipped/.test(inner)) g.skip++; else g.pass++;
    groups.set(key, g);
  }
}
let pass = 0, fail = 0, skip = 0;
const rows = [...groups].map(([k, g]) => {
  pass += g.pass; fail += g.fail; skip += g.skip;
  return `| ${k} | ${MODULES[k] || k} | ${g.pass} | ${g.fail} | ${g.fail ? '❌ ' + g.failures.join(', ') : '✅'} |`;
});
console.log(`## YR sites — test results

**${pass} passed, ${fail} failed, ${skip} skipped** (${pass + fail + skip} test runs)${missing.length ? `\n\n⚠️ report not produced: ${missing.join(', ')}` : ''}

| ID | Module | Passed | Failed | Status |
|---|---|---|---|---|
${rows.join('\n')}

Test case catalogue: \`yr-sites/docs/测试用例.md\``);
