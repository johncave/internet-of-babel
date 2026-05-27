// Global state
let runningApps = new Map();
let appRegistry = new Map();

// ---- Shared WebSocket bus ----
// One connection to /ws lives in the shell. Apps subscribe to message types
// via BabelcomAPI.subscribe(type, fn). The taskbar status indicator is driven
// from here so it works whether or not any app is open.
const BabelcomBus = (() => {
    const listeners = new Map(); // type -> Set<fn>
    const latest = new Map();    // type -> last full message
    let ws = null;
    let reconnectAttempts = 0;
    let reconnectTimer = null;
    const maxReconnectDelay = 30000;

    function connect() {
        const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${wsProtocol}//${location.host}/ws`;
        updateSystemStatus('CONNECTING', '#ffff00');

        try {
            ws = new WebSocket(url);
        } catch (e) {
            console.warn('🛰️  Bus: failed to construct WebSocket', e);
            scheduleReconnect();
            return;
        }

        ws.onopen = () => {
            reconnectAttempts = 0;
            updateSystemStatus('ONLINE', '#00ff00');
            console.log('🛰️  Babelcom bus connected');
        };

        ws.onmessage = (event) => {
            let msg;
            try { msg = JSON.parse(event.data); } catch (e) { return; }
            if (!msg || !msg.type) return;

            latest.set(msg.type, msg);

            // Shell-side reactions
            if (msg.type === 'system_status' && msg.data) {
                updateSystemStatus(msg.data.current_phase || 'ONLINE', '#00ff00');
            }

            const subs = listeners.get(msg.type);
            if (subs) {
                for (const fn of subs) {
                    try { fn(msg); } catch (e) { console.error('subscriber error', e); }
                }
            }
        };

        ws.onclose = () => {
            ws = null;
            updateSystemStatus('OFFLINE', '#ff0000');
            scheduleReconnect();
        };

        ws.onerror = (e) => {
            console.warn('🛰️  Babelcom bus error', e);
        };
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;
        reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), maxReconnectDelay);
        updateSystemStatus(`RECONNECTING ${Math.round(delay / 1000)}s`, '#ffff00');
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, delay);
    }

    function subscribe(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
        return () => listeners.get(type)?.delete(fn);
    }

    function getLatest(type) {
        return latest.get(type) || null;
    }

    return { connect, subscribe, getLatest };
})();

// Initialize the desktop
document.addEventListener('DOMContentLoaded', function() {
    initializeDesktop();
    updateClock();
    setInterval(updateClock, 1000);
    BabelcomBus.connect();
    // Open web browser in fullscreen on load
    // setTimeout(() => {
    //     let win = openApp('library-browser');
    //     win.maximize()
    // }, 100);

    // Auto-open Start app if never opened or last opened > 1 week ago
    try {
        const lastStartOpened = localStorage.getItem('startLastOpened');
        const now = Date.now();
        const oneWeek = 7 * 24 * 60 * 60 * 1000;
        if (!lastStartOpened || now - parseInt(lastStartOpened, 10) > oneWeek) {
            openApp('welcome');
        }
    } catch (e) {
        // Fallback: always open if localStorage fails
        openApp('welcome');
    }
});

// Desktop initialization
function initializeDesktop() {
    console.log('🚀 Babelcom Desktop Initializing...');
    
    // Register built-in apps.
    // tag-based apps are shadow DOM custom elements (isolated CSS + DOM).
    // component-based apps are the legacy global-object pattern.
    registerApp('system-monitor', {
        name: 'System Monitor',
        icon: '📊',
        iconPath: '/static/icons/system-monitor.png',
        tag: 'babel-system-monitor',
        defaultWidth: 600,
        defaultHeight: 800
    });

    registerApp('library-browser', {
        name: 'Web of Babel',
        icon: '📖',
        iconPath: '/static/icons/web-browser.png',
        tag: 'babel-library-browser'
    });

    // TODO: migrate radio to shadow DOM (Butterchurn + audio context need careful handling)
    registerApp('radio', {
        name: 'Radio',
        icon: '📻',
        iconPath: '/static/icons/radio.png',
        component: RadioApp,
        defaultWidth: 450,
        defaultHeight: 450
    });

    registerApp('welcome', {
        name: 'Start',
        icon: '👋',
        iconPath: '/static/icons/start.svg',
        tag: 'babel-welcome',
        defaultWidth: 450,
        defaultHeight: 485
    });

    
    console.log('✅ Desktop initialized with', appRegistry.size, 'apps');
}

// App registration system
function registerApp(id, config) {
    appRegistry.set(id, {
        id: id,
        name: config.name,
        icon: config.icon,
        component: config.component,
        ...config
    });
    console.log(`📱 Registered app: ${config.name} (${id})`);
    
    // Update title for existing windows of this app
    updateWindowTitle(id, config.name);
}

// Update window title for existing windows
function updateWindowTitle(appId, newTitle) {
    if (runningApps.has(appId)) {
        const window = runningApps.get(appId);
        if (window && window.setTitle) {
            window.setTitle(newTitle);
        }
    }
}


// Open an application
function openApp(appId) {
    if (!appRegistry.has(appId)) {
        console.error(`❌ App not found: ${appId}`);
        return;
    }
    
    // Check if app is already running
    if (runningApps.has(appId)) {
        const winboxWindow = runningApps.get(appId);
        if (winboxWindow.min){
            winboxWindow.minimize(false)
        }
        winboxWindow.focus();
        return winboxWindow; // Return the window instance if already running
    }
    
    const appConfig = appRegistry.get(appId);
    console.log(`🚀 Opening ${appConfig.name}...`);
    
    // Detect mobile device
    const isMobile = window.innerWidth <= 768;
    
    
    // Set window configuration based on device and app.
    // tag-based apps mount a custom element directly into the WinBox body;
    // component-based apps render into a seeded div.
    let windowConfig = {
        title: appConfig.name,
        icon: appConfig.iconPath,
        resizable: true,
        minimizable: true,
        maximizable: true,
        closable: true,
        html: appConfig.tag ? '' : `<div class="app-window" id="app-${appId}"></div>`,
        top: 0,
        bottom: 50
    };
    
    if (isMobile) {
        if (appId === 'radio') {
            // Radio opens at 0,0 on mobile
            windowConfig.x = 0;
            windowConfig.y = 0;
            windowConfig.width = appConfig.defaultWidth || 400;
            windowConfig.height = appConfig.defaultHeight || 200;
        } else {
            // All other apps open maximized on mobile
            windowConfig.max = true;
        }
    } else {
        // Desktop positioning
        windowConfig.width = appConfig.defaultWidth || 800;
        windowConfig.height = appConfig.defaultHeight || 600;
        windowConfig.x = 100 + (runningApps.size * 50);
        windowConfig.y = 25 + (runningApps.size * 50);
    }
    
    // Create window using WinBox
    const winboxWindow = new WinBox(windowConfig);
    
    // Store window reference
    runningApps.set(appId, winboxWindow);
    
    // Ensure window has correct title
    winboxWindow.setTitle(appConfig.name);
    
    // Mount the app
    if (appConfig.tag) {
        const el = document.createElement(appConfig.tag);
        // Attach the winbox reference BEFORE inserting so connectedCallback can see it
        el.winboxWindow = winboxWindow;
        el.appConfig = appConfig;
        winboxWindow.body.appendChild(el);
        // Stash on the winbox so we can clean up on close
        winboxWindow._appElement = el;
    } else if (appConfig.component) {
        const appElement = document.getElementById(`app-${appId}`);
        if (appElement) {
            appConfig.component.init(appElement, appConfig, winboxWindow);
        }
    }
    
    // Handle window close
    winboxWindow.onclose = () => {
        if (appConfig.tag) {
            // Removing the element triggers disconnectedCallback for cleanup
            const el = winboxWindow._appElement;
            if (el && el.parentNode) el.parentNode.removeChild(el);
        } else if (appConfig.component && appConfig.component.destroy) {
            appConfig.component.destroy();
        }

        runningApps.delete(appId);
        updateTaskbar();
        console.log(`🔒 Closed ${appConfig.name}`);
    };
    
    // Handle window minimize
    winboxWindow.onminimize = () => {
        // Set display:none on the window's DOM element to hide it, but allow minimize animation
        if (winboxWindow.window) {
            winboxWindow.window.style.display = 'none';
        }
        updateTaskbar();
        console.log(`📉 Minimized ${appConfig.name}`);
        return false; // Prevent WinBox default roll-up window
    };
    
    // Handle window maximize
    winboxWindow.onmaximize = () => {
        updateTaskbar();
        console.log(`📈 Maximized ${appConfig.name}`);
    };
    
    // Handle window restore (when unminimized)
    winboxWindow.onrestore = () => {
        // Remove display:none to show the window again
        if (winboxWindow.window) {
            winboxWindow.window.style.display = '';
        }
        updateTaskbar();
        console.log(`📋 Restored ${appConfig.name}`);
    };
    
    // Update taskbar
    updateTaskbar();
    
    console.log(`✅ ${appConfig.name} opened successfully`);
    return winboxWindow; // Return the window instance when newly created
}

// Patch openApp to record when Start is opened
const originalOpenApp = openApp;
openApp = function(appId) {
    if (appId === 'welcome' || appId === 'start') {
        try {
            localStorage.setItem('startLastOpened', Date.now().toString());
        } catch (e) {}
    }
    return originalOpenApp.apply(this, arguments);
};

// Update taskbar with running apps
function updateTaskbar() {
    const runningAppsContainer = document.getElementById('runningApps');
    runningAppsContainer.innerHTML = '';
    
    runningApps.forEach((window, appId) => {
        const appConfig = appRegistry.get(appId);
        if (appConfig) {
            const appButton = document.createElement('div');
            appButton.className = 'taskbar-app';
            appButton.innerHTML = `
                <span class="taskbar-app-icon"><img src="${appConfig.iconPath}" alt="${appConfig.name}" style="width: 16px; height: 16px; vertical-align: middle;"></span>
                <span class="taskbar-app-name">${appConfig.name}</span>
            `;
            appButton.onclick = () => {
                // Debug: log window properties
                console.log('Window properties:', {
                    window
                });
                
                // Check if window is minimized and restore it
                if (window.min) {
                    // Try to restore using WinBox.js methods
                    window.minimize(false);
                    window.focus();
                    return;
                } else {
                    window.focus();
                }

                

                console.log("Window properties after:", window)
            };
            runningAppsContainer.appendChild(appButton);
        }
    });
}

// Start menu functionality
function toggleStartMenu() {
    const startMenu = document.getElementById('startMenu');
    startMenu.classList.toggle('active');
}

// Close start menu when clicking outside
document.addEventListener('click', function(event) {
    const startMenu = document.getElementById('startMenu');
    const startButton = document.querySelector('.start-button');
    
    if (!startMenu.contains(event.target) && !startButton.contains(event.target)) {
        startMenu.classList.remove('active');
    }
});

// Update clock
function updateClock() {
    const clockElement = document.getElementById('clock');
    const now = new Date();
    const timeString = now.toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit'
    });
    clockElement.textContent = timeString;
}

// Update the taskbar status indicator. Called by BabelcomBus only.
function updateSystemStatus(status, color) {
    const statusIndicator = document.getElementById('statusIndicator');
    if (!statusIndicator) return;
    const statusText = statusIndicator.querySelector('.status-text');
    const statusDot = statusIndicator.querySelector('.status-dot');
    statusText.textContent = status || 'UNKNOWN';
    statusDot.style.background = color || '#00ff00';
}

// Utility functions
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    if (days > 0) {
        return `${days}d ${hours}h ${minutes}m`;
    } else if (hours > 0) {
        return `${hours}h ${minutes}m`;
    } else {
        return `${minutes}m`;
    }
}

// Global app API
window.BabelcomAPI = {
    openApp,
    registerApp,
    formatBytes,
    formatUptime,
    subscribe: BabelcomBus.subscribe,
    getLatest: BabelcomBus.getLatest,
    getRunningApps: () => Array.from(runningApps.keys()),
    getAppRegistry: () => Array.from(appRegistry.keys())
};

console.log('🌐 Babelcom API loaded'); 