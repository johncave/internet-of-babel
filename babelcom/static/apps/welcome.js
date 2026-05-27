// Welcome App — shadow DOM custom element
class BabelWelcome extends HTMLElement {
    static lines = [
        { text: 'This dingus is an<br>Intel Compute Stick.', img: '/static/babelcom.webp' },
        { text: 'The worst computer ever made.', img: '/static/babelcom.webp' },
        { text: 'So I made it write articles forever.', img: '/static/apps/welcome/working.png' },
        { text: 'It\'s the computer Clippy always dreamed of ❤️.', img: '/static/apps/welcome/working.png' },
        { text: 'Enjoy<br>The Computer of Babel', img: null },
    ];

    constructor() {
        super();
        this.root = this.attachShadow({ mode: 'open' });
        this.currentLine = 0;
    }

    connectedCallback() {
        this.render();
    }

    render() {
        const line = BabelWelcome.lines[this.currentLine];
        const isLast = this.currentLine >= BabelWelcome.lines.length - 1;
        const bgStyle = line.img
            ? `background-image: url('${line.img}'); background-size: contain; background-position: center; background-repeat: no-repeat;`
            : '';

        this.root.innerHTML = `
            <style>
                :host { display: block; height: 100%; font-family: 'Share Tech Mono', monospace; }
                .welcome-app {
                    padding: 32px 32px 24px 32px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    height: 100%;
                    box-sizing: border-box;
                    transition: background-image 0.5s ease-in-out;
                    position: relative;
                }
                .welcome-app::before {
                    content: '';
                    position: absolute;
                    inset: 0;
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
                    font-size: 1.2em;
                    margin: 20px 0;
                }
                .welcome-controls {
                    width: 100%;
                    display: flex;
                    justify-content: flex-end;
                }
                .welcome-btn {
                    background: linear-gradient(45deg, rgba(0, 255, 255, 0.1), rgba(255, 0, 128, 0.1));
                    border: 2px solid #00ffff;
                    color: #00ffff;
                    padding: 12px 24px;
                    border-radius: 8px;
                    cursor: pointer;
                    font-family: 'Orbitron', sans-serif;
                    font-weight: bold;
                    margin-left: 10px;
                    backdrop-filter: blur(10px);
                    transition: all 0.3s ease;
                }
                .welcome-btn:hover {
                    background: linear-gradient(45deg, rgba(0, 255, 255, 0.2), rgba(255, 0, 128, 0.2));
                    box-shadow: 0 0 15px rgba(0, 255, 255, 0.5);
                    transform: translateY(-2px);
                }
            </style>
            <div class="welcome-app" style="${bgStyle}">
                <div class="welcome-content">
                    <div class="welcome-text">${line.text}</div>
                    <div class="welcome-controls">
                        <button id="action-btn" class="welcome-btn">${isLast ? 'Close' : 'Next'}</button>
                    </div>
                </div>
            </div>
        `;

        this.root.getElementById('action-btn').addEventListener('click', () => {
            if (isLast) {
                if (this.winboxWindow) this.winboxWindow.close();
            } else {
                this.currentLine++;
                this.render();
            }
        });
    }
}

customElements.define('babel-welcome', BabelWelcome);
