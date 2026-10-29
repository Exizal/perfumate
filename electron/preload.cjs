// Exposes a small, fixed set of desktop functions to the page (see src/desktop.ts).
const { contextBridge, ipcRenderer } = require('electron');

const sep = process.platform === 'win32' ? '\\' : '/';

contextBridge.exposeInMainWorld('desktop', {
  version: '1.0.0',
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  readText: (p) => ipcRenderer.invoke('read-text', p),
  writeText: (p, text) => ipcRenderer.invoke('write-text', p, text),
  joinPath: (...parts) => parts.map((x, i) => (i === 0 ? String(x).replace(/[\\/]+$/, '') : String(x).replace(/^[\\/]+|[\\/]+$/g, ''))).join(sep),
});
