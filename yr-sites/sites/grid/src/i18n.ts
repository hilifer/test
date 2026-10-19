export type Lang = 'en' | 'zh';
export const langs: Lang[] = ['en', 'zh'];

/** Prefix a path for a language. English lives at the root, Chinese under /zh/. */
export const lp = (lang: Lang, path: string) => (lang === 'zh' ? `/zh${path}` : path);
/** The same page in the other language. */
export const swap = (lang: Lang, pathname: string) => (lang === 'zh' ? pathname.replace(/^\/zh/, '') || '/' : `/zh${pathname}`);

const S = {
  en: {
    nav_products: 'Products', nav_solutions: 'Solutions', nav_calc: 'ROI calculator', nav_partners: 'Partners', nav_about: 'About', nav_news: 'News', cta_quote: 'Get a quote', menu: 'Menu',
    demo: 'Preview build. Product specifications, certifications, prices and calculator assumptions are sample data until replaced with verified figures.',
    talk: 'Talk to sales', ai247: 'AI assistant answers 24/7.', forai: 'For AI agents', privacy: 'Privacy & cookies', corporate: 'Corporate site', otherlang: '中文',
    moq: 'MOQ', from: 'From', lead: 'Lead time', samples: 'Samples', warranty: 'Warranty', days: 'days', specs: 'Specifications', refprice: 'Reference price', qty: 'Quantity', unitprice: 'Unit price',
    price_note_long: 'Range covers configuration options. Freight is quoted on the PI.', instant: 'Get an instant reference price', formal: 'Request a formal PI', certs: 'Certifications', faq: 'Common questions', alsoin: 'Also in', mdv: 'Machine-readable version',
    allprods: 'All products', products_lede: 'Storage, inverters, modules and EV chargers. Every page lists specifications, certifications, MOQ, lead time and a reference price range.',
    q_title: 'Request a formal quotation', q_lede: 'Tell us the quantity, configuration and destination. A sales engineer replies with a PI including freight, normally within one business day.',
    f_name: 'Name', f_company: 'Company', f_email: 'Work email', f_wa: 'WhatsApp or phone', f_country: 'Country', f_type: 'You are', f_choose: 'Choose one', f_product: 'Product', f_notsure: 'Not sure yet', f_qty: 'Quantity', f_when: 'Buying', f_whenq: 'When?', f_details: 'Project details', f_consent: 'I agree that YR GRID may contact me about this request. See the', f_privacy: 'privacy notice', f_send: 'Send request',
    f_types: ['Distributor / installer', 'EPC contractor', 'Building or factory owner', 'Charging operator / fleet', 'Brand (OEM/ODM)', 'Other'],
    f_whens: ['Within 1 month', 'In 2–3 months', 'Later this year', 'Just researching'],
    f_need_contact: 'Add a work email or WhatsApp number so we can send the quotation.', f_need_consent: 'Tick the consent box so we can contact you.', f_sending: 'Sending…', f_sent: 'Request sent. A sales engineer will email you, normally within one business day.', f_fail: 'Not sent', f_unreach: 'the server is not reachable in this preview',
    news_title: 'Insights and news', news_lede: 'Market updates, policy changes and practical guides for solar, storage and EV charging projects.', allarticles: 'All articles', faq_full: 'Frequently asked questions', sources: 'Sources', mentioned: 'Products mentioned', updated: 'Updated',
  },
  zh: {
    nav_products: '产品', nav_solutions: '解决方案', nav_calc: '收益测算', nav_partners: '渠道合作', nav_about: '关于我们', nav_news: '资讯', cta_quote: '获取报价', menu: '菜单',
    demo: '预览版：产品参数、认证、价格和测算参数均为示例数据，上线前将替换为核实后的数据。',
    talk: '联系销售', ai247: 'AI 助手 7×24 小时在线。', forai: 'AI 智能体接口', privacy: '隐私与 Cookie', corporate: '集团官网', otherlang: 'English',
    moq: '起订', from: '参考价起', lead: '交期', samples: '样品', warranty: '质保', days: '天', specs: '技术参数', refprice: '参考价', qty: '数量', unitprice: '单价',
    price_note_long: '区间覆盖不同配置。运费在正式 PI 中报价。', instant: '立即获取参考价', formal: '申请正式 PI', certs: '认证', faq: '常见问题', alsoin: '同系列', mdv: '机器可读版本',
    allprods: '全部产品', products_lede: '储能、逆变器、组件与充电桩。每个产品页都列出参数、认证、起订量、交期和参考价区间。',
    q_title: '申请正式报价', q_lede: '告诉我们数量、配置和目的地，业务工程师通常会在一个工作日内发送含运费的正式 PI。',
    f_name: '姓名', f_company: '公司', f_email: '工作邮箱', f_wa: 'WhatsApp / 电话', f_country: '国家/地区', f_type: '您的身份', f_choose: '请选择', f_product: '产品', f_notsure: '暂不确定', f_qty: '数量', f_when: '采购时间', f_whenq: '何时？', f_details: '项目需求', f_consent: '我同意 YR GRID 就此需求与我联系，详见', f_privacy: '隐私说明', f_send: '提交需求',
    f_types: ['经销商 / 安装商', 'EPC 总包', '厂房或楼宇业主', '充电运营商 / 车队', '品牌方（OEM/ODM）', '其他'],
    f_whens: ['一个月内', '2–3 个月内', '今年内', '先了解一下'],
    f_need_contact: '请填写工作邮箱或 WhatsApp，方便发送报价。', f_need_consent: '请勾选同意联系。', f_sending: '提交中…', f_sent: '已提交，业务工程师通常会在一个工作日内与您联系。', f_fail: '未提交', f_unreach: '预览环境未连接服务器',
    news_title: '行业资讯', news_lede: '光伏、储能与充电项目的市场动态、政策变化和实操指南。', allarticles: '全部文章', faq_full: '常见问题', sources: '参考来源', mentioned: '相关产品', updated: '更新于',
  },
} as const;

export const t = (lang: Lang) => S[lang];
export const pick = <T,>(lang: Lang, en: T, zh?: T | null) => (lang === 'zh' && zh != null ? zh : en);
export const fmtDate = (lang: Lang, d: Date) => d.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'long', day: 'numeric' });

export const specZh: Record<string, string> = {
  Capacity: '容量', 'Rated power': '额定功率', Cell: '电芯', Grid: '电网', Cooling: '冷却方式', 'Fire protection': '消防', Protection: '防护等级', Communication: '通讯', 'Operating temp': '工作温度', Dimensions: '尺寸',
  Switchover: '并离网切换', Voltage: '电压', 'Max charge/discharge': '最大充放电', Compatibility: '兼容性', MPPT: 'MPPT', 'Max PV input': '最大光伏输入', Battery: '电池', 'Backup switchover': '备电切换', Efficiency: '效率', Monitoring: '监控',
  Power: '功率', Cells: '电池片', Bifaciality: '双面率', Weight: '重量', 'Max system voltage': '最大系统电压', 'Temp. coefficient (Pmax)': '功率温度系数', Connector: '接口', Protocol: '协议', Authentication: '启动方式', Connectivity: '联网', Display: '显示',
  'Output voltage': '输出电压', Connectors: '充电枪', Payment: '支付',
};
