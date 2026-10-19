// Quote list ("RFQ cart") — buyers collect several products with quantities and send one request.
// Stored in the visitor's browser only; submitted lines go to /api/leads → admin turns them into a multi-line PI.
const KEY = 'yr-quote-list';
const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
const write = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} refresh(); };
const quoteHref = () => document.querySelector('[data-quote-href]')?.getAttribute('href') || '/quote/';

function refresh() {
  const items = read();
  document.querySelectorAll('[data-quote-count]').forEach((el) => { el.textContent = String(items.length); el.hidden = items.length === 0; });
  document.querySelectorAll('[data-add-quote]').forEach((b) => {
    const on = items.some((i) => i.id === b.dataset.id);
    b.classList.toggle('is-added', on);
    b.textContent = on ? 'In quote list ✓' : 'Add to quote list';
  });
  document.querySelectorAll('[data-quote-list]').forEach(render);
}

function toast(name) {
  let t = document.getElementById('yrq-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'yrq-toast';
    t.setAttribute('role', 'status');
    t.style.cssText = 'position:fixed;left:50%;top:84px;transform:translateX(-50%);z-index:9995;background:#14202e;color:#fff;padding:12px 18px;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.25);font:500 15px/1.4 inherit;display:flex;gap:14px;align-items:center;max-width:calc(100vw - 24px)';
    document.body.append(t);
  }
  t.innerHTML = '';
  const s = document.createElement('span'); s.textContent = `Added: ${name}`;
  const a = document.createElement('a'); a.href = quoteHref(); a.textContent = 'View quote list'; a.style.cssText = 'color:#ffd27a;font-weight:650';
  t.append(s, a);
  t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), 3500);
}

function render(box) {
  const items = read();
  if (!items.length) {
    box.innerHTML = `<p class="qlist__empty">Your quote list is empty. Browse <a href="${document.querySelector('[data-products-link]')?.getAttribute('href') || '/products/'}">products</a> and click “Add to quote list”, or just describe your project in the form.</p>`;
    return;
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  box.innerHTML = `<table class="qlist"><thead><tr><th scope="col">Product</th><th scope="col">Quantity</th><th scope="col">Options (wattage, CCT, optic…)</th><th></th></tr></thead><tbody>${items.map((i, n) => `
    <tr><td><b>${esc(i.name)}</b><br><span class="qlist__sku">${esc(i.id)} · MOQ ${esc(i.moq)} ${esc(i.unit || '')}</span></td>
    <td><input type="number" min="1" value="${esc(i.qty)}" data-qi="${n}" data-k="qty" aria-label="Quantity for ${esc(i.name)}"></td>
    <td><input value="${esc(i.note)}" data-qi="${n}" data-k="note" placeholder="e.g. 150W 5000K" aria-label="Options for ${esc(i.name)}"></td>
    <td><button type="button" class="qlist__rm" data-qrm="${n}" aria-label="Remove ${esc(i.name)}">Remove</button></td></tr>`).join('')}</tbody></table>`;
}

document.addEventListener('click', (e) => {
  const add = e.target.closest('[data-add-quote]');
  if (add) {
    const items = read();
    if (!items.some((i) => i.id === add.dataset.id)) {
      items.push({ id: add.dataset.id, name: add.dataset.name, moq: Number(add.dataset.moq) || 1, unit: add.dataset.unit || 'pcs', qty: Number(add.dataset.moq) || 1, note: '' });
      write(items);
      toast(add.dataset.name);
    } else location.href = quoteHref();
    return;
  }
  const rm = e.target.closest('[data-qrm]');
  if (rm) { const items = read(); items.splice(Number(rm.dataset.qrm), 1); write(items); }
});
document.addEventListener('change', (e) => {
  const inp = e.target.closest('[data-qi]');
  if (!inp) return;
  const items = read();
  const it = items[Number(inp.dataset.qi)];
  if (!it) return;
  it[inp.dataset.k] = inp.dataset.k === 'qty' ? Math.max(1, Math.round(Number(inp.value) || 1)) : inp.value.slice(0, 200);
  try { localStorage.setItem(KEY, JSON.stringify(items)); } catch {}
});

window.YRQuote = { items: read, clear: () => write([]) };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh); else refresh();
