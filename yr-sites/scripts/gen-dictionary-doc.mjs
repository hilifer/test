// Regenerates docs/数据字典.md from shared/dictionary.js so the doc never drifts from the code.
import { writeFileSync } from 'node:fs';
import { DICT } from '../shared/dictionary.js';
const names = { quote: '报价单（PI）', order: '订单', shipment: '发货单', rma: '售后单（RMA）' };
let md = `# 数据字典：销售 → 交付闭环\n\n本文件由 \`node scripts/gen-dictionary-doc.mjs\` 根据 \`shared/dictionary.js\` 自动生成。系统所有状态、允许的流转、编号规则都以此为准；后台、客户中心、AI 客服和金蝶对接读的都是同一份定义。\n\n## 主线\n\n线索 → 报价单（PI）→ 客户在线确认 → 订单 → 收定金 → 生产/备货 → 待发货 → 发货单（物流动态）→ 签收 → 完成；签收后可发起售后单（RMA），补发走售后发货单。\n\n## 编号规则\n\n| 对象 | 格式 | 示例 |\n|---|---|---|\n`;
for (const k of ['quote', 'order', 'shipment', 'rma']) md += `| ${names[k]} | ${DICT[k].prefix}-年月日-当日序号 | ${DICT[k].prefix}-261017-001 |\n`;
for (const k of ['quote', 'order', 'shipment', 'rma']) {
  md += `\n## ${names[k]}状态\n\n| 代码 | 中文 | 英文（客户可见） | 可流转到 |\n|---|---|---|---|\n`;
  for (const [s, v] of Object.entries(DICT[k].states)) md += `| \`${s}\` | ${v.zh} | ${v.en} | ${(DICT[k].transitions[s] || []).map((t) => DICT[k].states[t].zh).join('、') || '—（终态）'} |\n`;
}
md += `\n## 自动规则\n\n- 客户在门户确认 PI → 自动生成订单（待付定金），并按配置推送金蝶销售订单。\n- 登记收款累计达到应收定金 → 订单自动进入「生产/备货中」。\n- 发货单状态改为「运输中」→ 订单自动变为「已发货」；改为「已签收」→ 订单自动变为「已签收」。\n- 订单标记「已完成」前必须收清全款。\n- 付款条款为「30% 定金 70% 发货前」或「100% 预付」时，待发货阶段未收清尾款会在订单页醒目提示。\n- 订单占用库存 = 待付定金、生产/备货中、待发货三个状态的订单数量。\n`;
md += `\n## 付款方式\n\n| 代码 | 中文 | 英文 |\n|---|---|---|\n${DICT.paymentTerms.map((t) => `| \`${t.id}\` | ${t.zh} | ${t.en} |`).join('\n')}\n`;
md += `\n## 售后问题类型与处理方式\n\n| 问题类型 | 中文 | | 处理方式 | 中文 |\n|---|---|---|---|---|\n`;
const iss = Object.entries(DICT.rma.issues), res = Object.entries(DICT.rma.resolutions);
for (let i = 0; i < Math.max(iss.length, res.length); i++) md += `| ${iss[i] ? '`' + iss[i][0] + '`' : ''} | ${iss[i]?.[1].zh || ''} | | ${res[i] ? '`' + res[i][0] + '`' : ''} | ${res[i]?.[1].zh || ''} |\n`;
md += `\n## 运输方式\n\n${Object.entries(DICT.shipment.modes).map(([k, v]) => `- \`${k}\` ${v.zh} / ${v.en}`).join('\n')}\n\n## 价格条款\n\n${DICT.incoterms.join('、')}\n`;
writeFileSync(new URL('../docs/数据字典.md', import.meta.url), md);
console.log('docs/数据字典.md updated');
