/* Electron main process (desktop shell).
 *
 * Owns everything the browser cannot: real file-system access and folder
 * watching via chokidar. The renderer runs the identical shared UI (app.js)
 * and reaches these capabilities only through the narrow, context-isolated
 * bridge defined in electron-preload.cjs. The renderer never gets raw Node.
 *
 * This file is CommonJS (.cjs) on purpose, even though the rest of the
 * project (app.js, the build scripts) runs as ES modules ("type": "module"
 * in package.json). Electron's sandboxed preload bridge is only reliably
 * supported as CommonJS, so the main process and preload are kept as a
 * matched CommonJS pair using the .cjs extension - Node always treats .cjs
 * as CommonJS regardless of the project's module type, so this is exactly
 * as stable as it was before, with no behaviour change.
 */

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');

const projectRoot = path.resolve(__dirname, '..');

let chokidar = null;
try { chokidar = require('chokidar'); } catch { /* watcher optional until installed */ }

let mainWindow = null;
let watcher = null;
let localServer = null;

/* ---------------------------------------------------------------------
 * Serve the renderer over http://127.0.0.1 instead of file://.
 *
 * Why: app.js uses fetch('../settings/config.json') and import('../third-party/pdf.min.mjs')
 * and registers a service worker. Under the file:// protocol, Chromium
 * gives every file its own opaque origin, so fetch() of a sibling file is
 * blocked by CORS and service workers refuse to register at all (they
 * require a secure context: https or localhost). Loading the exact same
 * files over a local HTTP server - the same thing "npm run web" already
 * does - removes this whole class of failure, and also sidesteps known
 * Chromium issues loading file:// pages from inside OneDrive-synced
 * folders. Nothing else changes: every path in app.js/config.json/
 * manifest.json is relative, so it resolves the same way either way.
 * ------------------------------------------------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function startLocalServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let reqPath = decodeURIComponent((req.url || '/').split('?')[0]);
      if (reqPath === '/') reqPath = '/index.html';
      const resolved = path.normalize(path.join(projectRoot, reqPath));
      if (!resolved.startsWith(projectRoot)) { res.writeHead(403); res.end('Forbidden'); return; }
      fs.readFile(resolved, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        const ext = path.extname(resolved).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function createWindow() {
  if (!localServer) localServer = await startLocalServer();
  const { port } = localServer.address();

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 380,
    backgroundColor: '#0F6CBD',
    title: 'Personal Finance Analyser',
    webPreferences: {
      preload: path.join(__dirname, 'electron-preload.cjs'),
      contextIsolation: true,   // renderer cannot see Node
      nodeIntegration: false,   // no direct require() in the UI
      sandbox: true,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadURL(`http://127.0.0.1:${port}/index.html`);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('before-quit', () => { if (localServer) localServer.close(); });

function isSettledPdf(file) {
  return file.toLowerCase().endsWith('.pdf');
}

/* ---- IPC: the whole desktop surface the renderer is allowed to use ---- */

ipcMain.handle('choose-folder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose your statements folder',
    properties: ['openDirectory'],
  });
  return res.canceled ? null : res.filePaths[0];
});

// List the PDFs currently in a folder (used to catch up on reopen).
ipcMain.handle('scan-folder', async (_e, folder) => {
  if (!folder || !fs.existsSync(folder)) throw new Error('folder-missing');
  const entries = await fsp.readdir(folder);
  return entries.filter(isSettledPdf).map((f) => path.join(folder, f));
});

// Read a PDF as bytes for the shared parser to process on-device.
ipcMain.handle('read-file', async (_e, filePath) => {
  const buf = await fsp.readFile(filePath);
  // Return an ArrayBuffer the renderer can hand straight to pdf.js.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

// Start watching a folder. chokidar's awaitWriteFinish means a half-downloaded
// PDF is never read; a settled new file is announced to the renderer.
ipcMain.handle('watch-folder', async (_e, folder) => {
  if (!chokidar) return { ok: false, reason: 'chokidar-not-installed' };
  if (!folder || !fs.existsSync(folder)) return { ok: false, reason: 'folder-missing' };
  if (watcher) { await watcher.close(); watcher = null; }
  watcher = chokidar.watch(folder, {
    depth: 0,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 1200, pollInterval: 200 },
  });
  watcher.on('add', (file) => {
    if (isSettledPdf(file) && mainWindow) mainWindow.webContents.send('new-file', file);
  });
  watcher.on('error', () => { if (mainWindow) mainWindow.webContents.send('watch-error'); });
  return { ok: true };
});
