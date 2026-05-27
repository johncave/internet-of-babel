// System Monitor — shadow DOM custom element
class BabelSystemMonitor extends HTMLElement {
    constructor() {
        super();
        this.root = this.attachShadow({ mode: 'open' });
        this.unsubs = [];
    }

    connectedCallback() {
        this.render();

        this.unsubs.push(BabelcomAPI.subscribe('system_status', (msg) => this.updateSystemStatus(msg.data)));
        this.unsubs.push(BabelcomAPI.subscribe('token', (msg) => this.addLLMOutput(msg.token)));
        this.unsubs.push(BabelcomAPI.subscribe('reset', () => this.clearLLMOutput()));

        const latestStatus = BabelcomAPI.getLatest('system_status');
        if (latestStatus && latestStatus.data) this.updateSystemStatus(latestStatus.data);

        console.log('📊 System Monitor initialized');
    }

    disconnectedCallback() {
        for (const u of this.unsubs) u();
        this.unsubs = [];
        console.log('📊 System Monitor destroyed');
    }

    render() {
        this.root.innerHTML = `
            <style>
                :host {
                    display: block;
                    height: 100%;
                    overflow-y: auto;
                    color: #e0e0e0;
                    font-family: 'Share Tech Mono', monospace;
                }
                .system-monitor { padding: 10px; }
                h1 {
                    font-family: 'Orbitron', sans-serif;
                    color: #00ffff;
                    border-bottom: 3px solid #ff0080;
                    padding-bottom: 15px;
                    text-shadow: 0 0 10px rgba(0, 255, 255, 0.5);
                    font-size: 2.2em;
                    letter-spacing: 2px;
                    margin: 0 0 30px 0;
                }
                h3 {
                    font-family: 'Orbitron', sans-serif;
                    color: #ff6b9d;
                    text-shadow: 0 0 6px rgba(255, 107, 157, 0.5);
                    font-size: 36px;
                    margin: 0 0 15px 0;
                }
                .generation-section {
                    background: rgba(0, 0, 0, 0.7);
                    border: 2px solid #00ffff;
                    border-radius: 15px;
                    padding: 25px;
                    margin-bottom: 25px;
                    box-shadow: 0 0 20px rgba(0, 255, 255, 0.3);
                }
                .generation-section h3 {
                    color: #00ffff;
                    margin-bottom: 20px;
                    text-shadow: 0 0 10px rgba(0, 255, 255, 0.5);
                }
                .generation-status {
                    margin-bottom: 25px;
                    border-radius: 10px;
                    border: 1px solid rgba(255, 0, 128, 0.3);
                }
                .current-task {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 12px;
                    background: rgba(0, 0, 0, 0.5);
                }
                .task-label { color: #ff6b9d; font-weight: bold; }
                .task-value {
                    color: #00ffff;
                    font-weight: bold;
                    text-shadow: 0 0 5px rgba(0, 255, 255, 0.5);
                    text-decoration: underline;
                }
                .llm-output-container {
                    background: rgba(0, 0, 0, 0.9);
                    padding: 15px;
                    padding-top: 0px;
                    height: 300px;
                    overflow-y: auto;
                    font-family: 'Share Tech Mono', monospace;
                    font-size: 1em;
                    line-height: 1.6;
                    color: #e0e0e0;
                    word-wrap: break-word;
                }
                .llm-token {
                    display: inline;
                    color: #00ffff;
                    text-shadow: 0 0 3px rgba(0, 255, 255, 0.3);
                    transition: color 0.1s ease;
                }
                .llm-token:hover {
                    color: #ff6b9d;
                    text-shadow: 0 0 5px rgba(255, 107, 157, 0.5);
                }
                .output-line {
                    color: #e0e0e0;
                    margin-bottom: 5px;
                    padding: 2px 0;
                    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                }
                .output-line:last-child { border-bottom: none; }
                .output-line.info { color: #00ffff; }
                .output-line.success { color: #00ff00; }
                .output-line.warning { color: #ffff00; }
                .output-line.error { color: #ff0000; }
                .compact-status {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
                    gap: 15px;
                    margin-bottom: 25px;
                }
                .status-card {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    background: rgba(0, 0, 0, 0.5);
                    border: 1px solid rgba(0, 255, 255, 0.3);
                    border-radius: 10px;
                    padding: 15px;
                    box-shadow: 0 0 15px rgba(0, 255, 255, 0.2);
                }
                .status-icon {
                    font-size: 1.5em;
                    text-shadow: 0 0 10px rgba(0, 255, 255, 0.5);
                }
                .status-info { flex: 1; }
                .status-label {
                    color: #ff6b9d;
                    font-size: 1em;
                    font-weight: bold;
                    margin-bottom: 2px;
                }
                .status-value {
                    color: #00ffff;
                    font-weight: bold;
                }
                .performance-metrics {
                    background: rgba(0, 0, 0, 0.5);
                    border: 1px solid rgba(255, 0, 128, 0.3);
                    border-radius: 10px;
                    padding: 20px;
                    margin-bottom: 25px;
                }
                .performance-metrics h3 {
                    color: #ff0080;
                    margin-bottom: 15px;
                    text-shadow: 0 0 8px rgba(255, 0, 128, 0.5);
                }
                .metrics-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: 12px;
                }
                .metric-item {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 8px 12px;
                    background: rgba(0, 0, 0, 0.3);
                    border-radius: 5px;
                    border: 1px solid rgba(255, 107, 157, 0.3);
                }
                .metric-label {
                    color: #ff6b9d;
                    font-weight: bold;
                    font-size: 0.9em;
                }
                .metric-value {
                    color: #00ffff;
                    font-weight: bold;
                    text-shadow: 0 0 5px rgba(0, 255, 255, 0.5);
                    font-size: 0.9em;
                }
            </style>
            <div class="system-monitor">
                <h1>System Monitor</h1>

                <div class="compact-status">
                    <div class="status-card">
                        <div class="status-icon">
                            <img src="/static/icons/compute.png" alt="Compute" style="width: 1.8em; height: 1.8em; vertical-align: middle;" />
                        </div>
                        <div class="status-info">
                            <div class="status-label">Compute</div>
                            <div class="status-value" id="cpu-usage">--</div>
                        </div>
                    </div>
                    <div class="status-card">
                        <div class="status-icon">
                            <img src="/static/icons/memory.png" alt="Memory" style="width: 1.8em; height: 1.8em; vertical-align: middle;" />
                        </div>
                        <div class="status-info">
                            <div class="status-label">Memory</div>
                            <div class="status-value" id="memory-usage">--</div>
                        </div>
                    </div>
                    <div class="status-card">
                        <div class="status-icon">🌡️</div>
                        <div class="status-info">
                            <div class="status-label">Heat</div>
                            <div class="status-value" id="temperature-value">--</div>
                        </div>
                    </div>
                </div>

                <div class="generation-section">
                    <h3>✨ Current Job</h3>
                    <div class="generation-status">
                        <div class="current-task">
                            <span class="task-value" id="current-task">Loading...</span>
                            <span class="task-label" id="task-label">Writing</span>
                        </div>
                        <div class="llm-output-container" id="llm-output-container">
                            <div class="output-line info">Waiting for babelcom...</div>
                        </div>
                    </div>
                </div>

                <div class="performance-metrics">
                    <h3><img src="/static/icons/system-monitor.png" alt="Overview" style="width: 1.2em; height: 1.2em; vertical-align: middle;" /> Overview</h3>
                    <div class="metrics-grid">
                        <div class="metric-item">
                            <span class="metric-label">Articles Generated</span>
                            <span class="metric-value" id="articles-count">--</span>
                        </div>
                        <div class="metric-item">
                            <span class="metric-label">Progress</span>
                            <span class="metric-value" id="generation-rate">0%</span>
                        </div>
                        <div class="metric-item">
                            <span class="metric-label">Exact Time Remaining</span>
                            <span class="metric-value" id="queue-size">Infinite</span>
                        </div>
                        <div class="metric-item">
                            <span class="metric-label">Uptime</span>
                            <span class="metric-value" id="system-uptime">--</span>
                        </div>
                        <div class="metric-item">
                            <span class="metric-label">Heat Death of Universe</span>
                            <span class="metric-value" id="heat-death">Approaches</span>
                        </div>
                        <div class="metric-item">
                            <span class="metric-label">Power Consumption</span>
                            <span class="metric-value" id="power-consumption">Moderate</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    $(id) { return this.root.getElementById(id); }

    updateSystemStatus(status) {
        this.$('memory-usage').textContent = status.memory_usage.toFixed(1) + '%';
        this.$('cpu-usage').textContent = status.cpu_usage.toFixed(1) + '%';
        this.$('temperature-value').textContent = status.temperature + '°C';

        this.updateStatusColor('memory-usage', status.memory_usage);
        this.updateStatusColor('cpu-usage', status.cpu_usage);
        this.updateStatusColor('temperature-value', parseFloat(status.temperature));

        this.$('articles-count').textContent = status.articles_count.toLocaleString();
        this.$('system-uptime').textContent = status.uptime;
        this.$('task-label').textContent = status.current_phase || 'Writing';
        this.$('current-task').textContent = status.current_title || 'No current task';
    }

    updateStatusColor(elementId, value) {
        const element = this.$(elementId);
        if (value > 80) element.style.color = '#ff0000';
        else if (value > 60) element.style.color = '#ffff00';
        else element.style.color = '#00ffff';
    }

    addLLMOutput(token) {
        const container = this.$('llm-output-container');
        const isAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 50;

        const tokenSpan = document.createElement('span');
        tokenSpan.className = 'llm-token';
        tokenSpan.innerHTML = token.replace(/\n/g, '<br>');
        container.appendChild(tokenSpan);

        if (isAtBottom) container.scrollTop = container.scrollHeight;

        while (container.children.length > 1000) {
            container.removeChild(container.firstChild);
        }
    }

    clearLLMOutput() {
        this.$('llm-output-container').innerHTML = '';
        console.log('LLM output cleared');
    }
}

customElements.define('babel-system-monitor', BabelSystemMonitor);
