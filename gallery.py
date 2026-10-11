"""
圖庫後端：掃 output/ 資料夾、分頁列出、產縮圖（磁碟快取）、只讀 PNG 文字區塊的參數。

  GET /yomu/api/gallery?offset=&limit=&q=&refresh=1
  GET /yomu/api/thumb?filename=&subfolder=&size=256
  GET /yomu/api/pnginfo?filename=&subfolder=
"""
import asyncio
import hashlib
import mimetypes
import os
import struct
import threading
import time
import zlib

from aiohttp import web
from PIL import Image

import folder_paths

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
THUMB_DIR = os.path.join(BASE_DIR, "cache", "thumbs")
mimetypes.add_type("image/webp", ".webp")
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm", ".mkv")
VIDEO_EXTS = (".mp4", ".webm", ".mkv")
SCAN_TTL = 60.0           # 幾秒內重複請求不重掃（開圖庫、生完圖時前端會強制重掃）

_cache = {"items": [], "scanned": 0.0, "root": None}
_lock = threading.Lock()


def _output_root():
    return os.path.abspath(folder_paths.get_output_directory())


def _safe_path(filename, subfolder):
    """把 filename/subfolder 解析成 output 內的絕對路徑；跳脫出去就回 None"""
    root = _output_root()
    rel = os.path.normpath(os.path.join(subfolder or "", os.path.basename(filename)))
    full = os.path.abspath(os.path.join(root, rel))
    if not full.startswith(root + os.sep) and full != root:
        return None
    return full


def _scan():
    root = _output_root()
    items = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        sub = os.path.relpath(dirpath, root).replace("\\", "/")
        if sub == ".":
            sub = ""
        for fn in filenames:
            if not fn.lower().endswith(IMAGE_EXTS):
                continue
            try:
                st = os.stat(os.path.join(dirpath, fn))
            except OSError:
                continue
            items.append({"filename": fn, "subfolder": sub, "mtime": int(st.st_mtime), "size": st.st_size})
    items.sort(key=lambda x: (-x["mtime"], x["filename"]))
    return items


def get_items(force=False):
    with _lock:
        now = time.time()
        if force or _cache["root"] != _output_root() or now - _cache["scanned"] > SCAN_TTL:
            _cache["items"] = _scan()
            _cache["scanned"] = now
            _cache["root"] = _output_root()
        return _cache["items"]


def _thumb_path(full, size):
    st = os.stat(full)
    key = hashlib.sha1(f"{full}|{st.st_mtime_ns}|{st.st_size}|{size}".encode("utf-8", "surrogateescape")).hexdigest()
    return os.path.join(THUMB_DIR, key[:2], key + ".webp")


def _make_thumb(full, size):
    out = _thumb_path(full, size)
    if os.path.isfile(out):
        return out
    os.makedirs(os.path.dirname(out), exist_ok=True)
    if full.lower().endswith(VIDEO_EXTS):
        img = _video_frame(full)
        img.thumbnail((size, size), Image.Resampling.LANCZOS)
        tmp = out + f".{threading.get_ident()}.tmp"
        img.save(tmp, "WEBP", quality=90, method=4)
        os.replace(tmp, out)
        return out
    with Image.open(full) as img:
        img.draft("RGB", (size * 2, size * 2))       # JPEG 可以直接低解析度解碼
        img.thumbnail((size, size), Image.Resampling.LANCZOS)
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGB")
        tmp = out + f".{threading.get_ident()}.tmp"
        img.save(tmp, "WEBP", quality=90, method=4)
    os.replace(tmp, out)
    return out


def _video_frame(full):
    """影片縮圖：用 PyAV 抓約第 0.5 秒那一格"""
    import av
    with av.open(full) as c:
        stream = c.streams.video[0]
        target = 0.5
        for frame in c.decode(stream):
            t = float(frame.pts * stream.time_base) if frame.pts is not None else 0
            if t >= target:
                return frame.to_image()
            last = frame
        return last.to_image()


def read_png_text(full):
    """只讀 PNG 的 tEXt/iTXt/zTXt 區塊，碰到 IDAT 就停，不解碼像素"""
    out = {}
    with open(full, "rb") as f:
        if f.read(8) != b"\x89PNG\r\n\x1a\n":
            return out
        while True:
            head = f.read(8)
            if len(head) < 8:
                break
            length, ctype = struct.unpack(">I4s", head)
            if ctype in (b"IDAT", b"IEND"):
                break
            body = f.read(length)
            f.read(4)                                  # CRC
            try:
                if ctype == b"tEXt":
                    k, v = body.split(b"\x00", 1)
                    out[k.decode("latin-1")] = v.decode("utf-8", "replace")
                elif ctype == b"iTXt":
                    k, rest = body.split(b"\x00", 1)
                    comp = rest[0]
                    rest = rest[2:]
                    _lang, rest = rest.split(b"\x00", 1)
                    _tkey, txt = rest.split(b"\x00", 1)
                    if comp:
                        txt = zlib.decompress(txt)
                    out[k.decode("latin-1")] = txt.decode("utf-8", "replace")
                elif ctype == b"zTXt":
                    k, rest = body.split(b"\x00", 1)
                    out[k.decode("latin-1")] = zlib.decompress(rest[1:]).decode("utf-8", "replace")
            except Exception:
                pass
    return out


def register(routes):
    @routes.get("/yomu/api/gallery")
    async def gallery(request):
        q = request.query
        force = q.get("refresh") == "1"
        items = await asyncio.to_thread(get_items, force)
        needle = q.get("q", "").strip().lower()
        if needle:
            items = [i for i in items if needle in i["filename"].lower() or needle in i["subfolder"].lower()]
        offset = max(0, int(q.get("offset", "0")))
        limit = max(1, min(500, int(q.get("limit", "200"))))
        return web.json_response({"total": len(items), "offset": offset, "items": items[offset:offset + limit]})

    @routes.get("/yomu/api/thumb")
    async def thumb(request):
        q = request.query
        full = _safe_path(q.get("filename", ""), q.get("subfolder", ""))
        if not full or not os.path.isfile(full):
            return web.Response(status=404, text="not found")
        size = max(64, min(1024, int(q.get("size", "256"))))
        try:
            path = await asyncio.to_thread(_make_thumb, full, size)
        except Exception as e:
            return web.Response(status=500, text=f"thumb failed: {e}")
        return web.FileResponse(path, headers={"Content-Type": "image/webp", "Cache-Control": "public, max-age=31536000, immutable"})

    @routes.get("/yomu/api/video-frame")
    async def video_frame(request):
        """抓影片的最後（或第一）一格，原始解析度 PNG：拿來當圖生影片的來源，接著動"""
        q = request.query
        full = _safe_path(q.get("filename", ""), q.get("subfolder", ""))
        if not full or not os.path.isfile(full):
            return web.Response(status=404)
        which = q.get("which", "last")
        def grab():
            import av, io
            with av.open(full) as c:
                stream = c.streams.video[0]
                last = None
                for frame in c.decode(stream):
                    last = frame
                    if which == "first":
                        break
                buf = io.BytesIO(); last.to_image().save(buf, "PNG"); return buf.getvalue()
        try:
            data = await asyncio.to_thread(grab)
        except Exception as e:
            return web.json_response({"ok": False, "msg": str(e)}, status=500)
        return web.Response(body=data, content_type="image/png")

    @routes.post("/yomu/api/image-delete")
    async def image_delete(request):
        """把 output 裡的圖/影片移到資源回收筒（PowerShell，不需額外套件）"""
        q = request.query
        full = _safe_path(q.get("filename", ""), q.get("subfolder", ""))
        if not full or not os.path.isfile(full):
            return web.json_response({"ok": False, "msg": "找不到檔案"}, status=404)
        import subprocess
        script = ("Add-Type -AssemblyName Microsoft.VisualBasic; "
                  "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('" + full.replace("'", "''") + "', 'OnlyErrorDialogs', 'SendToRecycleBin')")
        def run():
            r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], capture_output=True, text=True, creationflags=0x08000000, timeout=60)
            if r.returncode != 0:
                raise RuntimeError(r.stderr.strip() or "刪除失敗")
        try:
            await asyncio.to_thread(run)
        except Exception as e:
            return web.json_response({"ok": False, "msg": str(e)}, status=500)
        get_items(True)
        return web.json_response({"ok": True})

    @routes.get("/yomu/api/pnginfo")
    async def pnginfo(request):
        q = request.query
        full = _safe_path(q.get("filename", ""), q.get("subfolder", ""))
        if not full or not os.path.isfile(full):
            return web.Response(status=404, text="not found")
        if not full.lower().endswith(".png"):
            return web.json_response({})
        return web.json_response(await asyncio.to_thread(read_png_text, full))
