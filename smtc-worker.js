const { parentPort } = require('worker_threads');
const { SMTCMonitor } = require('@coooookies/windows-smtc-monitor');

// In tick/duration data from WinRT, 10000000 ticks = 1 sec
function toSeconds(value) {
    if (value > 1000000) return value / 10000000;
    return value;
}

function getStatusString(statusNum) {
    switch (statusNum) {
        case 4: return 'playing';
        case 5: return 'paused';
        case 3: return 'stopped';
        default: return 'stopped';
    }
}

let smtcMonitor = null;
let currentAppId = null;
let allowedProcesses = [];

// Send completely updated state to parent
function sendState(appId, overrideMedia, overrideTimeline, overridePlayback) {
    try {
        const session = Array.isArray(smtcMonitor.sessions) ? smtcMonitor.sessions.find(s => s.sourceAppId === appId) : null;
        if (!session && !overrideMedia && !overrideTimeline && !overridePlayback) return;
        
        const media = overrideMedia || (session ? session.media : null);
        const timeline = overrideTimeline || (session ? session.timeline : null);
        const playback = overridePlayback || (session ? session.playback : null);
        
        let stateUpdate = { type: 'media-update', data: {} };
        let changed = false;

        if (media) {
            stateUpdate.data.title = media.title || '';
            stateUpdate.data.artist = media.artist || '';
            stateUpdate.data.thumbnail = media.thumbnail ? media.thumbnail.toString('base64') : null;
            changed = true;
        }

        if (timeline) {
            stateUpdate.data.position_sec = toSeconds(timeline.position);
            stateUpdate.data.duration_sec = toSeconds(timeline.duration);
            stateUpdate.data.server_time = Date.now() / 1000;
            changed = true;
        }

        if (playback) {
            stateUpdate.data.status = getStatusString(playback.playbackStatus);
            changed = true;
        }
        
        if (changed) {
            parentPort.postMessage(stateUpdate);
        }
    } catch(e) {
        console.error("SMTC Worker Session update failed:", e);
    }
}

function broadcastProcessList() {
    try {
        if (!smtcMonitor) return;
        const sessions = smtcMonitor.sessions || [];
        const appIds = sessions.map(s => s.sourceAppId);
        parentPort.postMessage({ type: 'process-list', data: appIds });
    } catch(e) {}
}

function isProcessAllowed(appId) {
    if (!appId) return false;
    if (allowedProcesses.length === 0) return true;
    const lowerAppId = appId.toLowerCase();
    return allowedProcesses.some(allowedProcess => {
        return lowerAppId.includes(allowedProcess) || lowerAppId === allowedProcess;
    });
}

function init() {
    smtcMonitor = new SMTCMonitor();

    smtcMonitor.on('current-session-changed', (sourceAppId) => {
        if (isProcessAllowed(sourceAppId)) {
            currentAppId = sourceAppId;
            sendState(sourceAppId);
        } else {
            const sessions = smtcMonitor.sessions || [];
            const fallback = sessions.find(s => isProcessAllowed(s.sourceAppId));
            currentAppId = fallback ? fallback.sourceAppId : null;
            if (currentAppId) {
                sendState(currentAppId);
            } else {
                parentPort.postMessage({ type: 'media-update', data: { status: 'stopped' } });
            }
        }
    });

    smtcMonitor.on('session-media-changed', (appId, mediaProps) => {
        if (appId === currentAppId || isProcessAllowed(appId)) {
            currentAppId = appId;
            sendState(appId, mediaProps, null, null);
        }
    });

    smtcMonitor.on('session-timeline-changed', (appId, timelineProps) => {
         if (appId === currentAppId || isProcessAllowed(appId)) {
            currentAppId = appId;
            sendState(appId, null, timelineProps, null);
        }
    });

    smtcMonitor.on('session-playback-changed', (appId, playbackInfo) => {
        if (appId === currentAppId || isProcessAllowed(appId)) {
            currentAppId = appId;
            sendState(appId, null, null, playbackInfo);
        }
    });
    
    smtcMonitor.on('session-created', () => broadcastProcessList());
    smtcMonitor.on('session-removed', () => broadcastProcessList());

    // Initial fetch
    broadcastProcessList();
    let sessions = smtcMonitor.sessions || [];
    let activeSession = sessions.find(s => isProcessAllowed(s.sourceAppId));
    if (activeSession) {
        currentAppId = activeSession.sourceAppId;
        sendState(currentAppId);
    }
}

// Receive Config updates from generic IPC Thread
parentPort.on('message', (msg) => {
    if (msg.type === 'config-update') {
        const pList = msg.processList || '';
        allowedProcesses = pList.trim() ? pList.toLowerCase().split(',').map(s => s.trim()).filter(s => s.length > 0) : [];
        
        // Retrigger state update internally if current session became disallowed!
        if (currentAppId && !isProcessAllowed(currentAppId)) {
            parentPort.postMessage({ type: 'media-update', data: { status: 'stopped' } });
            
            // Re-find active
            if (smtcMonitor) {
                let sessions = smtcMonitor.sessions || [];
                let fallback = sessions.find(s => isProcessAllowed(s.sourceAppId));
                currentAppId = fallback ? fallback.sourceAppId : null;
                if (currentAppId) {
                    sendState(currentAppId);
                }
            }
        }
    } else if (msg.type === 'get-processes') {
        broadcastProcessList();
    }
});

// Start loop
init();
