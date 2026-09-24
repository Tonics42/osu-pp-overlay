import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserWindow, Menu, Tray, app, ipcMain, nativeImage, shell } from 'electron';

import { Config } from './config.js';
import { OverlaySession } from './overlay.js';
import { TosuClient } from './tosu.js';
import { ensureTosuInstalled } from './tosuInstall.js';

const require = createRequire(import.meta.url);
const { calculate } = require('./calc.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
// Installed builds keep config, log and tosu in %APPDATA%\osu! PP Overlay; a source checkout keeps them in place.
const DATA_DIR = app.isPackaged ? app.getPath('userData') : APP_DIR;
fs.mkdirSync(DATA_DIR, { recursive: true });
const PREVIEW = process.argv.includes('--preview');

// Same GPU setup as tosu's in-game overlay: shared textures must live on the game's GPU.
app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-direct-composition');

const config = new Config(DATA_DIR);
config.preloadPath = path.join(__dirname, 'preload.cjs');
const UI_FILE = path.join(APP_DIR, 'ui', 'index.html');

/** @type {Map<number, OverlaySession>} */
const sessions = new Map();
const failedAttach = new Map(); // pid -> retry after timestamp
let tosuProcess = null;
let tray = null;
let previewWindow = null;
let tosu = null;

function broadcastTosu(state) {
    const targets = [...sessions.values()].filter(Boolean).map((s) => s.window);
    if (previewWindow) targets.push(previewWindow);
    for (const w of targets) {
        if (!w.isDestroyed()) w.webContents.send('tosu', state);
    }
}

const LOG_FILE = path.join(DATA_DIR, 'overlay.log');
try {
    if (fs.statSync(LOG_FILE).size > 1024 * 1024) fs.rmSync(LOG_FILE);
} catch {
    // no log yet
}

function log(...args) {
    const line = [new Date().toLocaleTimeString(), ...args]
        .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack || a.message : JSON.stringify(a)))
        .join(' ');
    console.log(line);
    try {
        fs.appendFileSync(LOG_FILE, `${line}\n`);
    } catch {
        // ignore
    }
}

// ---------- tosu ----------

async function isTosuUp() {
    try {
        // Any HTTP answer means tosu is up (it replies with an error status while osu! isn't running).
        await fetch(`http://${config.data.tosuHost}/json/v2`, { signal: AbortSignal.timeout(1500) });
        return true;
    } catch {
        return false;
    }
}

async function ensureTosu() {
    if (!config.data.autoStartTosu || (await isTosuUp())) return;

    const exe = path.resolve(DATA_DIR, config.data.tosuPath);
    if (!(await ensureTosuInstalled(exe, log, notify))) return;
    log('starting tosu:', exe);
    tosuProcess = spawn(exe, [], { cwd: path.dirname(exe), windowsHide: true, stdio: 'ignore' });
    tosuProcess.on('exit', (code) => {
        log('tosu exited with code', code);
        tosuProcess = null;
    });
}

// ---------- game process watcher ----------

function listGamePids() {
    return new Promise((resolve) => {
        execFile(
            'tasklist',
            ['/FI', 'IMAGENAME eq osu!.exe', '/FO', 'CSV', '/NH'],
            { windowsHide: true },
            (err, stdout) => {
                if (err) return resolve([]);
                const pids = [];
                for (const line of stdout.split(/\r?\n/)) {
                    const cols = line.split('","');
                    if (cols.length > 1 && cols[0].replace(/"/g, '').toLowerCase() === 'osu!.exe') {
                        pids.push(Number(cols[1]));
                    }
                }
                resolve(pids);
            }
        );
    });
}

const exePathCache = new Map(); // pid -> executable path

function getExePath(pid) {
    if (exePathCache.has(pid)) return Promise.resolve(exePathCache.get(pid));
    return new Promise((resolve) => {
        execFile(
            'powershell.exe',
            ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).Path`],
            { windowsHide: true },
            (err, stdout) => {
                const exe = err ? '' : stdout.trim();
                exePathCache.set(pid, exe);
                resolve(exe);
            }
        );
    });
}

/** osu!lazer lives in %LOCALAPPDATA%\osulazer; osu!stable (anti-cheat!) is skipped unless allowed. */
async function isAllowedGame(pid) {
    if (config.data.allowStable) return true;
    const exe = (await getExePath(pid)).toLowerCase();
    return exe.includes('osulazer');
}

async function watchGame() {
    const pids = await listGamePids();
    for (const pid of pids) {
        if (sessions.has(pid)) continue;
        if ((failedAttach.get(pid) || 0) > Date.now()) continue;
        if (!(await isAllowedGame(pid))) {
            if (!failedAttach.has(pid)) log('skipping non-lazer osu! process', pid, exePathCache.get(pid));
            failedAttach.set(pid, Infinity);
            continue;
        }
        sessions.set(pid, null); // reserve while attaching
        attach(pid);
    }
}

async function attach(pid) {
    try {
        log('attaching to osu! pid', pid);
        const session = await OverlaySession.attach(pid, config, log);
        sessions.set(pid, session);

        session.on('destroyed', () => {
            log('overlay detached from pid', pid);
            sessions.delete(pid);
        });
        session.on('toggle-panel', () => session.window.webContents.send('toggle-panel'));
        session.on('show-panel', () => session.window.webContents.send('show-panel'));
        session.on('save-position', (pos) => config.update({ panel: pos }));

        const wc = session.window.webContents;
        wc.on('console-message', (e) => log('[ui]', e.message));
        wc.on('render-process-gone', (_e, details) => log('[ui] renderer gone:', details));
        let paints = 0;
        wc.on('paint', (e) => {
            paints++;
            if (paints === 1 || paints % 600 === 0) {
                log(`[paint] #${paints}`, e?.texture ? 'shared-texture' : 'bitmap', session.window.getSize().join('x'));
            }
        });

        wc.on('did-finish-load', () => session.sendLayout());
        await session.window.loadFile(UI_FILE);
        log('overlay ready in pid', pid);
    } catch (err) {
        log('attach failed for pid', pid, err?.message || err);
        sessions.delete(pid);
        failedAttach.set(pid, Date.now() + 15000);
    }
}

function sessionFor(webContents) {
    for (const s of sessions.values()) {
        if (s && s.window.webContents === webContents) return s;
    }
    return null;
}

// ---------- IPC ----------

function resolveBeatmapPath({ songsFolder, beatmapFile }) {
    if (!beatmapFile) return null;
    const candidates = [];
    if (path.isAbsolute(beatmapFile)) candidates.push(beatmapFile);
    if (songsFolder) candidates.push(path.join(songsFolder, beatmapFile));
    candidates.push(path.join(process.env.APPDATA || '', 'osu', 'files', beatmapFile));
    return candidates.find((p) => {
        try {
            return fs.statSync(p).isFile();
        } catch {
            return false;
        }
    });
}

ipcMain.handle('calc', (_e, req) => {
    const file = resolveBeatmapPath(req);
    if (!file) return { error: 'Файл карты не найден' };
    try {
        return calculate({ ...req, path: file });
    } catch (err) {
        return { error: String(err?.message || err) };
    }
});

ipcMain.handle('get-config', () => ({ ...config.data, preview: PREVIEW }));

ipcMain.handle('get-tosu', () => tosu?.state() ?? { connected: false, data: null });

ipcMain.on('save-panel', (_e, panel) => config.update({ panel }));

ipcMain.on('panel-state', (e, panel) => sessionFor(e.sender)?.setPanel(panel));

ipcMain.on('set-locked', (e, locked) => sessionFor(e.sender)?.setLocked(locked));

ipcMain.on('drag-start', (e) => sessionFor(e.sender)?.startDrag());

ipcMain.on('set-pinned', (e, pinned) => sessionFor(e.sender)?.setPinned(pinned));

// null in the preview window: the page then lays itself out in its own window.
ipcMain.handle('get-game-size', (e) => sessionFor(e.sender)?.game ?? null);

// ---------- app ----------

function trayIcon() {
    return nativeImage.createFromPath(path.join(APP_DIR, 'build', 'icon-256.png')).resize({ width: 16, height: 16 });
}

function notify(content) {
    try {
        tray?.displayBalloon({ title: 'osu! PP Overlay', content, iconType: 'info' });
    } catch {
        // balloons are best effort
    }
}

function createTray() {
    tray = new Tray(trayIcon());
    tray.setToolTip('osu! PP Overlay');
    tray.setContextMenu(
        Menu.buildFromTemplate([
            { label: 'osu! PP Overlay', enabled: false },
            { type: 'separator' },
            { label: 'Перезагрузить оверлей', click: () => reloadAll() },
            { label: 'Открыть окно предпросмотра', click: () => openPreview() },
            { label: 'Открыть config.json', click: () => shell.openPath(config.file) },
            { label: 'Открыть папку с логом', click: () => shell.openPath(DATA_DIR) },
            { label: 'Панель tosu', click: () => shell.openExternal(`http://${config.data.tosuHost}`) },
            { type: 'separator' },
            { label: 'Выход', click: () => app.quit() }
        ])
    );
}

function reloadAll() {
    config.load();
    for (const s of sessions.values()) {
        if (!s) continue;
        s.reloadKeybinds();
        s.window.reload();
    }
}

function openPreview() {
    if (previewWindow && !previewWindow.isDestroyed()) {
        previewWindow.focus();
        return;
    }
    previewWindow = new BrowserWindow({
        width: 1280,
        height: 760,
        title: 'osu! PP Overlay — предпросмотр',
        backgroundColor: '#1b1b24',
        autoHideMenuBar: true,
        webPreferences: { preload: config.preloadPath }
    });
    const query = { preview: '1' };
    const demo = argValue('--demo');
    if (demo) query.demo = demo;
    if (process.argv.includes('--compact')) query.compact = '1';
    previewWindow.webContents.on('console-message', (e) => { if (!String(e.message).includes('Security Warning')) log('[preview]', e.message); });
    previewWindow.loadFile(UI_FILE, { query });

    // Dev helper: --capture=<file.png> saves a screenshot of the preview and quits.
    const capture = argValue('--capture');
    if (capture) {
        previewWindow.webContents.once('did-finish-load', () => {
            setTimeout(async () => {
                const image = await previewWindow.webContents.capturePage();
                fs.writeFileSync(capture, image.toPNG());
                app.quit();
            }, 2500);
        });
    }
}

function argValue(name) {
    const arg = process.argv.find((a) => a.startsWith(`${name}=`));
    return arg ? arg.slice(name.length + 1) : null;
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => openPreview());
    app.on('window-all-closed', () => {}); // keep running in tray

    app.whenReady().then(async () => {
        Menu.setApplicationMenu(null);
        try {
            // The game always wins CPU time over PP calculations.
            os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
        } catch {
            // not permitted — keep default priority
        }
        createTray();
        // In the background: the first run downloads tosu, which must not hold up the overlay.
        ensureTosu().catch((err) => log('tosu start failed:', String(err?.message || err)));
        tosu = new TosuClient(config.data.tosuHost, log);
        tosu.on('state', broadcastTosu);
        tosu.start();
        if (PREVIEW) openPreview();
        if (argValue('--capture')) return; // UI screenshot only, don't touch the game

        await watchGame();
        setInterval(watchGame, 2000);
        log('osu! PP Overlay started. Waiting for osu!...');
    });

    app.on('before-quit', () => {
        for (const s of sessions.values()) s?.destroy();
        if (tosuProcess) tosuProcess.kill();
    });

    app.on('will-quit', () => {
        // The .NET runtime inside the calculator may crash on normal teardown; exit hard instead.
        setTimeout(() => process.exit(0), 200);
    });
}
