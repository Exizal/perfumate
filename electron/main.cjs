// Desktop shell for Micro-Batch Lab Journal. The app itself is the same web build; this file
// serves it from a fixed local origin (so the IndexedDB database stays put), and provides
// folder sync, balance (serial port) access and native save dialogs.
const { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SYNC_FILE = 'lab-journal-sync.json';
const DIST = path.join(__dirname, '..', 'dist');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Micro-Batch Lab Journal',
    backgroundColor: '#f4f4f2',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });
  win.loadURL('app://lab/index.html');
}

function setupSerial() {
  const ses = session.defaultSession;
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'serial' || permission === 'clipboard-sanitized-write');
  ses.setDevicePermissionHandler((details) => details.deviceType === 'serial');
  // The page asks for a port; the user picks one here. Nothing connects without that choice.
  ses.on('select-serial-port', async (event, portList, _wc, callback) => {
    event.preventDefault();
    if (!portList.length) {
      await dialog.showMessageBox(win, { type: 'info', message: 'No serial or USB balance was found.', detail: 'Connect the balance, switch on its data output, and try again.' });
      callback('');
      return;
    }
    const labels = portList.map((p) => `${p.displayName || p.portName}${p.portName && p.displayName ? ` (${p.portName})` : ''}`);
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', message: 'Choose the balance port', buttons: [...labels, 'Cancel'], cancelId: labels.length, noLink: true,
    });
    callback(response < portList.length ? portList[response].portId : '');
  });
}

function setupIpc() {
  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Choose a sync folder' });
    if (r.canceled || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });
  // The page can only read and write the sync file itself, never other files.
  const checkPath = (p) => {
    const full = path.resolve(String(p));
    if (path.basename(full) !== SYNC_FILE) throw new Error('Only the sync file can be accessed.');
    return full;
  };
  ipcMain.handle('read-text', async (_e, p) => {
    const full = checkPath(p);
    try { return await fs.readFile(full, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  });
  ipcMain.handle('write-text', async (_e, p, text) => {
    const full = checkPath(p);
    if (typeof text !== 'string' || text.length > 200 * 1024 * 1024) throw new Error('Invalid data');
    const tmp = `${full}.tmp-${process.pid}`;
    await fs.writeFile(tmp, text, 'utf8');
    await fs.rename(tmp, full); // replace in one step so a reader never sees half a file
  });
}

function setupMenu() {
  const template = [
    { label: 'File', submenu: [{ role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  setupSerial();
  setupIpc();
  setupMenu();
  createWindow();
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
