// Shopping cart kept in the browser (localStorage) until checkout.
const Cart = (() => {
  const KEY = 'cart';
  function read() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
  function write(c) { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch {} badge(); }
  function items() { return Object.entries(read()).map(([id, qty]) => ({ id: +id, qty: +qty })).filter(i => i.qty > 0); }
  function add(id, qty) { const c = read(); c[id] = (c[id] || 0) + (qty || 1); write(c); }
  function set(id, qty) { const c = read(); if (qty > 0) c[id] = qty; else delete c[id]; write(c); }
  function count() { return items().reduce((s, i) => s + i.qty, 0); }
  function badge() { const el = document.getElementById('cart-count'); if (!el) return; const n = count(); if (el.textContent !== String(n)) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); } el.textContent = n; }
  const fmt = n => '₦' + (Number(n) || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function renderCartPage(opts = {}) {
    const list = items();
    const empty = document.getElementById('cart-empty'), view = document.getElementById('cart-view');
    const tbody = document.querySelector('#cart-table tbody');
    if (!list.length) { if (empty) empty.hidden = false; if (view) view.hidden = true; if (tbody) tbody.innerHTML = ''; const t = document.getElementById('cart-total'); if (t) t.textContent = fmt(0); return; }
    const res = await fetch('/api/products?ids=' + list.map(i => i.id).join(','));
    const products = await res.json();
    const byId = Object.fromEntries(products.map(p => [p.id, p]));
    let total = 0; const rows = [];
    for (const it of list) {
      const p = byId[it.id];
      if (!p) { set(it.id, 0); continue; }
      const qty = Math.min(it.qty, p.stock); if (qty !== it.qty) set(it.id, qty);
      const line = p.price * qty; total += line;
      rows.push(opts.compact
        ? `<tr><td>${esc(p.name)}</td><td class="r">${qty} × ${fmt(p.price)}</td><td></td><td class="r">${fmt(line)}</td></tr>`
        : `<tr><td>${esc(p.name)}</td><td>${fmt(p.price)}</td><td><input type="number" class="qty-input" min="1" max="${p.stock}" value="${qty}" data-id="${p.id}"></td><td class="r">${fmt(line)}</td><td><button class="btn small remove" data-id="${p.id}">Remove</button></td></tr>`);
    }
    if (empty) empty.hidden = rows.length > 0; if (view) view.hidden = rows.length === 0;
    if (tbody) tbody.innerHTML = rows.join('');
    const t = document.getElementById('cart-total'); if (t) t.textContent = fmt(total);
    if (!opts.compact && tbody) {
      tbody.querySelectorAll('.qty-input').forEach(inp => inp.addEventListener('change', () => { set(+inp.dataset.id, Math.max(0, parseInt(inp.value, 10) || 0)); renderCartPage(opts); }));
      tbody.querySelectorAll('.remove').forEach(b => b.addEventListener('click', () => { set(+b.dataset.id, 0); renderCartPage(opts); }));
    }
  }

  document.addEventListener('click', e => {
    const b = e.target.closest('.add-to-cart');
    if (!b) return;
    let qty = 1;
    if (b.dataset.qtyInput) qty = Math.max(1, parseInt(document.getElementById(b.dataset.qtyInput).value, 10) || 1);
    add(+b.dataset.id, qty);
    const old = b.textContent; b.textContent = 'Added ✓'; b.disabled = true;
    setTimeout(() => { b.textContent = old; b.disabled = false; }, 900);
  });
  document.addEventListener('DOMContentLoaded', () => {
    badge();
    const els = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window)) { els.forEach(e => e.classList.add('in')); return; }
    const io = new IntersectionObserver(entries => entries.forEach(en => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { threshold: 0.08 });
    els.forEach(e => io.observe(e));
  });
  return { items, add, set, count, renderCartPage };
})();
