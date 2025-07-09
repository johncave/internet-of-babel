// Global state
let runningApps = new Map();
let appRegistry = new Map();

// Initialize the desktop
document.addEventListener('DOMContentLoaded', function() {
    initializeDesktop();
    updateClock();
    setInterval(updateClock, 1000);
    updateSystemStatus();
    setInterval(updateSystemStatus, 5000);
    // Open library browser in fullscreen on load
    setTimeout(() => {
        let win = openApp('library-browser');
        win.maximize()
    }, 100);
});

// Desktop initialization
function initializeDesktop() {
    console.log('🚀 Babelcom Desktop Initializing...');
    
    // Register built-in apps
    registerApp('system-monitor', {
        name: 'System Monitor',
        icon: '📊',
        component: SystemMonitorApp
    });
    
    registerApp('library-browser', {
        name: 'Library Browser',
        icon: '📚',
        component: LibraryBrowserApp
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
}



// Open an application
function openApp(appId) {
    if (!appRegistry.has(appId)) {
        console.error(`❌ App not found: ${appId}`);
        return;
    }
    
    // Check if app is already running
    if (runningApps.has(appId)) {
        const window = runningApps.get(appId);
        if (window.min){
            window.minimize(false)
        }
        window.focus();
        return window; // Return the window instance if already running
    }
    
    const appConfig = appRegistry.get(appId);
    console.log(`🚀 Opening ${appConfig.name}...`);
    
    // Create window using WinBox
    const window = new WinBox({
        title: appConfig.name,
        width: 800,
        height: 600,
        x: 100 + (runningApps.size * 50),
        y: 100 + (runningApps.size * 50),
        resizable: true,
        minimizable: true,
        maximizable: true,
        closable: true,
        html: `<div class="app-window" id="app-${appId}"></div>`
    });
    
    // Store window reference
    runningApps.set(appId, window);
    
    // Initialize app component
    if (appConfig.component) {
        const appElement = document.getElementById(`app-${appId}`);
        if (appElement) {
            appConfig.component.init(appElement, appConfig);
        }
    }
    
    // Handle window close
    window.onclose = () => {
        runningApps.delete(appId);
        updateTaskbar();
        console.log(`🔒 Closed ${appConfig.name}`);
    };
    
    // Handle window minimize
    window.onminimize = () => {
        updateTaskbar();
        console.log(`📉 Minimized ${appConfig.name}`);
    };
    
    // Handle window maximize
    window.onmaximize = () => {
        updateTaskbar();
        console.log(`📈 Maximized ${appConfig.name}`);
    };
    
    // Handle window restore (when unminimized)
    window.onrestore = () => {
        updateTaskbar();
        console.log(`📋 Restored ${appConfig.name}`);
    };
    
    // Update taskbar
    updateTaskbar();
    
    console.log(`✅ ${appConfig.name} opened successfully`);
    return window; // Return the window instance when newly created
}

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
                <span class="taskbar-app-icon">${appConfig.icon}</span>
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

// Update system status
function updateSystemStatus() {
    const statusIndicator = document.getElementById('statusIndicator');
    const statusText = statusIndicator.querySelector('.status-text');
    const statusDot = statusIndicator.querySelector('.status-dot');
    
    // Simulate system status (in real implementation, this would check actual system health)
    const isOnline = Math.random() > 0.1; // 90% chance of being online
    
    if (isOnline) {
        statusText.textContent = 'ONLINE';
        statusDot.style.background = '#00ff00';
    } else {
        statusText.textContent = 'OFFLINE';
        statusDot.style.background = '#ff0000';
    }
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
    getRunningApps: () => Array.from(runningApps.keys()),
    getAppRegistry: () => Array.from(appRegistry.keys())
};

console.log('🌐 Babelcom API loaded'); 