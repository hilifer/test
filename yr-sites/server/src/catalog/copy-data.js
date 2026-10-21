// Content used by copywriting.js that must stay as written in either language (banned words, built-in prompt
// templates, words used in generated titles and prompts). Not admin UI text, so it is not translated.
export const BANNED = [
  ['best', 'en', 'warn', '绝对化用语'], ['No.1', 'en', 'warn', '绝对化用语'], ['number one', 'en', 'warn', '绝对化用语'], ['world\'s first', 'en', 'block', '无法证明的首创宣称'],
  ['100% guaranteed', 'en', 'block', '无法兑现的保证'], ['lifetime warranty', 'en', 'warn', '与实际质保不符时有风险'], ['never fails', 'en', 'block', '无法兑现的保证'], ['zero defect', 'en', 'warn', '无法兑现的保证'],
  ['cure', 'en', 'block', '医疗功效宣称'], ['anti-virus', 'en', 'block', '医疗功效宣称'], ['kills bacteria', 'en', 'block', '医疗功效宣称'], ['FDA approved', 'en', 'block', '照明产品不由 FDA 批准'],
  ['cheapest', 'en', 'warn', '绝对化用语'], ['replica', 'en', 'block', '仿冒'], ['copy of', 'en', 'block', '仿冒'],
  ['最佳', 'zh', 'block', '广告法：绝对化用语'], ['最好', 'zh', 'block', '广告法：绝对化用语'], ['第一', 'zh', 'block', '广告法：绝对化用语'], ['国家级', 'zh', 'block', '广告法：绝对化用语'], ['最高级', 'zh', 'block', '广告法：绝对化用语'],
  ['顶级', 'zh', 'block', '广告法：绝对化用语'], ['极致', 'zh', 'warn', '广告法：绝对化用语'], ['绝对', 'zh', 'warn', '广告法：绝对化用语'], ['唯一', 'zh', 'warn', '广告法：绝对化用语'], ['首个', 'zh', 'warn', '广告法：绝对化用语'],
  ['永不', 'zh', 'warn', '无法兑现的保证'], ['杀菌', 'zh', 'block', '医疗功效宣称'], ['治疗', 'zh', 'block', '医疗功效宣称'], ['高仿', 'zh', 'block', '仿冒'],
];

export const TEMPLATES = [
  { id: 'b-title-seo-en', kind: 'title', lang: 'en', name: 'SEO title (English)', body: 'Write {{count}} English product titles for our own website. Product: {{name}} ({{model}}). Key specs: {{specs}}. Certifications: {{certifications}}. Buyers search for: {{keywords}}. Direction: {{direction}}. Put the most searched words first, include wattage and the main certification, max {{maxLength}} characters, no exaggerated claims.' },
  { id: 'b-title-b2b-en', kind: 'title', lang: 'en', name: 'B2B wholesale title (English)', body: 'Write {{count}} English titles aimed at contractors, distributors and project buyers. Product: {{name}} ({{model}}). Specs: {{specs}}. Certifications: {{certifications}}. Mention application and what matters for bulk orders. Max {{maxLength}} characters. Direction: {{direction}}.' },
  { id: 'b-title-zh', kind: 'title', lang: 'zh', name: '中文标题', body: '为独立站写 {{count}} 个中文商品标题。产品：{{name}}（型号 {{model}}）。主要参数：{{specs}}。认证：{{certifications}}。客户常搜：{{keywords}}。方向：{{direction}}。核心词放前面，写清功率和应用场景，不超过 {{maxLength}} 个字，不用"最""第一"等绝对化用语。' },
  { id: 'b-image-white', kind: 'image', lang: 'zh', name: '白底主图', body: '纯白背景（#FFFFFF），商品居中，四周留白 6%，保留真实颜色和阴影，不加文字、水印和其他物品，输出 {{size}} 方图。' },
  { id: 'b-image-scene-en', kind: 'image', lang: 'en', name: 'Scene image (English)', body: 'Place the {{name}} in a realistic {{scene}} setting, natural lighting, product sharp and true to colour, no added text or logos, {{size}}.' },
  { id: 'b-desc-en', kind: 'description', lang: 'en', name: 'Product description (English)', body: 'Write a clear product description for {{name}} ({{model}}): who it is for, 3–5 benefits backed by the specs ({{specs}}), certifications ({{certifications}}) and warranty ({{warranty}}). Plain language, no claims we cannot prove.' },
];

export const WORDS = {
  en: { wholesale: 'Wholesale & OEM', projects: (app) => `for ${app} Projects`, reference: 'Reference page title (learn structure and keywords only; never copy brands or model numbers)', request: (t) => `Request: ${t}` },
  zh: { wholesale: '工厂直供 支持 OEM', projects: (app) => `${app}工程`, reference: '参考页面的标题（只借鉴结构和关键词，不要照抄品牌或型号）', request: (t) => `要求：${t}` },
};

export const PROMPT_RULES = {
  zh: {
    image: ['构图：商品居中，完整显示，四周适当留白', '背景：未指定时用纯白（#FFFFFF）', '光线：自然柔和，保留真实颜色和材质', '尺寸：主图 800×800 或以上的方图', '避免：文字、水印、其他品牌标志、变形和多余物品'],
    copy: ['语言：简体中文，面向采购和工程客户', '内容：只用已提供的参数和认证，不编造', '避免：绝对化用语（最、第一、顶级等）和无法兑现的保证'],
  },
  en: {
    image: ['Composition: product centred, fully visible, even margins', 'Background: pure white (#FFFFFF) unless stated', 'Lighting: soft and natural, true colours and materials', 'Size: square, 800×800 or larger for main images', 'Avoid: text, watermarks, other brands\' logos, distortion, extra objects'],
    copy: ['Language: plain English for buyers and contractors', 'Content: only the given specs and certifications — invent nothing', 'Avoid: absolute claims (best, No.1…) and guarantees we cannot keep'],
  },
};
