const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..', '..');
const home = 'http://127.0.0.1:8188/yomu';
const launcher = 'http://127.0.0.1:8189';
app.setName('Yomu');
app.setPath('userData', path.join(root, 'user', 'yomu-app'));
app.setAppUserModelId('Yomu.Studio');
let yomuWindow, launcherWindow;

const alive = (win) => win && !win.isDestroyed();
const reachable = (url) => fetch(url, { signal: AbortSignal.timeout(1500) }).then(r => r.ok).catch(() => false);
const focus = (win) => { if (win.isMinimized()) win.restore(); win.focus(); };

function createWindow(options) {
  const win = new BrowserWindow({
    minWidth: 700, minHeight: 500, backgroundColor: '#f6f5f1',
    icon: path.join(__dirname, '..', 'assets', 'yomu.ico'),
    ...options,
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    const target = new URL(url);
    if (target.hostname === '127.0.0.1' || target.protocol === 'blob:') {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } } };
    }
    // 外部網站（Civitai 等）交給系統預設瀏覽器開，App 本身不載入
    if (target.protocol === 'https:' || target.protocol === 'http:') shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    if (target.hostname !== '127.0.0.1') {
      event.preventDefault();
      if (target.protocol === 'https:' || target.protocol === 'http:') shell.openExternal(url);
    }
  });
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r'))) {
      event.preventDefault(); win.webContents.reloadIgnoringCache();
    }
  });
  return win;
}

const splash = (title, text) => 'data:text/html;charset=utf-8,' + encodeURIComponent(`<html lang="zh-TW"><meta charset="UTF-8"><title>${title}</title><body style="margin:0;background:#f6f5f1;color:#384035;display:grid;place-content:center;height:100vh;font-family:Segoe UI,Microsoft JhengHei;text-align:center"><h1 style="font-family:Georgia;font-size:42px">Yomu.</h1><p>${text}</p></body></html>`);

async function openLauncher() {
  if (alive(launcherWindow)) return focus(launcherWindow);
  const win = launcherWindow = createWindow({ width: 820, height: 900, title: 'Yomu 啟動器', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  await win.loadURL(splash('Yomu 啟動器', '正在開啟啟動器…'));
  for (let n = 0; n < 20 && !win.isDestroyed(); n++) {
    if (await reachable(launcher + '/api/status')) return win.loadURL(launcher);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!win.isDestroyed()) await win.loadURL(splash('Yomu 啟動器', '啟動器沒有回應，請關掉這個視窗後重新開啟 Yomu。'));
}

async function openYomu() {
  if (alive(yomuWindow)) return focus(yomuWindow);
  const win = yomuWindow = createWindow({
    width: 1440, height: 980, minWidth: 900, minHeight: 600, title: 'Yomu',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'yomu-preload.cjs') },
  });
  win.maximize();
  await win.loadURL(splash('Yomu', '正在準備創作空間…'));
  const ready = await reachable(home);
  if (win.isDestroyed()) return;
  if (ready) return win.loadURL(home);
  await dialog.showMessageBox(win, { type: 'error', title: 'Yomu', message: 'ComfyUI 還沒啟動，請先在啟動器按「啟動 ComfyUI」。', buttons: ['開啟啟動器'] });
  const opening = openLauncher();
  win.close();
  await opening;
}

const openFor = (argv) => (argv.includes('--launcher') ? openLauncher() : openYomu());

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (event, argv) => openFor(argv));
  app.whenReady().then(() => {
    const resolveImage = async (event, imageUrl) => {
      if (!alive(yomuWindow) || event.senderFrame !== yomuWindow.webContents.mainFrame || event.senderFrame.url !== home) throw new Error('無法從此頁面開啟資料夾');
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
    openFor(process.argv);
  });
}
app.on('window-all-closed', () => app.quit());
