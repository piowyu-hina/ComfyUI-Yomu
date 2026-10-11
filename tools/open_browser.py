"""等 ComfyUI 就緒後開啟 Yomu App。給 start_service.bat 用。"""
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

host, port = "127.0.0.1", 8188
deadline = time.time() + 300
while time.time() < deadline:
    try:
        with socket.create_connection((host, port), timeout=1):
            break
    except OSError:
        time.sleep(1.5)
else:
    sys.exit(1)
time.sleep(1.0)
root = Path(__file__).resolve().parents[3]
electron = Path(os.environ["APPDATA"]) / "npm/node_modules/electron/dist/electron.exe"
subprocess.Popen([str(electron), str(Path(__file__).resolve().parents[1] / "launcher/yomu.cjs")], cwd=root)
