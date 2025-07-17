// Welcome App Component
const WelcomeApp = {
    name: 'Start',
    icon: '👋',
    lines: [
        { text: 'Welcome to your babelcom AI desk buddy.', img: '/static/apps/welcome/omg.png' },
        { text: 'Just plug it in, and babelcom will start generating infinite articles!', img: '/static/apps/welcome/omg.png' },
        //{ text: 'This is indicated by a persistent fan noise.', img: null },
        { text: 'Working together with babelcom.<br>It\'s human interaction 2.0.', img: '/static/apps/welcome/working.png' },
        { text: 'Open System Monitor to see what your AI buddy is writing.<br>Inspo-radical!', img: '/static/apps/welcome/working.png' },
        //{ text: 'Listen to the Radio while you browse the Web of Babel.', img: null },
        { text: 'What will you find in the Web of Babel?', img: null },
    ],
    currentLine: 0,
    winboxWindow: null,
    container: null,
    init: function(container, config, winboxWindow) {
        this.container = container;
        this.winboxWindow = winboxWindow;
        this.currentLine = 0;
        this.render();
    },
    render: function() {
        const line = this.lines[this.currentLine];
        this.container.innerHTML = `
            <div class="welcome-app" style="${line.img ? `background-image: url('${line.img}'); background-size: cover; background-position: center; background-repeat: no-repeat;` : ''}">
                <div class="welcome-content">
                    <div class="welcome-text" style="font-size:1.2em;margin:20px 0;">${line.text}</div>
                    <div class="welcome-controls" style="display:flex;justify-content:flex-end;">
                        ${this.currentLine < this.lines.length - 1 ? `<button id="welcome-next-btn" class="welcome-btn control-btn">Next</button>` : `<button id="welcome-close-btn" class="welcome-btn control-btn">Close</button>`}
                    </div>
                </div>
            </div>
            <style>
                .welcome-app {
                    padding: 32px 32px 24px 32px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    height: 100%;
                    transition: background-image 0.5s ease-in-out;
                    position: relative;
                }
                .welcome-app::before {
                    content: '';
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0, 0, 0, 0.6);
                    z-index: 1;
                }
                .welcome-content {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    width: 100%;
                    position: relative;
                    z-index: 2;
                }
                .welcome-text {
                    text-align: center;
                    width: 100%;
                    color: #ffffff;
                    text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.8);
                }
                .welcome-controls {
                    width: 100%;
                    display: flex;
                    justify-content: flex-end;
                }
                .welcome-btn.control-btn {
                    background: linear-gradient(45deg, rgba(0, 255, 255, 0.1), rgba(255, 0, 128, 0.1));
                    border: 2px solid #00ffff;
                    color: #00ffff;
                    padding: 12px 24px;
                    border-radius: 8px;
                    cursor: pointer;
                    font-family: 'Orbitron', sans-serif;
                    font-weight: bold;
                    transition: all 0.3s ease;
                    margin-left: 10px;
                    backdrop-filter: blur(10px);
                }
                .welcome-btn.control-btn:hover {
                    background: linear-gradient(45deg, rgba(0, 255, 255, 0.2), rgba(255, 0, 128, 0.2));
                    box-shadow: 0 0 15px rgba(0, 255, 255, 0.5);
                    transform: translateY(-2px);
                }
            </style>
        `;
        if (this.currentLine < this.lines.length - 1) {
            document.getElementById('welcome-next-btn').onclick = () => {
                this.currentLine++;
                this.render();
            };
        } else {
            document.getElementById('welcome-close-btn').onclick = () => {
                if (this.winboxWindow) this.winboxWindow.close();
            };
        }
    },
    destroy: function() {
        // No-op for now
    }
}; 