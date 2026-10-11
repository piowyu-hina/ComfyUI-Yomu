"""
Yomu 安裝程式 —— 在 http://127.0.0.1:8190 開一個小網頁，幫沒有 ComfyUI 的人下載並裝好 ComfyUI + Yomu。

只用 Python 標準庫。流程：git clone ComfyUI → 建 venv → 裝 PyTorch → 裝 ComfyUI 相依 →
git clone Yomu 與勾選的自訂節點 → 桌面捷徑。模型不在這裡下載，進 Yomu 後從缺模型視窗 / Civitai 瀏覽器裝。
"""
import json
import os
import shutil
import re
import subprocess
import sys
import threading
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
HOST, PORT = "127.0.0.1", 8190
YOMU_REPO = "https://github.com/piowyu-hina/ComfyUI-Yomu.git"
COMFY_REPO = "https://github.com/comfyanonymous/ComfyUI.git"
NODES = [
    ("impact", "修手 / 臉部修復（Impact Pack）", True, [
        "https://github.com/ltdrdata/ComfyUI-Impact-Pack.git",
        "https://github.com/ltdrdata/ComfyUI-Impact-Subpack.git"]),
    ("tagger", "反推提示詞（WD14 Tagger）", False, ["https://github.com/pythongosssss/ComfyUI-WD14-Tagger.git"]),
    ("mmaudio", "影片配音效（MMAudio）", False, ["https://github.com/kijai/ComfyUI-MMAudio.git"]),
    ("rife", "影片補幀（Frame Interpolation）", False, ["https://github.com/Fannovel16/ComfyUI-Frame-Interpolation.git"]),
]
NO_WINDOW = 0x08000000
MIN_FREE_GB = 12

_job = {"running": False, "ok": None, "log": [], "step": 0, "steps": 1, "dest": "", "name": "", "file": "", "now": "", "last": 0.0}
_lock = threading.Lock()
PIP_PROGRESS = re.compile(r"^Progress (\d+) of (\d+)$")
GIT_PROGRESS = re.compile(r"^\s*(Updating files:|Receiving objects:|Resolving deltas:|remote: )")


def note(text):
    """目前在做什麼（只顯示最新一行，不進記錄）"""
    with _lock:
        _job.update(now=text, last=time.time())


def log(line):
    with _lock:
        _job["log"].append(line)
    note(line.strip())


def run(args, cwd=None, env=None):
    log("$ " + " ".join(args))
    env = dict(os.environ if env is None else env, PIP_PROGRESS_BAR="raw")
    p = subprocess.Popen(args, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                         encoding="utf-8", errors="replace", creationflags=NO_WINDOW)
    for line in p.stdout:
        line = line.rstrip()
        progress = PIP_PROGRESS.match(line)
        if progress:
            done, total = int(progress[1]), int(progress[2])
            note(f"{_job['file']}  {done * 100 // total}%（{done >> 20} / {total >> 20} MB）")
        elif GIT_PROGRESS.match(line):
            note(line.strip())
        else:
            if line.lstrip().startswith("Downloading "):
                _job["file"] = line.split()[1]
            log("  " + line)
    return p.wait()


def step(text):
    with _lock:
        _job["step"] += 1
        _job["name"] = text
        _job["log"].append(f"== {text} ==")
    note(text)


def find_git():
    git = shutil.which("git")
    for c in (r"C:\Program Files\Git\cmd\git.exe", r"C:\Program Files (x86)\Git\cmd\git.exe"):
        git = git or (c if os.path.isfile(c) else None)
    if git:
        os.environ["PATH"] = os.path.dirname(git) + os.pathsep + os.environ["PATH"]
    return git


def detect_gpu():
    """回傳 (顯卡名稱, PyTorch 的 CUDA 版本)；沒有 NVIDIA 顯卡就是 (None, 'cpu')"""
    try:
        out = subprocess.check_output(["nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader"],
                                      text=True, creationflags=NO_WINDOW).strip().splitlines()[0]
        name, driver = [x.strip() for x in out.split(",")]
    except (OSError, subprocess.CalledProcessError, IndexError, ValueError):
        return None, "cpu"
    major = int(driver.split(".")[0])
    return name, "cu130" if major >= 580 else "cu128" if major >= 570 else "cu126"


def yomu_repo():
    if YOMU_REPO:
        return YOMU_REPO
    root = os.path.dirname(HERE)
    try:
        top = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], cwd=HERE, text=True,
                                     stderr=subprocess.DEVNULL, creationflags=NO_WINDOW).strip()
        if os.path.normcase(os.path.abspath(top)) != os.path.normcase(root):
            return ""
        return subprocess.check_output(["git", "remote", "get-url", "origin"], cwd=HERE, text=True,
                                       stderr=subprocess.DEVNULL, creationflags=NO_WINDOW).strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def clone(url, path):
    if os.path.isdir(os.path.join(path, ".git")):
        log(f"  {os.path.basename(path)} 已存在，略過")
        return True
    return run(["git", "clone", "--filter=blob:none", url, path]) == 0


def install_requirements(py, path):
    req = os.path.join(path, "requirements.txt")
    if os.path.isfile(req) and run([py, "-m", "pip", "install", "-r", req], path) != 0:
        log(f"!! {os.path.basename(path)} 的相依套件沒裝成功，該功能可能無法使用")


def make_shortcut(dest, vbs):
    env = dict(os.environ, YOMU_VBS=vbs, YOMU_DEST=dest, YOMU_ICO=os.path.join(os.path.dirname(os.path.dirname(vbs)), "assets", "yomu.ico"))
    ps = ("$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\\Yomu.lnk');"
          "$s.TargetPath='wscript.exe';$s.Arguments='\"'+$env:YOMU_VBS+'\"';$s.IconLocation=$env:YOMU_ICO;"
          "$s.WorkingDirectory=$env:YOMU_DEST;$s.Save()")
    return run(["powershell", "-NoProfile", "-Command", ps], env=env) == 0


def install_job(opts):
    dest = os.path.abspath(opts["dest"])
    groups = [g for g in NODES if g[0] in opts["nodes"]]
    repos = [(u, os.path.join(dest, "custom_nodes", u.rsplit("/", 1)[1][:-4])) for g in groups for u in g[3]]
    with _lock:
        _job.update(running=True, ok=None, log=[], step=0, steps=6 + len(repos), dest=dest, name="", file="", now="", last=time.time())
    ok = False
    try:
        step("檢查 Git")
        if not find_git():
            log("找不到 Git，用 winget 安裝…")
            run(["winget", "install", "-e", "--id", "Git.Git", "--accept-package-agreements", "--accept-source-agreements"])
            if not find_git():
                raise RuntimeError("Git 安裝失敗，請先到 https://git-scm.com 手動安裝後重開安裝程式")
        free = shutil.disk_usage(os.path.splitdrive(dest)[0] + os.sep).free / 2**30
        if free < MIN_FREE_GB:
            raise RuntimeError(f"磁碟只剩 {free:.1f} GB，至少需要 {MIN_FREE_GB} GB（不含模型）")
        repo = opts["yomu_repo"].strip()
        if not repo:
            raise RuntimeError("沒有 Yomu 的 GitHub 網址")

        step("下載 ComfyUI")
        if os.path.isdir(dest) and os.listdir(dest) and not os.path.isfile(os.path.join(dest, "main.py")):
            raise RuntimeError(f"{dest} 不是空資料夾，請換一個安裝位置")
        if not clone(COMFY_REPO, dest):
            raise RuntimeError("下載 ComfyUI 失敗")

        step("建立 Python 環境")
        py = os.path.join(dest, "venv", "Scripts", "python.exe")
        if not os.path.isfile(py) and run([sys.executable, "-m", "venv", os.path.join(dest, "venv")]) != 0:
            raise RuntimeError("建立 venv 失敗")

        step("安裝 PyTorch（約 3 GB，需要一點時間）")
        cuda = opts["cuda"]
        index = "https://download.pytorch.org/whl/" + cuda
        if run([py, "-m", "pip", "install", "torch", "torchvision", "torchaudio", "--index-url", index]) != 0:
            raise RuntimeError("PyTorch 安裝失敗")

        step("安裝 ComfyUI 相依套件（網路慢時可能要 10 到 30 分鐘，請耐心等）")
        if run([py, "-m", "pip", "install", "-r", os.path.join(dest, "requirements.txt")], dest) != 0:
            raise RuntimeError("相依套件安裝失敗")

        step("下載 Yomu")
        yomu = os.path.join(dest, "custom_nodes", "ComfyUI-Yomu")
        if not clone(repo, yomu):
            raise RuntimeError("下載 Yomu 失敗，請確認 GitHub 網址")
        install_requirements(py, yomu)

        for url, path in repos:
            step("下載 " + os.path.basename(path))
            if clone(url, path):
                install_requirements(py, path)
            else:
                log(f"!! {os.path.basename(path)} 下載失敗，略過")

        step("建立桌面捷徑")
        if not make_shortcut(dest, os.path.join(yomu, "launcher", "launch.vbs")):
            log("!! 捷徑沒建成，可以直接執行 " + os.path.join(yomu, "launcher", "launch.vbs"))
        log("完成！按下面的「開啟 Yomu」。第一次進去會缺模型，照畫面指示到 Civitai 下載即可。")
        ok = True
    except Exception as e:
        log(f"!! 安裝中斷：{e}")
    with _lock:
        _job.update(running=False, ok=ok)


PAGE = r"""<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="UTF-8"><title>Yomu 安裝程式</title>
<style>
:root{--bg:#0f1117;--bg2:#161a24;--bg3:#1d2230;--line:#2a3142;--text:#e6e9f0;--muted:#8b93a7;--accent:#7c6cf6;--ok:#3ecf8e;--danger:#e5484d}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:14px/1.5 "Segoe UI","Microsoft JhengHei",sans-serif;display:flex;justify-content:center;padding:40px 16px}
.card{width:100%;max-width:720px;background:var(--bg2);border:1px solid var(--line);border-radius:14px;padding:26px;display:flex;flex-direction:column;gap:16px}
h1{font-size:20px}.muted{color:var(--muted);font-size:12.5px}
label.f{display:flex;flex-direction:column;gap:4px}
input[type=text],select{background:var(--bg3);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:inherit}
.chk{display:flex;gap:8px;align-items:center;cursor:pointer}
button{border:0;background:linear-gradient(135deg,var(--accent),#a78bfa);color:#fff;padding:11px 18px;border-radius:9px;font:inherit;font-weight:600;cursor:pointer}
button:disabled{opacity:.4;cursor:not-allowed}
.track{height:8px;background:var(--bg3);border-radius:4px;overflow:hidden}.fill{height:100%;width:0;background:var(--accent);transition:width .3s}
pre{background:#0a0c12;border:1px solid var(--line);border-radius:9px;padding:12px;font:12px/1.45 Consolas,monospace;height:260px;overflow:auto;white-space:pre-wrap;word-break:break-all;color:#c9d1d9}
</style></head><body><div class="card">
<h1>Yomu 安裝程式</h1>
<div class="muted">會下載 ComfyUI、建立獨立的 Python 環境、裝好 Yomu。模型不在這裡下載（約需 12 GB 空間，不含模型）。</div>
<label class="f">安裝位置<input type="text" id="dest"></label>
<label class="f">顯卡 / PyTorch 版本<select id="cuda"></select><span class="muted" id="gpu"></span></label>
<div><div style="margin-bottom:6px">要一起裝的功能</div><div id="nodes"></div></div>
<label class="f">Yomu 的 GitHub 網址<input type="text" id="repo"></label>
<div style="display:flex;gap:10px"><button id="go">開始安裝</button><button id="open" disabled>開啟 Yomu</button></div>
<div class="track"><div class="fill" id="fill"></div></div>
<div id="now" class="muted" style="white-space:pre-line"></div>
<pre id="log"></pre>
</div>
<script>
const $=id=>document.getElementById(id);
const api=async(p,body)=>(await fetch(p,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})).json();
let timer=null;
(async()=>{
  const i=await api('/api/info');
  $('dest').value=i.dest; $('repo').value=i.repo;
  $('gpu').textContent=i.gpu?`偵測到 ${i.gpu}`:'沒有偵測到 NVIDIA 顯卡，只能用 CPU（很慢）';
  for(const [v,t] of [['cu130','NVIDIA（驅動 580 以上）'],['cu128','NVIDIA（驅動 570 以上）'],['cu126','NVIDIA（較舊驅動）'],['cpu','只用 CPU']])
    $('cuda').add(new Option(t,v));
  $('cuda').value=i.cuda;
  $('nodes').innerHTML=i.nodes.map(n=>`<label class="chk"><input type="checkbox" value="${n.key}" ${n.on?'checked':''}>${n.label}</label>`).join('');
  if(i.running){timer=setInterval(poll,1000);poll();}
})();
async function poll(){
  const s=await api('/api/status');
  $('log').textContent=s.log.join('\n'); $('log').scrollTop=$('log').scrollHeight;
  $('fill').style.width=(s.step/s.steps*100)+'%';
  const idle=Math.round(s.ts-s.last);
  $('now').textContent=s.running?`步驟 ${s.step} / ${s.steps}：${s.name}
${s.now}`+(idle>20?`
已 ${idle} 秒沒有新訊息，正在下載或安裝，網路慢時屬正常，請不要關掉。`:''):'';
  $('go').disabled=s.running;
  if(!s.running){clearInterval(timer);timer=null;$('open').disabled=!s.ok;if(s.ok)$('fill').style.width='100%';}
}
$('go').onclick=async()=>{
  const r=await api('/api/install',{dest:$('dest').value,cuda:$('cuda').value,yomu_repo:$('repo').value,nodes:[...document.querySelectorAll('#nodes input:checked')].map(x=>x.value)});
  if(!r.ok){alert(r.msg);return;}
  $('go').disabled=true;timer=setInterval(poll,1000);poll();
};
$('open').onclick=()=>api('/api/open',{});
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/":
            return self._send(200, PAGE, "text/html; charset=utf-8")
        if path == "/api/info":
            name, cuda = detect_gpu()
            return self._send(200, json.dumps({
                "dest": os.path.join(os.path.expanduser("~"), "Yomu"), "repo": yomu_repo(), "gpu": name, "cuda": cuda,
                "nodes": [{"key": k, "label": label, "on": on} for k, label, on, _ in NODES], "running": _job["running"]}))
        if path == "/api/status":
            with _lock:
                return self._send(200, json.dumps({**_job, "ts": time.time()}))
        self._send(404, "not found", "text/plain")

    def do_POST(self):
        if urllib.parse.urlparse(self.headers.get("Origin") or "http://127.0.0.1").hostname not in ("127.0.0.1", "localhost"):
            return self._send(403, '{"ok":false,"msg":"forbidden"}')
        path = urllib.parse.urlparse(self.path).path
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        if path == "/api/install":
            with _lock:
                if _job["running"]:
                    return self._send(200, '{"ok":false,"msg":"安裝進行中"}')
            threading.Thread(target=install_job, args=(body,), daemon=True).start()
            return self._send(200, '{"ok":true}')
        if path == "/api/open":
            vbs = os.path.join(_job["dest"], "custom_nodes", "ComfyUI-Yomu", "launcher", "launch.vbs")
            subprocess.Popen(["wscript.exe", vbs])
            return self._send(200, '{"ok":true}')
        self._send(404, '{"ok":false}')


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    threading.Timer(0.6, webbrowser.open, [f"http://{HOST}:{PORT}/"]).start()
    print(f"Yomu 安裝程式：http://{HOST}:{PORT}/  （安裝完成前請不要關掉這個視窗）")
    server.serve_forever()
