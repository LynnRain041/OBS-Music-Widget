const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    getConfig: () => new Promise(resolve => {
        ipcRenderer.once('config-data', (event, config) => resolve(config));
        ipcRenderer.send('get-config');
    }),
    saveConfig: (config) => ipcRenderer.send('save-config', config),
    getActiveProcesses: () => ipcRenderer.send('get-active-processes'),
    onActiveProcesses: (callback) => {
        ipcRenderer.on('active-processes', (event, list) => callback(list));
    }
});
