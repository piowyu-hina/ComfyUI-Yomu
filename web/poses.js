/* 姿勢卡：左欄「姿勢」卡片。一張 = 名稱 + 一整段描述，一次只放一張進正面提示詞 — 依賴 app.js 暴露的 window.HY */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const HY = () => window.HY;
  const TOKEN = '{隨機姿勢}';
  let official = [], mine = [];

  const all = () => [...official.map(p => ({ ...p, official: true })), ...mine];
  const filtered = () => {
    const q = $('poseSearch').value.trim().toLowerCase();
    return all().filter(p => !q || p.name.toLowerCase().includes(q) || p.text.toLowerCase().includes(q));
  };

  function select(p) {
    const ta = $('pos'), on = HY().hasPart(ta, p.text);
    for (const other of all()) if (HY().hasPart(ta, other.text)) HY().removePart(ta, other.text);   // 一次一張
    if (!on) HY().insertPart(ta, p.text);
    render();
  }

  async function saveMine() {
    const r = await fetch('/yomu/api/poses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mine }) }).then(r => r.json()).catch(() => null);
    if (!r?.ok) HY().toast('姿勢卡存檔失敗', true);
  }

  /** p = null 是新增：描述預設帶入提示詞裡選取的那段 */
  async function edit(p) {
    const ta = $('pos');
    const text = await HY().askText({ title: '姿勢描述（要加進提示詞的整段）', value: p ? p.text : ta.value.slice(ta.selectionStart, ta.selectionEnd).trim(), okText: '下一步' });
    if (typeof text !== 'string' || !text.trim()) return;
    const name = await HY().askText({ title: '姿勢卡名稱', value: p ? p.name : '', placeholder: '例如：坐在窗邊回頭看', okText: '儲存' });
    if (typeof name !== 'string' || !name.trim()) return;
    const card = { name: name.trim(), text: text.trim().replace(/[\s,]+$/, '') };
    if (p) mine[mine.indexOf(p)] = card; else mine.push(card);
    await saveMine();
    render();
  }

  async function remove(p) {
    if (!confirm(`刪除姿勢卡「${p.name}」？`)) return;
    mine = mine.filter(x => x !== p);
    await saveMine();
    render();
  }

  function render() {
    const list = $('poseList'), ta = $('pos');
    list.replaceChildren();
    for (const p of filtered()) {
      const row = document.createElement('div');
      row.className = 'pose-item' + (HY().hasPart(ta, p.text) ? ' selected' : ''); row.title = p.text;
      const head = document.createElement('div'); head.className = 'pose-head';
      const name = document.createElement('span'); name.className = 'pose-name'; name.textContent = p.name;
      const badge = document.createElement('span'); badge.className = 'pose-badge'; badge.textContent = p.official ? '官方' : '我的';
      head.append(name, badge);
      if (!p.official) {
        const ed = document.createElement('button'); ed.className = 'pose-act'; ed.textContent = '✎'; ed.title = '修改';
        const del = document.createElement('button'); del.className = 'pose-act'; del.textContent = '🗑'; del.title = '刪除';
        ed.onclick = (e) => { e.stopPropagation(); edit(p); };
        del.onclick = (e) => { e.stopPropagation(); remove(p); };
        head.append(ed, del);
      }
      const text = document.createElement('div'); text.className = 'pose-text'; text.textContent = p.text;
      row.append(head, text);
      row.onclick = () => select(p);
      list.append(row);
    }
    if (!list.children.length) {
      const e = document.createElement('div'); e.className = 'char-empty';
      e.textContent = all().length ? '沒有符合的姿勢' : '還沒有姿勢卡。在提示詞選取一段描述，按「＋ 存成姿勢卡」。';
      list.append(e);
    }
  }

  /** 生成時把 {隨機姿勢} 換掉用：有搜尋字就從搜尋結果抽 */
  function pickRandom() {
    const pool = filtered();
    if (!pool.length) return null;
    const p = pool[Math.floor(Math.random() * pool.length)];
    return { text: p.text, name: p.name };
  }
  window.HYPoses = { pickRandom };

  window.addEventListener('DOMContentLoaded', async () => {
    $('poseSearch').addEventListener('input', render);
    $('btnPoseAdd').onclick = () => edit(null);
    $('poseRandom').onchange = () => (($('poseRandom').checked ? HY().insertPart : HY().removePart)($('pos'), TOKEN));
    $('pos').addEventListener('input', () => { $('poseRandom').checked = $('pos').value.includes(TOKEN); render(); });
    const d = await fetch('/yomu/api/poses').then(r => r.json()).catch(() => ({ official: [], mine: [] }));
    official = d.official; mine = d.mine;
    $('poseRandom').checked = $('pos').value.includes(TOKEN);
    render();
  });
})();
