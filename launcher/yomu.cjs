const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..', '..');
const home = 'http://127.0.0.1:8188/yomu';
const launcher = 'http://127.0.0.1:8189';
app.setName('Yomu');
app.setPath('userData', path.join(root, 'user', 'yomu-app'));
app.setAppUserModelId('Yomu.Studio');
let window;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window) { if (window.isMinimized()) window.restore(); window.focus(); }
  });
  app.whenReady().then(async () => {
    const resolveImage = async (event, imageUrl) => {
      if (event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== home) throw new Error('無法從此頁面開啟資料夾');
      const url = new URL(imageUrl);
      if (url.origin !== new URL(home).origin || url.pathname !== '/view') throw new Error('請先選擇圖庫或生成的圖片');
      const type = url.searchParams.get('type') || 'output';
      if (!['output', 'input', 'temp'].includes(type)) throw new Error('無效的圖片位置');
      const directory = await fs.realpath(path.join(root, type));
      const filename = url.searchParams.get('filename');
      if (!filename || path.basename(filename) !== filename) throw new Error('無效的圖片檔名');
      const full = await fs.realpath(path.resolve(directory, url.searchParams.get('subfolder') || '', filename));
      const relative = path.relative(directory, full);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !(await fs.stat(full)).isFile()) throw new Error('圖片不在指定資料夾內');
      return full;
    };
    ipcMain.handle('yomu:reveal-image', async (event, imageUrl) => {
      shell.showItemInFolder(await resolveImage(event, imageUrl));
    });
    ipcMain.handle('yomu:trash-image', async (event, imageUrl) => {
      const full = await resolveImage(event, imageUrl);
      const url = new URL(imageUrl);
      if ((url.searchParams.get('type') || 'output') !== 'output' || !['.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(full).toLowerCase())) throw new Error('只能刪除圖庫中的圖片');
      await shell.trashItem(full);
    });
    Menu.setApplicationMenu(null);
    window = new BrowserWindow({
      width: 1440, height: 980, minWidth: 900, minHeight: 600,
      title: 'Yomu', backgroundColor: '#f6f5f1',
      icon: path.join(__dirname, '..', 'assets', 'yomu.ico'),
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'yomu-preload.cjs') },
    });
    window.maximize();
    window.webContents.setWindowOpenHandler(({ url }) => {
      const target = new URL(url);
      if (target.hostname === '127.0.0.1' || target.protocol === 'blob:') {
        return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } } };
      }
      // 外部網站（Civitai 等）交給系統預設瀏覽器開，App 本身不載入
      if (target.protocol === 'https:' || target.protocol === 'http:') shell.openExternal(url);
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      const target = new URL(url);
      if (target.hostname !== '127.0.0.1') {
        event.preventDefault();
        if (target.protocol === 'https:' || target.protocol === 'http:') shell.openExternal(url);
      }
    });
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r'))) {
        event.preventDefault(); window.webContents.reloadIgnoringCache();
      }
    });
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<html lang="zh-TW"><meta charset="UTF-8"><title>Yomu</title><body style="margin:0;background:#f6f5f1;color:#384035;display:grid;place-content:center;height:100vh;font-family:Segoe UI,Microsoft JhengHei;text-align:center"><h1 style="font-family:Georgia;font-size:42px">Yomu.</h1><p>正在準備創作空間…</p><p style="font-size:13px;color:#777">第一次啟動可能需要一點時間</p></body></html>'));
    try {
      let ready = await fetch(home, { signal: AbortSignal.timeout(1500) }).then(r => r.ok).catch(() => false);
      if (!ready) {
        const launcherReady = await fetch(launcher + '/api/status', { signal: AbortSignal.timeout(1500) }).then(r => r.ok).catch(() => false);
        if (!launcherReady) {
          const child = spawn(path.join(root, 'venv', 'Scripts', 'pythonw.exe'), [path.join(__dirname, 'launcher.py'), '--no-browser'], { cwd: root, windowsHide: true, detached: true, stdio: 'ignore' });
          child.unref();
          for (let n = 0; n < 30; n++) {
            if (await fetch(launcher + '/api/status').then(r => r.ok).catch(() => false)) break;
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
        const result = await fetch(launcher + '/api/start', { method: 'POST' }).then(r => r.json());
        if (!result.ok) throw new Error(result.msg);
        for (let n = 0; n < 150; n++) {
          ready = await fetch(home, { signal: AbortSignal.timeout(1500) }).then(r => r.ok).catch(() => false);
          if (ready || window.isDestroyed()) break;
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        if (!ready) throw new Error('ComfyUI 啟動逾時，請檢查啟動器記錄。');
      }
      if (!window.isDestroyed()) await window.loadURL(home);
    } catch (error) {
      if (!window.isDestroyed()) {
        await dialog.showMessageBox(window, { type: 'error', title: 'Yomu 啟動失敗', message: error.message, buttons: ['開啟啟動器'] });
        await window.loadURL(launcher);
      }
    }
  });
}
app.on('window-all-closed', () => app.quit());
