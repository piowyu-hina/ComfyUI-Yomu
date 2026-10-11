"""
Civitai 模型瀏覽器：搜尋、看版本、下載到對的資料夾（背景工作，含進度）。

  GET  /yomu/api/settings                       目前設定（API key 只回是否有 + 末四碼）
  POST /yomu/api/settings   {civitai_api_key}   存設定
  GET  /yomu/api/civitai/search?query&types&baseModels&sort&nsfw&cursor&limit
  POST /yomu/api/civitai/download {modelId, versionId, fileId}
  GET  /yomu/api/civitai/downloads              下載清單與進度
  POST /yomu/api/civitai/download/cancel?id=
"""
import asyncio
import json
import os
import re
import threading
import time
import urllib.parse

import requests
from aiohttp import web

import folder_paths

SETTINGS_PATH = os.path.join(folder_paths.get_user_directory(), "yomu_settings.json")
API = "https://civitai.com/api/v1"
UA = "Yomu/1.0 (ComfyUI custom node)"

# Civitai 的 type / baseModel → models/ 底下的資料夾
DIFFUSION_BASES = re.compile(r"anima|flux|wan|qwen|hunyuan|ltx|z-?image|lumina|cosmos|hidream|chroma|sd ?3", re.I)


def load_settings():
    try:
        with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_settings(d):
    os.makedirs(os.path.dirname(SETTINGS_PATH), exist_ok=True)
    with open(SETTINGS_PATH, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)


def api_key():
    return (load_settings().get("civitai_api_key") or "").strip()


def _headers():
    h = {"User-Agent": UA, "Accept": "application/json"}
    k = api_key()
    if k:
        h["Authorization"] = "Bearer " + k
    return h


def target_folder(model_type, base_model):
    t = (model_type or "").lower()
    if t in ("lora", "locon", "dora", "lycoris"):
        return "loras"
    if t == "textualinversion":
        return "embeddings"
    if t == "vae":
        return "vae"
    if t == "upscaler":
        return "upscale_models"
    if t == "controlnet":
        return "controlnet"
    if t == "checkpoint":
        return "diffusion_models" if DIFFUSION_BASES.search(base_model or "") else "checkpoints"
    return None


# ------------------------------------------------------------------ 已安裝（依 cm-info 的 VersionId）
_installed = {"at": 0, "ids": set()}


def installed_version_ids():
    if time.time() - _installed["at"] < 30:
        return _installed["ids"]
    ids = set()
    for kind in ("checkpoints", "diffusion_models", "loras", "embeddings", "vae", "upscale_models", "controlnet"):
        try:
            names = folder_paths.get_filename_list(kind)
        except Exception:
            continue
        for n in names:
            full = folder_paths.get_full_path(kind, n)
            if not full:
                continue
            p = os.path.splitext(full)[0] + ".cm-info.json"
            if os.path.isfile(p):
                try:
                    with open(p, "r", encoding="utf-8", errors="replace") as f:
                        vid = json.load(f).get("VersionId")
                    if vid:
                        ids.add(int(vid))
                except Exception:
                    pass
    _installed.update(at=time.time(), ids=ids)
    return ids


def _imgs(images, limit=16):
    imgs = [i for i in images or [] if isinstance(i, dict) and i.get("url") and i.get("type", "image") == "image"]
    imgs.sort(key=lambda i: (i.get("nsfwLevel") or 0))
    return [re.sub(r"/width=\d+/", "/width=450/", i["url"]) for i in imgs[:limit]]


def _img(images):
    lst = _imgs(images, 1)
    return lst[0] if lst else None


def slim_model(m):
    installed = installed_version_ids()
    versions = []
    for v in m.get("modelVersions") or []:
        files = []
        for f in v.get("files") or []:
            meta = f.get("metadata") or {}
            files.append({
                "id": f.get("id"), "name": f.get("name"), "sizeKB": f.get("sizeKB"),
                "type": f.get("type"), "format": meta.get("format"), "fp": meta.get("fp"), "size": meta.get("size"),
                "primary": bool(f.get("primary")), "downloadUrl": f.get("downloadUrl"),
                "hashes": f.get("hashes") or {},
            })
        versions.append({
            "id": v.get("id"), "name": v.get("name"), "baseModel": v.get("baseModel"),
            "trainedWords": v.get("trainedWords") or [], "publishedAt": v.get("publishedAt"),
            "image": _img(v.get("images")), "images": _imgs(v.get("images")), "files": files,
            "installed": v.get("id") in installed,
            "description": (v.get("description") or "")[:2000],
        })
    stats = m.get("stats") or {}
    return {
        "id": m.get("id"), "name": m.get("name"), "type": m.get("type"), "nsfw": bool(m.get("nsfw")),
        "creator": (m.get("creator") or {}).get("username"),
        "downloads": stats.get("downloadCount"), "likes": stats.get("thumbsUpCount"), "rating": stats.get("rating"),
        "tags": (m.get("tags") or [])[:8],
        "image": next((v["image"] for v in versions if v["image"]), None),
        "baseModel": versions[0]["baseModel"] if versions else None,
        "installed": any(v["installed"] for v in versions),
        "versions": versions,
        "description": re.sub(r"<[^>]+>", " ", m.get("description") or "")[:1500],
    }


# ------------------------------------------------------------------ 下載工作
_downloads = {}          # id -> dict
_dl_lock = threading.Lock()
_dl_seq = [0]


def _write_info(base, model, version, sha256=None):
    info = {
        "ModelId": model.get("id"), "ModelName": model.get("name"), "ModelType": model.get("type"),
        "ModelDescription": model.get("description"), "Nsfw": bool(model.get("nsfw")),
        "VersionId": version.get("id"), "VersionName": version.get("name"), "BaseModel": version.get("baseModel"),
        "TrainedWords": version.get("trainedWords") or [], "AuthorUsername": (model.get("creator") or {}).get("username"),
        "Hashes": {"SHA256": sha256} if sha256 else {}, "Source": "civitai",
        "SourceUrl": f"https://civitai.com/models/{model.get('id')}?modelVersionId={version.get('id')}",
        "ImportedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    with open(base + ".cm-info.json", "w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False, indent=2)


def _download_job(job):
    try:
        job["status"] = "downloading"
        r = requests.get(job["url"], headers=_headers(), stream=True, timeout=60, allow_redirects=True)
        if r.status_code == 401:
            raise RuntimeError("Civitai 拒絕（401）：需要有效的 API key")
        if r.status_code == 403:
            raise RuntimeError("Civitai 拒絕（403）：這個檔案可能需要登入或是作者限制下載")
        r.raise_for_status()
        cd = r.headers.get("Content-Disposition", "")
        m = re.search(r"filename\*?=(?:UTF-8'')?\"?([^\";]+)", cd)
        filename = urllib.parse.unquote(m.group(1)) if m else job["filename"]
        filename = os.path.basename(filename)
        job["filename"] = filename
        job["total"] = int(r.headers.get("Content-Length") or 0)
        dest = os.path.join(job["folder"], filename)
        if os.path.exists(dest):
            raise RuntimeError(f"檔案已存在：{filename}")
        tmp = dest + ".part"
        done, last, last_t = 0, 0, time.time()
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(chunk_size=1024 * 1024):
                if job.get("cancel"):
                    raise RuntimeError("已取消")
                f.write(chunk)
                done += len(chunk)
                job["done"] = done
                now = time.time()
                if now - last_t >= 0.5:
                    job["speed"] = (done - last) / (now - last_t)
                    last, last_t = done, now
        os.replace(tmp, dest)
        base = os.path.splitext(dest)[0]
        _write_info(base, job["model"], job["version"], job.get("sha256"))
        img = job["version"].get("image")
        if img:
            try:
                ir = requests.get(re.sub(r"/width=\d+/", "/width=512/", img), headers={"User-Agent": UA}, timeout=60)
                if ir.ok:
                    ext = ".png" if "png" in ir.headers.get("Content-Type", "") else ".jpeg"
                    with open(base + ".preview" + ext, "wb") as f:
                        f.write(ir.content)
            except Exception:
                pass
        job["status"] = "done"
        _installed["at"] = 0
    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)
        try:
            tmp = os.path.join(job["folder"], job["filename"] + ".part")
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
    finally:
        job["finished"] = time.time()


SEARCH_PAGES = 5      # 一次搜尋最多往下翻幾頁來湊滿結果
SEARCH_TTL = 60       # 秒
SEARCH_MAX = 200      # 合併後最多回幾筆
_search_cache = {}    # 搜尋條件 -> (時間, Civitai 回的資料)


def register(routes):
    @routes.get("/yomu/api/settings")
    async def get_settings(request):
        k = api_key()
        return web.json_response({"civitai_api_key_set": bool(k), "civitai_api_key_tail": k[-4:] if k else ""})

    @routes.post("/yomu/api/settings")
    async def set_settings(request):
        body = await request.json()
        d = load_settings()
        if "civitai_api_key" in body:
            d["civitai_api_key"] = str(body["civitai_api_key"]).strip()
        save_settings(d)
        return web.json_response({"ok": True})

    async def fetch_page(params):
        """一頁搜尋結果；同樣的條件 60 秒內不重問 Civitai（來回切換篩選時很有感）"""
        key = json.dumps(params, sort_keys=True)
        hit = _search_cache.get(key)
        if hit and time.time() - hit[0] < SEARCH_TTL:
            return hit[1]
        r = await _to_thread(requests.get, API + "/models", params=params, headers=_headers(), timeout=30)
        if r.status_code != 200:
            raise RuntimeError(f"Civitai 回應 {r.status_code}")
        data = r.json()
        _search_cache[key] = (time.time(), data)
        while len(_search_cache) > 40:
            _search_cache.pop(next(iter(_search_cache)))
        return data

    async def collect(params, cursor, pages, limit):
        """從 Civitai 收一組結果；一頁沒湊滿就自動往下翻（最多 pages 頁）。回傳（模型清單, 下一頁游標）"""
        items, seen = [], set()
        for _ in range(pages):
            if cursor:
                params["cursor"] = cursor
            try:
                data = await fetch_page(params)
            except Exception:
                if not items:
                    raise
                break
            for m in data.get("items", []):
                if m["id"] not in seen:
                    seen.add(m["id"])
                    items.append(m)
            cursor = (data.get("metadata") or {}).get("nextCursor")
            if not cursor or len(items) >= limit:
                break
        return items, cursor

    @routes.get("/yomu/api/civitai/search")
    async def search(request):
        q = request.query
        limit = min(int(q.get("limit", "24")), 100)
        # 有關鍵字或底模篩選時，Civitai 是撈完一頁才濾；一次撈 100 筆才湊得到東西
        params = {"limit": 100 if (q.get("query") or q.get("baseModels")) else limit}
        query = (q.get("query") or "").strip()
        if query:
            params["query"] = query
        if q.get("types"):
            params["types"] = q["types"].split(",")
        if q.get("baseModels"):
            params["baseModels"] = q["baseModels"].split(",")
        if q.get("sort"):
            params["sort"] = q["sort"]
        if q.get("period"):
            params["period"] = q["period"]
        params["nsfw"] = "true" if q.get("nsfw") == "1" else "false"
        cursor = q.get("cursor")
        # 只靠名字搜會漏很多：Civitai 把 arknight 當詞幹比對（找不到名字寫單數的，要加底線才找得到），
        # 而且名字沒寫關鍵字、只掛標籤的（例如只叫角色名的 LoRA）也不會出來。
        # 所以第一頁同時搜：原詞、加底線的詞、單複數兩種標籤，合併後照排序排好；「載入更多」沿用原詞的游標。
        jobs = [(dict(params), cursor, SEARCH_PAGES)]
        if query and not cursor:
            no_query = {k: v for k, v in params.items() if k != "query"}
            jobs.append((dict(params, query=query[:-1] if query.endswith("_") else query + "_"), None, 1))
            tag = query.lower().replace("_", " ").strip()
            for t in dict.fromkeys([tag, tag[:-1] if tag.endswith("s") else tag + "s"]):
                jobs.append((dict(no_query, tag=t), None, 1))
        results = await asyncio.gather(*[collect(*job, limit) for job in jobs], return_exceptions=True)
        if isinstance(results[0], Exception):
            return web.json_response({"ok": False, "msg": f"連線失敗：{results[0]}"}, status=502)
        merged, seen = [], set()
        for res in results:
            if isinstance(res, Exception):
                continue
            for m in res[0]:
                if m["id"] not in seen:
                    seen.add(m["id"])
                    merged.append(slim_model(m))
        key = {"Most Downloaded": lambda m: m["downloads"] or 0, "Highest Rated": lambda m: m["likes"] or 0,
               "Newest": lambda m: (m["versions"][0]["publishedAt"] or "") if m["versions"] else ""}.get(q.get("sort"))
        if key and len(jobs) > 1:
            merged.sort(key=key, reverse=True)
        return web.json_response({"ok": True, "items": merged[:SEARCH_MAX], "nextCursor": results[0][1]})

    @routes.get("/yomu/api/civitai/model")
    async def model_detail(request):
        """單一模型的完整資料（列表 API 有時只帶部分版本）"""
        mid = request.query.get("id", "")
        try:
            r = await _to_thread(requests.get, f"{API}/models/{int(mid)}", headers=_headers(), timeout=30)
            if r.status_code != 200:
                return web.json_response({"ok": False, "msg": f"Civitai 回應 {r.status_code}"}, status=502)
            return web.json_response({"ok": True, "model": slim_model(r.json())})
        except Exception as e:
            return web.json_response({"ok": False, "msg": str(e)}, status=502)

    @routes.get("/yomu/api/civitai/images")
    async def images(request):
        """某個版本的社群圖片（比 /models 帶的多很多）"""
        q = request.query
        params = {"modelVersionId": q.get("versionId", ""), "limit": min(int(q.get("limit", "30")), 100), "sort": "Most Reactions",
                  "nsfw": "X" if q.get("nsfw") == "1" else "None"}
        try:
            r = await _to_thread(requests.get, API + "/images", params=params, headers=_headers(), timeout=30)
            if r.status_code != 200:
                return web.json_response({"ok": False, "images": []})
            items = r.json().get("items", [])
        except Exception:
            return web.json_response({"ok": False, "images": []})
        urls = [re.sub(r"/width=\d+/", "/width=450/", i["url"]) for i in items if isinstance(i, dict) and i.get("url") and i.get("type", "image") == "image"]
        return web.json_response({"ok": True, "images": urls})

    @routes.post("/yomu/api/civitai/download")
    async def download(request):
        body = await request.json()
        model, version, file = body.get("model"), body.get("version"), body.get("file")
        if not (model and version and file):
            return web.json_response({"ok": False, "msg": "缺少參數"}, status=400)
        folder_kind = target_folder(model.get("type"), version.get("baseModel"))
        if not folder_kind:
            return web.json_response({"ok": False, "msg": f"不支援的類型：{model.get('type')}"}, status=400)
        folders = folder_paths.get_folder_paths(folder_kind)
        if not folders:
            return web.json_response({"ok": False, "msg": f"找不到資料夾 {folder_kind}"}, status=500)
        if not api_key():
            return web.json_response({"ok": False, "msg": "還沒設定 Civitai API key"}, status=400)
        url = file.get("downloadUrl") or f"https://civitai.com/api/download/models/{version.get('id')}"
        with _dl_lock:
            _dl_seq[0] += 1
            job = {
                "id": _dl_seq[0], "status": "queued", "model": model, "version": version, "modelName": model.get("name"),
                "versionName": version.get("name"), "kind": folder_kind, "folder": folders[0], "url": url,
                "filename": file.get("name") or f"model_{version.get('id')}.safetensors", "sha256": (file.get("hashes") or {}).get("SHA256"),
                "total": int((file.get("sizeKB") or 0) * 1024), "done": 0, "speed": 0, "started": time.time(), "finished": 0, "error": None,
            }
            _downloads[job["id"]] = job
        threading.Thread(target=_download_job, args=(job,), daemon=True).start()
        return web.json_response({"ok": True, "id": job["id"]})

    @routes.get("/yomu/api/civitai/downloads")
    async def downloads(request):
        with _dl_lock:
            out = [{k: v for k, v in j.items() if k not in ("model", "version", "url")} for j in _downloads.values()]
        out.sort(key=lambda j: -j["id"])
        return web.json_response(out)

    @routes.post("/yomu/api/civitai/download/cancel")
    async def cancel(request):
        jid = int(request.query.get("id", "0"))
        with _dl_lock:
            job = _downloads.get(jid)
            if job and job["status"] in ("queued", "downloading"):
                job["cancel"] = True
            elif job:
                _downloads.pop(jid, None)
        return web.json_response({"ok": True})


async def _to_thread(fn, *a, **kw):
    return await asyncio.to_thread(fn, *a, **kw)
