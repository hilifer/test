// Data dictionary — the single "unified language" for the sales-to-delivery loop.
// Every status, every allowed transition and every label lives here; the server,
// admin, customer portal, AI tools and the Kingdee adapter all read from this file.
//
// Flow:  Lead → Quote (PI) → Order → Payment → Fulfilment (stock / production) → Shipment → Delivered → After-sales (RMA)

export const DICT = {
  quote: {
    prefix: 'PI',
    states: {
      draft: { zh: '草稿', en: 'Draft' },
      sent: { zh: '已发送', en: 'Sent' },
      accepted: { zh: '客户已确认', en: 'Accepted' },
      expired: { zh: '已过期', en: 'Expired' },
      cancelled: { zh: '已作废', en: 'Cancelled' },
    },
    transitions: { draft: ['sent', 'cancelled'], sent: ['accepted', 'expired', 'cancelled', 'draft'], accepted: [], expired: ['draft'], cancelled: [] },
  },
  order: {
    prefix: 'SO',
    states: {
      pending_payment: { zh: '待付款', en: 'Awaiting payment' }, // online shop orders
      awaiting_deposit: { zh: '待付定金', en: 'Awaiting deposit' },
      in_production: { zh: '生产/备货中', en: 'In production' },
      ready_to_ship: { zh: '待发货', en: 'Ready to ship' },
      shipped: { zh: '已发货', en: 'Shipped' },
      delivered: { zh: '已签收', en: 'Delivered' },
      completed: { zh: '已完成', en: 'Completed' },
      cancelled: { zh: '已取消', en: 'Cancelled' },
    },
    transitions: {
      pending_payment: ['ready_to_ship', 'in_production', 'cancelled'],
      awaiting_deposit: ['in_production', 'cancelled'],
      in_production: ['ready_to_ship', 'cancelled'],
      ready_to_ship: ['shipped'],
      shipped: ['delivered'],
      delivered: ['completed'],
      completed: [],
      cancelled: [],
    },
    // which statuses customers see on the portal timeline
    timeline: ['awaiting_deposit', 'in_production', 'ready_to_ship', 'shipped', 'delivered', 'completed'],
    timelineShop: ['pending_payment', 'ready_to_ship', 'shipped', 'delivered', 'completed'],
  },
  payment: {
    kinds: { online: { zh: '在线支付', en: 'Online payment' }, deposit: { zh: '定金', en: 'Deposit' }, balance: { zh: '尾款', en: 'Balance' }, refund: { zh: '退款', en: 'Refund' }, other: { zh: '其他', en: 'Other' } },
  },
  shipment: {
    prefix: 'SH',
    states: {
      booked: { zh: '已订舱/已下单', en: 'Booked' },
      in_transit: { zh: '运输中', en: 'In transit' },
      arrived: { zh: '已到港/到站', en: 'Arrived' },
      delivered: { zh: '已签收', en: 'Delivered' },
      exception: { zh: '异常', en: 'Exception' },
    },
    transitions: { booked: ['in_transit', 'exception'], in_transit: ['arrived', 'delivered', 'exception'], arrived: ['delivered', 'exception'], delivered: [], exception: ['in_transit', 'arrived', 'delivered'] },
    modes: { sea: { zh: '海运', en: 'Sea freight' }, air: { zh: '空运', en: 'Air freight' }, express: { zh: '快递', en: 'Express' }, rail: { zh: '铁路', en: 'Rail' }, truck: { zh: '陆运', en: 'Truck' } },
  },
  rma: {
    prefix: 'RMA',
    states: {
      submitted: { zh: '新申请', en: 'Submitted' },
      reviewing: { zh: '审核中', en: 'Under review' },
      approved: { zh: '已同意', en: 'Approved' },
      in_progress: { zh: '处理中', en: 'In progress' },
      resolved: { zh: '已解决', en: 'Resolved' },
      rejected: { zh: '已拒绝', en: 'Declined' },
    },
    transitions: { submitted: ['reviewing', 'approved', 'rejected'], reviewing: ['approved', 'rejected'], approved: ['in_progress', 'resolved'], in_progress: ['resolved'], resolved: [], rejected: ['reviewing'] },
    issues: {
      defect: { zh: '产品故障', en: 'Product defect' },
      damage: { zh: '运输损坏', en: 'Damaged in transit' },
      shortage: { zh: '少发/错发', en: 'Missing or wrong items' },
      spec: { zh: '参数不符', en: 'Not as specified' },
      other: { zh: '其他', en: 'Other' },
    },
    resolutions: { replace: { zh: '补发/换货', en: 'Replacement' }, repair: { zh: '维修', en: 'Repair' }, refund: { zh: '退款', en: 'Refund' }, credit: { zh: '下单抵扣', en: 'Credit on next order' }, none: { zh: '无需处理', en: 'No action' } },
  },
  incoterms: ['EXW', 'FOB', 'CFR', 'CIF', 'DAP', 'DDP'],
  paymentTerms: [
    { id: 'tt30', zh: '30% 定金，70% 发货前付清', en: '30% T/T deposit, 70% before shipment' },
    { id: 'tt100', zh: '100% 预付', en: '100% T/T in advance' },
    { id: 'tt30bl', zh: '30% 定金，70% 见提单副本付清', en: '30% T/T deposit, 70% against B/L copy' },
    { id: 'lc', zh: '即期信用证', en: 'L/C at sight' },
  ],
};

export const label = (entity, state, lang = 'zh') => DICT[entity]?.states?.[state]?.[lang] || state;
export const canMove = (entity, from, to) => (DICT[entity]?.transitions?.[from] || []).includes(to);
export const nextStates = (entity, from) => DICT[entity]?.transitions?.[from] || [];
