// Global state
let runningApps = new Map();
let appRegistry = new Map();

// Initialize the desktop
document.addEventListener('DOMContentLoaded', function() {
    initializeDesktop();
    updateClock();
    setInterval(updateClock, 1000);
    updateSystemStatus('Online', '#00ff00'); // Default status
    //setInterval(updateSystemStatus, 5000);
    // Open web browser in fullscreen on load
    // setTimeout(() => {
    //     let win = openApp('library-browser');
    //     win.maximize()
    // }, 100);
});

// Desktop initialization
function initializeDesktop() {
    console.log('🚀 Babelcom Desktop Initializing...');
    
    // Register built-in apps
    registerApp('system-monitor', {
        name: 'System Monitor',
        icon: '📊',
        iconPath: '/static/icons/system-monitor.png',
        component: SystemMonitorApp,
        defaultWidth: 600,
        defaultHeight: 800
    });
    
    registerApp('library-browser', {
        name: 'Web Browser',
        icon: '📖',
        iconPath: '/static/icons/web-browser.png',
        component: LibraryBrowserApp
    });
    
    registerApp('radio', {
        name: 'Radio',
        icon: '📻',
        iconPath: '/static/icons/radio.png',
        component: RadioApp,
        defaultWidth: 400,
        defaultHeight: 200
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
    
    
    // Set window configuration based on device and app
    let windowConfig = {
        title: appConfig.name,
        icon: appConfig.iconPath,
        resizable: true,
        minimizable: true,
        maximizable: true,
        closable: true,
        html: `<div class="app-window" id="app-${appId}"></div>`
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
    
    // Initialize app component
    if (appConfig.component) {
        const appElement = document.getElementById(`app-${appId}`);
        if (appElement) {
            appConfig.component.init(appElement, appConfig);
        }
    }
    
    // Handle window close
    winboxWindow.onclose = () => {
        // Call the app's destroy function if it exists
        if (appConfig.component && appConfig.component.destroy) {
            appConfig.component.destroy();
        }
        
        runningApps.delete(appId);
        updateTaskbar();
        console.log(`🔒 Closed ${appConfig.name}`);
    };
    
    // Handle window minimize
    winboxWindow.onminimize = () => {
        updateTaskbar();
        console.log(`📉 Minimized ${appConfig.name}`);
    };
    
    // Handle window maximize
    winboxWindow.onmaximize = () => {
        updateTaskbar();
        console.log(`📈 Maximized ${appConfig.name}`);
    };
    
    // Handle window restore (when unminimized)
    winboxWindow.onrestore = () => {
        updateTaskbar();
        console.log(`📋 Restored ${appConfig.name}`);
    };
    
    // Update taskbar
    updateTaskbar();
    
    console.log(`✅ ${appConfig.name} opened successfully`);
    return winboxWindow; // Return the window instance when newly created
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

// Update system status
function updateSystemStatus(status, color) {
    const statusIndicator = document.getElementById('statusIndicator');
    const statusText = statusIndicator.querySelector('.status-text');
    const statusDot = statusIndicator.querySelector('.status-dot');
    
    // Simulate system status (in real implementation, this would check actual system health)
    // const isOnline = Math.random() > 0.1; // 90% chance of being online
    
    // if (isOnline) {
    //     statusText.textContent = 'ONLINE';
    //     statusDot.style.background = '#00ff00';
    // } else {
    //     statusText.textContent = 'OFFLINE';
    //     statusDot.style.background = '#ff0000';
    // }
    statusText.textContent = status || 'UNKNOWN';
    statusDot.style.background = color || '#00ff00'; // Default to green if no

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