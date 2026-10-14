/* 角色卡：左欄「角色」卡片，點卡片把角色標籤加進 / 移出正面提示詞 — 依賴 app.js 暴露的 window.HY */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const HY = () => window.HY;
  // 跟標籤補完一樣：底線換空白、括號跳脫（不然會被當成權重語法）
  const promptText = (tag) => tag.replace(/_/g, ' ').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const TOKEN = '{隨機角色}';
  const PAGE = 60;
  let seq = 0, timer = null, checked = false, offset = 0, end = false, loading = false;

  const inPrompt = (tag) => HY().hasPart($('pos'), promptText(tag));
  const toggle = (tag) => (inPrompt(tag) ? HY().removePart : HY().insertPart)($('pos'), promptText(tag));

  function syncSelected() {
    document.querySelectorAll('#charGrid .char-card').forEach(card => card.classList.toggle('selected', inPrompt(card.dataset.tag)));
  }

  function render(list, append) {
    const grid = $('charGrid');
    if (!append) { grid.replaceChildren(); grid.scrollTop = 0; }
    for (const c of list) {
      const card = document.createElement('button');
      card.type = 'button'; card.className = 'char-card'; card.dataset.tag = c.tag;
      card.title = `${c.name}${c.series ? `（${c.series}）` : ''}\n${c.tag}${c.count ? `\nDanbooru ${c.count} 張` : ''}`;
      const img = document.createElement('img');
      img.loading = 'lazy'; img.alt = ''; img.src = '/yomu/api/characters/thumb?id=' + c.id;
      const name = document.createElement('span'); name.className = 'char-name'; name.textContent = c.name;
      const series = document.createElement('span'); series.className = 'char-series'; series.textContent = c.series;
      card.append(img, name, series);
      card.onclick = () => { toggle(c.tag); syncSelected(); };
      grid.append(card);
    }
    if (!append && !list.length) { const e = document.createElement('div'); e.className = 'char-empty'; e.textContent = '沒有符合的角色'; grid.append(e); }
    syncSelected();
  }

  /** append = 捲到底載入下一頁 */
  async function search(append = false) {
    if (append && (end || loading)) return;
    const my = append ? seq : ++seq;
    if (!append) { offset = 0; end = false; }
    loading = true;
    const p = new URLSearchParams({ q: $('charSearch').value.trim(), offset, limit: PAGE });
    const list = await fetch('/yomu/api/characters?' + p).then(r => r.json()).catch(() => []);
    if (my !== seq) return;
    loading = false; offset += list.length; end = list.length < PAGE;
    render(list, append);
  }

  async function refreshStatus() {
    const s = await fetch('/yomu/api/characters/status').then(r => r.json()).catch(() => null);
    if (!s) return;
    $('charSetup').hidden = s.installed; $('charBrowser').hidden = !s.installed;
    $('btnCharDownload').disabled = s.running;
    const mb = (n) => (n / 2 ** 20).toFixed(0);
    $('charDlState').textContent = s.running
      ? (s.total && s.done < s.total ? `下載中… ${Math.round(s.done / s.total * 100)}%（${mb(s.done)} / ${mb(s.total)} MB）` : '整理縮圖中…')
      : (s.error ? '下載失敗：' + s.error : '');
    if (s.running) { $('charUpdate').hidden = true; setTimeout(refreshStatus, 1000); return; }
    if (s.installed) search();
    if (s.installed && !checked) {        // 打開 Yomu 時問一次 Hugging Face 有沒有新版
      checked = true;
      const c = await fetch('/yomu/api/characters/check').then(r => r.json()).catch(() => null);
      if (c?.update) { $('charUpdateText').textContent = `角色資料包有新版 v${c.latest}`; $('charUpdate').title = `目前 v${c.version}`; $('charUpdate').hidden = false; }
    }
  }
  async function download() {
    await fetch('/yomu/api/characters/download', { method: 'POST' }).catch(() => null);
    refreshStatus();
  }

  /** 生成時把 {隨機角色} 換掉用：有搜尋字就從搜尋結果抽 */
  async function pickRandom() {
    const c = await fetch('/yomu/api/characters/random?q=' + encodeURIComponent($('charSearch').value.trim())).then(r => r.json()).catch(() => null);
    return c?.tag ? { text: promptText(c.tag), name: c.name + (c.series ? `（${c.series}）` : '') } : null;
  }
  window.HYCharacters = { pickRandom };

  window.addEventListener('DOMContentLoaded', () => {
    $('charRandom').onchange = () => (($('charRandom').checked ? HY().insertPart : HY().removePart)($('pos'), TOKEN));
    $('btnCharDownload').onclick = download;
    $('btnCharUpdate').onclick = download;
    $('charSearch').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 150); });
    $('charGrid').addEventListener('scroll', (e) => { const g = e.target; if (g.scrollTop + g.clientHeight > g.scrollHeight - 300) search(true); });
    $('pos').addEventListener('input', () => { $('charRandom').checked = $('pos').value.includes(TOKEN); syncSelected(); });
    refreshStatus();
  });
})();
