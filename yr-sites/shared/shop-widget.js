// Buy box + cart badge for the static product pages (both sites). Live variants, tier price, stock and
// "add to cart" come from the sales server; if it is unreachable (static preview) the box stays hidden.
//   <div data-buy-box data-product="YR-HB-U2" data-lang="en"></div>     <a data-cart-link><span data-cart-count hidden></span></a>
const L = {
  en: { sale: 'Sale', ends: 'ends', zone: 'On sale now', reviews: 'Customer reviews', noReviews: 'No reviews yet — reviews come from verified buyers.', save: '♡ Save', saved: '♥ Saved', login: 'Log in to save products', related: 'You may also like', verified: 'Verified buyer', reply: 'Reply', over: 'Only {n} available — reduce the quantity or request a quote.', buy: 'Buy online', variant: 'Option', qty: 'Quantity', add: 'Add to cart', added: 'Added to cart', view: 'View cart', inStock: 'In stock', low: 'Only {n} left', oos: 'Out of stock — request a quote instead', each: 'each', from: 'from', moq: 'Min. order {n}', tiers: 'Volume price', ship: 'Shipping calculated at checkout', err: 'Could not add to cart. Please try again.' },
  zh: { sale: '促销', ends: '截止', zone: '正在促销', reviews: '买家评价', noReviews: '暂无评价——评价仅来自已收货的买家。', save: '♡ 收藏', saved: '♥ 已收藏', login: '登录后可收藏', related: '同类推荐', verified: '已购买', reply: '回复', over: '库存仅 {n}，请减少数量或询价。', buy: '在线购买', variant: '规格', qty: '数量', add: '加入购物车', added: '已加入购物车', view: '查看购物车', inStock: '有现货', low: '仅剩 {n}', oos: '暂时缺货，请询价', each: '/件', from: '起', moq: '起订 {n}', tiers: '批量价', ship: '运费在结算时计算', err: '加入失败，请重试。' },
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
${data.promo ? `<p class="buybox__promo" data-promo>${t.sale} · ${esc(data.promo.label)} · ${t.ends} ${new Date(data.promo.ends_at).toLocaleDateString()}</p>` : ''}<p class="buybox__price"><b data-price></b> <span data-each>${t.each}</span> <s data-cmp></s></p><p class="buybox__meta" data-meta></p><div data-tiers class="buybox__tiers"></div>
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

async function extras(box) {
  const lang = box.dataset.lang === 'zh' ? 'zh' : 'en';
  const t = L[lang];
  const id = encodeURIComponent(box.dataset.product);
  let rv, rel, wl;
  try { [rv, rel, wl] = await Promise.all([fetch(`/api/shop/reviews/${id}`).then((r) => r.json()), fetch(`/api/shop/related/${id}`).then((r) => r.json()), fetch('/api/shop/wishlist').then((r) => r.json())]); } catch { return; }
  const stars = (n) => '★'.repeat(Math.round(n)) + '☆'.repeat(5 - Math.round(n));
  const saved = wl.ids.includes(box.dataset.product);
  box.innerHTML = `<div class="extras"><p><button type="button" class="btn btn--line" data-wish>${saved ? t.saved : t.save}</button> <span data-wishmsg></span></p>
<h2>${t.reviews}${rv.count ? ` <span class="extras__avg">${stars(rv.average)} ${rv.average} (${rv.count})</span>` : ''}</h2>
${rv.count ? rv.reviews.map((r) => `<div class="extras__rev"><b>${stars(r.rating)}</b> ${esc(r.title || '')}<p>${esc(r.body)}</p><p class="extras__by">${esc(r.author)} · ${t.verified} · ${esc(r.date)}</p>${r.reply ? `<p class="extras__reply">${t.reply}: ${esc(r.reply)}</p>` : ''}</div>`).join('') : `<p class="extras__by">${t.noReviews}</p>`}
${rel.length ? `<h2>${t.related}</h2><ul class="extras__rel">${rel.map((p) => `<li><a href="${lang === 'zh' ? '/zh' : ''}/products/${esc(p.slug)}/">${p.image ? `<img src="${esc(p.image)}" alt="">` : ''}<b>${esc(lang === 'zh' && p.nameZh ? p.nameZh : p.name)}</b></a></li>`).join('')}</ul>` : ''}</div>`;
  box.querySelector('[data-wish]').addEventListener('click', async (e) => {
    const r = await fetch('/api/shop/wishlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ productId: box.dataset.product }) });
    if (r.status === 401) { box.querySelector('[data-wishmsg]').innerHTML = `<a href="/shop/account/login?next=${encodeURIComponent('/shop/account')}">${t.login}</a>`; return; }
    const j = await r.json();
    e.target.textContent = j.saved ? t.saved : t.save;
  });
  box.hidden = false;
}

/** Home page: running promotions with their products (filled live, so a sale starts and ends on time). */
async function promoZone(el) {
  const lang = el.dataset.lang === 'zh' ? 'zh' : 'en';
  const t = L[lang];
  let zones = [];
  try { const r = await fetch(`/api/shop/promotions?lang=${lang}`); if (!r.ok) return; zones = await r.json(); } catch { return; }
  if (!zones.length) return;
  const base = lang === 'zh' && location.pathname.startsWith('/zh') ? '/zh' : '';
  el.innerHTML = `<h2>${t.zone}</h2>${zones.map((z) => `<div class="promo-zone__item"><p class="promo-zone__label"><b>${esc(z.label)}</b> · ${t.ends} ${new Date(z.ends_at).toLocaleDateString()}</p><div class="featured-grid">${z.products.map((p) => `<a class="card" href="${base}/products/${esc(p.slug)}/">${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : ''}<b>${esc(p.name)}</b></a>`).join('')}</div></div>`).join('')}`;
  el.closest('.promo-zone')?.removeAttribute('hidden');
}

/** One page-view beacon for the site's own analytics (no cookies unless the visitor came from a campaign link). */
function beacon() {
  const product = document.querySelector('[data-buy-box][data-product], [data-shop-extras][data-product]')?.dataset.product || '';
  try { fetch('/api/t', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p: location.pathname, q: location.search, r: document.referrer, product }) }).catch(() => {}); } catch { /* old browser */ }
}

async function init() {
  beacon();
  document.querySelectorAll('[data-promo-zone]').forEach(promoZone);
  document.querySelectorAll('[data-buy-box]').forEach(mount);
  document.querySelectorAll('[data-shop-extras]').forEach(extras);
  if (document.querySelector('[data-cart-count]')) {
    try { const r = await fetch('/api/shop/cart'); if (r.ok) setCount((await r.json()).count); } catch { /* static preview */ }
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
