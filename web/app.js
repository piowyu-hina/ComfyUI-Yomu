/* Yomu — 前端（Stability Matrix Inference 風格）
 *
 * 流程：讀 workflows/<mode>.json 範本 → 把 UI 參數填進 "@slot" 節點 → POST /prompt
 * 範本裡 _meta.title 以 "@" 開頭的節點就是欄位插槽，其他節點一律原樣送出。
 * "@hires_*" 節點在 Hires Fix 關閉時整組拔掉，@save 直接接回 @decode。
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clientId = 'yomu-' + Math.random().toString(36).slice(2, 10);
  const LS_HISTORY = 'inference.history.v1';
  const LS_PARAMS = 'inference.params.v2';
  const LS_UI = 'inference.ui.v2';
  const MAX_HISTORY = 120;

  const state = { aux: { end: null },
    mode: 'txt2img',
    template: 'txt2img',      // 目前工作流（workflows/<template>.json）
    templates: {},
    unets: [],
    ckpts: [], loras: [], upscalers: [], embeddings: [],
    assets: { loras: {}, embeddings: {} },      // 有沒有預覽圖
    families: {},                              // kind -> name -> 架構家族
    compatOnly: true,
    assetKind: 'loras',
    modelInfo: {},            // 'loras/xxx.safetensors' -> {trainedWords, baseModel, ...}
    source: null,             // { name, subfolder, type, width, height, previewUrl }
    pending: new Map(),       // prompt_id -> { params, saveNodeId, titles, mode }
    history: [],
    current: null,            // { item, idx }
    lastSeed: null,
    ws: null,
    stopping: false,
    submitting: false,
    hiresSupported: false,    // 目前工作流有沒有 @hires_* 節點
  };

  // ================================================================ utils
  function toast(msg, isErr = false) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.toggle('err', isErr);
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (el.hidden = true), isErr ? 6000 : 2200);
  }
  const setStatus = (t) => ($('statusText').textContent = t);
  /** 用 execCommand 改 textarea 內容，瀏覽器的復原堆疊才會記得（Ctrl+Z 可以退回）。
   *  setText：整段換掉；replaceRange：只換 [start,end) 這一段，游標停在插入字後面 */
  function replaceRange(ta, start, end, text) {
    const hadFocus = document.activeElement === ta, s0 = ta.selectionStart, e0 = ta.selectionEnd;
    ta.focus(); ta.setSelectionRange(start, end);
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch {}
    if (!ok || ta.value.slice(start, start + text.length) !== text) { ta.value = ta.value.slice(0, start) + text + ta.value.slice(end); ta.setSelectionRange(start + text.length, start + text.length); }
    if (!hadFocus) ta.blur();
    else if (start > e0 || end < s0) ta.setSelectionRange(s0, e0);   // 改的地方不含原游標就把游標放回去
  }
  function setText(ta, text) { if (ta.value === text) return; replaceRange(ta, 0, ta.value.length, text); }
  /** 提示詞裡完整的一段（前後是逗號、換行或頭尾）：有沒有、拿掉、插到游標位置 — 角色卡、姿勢卡、隨機標籤共用 */
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const partRe = (text) => new RegExp(`(^|[,\\n])[ \\t]*${reEsc(text)}[ \\t]*(?=,|\\n|$),?[ \\t]*`);
  const hasPart = (ta, text) => partRe(text).test(ta.value);
  const removePart = (ta, text) => setText(ta, ta.value.replace(partRe(text), (m, sep) => (sep === ',' ? ', ' : sep)));
  function insertPart(ta, text) {
    const start = ta.selectionStart, before = ta.value.slice(0, start);
    replaceRange(ta, start, ta.selectionEnd, (before && !/[,\n]\s*$/.test(before) ? ', ' : '') + text + ', ');
  }
  /** 點背景關閉：要 pointerdown 和 click 都落在背景才算，拖選文字拖到外面放開不會誤關 */
  const closeOnBackdrop = (el, fn) => { let down = false; el.addEventListener('pointerdown', (e) => { down = e.target === el; }); el.addEventListener('click', (e) => { if (down && e.target === el) fn(); down = false; }); };
  const setProgress = (pct) => ($('progressFill').style.width = Math.max(0, Math.min(100, pct)) + '%');
  const viewUrl = (img) => '/view?' + new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' });
  const randomSeed = () => Math.floor(Math.random() * 4294967295);
  // 圖片的寬高一律 64 的倍數（SDXL 等模型的訓練尺寸）；影片照模型自己的規則，只取 8 的倍數
  const sizeStep = () => (/video/.test(state.mode) ? 8 : 64);
  const roundSize = (n) => Math.max(sizeStep(), Math.round(n / sizeStep()) * sizeStep());
  const snapSize = () => { for (const id of ['width', 'height']) $(id).value = roundSize(parseInt($(id).value, 10) || 1024); syncPreset(); };
  const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const ui = lsGet(LS_UI, {});   // 版面：欄寬、卡片摺疊、卡片順序
  const fmt = (n, d = 2) => Number(n).toFixed(d).replace(/\.?0+$/, '');

  function fillSelect(sel, items, preferred) {
    sel.innerHTML = '';
    for (const it of items) { const o = document.createElement('option'); o.value = it; o.textContent = it; sel.appendChild(o); }
    if (preferred && items.includes(preferred)) sel.value = preferred;
  }
  function matchFile(list, name) {
    if (!name) return null;
    if (list.includes(name)) return name;
    const want = PngInfo.baseName(name).toLowerCase();
    const exact = list.find(x => PngInfo.baseName(x).toLowerCase() === want);
    if (exact) return exact;
    // 模糊：A1111 的 "Model:" 是作者電腦上的檔名，跟 Civitai 檔名常常只差空格底線版本號
    const norm = (s) => PngInfo.baseName(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const w = norm(name);
    if (w.length < 6) return null;
    const scored = list.map(x => { const n = norm(x); const short = n.length < w.length ? n : w, long = n.length < w.length ? w : n; return { x, ok: long.includes(short) || lcs(n, w) / Math.max(n.length, w.length) >= 0.7 }; });
    return scored.find(s => s.ok)?.x || null;
  }
  function lcs(a, b) {   // 最長公共子序列長度（小字串用，夠快）
    const m = a.length, n = b.length; let prev = new Array(n + 1).fill(0);
    for (let i = 1; i <= m; i++) { const cur = new Array(n + 1).fill(0); for (let j = 1; j <= n; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]); prev = cur; }
    return prev[n];
  }
  /** 送出前清掉註解：整行 # 開頭、或行尾 # 之後；再整理多餘逗號 */
  function cleanPrompt(text) {
    return String(text || '').split('\n').map(l => l.replace(/#.*$/, '').trim()).filter(Boolean).join('\n')
      .replace(/\s*,\s*/g, ', ').replace(/(, )+/g, ', ').replace(/^, |, $/g, '').trim();
  }

  // ================================================================ server data
  async function loadModels() {
    const [ckpt, lora, ks, up, unet] = await Promise.all([
      fetch('/object_info/CheckpointLoaderSimple').then(r => r.json()),
      fetch('/object_info/LoraLoader').then(r => r.json()),
      fetch('/object_info/KSampler').then(r => r.json()),
      fetch('/object_info/UpscaleModelLoader').then(r => r.json()),
      fetch('/object_info/UNETLoader').then(r => r.json()),
    ]);
    // object_info 有兩種寫法：[[選項...], {...}] 或 ["COMBO", {options: [...]}]
    const combo = (spec) => (Array.isArray(spec?.[0]) ? spec[0] : spec?.[1]?.options) || [];
    state.ckpts = combo(ckpt.CheckpointLoaderSimple.input.required.ckpt_name);
    state.unets = combo(unet.UNETLoader.input.required.unet_name);
    state.loras = combo(lora.LoraLoader.input.required.lora_name);
    state.upscalers = combo(up.UpscaleModelLoader.input.required.model_name);
    const samplers = combo(ks.KSampler.input.required.sampler_name);
    const schedulers = combo(ks.KSampler.input.required.scheduler);
    try { state.embeddings = await fetch('/yomu/api/embeddings').then(r => r.json()); } catch { state.embeddings = []; }
    try { const r = await fetch('/yomu/api/model-assets'); if (r.ok) state.assets = await r.json(); } catch {}
    try { const r = await fetch('/yomu/api/model-families'); if (r.ok) state.families = await r.json(); } catch {}

    fillCkptSelect();
    fillSelect($('sampler'), samplers, $('sampler').value || 'dpmpp_2m');
    fillSelect($('scheduler'), schedulers, $('scheduler').value || 'karras');
    fillSelect($('hiresModel'), state.upscalers, $('hiresModel').value || state.upscalers.find(u => /anime/i.test(u)) || state.upscalers[0]);
    $('loraCount').textContent = state.loras.length;
    $('embeddingCount').textContent = state.embeddings.length;
    $('ckptCount').textContent = ckptList().length;
    updateCkptPreview();
  }

  // ---- 工作流（範本）----
  const TEMPLATE_LABELS = { txt2img: 'SDXL / Illustrious（標準）', img2img: 'SDXL / Illustrious（標準）', inpaint: 'SDXL / Illustrious（標準）', txt2img_anima: 'Anima', inpaint_anima: 'Anima', txt2video: 'Wan2.2 5B 720p（標準，20 步）', txt2video_turbo: 'Wan2.2 5B 720p Turbo（6 步，推薦）', txt2video_fast: 'Wan2.1 1.3B 480p（快速測試）', img2video: 'Wan2.2 I2V 14B（4 步，畫質好）', img2video_turbo: 'Wan2.2 5B Turbo（6 步，快 3 倍）', img2video_flf: 'Wan2.2 I2V 14B 首尾幀（給頭尾兩張圖）' };
  const tplLabel = (name) => TEMPLATE_LABELS[name] || name.replace(/^(txt2img|img2img|inpaint)_?/, '') || name;
  /** 範本的 @ckpt 是 UNETLoader → 用 diffusion_models 清單；否則 checkpoints */
  function ckptKind(name = state.template) {
    const t = state.templates[name]; if (!t) return 'checkpoints';
    const id = slotId(t, 'ckpt');
    return id && t[id].class_type === 'UNETLoader' ? 'diffusion_models' : 'checkpoints';
  }
  /** 目前工作流吃哪些架構：範本標籤（anima / wan…）→ 同名家族；標準範本 → SDXL 系＋SD1.5 */
  function compatFamilies(name = state.template) {
    if (name.startsWith('txt2video') || name.startsWith('img2video')) return ['wan'];
    const tag = name.replace(/^(txt2img|img2img|inpaint)_?/, '').toLowerCase();
    if (!tag) return ['sdxl', 'sd15'];
    return [tag];
  }
  function isCompat(kind, modelName) {
    if (!state.compatOnly) return true;
    const fam = state.families[kind]?.[modelName] || 'unknown';
    return fam === 'unknown' || compatFamilies().includes(fam);
  }
  const ckptListAll = (name = state.template) => (ckptKind(name) === 'diffusion_models' ? state.unets : state.ckpts);
  const ckptList = (name = state.template) => ckptListAll(name).filter(n => isCompat(ckptKind(name), n))
    // 文生影片：把只能圖生影片的（i2v、非 ti2v）和 14B 藏起來，12GB 卡跑不動也用不到
    .filter(n => !name.startsWith('txt2video') || (!/(^|[^t])i2v/i.test(n) && !/14B/i.test(n)))
    .filter(n => !(name.startsWith('img2video') && name !== 'img2video_turbo') || (/i2v/i.test(n) && /high/i.test(n)))
    .filter(n => name !== 'img2video_turbo' || (/ti2v/i.test(n) && /5B/i.test(n)));
  function fillCkptSelect(preferred) {
    const list = ckptList();
    // 預設挑：指定的 → 目前選的 → 名字含範本標籤的（例如 anima）→ 第一個
    const t = state.templates[state.template]; const own = t && slotId(t, 'ckpt') ? (t[slotId(t, 'ckpt')].inputs.unet_name || t[slotId(t, 'ckpt')].inputs.ckpt_name) : '';
    const tag = state.template.replace(/^(txt2img|img2img|inpaint)_?/, '');
    const guess = (own && list.includes(own)) ? own : (tag ? list.find(n => n.toLowerCase().includes(tag.toLowerCase())) : null);   // 範本自己指定的模型優先
    fillSelect($('ckpt'), list, preferred || ($('ckpt').value && list.includes($('ckpt').value) ? $('ckpt').value : (guess || list[0])));
    $('ckptLabel').textContent = ckptKind() === 'diffusion_models' ? '模型（diffusion_models）' : 'Checkpoint';
    $('ckptCount').textContent = list.length;
  }
  function fillWorkflowSelect() {
    const names = Object.keys(state.templates).filter(n => n.startsWith(state.mode)).sort();
    const sel = $('workflowSel');
    sel.innerHTML = '';
    for (const n of names) { const o = document.createElement('option'); o.value = n; o.textContent = tplLabel(n); sel.appendChild(o); }
    if (!names.includes(state.template)) state.template = names[0] || state.mode;
    sel.value = state.template;
    sel.parentElement.hidden = names.length < 2;
  }
  /** 切換工作流：換模型清單、顯示/隱藏這個範本沒有的欄位、套上次存的或範本預設的取樣參數 */
  function applyTemplate(name, { restore = true } = {}) {
    if (!state.templates[name]) return;
    state.template = name;
    $('workflowSel').value = name;
    const t = state.templates[name];
    const ownModel = slotId(t, 'ckpt') ? (t[slotId(t, 'ckpt')].inputs.unet_name || t[slotId(t, 'ckpt')].inputs.ckpt_name) : '';
    fillCkptSelect(ownModel && ckptListAll(name).includes(ownModel) ? ownModel : undefined);
    $('clipskip').closest('.field').hidden = !slotId(t, 'clipskip');
    $('fieldFp8').hidden = !('weight_dtype' in (t[slotId(t, 'ckpt')]?.inputs || {})) || !!slotId(t, 'ckpt_low');   // 只有 UNETLoader 型範本有 fp8 可選；14B 高低噪兩段的檔案本來就是 fp8，不給選
    state.hiresSupported = !!slotId(t, 'hires_sampler');
    $('fieldEndImage').hidden = !slotId(t, 'load_end_image');
    $('fieldShrink').hidden = !slotId(t, 'shrink');
    $('fieldHiresCn').hidden = !slotId(t, 'hires_cn');
    const saved = restore ? lsGet(LS_PARAMS + '.' + name, null) : null;
    if (saved) { delete saved.pos; delete saved.neg; delete saved.mode; delete saved.template; applyParams(saved, { keepSeed: true }); }
    else {
      const ks = t[slotId(t, 'sampler')]?.inputs || {};
      const lat = t[slotId(t, 'latent')]?.inputs || {};
      applyParams({ steps: ks.steps, cfg: ks.cfg, sampler: ks.sampler_name, scheduler: ks.scheduler,
        ...(/video/.test(name) ? { width: lat.width, height: lat.height, frames: lat.length } : {}) }, { keepSeed: true });
    }
    updateCkptPreview();
    if (state.mode === 'img2video' && state.source?.width) {   // 換範本後尺寸重新貼齊來源比例（5B 要 32 的倍數）
      const [w, h] = fitSource(Math.max(+$('width').value, +$('height').value)); $('width').value = w; $('height').value = h;
      setVideoPresets(true); syncPreset();
    }
    lsSet(LS_UI + '.template.' + state.mode, name);
  }

  async function loadTemplates() {
    const names = await fetch('/yomu/api/workflows').then(r => r.json());
    for (const n of names) state.templates[n] = await fetch('/yomu/api/workflow/' + encodeURIComponent(n)).then(r => r.json());
  }

  // ================================================================ websocket
  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?clientId=${clientId}`);
    ws.binaryType = 'arraybuffer';
    state.ws = ws;
    ws.onopen = () => { $('sbConn').classList.add('ok'); $('sbConn').textContent = '● ComfyUI 已連線'; };
    ws.onclose = () => { $('sbConn').classList.remove('ok'); $('sbConn').textContent = '● 重新連線中…'; setTimeout(connectWs, 2500); };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') { let m; try { m = JSON.parse(ev.data); } catch { return; } onWsMessage(m); }
      else onWsBinary(ev.data);
    };
  }
  function onWsBinary(buf) {
    if (state.pending.size === 0) return;
    const dv = new DataView(buf);
    const evType = dv.getUint32(0);
    let bytes;
    if (evType === 1) bytes = buf.slice(8);
    else if (evType === 4) bytes = buf.slice(8 + dv.getUint32(4));
    else return;
    if (state.stopping || !state.pending.size) return;
    if (onWsBinary._url) URL.revokeObjectURL(onWsBinary._url);
    onWsBinary._url = URL.createObjectURL(new Blob([bytes]));
    showImage(onWsBinary._url, true);
  }
  function onWsMessage(msg) {
    const d = msg.data || {};
    const job = d.prompt_id ? state.pending.get(d.prompt_id) : null;
    switch (msg.type) {
      case 'execution_start': if (job) { job.t0 = Date.now(); if (!state.stopping) { setStatus('開始執行…'); setProgress(2); } } break;
      case 'executing': if (job && d.node && !state.stopping) setStatus(`執行中：${job.titles[d.node] || d.node}`); break;
      case 'progress':
        if (job && !state.stopping) { setProgress(Math.round((d.value / d.max) * 100)); setStatus(`${job.titles[d.node] === 'hires_sampler' ? '精修中' : '採樣中'} ${d.value}/${d.max}`); }
        break;
      case 'executed': {
        if (!job || d.node !== job.saveNodeId) break;
        const images = (d.output?.images || []).filter(i => i.type === 'output');
        if (images.length) onJobImages(d.prompt_id, job, images);
        break;
      }
      case 'execution_success': {
        if (!job) break;
        const sec = job.t0 ? (Date.now() - job.t0) / 1000 : null;
        if (job.item) { job.item.elapsed = sec; lsSet(LS_HISTORY, state.history); if (state.current?.item === job.item) renderMeta(job.item.params, job.item); }
        state.pending.delete(d.prompt_id); finishJob(sec != null ? `完成 · ${sec.toFixed(1)} 秒` : '完成');
        if (job.onDone) job.onDone(job.item);
        break;
      }
      case 'execution_interrupted': if (state.pending.delete(d.prompt_id)) { finishJob('已取消'); if (!state.pending.size) restoreViewer(); } break;
      case 'execution_error':
        if (state.pending.delete(d.prompt_id)) { finishJob('發生錯誤'); toast(`錯誤（${d.node_type || d.node_id}）：${d.exception_message || '未知錯誤'}`, true); if (job?.onFail) job.onFail(); if (!state.pending.size) restoreViewer(); }
        break;
    }
  }
  /** 生成鈕：閒置＝生成；有任務在跑＝中斷（一次只跑一張，不排佇列） */
  function updateGenerateBtn() {
    const running = state.pending.size > 0, b = $('btnGenerate');
    b.textContent = state.stopping ? '中斷中…' : running ? '■ 中斷' : '✦ 生成';
    b.classList.toggle('stop', running);
    b.disabled = state.stopping || (state.submitting && !running);
    $('sbQueue').textContent = running ? '執行中' : '';
  }
  /** 中止 / 出錯後：預覽區回到上一張完整的圖，不要停在半成品 */
  function restoreViewer() {
    if (state.current?.item?.images?.[state.current.idx]) selectItem(state.current.item, state.current.idx);
    else { $('mainImage').hidden = true; $('mainVideo').hidden = true; $('mainVideo').removeAttribute('src'); $('viewerEmpty').hidden = false; }
  }
  function finishJob(text) {
    updateGenerateBtn();
    if (state.pending.size === 0 && !state.stopping) { setStatus(text); setProgress(text.startsWith('完成') ? 100 : 0); if (text.startsWith('完成 ·')) $('sbQueue').textContent = '上一張 ' + text.slice(5); }
  }

  // ================================================================ build prompt
  function slotId(prompt, name) { const want = '@' + name; for (const id in prompt) if (prompt[id]?._meta?.title === want) return id; return null; }
  function setSlot(prompt, name, values) {
    const id = slotId(prompt, name); if (!id) return;
    const inputs = prompt[id].inputs;
    for (const k in values) if (k in inputs) inputs[k] = values[k];
  }
  function nextNodeId(prompt) { let max = 0; for (const id in prompt) { const n = parseInt(id, 10); if (!isNaN(n) && n > max) max = n; } return String(max + 1); }

  /** @lora 插槽展開成 N 個串接的 LoraLoader；沒有 LoRA 就拔掉並接回上游。權重只作用在 model，clip 固定 1.0。
   *  @lora_low（Wan 2.2 low-noise 那一路）是 LoraLoaderModelOnly，沒有 clip。 */
  function applyLoras(prompt, loras, slot = 'lora') {
    const id = slotId(prompt, slot); if (!id) return;
    const tpl = prompt[id];
    const srcModel = tpl.inputs.model, srcClip = tpl.inputs.clip, hasClip = 'clip' in tpl.inputs;
    const consumers = [];
    for (const nid in prompt) for (const [k, v] of Object.entries(prompt[nid].inputs)) if (Array.isArray(v) && v[0] === id) consumers.push([nid, k, v[1]]);
    delete prompt[id];
    let outModel = srcModel, outClip = srcClip;
    loras.forEach((l, i) => {
      const nid = nextNodeId(prompt);
      const inputs = { ...tpl.inputs, model: outModel, lora_name: l.name, strength_model: l.weight };
      if (hasClip) Object.assign(inputs, { clip: outClip, strength_clip: 1.0 });
      prompt[nid] = { class_type: tpl.class_type, _meta: { title: `LoRA ${i + 1}${slot === 'lora' ? '' : ' low'}` }, inputs };
      outModel = [nid, 0]; if (hasClip) outClip = [nid, 1];
    });
    for (const [nid, k, slot] of consumers) prompt[nid].inputs[k] = slot === 0 ? outModel : outClip;
  }
  /** Hires Fix 關閉：拔掉所有 @hires_* 節點，@save 直接吃 @decode */
  /** 影像後處理鏈：每一段 = {prefix, 入口節點(吃 image 的), 出口節點}；關掉的拔掉、下一段接回上一段 */
  const STAGES = [
    { key: 'hires', prefix: '@hires', inNode: 'hires_upscale', inKey: 'image', outNode: 'hires_decode' },   // 放大重畫
  ];
  function applyStages(prompt, enabled) {
    const saveId = slotId(prompt, 'save'), decodeId = slotId(prompt, 'decode');
    if (!saveId || !decodeId || !('images' in prompt[saveId].inputs)) return;   // 影片範本不套
    let prev = [decodeId, 0];
    for (const st of STAGES) {
      const has = Object.keys(prompt).some(id => String(prompt[id]._meta?.title || '').startsWith(st.prefix));
      if (!has) continue;
      if (!enabled[st.key]) {
        for (const id of Object.keys(prompt)) if (String(prompt[id]._meta?.title || '').startsWith(st.prefix)) delete prompt[id];
        continue;
      }
      const inId = slotId(prompt, st.inNode), outId = slotId(prompt, st.outNode);
      if (inId) prompt[inId].inputs[st.inKey] = prev;
      if (outId) prev = [outId, 0];
    }
    prompt[saveId].inputs.images = prev;
  }
  /** 拔掉一個節點：吃它輸出的改接 src */
  function bypassNode(prompt, key, src) {
    const id = slotId(prompt, key); if (!id) return;
    for (const nid in prompt) for (const [k, v] of Object.entries(prompt[nid].inputs)) if (Array.isArray(v) && v[0] === id) prompt[nid].inputs[k] = src;
    delete prompt[id];
  }
  function applyShrink(prompt, p) {
    const id = slotId(prompt, 'shrink'); if (!id) return;
    if (!p.shrink) { bypassNode(prompt, 'shrink', prompt[id].inputs.model); return; }
    // 縮的倍率跟尺寸走：1MP 以下幾乎不縮，1.5MP≈1.25，2.3MP≈1.5，4MP＝2
    const f = Math.max(1.25, Math.min(2.5, Math.round(Math.sqrt((p.width * p.height) / 1048576) * 4) / 4));
    setSlot(prompt, 'shrink', { downscale_factor: f });
  }
  function applyHires(prompt, p) {
    if (!p.hires.enabled) return;
    if (slotId(prompt, 'hires_cn')) {
      if (p.hires.cn) setSlot(prompt, 'hires_cn', { strength: 0.6 });
      else {   // 不鎖：hires 取樣器接回原本的正負面
        const cn = slotId(prompt, 'hires_cn'), s = slotId(prompt, 'hires_sampler');
        prompt[s].inputs.positive = prompt[cn].inputs.positive; prompt[s].inputs.negative = prompt[cn].inputs.negative;
        delete prompt[cn]; delete prompt[slotId(prompt, 'hires_cn_model')];
      }
    }
    setSlot(prompt, 'hires_model', { model_name: p.hires.model });
    setSlot(prompt, 'hires_resize', { width: roundSize(p.width * p.hires.scale), height: roundSize(p.height * p.hires.scale) });
    setSlot(prompt, 'hires_sampler', { seed: p.seed, steps: p.hires.steps, cfg: p.cfg, sampler_name: p.sampler, scheduler: p.scheduler, denoise: p.hires.denoise });
  }

  function collectParams({ rollSeed = false } = {}) {
    const loras = [];
    document.querySelectorAll('.lora-row').forEach(r => {
      const name = r.dataset.name, weight = parseFloat(r.querySelector('input.w').value);
      if (name && !isNaN(weight)) loras.push({ name, weight });
    });
    let seed = parseInt($('seed').value, 10);
    if (rollSeed && (!$('lockSeed').checked || isNaN(seed))) { seed = randomSeed(); $('seed').value = seed; }   // 生成時沒鎖才抽新的；存參數等其他呼叫不能動欄位
    return {
      mode: state.mode,
      template: state.template,
      ckpt: $('ckpt').value,
      clipskip: parseInt($('clipskip').value, 10),
      loras,
      pos: $('pos').value, neg: $('neg').value,
      width: roundSize(parseInt($('width').value, 10) || 768), height: roundSize(parseInt($('height').value, 10) || 1344),
      steps: parseInt($('steps').value, 10), cfg: parseFloat($('cfg').value),
      sampler: $('sampler').value, scheduler: $('scheduler').value,
      seed,
      denoise: parseFloat($('denoise').value),
      resizeToTarget: $('resizeToTarget').checked,
      fp8: $('fp8').checked,
      maskGrow: parseInt($('maskGrow').value, 10) || 0,
      frames: parseInt($('frames').value, 10) || 81,
      endImage: state.aux.end ? auxPath(state.aux.end) : '',
      hires: { enabled: $('hiresOn').checked, model: $('hiresModel').value, scale: parseFloat($('hiresScale').value), steps: parseInt($('hiresSteps').value, 10), denoise: parseFloat($('hiresDenoise').value), cn: $('hiresCn').checked },
      shrink: $('shrinkOn').checked,
      source: state.source ? { name: state.source.name, subfolder: state.source.subfolder, type: state.source.type, width: state.source.width, height: state.source.height } : null,
    };
  }

  function buildPrompt(p) {
    const tpl = state.templates[p.template || p.mode];
    if (!tpl) throw new Error(`找不到範本 ${p.template || p.mode}.json`);
    const prompt = JSON.parse(JSON.stringify(tpl));
    setSlot(prompt, 'ckpt', { ckpt_name: p.ckpt, unet_name: p.ckpt, weight_dtype: p.fp8 ? 'fp8_e4m3fn' : 'default' });
    setSlot(prompt, 'clipskip', { stop_at_clip_layer: p.clipskip });
    // embedding 依架構過濾：只留跟目前工作流同家族的（SDXL 範本另外接受 unknown），其他拿掉以免文字編碼器崩掉
    const fams = compatFamilies(p.template || state.template);
    const embOk = (token) => {
      const base = token.slice('embedding:'.length).toLowerCase();
      const map = state.families.embeddings || {};
      const key = Object.keys(map).find(k => PngInfo.baseName(k).toLowerCase() === base);
      const fam = key ? map[key] : 'unknown';
      return fams.includes(fam) || (fam === 'unknown' && fams.includes('sdxl'));
    };
    const prep = (t) => cleanPrompt(String(t || '').replace(/embedding:[^\s,()<>]+/gi, m => (embOk(m) ? m : '')));
    setSlot(prompt, 'positive', { text: prep(p.pos) });
    setSlot(prompt, 'negative', { text: prep(p.neg) });
    setSlot(prompt, 'latent', { width: p.width, height: p.height, batch_size: 1, amount: 1, length: p.frames });
    setSlot(prompt, 'sampler', { seed: p.seed, noise_seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: p.sampler, scheduler: p.scheduler, denoise: (p.mode === 'img2img' || p.mode === 'inpaint') ? p.denoise : 1.0 });
    if (slotId(prompt, 'sampler_low')) {   // 圖生影片：high / low 兩段各跑一半步數
      const half = Math.max(1, Math.ceil(p.steps / 2));
      setSlot(prompt, 'sampler', { end_at_step: half });
      setSlot(prompt, 'sampler_low', { noise_seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: p.sampler, scheduler: p.scheduler, start_at_step: half, end_at_step: p.steps });
    }
    if (p.mode === 'img2video') {
      if (!p.source) throw new Error('請先放入來源圖片');
      setSlot(prompt, 'load_image', { image: p.source.subfolder ? `${p.source.subfolder}/${p.source.name}` : p.source.name });
      // DaSiWa Lightspeed 內建 4 步，不再掛加速 LoRA
      setSlot(prompt, 'ckpt_low', { unet_name: lowModel(p.ckpt) || p.ckpt });
      if (builtinSpeed(p.ckpt)) {
        for (const key of ['speed_lora_high', 'speed_lora_low']) {
          const id = slotId(prompt, key); if (!id) continue;
          const src = prompt[id].inputs.model;
          for (const nid in prompt) for (const [k, v] of Object.entries(prompt[nid].inputs)) if (Array.isArray(v) && v[0] === id) prompt[nid].inputs[k] = src;
          delete prompt[id];
        }
      }
    }
    if (p.mode === 'inpaint') {
      if (!p.source || !p.inpaintMask) throw new Error('請先放入來源圖片並塗上遮罩');
      setSlot(prompt, 'load_image', { image: p.source.subfolder ? `${p.source.subfolder}/${p.source.name}` : p.source.name });
      setSlot(prompt, 'load_mask', { image: p.inpaintMask });
      setSlot(prompt, 'mask_grow', { expand: p.maskGrow });
    }
    if (p.mode === 'img2img') {
      if (!p.source) throw new Error('請先放入來源圖片');
      setSlot(prompt, 'load_image', { image: p.source.subfolder ? `${p.source.subfolder}/${p.source.name}` : p.source.name });
      setSlot(prompt, 'resize', { width: p.resizeToTarget ? p.width : p.source.width, height: p.resizeToTarget ? p.height : p.source.height });
    }
    if (p.hires.enabled && !p.hires.model) throw new Error('Hires Fix 需要選一個放大模型');
    if (slotId(prompt, 'load_end_image')) {
      if (!p.endImage) throw new Error('首尾幀範本需要一張結尾圖');
      setSlot(prompt, 'load_end_image', { image: p.endImage });
    }
    applyStages(prompt, { hires: p.hires.enabled });
    applyHires(prompt, p);
    applyShrink(prompt, p);
    applyLoras(prompt, p.loras);
    applyLoras(prompt, p.loras.map(l => ({ ...l, name: lowModel(l.name, state.loras) || l.name })), 'lora_low');
    const saveNodeId = slotId(prompt, 'save');
    if (!saveNodeId) throw new Error('範本缺少 @save 節點');
    const titles = {};
    for (const id in prompt) titles[id] = (prompt[id]._meta?.title || prompt[id].class_type).replace(/^@/, '');
    return { prompt, saveNodeId, titles };
  }

  // ================================================================ generate
  async function generate() {
    if (state.pending.size) return cancel();
    if (state.stopping || state.submitting) return;
    state.submitting = true; updateGenerateBtn();
    try {
      const params = collectParams({ rollSeed: true });
      if (!params.ckpt) throw new Error('請先選擇 Checkpoint');
      // {隨機角色} / {隨機姿勢}：欄位裡留著標籤，送出（和存進圖片）的提示詞換成這次抽到的
      const picks = [];
      for (const [token, pick, none] of [['{隨機角色}', HYCharacters.pickRandom, '抽不到角色：先下載角色資料包，或換個搜尋字'], ['{隨機姿勢}', HYPoses.pickRandom, '抽不到姿勢：還沒有姿勢卡，或搜尋不到']]) {
        if (!params.pos.includes(token)) continue;
        const r = await pick();
        if (!r) throw new Error(none);
        params.pos = params.pos.split(token).join(r.text); picks.push(r.name);
      }
      if (picks.length) params.random = picks;
      if (params.mode === 'inpaint') {
        if (!state.source || !HYInpaint.loaded) throw new Error('請先放入來源圖片');
        if (!HYInpaint.hasMask()) throw new Error('還沒塗遮罩：在右邊圖片上把要重畫的地方塗紅');
        setStatus('準備遮罩…');
        const blob = await HYInpaint.exportBlob();
        const fd = new FormData();
        fd.append('image', blob, `mask_${Date.now()}.png`); fd.append('subfolder', 'yomu'); fd.append('overwrite', 'true');
        const up = await fetch('/upload/image', { method: 'POST', body: fd }).then(r => r.json());
        params.inpaintMask = up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
      }
      setStatus('送出中…'); setProgress(1);
      const p = { ...params };
      const { prompt, saveNodeId, titles } = buildPrompt(p);
      const res = await fetch('/prompt', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // SaveImage 會把 extra_pnginfo 的每個 key 寫進 PNG，之後拖回來就能還原參數
        body: JSON.stringify({ prompt, client_id: clientId, extra_data: { extra_pnginfo: { yomu: p } } }),
      });
      const out = await res.json();
      if (!res.ok || out.error) {
        const detail = out.node_errors && Object.keys(out.node_errors).length
          ? Object.values(out.node_errors).flatMap(n => n.errors.map(e => e.message + (e.details ? `：${e.details}` : ''))).join('；')
          : (out.error?.message || res.statusText);
        throw new Error(detail);
      }
      state.pending.set(out.prompt_id, { params: p, saveNodeId, titles, mode: p.mode });
      state.lastSeed = p.seed;
      $('sbRandom').textContent = picks.length ? '🎲 ' + picks.join('、') : '';
      
      updateGenerateBtn();
      saveParams();
    } catch (e) { setStatus('就緒'); setProgress(0); toast(e.message, true); }
    finally { state.submitting = false; updateGenerateBtn(); }
  }
  async function cancel() {
    if (state.stopping || !state.pending.size) return;
    state.stopping = true;
    updateGenerateBtn();
    setStatus('正在中止…等待目前運算停止');
    const ids = [...state.pending.keys()];
    const request = async (url, body) => {
      const res = await fetch(url, { method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`請求失敗 (${res.status})`);
      return body ? null : res.json();
    };
    try {
      await request('/queue', { delete: ids });
      for (const id of ids) await request('/interrupt', { prompt_id: id });
      const deadline = Date.now() + 30000;
      while (true) {
        const queue = await request('/queue');
        const remaining = new Set([...queue.queue_running, ...queue.queue_pending].map(item => item[1]));
        for (const id of ids) if (!remaining.has(id)) state.pending.delete(id);
        updateGenerateBtn();
        if (!ids.some(id => remaining.has(id))) { setStatus('已中止'); setProgress(0); restoreViewer(); break; }
        if (Date.now() >= deadline) { setStatus('後端仍在運算，中止尚未完成，可再次中止'); break; }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (e) { setStatus('中止未確認，請重試'); toast('中止失敗：' + e.message, true); }
    finally {
      state.stopping = false;
      updateGenerateBtn();
    }
  }

  // ================================================================ results / history strip
  function onJobImages(promptId, job, images) {
    const item = { id: promptId, ts: Date.now(), mode: job.mode, params: job.params,
      images: images.map(i => ({ url: viewUrl(i), filename: i.filename, subfolder: i.subfolder || '' })) };
    job.item = item;
    state.history.unshift(item);
    if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
    lsSet(LS_HISTORY, state.history);
    selectItem(item, 0);
    if (GV.open) setTimeout(() => gvLoad(true), 800);
  }
  const isVideoUrl = (u) => /\.(mp4|webm|mkv)(\?|$)/i.test(String(u || '').replace(/^.*filename=/, '').split('&')[0]) || /\.(mp4|webm|mkv)$/i.test(String(u || ''));
  function showImage(url, isPreview = false, isVideo = isVideoUrl(url)) {
    const img = $('mainImage'), vid = $('mainVideo');
    if (state.mode === 'inpaint') HYInpaint.show(false);
    if (!isPreview && isVideo) { img.hidden = true; vid.src = url; vid.hidden = false; $('viewerEmpty').hidden = true; $('viewerTools').hidden = false; return; }
    vid.hidden = true; vid.removeAttribute('src');
    img.src = url; img.hidden = false;
    $('viewerEmpty').hidden = true;
    if (!isPreview) $('viewerTools').hidden = false;
  }
  function selectItem(item, idx = 0) {
    state.current = { item, idx };
    const img = item.images[idx];
    showImage(img.url);
    $('btnOpen').href = img.url;
    renderMeta(item.params, item);
  }
  function renderMeta(p, item) {
    const v = (x, d = '?') => (x == null ? d : x);
    const took = item?.elapsed != null ? ` · ⏱ ${item.elapsed.toFixed(1)}s` : '';
    const loras = p.loras?.length ? p.loras.map(l => `${PngInfo.baseName(l.name)}:${l.weight}`).join(', ') : '無';
    const hires = p.hires?.enabled ? ` · Hires ×${p.hires.scale}` : '';
    $('metaBar').textContent = `${v(p.width)}×${v(p.height)}${hires}${took} · ${v(p.steps)}步 · CFG ${v(p.cfg)} · ${v(p.sampler)}/${v(p.scheduler)} · seed ${v(p.seed)} · ${PngInfo.baseName(p.ckpt) || '?'} · LoRA: ${loras}`;
    $('metaBar').title = $('metaBar').textContent;
  }
  let menuImage = null;

  function saveCurrentImage() {
    const im = menuImage || state.current?.item.images[state.current.idx];
    if (!im) { toast('沒有可另存的圖片', true); return; }
    const a = document.createElement('a');
    a.href = im.url; a.download = im.filename || `yomu_${Date.now()}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    toast(`已另存：${a.download}`);
  }

  // ================================================================ 參數 <-> UI
  function applyParams(p, { keepSeed = false } = {}) {
    const missing = [];
    if (p.mode && p.mode !== state.mode) switchMode(p.mode);
    if (p.template && p.template !== state.template && state.templates[p.template]) applyTemplate(p.template, { restore: false });
    if (p.ckpt) {
      let m = matchFile(ckptListAll(), p.ckpt);
      if (!m) {
        // 這張圖的模型不在目前工作流的清單裡（例如 Anima 圖、現在卻在 SDXL）→ 找一個吃得下它的工作流切過去
        const other = Object.keys(state.templates).find(n => n.startsWith(state.mode) && n !== state.template && matchFile(ckptListAll(n), p.ckpt));
        if (other) { applyTemplate(other, { restore: false }); m = matchFile(ckptListAll(), p.ckpt); }
      }
      if (m && !ckptList().includes(m)) { state.compatOnly = false; $('compatOnly').checked = false; fillCkptSelect(m); }
      if (m) { $('ckpt').value = m; updateCkptPreview(); } else missing.push({ label: 'Checkpoint', type: 'Checkpoint', name: p.ckpt });
    }
    if (p.clipskip != null) $('clipskip').value = String(p.clipskip);
    if (p.pos != null) setText($('pos'), p.pos);
    if (p.neg != null) setText($('neg'), p.neg);
    if (p.width) $('width').value = p.width;
    if (p.height) $('height').value = p.height;
    if (/video/.test(p.mode || state.mode)) syncPreset(); else snapSize();   // 舊圖的 720×1280 這類尺寸也對齊 64
    if (p.steps) { $('steps').value = p.steps; $('stepsVal').textContent = p.steps; }
    if (p.cfg != null) { $('cfg').value = p.cfg; $('cfgVal').textContent = fmt(p.cfg); }
    if (p.sampler && [...$('sampler').options].some(o => o.value === p.sampler)) $('sampler').value = p.sampler;
    if (p.scheduler && [...$('scheduler').options].some(o => o.value === p.scheduler)) $('scheduler').value = p.scheduler;
    if (p.seed != null && !keepSeed) { $('seed').value = p.seed; $('lockSeed').checked = true; }
    if (p.denoise != null) { $('denoise').value = p.denoise; $('denoiseVal').textContent = Number(p.denoise).toFixed(2); }
    if (p.resizeToTarget != null) $('resizeToTarget').checked = p.resizeToTarget;
    if (p.fp8 != null) $('fp8').checked = !!p.fp8;
    if (p.frames) $('frames').value = p.frames;
    if (/video/.test(state.mode)) setVideoPresets(true);
    if (p.loras) {
      $('loraList').innerHTML = '';
      for (const l of p.loras) { const m = matchFile(state.loras, l.name); if (m) addLoraRow(m, l.weight); else missing.push({ label: 'LoRA', type: 'LORA', name: l.name }); }
      updateLoraEmpty();
    }
    if (p.shrink != null) $('shrinkOn').checked = !!p.shrink;
    if (p.hires) {
      const h = p.hires;
      if (h.enabled != null) $('hiresOn').checked = !!h.enabled;
      if (h.model) { const m = matchFile(state.upscalers, h.model); if (m) $('hiresModel').value = m; else if (h.enabled) missing.push({ label: '放大模型', type: 'Upscaler', name: h.model }); }
      if (h.scale) { $('hiresScale').value = h.scale; $('hiresScaleVal').textContent = fmt(h.scale, 2); }
      if (h.steps) { $('hiresSteps').value = h.steps; $('hiresStepsVal').textContent = h.steps; }
      if (h.denoise != null) { $('hiresDenoise').value = h.denoise; $('hiresDenoiseVal').textContent = Number(h.denoise).toFixed(2); }
      if (h.cn != null) $('hiresCn').checked = !!h.cn;
    }
    syncHires();
    hlAll();
    return missing;
  }
  function saveParams() { const p = collectParams(); delete p.seed; delete p.source; lsSet(LS_PARAMS, p); lsSet(LS_PARAMS + '.' + state.template, p); }
  function restoreParams() { const p = lsGet(LS_PARAMS, null); if (p) { p.mode = undefined; p.template = undefined; applyParams(p, { keepSeed: true }); } }

  /** A1111 圖只有作者端的檔名＋hash：名字對不到就用 hash 問伺服器 */
  async function resolveModelHash(p) {
    if (!p.modelHash) return p;
    const all = [...state.ckpts, ...state.unets];
    if (p.ckpt && matchFile(all, p.ckpt)) return p;
    try {
      const r = await fetch('/yomu/api/model-by-hash?hash=' + encodeURIComponent(p.modelHash)).then(r => r.json());
      if (r.ok) return { ...p, ckpt: r.name };
    } catch {}
    return p;
  }

  /** 拖進來的圖：先顯示在預覽區（不進歷史），再讀它的參數 */
  function showLocalImage(file, params) {
    if (showLocalImage._url) URL.revokeObjectURL(showLocalImage._url);
    const url = showLocalImage._url = URL.createObjectURL(file);
    const item = { id: 'local-' + Date.now(), ts: Date.now(), mode: params?.mode || 'txt2img', params: params || {}, images: [{ url, filename: file.name, subfolder: '' }] };
    state.current = { item, idx: 0 };
    showImage(url, false, isVideoFile(file.name) || file.type.startsWith('video/'));
    $('btnOpen').href = url;
    if (params) renderMeta(params); else $('metaBar').textContent = file.name;
  }
  /** 圖片：PNG 文字區塊；影片：容器 metadata（交給伺服器讀） */
  async function readFileTags(file, video) {
    if (video) {
      const fd = new FormData(); fd.append('file', file, file.name);
      return fetch('/yomu/api/videoinfo', { method: 'POST', body: fd }).then(r => r.json());
    }
    return /png$/i.test(file.name) || file.type === 'image/png' ? PngInfo.readTextChunks(await file.arrayBuffer()) : {};
  }
  /** 丟進來的圖／影片：讀參數、切到對應分頁；沒有參數的圖在需要來源圖的分頁就當來源 */
  async function loadParamsFromFile(file) {
    const video = !!file && (isVideoFile(file.name) || file.type.startsWith('video/'));
    if (!file || !(video || file.type.startsWith('image/'))) { toast('請拖圖片或影片檔', true); return; }
    let tags;
    try { tags = await readFileTags(file, video); } catch { toast('讀取參數失敗：請確認 ComfyUI 已重新啟動到最新版', true); return; }
    let raw = PngInfo.parseParams(tags);
    if (video && raw?.origin !== 'yomu') raw = null;   // 影片只認 Yomu 自己存的參數
    if (!raw) {
      if (!video && ['img2img', 'inpaint', 'img2video'].includes(state.mode)) { uploadFile(file, { keepMode: true }); return; }
      showLocalImage(file, null);
      toast(video ? '這支影片裡沒有 Yomu 的參數，只顯示影片' : '這張圖裡沒有可讀的生圖參數，只顯示圖片');
      return;
    }
    const pos = PngInfo.extractLoras(raw.pos), neg = PngInfo.extractLoras(raw.neg);
    const p = { ...raw, pos: pos.text, neg: neg.text, loras: raw.loras?.length ? raw.loras : pos.loras };
    if (raw.origin !== 'yomu') p.mode = 'txt2img';
    showLocalImage(file, p);
    const missing = applyParams(await resolveModelHash(p));
    const restored = await restoreSources(p);
    const srcName = { yomu: 'Yomu', stability_matrix: 'Stability Matrix', comfyui: 'ComfyUI', a1111: 'A1111' }[raw.origin] || raw.origin;
    toast(`已載入參數（來源：${srcName}），切到「${document.querySelector(`#modeTabs .tab[data-mode="${state.mode}"]`)?.textContent || state.mode}」` + (restored ? '；' + restored : ''));
    showMissing(missing);
  }
  /** 圖用到的模型這台電腦沒有 → 列出來，每個都可以直接到 Civitai 搜 */
  function showMissing(missing) {
    if (!missing.length) return;
    const list = $('missingList'); list.textContent = '';
    for (const m of missing) {
      const row = document.createElement('div'); row.className = 'row';
      const kind = document.createElement('span'); kind.className = 'miss-kind'; kind.textContent = m.label;
      const name = document.createElement('span'); name.className = 'miss-name'; name.textContent = PngInfo.baseName(m.name);
      const btn = document.createElement('button'); btn.className = 'mini'; btn.textContent = '☁ 到 Civitai 找';
      btn.onclick = () => { $('missingModal').hidden = true; HYCivitai.find(PngInfo.baseName(m.name), m.type); };
      row.append(kind, name, btn);
      list.appendChild(row);
    }
    $('missingModal').hidden = false;
  }

  // ================================================================ LoRA rows + 瀏覽器
  const previewUrl = (kind, name) => '/yomu/api/model-preview?' + new URLSearchParams({ kind, name });
  async function modelInfo(kind, name) {
    const key = `${kind}/${name}`;
    if (!(key in state.modelInfo)) {
      try { state.modelInfo[key] = await fetch('/yomu/api/model-info?' + new URLSearchParams({ kind, name })).then(r => r.ok ? r.json() : {}); }
      catch { state.modelInfo[key] = {}; }
    }
    return state.modelInfo[key];
  }
  /** 把觸發詞插到正面提示詞（已經有的不重複） */
  function insertTriggerWords(words) {
    const ta = $('pos');
    const have = ta.value.toLowerCase();
    const add = words.filter(w => w && !have.includes(w.toLowerCase()));
    if (!add.length) { toast('觸發詞已經在提示詞裡了'); return; }
    const sep = ta.value.trim() ? (/[,\n]\s*$/.test(ta.value) ? '' : ', ') : '';
    replaceRange(ta, ta.value.length, ta.value.length, sep + add.join(', ') + ', ');
    syncHl('pos');
    toast('已加入：' + add.join(', '));
  }
  /** Wan 2.2 14B 的 low-noise 模型／LoRA = 同名把 high 換成 low（或 -H- 這種單字母換成 L）；找不到回 null */
  function lowModel(high, list = state.unets) {
    const low = high.replace(/high/gi, m => m === 'HIGH' ? 'LOW' : m === 'High' ? 'Low' : 'low');
    if (low !== high && list.includes(low)) return low;
    const short = high.replace(/(^|[-_ .])H(?=[-_ .])/g, '$1L');
    return short !== high && list.includes(short) ? short : null;
  }
  const builtinSpeed = name => /lightspeed|dasiwa/i.test(name);
  async function updateCkptPreview() {
    const name = $('ckpt').value;
    $('ckptName').textContent = name ? PngInfo.baseName(name) : '（沒有模型）';
    $('ckptMeta').textContent = ''; $('ckptPreviewImg').hidden = true;
    const t = state.templates[state.template];
    document.querySelectorAll('.lora-row').forEach(r => r._refresh());   // 換範本時 Low 配對那行跟著變
    $('ckptLow').hidden = !(name && t && slotId(t, 'ckpt_low'));
    if (!$('ckptLow').hidden) {
      const low = lowModel(name);
      $('ckptLow').textContent = (low ? `↳ Low（自動配對）：${PngInfo.baseName(low)}` : '⚠ 找不到對應的 Low 模型，後半段也會用這個 High')
        + (builtinSpeed(name) ? '　· 內建加速，已拿掉 lightx2v LoRA' : '　· 搭配 lightx2v 4 步加速 LoRA');
    }
    if (!name) return;
    const kind = ckptKind();
    const has = !!state.assets[kind]?.[name];
    const info = await modelInfo(kind, name);
    if (name !== $('ckpt').value) return;
    $('ckptPreviewImg').src = has ? previewUrl(kind, name) : '';
    $('ckptPreviewImg').hidden = !has;
    $('ckptMeta').textContent = [info.modelName, info.versionName, info.baseModel].filter(Boolean).join(' · ');
  }
  function addLoraRow(name = '', weight = 1.0) {
    if (!name) return;
    const row = document.createElement('div');
    row.className = 'lora-row'; row.dataset.name = name;
    const thumb = document.createElement('img'); thumb.className = 'thumb'; thumb.alt = '';
    const label = document.createElement('span'); label.className = 'name';
    const l1 = document.createElement('span'); l1.textContent = PngInfo.baseName(name);
    const l2 = document.createElement('small'); l2.hidden = true;
    const l3 = document.createElement('small'); l3.hidden = true;
    label.append(l1, l2, l3);
    const sel = { value: name };                       // 名稱固定，下面的 refresh 沿用 sel.value
    const w = document.createElement('input');
    w.type = 'number'; w.className = 'w'; w.step = '0.05'; w.value = Number(weight).toFixed(2); w.title = '權重（model）';
    const tw = document.createElement('button'); tw.className = 'tw'; tw.textContent = '✚'; tw.title = '加入觸發詞'; tw.disabled = true;
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.title = '移除';
    x.onclick = () => { row.remove(); updateLoraEmpty(); };
    const refresh = async () => {
      const n = sel.value;
      const t = state.templates[state.template];
      l3.hidden = !(t && slotId(t, 'lora_low'));
      if (!l3.hidden) { const low = lowModel(n, state.loras); l3.textContent = low ? '↳ Low：' + PngInfo.baseName(low) : '↳ High、Low 兩段都用這個'; }
      const has = !!state.assets.loras?.[n];
      thumb.classList.toggle('none', !has);
      thumb.src = has ? previewUrl('loras', n) : '';
      thumb.title = n;
      const info = await modelInfo('loras', n);
      if (sel.value !== n) return;
      const words = info.trainedWords || [];
      tw.disabled = words.length === 0;
      tw.title = words.length ? '加入觸發詞：' + words.join(', ') : '沒有觸發詞資料';
      const meta = [info.modelName, info.versionName, info.baseModel].filter(Boolean).join(' · ');
      l2.textContent = meta; l2.hidden = !meta;
      label.title = n + (meta ? '\n' + meta : '');
    };
    row._refresh = refresh;
    tw.onclick = () => insertTriggerWords(state.modelInfo[`loras/${sel.value}`]?.trainedWords || []);
    row.append(thumb, label, w, tw, x);
    $('loraList').appendChild(row);
    refresh();
    updateLoraEmpty();
  }
  function updateLoraEmpty() { $('loraEmpty').hidden = document.querySelectorAll('.lora-row').length > 0; renderAssets(); }

  function renderAssets() {
    if ($('assetModal').hidden) return;
    const kind = state.assetKind, query = $('assetSearch').value.trim().toLowerCase();
    const selected = new Set([...document.querySelectorAll('.lora-row')].map(el => el.dataset.name));
    const previews = state.assets[kind === 'checkpoints' ? ckptKind() : kind] || {};
    const realKind = kind === 'checkpoints' ? ckptKind() : kind;
    const names = ({ loras: state.loras.filter(n => isCompat('loras', n)), embeddings: state.embeddings, checkpoints: ckptList() })[kind] || [];
    const previewName = (name) => kind === 'embeddings' ? Object.keys(previews).find(n => n.replace(/\.[^.]+$/, '') === name) : name;
    const items = names.filter(n => n.toLowerCase().includes(query));
    items.sort((a, b) => Number(!!previews[previewName(b)]) - Number(!!previews[previewName(a)]));
    const grid = $('assetGrid');
    grid.replaceChildren();
    for (const name of items) {
      const card = document.createElement('div'); card.tabIndex = 0; card.setAttribute('role', 'button');
      card.className = 'asset-card'; card.title = name;
      const isSel = (kind === 'loras' && selected.has(name)) || (kind === 'checkpoints' && $('ckpt').value === name);
      card.classList.toggle('selected', isSel);
      const art = document.createElement('span'); art.className = 'asset-art';
      const mono = document.createElement('span'); mono.className = 'asset-monogram';
      mono.textContent = kind === 'embeddings' ? 'Em' : PngInfo.baseName(name).slice(0, 2).toUpperCase();
      art.append(mono);
      const sub = document.createElement('div'); sub.className = 'asset-sub';
      modelInfo(realKind, name).then(info => {
        if (info.baseModel) { const b = document.createElement('span'); b.className = 'asset-badge'; b.textContent = info.baseModel; art.append(b); }
        const meta = [info.modelName, info.versionName].filter(Boolean).join(' · ');
        sub.textContent = meta;
        card.title = name + (meta ? `\n${meta}` : '') + (info.trainedWords?.length ? `\n觸發詞：${info.trainedWords.join(', ')}` : '');
      });
      const file = previewName(name);
      if (previews[file]) {
        const img = document.createElement('img'); img.alt = ''; img.loading = 'lazy';
        img.src = '/yomu/api/model-preview?' + new URLSearchParams({ kind: realKind, name: file });
        img.onerror = () => img.remove();
        art.append(img);
      }
      const label = document.createElement('div'); label.className = 'asset-name'; label.textContent = PngInfo.baseName(name).replace(/_/g, ' ');
      const add = document.createElement('span'); add.className = 'asset-add'; add.textContent = isSel ? '✓' : '+';
      const del = document.createElement('span'); del.className = 'asset-del'; del.textContent = '🗑'; del.title = '移到資源回收筒（含預覽圖與資訊檔）';
      del.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`把「${name}」移到資源回收筒？\n（連同預覽圖、cm-info.json 一起）`)) return;
        let r; try { r = await fetch('/yomu/api/model-delete?' + new URLSearchParams({ kind: realKind, name }), { method: 'POST' }).then(r => r.json()); }
        catch (err) { toast('刪除失敗：' + err.message, true); return; }
        if (!r.ok) { toast('刪除失敗：' + r.msg, true); return; }
        if (kind === 'loras') document.querySelectorAll('.lora-row').forEach(row => { if (row.dataset.name === name) row.remove(); });
        await loadModels(); updateLoraEmpty(); renderAssets(); updateCkptPreview();
        toast('已移到資源回收筒：' + PngInfo.baseName(name));
      };
      card.append(art, label, sub, add, del);
      card.onclick = () => {
        if (kind === 'checkpoints') {
          $('ckpt').value = name; updateCkptPreview(); renderAssets(); toast('已選擇 ' + PngInfo.baseName(name)); $('assetModal').hidden = true;
        } else if (kind === 'loras') {
          const existing = [...document.querySelectorAll('.lora-row')].find(r => r.dataset.name === name);
          if (existing) { existing.remove(); updateLoraEmpty(); } else addLoraRow(name);
        } else {
          const ta = $('pos'), start = ta.selectionStart, end = ta.selectionEnd;
          const before = ta.value.slice(0, start);
          const prefix = before && !/[,\n]\s*$/.test(before) ? ', ' : '';
          ta.setRangeText(prefix + 'embedding:' + name + ', ', start, end, 'end');
          syncHl('pos'); ta.focus();
        }
      };
      grid.append(card);
    }
    if (!items.length) { const e = document.createElement('div'); e.className = 'asset-empty'; e.textContent = query ? '沒有符合的' : '這個分類沒有檔案'; grid.append(e); }
  }
  function setupAssets() {
    const open = (kind) => {
      if (kind) { state.assetKind = kind; document.querySelectorAll('#assetTabs .tab').forEach(x => x.classList.toggle('active', x.dataset.kind === kind)); }
      $('assetModal').hidden = false; renderAssets(); $('assetSearch').focus();
    };
    const close = () => { $('assetModal').hidden = true; };
    $('btnLibrary').onclick = () => open('checkpoints');
    $('ckptPreview').onclick = () => open('checkpoints');
    $('ckptPreview').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open('checkpoints'); } };
    $('btnAddLora').onclick = () => open('loras');
    $('btnCloseAssets').onclick = close;
    closeOnBackdrop($('assetModal'), close);
    $('assetTabs').onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      state.assetKind = b.dataset.kind;
      document.querySelectorAll('#assetTabs .tab').forEach(x => x.classList.toggle('active', x === b));
      $('assetHelp').textContent = { checkpoints: '點卡片切換 Checkpoint。', loras: '點卡片加入／移除 LoRA，權重回到左側「模型」卡調整；LoRA 列的 ✚ 可加入觸發詞。', embeddings: '點卡片把 embedding 插到正面提示詞的游標位置。' }[state.assetKind];
      $('assetSearch').value = '';
      renderAssets();
    };
    $('assetSearch').addEventListener('input', renderAssets);
  }

  // ================================================================ size / hires / mode
  const IMG_PRESETS = [['768x1344', '768 × 1344（9:16）'], ['1344x768', '1344 × 768（16:9）'], ['1024x1024', '1024 × 1024（1:1）'], ['768x1024', '768 × 1024（3:4）'], ['1024x768', '1024 × 768（4:3）'], ['640x896', '640 × 896（5:7）'], ['832x1216', '832 × 1216（2:3）'], ['1216x832', '1216 × 832（3:2）'], ['1024x1536', '1024 × 1536（2:3 大）'], ['1536x1024', '1536 × 1024（3:2 大）']];
  const VID_PRESETS = [['1280x704', '1280 × 704（16:9 720p）'], ['704x1280', '704 × 1280（9:16 720p）'], ['960x544', '960 × 544（16:9 小）'], ['544x960', '544 × 960（9:16 小）'], ['832x480', '832 × 480（480p）'], ['480x832', '480 × 832（480p 直）'], ['640x640', '640 × 640']];
  /** 來源圖依長邊縮放、取 16 的倍數 */
  function fitSource(longSide) {
    const t = state.templates[state.template] || {};
    const step = t[slotId(t, 'latent')]?.class_type === 'Wan22ImageToVideoLatent' ? 32 : 16;   // 5B 要 32 的倍數
    const s = longSide / Math.max(state.source.width, state.source.height);
    return [Math.max(256, Math.round(state.source.width * s / step) * step), Math.max(256, Math.round(state.source.height * s / step) * step)];
  }
  function setVideoPresets(isVideo) {
    const sel = $('presetSel'), cur = sel.value;
    $('width').step = $('height').step = sizeStep();
    // 圖生影片：多幾個「跟來源同比例」的快捷（依長邊）
    const srcOpts = [];
    if (state.mode === 'img2video' && state.source?.width && state.source?.height) {
      for (const [long, label] of [[640, '480p 等級'], [704, '快速'], [896, '標準'], [1280, '720p 等級（慢）']]) {
        const [w, h] = fitSource(long);
        srcOpts.push([`${w}x${h}`, `同來源比例 ${w} × ${h}（${label}）`]);
      }
    }
    sel.innerHTML = [...srcOpts, ...(isVideo ? VID_PRESETS : IMG_PRESETS)].map(([v, l]) => `<option value="${v}">${l}</option>`).join('') + '<option value="custom">自訂…</option>';
    sel.value = [...sel.options].some(o => o.value === cur) ? cur : 'custom';
    const t = state.templates[state.template] || {};
    const fr = $('frames'), outFps = t[slotId(t, 'video')]?.inputs?.fps || 24, mult = t[slotId(t, 'vfi')]?.inputs?.multiplier || 1;
    const fps = outFps / mult;
    $('framesVal').textContent = `≈ ${(fr.value / fps).toFixed(1)} 秒${mult > 1 ? `（補幀後 ${outFps}fps）` : ` @ ${fps}fps`}`;
  }
  function syncPreset() {
    const key = `${$('width').value}x${$('height').value}`;
    const sel = $('presetSel');
    sel.value = [...sel.options].some(o => o.value === key) ? key : 'custom';
    syncHires();
  }
  function syncHires() {
    const on = $('hiresOn').checked;
    if (on && !addonOn('hires')) lsSet(LS_ADDONS, [...lsGet(LS_ADDONS, []), 'hires']);   // 拖進來的圖有開 Hires Fix：卡片跟著加回來
    addonCard('hires').hidden = !state.hiresSupported || !addonOn('hires');
    addonCard('hires').classList.toggle('off', !on);
    renderAddonMenu();
    const s = parseFloat($('hiresScale').value);
    $('hiresTarget').textContent = on ? `→ ${roundSize($('width').value * s)}×${roundSize($('height').value * s)}` : '';
  }
  // ================================================================ 左欄「＋ 新增」的卡片
  const LS_ADDONS = 'yomu.addons';
  const ADDON_NAMES = { hires: 'Hires Fix', char: '角色', pose: '姿勢' };
  const addonCard = (key) => document.querySelector(`.stack [data-addon="${key}"]`);
  // 加了哪些卡片記在 localStorage；Hires Fix 開不開看卡片裡的勾選框（跟著參數存）
  const addonOn = (key) => lsGet(LS_ADDONS, []).includes(key);
  function setAddon(key, on) {
    lsSet(LS_ADDONS, [...lsGet(LS_ADDONS, []).filter(k => k !== key), ...(on ? [key] : [])]);
    addonCard(key).hidden = !on;
    if (key === 'hires' && !on) { $('hiresOn').checked = false; saveParams(); }   // 拿掉 Hires Fix 卡片 = 關掉；開關在卡片裡的勾選框
    if (key === 'hires') syncHires(); else renderAddonMenu();
    if (!on) return;
    const card = addonCard(key), scroll = document.querySelector('.stack-scroll');
    scroll.insertBefore(card, $('addonAdd'));                       // 新增的卡片放到最下面，並記住排序
    ui.order = [...scroll.querySelectorAll(':scope > .card')].map(c => c.querySelector('.card-title')?.textContent);
    lsSet(LS_UI, ui);
    card.classList.remove('collapsed'); card.scrollIntoView({ block: 'nearest' });
  }
  function renderAddonMenu() {
    const keys = Object.keys(ADDON_NAMES).filter(k => !addonOn(k) && (k !== 'hires' || state.hiresSupported));
    $('addonMenu').replaceChildren(...keys.map(k => {
      const b = document.createElement('button'); b.textContent = ADDON_NAMES[k];
      b.onclick = () => { $('addonMenu').hidden = true; setAddon(k, true); };
      return b;
    }));
    $('addonAdd').hidden = !keys.length;
  }
  function setupAddons() {
    const scroll = document.querySelector('.stack-scroll');
    scroll.appendChild($('addonAdd'));   // 卡片排序會把卡片搬到後面，按鈕放回最底
    // 存過的順序裡沒有的卡片（之後才加的功能）排在最下面，不要被擠到最上面
    if (ui.order) for (const card of scroll.querySelectorAll(':scope > .card')) if (!ui.order.includes(card.querySelector('.card-title')?.textContent)) scroll.insertBefore(card, $('addonAdd'));
    for (const key of Object.keys(ADDON_NAMES)) addonCard(key).querySelector('.addon-x').onclick = () => setAddon(key, false);
    for (const key of lsGet(LS_ADDONS, [])) if (addonCard(key)) addonCard(key).hidden = false;
    $('btnAddon').onclick = () => { $('addonMenu').hidden = !$('addonMenu').hidden; };
    document.addEventListener('pointerdown', (e) => { if (!$('addonAdd').contains(e.target)) $('addonMenu').hidden = true; });
    renderAddonMenu();
  }

  function switchMode(mode) {
    state.mode = mode;
    document.querySelectorAll('#modeTabs .tab').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    const usesSource = mode === 'img2img' || mode === 'inpaint' || mode === 'img2video';
    const isVideo = mode === 'txt2video' || mode === 'img2video';
    $('fieldFrames').hidden = !isVideo;
    $('cardVideo').hidden = !isVideo;
    setVideoPresets(isVideo);
    $('cardSource').hidden = !usesSource;
    $('fieldDenoise').hidden = !(mode === 'img2img' || mode === 'inpaint');
    $('fieldResize').hidden = mode !== 'img2img';
    $('fieldMaskGrow').hidden = mode !== 'inpaint';
    $('btnEditMask').hidden = mode !== 'inpaint';
    $('btnResultAsSource').hidden = !usesSource;
    if (mode === 'inpaint') { if (state.source) { HYInpaint.load(state.source.previewUrl, state.source.width, state.source.height).then(() => HYInpaint.show(true)); } }
    else HYInpaint.show(false);
    positionMaskTools();
    if (Object.keys(state.templates).length) {
      fillWorkflowSelect();
      const remembered = lsGet(LS_UI + '.template.' + mode, null);
      applyTemplate(remembered && state.templates[remembered] ? remembered : $('workflowSel').value);
    }
  }

  // ================================================================ source image (img2img)
  /** 來源圖放進左邊的來源卡（info＝{name, subfolder, type}，blob＝圖檔本身），回傳寬高 */
  async function setSourceImage(info, blob) {
    const previewUrl = URL.createObjectURL(blob);
    const dims = await new Promise(resolve => { const im = new Image(); im.onload = () => resolve({ width: im.naturalWidth, height: im.naturalHeight }); im.onerror = () => resolve({ width: 0, height: 0 }); im.src = previewUrl; });
    state.source = { name: info.name, subfolder: info.subfolder || '', type: info.type || 'input', ...dims, previewUrl };
    $('sourcePreview').src = previewUrl; $('sourcePreview').hidden = false;
    $('dropEmpty').hidden = true;
    $('sourceInfo').textContent = `${info.name} · ${dims.width}×${dims.height}`; $('sourceInfo').hidden = false;
    return dims;
  }
  function clearSourceImage() {
    state.source = null;
    $('sourcePreview').removeAttribute('src'); $('sourcePreview').hidden = true;
    $('dropEmpty').hidden = false; $('sourceInfo').hidden = true;
  }
  async function uploadFile(file, { keepMode = false } = {}) {
    if (!file || !file.type.startsWith('image/')) { toast('請選擇圖片檔', true); return; }
    const fd = new FormData();
    fd.append('image', file, file.name || `paste_${Date.now()}.png`);
    fd.append('subfolder', 'yomu');
    setStatus('上傳圖片中…');
    const res = await fetch('/upload/image', { method: 'POST', body: fd });
    if (!res.ok) { toast('上傳失敗', true); setStatus('就緒'); return; }
    const info = await res.json();
    const dims = await setSourceImage(info, file);
    const previewUrl = state.source.previewUrl;
    setStatus('就緒');
    if (state.mode === 'inpaint') { await HYInpaint.load(previewUrl, dims.width, dims.height); HYInpaint.show(true); }
    if (state.mode === 'img2video' && dims.width && dims.height) {   // 依來源比例，長邊 896、16 的倍數
      const [w, h] = fitSource(896); $('width').value = w; $('height').value = h;
      setVideoPresets(true); syncPreset();
    }
    else if (state.mode !== 'img2img' && !keepMode) switchMode('img2img');
  }
  // ---------------------------------------------------------------- 附屬圖片格（結尾圖 / 參考圖）
  const auxPath = (a) => (a.subfolder ? `${a.subfolder}/${a.name}` : a.name);
  async function uploadAux(target, file) {
    if (!file || !file.type.startsWith('image/')) { toast('請選擇圖片檔', true); return; }
    const fd = new FormData(); fd.append('image', file, file.name || `aux_${Date.now()}.png`); fd.append('subfolder', 'yomu');
    const res = await fetch('/upload/image', { method: 'POST', body: fd });
    if (!res.ok) { toast('上傳失敗', true); return; }
    setAuxImage(target, await res.json(), file);
  }
  function setAuxImage(target, info, blob) {
    const previewUrl = URL.createObjectURL(blob);
    state.aux[target] = { name: info.name, subfolder: info.subfolder || '', type: info.type || 'input', previewUrl };
    const dz = document.querySelector(`.mini-drop[data-target="${target}"]`);
    dz.querySelector('img').src = previewUrl; dz.querySelector('img').hidden = false; dz.querySelector('.dropzone-empty').hidden = true;
    const inf = dz.querySelector('.dropzone-info'); inf.textContent = info.name; inf.hidden = false;
  }
  function clearAuxImage(target) {
    state.aux[target] = null;
    const dz = document.querySelector(`.mini-drop[data-target="${target}"]`);
    dz.querySelector('img').removeAttribute('src'); dz.querySelector('img').hidden = true; dz.querySelector('.dropzone-empty').hidden = false;
    dz.querySelector('.dropzone-info').hidden = true;
  }
  /** 載入圖／影片的參數後，把當時的來源圖與結尾圖放回去；檔案還在 input 裡就帶入，不在就留白。回傳要提示的字 */
  async function restoreSources(p) {
    const fetchInput = async (name, subfolder) => {
      const r = name ? await fetch(viewUrl({ filename: name, subfolder, type: 'input' })).catch(() => null) : null;
      return r?.ok ? { blob: await r.blob(), subfolder } : null;
    };
    const notes = [];
    const src = p.source, found = await fetchInput(src?.name, src?.subfolder || '');
    if (found) {
      await setSourceImage({ name: src.name, subfolder: found.subfolder, type: 'input' }, found.blob);
      if (state.mode === 'inpaint') await HYInpaint.load(state.source.previewUrl, state.source.width, state.source.height);
      notes.push('來源圖已帶入');
    } else {
      clearSourceImage();
      if (src?.name) notes.push('來源圖的檔案已不在，留白');
    }
    const endName = (p.endImage || '').split('/').pop(), endSub = (p.endImage || '').includes('/') ? p.endImage.slice(0, p.endImage.lastIndexOf('/')) : '';
    const end = await fetchInput(endName, endSub);
    if (end) { setAuxImage('end', { name: endName, subfolder: end.subfolder, type: 'input' }, end.blob); notes.push('結尾圖已帶入'); }
    else clearAuxImage('end');
    return notes.join('、');
  }
  function setupMiniDrops() {
    document.querySelectorAll('.mini-drop').forEach(dz => {
      const target = dz.dataset.target, input = dz.querySelector('input[type=file]');
      dz.onclick = () => input.click();
      input.onchange = (e) => { uploadAux(target, e.target.files[0]); e.target.value = ''; };
      dz.ondragover = (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.add('over'); };
      dz.ondragleave = () => dz.classList.remove('over');
      dz.ondrop = async (e) => {
        e.preventDefault(); e.stopPropagation(); dz.classList.remove('over');
        const key = e.dataTransfer.getData('application/x-yomu-output');
        if (key) {
          const it = GV.items.find(x => x && `${x.subfolder}/${x.filename}` === key); if (!it || isVideoFile(it.filename)) return;
          const blob = await fetch(viewUrl({ filename: it.filename, subfolder: it.subfolder, type: 'output' })).then(r => r.blob());
          await uploadAux(target, new File([blob], it.filename, { type: blob.type || 'image/png' })); return;
        }
        uploadAux(target, e.dataTransfer.files[0]);
      };
    });
  }
  /** 圖庫的圖 → 當來源（拖到來源卡） */
  const isVideoFile = (name) => /\.(mp4|webm|mkv)$/i.test(name || '');
  /** 把 output 裡的圖當來源；影片則抓最後一格（可以接著動） */
  async function sourceFromOutput(it) {
    if (isVideoFile(it.filename)) {
      setStatus('抓影片最後一格…');
      const r = await fetch('/yomu/api/video-frame?' + new URLSearchParams({ filename: it.filename, subfolder: it.subfolder || '', which: 'last' }));
      if (!r.ok) { toast('抓不到影片畫面', true); setStatus(''); return; }
      const blob = await r.blob();
      await uploadFile(new File([blob], it.filename.replace(/\.\w+$/, '') + '_last.png', { type: 'image/png' }), { keepMode: true });
      toast('已用影片的最後一格當來源，可以接著動');
      return;
    }
    const url = viewUrl({ filename: it.filename, subfolder: it.subfolder, type: 'output' });
    const blob = await fetch(url).then(r => r.blob());
    await uploadFile(new File([blob], it.filename, { type: blob.type || 'image/png' }), { keepMode: true });
  }
  /** 遮罩工具列貼在預覽區上緣 */
  function positionMaskTools() {
    const t = $('maskTools'); if (t.hidden) return;
    const r = $('viewer').getBoundingClientRect();
    t.style.left = (r.left + 12) + 'px'; t.style.top = (r.top + 10) + 'px';
  }
  // ================================================================ layout: splitters / collapse
  function setupLayout() {
    const layout = $('layout');
    if (ui.fourStackW) layout.style.setProperty('--stack-w', ui.fourStackW + 'px');
    if (ui.fourPromptW) layout.style.setProperty('--prompt-w', ui.fourPromptW + 'px');

    const drag = (handle, axis, onMove, onEnd) => {
      handle.onmousedown = (e) => {
        e.preventDefault();
        handle.classList.add('drag'); document.body.classList.add('resizing', axis);
        const start = axis === 'col' ? e.clientX : e.clientY;
        const move = (ev) => onMove((axis === 'col' ? ev.clientX : ev.clientY) - start);
        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); handle.classList.remove('drag'); document.body.classList.remove('resizing', axis); onEnd(); };
        window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
      };
    };
    // 兩條都是左右拖曳：vsplit 調參數欄寬、psplit 調提示詞欄寬
    let stackW = 0, promptW = 0;
    $('vsplit').addEventListener('mousedown', () => { stackW = $('stack').getBoundingClientRect().width; });
    drag($('vsplit'), 'col',
      (dx) => layout.style.setProperty('--stack-w', Math.max(185, Math.min(window.innerWidth * .3, stackW + dx)) + 'px'),
      () => { ui.fourStackW = Math.round($('stack').getBoundingClientRect().width); lsSet(LS_UI, ui); });
    $('psplit').addEventListener('mousedown', () => { promptW = $('main').getBoundingClientRect().width; });
    drag($('psplit'), 'col',
      (dx) => layout.style.setProperty('--prompt-w', Math.max(220, Math.min(window.innerWidth * .43, promptW + dx)) + 'px'),
      () => { ui.fourPromptW = Math.round($('main').getBoundingClientRect().width); lsSet(LS_UI, ui); });
    // 圖庫欄：把手在它左邊，往左拖 = 變寬
    if (ui.galleryW) layout.style.setProperty('--gallery-w', ui.galleryW + 'px');
    let galleryW = 0;
    $('gsplit').addEventListener('mousedown', () => { galleryW = $('galleryView').getBoundingClientRect().width; });
    drag($('gsplit'), 'col',
      (dx) => layout.style.setProperty('--gallery-w', Math.max(95, Math.min(window.innerWidth * .45, galleryW - dx)) + 'px'),
      () => { ui.galleryW = Math.round($('galleryView').getBoundingClientRect().width); lsSet(LS_UI, ui); });

    // 卡片摺疊（記住狀態）
    ui.collapsed = ui.collapsed || {};
    document.querySelectorAll('.stack .card').forEach((card, i) => {
      const key = card.querySelector('.card-title')?.textContent || String(i);
      if (ui.collapsed[key] ?? card.classList.contains('addon')) card.classList.add('collapsed');
      const btn = card.querySelector('[data-collapse]');
      if (btn) {
        const head = card.querySelector('.card-head');
        btn.setAttribute('aria-expanded', String(!card.classList.contains('collapsed')));
        const setCollapsed = (v) => {
          card.classList.toggle('collapsed', v);
          ui.collapsed[key] = v;
          btn.setAttribute('aria-expanded', String(!v));
          lsSet(LS_UI, ui);
        };
        head.onclick = (e) => {
          if (e.target.closest('input, select, a, button:not([data-collapse])')) return;
          setCollapsed(!card.classList.contains('collapsed'));
        };
      }
    });
    // 點進哪張卡片，那張的框是 ▾；點到別處就變 ✓（卡片維持開著，可以同時開很多張）
    document.addEventListener('pointerdown', (e) => {
      document.querySelectorAll('.stack .card').forEach(card => card.classList.toggle('active', card.contains(e.target)));
    });

    // 卡片順序：拖標題列排序（記住順序）
    const scroll = document.querySelector('.stack-scroll');
    const cards = () => [...scroll.querySelectorAll(':scope > .card')];
    const cardKey = (card) => card.querySelector('.card-title')?.textContent;
    const defaultOrder = cards().map(cardKey);
    const applyOrder = (order) => {
      for (const k of order || defaultOrder) { const c = cards().find(c => cardKey(c) === k); if (c) scroll.appendChild(c); }
    };
    applyOrder(ui.order);
    let dragCard = null;
    cards().forEach(card => {
      const head = card.querySelector('.card-head');
      head.draggable = true;
      head.ondragstart = (e) => { dragCard = card; e.dataTransfer.setData('text/x-yomu-card', cardKey(card)); e.dataTransfer.effectAllowed = 'move'; card.classList.add('dragging'); };
      head.ondragend = () => { dragCard = null; card.classList.remove('dragging'); ui.order = cards().map(cardKey); lsSet(LS_UI, ui); };
    });
    scroll.ondragover = (e) => {
      if (!dragCard) return;
      e.preventDefault();
      const over = e.target.closest('.card');
      if (!over || over === dragCard) return;
      const r = over.getBoundingClientRect();
      scroll.insertBefore(dragCard, e.clientY > r.top + r.height / 2 ? over.nextSibling : over);
    };

    // ---- 版面：預設 / 自訂（欄寬 + 卡片摺疊 + 卡片順序）
    const applyCollapsed = () => {
      document.querySelectorAll('.stack .card').forEach((card, i) => {
        const key = card.querySelector('.card-title')?.textContent || String(i);
        card.classList.toggle('collapsed', !!(ui.collapsed[key] ?? card.classList.contains('addon')));
        card.querySelector('[data-collapse]')?.setAttribute('aria-expanded', String(!card.classList.contains('collapsed')));
      });
    };
    const applyWidths = () => {
      for (const [k, v] of [['fourStackW', '--stack-w'], ['fourPromptW', '--prompt-w'], ['galleryW', '--gallery-w']]) {
        if (ui[k]) layout.style.setProperty(v, ui[k] + 'px'); else layout.style.removeProperty(v);
      }
    };
    const layoutDefault = () => {
      for (const k of ['fourStackW', 'fourPromptW', 'galleryW']) delete ui[k];
      ui.collapsed = {};
      delete ui.order;
      applyWidths(); applyCollapsed(); applyOrder(); lsSet(LS_UI, ui);
      toast('已回到預設版面');
    };
    const layoutSave = () => {
      ui.custom = {
        fourStackW: Math.round($('stack').getBoundingClientRect().width),
        fourPromptW: Math.round($('main').getBoundingClientRect().width),
        galleryW: Math.round($('galleryView').getBoundingClientRect().width),
        collapsed: { ...ui.collapsed },
        order: cards().map(cardKey),
      };
      lsSet(LS_UI, ui);
      toast('已存成自訂版面');
    };
    const layoutApply = () => {
      if (!ui.custom) { toast('還沒有存過自訂版面', true); return; }
      Object.assign(ui, { fourStackW: ui.custom.fourStackW, fourPromptW: ui.custom.fourPromptW, galleryW: ui.custom.galleryW, collapsed: { ...ui.custom.collapsed }, order: ui.custom.order });
      applyWidths(); applyCollapsed(); applyOrder(ui.order); lsSet(LS_UI, ui);
      toast('已套用自訂版面');
    };
    const menu = $('layoutMenu');
    $('btnLayout').onclick = (e) => {
      e.stopPropagation();
      const r = $('btnLayout').getBoundingClientRect();
      menu.hidden = false;
      menu.style.left = Math.min(r.left, innerWidth - menu.offsetWidth - 6) + 'px';
      menu.style.top = (r.bottom + 4) + 'px';
    };
    document.addEventListener('pointerdown', (e) => { if (!menu.contains(e.target) && e.target !== $('btnLayout')) menu.hidden = true; });
    menu.addEventListener('click', () => { menu.hidden = true; });
    $('btnLayoutDefault').onclick = layoutDefault;
    $('btnLayoutSave').onclick = layoutSave;
    $('btnLayoutApply').onclick = layoutApply;
  }

  // ================================================================ 提示詞著色
  const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function highlight(text) {
    return text.split('\n').map(line => {
      const i = line.indexOf('#');
      const code = i >= 0 ? line.slice(0, i) : line, cmt = i >= 0 ? line.slice(i) : '';
      let html = escHtml(code)
        .replace(/embedding:[^\s,()<>&]+/gi, m => `<span class="tk-emb">${m}</span>`)
        .replace(/\{隨機(?:角色|姿勢)\}/g, m => `<span class="tk-wc">${m}</span>`)
        .replace(/&lt;lora:[^&]*?&gt;/gi, m => `<span class="tk-lora">${m}</span>`)
        .replace(/(:)(\d+(?:\.\d+)?)(?=\))/g, '$1<span class="tk-w">$2</span>')
;
      if (cmt) html += `<span class="tk-cmt">${escHtml(cmt)}</span>`;
      return html;
    }).join('\n') + '​';
  }
  function syncHl(id) {
    const ta = $(id), pre = $(id + 'Hl'); if (!pre) return;
    pre.innerHTML = highlight(ta.value);
    // 在最後面打字／換行：瀏覽器只會捲到游標那一行，底部留白會被切掉一截，所以直接捲到底
    if (document.activeElement === ta && ta.selectionStart === ta.value.length) ta.scrollTop = ta.scrollHeight;
    pre.scrollTop = ta.scrollTop;
  }
  function hlAll() { syncHl('pos'); syncHl('neg'); }
  function setupHighlight() {
    for (const id of ['pos', 'neg']) {
      const ta = $(id);
      ta.addEventListener('input', () => syncHl(id));
      ta.addEventListener('scroll', () => { $(id + 'Hl').scrollTop = ta.scrollTop; });
    }
    hlAll();
  }

  /** Ctrl+← / → 照 VS Code 跳字：行首往前跳到上一行行尾、行尾往後跳到下一行（瀏覽器的 textarea 不會跨行）；Shift 一起選取 */
  function setupWordJump() {
    const isWord = (c) => /[\p{L}\p{N}_]/u.test(c);
    const isSpace = (c) => c === ' ' || c === '\t';
    const jump = (v, i, dir) => {
      const at = (k) => v[dir < 0 ? k - 1 : k];
      const inside = (k) => (dir < 0 ? k > 0 : k < v.length);
      if (inside(i) && at(i) === '\n') return i + dir;
      while (inside(i) && isSpace(at(i))) i += dir;
      const kind = inside(i) && isWord(at(i));
      while (inside(i) && at(i) !== '\n' && !isSpace(at(i)) && isWord(at(i)) === kind) i += dir;
      return i;
    };
    for (const id of ['pos', 'neg']) {
      $(id).addEventListener('keydown', (e) => {
        if (!e.ctrlKey || e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
        e.preventDefault();
        const ta = e.target, dir = e.key === 'ArrowLeft' ? -1 : 1;
        const back = ta.selectionDirection === 'backward';
        const focus = back ? ta.selectionStart : ta.selectionEnd, anchor = back ? ta.selectionEnd : ta.selectionStart;
        const to = jump(ta.value, focus, dir);
        if (!e.shiftKey) ta.setSelectionRange(to, to);
        else ta.setSelectionRange(Math.min(anchor, to), Math.max(anchor, to), to < anchor ? 'backward' : 'forward');
      });
    }
  }

  // ================================================================ 自動補完
  function setupAutocomplete(taId, popupId) {
    const ta = $(taId), popup = $(popupId), wrap = ta.closest('.ac-wrap');
    let matches = [], sel = 0, timer = null, wordStart = 0, pending = '', applyOnLoad = false;
    let picking = false;   // 按 ↓ 進到清單裡才算在選；沒進清單時 Enter 是換行、↑ 是往上一行，只有 Tab 補完
    // 鏡像層：跟 textarea 同字體同排版，用來量「正在打的字」在哪個位置
    const mirror = document.createElement('pre');
    mirror.className = 'hl ac-mirror'; mirror.setAttribute('aria-hidden', 'true');
    ta.parentElement.appendChild(mirror);
    const close = () => { popup.hidden = true; matches = []; pending = ''; applyOnLoad = false; picking = false; };
    /** 把清單放到游標那個字的正下方；下面塞不下就放上方 */
    const positionPopup = () => {
      mirror.innerHTML = escHtml(ta.value.slice(0, wordStart)) + '<span class="cm">\u200b</span>';
      const mark = mirror.querySelector('.cm');
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
      const caretTop = mark.offsetTop - ta.scrollTop, caretLeft = mark.offsetLeft;
      const edRect = ta.getBoundingClientRect(), wrapRect = wrap.getBoundingClientRect();
      const bound = (ta.closest('.card-body') || wrap).getBoundingClientRect();
      const ph = popup.offsetHeight, pw = popup.offsetWidth;
      popup.style.left = Math.max(0, Math.min(caretLeft, wrap.clientWidth - pw)) + 'px';
      popup.style.top = popup.style.bottom = '';
      const belowY = edRect.top + caretTop + lh + 4;              // 螢幕座標：字的下緣
      const spaceBelow = bound.bottom - belowY, spaceAbove = (edRect.top + caretTop) - bound.top - 4;
      if (spaceBelow >= Math.min(ph, 140) || spaceBelow >= spaceAbove) {
        popup.style.top = (belowY - wrapRect.top) + 'px';
        popup.style.maxHeight = Math.max(80, Math.min(260, spaceBelow - 4)) + 'px';
      } else {
        popup.style.bottom = (wrapRect.bottom - (edRect.top + caretTop) + 4) + 'px';
        popup.style.maxHeight = Math.max(80, Math.min(260, spaceAbove)) + 'px';
      }
    };
    const render = () => {
      popup.innerHTML = '';
      matches.forEach((m, i) => {
        const row = document.createElement('div');
        row.className = 'ac-item' + (picking && i === sel ? ' sel' : '');
        const left = document.createElement('span'); left.className = 'cat-' + m.cat; left.textContent = m.tag.replace(/_/g, ' ');
        if (m.alias) { const a = document.createElement('span'); a.className = 'alias'; a.textContent = `← ${m.alias}`; left.appendChild(a); }
        const cnt = document.createElement('span'); cnt.className = 'cnt' + (m.emb ? ' emb' : '');
        cnt.textContent = m.emb ? 'embedding' : (m.count >= 1000 ? (m.count / 1000).toFixed(0) + 'k' : m.count);
        row.append(left, cnt);
        row.onmousedown = (e) => { e.preventDefault(); apply(m.tag, m.emb); };
        popup.appendChild(row);
      });
      popup.hidden = matches.length === 0;
      if (!popup.hidden) { positionPopup(); popup.children[sel]?.scrollIntoView({ block: 'nearest' }); }
    };
    const apply = (tag, isEmb = false) => {
      const text = isEmb ? tag : tag.replace(/_/g, ' ').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
      const before = ta.value.slice(0, wordStart), after = ta.value.slice(ta.selectionStart);
      const insert = text + ', ';
      const stripped = after.match(/^,?[ \t]*/)[0].length;
      replaceRange(ta, wordStart, ta.selectionStart + stripped, insert);
      ta.selectionStart = ta.selectionEnd = (before + insert).length;
      syncHl(taId); close();
    };
    ta.addEventListener('input', () => {
      clearTimeout(timer);
      const cur = ta.selectionStart, head = ta.value.slice(0, cur);
      const lineStart = head.lastIndexOf('\n') + 1;
      if (head.slice(lineStart).trimStart().startsWith('#')) return close();
      const m = head.match(/(?:^|,|\n|\()\s*([^,\n()#]{2,})$/);   // __xx 也會被抓到
      if (!m) return close();
      wordStart = cur - m[1].length;
      const q = m[1].trim();
      pending = q;
      timer = setTimeout(() => runSearch(q), 90);
    });
    async function runSearch(q) {
      const ql = q.toLowerCase();
      const embs = ql.startsWith('emb')
        ? state.embeddings.filter(e => ('embedding:' + e).toLowerCase().includes(ql.replace(/^embedding:?/, ''))).map(e => ({ tag: 'embedding:' + e, cat: 'emb', count: 'emb', emb: true }))
        : [];
      let tags = [];
      try { tags = await fetch('/yomu/api/tags?q=' + encodeURIComponent(q) + '&limit=12').then(r => r.json()); } catch {}
      if (pending !== q) return;                 // 已經又打了別的字
      matches = [...embs, ...tags].slice(0, 14);
      sel = 0; picking = false; render();
      if (applyOnLoad && matches.length) { applyOnLoad = false; apply(matches[0].tag, matches[0].emb); }
      applyOnLoad = false;
    }
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && popup.hidden) {
        // 清單還沒出來就按 Tab：不要跳到下一個欄位；有字在等查詢就立刻查、查到就套第一個
        e.preventDefault();
        if (pending) { clearTimeout(timer); applyOnLoad = true; runSearch(pending); }
        return;
      }
      if (popup.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = picking ? (sel + 1) % matches.length : 0; picking = true; render(); }
      else if (e.key === 'ArrowUp' && picking) { e.preventDefault(); sel = (sel - 1 + matches.length) % matches.length; render(); }
      else if (e.key === 'Tab' || (e.key === 'Enter' && picking && !e.ctrlKey)) { e.preventDefault(); apply(matches[sel].tag, matches[sel].emb); }
      else if (['Escape', 'Enter', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) close();   // 照原本的意思換行 / 移游標，清單收起來
    });
    ta.addEventListener('mousedown', close);
    ta.addEventListener('blur', () => setTimeout(close, 120));
    ta.addEventListener('scroll', () => { if (!popup.hidden) positionPopup(); });
  }

  // ================================================================ 圖庫（虛擬捲動）
  const GV = { open: false, items: [], total: 0, q: '', cell: 190, gap: 8, cols: 1, pages: new Set(), loading: new Set(), nodes: new Map(), active: null, seq: 0, lastLoad: 0 };
  const GV_PAGE = 200;
  const thumbUrl = (it, size) => `/yomu/api/thumb?filename=${encodeURIComponent(it.filename)}&subfolder=${encodeURIComponent(it.subfolder)}&size=${size}&v=${it.mtime}-${it.size}`;   // 檔名被重用時（刪圖後編號重來）不會吃到舊快取

  function openGallery() {
    GV.open = true; $('galleryView').hidden = false;
    if (Date.now() - GV.lastLoad > 30000) gvLoad(true); else gvLayout();
  }
  async function gvLoad(refresh = false) {
    const seq = ++GV.seq;
    GV.items = []; GV.pages.clear(); GV.loading.clear(); GV.nodes.forEach(n => n.remove()); GV.nodes.clear();
    $('gvCount').textContent = '讀取中…';
    await gvFetchPage(0, refresh, seq);
    if (seq === GV.seq) { GV.lastLoad = Date.now(); gvLayout(); }
  }
  async function gvFetchPage(page, refresh = false, seq = GV.seq) {
    if (GV.pages.has(page) || GV.loading.has(page)) return;
    GV.loading.add(page);
    try {
      const r = await fetch(`/yomu/api/gallery?offset=${page * GV_PAGE}&limit=${GV_PAGE}&q=${encodeURIComponent(GV.q)}${refresh ? '&refresh=1' : ''}`).then(r => r.json());
      if (seq !== GV.seq) return;
      GV.total = r.total;
      r.items.forEach((it, i) => { GV.items[page * GV_PAGE + i] = it; });
      GV.pages.add(page);
      $('gvCount').textContent = `${GV.total.toLocaleString()} 張`;
      $('sbGallery').textContent = `圖庫 ${GV.total.toLocaleString()} 張`;
      gvLayout();
    } catch { $('gvCount').textContent = '讀取失敗'; }
    finally { GV.loading.delete(page); }
  }
  function gvLayout() {
    const sc = $('gvScroll');
    GV.cell = Math.max(60, sc.clientWidth - 16);
    const step = Math.round(GV.cell * 16 / 9) + GV.gap;
    GV.cols = 1;
    $('gvSpacer').style.height = Math.max(1, Math.ceil(GV.total / GV.cols) * step) + 'px';
    gvRender();
  }
  function gvRender() {
    const sc = $('gvScroll'), cells = $('gvCells'), step = Math.round(GV.cell * 16 / 9) + GV.gap;
    const firstRow = Math.max(0, Math.floor(sc.scrollTop / step) - 1);
    const lastRow = Math.ceil((sc.scrollTop + sc.clientHeight) / step) + 1;
    const start = firstRow * GV.cols, end = Math.min(GV.total, (lastRow + 1) * GV.cols);
    const keep = new Set();
    const padX = 8;
    for (let i = start; i < end; i++) {
      keep.add(i);
      const page = Math.floor(i / GV_PAGE);
      if (!GV.pages.has(page)) { gvFetchPage(page); continue; }
      const it = GV.items[i]; if (!it) continue;
      let el = GV.nodes.get(i);
      if (!el) {
        el = document.createElement('div'); el.className = 'gv-cell';
        const im = document.createElement('img'); im.loading = 'lazy'; im.decoding = 'async';
        im.onload = () => im.classList.add('ok');
        // 縮圖解析度跟著格子實際大小與螢幕 DPR 走（直圖長邊是高），上限 768
        im.src = thumbUrl(it, Math.min(1024, Math.ceil(Math.max(GV.cell, GV.cell * 16 / 9) * (window.devicePixelRatio || 1) / 256) * 256));
        im.addEventListener('dragstart', (e) => {
          e.dataTransfer.clearData();
          e.dataTransfer.setData('application/x-yomu-output', `${it.subfolder}/${it.filename}`);
          e.dataTransfer.setData('text/uri-list', new URL(viewUrl({ ...it, type: 'output' }), location.href).href);
          e.dataTransfer.effectAllowed = 'copy';
        });
        const cap = document.createElement('div'); cap.className = 'cap'; cap.textContent = it.filename;
        el.append(im, cap);
        if (/\.(mp4|webm|mkv)$/i.test(it.filename)) { const pl = document.createElement('span'); pl.className = 'play'; pl.textContent = '▶'; el.appendChild(pl); }
        el.onclick = () => {
          const u = viewUrl({ ...it, type: 'output' }), isV = /\.(mp4|webm|mkv)$/i.test(it.filename);
          $('fullImage').hidden = isV; $('fullVideo').hidden = !isV;
          if (isV) $('fullVideo').src = u; else { $('fullVideo').removeAttribute('src'); }
          $('fullImage').src = isV ? '' : u;
          $('fullCaption').textContent = `${it.subfolder ? it.subfolder + ' / ' : ''}${it.filename}   ·   ${new Date(it.mtime * 1000).toLocaleString()}`;
          $('imageOverlay').hidden = false;
        };
        el.oncontextmenu = (e) => {
          e.preventDefault();
          menuImage = { url: viewUrl({ ...it, type: 'output' }), filename: it.filename, subfolder: it.subfolder || '' };
          $('btnAnimate').hidden = false;
          $('btnOpen').href = menuImage.url;
          const menu = $('imageMenu');
          menu.hidden = false;
          menu.style.left = Math.max(0, Math.min(e.clientX, innerWidth - menu.offsetWidth - 6)) + 'px';
          menu.style.top = Math.max(0, Math.min(e.clientY, innerHeight - menu.offsetHeight - 6)) + 'px';
        };
        cells.appendChild(el); GV.nodes.set(i, el);
      }
      const r = Math.floor(i / GV.cols), c = i % GV.cols;
      el.style.transform = `translate(${padX + c * step}px, ${r * step}px)`;
      el.style.width = GV.cell + 'px';
      el.style.height = (step - GV.gap) + 'px';
      el.classList.toggle('active', GV.active === `${it.subfolder}/${it.filename}`);
    }
    for (const [i, el] of GV.nodes) if (!keep.has(i)) { el.remove(); GV.nodes.delete(i); }
    let empty = cells.querySelector('.gv-empty');
    if (GV.total === 0 && GV.pages.size) { if (!empty) { empty = document.createElement('div'); empty.className = 'gv-empty'; empty.textContent = GV.q ? '沒有符合的圖片' : 'output 資料夾裡還沒有圖片'; cells.appendChild(empty); } }
    else if (empty) empty.remove();
  }
  async function gvSelect(it, el, loadParams = false) {
    GV.active = `${it.subfolder}/${it.filename}`;
    document.querySelectorAll('.gv-cell.active').forEach(x => x.classList.remove('active'));
    if (el) el.classList.add('active');
    const url = viewUrl({ filename: it.filename, subfolder: it.subfolder, type: 'output' });
    const item = { id: 'gv-' + GV.active, ts: it.mtime * 1000, mode: 'txt2img', params: {}, images: [{ url, filename: it.filename, subfolder: it.subfolder }] };
    state.current = { item, idx: 0 };
    showImage(url); $('btnOpen').href = url;
    $('metaBar').textContent = `${it.filename} · 讀取參數中…`;
    try {
      const chunks = await fetch(`/yomu/api/pnginfo?filename=${encodeURIComponent(it.filename)}&subfolder=${encodeURIComponent(it.subfolder)}`).then(r => r.json());
      let raw = PngInfo.parseParams(chunks);
      if (isVideoFile(it.filename) && raw?.origin !== 'yomu') raw = null;
      if (!raw) { $('metaBar').textContent = `${it.filename} · 沒有可讀的參數`; return; }
      const pos = PngInfo.extractLoras(raw.pos), neg = PngInfo.extractLoras(raw.neg);
      const p = { ...raw, pos: pos.text, neg: neg.text, loras: raw.loras?.length ? raw.loras : pos.loras };
      if (raw.origin !== 'yomu') p.mode = 'txt2img';
      item.params = p; item.mode = p.mode;
      if (state.current?.item === item) { renderMeta(p, item); if (loadParams) { const missing = applyParams(await resolveModelHash(p)); const restored = await restoreSources(p); toast('已載入參數' + (restored ? '；' + restored : '')); showMissing(missing); } }
    } catch { $('metaBar').textContent = it.filename; }
  }
  function setupGallery() {
    const sc = $('gvScroll');
    let raf = null;
    sc.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(() => { raf = null; gvRender(); }); });
    new ResizeObserver(() => { if (GV.open) gvLayout(); }).observe(sc);
    $('gvRefresh').onclick = () => gvLoad(true);
    let t = null;
    $('gvSearch').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { GV.q = $('gvSearch').value.trim(); gvLoad(false); }, 250); });
  }

  // ================================================================ 燈箱
  function setupImageMenu() {
    const menu = $('imageMenu');
    const close = () => { menu.hidden = true; menuImage = null; };
    $('mainImage').addEventListener('contextmenu', (e) => e.preventDefault());
    closeOnBackdrop($('imageOverlay'), () => { $('imageOverlay').hidden = true; });
    menu.addEventListener('click', close);
    document.addEventListener('pointerdown', (e) => { if (!menu.contains(e.target)) close(); });
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { close(); $('assetModal').hidden = true; $('imageOverlay').hidden = true; }
    });
  }

  function setupPreviewZoom() {
    const viewer = $('viewer'), img = $('mainImage');
    let scale = 1, x = 0, y = 0;
    const render = () => {
      img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
      img.style.cursor = 'default';
      $('btnFitImage').textContent = `${Math.round(scale * 100)}% · 適合視窗`;
    };
    const reset = () => { scale = 1; x = y = 0; render(); };
    img.draggable = false;
    img.addEventListener('load', reset);
    viewer.addEventListener('wheel', (e) => {
      if (img.hidden || !img.naturalWidth) return;
      e.preventDefault();
      const rect = viewer.getBoundingClientRect();
      const px = e.clientX - rect.left - rect.width / 2;
      const py = e.clientY - rect.top - rect.height / 2;
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1);
      const next = Math.max(1, Math.min(10, scale * Math.exp(-delta * .0015)));
      x = px - (px - x) * next / scale;
      y = py - (py - y) * next / scale;
      scale = next;
      if (scale === 1) x = y = 0;
      render();
    }, { passive: false });
    $('btnFitImage').onclick = reset;
    new ResizeObserver(reset).observe(viewer);
  }

  // ================================================================ Civitai 抓圖 / 更新 ComfyUI
  function setupCivitai() {
    let timer = null;
    const poll = async () => {
      const s = await fetch('/yomu/api/civitai/status').then(r => r.json());
      if (s.running) $('civitaiState').textContent = `${s.done}/${s.total} · ${s.current}`;
      else {
        clearInterval(timer); timer = null;
        $('btnCivitai').disabled = false;
        const got = s.results.filter(r => r.status === '已下載').length;
        const miss = s.results.filter(r => r.status.includes('沒有')).length;
        $('civitaiState').textContent = s.total ? `完成：下載 ${got} 張，Civitai 找不到 ${miss} 個` : '沒有需要補的';
        await loadModels(); renderAssets(); updateCkptPreview();
        document.querySelectorAll('.lora-row').forEach(r => r._refresh());
      }
    };
    $('btnCivitai').onclick = async () => {
      const r = await fetch('/yomu/api/civitai/fetch', { method: 'POST' }).then(r => r.json());
      if (!r.ok) { toast(r.msg, true); return; }
      $('btnCivitai').disabled = true; $('civitaiState').textContent = '開始…';
      if (!timer) timer = setInterval(poll, 1200);
    };
    fetch('/yomu/api/civitai/status').then(r => r.json()).then(s => { if (s.running) { $('btnCivitai').disabled = true; timer = setInterval(poll, 1200); } }).catch(() => {});
  }

  // ================================================================ bindings
  function bind() {
    $('btnDeleteImage').onclick = async () => {
      const image = menuImage;
      if (!image) return;
      if (!confirm(`把「${image.filename}」移到資源回收筒？`)) return;
      try {
        let done = false;
        if (window.yomuDesktop?.trashImage) { try { await window.yomuDesktop.trashImage(new URL(image.url, location.href).href); done = true; } catch {} }
        if (!done) {
          const u = new URL(image.url, location.href);
          const r = await fetch('/yomu/api/image-delete?' + new URLSearchParams({ filename: u.searchParams.get('filename') || image.filename, subfolder: u.searchParams.get('subfolder') || image.subfolder || '' }), { method: 'POST' }).then(r => r.json());
          if (!r.ok) throw new Error(r.msg || '刪除失敗');
        }
        state.history = state.history.map(item => ({ ...item, images: item.images.filter(im => im.url !== image.url) })).filter(item => item.images.length);
        lsSet(LS_HISTORY, state.history);
        if (state.current?.item.images[state.current.idx]?.url === image.url) {
          state.current = null;
          $('mainImage').hidden = true; $('mainImage').removeAttribute('src');
          $('viewerEmpty').hidden = false; $('viewerTools').hidden = true;
          $('metaBar').textContent = '';
        }
        await gvLoad(true);
        toast('已移到資源回收筒：' + image.filename);
      } catch (e) { toast('刪除失敗：' + e.message, true); }
    };
    const THEMES = [['dark', '主題：深色'], ['sakura', '主題：櫻粉'], ['moon', '主題：月夜']];
    const setTheme = (theme) => {
      if (!THEMES.some(([k]) => k === theme)) theme = 'dark';
      document.documentElement.dataset.theme = theme;
      $('btnTheme').textContent = THEMES.find(([k]) => k === theme)[1];
      lsSet('inference.theme', theme);
    };
    setTheme(lsGet('inference.theme', 'dark'));
    $('btnTheme').onclick = () => {
      const i = THEMES.findIndex(([k]) => k === document.documentElement.dataset.theme);
      setTheme(THEMES[(i + 1) % THEMES.length][0]);
    };
    $('btnShowFolder').onclick = async () => {
      if (!menuImage && !state.current) return;
      const image = menuImage || state.current.item.images[state.current.idx];
      try {
        if (window.yomuDesktop) await window.yomuDesktop.revealImage(new URL(image.url, location.href).href);
        else {   // 沒裝 Electron（Edge App 視窗）：請 ComfyUI 那邊開檔案總管
          const u = new URL(image.url, location.href);
          const r = await fetch('/yomu/api/image-reveal?' + new URLSearchParams({ filename: u.searchParams.get('filename') || image.filename, subfolder: u.searchParams.get('subfolder') || image.subfolder || '' }), { method: 'POST' }).then(r => r.json());
          if (!r.ok) throw new Error(r.msg);
        }
      } catch (e) { toast('無法開啟資料夾：' + e.message, true); }
    };
    $('btnGenerate').onclick = generate;
    $('btnModelsDir').onclick = async () => {
      const r = await fetch('/yomu/api/open-models', { method: 'POST' }).catch(() => null);
      if (!r?.ok) toast('開不了資料夾：請確認 ComfyUI 已重新啟動到最新版', true);
    };
    $('ckpt').onchange = updateCkptPreview;
    $('workflowSel').onchange = () => applyTemplate($('workflowSel').value);
    state.compatOnly = lsGet(LS_UI + '.compatOnly', true); $('compatOnly').checked = state.compatOnly;
    $('compatOnly').onchange = () => { state.compatOnly = $('compatOnly').checked; lsSet(LS_UI + '.compatOnly', state.compatOnly); fillCkptSelect(); renderAssets(); updateCkptPreview(); };
    $('btnSwap').onclick = () => { const w = $('width').value; $('width').value = $('height').value; $('height').value = w; syncPreset(); };
    $('presetSel').onchange = () => { const v = $('presetSel').value; if (v === 'custom') return; const [w, h] = v.split('x'); $('width').value = w; $('height').value = h; syncHires(); };
    $('width').oninput = syncPreset; $('height').oninput = syncPreset;
    $('width').onchange = snapSize; $('height').onchange = snapSize;   // 打完數字才對齊，打字途中不跳
    $('frames').oninput = () => setVideoPresets(state.mode === 'txt2video');
    const sbModel = () => { $('sbModel').textContent = `${PngInfo.baseName($('ckpt').value) || '未選模型'} · ${$('width').value}×${$('height').value} · ${$('steps').value}步 · CFG ${$('cfgVal').textContent}`; };
    $('stack').addEventListener('input', sbModel); $('stack').addEventListener('change', sbModel); setTimeout(sbModel, 1500);
    $('btnRandomSeed').onclick = () => { $('seed').value = randomSeed(); };
    $('btnLastSeed').onclick = () => { if (state.lastSeed != null) { $('seed').value = state.lastSeed; $('lockSeed').checked = true; } };
    $('btnSave').onclick = saveCurrentImage;
    $('btnAnimate').onclick = async () => {
      $('imageMenu').hidden = true;
      const im = menuImage || state.current?.item.images[state.current.idx];
      if (!im) { toast('先選一張圖', true); return; }
      switchMode('img2video');
      if (isVideoFile(im.filename)) { await sourceFromOutput({ filename: im.filename, subfolder: im.subfolder || '' }); return; }
      const blob = await fetch(im.url).then(r => r.blob());
      await uploadFile(new File([blob], im.filename || 'source.png', { type: blob.type || 'image/png' }), { keepMode: true });
      toast('圖已放進圖生影片，寫一句想要的動作再按生成');
    };
    $('steps').oninput = () => ($('stepsVal').textContent = $('steps').value);
    $('cfg').oninput = () => ($('cfgVal').textContent = fmt($('cfg').value));
    $('denoise').oninput = () => ($('denoiseVal').textContent = Number($('denoise').value).toFixed(2));
    $('hiresOn').onchange = syncHires;
    $('hiresScale').oninput = () => { $('hiresScaleVal').textContent = fmt($('hiresScale').value, 2); syncHires(); };
    $('hiresSteps').oninput = () => ($('hiresStepsVal').textContent = $('hiresSteps').value);
    $('hiresDenoise').oninput = () => ($('hiresDenoiseVal').textContent = Number($('hiresDenoise').value).toFixed(2));
    $('modeTabs').onclick = (e) => { const b = e.target.closest('.tab'); if (b) switchMode(b.dataset.mode); };

    // 來源圖：點擊 / 拖到 dropzone / 貼上
    const dz = $('dropzone');
    dz.onclick = () => $('fileInput').click();
    $('fileInput').onchange = (e) => uploadFile(e.target.files[0]);
    dz.ondragover = (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.add('over'); };
    dz.ondragleave = () => dz.classList.remove('over');
    dz.ondrop = async (e) => {
      e.preventDefault(); e.stopPropagation(); dz.classList.remove('over');
      const key = e.dataTransfer.getData('application/x-yomu-output');
      if (key) { const it = GV.items.find(x => x && `${x.subfolder}/${x.filename}` === key); if (it) await sourceFromOutput(it); return; }
      uploadFile(e.dataTransfer.files[0]);
    };
    $('btnEditMask').onclick = () => { if (state.source) HYInpaint.show(true); };
    setupMiniDrops();
    $('btnResultAsSource').onclick = async () => {
      if (!state.current) return;
      const im = state.current.item.images[state.current.idx];
      const blob = await fetch(im.url).then(r => r.blob());
      await uploadFile(new File([blob], im.filename, { type: blob.type || 'image/png' }), { keepMode: true });
      toast('已把結果當成來源');
    };
    window.addEventListener('resize', positionMaskTools);
    window.addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/')); if (f) { e.preventDefault(); uploadFile(f); } });
    // 拖 PNG 到畫面任何位置 → 顯示並讀參數（各個 dropzone 自己處理的不會冒泡到這裡）
    const dropAll = $('dropAll');
    let dragDepth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; dropAll.hidden = false; } });
    window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; dropAll.hidden = true; } });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', () => { dragDepth = 0; dropAll.hidden = true; }, true);   // dropzone 會擋冒泡，所以在捕獲階段收遮罩
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const key = e.dataTransfer.getData('application/x-yomu-output');
      const f = e.dataTransfer.files[0];
      if (!key && !f) return;
      if (document.querySelector('.modal:not([hidden])')) return;
      if (key) {
        const item = GV.items.find(it => it && `${it.subfolder}/${it.filename}` === key);
        if (!item) return;
        gvSelect(item, null, true);
        return;
      }
      loadParamsFromFile(f);
    });
    $('btnCloseMissing').onclick = () => { $('missingModal').hidden = true; };
    closeOnBackdrop($('missingModal'), () => { $('missingModal').hidden = true; });

    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (!state.pending.size) generate(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveCurrentImage(); }
    });
    window.addEventListener('beforeunload', saveParams);
  }

  // ================================================================ init
  /** 取代 prompt()：頁內小輸入框，回傳 Promise<string|null>；buttons 可加「刪除」 */
  function askText({ title, value = '', placeholder = '', okText = '確定', danger = null }) {
    return new Promise(resolve => {
      const box = document.createElement('div'); box.className = 'ask';
      box.innerHTML = `<div class="ask-box"><div class="ask-title"></div><input type="text"><div class="ask-btns"><button class="tbtn" data-ok></button>${danger ? '<button class="tbtn ask-danger" data-danger></button>' : ''}<button class="tbtn" data-cancel>取消</button></div></div>`;
      box.querySelector('.ask-title').textContent = title;
      const inp = box.querySelector('input'); inp.value = value; inp.placeholder = placeholder;
      box.querySelector('[data-ok]').textContent = okText;
      if (danger) box.querySelector('[data-danger]').textContent = danger;
      const done = (v) => { box.remove(); resolve(v); };
      box.querySelector('[data-ok]').onclick = () => done(inp.value);
      box.querySelector('[data-cancel]').onclick = () => done(null);
      if (danger) box.querySelector('[data-danger]').onclick = () => done({ danger: true });
      closeOnBackdrop(box, () => done(null));
      inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value); if (e.key === 'Escape') done(null); };
      document.body.appendChild(box); inp.focus(); inp.select();
    });
  }
  window.HY = { askText, closeOnBackdrop, setText, replaceRange, hasPart, removePart, insertPart, positionMaskTools, toast, loadModels, renderAssets, compatFamilies: (...a) => compatFamilies(...a), state, lsGet, lsSet };
  (async () => {
    bind();
    setupLayout();
    setupAddons();
    setupHighlight();
    setupWordJump();
    setupAutocomplete('pos', 'acPopup');
    setupAutocomplete('neg', 'acPopupNeg');
    setupAssets();
    setupCivitai();
    setupGallery();
    openGallery();
    setupImageMenu();
    setupPreviewZoom();
    connectWs();
    state.history = lsGet(LS_HISTORY, []);
    try {
      await Promise.all([loadModels(), loadTemplates()]);
      restoreParams();
      switchMode(state.mode);
      syncPreset();
    } catch (e) { toast('初始化失敗：' + e.message, true); }
  })();
})();
