/* Electron preload - the only bridge between the shared UI and the desktop.
 *
 * Context isolation is on, so the renderer sees just this small, explicit API
 * and never Node itself. app.js checks for window.ccDesktop to decide whether
 * folder features are available; on the phone that object is simply absent and
 * the identical code falls back to the Add-statement file picker.
 *
 * CommonJS (.cjs) on purpose: Electron's sandboxed preload scripts are only
 * reliably supported as CommonJS, so this stays paired with electron-main.cjs
 * even though the rest of the project uses ES modules. The .cjs extension
 * always parses as CommonJS in Node, independent of the project's
 * "type": "module" setting, so nothing here needed to change.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ccDesktop', {
  // Pick a statements folder to watch.
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  // List PDFs already in a folder (catch up on reopen), then begin watching.
  scanFolder: async (folder) => {
    const files = await ipcRenderer.invoke('scan-folder', folder);
    ipcRenderer.invoke('watch-folder', folder).catch(() => {});
    return files;
  },
  // Read a PDF's bytes for on-device parsing.
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  // Notified when a settled new PDF appears in the watched folder.
  onNewFile: (cb) => ipcRenderer.on('new-file', (_e, path) => cb(path)),
  onWatchError: (cb) => ipcRenderer.on('watch-error', () => cb()),
});
