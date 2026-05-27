// System Monitor — shadow DOM custom element
const METRICS = {
    cpu:    { label: 'Compute', iconImg: '/static/icons/compute.png', max: 100, format: (v) => v.toFixed(1) + '%' },
    memory: { label: 'Memory',  iconImg: '/static/icons/memory.png',  max: 100, format: (v) => v.toFixed(1) + '%' },
    heat:   { label: 'Heat',    iconEmoji: '🌡️',                     max: 100, format: (v) => `${v.toFixed(0)}°C` },
};
const METRIC_KEYS = ['cpu', 'memory', 'heat'];
const HISTORY_WINDOW_MS = 60_000;

class BabelSystemMonitor extends HTMLElement {
    constructor() {
        super();
        this.root = this.attachShadow({ mode: 'open' });
        this.unsubs = [];
        this.activeMetric = 'cpu';
        this.history = { cpu: [], memory: [], heat: [] };
        this.latestValues = { cpu: 0, memory: 0, heat: 0 };
        this.tickInterval = null;
    }

    connectedCallback() {
        this.render();
        this.bindTabs();

        this.unsubs.push(BabelcomAPI.subscribe('system_status', (msg) => this.updateSystemStatus(msg.data)));

        const latest = BabelcomAPI.getLatest('system_status');
        if (latest && latest.data) this.updateSystemStatus(latest.data);

        // Slide the graph window forward every 500ms even without new data
        this.tickInterval = setInterval(() => this.renderGraph(), 500);
        this.renderGraph();

        console.log('📊 System Monitor initialized');
    }

    disconnectedCallback() {
        for (const u of this.unsubs) u();
        this.unsubs = [];
        if (this.tickInterval) clearInterval(this.tickInterval);
        this.tickInterval = null;
        console.log('📊 System Monitor destroyed');
    }

    $(id) { return this.root.getElementById(id); }

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

                .metric-tabs {
                    display: grid;
                    grid-template-columns: repeat(3, 1fr);
                    gap: 8px;
                    margin-bottom: 0;
                }
                .metric-tab {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    background: rgba(0, 0, 0, 0.5);
                    border: 1px solid rgba(0, 255, 255, 0.3);
                    border-bottom: none;
                    border-radius: 10px 10px 0 0;
                    padding: 15px;
                    cursor: pointer;
                    transition: background 0.2s ease, border-color 0.2s ease;
                    font: inherit;
                    color: inherit;
                    text-align: left;
                }
                .metric-tab:hover {
                    background: rgba(0, 255, 255, 0.08);
                }
                .metric-tab.active {
                    background: rgba(0, 0, 0, 0.85);
                    border-color: #00ffff;
                    box-shadow: 0 -4px 15px rgba(0, 255, 255, 0.25);
                }
                .metric-tab-icon {
                    font-size: 1.5em;
                    text-shadow: 0 0 10px rgba(0, 255, 255, 0.5);
                    line-height: 1;
                }
                .metric-tab-icon img { width: 1.8em; height: 1.8em; vertical-align: middle; }
                .metric-tab-info { flex: 1; }
                .metric-tab-label {
                    color: #ff6b9d;
                    font-size: 1em;
                    font-weight: bold;
                    margin-bottom: 2px;
                }
                .metric-tab-value {
                    color: #00ffff;
                    font-weight: bold;
                    font-size: 1.1em;
                }

                .graph-panel {
                    background: rgba(0, 0, 0, 0.85);
                    border: 1px solid #00ffff;
                    border-radius: 0 0 10px 10px;
                    padding: 12px 16px 16px;
                    margin-bottom: 25px;
                    box-shadow: 0 0 20px rgba(0, 255, 255, 0.2);
                }
                .graph-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: baseline;
                    margin-bottom: 8px;
                    font-size: 0.85em;
                    color: #ff6b9d;
                }
                .graph-header .right { color: rgba(0,255,255,0.6); }
                .graph-wrap {
                    position: relative;
                    width: 100%;
                    height: 180px;
                }
                svg.graph {
                    width: 100%;
                    height: 100%;
                    display: block;
                }
                .grid-line { stroke: rgba(0, 255, 255, 0.12); stroke-width: 0.2; }
                .axis-label {
                    fill: rgba(0, 255, 255, 0.45);
                    font-size: 3px;
                    font-family: 'Share Tech Mono', monospace;
                }
                .graph-line {
                    stroke: #00ffff;
                    stroke-width: 0.6;
                    fill: none;
                    filter: drop-shadow(0 0 1px #00ffff);
                }
                .graph-fill {
                    fill: url(#cyanFill);
                    opacity: 0.35;
                }
                .graph-dot { fill: #00ffff; }

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
                .current-task {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 12px;
                    background: rgba(0, 0, 0, 0.5);
                    border-radius: 10px;
                    border: 1px solid rgba(255, 0, 128, 0.3);
                }
                .task-label { color: #ff6b9d; font-weight: bold; }
                .task-value {
                    color: #00ffff;
                    font-weight: bold;
                    text-shadow: 0 0 5px rgba(0, 255, 255, 0.5);
                    text-decoration: underline;
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

                <div class="metric-tabs" id="metric-tabs">
                    ${METRIC_KEYS.map((key) => {
                        const m = METRICS[key];
                        const iconHtml = m.iconImg
                            ? `<img src="${m.iconImg}" alt="${m.label}">`
                            : `<span>${m.iconEmoji}</span>`;
                        return `
                            <button class="metric-tab" data-metric="${key}" id="tab-${key}">
                                <div class="metric-tab-icon">${iconHtml}</div>
                                <div class="metric-tab-info">
                                    <div class="metric-tab-label">${m.label}</div>
                                    <div class="metric-tab-value" id="val-${key}">--</div>
                                </div>
                            </button>
                        `;
                    }).join('')}
                </div>

                <div class="graph-panel">
                    <div class="graph-header">
                        <span id="graph-title">Compute</span>
                        <span class="right">last 60s</span>
                    </div>
                    <div class="graph-wrap">
                        <svg class="graph" id="graph-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
                            <defs>
                                <linearGradient id="cyanFill" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="0%" stop-color="#00ffff" stop-opacity="0.8"/>
                                    <stop offset="100%" stop-color="#00ffff" stop-opacity="0"/>
                                </linearGradient>
                            </defs>
                            <line class="grid-line" x1="0" y1="25" x2="100" y2="25"/>
                            <line class="grid-line" x1="0" y1="50" x2="100" y2="50"/>
                            <line class="grid-line" x1="0" y1="75" x2="100" y2="75"/>
                            <path class="graph-fill" id="graph-fill" d=""/>
                            <path class="graph-line" id="graph-line" d=""/>
                            <circle class="graph-dot" id="graph-dot" r="0.9" cx="0" cy="100" style="display:none"/>
                        </svg>
                    </div>
                </div>

                <!-- <div class="generation-section">
                    <h3>✨ Current Job</h3>
                    <div class="current-task">
                        <span class="task-value" id="current-task">Loading...</span>
                        <span class="task-label" id="task-label">Writing</span>
                    </div>
                </div> --!>

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

        this.updateActiveTabUI();
    }

    bindTabs() {
        for (const key of METRIC_KEYS) {
            this.$(`tab-${key}`).addEventListener('click', () => this.setActiveMetric(key));
        }
    }

    setActiveMetric(key) {
        if (!METRICS[key] || key === this.activeMetric) return;
        this.activeMetric = key;
        this.updateActiveTabUI();
        this.renderGraph();
    }

    updateActiveTabUI() {
        for (const key of METRIC_KEYS) {
            const tab = this.$(`tab-${key}`);
            if (!tab) continue;
            tab.classList.toggle('active', key === this.activeMetric);
        }
        const title = this.$('graph-title');
        if (title) title.textContent = METRICS[this.activeMetric].label;
    }

    updateSystemStatus(status) {
        const cpu = status.cpu_usage;
        const memory = status.memory_usage;
        const heat = parseFloat(status.temperature);

        this.latestValues = { cpu, memory, heat };
        const now = Date.now();
        this.history.cpu.push({ ts: now, value: cpu });
        this.history.memory.push({ ts: now, value: memory });
        if (!Number.isNaN(heat)) this.history.heat.push({ ts: now, value: heat });
        this.trimHistory(now);

        // Tab value readouts
        this.$('val-cpu').textContent = METRICS.cpu.format(cpu);
        this.$('val-memory').textContent = METRICS.memory.format(memory);
        this.$('val-heat').textContent = Number.isNaN(heat) ? '--' : METRICS.heat.format(heat);

        // Overview
        this.$('articles-count').textContent = status.articles_count.toLocaleString();
        this.$('system-uptime').textContent = status.uptime;

        this.renderGraph();
    }

    trimHistory(now) {
        const cutoff = now - HISTORY_WINDOW_MS;
        for (const key of METRIC_KEYS) {
            const arr = this.history[key];
            let i = 0;
            while (i < arr.length && arr[i].ts < cutoff) i++;
            if (i > 0) arr.splice(0, i);
        }
    }

    renderGraph() {
        const data = this.history[this.activeMetric];
        const metric = METRICS[this.activeMetric];
        const linePath = this.$('graph-line');
        const fillPath = this.$('graph-fill');
        const dot = this.$('graph-dot');
        if (!linePath || !fillPath || !dot) return;

        const now = Date.now();
        const windowStart = now - HISTORY_WINDOW_MS;
        const w = 100;
        const h = 100;

        if (!data.length) {
            linePath.setAttribute('d', '');
            fillPath.setAttribute('d', '');
            dot.style.display = 'none';
            return;
        }

        const points = data.map(({ ts, value }) => {
            const x = ((ts - windowStart) / HISTORY_WINDOW_MS) * w;
            const y = h - Math.max(0, Math.min(metric.max, value)) / metric.max * h;
            return [Math.max(0, Math.min(w, x)), y];
        });

        const line = 'M' + points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' L');
        const last = points[points.length - 1];
        const first = points[0];
        const fill = `${line} L${last[0].toFixed(2)},${h} L${first[0].toFixed(2)},${h} Z`;

        linePath.setAttribute('d', line);
        fillPath.setAttribute('d', fill);
        dot.setAttribute('cx', last[0].toFixed(2));
        dot.setAttribute('cy', last[1].toFixed(2));
        dot.style.display = 'block';
    }
}

customElements.define('babel-system-monitor', BabelSystemMonitor);
