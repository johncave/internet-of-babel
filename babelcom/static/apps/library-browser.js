// Web of Babel — shadow DOM custom element. Wiki lives on the wiki.* sibling
// host of whatever babelcom.* host we're on; falls back to prod if unparsed.
const LIBRARY_HOME_URL = (() => {
    const m = /^babelcom\.(.+)$/i.exec(location.host);
    return m ? `${location.protocol}//wiki.${m[1]}/` : 'https://web4.johncave.co.nz/';
})();

class BabelLibraryBrowser extends HTMLElement {
    constructor() {
        super();
        this.root = this.attachShadow({ mode: 'open' });
    }

    connectedCallback() {
        this.root.innerHTML = `
            <style>
                :host { display: block; height: 100%; font-family: 'Share Tech Mono', monospace; }
                .app-window {
                    height: 100%;
                    display: flex;
                    flex-direction: column;
                    border-radius: 15px;
                    overflow: hidden;
                }
                .iframe-controls {
                    display: flex;
                    align-items: center;
                    position: relative;
                    flex: 0 0 auto;
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
                .popout-btn { position: absolute; right: 10px; }
                .library-iframe-container {
                    flex: 1 1 auto;
                    width: 100%;
                    border: 2px solid #00ffff;
                    border-radius: 10px;
                    overflow: hidden;
                    background: rgba(0, 0, 0, 0.5);
                    min-height: 0;
                }
                iframe {
                    width: 100%;
                    height: 100%;
                    border: none;
                    background: white;
                    display: block;
                }
            </style>
            <div class="app-window">
                <div class="iframe-controls">
                    <button id="home-btn" class="control-btn">🏠 Home</button>
                    <button id="refresh-btn" class="control-btn">🔄 Refresh</button>
                    <button id="popout-btn" class="control-btn popout-btn">🖥️ Pop Out</button>
                </div>
                <div class="library-iframe-container">
                    <iframe src="${LIBRARY_HOME_URL}" title="Internet of Babel Library" frameborder="0"></iframe>
                </div>
            </div>
        `;

        const iframe = this.root.querySelector('iframe');

        this.root.getElementById('home-btn').addEventListener('click', () => {
            iframe.src = LIBRARY_HOME_URL;
        });
        this.root.getElementById('refresh-btn').addEventListener('click', () => {
            try {
                iframe.contentWindow.location.reload();
            } catch (e) {
                iframe.src = iframe.src;
            }
        });
        this.root.getElementById('popout-btn').addEventListener('click', () => {
            window.open(LIBRARY_HOME_URL, '_blank');
        });
    }
}

customElements.define('babel-library-browser', BabelLibraryBrowser);
