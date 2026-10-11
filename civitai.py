"""
從 Civitai 補模型預覽圖與資訊（背景工作）。

  POST /yomu/api/civitai/fetch?kinds=checkpoints,loras,embeddings&force=0   開始
  GET  /yomu/api/civitai/status                                             進度

流程：每個沒有預覽圖的模型 → 取 SHA256（cm-info.json 有就直接用，沒有才算）
      → GET https://civitai.com/api/v1/model-versions/by-hash/<sha256>
      → 存 <model>.preview.<ext> 與 <model>.cm-info.json（跟 Stability Matrix 同格式）
"""
import hashlib
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request

from aiohttp import web

import folder_paths

API = "https://civitai.com/api/v1/model-versions/by-hash/"
UA = "Yomu/1.0 (ComfyUI custom node)"
KINDS = ("checkpoints", "diffusion_models", "loras", "embeddings")
PREVIEW_SUFFIXES = (".preview.png", ".preview.jpeg", ".preview.jpg", ".preview.webp", ".png", ".jpg", ".jpeg", ".webp")

_job = {"running": False, "total": 0, "done": 0, "current": "", "results": [], "started": 0, "finished": 0}
_lock = threading.Lock()


def _has_preview(full):
    base = os.path.splitext(full)[0]
    return any(os.path.isfile(base + s) for s in PREVIEW_SUFFIXES)


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest().upper()


def _get_hash(full):
    info_path = os.path.splitext(full)[0] + ".cm-info.json"
    if os.path.isfile(info_path):
        try:
            with open(info_path, "r", encoding="utf-8", errors="replace") as f:
                hashes = (json.load(f).get("Hashes") or {})
            for k in ("SHA256", "sha256"):
                if hashes.get(k):
                    return str(hashes[k]).upper()
        except Exception:
            pass
    return _sha256(full)


def _http_get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.headers.get("Content-Type", "")


def _pick_image(images):
    """優先挑靜態圖、nsfw 等級最低的"""
    imgs = [i for i in images or [] if isinstance(i, dict) and i.get("url") and i.get("type", "image") == "image"]
    if not imgs:
        return None
    imgs.sort(key=lambda i: (i.get("nsfwLevel") or 0))
    return imgs[0]["url"]


def _read_info(info_path):
    try:
        with open(info_path, "r", encoding="utf-8", errors="replace") as f:
            return json.load(f)
    except Exception:
        return {}


def _needs_hash(info_path):
    if not os.path.isfile(info_path):
        return False
    d = _read_info(info_path)
    return bool(d.get("VersionId")) and not (d.get("Hashes") or {}).get("SHA256")


def _fill_hash(info_path):
    """cm-info 有 VersionId 沒 SHA256（早期下載的）→ 問 Civitai 版本 API 補上"""
    d = _read_info(info_path)
    try:
        body, _ = _http_get(f"https://civitai.com/api/v1/model-versions/{int(d['VersionId'])}")
        ver = json.loads(body)
    except Exception as e:
        return f"補 hash 失敗：{e}"
    files = ver.get("files") or []
    primary = next((f for f in files if f.get("primary")), files[0] if files else None)
    sha = ((primary or {}).get("hashes") or {}).get("SHA256")
    if not sha:
        return "Civitai 沒給 hash"
    d.setdefault("Hashes", {})["SHA256"] = sha.upper()
    if not d.get("TrainedWords"):
        d["TrainedWords"] = ver.get("trainedWords") or []
    with open(info_path, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
    return "已補 hash"


def _fetch_one(kind, name, force=False):
    full = folder_paths.get_full_path(kind, name)
    if not full or not os.path.isfile(full):
        return "找不到檔案"
    base = os.path.splitext(full)[0]
    info_path = base + ".cm-info.json"
    if _has_preview(full) and os.path.isfile(info_path) and not force:
        return _fill_hash(info_path) if _needs_hash(info_path) else "已有"

    sha = _get_hash(full)
    try:
        body, _ = _http_get(API + sha)
    except urllib.error.HTTPError as e:
        return "Civitai 沒有這個模型" if e.code == 404 else f"Civitai 回應 {e.code}"
    except Exception as e:
        return f"連線失敗：{e}"
    try:
        ver = json.loads(body)
    except Exception:
        return "回應不是 JSON"

    # 資訊檔（沒有才寫，避免蓋掉 SM 的）
    if not os.path.isfile(info_path) or force:
        info = {
            "ModelId": ver.get("modelId"),
            "ModelName": (ver.get("model") or {}).get("name"),
            "ModelType": (ver.get("model") or {}).get("type"),
            "Nsfw": bool((ver.get("model") or {}).get("nsfw")),
            "VersionId": ver.get("id"),
            "VersionName": ver.get("name"),
            "BaseModel": ver.get("baseModel"),
            "TrainedWords": ver.get("trainedWords") or [],
            "Hashes": {"SHA256": sha},
            "Source": "civitai",
            "SourceUrl": f"https://civitai.com/models/{ver.get('modelId')}?modelVersionId={ver.get('id')}",
            "ImportedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        with open(info_path, "w", encoding="utf-8") as f:
            json.dump(info, f, ensure_ascii=False, indent=2)

    if _has_preview(full) and not force:
        return "已補資訊"
    url = _pick_image(ver.get("images"))
    if not url:
        return "Civitai 上沒有圖"
    url = re.sub(r"/width=\d+/", "/width=512/", url)
    try:
        data, ctype = _http_get(url, timeout=60)
    except Exception as e:
        return f"下載圖片失敗：{e}"
    ext = ".jpeg"
    if "png" in ctype or url.lower().endswith(".png"):
        ext = ".png"
    elif "webp" in ctype or url.lower().endswith(".webp"):
        ext = ".webp"
    with open(base + ".preview" + ext, "wb") as f:
        f.write(data)
    return "已下載"


def _run(kinds, force):
    targets = []
    for kind in kinds:
        for name in folder_paths.get_filename_list(kind):
            full = folder_paths.get_full_path(kind, name)
            if not full:
                continue
            info_path = os.path.splitext(full)[0] + ".cm-info.json"
            if force or not _has_preview(full) or not os.path.isfile(info_path) or _needs_hash(info_path):
                targets.append((kind, name))
    with _lock:
        _job.update(running=True, total=len(targets), done=0, current="", results=[], started=time.time(), finished=0)
    for kind, name in targets:
        with _lock:
            _job["current"] = name
        try:
            status = _fetch_one(kind, name, force)
        except Exception as e:
            status = f"錯誤：{e}"
        with _lock:
            _job["results"].append({"kind": kind, "name": name, "status": status})
            _job["done"] += 1
        time.sleep(0.6)          # 對 Civitai 客氣一點
    with _lock:
        _job.update(running=False, current="", finished=time.time())


def register(routes):
    @routes.post("/yomu/api/civitai/fetch")
    async def civitai_fetch(request):
        with _lock:
            if _job["running"]:
                return web.json_response({"ok": False, "msg": "已經在抓了"})
        kinds = [k for k in request.query.get("kinds", ",".join(KINDS)).split(",") if k in KINDS]
        force = request.query.get("force") == "1"
        threading.Thread(target=_run, args=(kinds or list(KINDS), force), daemon=True).start()
        return web.json_response({"ok": True})

    @routes.get("/yomu/api/civitai/status")
    async def civitai_status(request):
        with _lock:
            return web.json_response(dict(_job))
