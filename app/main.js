'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const { URL } = require('node:url');

// Packaged, the converter ships as an unpacked resource; in dev it sits next door.
const OUTPUTS = app.isPackaged
  ? path.join(process.resourcesPath, 'converter')
  : path.join(__dirname, '..', 'converter');
const PYTHON = process.env.CBZ_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const THEME_PREFERENCE_FILE = 'theme.json';

let backend = null;
let win = null;
let updateState = { phase: 'idle', version: '' };
const DOWNLOAD_HOSTS = new Set([
  '7-zip.org', 'www.7-zip.org', 'github.com', 'release-assets.githubusercontent.com',
  'gyan.dev', 'www.gyan.dev', 'download.imagemagick.org',
  'download.documentfoundation.org', 'poppler.freedesktop.org',
  'calibre-ebook.com', 'download.calibre-ebook.com',
]);

function normalizeTheme(theme) {
  return theme === 'dark' ? 'dark' : 'light';
}

function themePreferencePath() {
  return path.join(app.getPath('userData'), THEME_PREFERENCE_FILE);
}

function readThemePreference() {
  try {
    const saved = JSON.parse(fs.readFileSync(themePreferencePath(), 'utf8'));
    return normalizeTheme(saved.theme);
  } catch {
    return 'light';
  }
}

function writeThemePreference(theme) {
  const next = normalizeTheme(theme);
  try {
    const preferencePath = themePreferencePath();
    fs.mkdirSync(path.dirname(preferencePath), { recursive: true });
    fs.writeFileSync(preferencePath, `${JSON.stringify({ theme: next })}\n`, 'utf8');
  } catch (error) {
    console.warn('[theme] could not persist preference:', error.message);
  }
  return next;
}

function publishUpdateState(next) {
  updateState = { ...updateState, ...next };
  if (win && !win.isDestroyed()) win.webContents.send('update:state', updateState);
}

function dependencyProgress(next) {
  if (win && !win.isDestroyed()) win.webContents.send('dependency:progress', next);
}

function safeDownloadUrl(raw) {
  const parsed = new URL(String(raw));
  if (parsed.protocol !== 'https:' || ![...DOWNLOAD_HOSTS].some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) {
    throw new Error('Dependency downloads must use an approved HTTPS source.');
  }
  return parsed;
}

function downloadFile(rawUrl, target, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('Too many download redirects.'));
  const url = safeDownloadUrl(rawUrl);
  return new Promise((resolve, reject) => {
    const request = https.get(url, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        downloadFile(new URL(response.headers.location, url).toString(), target, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${response.statusCode}.`));
        return;
      }
      const total = Number(response.headers['content-length'] || 0);
      let received = 0;
      const file = fs.createWriteStream(target);
      response.on('data', chunk => {
        received += chunk.length;
        dependencyProgress({ phase: 'downloading', received, total });
      });
      response.on('error', error => { file.destroy(); reject(error); });
      file.on('error', reject);
      file.on('finish', () => file.close(() => resolve()));
      response.pipe(file);
    });
    request.on('error', reject);
  });
}

async function downloadDependency(rawUrl, helperName) {
  const url = safeDownloadUrl(rawUrl);
  const folder = path.join(app.getPath('downloads'), 'One Tool Helpers');
  fs.mkdirSync(folder, { recursive: true });
  let fromUrl = path.basename(url.pathname).replace(/[^a-zA-Z0-9._-]/g, '_');
  // Calibre intentionally exposes a stable, extensionless redirect endpoint.
  // Preserve a useful extension so Windows can open the downloaded installer.
  if (url.hostname === 'calibre-ebook.com' && url.pathname === '/dist/win64') fromUrl = 'calibre-installer-x64.msi';
  const filename = fromUrl && fromUrl !== '.' ? fromUrl : `${String(helperName || 'helper').replace(/[^a-zA-Z0-9._-]/g, '_')}.download`;
  const target = path.join(folder, filename);
  dependencyProgress({ phase: 'downloading', helper: helperName, received: 0, total: 0 });
  try {
    await downloadFile(url.toString(), target);
  } catch (error) {
    try { fs.rmSync(target, { force: true }); } catch {}
    dependencyProgress({ phase: 'error', helper: helperName, error: error.message });
    throw error;
  }
  dependencyProgress({ phase: 'ready', helper: helperName, path: target });
  shell.showItemInFolder(target);
  return { path: target, filename };
}

function setupAutoUpdater() {
  // electron-updater cannot check a development window and should never make
  // local development depend on GitHub being reachable.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => publishUpdateState({ phase: 'checking' }));
  autoUpdater.on('update-not-available', () => publishUpdateState({ phase: 'idle', version: '' }));
  autoUpdater.on('update-available', info => {
    publishUpdateState({ phase: 'downloading', version: info.version, progress: 0 });
    autoUpdater.downloadUpdate().catch(error => {
      console.error('[updater] download failed:', error);
      publishUpdateState({ phase: 'idle', version: '' });
    });
  });
  autoUpdater.on('download-progress', progress => {
    publishUpdateState({ phase: 'downloading', progress: progress.percent });
  });
  autoUpdater.on('update-downloaded', info => {
    publishUpdateState({ phase: 'ready', version: info.version, progress: 100 });
  });
  autoUpdater.on('error', error => {
    console.error('[updater] check failed:', error);
    publishUpdateState({ phase: 'idle', version: '' });
  });

  autoUpdater.checkForUpdates().catch(error => {
    console.error('[updater] check failed:', error);
    publishUpdateState({ phase: 'idle', version: '' });
  });
}

/** Ask the OS for a free port so two instances never collide. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function waitForServer(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error('the converter backend did not start'));
        else setTimeout(attempt, 120);
      });
    };
    attempt();
  });
}

async function startBackend() {
  const port = await freePort();
  const backendEnv = {
    ...process.env,
    ONETOOL_NODE_RUNTIME: process.execPath,
    ONETOOL_PDF_MD_RUNNER: path.join(__dirname, 'pdf_to_md.cjs'),
    ONETOOL_HISTORY_PATH: path.join(app.getPath('userData'), 'history.json'),
    ONETOOL_ELECTRON_RUN_AS_NODE: '1',
  };
  backend = spawn(PYTHON, ['server.py', '--port', String(port), '--no-browser'], {
    cwd: OUTPUTS,
    env: backendEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  backend.stdout.on('data', d => process.stdout.write(`[backend] ${d}`));
  backend.stderr.on('data', d => process.stderr.write(`[backend] ${d}`));
  backend.on('exit', code => {
    backend = null;
    if (code !== 0 && code !== null && !app.isQuitting) {
      dialog.showErrorBox('Converter stopped', `The Python backend exited with code ${code}.`);
    }
  });
  await waitForServer(port);
  return port;
}

function createWindow(port) {
  win = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 801,
    minHeight: 491,
    show: false,
    frame: false,                    // the app draws its own title bar
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#f2f2f4',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadURL(`http://127.0.0.1:${port}/`);
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });

  const sync = () => win && !win.isDestroyed() && win.webContents.send('window:state', {
    maximized: win.isMaximized(),
    focused: win.isFocused()
  });
  for (const evt of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur']) {
    win.on(evt, sync);
  }
}

ipcMain.handle('window:minimize', () => win && win.minimize());
ipcMain.handle('window:toggleMaximize', () => {
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
  return win.isMaximized();
});
ipcMain.handle('window:close', () => win && win.close());
ipcMain.handle('theme:get', () => readThemePreference());
ipcMain.handle('window:set-theme', (_event, theme) => {
  const next = writeThemePreference(theme);
  if (win && !win.isDestroyed()) win.setBackgroundColor(next === 'dark' ? '#000000' : '#f2f2f4');
  return next;
});
ipcMain.handle('window:isMaximized', () => Boolean(win && win.isMaximized()));
ipcMain.handle('update:get-state', () => updateState);
ipcMain.handle('update:install', () => {
  if (updateState.phase !== 'ready') return false;
  app.isQuitting = true;
  autoUpdater.quitAndInstall(false, true);
  return true;
});
ipcMain.handle('dependency:download', (_event, payload = {}) =>
  downloadDependency(payload.url, payload.name)
);

app.whenReady().then(async () => {
  try {
    createWindow(await startBackend());
    setupAutoUpdater();
  } catch (err) {
    dialog.showErrorBox('Could not start', `${err.message}\n\nIs Python 3.10+ on your PATH? Set CBZ_PYTHON to override.`);
    app.quit();
  }

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(await startBackend());
  });
});

app.on('before-quit', () => { app.isQuitting = true; });
app.on('will-quit', () => { if (backend) backend.kill(); });
app.on('window-all-closed', () => app.quit());
