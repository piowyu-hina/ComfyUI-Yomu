"""
Yomu 啟動器 —— http://127.0.0.1:8189 的小網頁，用來啟動 / 停止 ComfyUI；視窗關掉後啟動器自己結束。

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
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LAUNCHER_DIR = os.path.dirname(os.path.abspath(__file__))
YOMU_DIR = os.path.dirname(LAUNCHER_DIR)
COMFY_DIR = os.path.dirname(os.path.dirname(YOMU_DIR))
PYTHON = os.path.join(COMFY_DIR, "venv", "Scripts", "python.exe")
SAGE_DIR = os.path.join(COMFY_DIR, "venv", "Lib", "site-packages", "sageattention")


def comfy_args():
    """有裝 SageAttention 就用它（影片取樣快 3 到 4 成），沒裝維持 PyTorch 內建注意力"""
    attention = "--use-sage-attention" if os.path.isdir(SAGE_DIR) else "--use-pytorch-cross-attention"
    return [
        "-u", "main.py",
        "--preview-method", "auto",
        attention,
        "--enable-manager",
        "--fast", "fp16_accumulation", "fp8_matrix_mult",
        "--listen", "127.0.0.1",
        "--port", "8188",
    ]


COMFY_HOST, COMFY_PORT = "127.0.0.1", 8188
LAUNCHER_HOST, LAUNCHER_PORT = "127.0.0.1", 8189
CONSOLE_LOG = os.path.join(COMFY_DIR, "user", "comfyui_console.log")
INFERENCE_URL = f"http://{COMFY_HOST}:{COMFY_PORT}/yomu"
LAUNCHER_URL = f"http://{LAUNCHER_HOST}:{LAUNCHER_PORT}/"

_proc = None            # 由啟動器自己拉起來的 ComfyUI 程序
_lock = threading.Lock()
_started_at = None
_last_seen = time.time()   # 頁面最後一次連進來的時間
_closing = False           # 頁面關閉時送 /api/bye


# ------------------------------------------------------------------ helpers
ELECTRON = os.path.join(os.environ.get("APPDATA", ""), "npm", "node_modules", "electron", "dist", "electron.exe")
BROWSERS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]


def open_in_window(url, size):
    """優先 Edge/Chrome 的 --app 視窗（沒有網址列）；都沒有就用預設瀏覽器"""
    for exe in BROWSERS:
        if os.path.isfile(exe):
            subprocess.Popen([exe, f"--app={url}", f"--window-size={size}"], creationflags=0x00000008)
            return
    webbrowser.open(url)


def open_window(flag, url, size):
    """優先 Electron（yomu.cjs --launcher / --yomu）；沒裝就用 Edge/Chrome 的 App 視窗"""
    if os.path.isfile(ELECTRON):
        subprocess.Popen([ELECTRON, os.path.join(LAUNCHER_DIR, "yomu.cjs"), flag], cwd=COMFY_DIR)
    else:
        open_in_window(url, size)


def open_yomu():
    open_window("--yomu", INFERENCE_URL, "1680,1000")


def open_launcher():
    open_window("--launcher", LAUNCHER_URL, "820,900")


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
            [PYTHON] + comfy_args(),
            cwd=COMFY_DIR,
            stdout=log,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            creationflags=0x08000000,     # CREATE_NO_WINDOW
        )
        log.close()
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


def _repos(target):
    if target == "yomu":
        return [("Yomu", YOMU_DIR)]
    nodes_dir = os.path.join(COMFY_DIR, "custom_nodes")
    return [("ComfyUI 本體", COMFY_DIR)] + [
        (d, os.path.join(nodes_dir, d)) for d in sorted(os.listdir(nodes_dir))
        if os.path.isdir(os.path.join(nodes_dir, d, ".git")) and os.path.join(nodes_dir, d) != YOMU_DIR
    ]


def update_available(target):
    """開啟頁面時檢查用：有任一個 repo 落後（或上游改寫）就算有更新"""
    return any(_behind(path) for _, path in _repos(target))


def _update_job(target):
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
        todo = []
        for name, path in _repos(target):
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
        if target == "comfyui":
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

        _ulog(f"更新後版本：ComfyUI {_comfy_version()}（{_git_out(['rev-parse', '--short', 'HEAD'], COMFY_DIR)}）、Yomu {_git_out(['rev-parse', '--short', 'HEAD'], YOMU_DIR) or '?'}")
        if was_running:
            _ulog("重新啟動 ComfyUI…")
            start()
        _ulog("完成" if ok else "完成（有錯誤，請看上面）")
    except Exception as e:
        ok = False
        _ulog(f"!! 例外：{e}")
    with _update_lock:
        _update.update(running=False, ok=ok, finished=time.time())


def start_update(target):
    with _update_lock:
        if _update["running"]:
            return {"ok": False, "msg": "已經在更新中"}
    threading.Thread(target=_update_job, args=(target,), daemon=True).start()
    return {"ok": True, "msg": "開始更新"}


def seen(closing=False):
    global _last_seen, _closing
    _last_seen, _closing = time.time(), closing


def exit_when_idle(server):
    """視窗關掉 3 秒後（或 3 分鐘沒有頁面連進來）就結束啟動器；更新中會等更新完。ComfyUI 不受影響。"""
    while True:
        time.sleep(1)
        idle = time.time() - _last_seen
        if idle > (3 if _closing else 180) and not _update["running"]:
            server.shutdown()
            return


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
<title>Yomu 啟動器</title>
<style>
:root{--bg:#1b1b1b;--bg2:#202020;--card:#2b2b2b;--line:#3a3a3a;--line2:#474747;--text:#e8e8e8;--muted:#9a9a9a;--accent:#36b9e6;--ok:#4cc38a;--warn:#f0b429;--danger:#d9534f}
*{box-sizing:border-box;margin:0;padding:0}
[hidden]{display:none!important}
html,body{height:100%}
body{background:var(--bg);color:var(--text);font:14px/1.45 "Segoe UI","Noto Sans TC","Microsoft JhengHei",sans-serif;display:flex;flex-direction:column;user-select:none}
.muted{color:var(--muted)}
main{flex:1;min-height:0;display:flex;flex-direction:column;gap:12px;padding:16px 18px 12px}
.hero{display:flex;align-items:center;gap:16px;padding:16px 18px;border:1px solid var(--line);border-radius:10px;background:linear-gradient(120deg,rgba(150,30,60,.38),rgba(43,43,43,.6) 55%,rgba(54,185,230,.14))}
.hero img{width:60px;height:60px;border-radius:14px;box-shadow:0 4px 14px rgba(0,0,0,.4)}
.hero-title{font-size:20px;font-weight:700;letter-spacing:.02em}
.hero-sub{color:#cfcfcf;font-size:13px;margin-top:2px}
.svc{display:flex;align-items:center;gap:14px;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px}
.dot{width:10px;height:10px;border-radius:50%;background:#5a5a5a;flex-shrink:0}
.dot.running,.dot.external,.dot.ready{background:var(--ok);box-shadow:0 0 8px rgba(76,195,138,.6)}
.dot.starting{background:var(--warn);animation:blink 1s infinite}
@keyframes blink{50%{opacity:.3}}
.info{flex:1;min-width:0}
.name{font-size:15px;font-weight:600}
.ver{color:var(--muted);font-size:12.5px;font-weight:400;margin-left:4px}
.sub{color:var(--muted);font-size:12.5px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.check{display:inline-flex;align-items:center;gap:6px;margin-top:6px;color:var(--muted);font-size:12.5px;cursor:pointer}
.check input{accent-color:var(--accent)}
.actions{display:flex;gap:8px;flex-shrink:0}
button{font:inherit;font-weight:600;color:var(--text);background:#363636;border:1px solid var(--line2);border-radius:6px;padding:8px 16px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px}
button:hover:not(:disabled){filter:brightness(1.15)}
button:disabled{opacity:.4;cursor:not-allowed}
.main-btn{min-width:120px}
.primary{background:var(--accent);border-color:var(--accent);color:#06222d}
.danger{background:var(--danger);border-color:var(--danger);color:#fff}
.update{background:var(--ok);border-color:var(--ok);color:#06281a;min-width:92px}
.update.off{visibility:hidden}
main:not(.has-update) .update{display:none}
.panel{flex:1;min-height:160px;display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.tabs{display:flex;align-items:center;border-bottom:1px solid var(--line);background:#262626;padding:0 6px}
.tab{background:none;border:0;border-bottom:2px solid transparent;border-radius:0;padding:9px 12px;color:var(--muted)}
.tab.on{color:var(--text);border-bottom-color:var(--accent)}
.tabs .muted{margin-left:auto;padding-right:8px;font-size:12px}
pre{flex:1;min-height:0;overflow:auto;padding:12px 14px;font:12px/1.5 Consolas,"Cascadia Mono","Microsoft JhengHei",monospace;white-space:pre-wrap;word-break:break-all;color:#c9d1d9;background:#161616;user-select:text}
footer{color:var(--muted);font-size:12px;text-align:center}
</style></head><body>
<main>
  <header class="hero"><img src="/icon.png" alt=""><div><div class="hero-title">Yomu</div><div class="hero-sub" id="summary">查詢中…</div></div></header>
  <section class="svc">
    <span class="dot" id="dot"></span>
    <div class="info"><div class="name">ComfyUI <span class="ver" id="ver"></span></div><div class="sub" id="stateText">查詢中…</div></div>
    <div class="actions">
      <button class="main-btn primary" id="btnToggle">▶ 啟動</button>
      <button class="update off" id="btnUpdateComfy" title="更新 ComfyUI 本體與其他自訂節點（git pull + pip install），不含 Yomu">⬆ 更新</button>
    </div>
  </section>
  <section class="svc">
    <span class="dot" id="yomuDot"></span>
    <div class="info"><div class="name">Yomu</div>
      <label class="check"><input type="checkbox" id="autoOpen" checked>ComfyUI 啟動完成後自動開啟</label></div>
    <div class="actions">
      <button class="main-btn primary" id="btnYomu">✦ 開啟</button>
      <button class="update off" id="btnUpdateYomu" title="只更新 Yomu（含啟動器），不動 ComfyUI 和套件">⬆ 更新</button>
    </div>
  </section>
  <section class="panel">
    <div class="tabs"><button class="tab on" data-tab="log">ComfyUI 輸出</button><button class="tab" data-tab="updLog" id="updTab" hidden>更新記錄</button><span class="muted" id="updState"></span></div>
    <pre id="log"></pre><pre id="updLog" hidden></pre>
  </section>
  <footer>關掉這個視窗只會結束啟動器，ComfyUI 會繼續執行</footer>
</main>
<script>
const $=id=>document.getElementById(id);
let state='', wantOpen=false;
const names={stopped:'已停止',starting:'啟動中…（第一次載入模型會比較久）',running:'執行中',external:'執行中（非由啟動器啟動）'};
async function api(p,method='GET'){const r=await fetch(p,{method});return r.json();}
async function refresh(){
  try{
    const s=await api('/api/status');
    state=s.state; $('dot').className='dot '+state;
    $('ver').textContent=s.version?'v'+s.version:'';
    $('summary').textContent={stopped:'ComfyUI 還沒啟動，按「▶ 啟動」開始',starting:'ComfyUI 啟動中，馬上就好…',running:'一切就緒，可以開始創作了',external:'一切就緒，可以開始創作了'}[state];
    $('stateText').textContent=[names[state],s.pid&&`PID ${s.pid}`,s.uptime!=null&&`${Math.floor(s.uptime/60)} 分 ${s.uptime%60} 秒`].filter(Boolean).join('  ·  ');
    const up=state==='running'||state==='external';
    const running=state!=='stopped';
    $('btnToggle').textContent=running?'■ 停止':'▶ 啟動';
    $('btnToggle').className='main-btn '+(running?'danger':'primary');
    $('btnYomu').disabled=!up;
    $('yomuDot').className='dot'+(up?' ready':'');
    if(up&&wantOpen){wantOpen=false;api('/api/open-yomu','POST');}
    const pre=$('log');const atBottom=pre.scrollTop+pre.clientHeight>=pre.scrollHeight-8;
    const t=await (await fetch('/api/log')).text();
    if(t!==pre.textContent){pre.textContent=t;if(atBottom)pre.scrollTop=pre.scrollHeight;}
  }catch(e){$('stateText').textContent='啟動器連線失敗';}
}
async function start(){wantOpen=$('autoOpen').checked;const r=await api('/api/start','POST');$('stateText').textContent=r.msg;refresh();}
async function stop(){wantOpen=false;const r=await api('/api/stop','POST');$('stateText').textContent=r.msg;refresh();}
$('btnToggle').onclick=()=>state==='stopped'?start():stop();
$('btnYomu').onclick=()=>api('/api/open-yomu','POST');
function showTab(id){
  for(const t of document.querySelectorAll('.tab'))t.classList.toggle('on',t.dataset.tab===id);
  $('log').hidden=id!=='log'; $('updLog').hidden=id!=='updLog';
}
for(const t of document.querySelectorAll('.tab'))t.onclick=()=>showTab(t.dataset.tab);
let updTimer=null;
const updBtns={comfyui:$('btnUpdateComfy'),yomu:$('btnUpdateYomu')};
function setAvailable(b,on){
  b.classList.toggle('off',!on);
  document.querySelector('main').classList.toggle('has-update',Object.values(updBtns).some(x=>!x.classList.contains('off')));
}
function checkUpdates(){
  for(const [t,b] of Object.entries(updBtns))api('/api/update/check?target='+t).then(r=>setAvailable(b,r.available));
}
async function pollUpdate(){
  const u=await api('/api/update/status');
  if($('updTab').hidden){$('updTab').hidden=false;showTab('updLog');}
  $('updLog').textContent=u.log.join('\n'); $('updLog').scrollTop=$('updLog').scrollHeight;
  $('updState').textContent=u.running?'更新中…':(u.ok===null?'':(u.ok?'更新完成':'更新完成（有錯誤）'));
  for(const b of Object.values(updBtns)){b.disabled=u.running;if(u.running)setAvailable(b,true);}
  if(!u.running&&updTimer){clearInterval(updTimer);updTimer=null;checkUpdates();}
}
const runUpdate=(target,ask)=>async()=>{
  if(!confirm(ask+'\n更新期間 ComfyUI 會先停止，完成後自動重啟。'))return;
  const r=await api('/api/update?target='+target,'POST'); $('stateText').textContent=r.msg;
  if(r.ok&&!updTimer){pollUpdate();updTimer=setInterval(pollUpdate,1500);}
};
$('btnUpdateYomu').onclick=runUpdate('yomu','更新 Yomu（含啟動器）？');
$('btnUpdateComfy').onclick=runUpdate('comfyui','更新 ComfyUI 本體與其他自訂節點（git pull + pip install）？');
api('/api/update/status').then(u=>{if(u.running){pollUpdate();updTimer=setInterval(pollUpdate,1500);}else checkUpdates();});
refresh();setInterval(refresh,1500);
addEventListener('pagehide',()=>navigator.sendBeacon('/api/bye'));
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

    def _host_ok(self):
        """只收 127.0.0.1 / localhost 的 Host，擋 DNS rebinding"""
        return self.headers.get("Host", "") in (f"{LAUNCHER_HOST}:{LAUNCHER_PORT}", f"localhost:{LAUNCHER_PORT}")

    def do_GET(self):
        if not self._host_ok():
            return self._send(403, "forbidden", "text/plain")
        path = urllib.parse.urlparse(self.path).path
        seen()
        if path == "/":
            return self._send(200, PAGE, "text/html; charset=utf-8")
        if path == "/icon.png":
            with open(os.path.join(YOMU_DIR, "assets", "yomu.png"), "rb") as f:
                return self._send(200, f.read(), "image/png")
        if path == "/api/status":
            return self._send(200, json.dumps(status()))
        if path == "/api/log":
            return self._send(200, tail_log(), "text/plain; charset=utf-8")
        if path == "/api/update/status":
            return self._send(200, json.dumps(update_status()))
        if path == "/api/update/check":
            target = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("target", [""])[0]
            if target not in ("yomu", "comfyui"):
                return self._send(400, '{"ok":false,"msg":"target 必須是 yomu 或 comfyui"}')
            return self._send(200, json.dumps({"available": update_available(target)}))
        self._send(404, "not found", "text/plain")

    def do_POST(self):
        if not self._host_ok() or not self._same_site():
            return self._send(403, '{"ok":false,"msg":"forbidden"}')
        path = urllib.parse.urlparse(self.path).path
        seen(path == "/api/bye")
        if path == "/api/bye":
            return self._send(200, '{"ok":true}')
        if path == "/api/start":
            return self._send(200, json.dumps(start()))
        if path == "/api/stop":
            return self._send(200, json.dumps(stop()))
        if path == "/api/open-yomu":
            open_yomu()
            return self._send(200, '{"ok":true}')
        if path == "/api/update":
            target = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("target", [""])[0]
            if target not in ("yomu", "comfyui"):
                return self._send(400, '{"ok":false,"msg":"target 必須是 yomu 或 comfyui"}')
            return self._send(200, json.dumps(start_update(target)))
        self._send(404, '{"ok":false}')


def main():
    if port_open(LAUNCHER_HOST, LAUNCHER_PORT):
        open_launcher()
        return

    server = ThreadingHTTPServer((LAUNCHER_HOST, LAUNCHER_PORT), Handler)
    threading.Timer(0.6, open_launcher).start()
    threading.Thread(target=exit_when_idle, args=(server,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
