// Reads JUnit XML reports (node:test, Playwright) into modules (test-case ID prefix, see docs/测试用例.md) with every
// test case, its result, time and failure message. Shared by test-summary.mjs and publish-check.mjs.
import { readFileSync, existsSync } from 'node:fs';

export const MODULES = {
  SE: '销售规则引擎', DI: '数据字典', ML: '机器可读层 llms.txt / .md / JSON-LD', CA: '内容智能体 SEO/GEO', KD: '金蝶适配器', KF: '真实金蝶模式', LL: '大模型调用', AL: '告警推送',
  SV: '销售→交付核心', AP: '公开接口 chat / leads', MC: 'MCP 接口', AD: '后台', SF: '全流程 线索→报价→订单→发货→售后', AI: 'AI 模式智能体', GR: '运营数据（单元）',
  AU: '账号、角色与登录安全', PC: '商品中心（单元）', PA: '商品中心（接口）', SH: '网店交易（单元）', SA: '网店交易（接口）', AS: '物流与售后（单元）', AA: '物流与售后（接口）',
  MK: '营销（单元）', MA: '营销（接口）', LS: 'AI 自动上架（单元）', 'LS-A': 'AI 自动上架（接口）', DL: 'AI 议价与电子合同（单元）', DA: 'AI 议价与电子合同（接口）', LC: '人工客服接管',
  BK: '数据库备份', SY: '系统状态', MD: '素材仓库（单元）', MS: '素材仓库（接口）', IP: '图片处理（单元）', MP: '图片处理（接口）', TK: '任务中心', CW: '标题与提示词（单元）', CP: '标题与提示词（接口）',
  PL: '链接拉取', JB: '定时任务', ER: '错误日志', OS: '服务连通性', SC: '登录安全与配置检查', OP: '运维中心（接口）', CR: '业务 CRM（单元）', EM: '邮件营销', NA: '新品区',
  GA: '运营（接口）', FN: '财务（单元）', FA: '财务（接口）', WH: '仓库（单元）', WA: '仓库（接口）', SD: '客服（单元）', CS: '客服（接口）', GV: '管理员看板与审批（单元）', GO: '管理员看板与审批（接口）',
  LT: '品牌资产与排版模板（单元）', BA: '品牌资产与排版模板（接口）', NT: '消息提醒（单元）', NS: '消息提醒（接口）', IN: '后台中英文（单元）', 'IN-A': '后台中英文（接口）', WB: '岗位工作台', RL: '岗位与权限', OL: '操作日志',
  LV: '真实第三方服务（沙箱）', 'E2E-L': '浏览器 E2E · YAORONG LED', 'E2E-G': '浏览器 E2E · YR GRID', 'E2E-S': '浏览器 E2E · 网店', 'E2E-P': '浏览器 E2E · 商品中心',
  FT: '演示视频 · 功能演示', 'PG-LED': '演示视频 · LED 网站页面', 'PG-GRID': '演示视频 · GRID 网站页面', 'PG-SHOP': '演示视频 · 网店', 'PG-ADMIN': '演示视频 · 后台页面',
};
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#10;/g, ' ').replace(/&amp;/g, '&');
export function parseJunit(files) {
const groups = new Map(), missing = [], annotations = [];
for (const file of files) {
  if (!existsSync(file)) { missing.push(file); continue; }
  const xml = readFileSync(file, 'utf8');
  for (const [, attrs, , inner = ''] of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = decode((attrs.match(/\bname="([^"]*)"/) || [])[1] || '');
    const time = Number((attrs.match(/\btime="([^"]*)"/) || [])[1] || 0);
    const key = (name.match(/^(E2E-[A-Z]|PG-[A-Z]+|[A-Z]{2}-A(?=-?\d)|[A-Z]{2})(?=[-\s\d])/) || [])[1] || 'other';
    const g = groups.get(key) || { pass: 0, fail: 0, skip: 0, cases: [] };
    let status = 'pass', msg = '';
    if (/<failure|<error/.test(inner)) {
      status = 'fail';
      msg = decode((inner.match(/<(?:failure|error)[^>]*message="([^"]*)"/) || inner.match(/<(?:failure|error)[^>]*>([\s\S]{0,600})/) || [])[1] || '').replace(/\s+/g, ' ').slice(0, 300);
      annotations.push(`::error title=${name.slice(0, 120).replace(/[:,\n]/g, ' ')}::${msg.replace(/%/g, '%25') || 'failed'}`);
    } else if (/<skipped/.test(inner)) { status = 'skip'; msg = decode((inner.match(/<skipped[^>]*message="([^"]*)"/) || [])[1] || ''); }
    g[status]++;
    g.cases.push({ name, time, status, msg });
    groups.set(key, g);
  }
}
const ORDER = Object.keys(MODULES);
const keys = [...groups.keys()].sort((a, b) => (ORDER.indexOf(a) + 1 || 999) - (ORDER.indexOf(b) + 1 || 999));
let pass = 0, fail = 0, skip = 0;
for (const k of keys) { const g = groups.get(k); pass += g.pass; fail += g.fail; skip += g.skip; }
return { groups, keys, missing, annotations, pass, fail, skip };
}
