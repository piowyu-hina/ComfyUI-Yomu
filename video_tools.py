"""
影片放大（外部工具 Video2X，Vulkan/ncnn，不佔 ComfyUI 的顯存排程）

  POST /yomu/api/video/upscale   {filename, subfolder, type, engine, scale, noise}  → {id}
  GET  /yomu/api/video/upscale/status?id=…  → {running, ok, progress, log, out}
  POST /yomu/api/video/upscale/cancel {id}

工具放在 D:/ComfyUI/tools/video2x/video2x.exe；輸出到 output/Yomu/video/<原檔名>_x<倍率>.mp4
"""
import os
import re
import subprocess
import threading
import time
import uuid

from aiohttp import web

import folder_paths

TOOLS_DIR = os.path.join(folder_paths.base_path, "tools")
VIDEO2X = os.path.join(TOOLS_DIR, "video2x", "video2x.exe")
OUT_SUB = os.path.join("Yomu", "video")

ENGINES = {
    "realesrgan": {"label": "Real-ESRGAN 動漫影片版（推薦）"},
    "realcugan": {"label": "Real-CUGAN（這台跑很慢）"},
    "libplacebo": {"label": "Anime4K（最快、效果最淡）"},
}


def _video_size(path):
    import av
    with av.open(path) as c:
        s = c.streams.video[0]
        return s.width, s.height
_jobs = {}
_lock = threading.Lock()


def _src_path(filename, subfolder, typ):
    base = {"output": folder_paths.get_output_directory(), "input": folder_paths.get_input_directory(), "temp": folder_paths.get_temp_directory()}.get(typ or "output")
    root = os.path.abspath(base)
    full = os.path.abspath(os.path.join(root, subfolder or "", os.path.basename(filename)))
    return full if full.startswith(root) and os.path.isfile(full) else None


def _build_cmd(src, dst, engine, scale, noise):
    cmd = [VIDEO2X, "-i", src, "-o", dst, "-p", engine]
    if engine == "realcugan":
        cmd += ["-s", str(scale), "-n", str(noise), "--realcugan-model", "models-se"]
    elif engine == "realesrgan":
        cmd += ["-s", str(scale), "--realesrgan-model", "realesr-animevideov3"]
    elif engine == "libplacebo":   # Anime4K 要給輸出尺寸
        w, h = _video_size(src)
        cmd += ["-w", str(w * scale), "-h", str(h * scale), "--libplacebo-shader", "anime4k-v4-a"]
    cmd += ["-c", "libx264", "-e", "crf=18", "-e", "preset=medium", "--pix-fmt", "yuv420p"]
    return cmd


def _run(job):
    try:
        job["log"].append("$ " + " ".join(job["cmd"]))
        p = subprocess.Popen(job["cmd"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                             creationflags=0x08000000, cwd=os.path.dirname(VIDEO2X))
        job["proc"] = p
        buf = ""
        while True:   # 進度列用 \r 蓋寫，所以自己切
            ch = p.stdout.read(1)
            if not ch:
                break
            if ch not in ("\r", "\n"):
                buf += ch
                continue
            line = buf.strip().replace("\x1b[K", ""); buf = ""
            if not line:
                continue
            m = re.search(r"frame=(\d+)/(\d+)", line)
            if m:
                job["progress"] = int(m.group(1)) / max(1, int(m.group(2)))
                job["log"][-1:] = [line[-200:]] if job["log"] and job["log"][-1].startswith("frame=") else job["log"] + [line[-200:]]
                continue
            if "[info]" in line and "FFmpeg" in line:
                continue
            job["log"].append(line[-300:])
            if len(job["log"]) > 200:
                del job["log"][:-150]
        rc = p.wait()
        # Video2X 6.4 寫完檔案後偶爾在收尾時當掉（0xC0000005），輸出檔其實是好的：以「檔案存在且能解碼」為準
        def _valid(path):
            try:
                import av
                with av.open(path) as c:
                    return c.streams.video[0].frames > 0 or c.duration
            except Exception:
                return False
        if os.path.isfile(job["dst"]) and os.path.getsize(job["dst"]) > 0 and _valid(job["dst"]):
            job["ok"] = True
            job["out"] = {"filename": os.path.basename(job["dst"]), "subfolder": OUT_SUB.replace("\\", "/"), "type": "output"}
        else:
            job["ok"] = False
            job["log"].append(f"結束碼 {rc}")
    except Exception as e:
        job["ok"] = False
        job["log"].append("錯誤：" + str(e))
    finally:
        job["running"] = False
        job["elapsed"] = time.time() - job["t0"]
        try:
            from .gallery import get_items
            get_items(True)
        except Exception:
            pass


def register(routes):
    @routes.get("/yomu/api/video/tools")
    async def tools(request):
        return web.json_response({"video2x": os.path.isfile(VIDEO2X), "engines": {k: v["label"] for k, v in ENGINES.items()}})

    @routes.post("/yomu/api/video/upscale")
    async def upscale(request):
        b = await request.json()
        if not os.path.isfile(VIDEO2X):
            return web.json_response({"ok": False, "msg": "找不到 tools/video2x/video2x.exe"}, status=500)
        src = _src_path(b.get("filename", ""), b.get("subfolder", ""), b.get("type", "output"))
        if not src:
            return web.json_response({"ok": False, "msg": "找不到影片"}, status=404)
        engine = b.get("engine") if b.get("engine") in ENGINES else "realcugan"
        scale = int(b.get("scale") or 2); scale = scale if scale in (2, 3, 4) else 2
        noise = max(-1, min(3, int(b.get("noise") if b.get("noise") is not None else 0)))
        out_dir = os.path.join(folder_paths.get_output_directory(), OUT_SUB); os.makedirs(out_dir, exist_ok=True)
        stem = re.sub(r"_x\d$", "", os.path.splitext(os.path.basename(src))[0])
        dst = os.path.join(out_dir, f"{stem}_x{scale}.mp4")
        i = 1
        while os.path.exists(dst):
            i += 1; dst = os.path.join(out_dir, f"{stem}_x{scale}_{i}.mp4")
        with _lock:
            if any(j["running"] for j in _jobs.values()):
                return web.json_response({"ok": False, "msg": "已經有一支影片在放大了，等它完成"}, status=409)
            jid = uuid.uuid4().hex[:10]
            job = {"id": jid, "running": True, "ok": None, "progress": 0.0, "log": [], "out": None, "dst": dst, "t0": time.time(), "proc": None,
                   "cmd": _build_cmd(src, dst, engine, scale, noise)}
            _jobs[jid] = job
        threading.Thread(target=_run, args=(job,), daemon=True).start()
        return web.json_response({"ok": True, "id": jid})

    @routes.get("/yomu/api/video/upscale/status")
    async def status(request):
        job = _jobs.get(request.query.get("id", ""))
        if not job:
            return web.json_response({"ok": False, "msg": "沒有這個工作"}, status=404)
        return web.json_response({"running": job["running"], "ok": job["ok"], "progress": job["progress"], "log": job["log"][-12:],
                                  "out": job["out"], "elapsed": job.get("elapsed") or (time.time() - job["t0"])})

    @routes.post("/yomu/api/video/upscale/cancel")
    async def cancel(request):
        b = await request.json()
        job = _jobs.get(b.get("id", ""))
        if job and job["running"] and job["proc"]:
            try:
                job["proc"].kill()
            except Exception:
                pass
        return web.json_response({"ok": True})
