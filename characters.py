"""
角色卡：WAI 角色資料包（huggingface.co/datasets/flagrantia/character_select_stand_alone_app，MIT 授權）
5000 多個動漫角色的中文名、Danbooru 標籤與縮圖。按「下載角色資料包」才會下載，存在 cache/characters/。
資料包的中文名是簡體，用 characters_s2t.json（逐字對照，拿掉了「后、里、干」這類一字多義的字）轉成繁體；搜尋字也一樣轉，打簡體繁體都找得到。

  GET  /yomu/api/characters?q=&limit=     搜尋角色（中文名 / 標籤；空字串 = 最熱門）
  GET  /yomu/api/characters/thumb?id=     縮圖（webp）
  GET  /yomu/api/characters/status        資料包狀態與下載進度
  GET  /yomu/api/characters/check         Hugging Face 上有沒有新版（打開 Yomu 時問一次）
  POST /yomu/api/characters/download      下載 / 更新到最新版
"""
import asyncio
import base64
import csv
import gzip
import json
import os
import re
import shutil
import threading

import requests
from aiohttp import web

from . import _load_tags

HF = "https://huggingface.co/datasets/flagrantia/character_select_stand_alone_app/resolve/main/"
HF_TREE = "https://huggingface.co/api/datasets/flagrantia/character_select_stand_alone_app/tree/main"
# 作者配合新版 WAI 模型另外放一組新版號的檔案（v120、v160…），不覆蓋舊的
THUMBS_JSON, MD5_CSV, NAMES_CSV = "wai_character_thumbs_v{}.json", "wai_character_md5_v{}.csv", "wai_characters_v{}.csv"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CHAR_DIR = os.path.join(BASE_DIR, "cache", "characters")
THUMB_DIR = os.path.join(CHAR_DIR, "thumbs")
with open(os.path.join(BASE_DIR, "characters_s2t.json"), encoding="utf-8") as _f:
    S2T = str.maketrans(json.load(_f))

_job = {"running": False, "done": 0, "total": 0, "error": None}
_chars = None
_lock = threading.Lock()


def installed_version():
    """已下載的版本號（名單和 md5 都在才算）；沒裝回 None"""
    if not os.path.isdir(CHAR_DIR):
        return None
    versions = [int(m[1]) for f in os.listdir(CHAR_DIR) if (m := re.fullmatch(r"wai_characters_v(\d+)\.csv", f))
                and os.path.isfile(os.path.join(CHAR_DIR, MD5_CSV.format(m[1])))]
    return max(versions, default=None)


def latest_version():
    """Hugging Face 上三個檔都齊的最新版本號"""
    r = requests.get(HF_TREE, timeout=20)
    r.raise_for_status()
    names = {f["path"] for f in r.json()}
    versions = {int(m[1]) for n in names if (m := re.fullmatch(r"wai_characters_v(\d+)\.csv", n))}
    return max((v for v in versions if all(f.format(v) in names for f in (THUMBS_JSON, MD5_CSV, NAMES_CSV))), default=None)


def _download(name, dest):
    r = requests.get(HF + name, stream=True, timeout=60)
    r.raise_for_status()
    _job.update(done=0, total=int(r.headers.get("Content-Length") or 0))
    with open(dest + ".part", "wb") as f:
        for chunk in r.iter_content(chunk_size=1024 * 1024):
            f.write(chunk)
            _job["done"] += len(chunk)
    os.replace(dest + ".part", dest)


def _download_job():
    global _chars
    try:
        version = latest_version()
        if version is None:
            raise RuntimeError("Hugging Face 上找不到角色資料包")
        old = installed_version()
        os.makedirs(CHAR_DIR, exist_ok=True)
        thumbs = os.path.join(CHAR_DIR, THUMBS_JSON.format(version))
        _download(THUMBS_JSON.format(version), thumbs)
        with open(thumbs, "r", encoding="utf-8") as f:
            data = json.load(f)
        shutil.rmtree(THUMB_DIR, ignore_errors=True)      # 新版的縮圖 md5 不一樣，舊的整個換掉
        os.makedirs(THUMB_DIR)
        for md5, b64 in data.items():     # base64(gzip(webp)) → 一張一個檔，之後直接當靜態檔送
            if re.fullmatch(r"[0-9a-f]{32}", md5):
                with open(os.path.join(THUMB_DIR, md5 + ".webp"), "wb") as out:
                    out.write(gzip.decompress(base64.b64decode(b64)))
        os.remove(thumbs)
        for name in (MD5_CSV, NAMES_CSV):     # 名單最後下載：有名單 = 資料包完整
            _download(name.format(version), os.path.join(CHAR_DIR, name.format(version)))
        if old is not None and old != version:
            for name in (MD5_CSV, NAMES_CSV):
                os.remove(os.path.join(CHAR_DIR, name.format(old)))
        with _lock:
            _chars = None
    except Exception as e:
        _job["error"] = str(e)
    _job["running"] = False


def _load():
    """[(標籤, 名字, 作品, md5, Danbooru 投稿數)]，熱門的在前"""
    global _chars
    with _lock:
        version = installed_version()
        if _chars is None and version is not None:
            with open(os.path.join(CHAR_DIR, MD5_CSV.format(version)), encoding="utf-8-sig") as f:
                md5 = {row[0]: row[1] for row in csv.reader(f) if len(row) >= 2}
            counts = {tag: count for tag, cat, count, aliases in _load_tags() if cat == 4}
            rows = []
            with open(os.path.join(CHAR_DIR, NAMES_CSV.format(version)), encoding="utf-8-sig") as f:
                for row in csv.reader(f):
                    if len(row) < 2:
                        continue
                    full = row[0].translate(S2T)
                    m = re.match(r"^(.+)（([^（）]+)）$", full)     # 「神代類（世界計劃）」→ 名字 + 作品
                    name, series = (m[1], m[2]) if m else (full, "")
                    rows.append((row[1], name, series, md5.get(row[1], ""), counts.get(row[1].replace(" ", "_"), 0)))
            rows.sort(key=lambda r: -r[4])
            _chars = rows
        return _chars or []


def search(q, limit):
    rows = _load()
    q = q.strip().lower().replace("_", " ").translate(S2T)
    if not q:
        return rows[:limit]
    starts, contains = [], []
    for row in rows:
        tag, name, series = row[0], row[1].lower(), row[2].lower()
        if tag.startswith(q) or name.startswith(q) or any(w.startswith(q) for w in re.split(r"[ ()]+", tag)):
            starts.append(row)
        elif q in tag or q in name or q in series:
            contains.append(row)
    return (starts + contains)[:limit]


def register(routes):
    @routes.get("/yomu/api/characters")
    async def characters(request):
        limit = min(int(request.query.get("limit", "60")), 200)
        return web.json_response([
            {"tag": t, "name": n, "series": s, "id": m, "count": c}
            for t, n, s, m, c in search(request.query.get("q", ""), limit)
        ])

    @routes.get("/yomu/api/characters/thumb")
    async def thumb(request):
        cid = request.query.get("id", "")
        path = os.path.join(THUMB_DIR, cid + ".webp")
        if not re.fullmatch(r"[0-9a-f]{32}", cid) or not os.path.isfile(path):
            return web.Response(status=404)
        return web.FileResponse(path, headers={"Content-Type": "image/webp", "Cache-Control": "max-age=604800"})

    @routes.get("/yomu/api/characters/status")
    async def status(request):
        return web.json_response({"installed": installed_version() is not None, "version": installed_version(), "count": len(_load()), **_job})

    @routes.get("/yomu/api/characters/check")
    async def check(request):
        try:
            latest = await asyncio.to_thread(latest_version)
        except Exception as e:
            return web.json_response({"update": False, "error": str(e)})
        current = installed_version()
        return web.json_response({"update": bool(latest and current and latest > current), "version": current, "latest": latest})

    @routes.post("/yomu/api/characters/download")
    async def download(request):
        with _lock:
            if _job["running"]:
                return web.json_response({"ok": False, "msg": "已經在下載中"})
            _job.update(running=True, done=0, total=0, error=None)
        threading.Thread(target=_download_job, daemon=True).start()
        return web.json_response({"ok": True})
