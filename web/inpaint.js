/* 局部重繪：在預覽區上塗遮罩，輸出「被塗的地方透明」的 RGBA PNG 給 LoadImage 用 — 依賴 window.HY */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const HY = () => window.HY;

  const M = { img: null, mask: null, ctx: null, w: 0, h: 0, brush: 40, eraser: false, painting: false, last: null, dirty: false, srcUrl: '' };

  /** 載入來源圖到遮罩編輯器（previewUrl 是 blob 或 /view 網址） */
  async function load(url, width, height) {
    M.srcUrl = url;
    const img = $('maskImg');
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    M.w = img.naturalWidth || width; M.h = img.naturalHeight || height;
    M.img = img;
    M.mask = document.createElement('canvas'); M.mask.width = M.w; M.mask.height = M.h;
    M.ctx = M.mask.getContext('2d', { willReadFrequently: true });
    const c = $('maskCanvas'); c.width = M.w; c.height = M.h;
    M.dirty = false;
    redraw();
    layout();
  }
  function layout() {
    const stage = $('maskStage'); if (stage.hidden || !M.img) return;
    // 讓圖片＋畫布一起塞進預覽區並維持比例
    const r = stage.getBoundingClientRect();
    const s = Math.min((r.width - 24) / M.w, (r.height - 24) / M.h, 1.5);
    const wrap = $('maskWrap');
    wrap.style.width = Math.floor(M.w * s) + 'px'; wrap.style.height = Math.floor(M.h * s) + 'px';
  }
  function redraw() {
    const c = $('maskCanvas'), ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    if (!M.mask) return;
    // 遮罩用半透明紅色顯示
    ctx.save(); ctx.globalAlpha = 0.55; ctx.drawImage(M.mask, 0, 0); ctx.restore();
    ctx.save(); ctx.globalCompositeOperation = 'source-in'; ctx.fillStyle = '#ff3355'; ctx.fillRect(0, 0, c.width, c.height); ctx.restore();
  }
  function pos(e) {
    const c = $('maskCanvas'), r = c.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (c.width / r.width), y: (e.clientY - r.top) * (c.height / r.height) };
  }
  function dab(a, b) {
    const ctx = M.ctx;
    ctx.save();
    ctx.globalCompositeOperation = M.eraser ? 'destination-out' : 'source-over';
    ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff';
    ctx.lineWidth = M.brush; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.restore();
    M.dirty = true;
  }
  function clear() { if (M.ctx) { M.ctx.clearRect(0, 0, M.w, M.h); M.dirty = false; redraw(); } }
  function hasMask() {
    if (!M.ctx || !M.dirty) return false;
    const d = M.ctx.getImageData(0, 0, M.w, M.h).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
    return false;
  }
  /** 輸出純遮罩 PNG：塗過的地方白、其他黑（LoadImageMask 讀 red 通道）。
   *  不把遮罩塞進原圖的 alpha——canvas 存 PNG 時 alpha=0 的像素 RGB 會被清成黑色，重繪起點就變一團黑。 */
  async function exportBlob() {
    const c = document.createElement('canvas'); c.width = M.w; c.height = M.h;
    const ctx = c.getContext('2d');
    const out = ctx.createImageData(M.w, M.h), mk = M.ctx.getImageData(0, 0, M.w, M.h).data;
    const d = out.data;
    for (let i = 0; i < d.length; i += 4) { const v = mk[i + 3]; d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255; }
    ctx.putImageData(out, 0, 0);
    return new Promise(res => c.toBlob(res, 'image/png'));
  }
  function show(on) {
    $('maskStage').hidden = !on;
    $('maskTools').hidden = !on;
    if (on) { $('mainImage').hidden = true; $('viewerEmpty').hidden = true; layout(); }
    window.HY?.positionMaskTools?.();
  }
  function setup() {
    const c = $('maskCanvas');
    c.addEventListener('pointerdown', (e) => { if (!M.ctx) return; M.painting = true; M.last = pos(e); dab(M.last, M.last); redraw(); c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', (e) => {
      if (!M.painting) { $('maskCursor').style.display = 'block'; const r = c.getBoundingClientRect(); const sz = M.brush * (r.width / c.width); Object.assign($('maskCursor').style, { left: e.clientX - r.left - sz / 2 + 'px', top: e.clientY - r.top - sz / 2 + 'px', width: sz + 'px', height: sz + 'px' }); return; }
      const p = pos(e); dab(M.last, p); M.last = p; redraw();
    });
    const end = () => { M.painting = false; };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { $('maskCursor').style.display = 'none'; });
    c.addEventListener('wheel', (e) => { e.preventDefault(); M.brush = Math.max(4, Math.min(300, M.brush * (e.deltaY < 0 ? 1.15 : 0.87))); $('maskBrush').value = Math.round(M.brush); $('maskBrushVal').textContent = Math.round(M.brush); }, { passive: false });
    $('maskBrush').oninput = () => { M.brush = parseInt($('maskBrush').value, 10); $('maskBrushVal').textContent = M.brush; };
    $('maskEraser').onchange = () => { M.eraser = $('maskEraser').checked; };
    $('maskClear').onclick = clear;
    $('maskInvert').onclick = () => {
      if (!M.ctx) return;
      const id = M.ctx.getImageData(0, 0, M.w, M.h), d = id.data;
      for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = 255 - d[i + 3]; }
      M.ctx.putImageData(id, 0, 0); M.dirty = true; redraw();
    };
    new ResizeObserver(layout).observe($('viewer'));
  }
  window.addEventListener('DOMContentLoaded', setup);
  window.HYInpaint = { load, show, clear, hasMask, exportBlob, get loaded() { return !!M.img; }, get grow() { return parseInt($('maskGrow').value, 10) || 0; } };
})();
