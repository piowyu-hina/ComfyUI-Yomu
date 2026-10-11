"""
ComfyUI 啟動器 —— 常駐在 http://127.0.0.1:8189 的小網頁，用來啟動 / 停止 ComfyUI。

只用 Python 標準庫，不依賴 venv 內任何套件；用 pythonw 執行就不會有黑視窗。
ComfyUI 本體的 stdout / stderr 會導到 user/comfyui_console.log，頁面上即時顯示。
"""
import hashlib
import json
import os
import re
import socket
import subprocess
import webbrowser
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LAUNCHER_DIR = os.path.dirname(os.path.abspath(__file__))
YOMU_DIR = os.path.dirname(LAUNCHER_DIR)
COMFY_DIR = os.path.dirname(os.path.dirname(YOMU_DIR))
PYTHON = os.path.join(COMFY_DIR, "venv", "Scripts", "python.exe")
COMFY_ARGS = [
    "-u", "main.py",
    "--preview-method", "auto",
    "--use-pytorch-cross-attention",
    "--enable-manager",
    "--fast", "fp16_accumulation", "fp8_matrix_mult",
    "--listen", "127.0.0.1",
    "--port", "8188",
]
COMFY_HOST, COMFY_PORT = "127.0.0.1", 8188
LAUNCHER_HOST, LAUNCHER_PORT = "127.0.0.1", 8189
CONSOLE_LOG = os.path.join(COMFY_DIR, "user", "comfyui_console.log")
INFERENCE_URL = f"http://{COMFY_HOST}:{COMFY_PORT}/yomu"

_proc = None            # 由啟動器自己拉起來的 ComfyUI 程序
_lock = threading.Lock()
_started_at = None


# ------------------------------------------------------------------ helpers
ELECTRON = os.path.join(os.environ.get("APPDATA", ""), "npm", "node_modules", "electron", "dist", "electron.exe")
BROWSERS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]


def open_app():
    """優先 Electron App；沒裝就用 Edge/Chrome 的 --app 視窗；再不行就一般瀏覽器"""
    if os.path.isfile(ELECTRON):
        subprocess.Popen([ELECTRON, os.path.join(LAUNCHER_DIR, "yomu.cjs")], cwd=COMFY_DIR)
        return
    for exe in BROWSERS:
        if os.path.isfile(exe):
            subprocess.Popen([exe, f"--app={INFERENCE_URL}", "--window-size=1680,1000"], creationflags=0x00000008)
            return
    webbrowser.open(INFERENCE_URL)


def port_open(host, port, timeout=0.4):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def find_pid_on_port(port):
    """ComfyUI 不是啟動器開的時候，用 netstat 找它的 PID。"""
    try:
        out = subprocess.check_output(["netstat", "-ano", "-p", "tcp"], text=True, creationflags=0x08000000)
    except Exception:
        return None
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[1].endswith(f":{port}") and parts[3] == "LISTENING":
            try:
                return int(parts[4])
            except ValueError:
                pass
    return None


def status():
    global _proc
    with _lock:
        own_alive = _proc is not None and _proc.poll() is None
        if _proc is not None and not own_alive:
            _proc = None
    listening = port_open(COMFY_HOST, COMFY_PORT)
    if own_alive and listening:
        state = "running"
    elif own_alive:
        state = "starting"
    elif listening:
        state = "external"        # 有人用別的方式開了 ComfyUI
    else:
        state = "stopped"
    return {
        "state": state,
        "pid": _proc.pid if own_alive else (find_pid_on_port(COMFY_PORT) if listening else None),
        "uptime": int(time.time() - _started_at) if (own_alive and _started_at) else None,
        "version": _comfy_version(),
        "inference_url": INFERENCE_URL,
        "comfy_url": f"http://{COMFY_HOST}:{COMFY_PORT}/",
    }


def start():
    global _proc, _started_at
    with _lock:
        if _proc is not None and _proc.poll() is None:
            return {"ok": True, "msg": "已經在執行中"}
        if port_open(COMFY_HOST, COMFY_PORT):
            return {"ok": True, "msg": "ComfyUI 已由其他方式啟動"}
        if not os.path.isfile(PYTHON):
            return {"ok": False, "msg": f"找不到 {PYTHON}"}
        os.makedirs(os.path.dirname(CONSOLE_LOG), exist_ok=True)
        log = open(CONSOLE_LOG, "wb")
        _proc = subprocess.Popen(
            [PYTHON] + COMFY_ARGS,
            cwd=COMFY_DIR,
            stdout=log,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            creationflags=0x08000000,     # CREATE_NO_WINDOW
        )
        _started_at = time.time()
        return {"ok": True, "msg": f"已啟動 (PID {_proc.pid})"}


def stop():
    global _proc
    with _lock:
        pid = None
        if _proc is not None and _proc.poll() is None:
            pid = _proc.pid
        elif port_open(COMFY_HOST, COMFY_PORT):
            pid = find_pid_on_port(COMFY_PORT)
        if pid is None:
            _proc = None
            return {"ok": True, "msg": "ComfyUI 本來就沒在跑"}
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                       capture_output=True, creationflags=0x08000000)
        _proc = None
        return {"ok": True, "msg": f"已停止 (PID {pid})"}


# ------------------------------------------------------------------ 更新 ComfyUI
UPDATE_LOG = os.path.join(COMFY_DIR, "user", "update.log")
_update = {"running": False, "ok": None, "log": [], "started": 0, "finished": 0}
_update_lock = threading.Lock()


def _ulog(line):
    with _update_lock:
        _update["log"].append(line)
    try:
        with open(UPDATE_LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def _run_cmd(args, cwd):
    _ulog("$ " + " ".join(args))
    p = subprocess.Popen(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, encoding="utf-8", errors="replace", creationflags=0x08000000)
    for line in p.stdout:
        _ulog("  " + line.rstrip())
    p.wait()
    return p.returncode


def _git_out(args, cwd):
    try:
        return subprocess.check_output(["git"] + args, cwd=cwd, text=True, encoding="utf-8", errors="replace",
                                       stderr=subprocess.STDOUT, creationflags=0x08000000).strip()
    except Exception:
        return ""


def _behind(cwd):
    """git fetch 後回傳落後上游幾個 commit；-1 = 分支歧異（上游 force push）；None = 不是 git repo / 沒上游"""
    if not os.path.isdir(os.path.join(cwd, ".git")):
        return None
    _git_out(["fetch", "--quiet"], cwd)
    if not _git_out(["rev-parse", "--abbrev-ref", "@{u}"], cwd):
        return None
    behind = _git_out(["rev-list", "--count", "HEAD..@{u}"], cwd)
    ahead = _git_out(["rev-list", "--count", "@{u}..HEAD"], cwd)
    if not behind.isdigit():
        return None
    if ahead.isdigit() and int(ahead) > 0 and int(behind) > 0:
        return -1
    return int(behind)


def _comfy_version():
    try:
        with open(os.path.join(COMFY_DIR, "comfyui_version.py"), encoding="utf-8") as f:
            for line in f:
                if line.startswith("__version__"):
                    return line.split("=", 1)[1].strip().strip('"\'')
    except OSError:
        pass
    return "?"


def _file_hash(path):
    try:
        with open(path, "rb") as f:
            return hashlib.sha1(f.read()).hexdigest()
    except OSError:
        return ""


def _update_job(restart):
    with _update_lock:
        _update.update(running=True, ok=None, log=[], started=time.time(), finished=0)
    try:
        open(UPDATE_LOG, "w").close()
    except OSError:
        pass
    ok = True
    try:
        _ulog(f"目前 ComfyUI 版本：{_comfy_version()}（{_git_out(['rev-parse', '--short', 'HEAD'], COMFY_DIR)}）")
        _ulog(f"目前 Yomu 版本：{_git_out(['rev-parse', '--short', 'HEAD'], YOMU_DIR) or '?'}")
        _ulog("檢查更新…")
        nodes_dir = os.path.join(COMFY_DIR, "custom_nodes")
        repos = [("ComfyUI 本體", COMFY_DIR)] + [
            (d, os.path.join(nodes_dir, d)) for d in sorted(os.listdir(nodes_dir))
            if os.path.isdir(os.path.join(nodes_dir, d, ".git"))
        ]
        todo = []
        for name, path in repos:
            b = _behind(path)
            if b is None:
                continue
            if b == 0:
                _ulog(f"  {name}：已是最新")
            else:
                _ulog(f"  {name}：{'上游分支改寫，需重新對齊' if b < 0 else f'落後 {b} 個提交'}")
                todo.append((name, path, b))
        if not todo:
            _ulog(f"全部都是最新版，不需要重啟 ComfyUI。")
            with _update_lock:
                _update.update(running=False, ok=True, finished=time.time())
            return

        was_running = status()["state"] in ("running", "starting", "external")
        if was_running:
            _ulog("停止 ComfyUI…")
            stop()
            time.sleep(2)

        yomu_before = _git_out(["rev-parse", "HEAD"], YOMU_DIR)
        req = os.path.join(COMFY_DIR, "requirements.txt")
        req_before = _file_hash(req)
        for name, path, b in todo:
            _ulog(f"== {name} ==")
            if b < 0:
                dirty = _git_out(["status", "--porcelain"], path)
                if dirty:
                    _ulog(f"!! {name} 有本機修改，不敢強制對齊，略過")
                    continue
                if _run_cmd(["git", "reset", "--hard", "@{u}"], path) != 0:
                    _ulog(f"!! {name} 對齊失敗")
                    if path == COMFY_DIR:
                        ok = False
                continue
            if _run_cmd(["git", "pull", "--ff-only"], path) != 0:
                _ulog(f"!! {name} 更新失敗（本機有改過的檔案？）")
                if path == COMFY_DIR:
                    ok = False

        yomu_after = _git_out(["rev-parse", "HEAD"], YOMU_DIR)
        if yomu_before != yomu_after and _git_out(["diff", "--name-only", yomu_before, yomu_after, "--", "launcher"], YOMU_DIR):
            _ulog("!! 啟動器本身有更新，請關掉啟動器再重開才會生效")
        if _file_hash(req) != req_before:
            _ulog("== 相依套件（requirements.txt 有變）==")
            if _run_cmd([PYTHON, "-m", "pip", "--version"], COMFY_DIR) != 0:
                _ulog("venv 沒有 pip，先安裝…")
                _run_cmd([PYTHON, "-m", "ensurepip", "--upgrade"], COMFY_DIR)
            if _run_cmd([PYTHON, "-m", "pip", "install", "-r", "requirements.txt"], COMFY_DIR) != 0:
                ok = False
                _ulog("!! pip install 失敗")
        else:
            _ulog("requirements.txt 沒變，略過套件安裝")

        _ulog(f"更新後版本：{_comfy_version()}（{_git_out(['rev-parse', '--short', 'HEAD'], COMFY_DIR)}）")
        if restart and was_running:
            _ulog("重新啟動 ComfyUI…")
            start()
        _ulog("完成" if ok else "完成（有錯誤，請看上面）")
    except Exception as e:
        ok = False
        _ulog(f"!! 例外：{e}")
    with _update_lock:
        _update.update(running=False, ok=ok, finished=time.time())


def start_update(restart=True):
    with _update_lock:
        if _update["running"]:
            return {"ok": False, "msg": "已經在更新中"}
    threading.Thread(target=_update_job, args=(restart,), daemon=True).start()
    return {"ok": True, "msg": "開始更新"}


def update_status():
    with _update_lock:
        return dict(_update)


def tail_log(max_bytes=24000):
    if not os.path.isfile(CONSOLE_LOG):
        return ""
    with open(CONSOLE_LOG, "rb") as f:
        f.seek(0, os.SEEK_END)
        size = f.tell()
        f.seek(max(0, size - max_bytes))
        data = f.read()
    text = re.sub(r"\x1b\[[0-9;]*m", "", data.decode("utf-8", errors="replace"))  # 去掉 ANSI 顏色碼
    if size > max_bytes:
        text = text.split("\n", 1)[-1]
    return text


# ------------------------------------------------------------------ page
PAGE = r"""<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ComfyUI 啟動器</title>
<style>
:root{--bg:#0f1117;--bg2:#161a24;--bg3:#1d2230;--line:#2a3142;--text:#e6e9f0;--muted:#8b93a7;--accent:#7c6cf6;--ok:#3ecf8e;--warn:#fbbf24;--danger:#e5484d}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,"Segoe UI","Noto Sans TC","Microsoft JhengHei",sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:40px 16px}
.card{width:100%;max-width:760px;background:var(--bg2);border:1px solid var(--line);border-radius:14px;padding:26px;display:flex;flex-direction:column;gap:18px}
h1{font-size:20px;display:flex;align-items:center;gap:12px}
.badge{background:linear-gradient(135deg,var(--accent),#c084fc);color:#fff;font-size:11px;font-weight:700;letter-spacing:.08em;padding:3px 8px;border-radius:6px}
.status{display:flex;align-items:center;gap:10px;font-size:15px}
.dot{width:12px;height:12px;border-radius:50%;background:var(--danger);flex-shrink:0}
.dot.running{background:var(--ok);box-shadow:0 0 10px var(--ok)}
.dot.starting{background:var(--warn);animation:blink 1s infinite}
.dot.external{background:var(--ok)}
@keyframes blink{50%{opacity:.3}}
.muted{color:var(--muted);font-size:12.5px}
.btns{display:flex;flex-wrap:wrap;gap:10px}
button,a.btn{border:1px solid var(--line);background:var(--bg3);color:var(--text);padding:10px 18px;border-radius:9px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
button:hover,a.btn:hover{border-color:var(--accent)}
button:disabled{opacity:.4;cursor:not-allowed}
.primary{background:linear-gradient(135deg,var(--accent),#a78bfa);border:0;color:#fff;box-shadow:0 4px 16px rgba(124,108,246,.35)}
.danger{background:var(--danger);border:0;color:#fff}
pre{background:#0a0c12;border:1px solid var(--line);border-radius:9px;padding:12px;font:12px/1.45 Consolas,"Cascadia Mono",monospace;height:320px;overflow:auto;white-space:pre-wrap;word-break:break-all;color:#c9d1d9}
.row{display:flex;justify-content:space-between;align-items:center}
label{display:flex;align-items:center;gap:6px;cursor:pointer}
</style></head><body>
<div class="card">
  <h1><span class="badge">COMFYUI</span>啟動器</h1>
  <div class="status"><span class="dot" id="dot"></span><span id="stateText">查詢中…</span></div>
  <div class="btns">
    <button class="primary" id="btnStart">▶ 啟動 ComfyUI</button>
    <button class="danger" id="btnStop">■ 停止</button>
    <button id="btnRestart">⟳ 重新啟動</button>
    <button id="btnUpdate" title="git pull + pip install，更新期間會先停止 ComfyUI，完成後自動重啟">⬆ 更新 ComfyUI</button>
    <a class="btn" id="lnkInference" href="__INFERENCE__" target="_blank">✦ Yomu ↗</a>
    <a class="btn" id="lnkComfy" href="__COMFY__" target="_blank">節點畫布 ↗</a>
  </div>
  <div class="row">
    <span class="muted">ComfyUI 輸出（user/comfyui_console.log）</span>
    <label class="muted"><input type="checkbox" id="autoOpen" checked> 啟動完成後自動開啟 Yomu</label>
  </div>
  <pre id="log"></pre>
  <div class="row" id="updRow" hidden><span class="muted">更新記錄</span><span class="muted" id="updState"></span></div>
  <pre id="updLog" hidden style="height:200px"></pre>
  <div class="muted">啟動器本身：http://127.0.0.1:8189 — 關掉這個分頁不會關掉 ComfyUI。</div>
</div>
<script>
const $=id=>document.getElementById(id);
let state='', wantOpen=false;
const names={stopped:'已停止',starting:'啟動中…（第一次載入模型會比較久）',running:'執行中',external:'執行中（非由啟動器啟動）'};
async function api(p,method='GET'){const r=await fetch(p,{method});return r.json();}
async function refresh(){
  try{
    const s=await api('/api/status');
    if(s.state!==state){state=s.state;$('dot').className='dot '+state;}
    $('stateText').textContent=names[state]+(s.version?`  ·  v${s.version}`:'')+(s.pid?`  ·  PID ${s.pid}`:'')+(s.uptime!=null?`  ·  ${Math.floor(s.uptime/60)} 分 ${s.uptime%60} 秒`:'');
    const up=state==='running'||state==='external';
    $('btnStart').disabled=up||state==='starting';
    $('btnStop').disabled=state==='stopped';
    $('btnRestart').disabled=state==='stopped';
    $('lnkInference').style.opacity=$('lnkComfy').style.opacity=up?1:.4;
    if(up&&wantOpen){wantOpen=false;window.open(s.inference_url,'_blank');}
    const pre=$('log');const atBottom=pre.scrollTop+pre.clientHeight>=pre.scrollHeight-8;
    const t=await (await fetch('/api/log')).text();
    if(t!==pre.textContent){pre.textContent=t;if(atBottom)pre.scrollTop=pre.scrollHeight;}
  }catch(e){$('stateText').textContent='啟動器連線失敗';}
}
async function start(){wantOpen=$('autoOpen').checked;const r=await api('/api/start','POST');$('stateText').textContent=r.msg;refresh();}
async function stop(){wantOpen=false;const r=await api('/api/stop','POST');$('stateText').textContent=r.msg;refresh();}
$('btnStart').onclick=start;
$('btnStop').onclick=stop;
$('btnRestart').onclick=async()=>{await api('/api/stop','POST');setTimeout(start,1500);};
let updTimer=null;
async function pollUpdate(){
  const u=await api('/api/update/status');
  $('updRow').hidden=$('updLog').hidden=false;
  $('updLog').textContent=u.log.join('\n'); $('updLog').scrollTop=$('updLog').scrollHeight;
  $('updState').textContent=u.running?'更新中…':(u.ok===null?'':(u.ok?'完成':'完成（有錯誤）'));
  $('btnUpdate').disabled=u.running;
  if(!u.running&&updTimer){clearInterval(updTimer);updTimer=null;}
}
$('btnUpdate').onclick=async()=>{
  if(!confirm('更新 ComfyUI 本體與自訂節點（git pull + pip install）？\n更新期間 ComfyUI 會先停止，完成後自動重啟。'))return;
  const r=await api('/api/update','POST'); $('stateText').textContent=r.msg;
  if(r.ok&&!updTimer){pollUpdate();updTimer=setInterval(pollUpdate,1500);}
};
api('/api/update/status').then(u=>{if(u.running){pollUpdate();updTimer=setInterval(pollUpdate,1500);}});
refresh();setInterval(refresh,1500);
if(new URLSearchParams(location.search).get('autostart')==='1'){start();history.replaceState(null,'',location.pathname);}
</script></body></html>
"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):        # 安靜
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin", "")
        if urllib.parse.urlparse(origin).hostname in ("127.0.0.1", "localhost"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(data)

    def _same_site(self):
        """擋掉其他網站對 127.0.0.1 的 CSRF（跟 ComfyUI 本身同樣的做法）"""
        sfs = self.headers.get("Sec-Fetch-Site")
        if sfs and sfs == "cross-site":
            return False
        origin = self.headers.get("Origin")
        if origin:
            host = urllib.parse.urlparse(origin).hostname
            if host not in ("127.0.0.1", "localhost"):
                return False
        return True

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/":
            page = PAGE.replace("__INFERENCE__", INFERENCE_URL).replace("__COMFY__", f"http://{COMFY_HOST}:{COMFY_PORT}/")
            return self._send(200, page, "text/html; charset=utf-8")
        if path == "/api/status":
            return self._send(200, json.dumps(status()))
        if path == "/api/log":
            return self._send(200, tail_log(), "text/plain; charset=utf-8")
        if path == "/api/update/status":
            return self._send(200, json.dumps(update_status()))
        self._send(404, "not found", "text/plain")

    def do_POST(self):
        if not self._same_site():
            return self._send(403, '{"ok":false,"msg":"forbidden"}')
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/start":
            return self._send(200, json.dumps(start()))
        if path == "/api/stop":
            return self._send(200, json.dumps(stop()))
        if path == "/api/update":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            return self._send(200, json.dumps(start_update(restart=qs.get("restart", ["1"])[0] != "0")))
        self._send(404, '{"ok":false}')


def main():
    open_page = "--no-browser" not in sys.argv

    if port_open(LAUNCHER_HOST, LAUNCHER_PORT):
        if open_page:
            open_app()
        return

    server = ThreadingHTTPServer((LAUNCHER_HOST, LAUNCHER_PORT), Handler)
    if open_page:
        threading.Timer(0.6, open_app).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
