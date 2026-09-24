const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ppApi', {
    calculate: (req) => ipcRenderer.invoke('calc', req),
    getConfig: () => ipcRenderer.invoke('get-config'),
    getTosu: () => ipcRenderer.invoke('get-tosu'),
    onTosu: (cb) => ipcRenderer.on('tosu', (_e, state) => cb(state)),
    savePanel: (panel) => ipcRenderer.send('save-panel', panel),
    reportPanel: (panel) => ipcRenderer.send('panel-state', panel),
    setLocked: (locked) => ipcRenderer.send('set-locked', locked),
    dragStart: () => ipcRenderer.send('drag-start'),
    setPinned: (pinned) => ipcRenderer.send('set-pinned', pinned),
    onLayout: (cb) => ipcRenderer.on('layout', (_e, layout) => cb(layout)),
    getGameSize: () => ipcRenderer.invoke('get-game-size'),
    onGameSize: (cb) => ipcRenderer.on('game-size', (_e, size) => cb(size)),
    onInteraction: (cb) => ipcRenderer.on('interaction', (_e, state) => cb(state)),
    onTogglePanel: (cb) => ipcRenderer.on('toggle-panel', () => cb()),
    onShowPanel: (cb) => ipcRenderer.on('show-panel', () => cb())
});
