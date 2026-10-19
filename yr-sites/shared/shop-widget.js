// Buy box + cart badge for the static product pages (both sites). Live variants, tier price, stock and
// "add to cart" come from the sales server; if it is unreachable (static preview) the box stays hidden.
//   <div data-buy-box data-product="YR-HB-U2" data-lang="en"></div>     <a data-cart-link><span data-cart-count hidden></span></a>
const L = {
  en: { over: 'Only {n} available — reduce the quantity or request a quote.', buy: 'Buy online', variant: 'Option', qty: 'Quantity', add: 'Add to cart', added: 'Added to cart', view: 'View cart', inStock: 'In stock', low: 'Only {n} left', oos: 'Out of stock — request a quote instead', each: 'each', from: 'from', moq: 'Min. order {n}', tiers: 'Volume price', ship: 'Shipping calculated at checkout', err: 'Could not add to cart. Please try again.' },
  zh: { over: '库存仅 {n}，请减少数量或询价。', buy: '在线购买', variant: '规格', qty: '数量', add: '加入购物车', added: '已加入购物车', view: '查看购物车', inStock: '有现货', low: '仅剩 {n}', oos: '暂时缺货，请询价', each: '/件', from: '起', moq: '起订 {n}', tiers: '批量价', ship: '运费在结算时计算', err: '加入失败，请重试。' },
};
const money = (cur, n) => `${cur === 'USD' ? 'US$' : cur + ' '}${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const priceFor = (v, q) => (v.tiers || []).reduce((p, t) => (q >= t.minQty ? t.price : p), v.price);

function setCount(n) {
  document.querySelectorAll('[data-cart-count]').forEach((el) => { el.textContent = String(n); el.hidden = !n; });
}

async function mount(box) {
  const t = L[box.dataset.lang === 'zh' ? 'zh' : 'en'];
  let data;
  try { const r = await fetch(`/api/shop/product/${encodeURIComponent(box.dataset.product)}`); if (!r.ok) return; data = await r.json(); } catch { return; }
  if (data.salesMode === 'inquiry' || !data.variants.length) return;
  const v0 = data.variants[0];
  box.innerHTML = `<div class="buybox"><p class="buybox__h">${t.buy}</p>
${data.variants.length > 1 ? `<label class="buybox__f">${t.variant}<select data-v>${data.variants.map((v, i) => `<option value="${i}">${esc(v.label || v.sku)}</option>`).join('')}</select></label>` : ''}
<p class="buybox__price"><b data-price></b> <span data-each>${t.each}</span> <s data-cmp></s></p><p class="buybox__meta" data-meta></p><div data-tiers class="buybox__tiers"></div>
<div class="buybox__row"><label class="buybox__f">${t.qty}<input data-q type="number" inputmode="numeric" min="1" step="1"></label><button type="button" class="btn btn--signal buybox__add" data-add>${t.add}</button></div>
<p class="buybox__meta">${t.ship}</p><p class="buybox__msg" role="status" data-msg></p></div>`;
  const $ = (s) => box.querySelector(s);
  let v = v0;
  const render = () => {
    const q = Math.max(v.minQty || 1, Math.floor(Number($('[data-q]').value) || 0));
    $('[data-price]').textContent = money(data.currency, priceFor(v, q));
    $('[data-cmp]').textContent = v.compareAt ? money(data.currency, v.compareAt) : '';
    const stock = v.available <= 0 ? t.oos : v.available < 20 ? t.low.replace('{n}', v.available) : t.inStock;
    $('[data-meta]').textContent = `${stock} · ${t.moq.replace('{n}', v.minQty || 1)}`;
    $('[data-tiers]').innerHTML = (v.tiers || []).length ? `${t.tiers}: ${[{ minQty: v.minQty || 1, price: v.price }, ...v.tiers].map((x) => `${x.minQty}+ ${money(data.currency, x.price)}`).join(' · ')}` : '';
    const over = q > v.available && v.available > 0;
    $('[data-add]').disabled = v.available <= 0 || over;
    $('[data-msg]').textContent = over ? t.over.replace('{n}', v.available) : '';
  };
  const pick = () => { v = data.variants[Number($('[data-v]')?.value || 0)]; $('[data-q]').min = v.minQty || 1; $('[data-q]').value = Math.max(Number($('[data-q]').value) || 0, v.minQty || 1); render(); };
  $('[data-q]').value = v0.minQty || 1;
  $('[data-v]')?.addEventListener('change', pick);
  $('[data-q]').addEventListener('input', render);
  $('[data-add]').addEventListener('click', async () => {
    const msg = $('[data-msg]');
    try {
      const r = await fetch('/api/shop/cart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku: v.sku, qty: Number($('[data-q]').value) }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setCount(j.count);
      msg.innerHTML = `${t.added} — <a href="/shop/cart${box.dataset.lang === 'zh' ? '?lang=zh' : ''}">${t.view}</a>`;
    } catch { msg.textContent = t.err; }
  });
  render();
  box.hidden = false;
}

async function init() {
  document.querySelectorAll('[data-buy-box]').forEach(mount);
  if (document.querySelector('[data-cart-count]')) {
    try { const r = await fetch('/api/shop/cart'); if (r.ok) setCount((await r.json()).count); } catch { /* static preview */ }
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
