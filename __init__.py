"""
ComfyUI-Yomu
Yomu：簡單的文生圖 / 圖生圖介面，背後跑的是 workflows/ 內的 API 格式工作流範本。

路由：
  GET /yomu                      主頁面
  GET /yomu/static/{file}        前端靜態檔
  GET /yomu/api/workflows        列出可用範本
  GET /yomu/api/workflow/{name}  取得單一範本 JSON
  GET /yomu/api/tags?q=&limit=   Danbooru 標籤自動補完
  GET /yomu/api/gallery|thumb|pnginfo   圖庫（見 gallery.py）
  GET /yomu/api/characters*      角色卡（見 characters.py）
"""
import asyncio
import csv
import json
import os
import threading

from aiohttp import web
import folder_paths
from server import PromptServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")
WORKFLOW_DIR = os.path.join(BASE_DIR, "workflows")
TAG_CSV = os.path.join(
    os.path.dirname(BASE_DIR), "ComfyUI-Autocomplete-Plus-Plus", "tags", "danbooru.csv"
)

routes = PromptServer.instance.routes


@routes.get("/yomu")
async def serve_index(request):
    return web.FileResponse(os.path.join(WEB_DIR, "index.html"))


@routes.get("/yomu/static/{name}")
async def serve_static(request):
    name = os.path.basename(request.match_info["name"])
    path = os.path.join(WEB_DIR, name)
    if not os.path.isfile(path):
        return web.Response(status=404, text="not found")
    return web.FileResponse(path, headers={"Cache-Control": "no-cache"})


@routes.get("/yomu/api/workflows")
async def list_workflows(request):
    names = sorted(
        f[:-5] for f in os.listdir(WORKFLOW_DIR) if f.endswith(".json") and not f.startswith("_")   # 底線開頭 = 工具用，不列在選單
    )
    return web.json_response(names)


@routes.get("/yomu/api/workflow/{name}")
async def get_workflow(request):
    name = os.path.basename(request.match_info["name"])
    path = os.path.join(WORKFLOW_DIR, name + ".json")
    if not os.path.isfile(path):
        return web.Response(status=404, text="workflow not found")
    with open(path, "r", encoding="utf-8") as f:
        return web.json_response(json.load(f))


# ---- 標籤自動補完（第一次用到時才載入 CSV，之後留在記憶體） ----
_tags = None
_tags_lock = threading.Lock()


def _load_tags():
    global _tags
    with _tags_lock:
        if _tags is not None:
            return _tags
        rows = []
        if os.path.isfile(TAG_CSV):
            with open(TAG_CSV, "r", encoding="utf-8", errors="ignore") as f:
                for row in csv.reader(f):
                    if len(row) < 3:
                        continue
                    try:
                        cat, count = int(row[1]), int(row[2])
                    except ValueError:
                        continue
                    aliases = row[3].split(",") if len(row) > 3 and row[3] else []
                    rows.append((row[0], cat, count, [a for a in aliases if a]))
        rows.sort(key=lambda r: -r[2])
        if rows:      # 檔案不存在時不要把「空」記起來，補上檔案後就能用
            _tags = rows
        return rows


@routes.get("/yomu/api/embeddings")
async def list_embeddings(request):
    """models/embeddings 裡的檔名（不含副檔名），給提示詞補完用"""
    names = folder_paths.get_filename_list("embeddings")
    return web.json_response(sorted({os.path.splitext(n)[0] for n in names}))


def _model_preview(kind, name):
    full = folder_paths.get_full_path(kind, name)
    if not full:
        return None
    base = os.path.splitext(full)[0]
    for suffix in (".preview.png", ".preview.jpeg", ".preview.jpg", ".preview.webp", ".png", ".jpg", ".jpeg", ".webp"):
        preview = base + suffix
        if os.path.isfile(preview):
            return preview
    return None


MODEL_KINDS = ("checkpoints", "diffusion_models", "loras", "embeddings")


def _model_info(kind, name):
    """Stability Matrix / Civitai 下載時附的 <model>.cm-info.json：觸發詞、底模、版本"""
    full = folder_paths.get_full_path(kind, name)
    if not full:
        return {}
    path = os.path.splitext(full)[0] + ".cm-info.json"
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            d = json.load(f)
    except Exception:
        return {}
    return {
        "trainedWords": [w for w in (d.get("TrainedWords") or []) if isinstance(w, str)],
        "baseModel": d.get("BaseModel"),
        "modelName": d.get("ModelName"),
        "versionName": d.get("VersionName"),
        "nsfw": bool(d.get("Nsfw")),
        "sourceUrl": d.get("SourceUrl"),
        "sha256": (d.get("Hashes") or {}).get("SHA256"),
    }


import re as _re

FAMILY_RULES = [   # (family, BaseModel / 檔名 的關鍵字)
    ("wan",    r"wan|i2v|t2v|ti2v"),
    ("video",  r"ltx|hunyuan.?video|svd|mochi|cogvideo|animate"),
    ("anima",  r"anima"),
    ("flux",   r"flux|kontext|krea"),
    ("qwen",   r"qwen"),
    ("sd15",   r"sd ?1\.[45]|sd ?2\.|^v1-|sd15"),
    ("sdxl",   r"illustrious|pony|noob|sdxl|xl|sd ?3"),
]


def _model_family(kind, name):
    """先看 cm-info 的 BaseModel，沒有就猜檔名；猜不到回 unknown"""
    info = _model_info(kind, name)
    for text in (info.get("baseModel") or "", name):
        t = text.lower()
        for fam, pat in FAMILY_RULES:
            if _re.search(pat, t):
                return fam
        if text is not name and text:
            return "other"          # 有 BaseModel 但不認得
    return "unknown"


@routes.get("/yomu/api/model-by-hash")
async def model_by_hash(request):
    """A1111 圖片裡的 Model hash（SHA256 前 10 碼）→ 本機哪個檔案"""
    want = request.query.get("hash", "").strip().lower()
    if len(want) < 8:
        return web.json_response({"ok": False})
    for kind in MODEL_KINDS:
        for name in folder_paths.get_filename_list(kind):
            sha = ((_model_info(kind, name).get("sha256") or "")).lower()
            if sha and sha.startswith(want):
                return web.json_response({"ok": True, "kind": kind, "name": name})
    return web.json_response({"ok": False})


@routes.get("/yomu/api/model-families")
async def model_families(request):
    return web.json_response({
        kind: {name: _model_family(kind, name) for name in folder_paths.get_filename_list(kind)}
        for kind in MODEL_KINDS
    })


@routes.get("/yomu/api/model-assets")
async def model_assets(request):
    return web.json_response({
        kind: {name: bool(_model_preview(kind, name)) for name in folder_paths.get_filename_list(kind)}
        for kind in MODEL_KINDS
    })


@routes.get("/yomu/api/model-info")
async def model_info(request):
    kind, name = request.query.get("kind"), request.query.get("name", "")
    if kind not in MODEL_KINDS or name not in folder_paths.get_filename_list(kind):
        return web.Response(status=404)
    return web.json_response(_model_info(kind, name))


def _recycle(paths):
    """用 Windows 的資源回收筒刪檔（不需要額外套件）"""
    import subprocess
    script = (
        "Add-Type -AssemblyName Microsoft.VisualBasic; "
        + "; ".join(
            "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('" + p.replace("'", "''") + "', 'OnlyErrorDialogs', 'SendToRecycleBin')"
            for p in paths
        )
    )
    r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                       capture_output=True, text=True, creationflags=0x08000000, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or "刪除失敗")


@routes.post("/yomu/api/open-models")
async def open_models(request):
    """在檔案總管開啟 models 資料夾（所有模型類型的資料夾都在裡面）"""
    os.startfile(folder_paths.models_dir)
    return web.json_response({"ok": True, "path": folder_paths.models_dir})


@routes.post("/yomu/api/model-delete")
async def model_delete(request):
    kind, name = request.query.get("kind"), request.query.get("name", "")
    if kind not in MODEL_KINDS or name not in folder_paths.get_filename_list(kind):
        return web.json_response({"ok": False, "msg": "找不到這個模型"}, status=404)
    full = folder_paths.get_full_path(kind, name)
    base = os.path.splitext(full)[0]
    paths = [full] + [
        base + suf for suf in (".preview.png", ".preview.jpeg", ".preview.jpg", ".preview.webp", ".cm-info.json", ".civitai.info", ".json")
        if os.path.isfile(base + suf)
    ]
    def _unload_and_retry():
        # 用過的模型會被 ComfyUI 以 mmap 方式抓著檔案，Windows 就不給刪：先把所有模型從記憶體卸掉再試一次
        import gc
        import comfy.model_management as mm
        mm.unload_all_models()
        mm.soft_empty_cache()
        gc.collect()
        _recycle(paths)
    try:
        try:
            await asyncio.to_thread(_recycle, paths)
        except Exception:
            await asyncio.to_thread(_unload_and_retry)
    except Exception as e:
        return web.json_response({"ok": False, "msg": f"{e}（檔案可能正被使用中，重啟 ComfyUI 後再試）"}, status=500)
    return web.json_response({"ok": True, "removed": [os.path.basename(p) for p in paths]})


@routes.get("/yomu/api/model-preview")
async def model_preview(request):
    kind, name = request.query.get("kind"), request.query.get("name", "")
    if kind not in MODEL_KINDS or name not in folder_paths.get_filename_list(kind):
        return web.Response(status=404)
    preview = _model_preview(kind, name)
    if not preview:
        return web.Response(status=404)
    thumbnail = await asyncio.to_thread(_make_thumb, preview, 256)
    return web.FileResponse(thumbnail, headers={"Content-Type": "image/webp"})


@routes.get("/yomu/api/tags")
async def search_tags(request):
    q = request.query.get("q", "").strip().lower().replace(" ", "_")
    limit = min(int(request.query.get("limit", "20")), 50)
    if not q:
        return web.json_response([])
    tags = _load_tags()
    starts, contains = [], []
    for tag, cat, count, aliases in tags:
        alias_hit = None
        if tag.startswith(q):
            starts.append((tag, cat, count, None))
        else:
            for a in aliases:
                if a.startswith(q):
                    alias_hit = a
                    break
            if alias_hit:
                starts.append((tag, cat, count, alias_hit))
            elif q in tag:
                contains.append((tag, cat, count, None))
        if len(starts) >= limit:
            break
    result = (starts + contains)[:limit]
    return web.json_response(
        [{"tag": t, "cat": c, "count": n, "alias": a} for t, c, n, a in result]
    )


from .gallery import register as _register_gallery, _make_thumb
_register_gallery(routes)
from .civitai import register as _register_civitai
_register_civitai(routes)
from .civitai_browser import register as _register_civitai_browser
_register_civitai_browser(routes)
from .characters import register as _register_characters
_register_characters(routes)

NODE_CLASS_MAPPINGS = {}

WEB_DIRECTORY = "./js"
