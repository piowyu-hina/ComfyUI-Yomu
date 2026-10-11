/* 字卡（wildcards）：__名字__ 與 {A|B|C} 的展開、字卡庫視窗 — 依賴 window.HY */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const HY = () => window.HY;
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cache = new Map();          // name -> lines

  // ---- 可重現的亂數（seed 決定抽到什麼）
  function rng(seed) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
  const pick = (arr, r) => arr[Math.floor(r() * arr.length)];

  async function lines(name) {
    if (cache.has(name)) return cache.get(name);
    let ls = [];
    try { const r = await fetch('/yomu/api/wildcard?name=' + encodeURIComponent(name)).then(r => r.json()); ls = r.lines || []; } catch {}
    cache.set(name, ls);
    return ls;
  }
  const hasWildcards = (text) => /__[^\s<]+?__|\{[^{}]*\|[^{}]*\}/.test(String(text || ''));

  /** 展開：先 __名字__（找不到就保留原文），再 {A|B|C}；最多三輪處理巢狀。回傳 {text, picks} */
  async function expand(text, seed) {
    const r = rng(seed), picks = [];
    let t = String(text || '');
    for (let pass = 0; pass < 3 && hasWildcards(t); pass++) {
      const names = [...new Set([...t.matchAll(/__([^\s<]+?)__/g)].map(m => m[1]))];
      const found = {};
      for (const n of names) found[n] = await lines(n);
      t = t.replace(/__([^\s<]+?)__/g, (m, n) => { const ls = found[n]; if (!ls || !ls.length) return m; const v = pick(ls, r); picks.push(`__${n}__ → ${v}`); return v; });
      t = t.replace(/\{([^{}]*\|[^{}]*)\}/g, (m, body) => { const v = pick(body.split('|'), r).trim(); picks.push(`{…} → ${v}`); return v; });
    }
    return { text: t, picks };
  }

  // ---- 字卡庫
  const W = { q: '', items: [], sel: null };
  const label = (n) => n.split('/').pop().replace(/[_-]+/g, ' ');
  function itemEl(it) {
    const el = document.createElement('div'); el.className = 'wc-item' + (it.mine ? ' mine' : '');
    const short = it.short || it.name;
    el.innerHTML = `<div class="wc-name">${esc(label(it.name))} <span class="muted small">__${esc(short)}__</span></div>
      <div class="wc-meta">${it.count} 行${it.preview ? ' · ' + esc(it.preview.join(' / ')).slice(0, 90) : ''}</div>
      <div class="wc-actions"><button class="mini" data-ins>插入</button><button class="mini" data-view>看內容</button>${it.mine ? '<button class="mini" data-edit>編輯</button>' : ''}</div>`;
    el.querySelector('[data-ins]').onclick = () => insert(`__${short}__`);
    el.querySelector('[data-view]').onclick = () => view(it);
    el.querySelector('[data-edit]')?.addEventListener('click', () => edit(it));
    return el;
  }
  async function load() {
    const list = $('wcList'); list.innerHTML = '<div class="muted small" style="padding:20px">讀取中…</div>';
    if (W.q) {   // 搜尋：扁平清單
      const r = await fetch('/yomu/api/wildcards?q=' + encodeURIComponent(W.q) + '&limit=200').then(r => r.json());
      $('wcCount').textContent = `${r.total.toLocaleString()} 張符合`;
      list.innerHTML = '';
      r.items.forEach(it => list.appendChild(itemEl(it)));
      if (!r.items.length) list.innerHTML = '<div class="muted small" style="padding:20px">沒有符合的字卡</div>';
      return;
    }
    // 沒搜尋：依字卡包分組，大包只顯示數量、用搜尋找
    const g = await fetch('/yomu/api/wildcards/groups').then(r => r.json());
    let total = 0; for (const k in g) total += g[k].count;
    $('wcCount').textContent = `${total.toLocaleString()} 張`;
    list.innerHTML = '';
    const order = Object.keys(g).sort((a, b) => (a === '我的' ? -1 : b === '我的' ? 1 : g[a].count - g[b].count));
    for (const name of order) {
      const grp = g[name];
      const sec = document.createElement('details'); sec.className = 'wc-group'; sec.open = grp.count <= 40 || name === '我的';
      sec.innerHTML = `<summary>${esc(name)} <span class="muted small">${grp.count.toLocaleString()} 張</span></summary>`;
      const body = document.createElement('div'); body.className = 'wc-group-body';
      if (grp.files.length) grp.files.forEach(f => body.appendChild(itemEl({ ...f, mine: name === '我的' })));
      else body.innerHTML = `<div class="muted small" style="padding:8px 10px">太多了（${grp.count.toLocaleString()} 張，多半是一個角色一張），請用上面的搜尋框找，例如角色名的英文。</div>`;
      sec.appendChild(body); list.appendChild(sec);
    }
  }
  function insert(text) {
    const ta = $('pos'), start = ta.selectionStart, end = ta.selectionEnd;
    const before = ta.value.slice(0, start);
    const prefix = before && !/[,\n(]\s*$/.test(before) ? ', ' : '';
    ta.setRangeText(prefix + text + ', ', start, end, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    HY().toast('已插入 ' + text);
  }
  async function view(it) {
    const ls = await lines(it.name);
    $('wcViewTitle').textContent = it.name; $('wcViewBody').innerHTML = ls.map(l => `<div class="wc-line">${esc(l)}</div>`).join('') || '<div class="muted">空的</div>';
    $('wcViewBody').querySelectorAll('.wc-line').forEach(el => el.onclick = () => insert(el.textContent));
    $('wcView').hidden = false;
  }
  async function edit(it) {
    const ls = it ? await lines(it.name) : [];
    $('wcEditName').value = it ? it.name.replace(/^我的\//, '') : ''; $('wcEditName').disabled = !!it;
    $('wcEditText').value = ls.join('\n'); $('wcEdit').hidden = false; $('wcEditText').focus();
  }
  async function saveEdit() {
    const name = $('wcEditName').value.trim(); if (!name) { HY().toast('要取名字', true); return; }
    const r = await fetch('/yomu/api/wildcards/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, text: $('wcEditText').value }) }).then(r => r.json());
    if (!r.ok) { HY().toast(r.msg, true); return; }
    cache.delete(r.name); $('wcEdit').hidden = true; HY().toast('已存：' + r.name); load();
  }
  async function delEdit() {
    const name = '我的/' + $('wcEditName').value.trim();
    if (!confirm(`刪除字卡「${name}」？`)) return;
    await fetch('/yomu/api/wildcards/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    cache.delete(name); $('wcEdit').hidden = true; load();
  }

  window.addEventListener('DOMContentLoaded', () => {
    $('btnWildcards').onclick = () => { $('wcModal').hidden = false; load(); $('wcSearch').focus(); };
    $('wcClose').onclick = () => { $('wcModal').hidden = true; };
    $('wcModal').onclick = (e) => { if (e.target === $('wcModal')) $('wcModal').hidden = true; };
    let t = null; $('wcSearch').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { W.q = $('wcSearch').value.trim(); load(); }, 200); });
    $('wcNew').onclick = () => edit(null);
    $('wcViewClose').onclick = () => { $('wcView').hidden = true; };
    $('wcEditSave').onclick = saveEdit; $('wcEditDel').onclick = delEdit; $('wcEditCancel').onclick = () => { $('wcEdit').hidden = true; };
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('wcModal').hidden) { if (!$('wcView').hidden) $('wcView').hidden = true; else if (!$('wcEdit').hidden) $('wcEdit').hidden = true; else $('wcModal').hidden = true; } });
  });
  window.HYWildcards = { expand, hasWildcards, lines, clearCache: () => cache.clear() };
})();
