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

`launcher/launcher.py` 是小啟動器（http://127.0.0.1:8189），一個按鈕切換啟動／停止，關掉視窗後啟動器自己結束（ComfyUI 繼續跑），
有即時 log；開啟時會檢查更新，有新版才出現綠色的「更新 ComfyUI」「更新 Yomu」按鈕；ComfyUI 起來後會自動開 Yomu。有裝 Electron 就用 Electron 視窗，沒有就用 Edge / Chrome 的 App 視窗。

- `launcher/launch.vbs`：桌面捷徑用，開啟啟動器視窗

## Hires Fix 與圖片參數

- 範本裡 `@hires_*` 節點是 Hires Fix（放大模型 → 縮到倍率 → VAE Encode → 第二次 KSampler）。
  介面關閉 Hires Fix 時整組會被拔掉，`@save` 直接接回 `@decode`。
- 提示詞裡 `#` 開頭的整行、或行尾 `#` 之後的文字是註解，送出時會拿掉。
- 點選 LoRA 卡片加入／移除，權重在提示詞下方調整，clip 固定 1.0。也可直接輸入 `<lora:名:權重>`。
- 點選 embedding 卡片會在正面提示詞游標位置插入 `embedding:名稱`。
- 模型卡片使用模型旁的 `.preview.png/.jpeg/.jpg/.webp` 或同名圖片；沒有本機圖片時顯示名稱縮寫，不自動下載。
- 生成的 PNG 會多一個 `yomu` 文字區塊，把 PNG 拖到畫面任何位置就能還原全部設定；用到的模型這台沒有時，會跳出視窗列出來並可直接到 Civitai 搜尋。
  也能讀 Stability Matrix、A1111、一般 ComfyUI 的圖；提示詞裡的 `<lora:名:權重>` 會自動轉成 LoRA 列。

## 角色卡

左欄「角色」卡片：第一次按「下載角色資料包」，從 Hugging Face 下載 [WAI 角色資料包](https://huggingface.co/datasets/flagrantia/character_select_stand_alone_app)（MIT，5000 多個角色的中文名、標籤、縮圖，約 125 MB）到 `cache/characters/`。
可以用中文（簡繁都行）、英文或作品名搜尋；點卡片把角色標籤加進正面提示詞，再點一次拿掉。中文名用 `characters_s2t.json` 轉成繁體。
打開 Yomu 時會問一次 Hugging Face 有沒有新版本的資料包（作者配合新版 WAI 模型會出 v120、v160…），有的話卡片上會出現「更新」，按了才下載。

## 姿勢卡

左欄「＋ 新增」→ 姿勢。每張卡是「名稱 + 一整段描述」，點一下放進正面提示詞，一次只放一張（點別張會換掉）。
官方的寫在 `poses.json`（`[{"name": "...", "text": "..."}]`），自己新增的存在 `user/yomu_poses.json`，更新 Yomu 不會蓋掉。
新增：在提示詞選取一段描述，按「＋ 存成姿勢卡」。

## 隨機角色 / 隨機姿勢

勾角色卡或姿勢卡的 🎲，提示詞裡會出現 `{隨機角色}` / `{隨機姿勢}`（可以自己搬位置）。每次生成時換成抽到的內容，有搜尋字就從搜尋結果抽；
欄位裡的標籤不變，送出和存進圖片的是換好的，所以圖片拖回來就是實際用的角色 / 姿勢。

## Civitai 搜尋

除了原詞，還會一起搜相關的熱門作品 / 角色名（`ark` → arknights，`miku` → hatsune miku；中文從角色資料包對到英文名），狀態列會列出「也搜尋了」哪些。
沒勾 NSFW 時依模型本身的標記過濾，預覽圖只顯示 PG / PG-13 的；不會因為有一張 R 級預覽圖就把整個模型藏起來。

## 圖庫

右上角「圖庫」會列出 `output/` 裡全部的圖（伺服器掃描、分頁、虛擬捲動）。
縮圖快取在 `cache/thumbs/`（可以整個刪掉，會自動重建）。點縮圖 → 顯示在預覽區並讀它的參數；
「載入參數」才會套到左側。搜尋框比對檔名／子資料夾。

## 桌面捷徑

`Yomu.lnk`（桌面）→ `launcher/launch.vbs` → 啟動器視窗 → 按「啟動 ComfyUI」→ Yomu 視窗。圖示在 `assets/yomu.ico`。
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
幀數欄位對應 length；影片模式沒有 Hires。圖庫會列出 mp4（縮圖用 PyAV 抓第 0.5 秒），預覽區與大圖用 `<video>` 播放。

## 圖生影片

分頁「圖生影片」或圖片右鍵「🎬 讓它動起來」。範本 `img2video.json`：Wan2.2 I2V 14B high/low（`@ckpt` 選 high，low 由檔名 high→low 推得）
＋ lightx2v 4 步 LoRA（`@speed_lora_*`，選到 DaSiWa Lightspeed 時自動拔掉，因為它內建 4 步）＋ `WanImageToVideo`（@latent）
＋ 兩段 `KSamplerAdvanced`（@sampler / @sampler_low，各跑一半步數）＋ RIFE 補幀 ×2（@vfi）→ 32fps mp4。
需要 `ComfyUI-Frame-Interpolation`（RIFE 補幀節點，安裝程式會一起裝）。來源圖放進來會自動把尺寸設成同比例（長邊 896）。4070 上 496×896×81 幀約 2–3 分鐘。

## 安裝與更新（給朋友）

- 沒有 ComfyUI：下載這個倉庫的 ZIP，解開後執行 `installer\Yomu-Setup.bat`。它會開一個安裝網頁，下載 ComfyUI、建好 Python 環境、裝 PyTorch 與 Yomu，並在桌面建 `Yomu` 捷徑。模型不包含，進 Yomu 後照缺模型視窗到 Civitai 下載。
- 已經有 ComfyUI：把這個倉庫 `git clone` 到 `custom_nodes/ComfyUI-Yomu`，執行 `launcher\launch.vbs` 開啟。
- 提示詞的 Danbooru 標籤補完讀的是 `custom_nodes/ComfyUI-Autocomplete-Plus-Plus/tags/danbooru.csv`，安裝程式會一起裝；自己 clone 的人要另外裝這個節點。
- 更新：開啟啟動器時會檢查，有新版才會出現綠色的「更新」按鈕。ComfyUI 那列的只更新 ComfyUI 本體和其他自訂節點，Yomu 那列的只更新 Yomu（含啟動器），需要時會 `pip install`；檢查用 `git fetch`，更新用 `git pull --ff-only`。
- 啟動器自己（`launcher/`）有更新時，關掉啟動器視窗再從捷徑重開就會生效。
