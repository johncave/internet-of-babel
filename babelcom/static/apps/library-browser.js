// Web Browser Application
const LibraryBrowserApp = {
    name: 'Web Browser',
    icon: '📚',

    init: function (container, config) {
        this.container = container;
        this.config = config;

        this.render();

        console.log('📚 Web Browser initialized');
    },

    render: function () {
        this.container.innerHTML = `
            <div class="app-window">
                <div class="iframe-controls">
                <button onclick="LibraryBrowserApp.goHome()" class="control-btn">
                        🏠 Home
                    </button>
                    <button onclick="LibraryBrowserApp.refresh()" class="control-btn">
                        🔄 Refresh
                    </button>
                    <button onclick="LibraryBrowserApp.openExternal()" class="control-btn" style="position:absolute; right:10px">
                        🖥️ Pop Out
                    </button>
                    
                </div>
                <div class="library-iframe-container">
                    <iframe 
                        src="https://web4.johncave.co.nz/" 
                        id="library-iframe"
                        title="Internet of Babel Library"
                        frameborder="0">
                    </iframe>
                </div>
                
                
            </div>
        `;

        this.addStyles();
    },

    addStyles: function () {
        const styleId = 'library-browser-styles';
        if (document.getElementById(styleId)) return;

        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            .library-iframe-container {
                width: 100%;
                height: 100%;
                min-height: 500px;
                border: 2px solid #00ffff;
                border-radius: 10px;
                overflow: hidden;
                background: rgba(0, 0, 0, 0.5);
            }
            
            .library-iframe-container iframe {
                width: 100% !important;
                height: 100% !important;
                border: none !important;
                background: white !important;
                min-height: 500px !important;
            }
            
            /* Override any global iframe styles for library browser */
            .winbox .library-iframe-container iframe {
                width: 100% !important;
                height: 100% !important;
                border: none !important;
                background: white !important;
                min-height: 500px !important;
            }
            
            .iframe-controls {
                display: flex;
                justify-content: left;
                
            }
            
            .control-btn {
                background: linear-gradient(45deg, rgba(0, 255, 255, 0.1), rgba(255, 0, 128, 0.1));
                border: 2px solid #00ffff;
                color: #00ffff;
                padding: 12px 24px;
                border-radius: 8px;
                cursor: pointer;
                font-family: 'Orbitron', sans-serif;
                font-weight: bold;
                transition: all 0.3s ease;
                margin: 10px;
            }
            
            .control-btn:hover {
                background: linear-gradient(45deg, rgba(0, 255, 255, 0.2), rgba(255, 0, 128, 0.2));
                box-shadow: 0 0 15px rgba(0, 255, 255, 0.5);
                transform: translateY(-2px);
            }
        `;
        document.head.appendChild(style);
    },

    refresh: function () {
        const iframe = document.getElementById('library-iframe');
        //iframe.src = iframe.src;
        iframe.contentWindow.location.reload()
        console.log('🔄 Refreshing library iframe');
    },

    openExternal: function () {
        window.open('https://web4.johncave.co.nz', '_blank');
        console.log('🌐 Opening library in new tab');
    },

    goHome: function () {
        const iframe = document.getElementById('library-iframe');
        iframe.src = 'https://web4.johncave.co.nz';
        console.log('🏠 Going to library home');
    },

    destroy: function () {
        console.log('📚 Web Browser destroyed');
    }
}; 