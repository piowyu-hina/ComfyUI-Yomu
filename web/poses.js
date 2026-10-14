/* 姿勢卡：左欄「姿勢」卡片。一張 = 名稱 + 一整段描述，一次只放一張進正面提示詞 — 依賴 app.js 暴露的 window.HY
 * 不跳任何視窗：改名、修改、刪除確認、提示都在卡片裡面做 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const HY = () => window.HY;
  const TOKEN = '{隨機姿勢}';
  let poses = [];
  let editing = null, deleting = null, flash = null;   // 正在改的卡、等第二下確認刪除的卡、剛存 / 重複時閃一下的卡

  const filtered = () => {
    const q = $('poseSearch').value.trim().toLowerCase();
    return poses.filter(p => !q || p.name.toLowerCase().includes(q) || p.text.toLowerCase().includes(q));
  };
  const hint = (text, ok = false) => { $('poseHint').textContent = text; $('poseHint').classList.toggle('ok', ok); };
  /** 存檔格式：「單字, 單字」— 逗號後一個空白，拿掉多的空白、空的一段和最後的逗號；換行也當逗號 */
  const tidy = (text) => text.split(/[,\n]/).map(t => t.trim().replace(/\s+/g, ' ')).filter(Boolean).join(', ');

  /** 目前放在提示詞裡的那張：有好幾張的描述都對得上時（一張是另一張的開頭），取描述最長的 */
  const active = () => poses.filter(p => HY().hasPart($('pos'), p.text)).sort((a, b) => b.text.length - a.text.length)[0] || null;

  /** 一次一張：先把目前那張整段拿掉，再放選的這張；點目前那張 = 取消 */
  function select(p) {
    const ta = $('pos'), cur = active();
    if (cur) HY().removePart(ta, cur.text);
    if (cur !== p) HY().insertPart(ta, p.text);
    render();
  }

  async function save() {
    const r = await fetch('/yomu/api/poses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(poses) }).then(r => r.json()).catch(() => null);
    if (!r?.ok) hint('存檔失敗，請確認 ComfyUI 有在執行');
  }

  /** 把提示詞裡反白的那段直接存成一張，名稱欄位直接打開讓你取名 */
  function addFromSelection() {
    const ta = $('pos');
    const text = tidy(ta.value.slice(ta.selectionStart, ta.selectionEnd));
    if (!text) return hint('先在正面提示詞反白選取要存的那段');
    hint('');
    const same = poses.find(p => p.text === text);
    if (same) { flash = same; deleting = null; render(); return; }
    const card = { name: '', text };
    poses.push(card);
    editing = card; deleting = null; flash = card;
    save(); render();
  }

  function finishEdit(p, row) {
    const text = tidy(row.querySelector('.pose-edit-text').value);
    if (text) Object.assign(p, { name: row.querySelector('.pose-edit-name').value.trim(), text });
    editing = null;
    save(); render();
  }

  function render() {
    const list = $('poseList'), cur = active();
    list.replaceChildren();
    for (const p of filtered()) {
      const row = document.createElement('div');
      row.className = 'pose-item' + (p === cur ? ' selected' : '') + (p === flash ? ' flash' : '');
      if (p === editing) {
        row.classList.add('editing');
        const name = document.createElement('input'); name.type = 'text'; name.className = 'pose-edit-name'; name.value = p.name; name.placeholder = '名稱，例如：坐在窗邊回頭看';
        const text = document.createElement('textarea'); text.className = 'pose-edit-text'; text.rows = 2; text.value = p.text;
        const btns = document.createElement('div'); btns.className = 'pose-edit-btns';
        const ok = document.createElement('button'); ok.className = 'mini'; ok.textContent = '✓ 完成';
        const cancel = document.createElement('button'); cancel.className = 'mini'; cancel.textContent = '取消';
        ok.onclick = () => finishEdit(p, row);
        cancel.onclick = () => { editing = null; render(); };
        for (const el of [name, text]) el.onkeydown = (e) => {
          if (e.key === 'Escape') cancel.onclick();
          if (e.key === 'Enter' && (el === name || e.ctrlKey)) { e.preventDefault(); finishEdit(p, row); }
        };
        btns.append(ok, cancel);
        row.append(name, text, btns);
        list.append(row);
        setTimeout(() => name.focus());
        continue;
      }
      row.title = p.text;
      const head = document.createElement('div'); head.className = 'pose-head';
      const name = document.createElement('span'); name.className = 'pose-name' + (p.name ? '' : ' unnamed'); name.textContent = p.name || '未命名';
      const ed = document.createElement('button'); ed.className = 'pose-act'; ed.textContent = '✎'; ed.title = '修改名稱和描述';
      ed.onclick = (e) => { e.stopPropagation(); editing = p; deleting = null; render(); };
      const del = document.createElement('button');
      del.className = 'pose-act' + (p === deleting ? ' confirm' : ''); del.textContent = p === deleting ? '再按一次刪除' : '🗑'; del.title = '刪除';
      del.onclick = (e) => {
        e.stopPropagation();
        if (p !== deleting) { deleting = p; render(); return; }
        poses = poses.filter(x => x !== p); deleting = null;
        save(); render();
      };
      head.append(name, ed, del);
      const text = document.createElement('div'); text.className = 'pose-text'; text.textContent = p.text;
      row.append(head, text);
      row.onclick = () => { deleting = null; select(p); };
      // 拖曳排序：拖的時候直接搬 DOM，放開再照畫面順序存；搜尋中只看得到一部分，不給拖
      row._pose = p;
      row.draggable = !$('poseSearch').value.trim();
      row.ondragstart = (e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-yomu-pose', ''); row.classList.add('dragging'); };
      row.ondragend = () => {
        row.classList.remove('dragging');
        const order = [...list.querySelectorAll('.pose-item')].map(r => r._pose);
        if (order.some((x, i) => x !== poses[i])) { poses = order; save(); }
        render();
      };
      row.ondragover = (e) => {
        const dragged = list.querySelector('.pose-item.dragging');
        if (!dragged) return;
        e.preventDefault();
        if (dragged === row) return;
        const r = row.getBoundingClientRect();
        list.insertBefore(dragged, e.clientY > r.top + r.height / 2 ? row.nextSibling : row);
      };
      row.ondrop = (e) => { if (list.querySelector('.pose-item.dragging')) { e.preventDefault(); e.stopPropagation(); } };
      list.append(row);
      if (p === flash) setTimeout(() => row.scrollIntoView({ block: 'nearest' }));
    }
    flash = null;
    if (!list.children.length) {
      const e = document.createElement('div'); e.className = 'char-empty';
      e.textContent = poses.length ? '沒有符合的姿勢' : '還沒有姿勢卡。在提示詞反白選取一段描述，按「＋ 存成卡」。';
      list.append(e);
    }
  }

  function exportPoses() {
    if (!poses.length) return hint('還沒有姿勢卡可以匯出');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(poses, null, 2)], { type: 'application/json' }));
    a.download = 'yomu-poses.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    hint(`已匯出 ${poses.length} 張`, true);
  }

  /** 加進現有的清單，描述重複的跳過，不蓋掉原本的 */
  async function importPoses(file) {
    let list = null;
    try { list = JSON.parse(await file.text()); } catch {}
    if (!Array.isArray(list)) return hint('這個檔案不是姿勢卡');
    let added = 0, skipped = 0;
    for (const p of list) {
      const text = tidy(String(p?.text || ''));
      if (!text) continue;
      if (poses.some(x => x.text === text)) { skipped++; continue; }
      poses.push({ name: String(p.name || '').trim(), text });
      added++;
    }
    if (added) save();
    render();
    hint(`匯入 ${added} 張` + (skipped ? `，略過 ${skipped} 張重複的` : ''), true);
  }

  /** 生成時把 {隨機姿勢} 換掉用：有搜尋字就從搜尋結果抽 */
  function pickRandom() {
    const pool = filtered();
    if (!pool.length) return null;
    const p = pool[Math.floor(Math.random() * pool.length)];
    return { text: p.text, name: p.name || '未命名姿勢' };
  }
  window.HYPoses = { pickRandom };

  window.addEventListener('DOMContentLoaded', async () => {
    $('poseSearch').addEventListener('input', render);
    $('btnPoseAdd').onclick = addFromSelection;
    $('btnPoseExport').onclick = exportPoses;
    $('btnPoseImport').onclick = () => $('poseImportFile').click();
    $('poseImportFile').onchange = () => { const f = $('poseImportFile').files[0]; $('poseImportFile').value = ''; if (f) importPoses(f); };
    $('poseRandom').onchange = () => (($('poseRandom').checked ? HY().insertPart : HY().removePart)($('pos'), TOKEN));
    $('pos').addEventListener('input', () => { $('poseRandom').checked = $('pos').value.includes(TOKEN); hint(''); if (!editing) render(); });
    poses = await fetch('/yomu/api/poses').then(r => r.json()).catch(() => []);
    if (poses.some(p => p.text !== tidy(p.text))) { for (const p of poses) p.text = tidy(p.text); save(); }   // 以前存的也整理一次
    $('poseRandom').checked = $('pos').value.includes(TOKEN);
    render();
  });
})();
