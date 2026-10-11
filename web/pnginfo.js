/* 從 PNG 的文字區塊讀出生圖參數。
 * 支援：Yomu 自己存的 yomu、Stability Matrix (parameters-json + smproj)、
 *       ComfyUI 的 prompt (API JSON)、A1111 風格的 parameters 文字。
 * 只讀 tEXt / iTXt / zTXt 區塊，不解碼像素。
 */
window.PngInfo = (() => {
  'use strict';

  async function inflate(bytes) {
    const ds = new DecompressionStream('deflate');
    const w = ds.writable.getWriter(); w.write(bytes); w.close();
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  }
  const utf8 = (b) => new TextDecoder('utf-8').decode(b);
  const latin1 = (b) => new TextDecoder('latin1').decode(b);
  const indexOf0 = (b, from = 0) => { for (let i = from; i < b.length; i++) if (b[i] === 0) return i; return -1; };

  /** 讀出 {key: text}；不是 PNG 或沒有文字區塊就回 {} */
  async function readTextChunks(buf) {
    const u8 = new Uint8Array(buf);
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (u8.length < 8 || sig.some((v, i) => u8[i] !== v)) return {};
    const dv = new DataView(buf);
    const out = {};
    let pos = 8;
    while (pos + 8 <= u8.length) {
      const len = dv.getUint32(pos);
      const type = latin1(u8.subarray(pos + 4, pos + 8));
      const body = u8.subarray(pos + 8, pos + 8 + len);
      if (type === 'IEND') break;
      try {
        if (type === 'tEXt') {
          const z = indexOf0(body);
          out[latin1(body.subarray(0, z))] = utf8(body.subarray(z + 1));
        } else if (type === 'iTXt') {
          const z = indexOf0(body);
          const key = latin1(body.subarray(0, z));
          const compFlag = body[z + 1];
          let p = z + 3;
          p = indexOf0(body, p) + 1;           // language tag
          p = indexOf0(body, p) + 1;           // translated keyword
          let txt = body.subarray(p);
          if (compFlag) txt = await inflate(txt);
          out[key] = utf8(txt);
        } else if (type === 'zTXt') {
          const z = indexOf0(body);
          out[latin1(body.subarray(0, z))] = utf8(await inflate(body.subarray(z + 2)));
        }
      } catch (e) { /* 壞掉的區塊就跳過 */ }
      pos += 12 + len;
    }
    return out;
  }

  const tryJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const baseName = (s) => String(s || '').replace(/\\/g, '/').split('/').pop().replace(/\.(safetensors|ckpt|pt|pth)$/i, '');

  /** 把 A1111 的 sampler 顯示名轉成 ComfyUI 的 sampler / scheduler */
  function mapSampler(name) {
    if (!name) return null;
    let n = name.trim(), scheduler = 'normal';
    const sched = [['Karras', 'karras'], ['Exponential', 'exponential'], ['SGM Uniform', 'sgm_uniform'], ['Simple', 'simple'], ['Beta', 'beta']];
    for (const [k, v] of sched) if (n.endsWith(' ' + k)) { scheduler = v; n = n.slice(0, -k.length - 1); }
    const table = {
      'DPM++ 2M': 'dpmpp_2m', 'DPM++ 2M SDE': 'dpmpp_2m_sde', 'DPM++ 3M SDE': 'dpmpp_3m_sde', 'DPM++ SDE': 'dpmpp_sde',
      'DPM++ 2S a': 'dpmpp_2s_ancestral', 'Euler a': 'euler_ancestral', 'Euler': 'euler', 'LMS': 'lms', 'Heun': 'heun',
      'DPM2': 'dpm_2', 'DPM2 a': 'dpm_2_ancestral', 'DPM fast': 'dpm_fast', 'DPM adaptive': 'dpm_adaptive',
      'DDIM': 'ddim', 'UniPC': 'uni_pc', 'LCM': 'lcm', 'Restart': 'restart',
    };
    return { sampler: table[n] || n.toLowerCase().replace(/[\s+]+/g, '_'), scheduler };
  }

  /** 拆 A1111 風格的 parameters 文字 */
  function parseA1111(text) {
    const negIdx = text.indexOf('\nNegative prompt:');
    const lines = text.trimEnd().split('\n');
    const last = lines[lines.length - 1];
    const kv = {};
    if (/^Steps:\s*\d+/.test(last)) {
      for (const m of last.matchAll(/([A-Za-z ]+):\s*("(?:[^"\\]|\\.)*"|[^,]+)/g)) kv[m[1].trim()] = m[2].trim().replace(/^"|"$/g, '');
      lines.pop();
    }
    const body = lines.join('\n');
    let pos = body, neg = '';
    if (negIdx >= 0) {
      const i = body.indexOf('\nNegative prompt:');
      if (i >= 0) { pos = body.slice(0, i); neg = body.slice(i + '\nNegative prompt:'.length).replace(/^\s+/, ''); }
    }
    const size = (kv['Size'] || '').split('x').map(Number);
    const s = mapSampler(kv['Sampler']);
    return {
      pos, neg,
      steps: kv['Steps'] ? Number(kv['Steps']) : undefined,
      cfg: kv['CFG scale'] ? Number(kv['CFG scale']) : undefined,
      seed: kv['Seed'] ? Number(kv['Seed']) : undefined,
      width: size[0] || undefined, height: size[1] || undefined,
      ckpt: kv['Model'] || undefined,
      modelHash: kv['Model hash'] || undefined,
      sampler: s?.sampler, scheduler: s?.scheduler,
      clipskip: kv['Clip skip'] ? -Number(kv['Clip skip']) : undefined,
      hires: kv['Hires upscale'] ? { enabled: true, scale: Number(kv['Hires upscale']), model: kv['Hires upscaler'], steps: kv['Hires steps'] ? Number(kv['Hires steps']) : undefined, denoise: kv['Denoising strength'] ? Number(kv['Denoising strength']) : undefined } : undefined,
    };
  }

  /** 把提示詞裡的 <lora:名:權重> 抽出來、<embedding:x> 改成 embedding:x */
  function extractLoras(text) {
    const loras = [];
    const cleaned = String(text || '').split('\n').map(line => {
      if (line.trimStart().startsWith('#')) return line;          // 註解行原樣保留，裡面的 <lora> 不算
      return line
        .replace(/<lora:([^:>]+)(?::([-\d.]+))?(?::[-\d.]+)?>/gi, (_, name, w) => { loras.push({ name, weight: w !== undefined ? Number(w) : 1 }); return ''; })
        .replace(/<embedding:([^>]+)>/gi, 'embedding:$1');
    }).join('\n');
    return { text: cleaned, loras };
  }

  /** 從 ComfyUI API 格式 prompt 猜參數（通用、盡力而為） */
  function parseComfyPrompt(p) {
    const nodes = Object.values(p).filter(n => n && n.class_type);
    const byType = (t) => nodes.filter(n => n.class_type === t);
    const ref = (arr) => (Array.isArray(arr) ? p[arr[0]] : null);
    const out = {};
    const ck = byType('CheckpointLoaderSimple')[0]; if (ck) out.ckpt = ck.inputs.ckpt_name;
    out.loras = byType('LoraLoader').map(n => ({ name: n.inputs.lora_name, weight: Number(n.inputs.strength_model) }));
    const lat = byType('EmptyLatentImage')[0]; if (lat) { out.width = lat.inputs.width; out.height = lat.inputs.height; out.batch = lat.inputs.batch_size; }
    const cs = byType('CLIPSetLastLayer')[0]; if (cs) out.clipskip = cs.inputs.stop_at_clip_layer;
    const ks = byType('KSampler').sort((a, b) => (b.inputs.denoise ?? 1) - (a.inputs.denoise ?? 1))[0];
    if (ks) {
      Object.assign(out, { seed: ks.inputs.seed, steps: ks.inputs.steps, cfg: ks.inputs.cfg, sampler: ks.inputs.sampler_name, scheduler: ks.inputs.scheduler });
      const posN = ref(ks.inputs.positive), negN = ref(ks.inputs.negative);
      if (posN?.inputs?.text != null) out.pos = posN.inputs.text;
      if (negN?.inputs?.text != null) out.neg = negN.inputs.text;
      const hs = byType('KSampler').find(n => n !== ks && (n.inputs.denoise ?? 1) < 1);
      const um = byType('UpscaleModelLoader')[0];
      if (hs && um) {
        const rs = byType('ImageScale')[0];
        out.hires = { enabled: true, model: um.inputs.model_name, steps: hs.inputs.steps, denoise: hs.inputs.denoise,
                      scale: rs && out.width ? +(rs.inputs.width / out.width).toFixed(2) : 2 };
      }
    }
    return out;
  }

  /**
   * 回傳統一格式的參數物件，或 null（沒有可用資料）。
   * 欄位都可能缺；呼叫端用現有值補。
   */
  function parseParams(chunks) {
    // 1. Yomu 自己存的（舊名 hinayome、inference_ui 也認）
    const mineRaw = chunks.yomu || chunks.hinayome || chunks.inference_ui;
    const mine = mineRaw && tryJson(mineRaw);
    if (mine && mine.pos != null) return { ...mine, source: 'yomu' };

    // 2. Stability Matrix
    const pj = chunks['parameters-json'] && tryJson(chunks['parameters-json']);
    const sm = chunks.smproj && tryJson(chunks.smproj);
    if (pj) {
      const st = sm?.State || {};
      const s = mapSampler(pj.Sampler);
      const out = {
        pos: pj.PositivePrompt, neg: pj.NegativePrompt, steps: pj.Steps, cfg: pj.CfgScale, seed: pj.Seed, ckpt: pj.ModelName,
        width: st.Sampler?.Width || pj.Width, height: st.Sampler?.Height || pj.Height,
        sampler: st.Sampler?.SelectedSampler?.Name || s?.sampler, scheduler: st.Sampler?.SelectedScheduler?.Name || s?.scheduler,
        clipskip: st.Model?.IsClipSkipEnabled ? -Number(st.Model.ClipSkip) : undefined,
        source: 'stability_matrix',
      };
      const hf = (st.Modules?.$values || []).find(m => m.$type === 'HiresFixModule');
      if (hf) {
        const up = (hf.$values || []).find(v => v.$type === 'Upscaler'), sa = (hf.$values || []).find(v => v.$type === 'Sampler');
        out.hires = { enabled: !!hf.IsEnabled, scale: up?.Scale, model: up?.SelectedUpscaler?.Name, steps: sa?.Steps, denoise: sa?.DenoiseStrength };
      }
      return out;
    }

    // 3. ComfyUI API prompt
    const cp = chunks.prompt && tryJson(chunks.prompt);
    if (cp && typeof cp === 'object') { const o = parseComfyPrompt(cp); if (o.pos != null || o.ckpt) return { ...o, source: 'comfyui' }; }

    // 4. A1111 文字
    if (chunks.parameters) return { ...parseA1111(chunks.parameters), source: 'a1111' };
    return null;
  }

  return { readTextChunks, parseParams, extractLoras, baseName };
})();
