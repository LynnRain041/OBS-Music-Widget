const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage } = require('electron');
const path = require('path');

// Disable Hardware Acceleration right away to fix blank screen bugs on some GPUs
app.disableHardwareAcceleration();
const fs = require('fs');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const { Worker } = require('worker_threads');

// --- Configuration Storage ---
const defaultConfig = {
    primaryColor: '#7c6aef',
    secondaryColor: '#a78bfa',
    layoutType: 'standard', // standard, compact, vertical
    animationType: 'fade', // fade, slide, zoom
    marqueeEnabled: true,
    marqueeSpeed: 10,
    processList: 'Spotify.exe, chrome.exe, vlc.exe'
};

let configPath = '';
let currentConfig = { ...defaultConfig };

function initConfig() {
    configPath = path.join(app.getPath('userData'), 'user-config.json');
    try {
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, 'utf8');
            currentConfig = { ...defaultConfig, ...JSON.parse(data) };
        }
    } catch (e) {
        console.error('Failed to load config', e);
    }
}

function saveConfig() {
    try {
        fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2));
    } catch (e) {
        console.error('Failed to save config', e);
    }
}

// No immediate loadConfig call here

// --- Globals ---
let mainWindow = null;
let tray = null;
let wsServer = null;
let connectedClients = new Set();
let smtcMonitor = null;
let currentAppId = null;

// The latest media state to send to new clients immediately
let lastMediaState = {
    title: '',
    artist: '',
    thumbnail: null,
    status: 'stopped',
    position_sec: 0,
    duration_sec: 0,
    server_time: 0
};

// --- HTTP and WS Server ---
const expressApp = express();
const server = http.createServer(expressApp);

// Serve the widget directory
expressApp.use(express.static(path.join(__dirname, 'widget')));

wsServer = new WebSocket.Server({ server });

wsServer.on('connection', (ws) => {
    connectedClients.add(ws);
    
    // Send current state and config immediately
    sendCurrentState(ws);

    ws.on('close', () => {
        connectedClients.delete(ws);
    });
});

function broadcastState() {
    for (const client of connectedClients) {
        if (client.readyState === WebSocket.OPEN) {
            sendCurrentState(client);
        }
    }
}

function sendCurrentState(client) {
    const payload = {
        ...lastMediaState,
        config: currentConfig
    };
    client.send(JSON.stringify(payload));
}

// Start Server
server.listen(8765, () => {
    console.log('OBS Media Widget server listening on port 8765');
});

// --- SMTC Tracking via Worker Thread to Fix WinRT STA/MTA COM Deadlocks ---
let smtcWorker = null;

function initSMTC() {
    smtcWorker = new Worker(path.join(__dirname, 'smtc-worker.js'));
    
    // Pass initial config
    smtcWorker.postMessage({ type: 'config-update', processList: currentConfig.processList });
    
    smtcWorker.on('message', (msg) => {
        if (msg.type === 'media-update') {
            lastMediaState = { ...lastMediaState, ...msg.data };
            broadcastState();
        } else if (msg.type === 'process-list') {
            if (mainWindow) {
                mainWindow.webContents.send('active-processes', msg.data);
            }
        }
    });

    smtcWorker.on('error', (err) => {
        console.error("SMTC Worker crashed: ", err);
    });
}



// Generate a basic 32x32 colored square icon
const appIconBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAACmSURBVFhH7dexDoJACATh0dJQS0ttLbS1ttL+/6G9TCIXF5jMbnJ+w8k2A8xP0yU4yR10l2CWO+gswS130FWCK+6giwRfcwfNJfilO2gqwW/dQVMB/qA7mC3AH3UHswT4Z3cwS2Ag7A4mCwyM3cEkgYGxO+gm0K876CbQrzvoJtCvO+gm0K876CbQrzvoJtCvO+gm0K876CbQrzvoJtCvO+gm0K87mCww8B9Eyw+O0wH0tAAAAABJRU5ErkJggg==';

let trayIcon = null;

function createWindow() {
    trayIcon = nativeImage.createFromDataURL(appIconBase64);
    
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        show: false,
        backgroundColor: '#1a1a1a',
        transparent: false,
        icon: trayIcon,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html')).catch(err => {
        console.error('Failed to load renderer/index.html!', err);
    });
    mainWindow.setMenuBarVisibility(false);
    
    // Always show the window regardless of 'ready-to-show' wait
    mainWindow.show(); 
    
    // For safety, handle load failure
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
        console.error('Failed to load!', errorCode, errorDescription);
    });

    mainWindow.on('close', (event) => {
        if (!app.isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });
}

function createTray() {
    if (!trayIcon) {
        trayIcon = nativeImage.createFromDataURL(appIconBase64);
    }
    tray = new Tray(trayIcon);
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Open Settings', click: () => mainWindow.show() },
        { type: 'separator' },
        { label: 'Quit', click: () => {
            app.isQuitting = true;
            app.quit();
        }}
    ]);
    tray.setToolTip('OBS Media Widget');
    tray.setContextMenu(contextMenu);
    
    tray.on('click', () => {
        if (mainWindow) {
            mainWindow.show();
        }
    });
}
app.on('ready', () => {
    // Setup Config
    initConfig();

    createWindow();
    createTray();
    initSMTC();
});

// Provide IPC to renderer
ipcMain.on('get-config', (event) => {
    event.reply('config-data', currentConfig);
});

ipcMain.on('save-config', (event, newConfig) => {
    currentConfig = { ...currentConfig, ...newConfig };
    saveConfig();
    if (smtcWorker) {
        smtcWorker.postMessage({ type: 'config-update', processList: currentConfig.processList });
    }
    broadcastState(); // Notify all listening clients about new config!
});

ipcMain.on('get-active-processes', () => {
    if (smtcWorker) {
        smtcWorker.postMessage({ type: 'get-processes' });
    }
});

