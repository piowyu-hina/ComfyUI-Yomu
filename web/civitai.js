/* Civitai 模型瀏覽器（搜尋 / 版本 / 下載）— 依賴 app.js 暴露的 window.HY */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const HY = () => window.HY;
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmtSize = (kb) => (!kb ? '?' : kb > 1024 * 1024 ? (kb / 1024 / 1024).toFixed(2) + ' GB' : kb > 1024 ? (kb / 1024).toFixed(0) + ' MB' : kb.toFixed(0) + ' KB');
  const fmtNum = (n) => (n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));

  const BASE_BY_FAMILY = { sdxl: ['Illustrious', 'Pony', 'NoobAI', 'SDXL 1.0'], sd15: ['SD 1.5'], anima: ['Anima'], flux: ['Flux.1 D', 'Flux.2 D'], wan: ['Wan Video 2.2 I2V-A14B', 'Wan Video 14B i2v 720p'], qwen: ['Qwen'] };

  const S = { items: [], cursor: null, loading: false, q: '', detail: null, pollTimer: null, seq: 0 };

  function filters() {
    const fams = HY().compatFamilies();
    const bases = $('cvBase').value === 'auto' ? fams.flatMap(f => BASE_BY_FAMILY[f] || []) : ($('cvBase').value === 'all' ? [] : [$('cvBase').value]);
    const noBase = ['Upscaler', 'VAE', 'Wildcards'].includes($('cvType').value);   // 放大模型 / VAE 不分底模
    return { types: $('cvType').value, baseModels: noBase ? '' : bases.join(','), sort: $('cvSort').value, nsfw: $('cvNsfw').checked ? '1' : '0', query: $('cvSearch').value.trim() };
  }

  async function search(more = false) {
    if (S.loading) return;
    if (!more) { S.items = []; S.cursor = null; $('cvGrid').innerHTML = ''; }
    const seq = ++S.seq;
    S.loading = true; $('cvStatus').textContent = '搜尋中…'; $('cvMore').disabled = true;
    const f = filters();
    const p = new URLSearchParams({ ...f, limit: '24' });
    if (S.cursor) p.set('cursor', S.cursor);
    try {
      const r = await fetch('/yomu/api/civitai/search?' + p).then(r => r.json());
      if (seq !== S.seq) return;
      if (!r.ok) throw new Error(r.msg);
      S.items.push(...r.items); S.cursor = r.nextCursor || null;
      r.items.forEach(renderCard);
      $('cvStatus').textContent = S.items.length ? `${S.items.length} 個結果${S.cursor ? '' : '（到底了）'}` : '沒有結果';
      $('cvMore').hidden = !S.cursor;
    } catch (e) { $('cvStatus').textContent = '搜尋失敗：' + e.message; }
    finally { S.loading = false; $('cvMore').disabled = false; }
  }

  function renderCard(m) {
    const el = document.createElement('div');
    el.className = 'cv-card' + (m.installed ? ' installed' : '');
    el.innerHTML = `
      <div class="cv-art">${m.image ? `<img loading="lazy" src="${esc(m.image)}" alt="">` : ''}
        <span class="cv-badge">${esc(m.type)}</span>${m.baseModel ? `<span class="cv-badge base">${esc(m.baseModel)}</span>` : ''}
        ${m.installed ? '<span class="cv-badge ok">已安裝</span>' : ''}${m.nsfw ? '<span class="cv-badge nsfw">NSFW</span>' : ''}
      </div>
      <div class="cv-name">${esc(m.name)}</div>
      <div class="cv-meta">${esc(m.creator || '')} · ⬇ ${fmtNum(m.downloads)} · 👍 ${fmtNum(m.likes)}</div>`;
    el.onclick = () => openDetail(m);
    $('cvGrid').appendChild(el);
  }

  function openDetail(m) {
    S.detail = m;
    const box = $('cvDetail');
    box.hidden = false;
    const vsel = m.versions.map((v, i) => `<option value="${i}">${esc(v.name)}${v.installed ? '（已安裝）' : ''}</option>`).join('');
    box.innerHTML = `
      <div class="cv-detail-head">
        <button class="tbtn" id="cvBack">← 返回</button>
        <span class="card-title">${esc(m.name)}</span>
        <a class="mini" href="https://civitai.com/models/${m.id}" target="_blank">在 Civitai 開啟 ↗</a>
      </div>
      <div class="cv-detail-body">
        <div class="cv-detail-art" id="cvDetailArt"></div>
        <div class="cv-detail-info">
          <div class="muted small">${esc(m.type)} · ${esc(m.creator || '')} · ⬇ ${fmtNum(m.downloads)} · 👍 ${fmtNum(m.likes)}</div>
          <div class="field"><label>版本</label><select id="cvVersion">${vsel}</select></div>
          <div id="cvVersionInfo"></div>
          <div class="cv-desc">${esc(m.description)}</div>
        </div>
      </div>`;
    $('cvBack').onclick = () => { box.hidden = true; S.detail = null; };
    $('cvVersion').onchange = () => renderVersion(m, m.versions[$('cvVersion').value]);
    renderVersion(m, m.versions[0]);
    // 補抓完整版本清單（列表 API 可能只給一部分）
    fetch('/yomu/api/civitai/model?id=' + m.id).then(r => r.json()).then(r => {
      if (!r.ok || S.detail !== m || r.model.versions.length <= m.versions.length) return;
      const cur = m.versions[$('cvVersion').value]?.id;
      m.versions = r.model.versions; m.installed = r.model.installed;
      $('cvVersion').innerHTML = m.versions.map((v, i) => `<option value="${i}">${esc(v.name)}${v.installed ? '（已安裝）' : ''}</option>`).join('');
      const idx = Math.max(0, m.versions.findIndex(v => v.id === cur));
      $('cvVersion').value = String(idx);
      $('cvVersion').previousElementSibling.textContent = `版本（${m.versions.length}）`;
    }).catch(() => {});
  }

  function renderVersion(m, v) {
    if (!v) return;
    // 這個版本的所有圖；沒有就借其他版本的
    const imgs = (v.images && v.images.length) ? [...v.images] : m.versions.flatMap(x => x.images || []).slice(0, 16);
    const art = $('cvDetailArt');
    const render = () => {
      art.innerHTML = `<div class="cv-main"><img src="${esc(imgs[0])}" alt=""></div>` +
        (imgs.length > 1 ? `<div class="cv-thumbs">${imgs.map((u, i) => `<img src="${esc(u.replace('/width=450/', '/width=160/'))}" data-i="${i}" class="${i === 0 ? 'active' : ''}" alt="">`).join('')}</div>` : '');
      art.querySelectorAll('.cv-thumbs img').forEach(t => t.onclick = () => {
        art.querySelector('.cv-main img').src = imgs[t.dataset.i];
        art.querySelectorAll('.cv-thumbs img').forEach(x => x.classList.toggle('active', x === t));
      });
      art.querySelector('.cv-main img').onclick = () => window.open(imgs[Math.max(0, [...art.querySelectorAll('.cv-thumbs img')].findIndex(x => x.classList.contains('active')))].replace('/width=450/', '/width=1024/'), '_blank');
    };
    if (!imgs.length) art.innerHTML = '<div class="muted">沒有預覽圖</div>'; else render();
    // 再去抓社群圖片補進縮圖列
    const seq = (renderVersion._seq = (renderVersion._seq || 0) + 1);
    fetch(`/yomu/api/civitai/images?versionId=${v.id}&nsfw=${$('cvNsfw').checked ? 1 : 0}&limit=30`).then(r => r.json()).then(r => {
      if (seq !== renderVersion._seq || !r.images?.length) return;
      const seen = new Set(imgs.map(u => u.split('/').pop()));
      const extra = r.images.filter(u => !seen.has(u.split('/').pop()));
      if (!extra.length) return;
      const keep = Math.max(0, [...art.querySelectorAll('.cv-thumbs img')].findIndex(x => x.classList.contains('active')));
      imgs.push(...extra); render();
      const th = art.querySelectorAll('.cv-thumbs img')[keep]; if (th) th.click();
    }).catch(() => {});
    const files = v.files.filter(f => (f.type || 'Model') === 'Model' || f.type === 'Pruned Model');
    const list = (files.length ? files : v.files).map(f => `
      <div class="cv-file">
        <div class="cv-file-name">${esc(f.name)}<span class="muted small"> · ${fmtSize(f.sizeKB)}${f.fp ? ' · ' + esc(f.fp) : ''}${f.size ? ' · ' + esc(f.size) : ''}</span></div>
        <button class="tbtn cv-dl" data-file="${f.id}" ${v.installed ? 'disabled' : ''}>${v.installed ? '已安裝' : '⬇ 下載'}</button>
      </div>`).join('');
    $('cvVersionInfo').innerHTML = `
      <div class="muted small">底模：${esc(v.baseModel || '?')} · 會存到 <b>models/${esc(folderFor(m.type, v.baseModel))}</b></div>
      ${v.trainedWords.length ? `<div class="cv-words">觸發詞：${v.trainedWords.map(w => `<code>${esc(w)}</code>`).join(' ')}</div>` : ''}
      <div class="cv-files">${list}</div>`;
    $('cvVersionInfo').querySelectorAll('.cv-dl').forEach(b => b.onclick = () => startDownload(m, v, v.files.find(f => String(f.id) === b.dataset.file)));
  }

  function folderFor(type, base) {
    const t = (type || '').toLowerCase();
    if (['lora', 'locon', 'dora', 'lycoris'].includes(t)) return 'loras';
    if (t === 'textualinversion') return 'embeddings';
    if (t === 'vae') return 'vae';
    if (t === 'upscaler') return 'upscale_models';
    if (t === 'wildcards') return 'wildcards';
    if (t === 'checkpoint') return /anima|flux|wan|qwen|hunyuan|ltx|z-?image|lumina|cosmos|hidream|chroma|sd ?3/i.test(base || '') ? 'diffusion_models' : 'checkpoints';
    return t;
  }

  async function startDownload(m, v, f) {
    const r = await fetch('/yomu/api/civitai/download', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: { id: m.id, name: m.name, type: m.type, nsfw: m.nsfw, creator: { username: m.creator }, description: m.description }, version: v, file: f }) }).then(r => r.json());
    if (!r.ok) { HY().toast(r.msg, true); return; }
    HY().toast('開始下載：' + f.name);
    $('cvDownloads').hidden = false;
    pollDownloads(true);
  }

  async function pollDownloads(force = false) {
    let list; try { list = await fetch('/yomu/api/civitai/downloads').then(r => r.json()); } catch { return; }
    const box = $('cvDlList');
    box.innerHTML = list.map(j => {
      const pct = j.total ? Math.min(100, Math.round(j.done / j.total * 100)) : 0;
      const spd = j.speed ? (j.speed / 1024 / 1024).toFixed(1) + ' MB/s' : '';
      const st = { queued: '排隊中', downloading: `${pct}% · ${spd}`, done: '完成', error: '失敗：' + esc(j.error || '') }[j.status] || j.status;
      return `<div class="cv-dl-row ${j.status}">
        <div class="cv-dl-name">${esc(j.filename)} <span class="muted small">→ ${esc(j.kind)}</span></div>
        <div class="cv-dl-bar"><div style="width:${j.status === 'done' ? 100 : pct}%"></div></div>
        <div class="cv-dl-state">${st}</div>
        <button class="mini" data-cancel="${j.id}">${j.status === 'downloading' || j.status === 'queued' ? '取消' : '✕'}</button>
      </div>`;
    }).join('') || '<div class="muted small">沒有下載</div>';
    box.querySelectorAll('[data-cancel]').forEach(b => b.onclick = async () => { await fetch('/yomu/api/civitai/download/cancel?id=' + b.dataset.cancel, { method: 'POST' }); pollDownloads(true); });
    const active = list.some(j => j.status === 'downloading' || j.status === 'queued');
    const justDone = list.some(j => j.status === 'done' && Date.now() - j.finished * 1000 < 4000);
    if (justDone && !pollDownloads._refreshed) { pollDownloads._refreshed = true; setTimeout(() => { pollDownloads._refreshed = false; }, 5000); HY().loadModels().then(() => HY().renderAssets()); }
    if (active && !S.pollTimer) S.pollTimer = setInterval(pollDownloads, 1000);
    if (!active && S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
  }

  async function loadKeyState() {
    try {
      const s = await fetch('/yomu/api/settings').then(r => r.json());
      $('cvKeyState').textContent = s.civitai_api_key_set ? `API key：…${s.civitai_api_key_tail}` : 'API key：未設定（下載需要）';
    } catch {}
  }
  async function saveKey() {
    const k = await HY().askText({ title: '貼上 Civitai API key（civitai.com → 帳號設定 → API Keys）', placeholder: 'API key', okText: '儲存' });
    if (k == null || typeof k !== 'string') return;
    await fetch('/yomu/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ civitai_api_key: k }) });
    loadKeyState();
  }

  function open() {
    $('civitaiModal').hidden = false;
    loadKeyState();
    if (!S.items.length) search();
    pollDownloads();
    $('cvSearch').focus();
  }
  function close() { $('civitaiModal').hidden = true; }
  /** 缺模型提醒用：帶著檔名直接開搜尋 */
  function find(query, type) {
    $('cvSearch').value = query; $('cvType').value = type; $('cvBase').value = 'all';
    $('civitaiModal').hidden = false;
    loadKeyState();
    pollDownloads();
    search();
  }
  window.HYCivitai = { find };

  window.addEventListener('DOMContentLoaded', () => {
    $('btnCivitaiBrowse').onclick = open;
    $('cvClose').onclick = close;
    window.HY.closeOnBackdrop($('civitaiModal'), close);
    $('cvSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
    $('cvGo').onclick = () => search();
    $('cvMore').onclick = () => search(true);
    ['cvType', 'cvBase', 'cvSort', 'cvNsfw'].forEach(id => $(id).onchange = () => search());
    $('cvKey').onclick = saveKey;
    $('cvToggleDl').onclick = () => { $('cvDownloads').hidden = !$('cvDownloads').hidden; if (!$('cvDownloads').hidden) pollDownloads(true); };
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('civitaiModal').hidden) { if (S.detail) { $('cvDetail').hidden = true; S.detail = null; } else close(); } });
  });
})();
