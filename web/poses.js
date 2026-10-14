/* 姿勢卡：左欄「姿勢」卡片。一張 = 名稱 + 一整段描述，一次只放一張進正面提示詞 — 依賴 app.js 暴露的 window.HY */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const HY = () => window.HY;
  const TOKEN = '{隨機姿勢}';
  let poses = [];

  const filtered = () => {
    const q = $('poseSearch').value.trim().toLowerCase();
    return poses.filter(p => !q || p.name.toLowerCase().includes(q) || p.text.toLowerCase().includes(q));
  };

  function select(p) {
    const ta = $('pos'), on = HY().hasPart(ta, p.text);
    for (const other of poses) if (HY().hasPart(ta, other.text)) HY().removePart(ta, other.text);   // 一次一張
    if (!on) HY().insertPart(ta, p.text);
    render();
  }

  async function save() {
    const r = await fetch('/yomu/api/poses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(poses) }).then(r => r.json()).catch(() => null);
    if (!r?.ok) HY().toast('姿勢卡存檔失敗', true);
    render();
  }

  /** 把提示詞裡選取的那段直接存成一張（名稱先空著，之後按 ✎ 取） */
  function addFromSelection() {
    const ta = $('pos');
    const text = ta.value.slice(ta.selectionStart, ta.selectionEnd).replace(/^[\s,]+|[\s,]+$/g, '');
    if (!text) return HY().toast('先在正面提示詞選取要存的那段', true);
    if (poses.some(p => p.text === text)) return HY().toast('已經有這張姿勢卡了');
    poses.push({ name: '', text });
    save();
    HY().toast('已存成姿勢卡，按 ✎ 可以取名字');
  }

  async function edit(p) {
    const name = await HY().askText({ title: '姿勢卡名稱', value: p.name, placeholder: '例如：坐在窗邊回頭看', okText: '下一步' });
    if (typeof name !== 'string') return;
    const text = await HY().askText({ title: '描述（要加進提示詞的整段）', value: p.text, okText: '儲存' });
    if (typeof text !== 'string' || !text.trim()) return;
    Object.assign(p, { name: name.trim(), text: text.trim().replace(/[\s,]+$/, '') });
    save();
  }

  function remove(p) {
    if (!confirm(`刪除姿勢卡「${p.name || '未命名'}」？`)) return;
    poses = poses.filter(x => x !== p);
    save();
  }

  function render() {
    const list = $('poseList'), ta = $('pos');
    list.replaceChildren();
    for (const p of filtered()) {
      const row = document.createElement('div');
      row.className = 'pose-item' + (HY().hasPart(ta, p.text) ? ' selected' : ''); row.title = p.text;
      const head = document.createElement('div'); head.className = 'pose-head';
      const name = document.createElement('span'); name.className = 'pose-name' + (p.name ? '' : ' unnamed'); name.textContent = p.name || '未命名';
      head.append(name);
      const act = (label, title, fn) => {
        const b = document.createElement('button'); b.className = 'pose-act'; b.textContent = label; b.title = title;
        b.onclick = (e) => { e.stopPropagation(); fn(p); };
        head.append(b);
      };
      act('✎', '修改', edit); act('🗑', '刪除', remove);
      const text = document.createElement('div'); text.className = 'pose-text'; text.textContent = p.text;
      row.append(head, text);
      row.onclick = () => select(p);
      list.append(row);
    }
    if (!list.children.length) {
      const e = document.createElement('div'); e.className = 'char-empty';
      e.textContent = poses.length ? '沒有符合的姿勢' : '還沒有姿勢卡。在提示詞選取一段描述，按「＋ 存成卡」。';
      list.append(e);
    }
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
    $('poseRandom').onchange = () => (($('poseRandom').checked ? HY().insertPart : HY().removePart)($('pos'), TOKEN));
    $('pos').addEventListener('input', () => { $('poseRandom').checked = $('pos').value.includes(TOKEN); render(); });
    poses = await fetch('/yomu/api/poses').then(r => r.json()).catch(() => []);
    $('poseRandom').checked = $('pos').value.includes(TOKEN);
    render();
  });
})();
