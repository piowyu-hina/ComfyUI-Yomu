"""
字卡（wildcards）：models/wildcards/**/*.txt|yaml，一行一個選項；提示詞裡用 __名字__ 引用。

  GET  /yomu/api/wildcards?q=&limit=      搜尋字卡（名字 = 相對路徑去副檔名，用 / 分隔）
  GET  /yomu/api/wildcard?name=           某張字卡的全部行
  POST /yomu/api/wildcards/save {name, text}   存到 models/wildcards/我的/<name>.txt
  POST /yomu/api/wildcards/delete {name}
"""
import os
import re
import threading
import time

from aiohttp import web

import folder_paths

WC_DIR = os.path.join(folder_paths.models_dir, "wildcards")
MINE = "我的"
_index = {"at": 0, "items": {}}      # name -> {path, mtime, count, preview}
_lock = threading.Lock()


def _read_lines(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            raw = f.read()
    except OSError:
        return []
    if path.lower().endswith((".yaml", ".yml")):
        # 極簡 yaml：只吃「- 項目」清單行
        return [l.strip()[2:].strip().strip("'\"") for l in raw.splitlines() if l.strip().startswith("- ")]
    return [l.strip() for l in raw.splitlines() if l.strip() and not l.strip().startswith("#")]


def _scan():
    items = {}
    if not os.path.isdir(WC_DIR):
        return items
    for dirpath, dirnames, filenames in os.walk(WC_DIR):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for fn in filenames:
            if not fn.lower().endswith((".txt", ".yaml", ".yml")):
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, WC_DIR).replace("\\", "/")
            name = os.path.splitext(rel)[0]
            try:
                st = os.stat(full)
            except OSError:
                continue
            items[name] = {"path": full, "mtime": st.st_mtime, "size": st.st_size}
    return items


def index(force=False):
    with _lock:
        if force or time.time() - _index["at"] > 30:
            _index["items"] = _scan()
            _index["at"] = time.time()
        return _index["items"]


def _safe_name(name):
    name = name.replace("\\", "/").strip("/ ")
    if not name or ".." in name or not re.fullmatch(r"[\w\-一-鿿 /.&()+]+", name):
        return None
    return name


def resolve(name):
    """__名字__：先找完整路徑，找不到就用檔名（最後一段）比對；回 (完整名, item)"""
    items = index()
    if name in items:
        return name, items[name]
    low = os.path.basename(name).lower()
    hits = [n for n in items if os.path.basename(n).lower() == low]
    hits.sort(key=lambda n: (n.count("/"), n))          # 越淺的優先（避免 20k 角色檔搶名）
    return (hits[0], items[hits[0]]) if hits else (None, None)


def short_name(name):
    """能只用檔名就只用檔名（唯一時）"""
    items = index()
    low = os.path.basename(name).lower()
    same = [n for n in items if os.path.basename(n).lower() == low]
    return os.path.basename(name) if len(same) == 1 else name


def register(routes):
    @routes.get("/yomu/api/wildcards/groups")
    async def groups(request):
        """依第一層資料夾分組：{group: {count, files:[{name, short, count}]}}；大組（>300）只回數量"""
        items = index(request.query.get("refresh") == "1")
        out = {}
        for n in sorted(items):
            g = n.split("/")[0] if "/" in n else "（未分類）"
            out.setdefault(g, {"count": 0, "files": []})
            out[g]["count"] += 1
        for g, d in out.items():
            if d["count"] <= 300:
                for n in sorted(items):
                    if (n.split("/")[0] if "/" in n else "（未分類）") == g:
                        d["files"].append({"name": n, "short": short_name(n), "count": len(_read_lines(items[n]["path"]))})
        return web.json_response(out)

    @routes.get("/yomu/api/wildcards")
    async def wildcards(request):
        q = request.query.get("q", "").strip().lower()
        limit = min(int(request.query.get("limit", "60")), 500)
        items = index(request.query.get("refresh") == "1")
        names = sorted(items)
        if q:
            starts = [n for n in names if os.path.basename(n).lower().startswith(q)]
            contains = [n for n in names if q in n.lower() and n not in starts]
            names = starts + contains
        out = []
        for n in names[:limit]:
            it = items[n]
            lines = _read_lines(it["path"])
            out.append({"name": n, "short": short_name(n), "count": len(lines), "preview": lines[:3], "mine": n.startswith(MINE + "/")})
        return web.json_response({"total": len(names), "items": out})

    @routes.get("/yomu/api/wildcard")
    async def wildcard(request):
        full, it = resolve(request.query.get("name", ""))
        if not it:
            return web.json_response({"ok": False, "lines": []}, status=404)
        return web.json_response({"ok": True, "name": full, "lines": _read_lines(it["path"])[:5000]})

    @routes.post("/yomu/api/wildcards/save")
    async def save(request):
        body = await request.json()
        name = _safe_name(str(body.get("name", "")))
        if not name:
            return web.json_response({"ok": False, "msg": "名字不合法"}, status=400)
        if not name.startswith(MINE + "/"):
            name = MINE + "/" + name
        path = os.path.join(WC_DIR, name + ".txt")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(str(body.get("text", "")).replace("\r\n", "\n"))
        index(True)
        return web.json_response({"ok": True, "name": name})

    @routes.post("/yomu/api/wildcards/delete")
    async def delete(request):
        body = await request.json()
        name = str(body.get("name", ""))
        it = index().get(name)
        if not it or not name.startswith(MINE + "/"):
            return web.json_response({"ok": False, "msg": "只能刪「我的」字卡"}, status=400)
        os.remove(it["path"])
        index(True)
        return web.json_response({"ok": True})
