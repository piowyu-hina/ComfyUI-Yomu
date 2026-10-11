# ComfyUI-Yomu

Yomu：文生圖 / 圖生圖 App，從桌面 `Yomu` 捷徑開啟獨立視窗。
介面以 Stability Matrix Inference 的深色面板配置為參考：左側 Prompt／Generate，右側 Image Output／Gallery。
負面提示詞與 LoRA／embedding 在 Prompt 下方展開；右上角 Config 開啟參數面板。
預覽保留 9:16 直式比例，提示詞與預覽之間的分隔線可拖曳調整寬度。
網頁入口仍在 <http://127.0.0.1:8188/yomu>。
（ComfyUI 主畫面選單 Extensions → 「開啟 Yomu」也可以進來）

## 檔案

```
__init__.py        伺服器路由（/yomu、/yomu/api/*）
web/               前端：index.html、app.js、style.css
workflows/         工作流範本（ComfyUI API 格式）
  txt2img.json     文生圖
  img2img.json     圖生圖
js/launcher.js     在 ComfyUI 主介面選單加入口
tools/open_browser.py  啟動後自動開 App（start_service.bat 用）
```

## 背後的工作流怎麼換

前端**不寫死任何節點**，只做一件事：讀 `workflows/<模式>.json`，
把 UI 的值填進 `_meta.title` 以 `@` 開頭的「插槽」節點，然後送去 `/prompt`。

| 插槽 | 會被填入的 inputs（存在才填） |
|---|---|
| `@ckpt` | `ckpt_name` |
| `@lora` | 展開成 N 個串接的 LoraLoader；沒選 LoRA 就整個拔掉、上下游直接接上 |
| `@clipskip` | `stop_at_clip_layer` |
| `@positive` / `@negative` | `text` |
| `@latent` | `width` `height` `batch_size`（EmptyLatentImage）或 `amount`（RepeatLatentBatch） |
| `@sampler` | `seed` `steps` `cfg` `sampler_name` `scheduler` `denoise` |
| `@load_image` | `image`（圖生圖） |
| `@resize` | `width` `height`（圖生圖） |
| `@save` | 結果圖從這個節點抓 |

所以要把後面換成複雜工作流（高清修復、放大、ControlNet…）：
在 ComfyUI 畫布做好 → 右上角 Export (API) → 把對應節點的標題改成上面的插槽名 →
存成 `workflows/txt2img.json`（或 img2img.json）→ 重新整理頁面即可。
沒標插槽的節點會原封不動送出。

## 啟動 / 停止 ComfyUI

`D:\ComfyUI\launcher\launcher.py` 是常駐的小啟動器（http://127.0.0.1:8189），
有啟動／停止／重啟按鈕與即時 log，ComfyUI 起來後會自動開 Yomu。

- `launch.vbs`：桌面捷徑用，以本機 Electron 開啟 `launcher/yomu.cjs`，需要時自動啟動 ComfyUI
- `start_launcher.vbs`：放進「開機自動執行」用，只常駐啟動器不開瀏覽器
- `start_service.bat`：備用，直接在黑視窗跑 ComfyUI（不經啟動器）

## Hires Fix 與圖片參數

- 範本裡 `@hires_*` 節點是 Hires Fix（放大模型 → 縮到倍率 → VAE Encode → 第二次 KSampler）。
  介面關閉 Hires Fix 時整組會被拔掉，`@save` 直接接回 `@decode`。
- 提示詞裡 `#` 開頭的整行、或行尾 `#` 之後的文字是註解，送出時會拿掉。
- 點選 LoRA 卡片加入／移除，權重在提示詞下方調整，clip 固定 1.0。也可直接輸入 `<lora:名:權重>`。
- 點選 embedding 卡片會在正面提示詞游標位置插入 `embedding:名稱`。
- 模型卡片使用模型旁的 `.preview.png/.jpeg/.jpg/.webp` 或同名圖片；沒有本機圖片時顯示名稱縮寫，不自動下載。
- 生成的 PNG 會多一個 `yomu` 文字區塊，把 PNG 拖到右邊預覽區（或按「讀取圖片參數」）就能還原全部設定。
  也能讀 Stability Matrix、A1111、一般 ComfyUI 的圖；提示詞裡的 `<lora:名:權重>` 會自動轉成 LoRA 列。

## 圖庫

右上角「圖庫」會列出 `output/` 裡全部的圖（伺服器掃描、分頁、虛擬捲動）。
縮圖快取在 `cache/thumbs/`（可以整個刪掉，會自動重建）。點縮圖 → 顯示在預覽區並讀它的參數；
「載入參數」才會套到左側。搜尋框比對檔名／子資料夾。

## 桌面捷徑

`Yomu.lnk`（桌面）→ `launch.vbs` → Yomu App。圖示在 `assets/yomu.ico`。
App 預設最大化，同時只開一個主視窗；關閉視窗不會停止 ComfyUI。F5 重新載入介面。
App 的設定與紀錄存在 `user/yomu-app/`，與瀏覽器分開；可匯入舊 PNG 還原生成參數。

## 多個工作流

`workflows/` 裡以模式開頭命名：`txt2img*.json`、`img2img*.json`。同一模式有多個範本時，
「模型」卡會出現「工作流」下拉。`@ckpt` 是 `UNETLoader` 的範本會改用 `models/diffusion_models` 清單；
沒有 `@clipskip` / `@hires_*` 的範本，對應欄位會自動隱藏。切換範本時套用該範本 KSampler 的預設取樣參數，
之後每個範本各自記住上次的設定。範例：`txt2img_anima.json`（Anima：UNET + Qwen3 0.6B 文字編碼器 + Qwen VAE）。

## 局部重繪（inpaint）

分頁「局部重繪」：來源圖放進左側來源卡（拖檔案、貼上、或從圖庫拖過來），在右邊預覽區把要重畫的地方塗紅
（滾輪調筆刷、橡皮擦、反轉、清除），設定重繪幅度與遮罩外擴後生成。
前端會把「來源圖 + 遮罩（alpha=0）」合成一張 RGBA PNG 上傳，範本 `inpaint*.json` 用 LoadImage 的 MASK 輸出 →
GrowMask → SetLatentNoiseMask → KSampler → ImageCompositeMasked 只把遮罩區貼回原圖，其他地方一個像素都不會動。

## 文生影片

分頁「文生影片」，工作流三選一（`workflows/txt2video*.json`）：
- `txt2video_turbo`：Wan2.2 TI2V-5B + Turbo LoRA（`models/loras/Wan22_TI2V_5B_Turbo_lora_rank_64_fp16.safetensors`，來自 Kijai/WanVideo_comfy），6 步、CFG 1、shift 5。4070 上 1280×704×81 幀約 60 秒。**推薦**
- `txt2video`：Wan2.2 TI2V-5B 原版 20 步 CFG 5，品質稍好但約 3–4 分鐘
- `txt2video_fast`：Wan2.1 1.3B 480p，快速測試用
插槽：`@latent`（Wan22ImageToVideoLatent / EmptyHunyuanLatentVideo：width/height/length）、`@shift`、`@video`（CreateVideo fps）、`@save`（SaveVideo）。
幀數欄位對應 length；影片模式沒有 Hires / 張數。圖庫會列出 mp4（縮圖用 PyAV 抓第 0.5 秒），預覽區與大圖用 `<video>` 播放。

## ADetailer（修臉修手）

需要 `custom_nodes/ComfyUI-Impact-Pack` + `ComfyUI-Impact-Subpack`，偵測模型在 `models/ultralytics/bbox/`（face_yolov8m、hand_yolov8s）。
`txt2img.json` 裡 `@adet_face*`（FaceDetailer，用同一個 SDXL 模型）與 `@adet_hand*`（FaceDetailer，用 Anima 模型＋Qwen3 文字編碼器＋Qwen VAE）。
前端 `applyStages()` 把 hires → 修臉 → 修手 串成一條鏈，關掉的段整組拔掉、下一段接回上一段，最後接 `@save`。
Anima 那一段的提示詞會自動拿掉 SDXL embedding。

## 字卡（wildcards）與 Anima 整張精修

- 字卡放 `models/wildcards/**/*.txt`（一行一個），提示詞用 `__名字__`（名字 = 相對路徑去副檔名）抽一行，`{A|B|C}` 就地抽；
  `web/wildcards.js` 在送出前用 seed 決定抽到什麼（同 seed 同結果）；
  展開後的提示詞與抽到的項目（`picks`）都寫進 PNG，載入參數可原樣還原。自己的字卡存在 `models/wildcards/我的/`。
- 已下載的字卡包：The Prompt Builder（Pony/Illustrious）、Illustrious-XL Characters & Artists（2 萬個角色/畫師）、5770 Anime & Game Characters。
- `@refine_*`：Anima 整張精修階段（VAEEncode → KSampler denoise 0.35 → VAEDecode），鏈順序 hires → refine → 修臉 → 修手。

## 圖生影片

分頁「圖生影片」或圖片右鍵「🎬 讓它動起來」。範本 `img2video.json`：Wan2.2 I2V 14B high/low（`@ckpt` 選 high，low 由檔名 high→low 推得）
＋ lightx2v 4 步 LoRA（`@speed_lora_*`，選到 DaSiWa Lightspeed 時自動拔掉，因為它內建 4 步）＋ `WanImageToVideo`（@latent）
＋ 兩段 `KSamplerAdvanced`（@sampler / @sampler_low，各跑一半步數）＋ RIFE 補幀 ×2（@vfi）→ 32fps mp4。
來源圖放進來會自動把尺寸設成同比例（長邊 896）。4070 上 496×896×81 幀約 2–3 分鐘。

## 安裝與更新（給朋友）

- 沒有 ComfyUI：下載這個倉庫的 ZIP，解開後執行 `installer\Yomu-Setup.bat`。它會開一個安裝網頁，下載 ComfyUI、建好 Python 環境、裝 PyTorch 與 Yomu，並在桌面建 `Yomu` 捷徑。模型不包含，進 Yomu 後照缺模型視窗到 Civitai 下載。
- 已經有 ComfyUI：把這個倉庫 `git clone` 到 `custom_nodes/ComfyUI-Yomu`，執行 `launcher\launch.vbs` 開啟。
- 更新：啟動器頁面有兩個按鈕，「更新 Yomu」只更新 Yomu（含啟動器），「更新 ComfyUI」更新 ComfyUI 本體和其他自訂節點並視需要 `pip install`；都是 `git pull --ff-only`，只有按下去才會連網。
- 啟動器自己（`launcher/`）有更新時，更新記錄會提示要關掉啟動器再重開。
