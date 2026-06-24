// System Monitor — shadow DOM custom element
const METRICS = {
    cpu:    { label: 'Compute', iconImg: '/static/icons/compute.png', max: 100, format: (v) => v.toFixed(1) + '%' },
    memory: { label: 'Memory',  iconImg: '/static/icons/memory.png',  max: 100, format: (v) => v.toFixed(1) + '%' },
    heat:   { label: 'Heat',    iconEmoji: '🌡️',                     max: 100, format: (v) => `${v.toFixed(0)}°C` },
};
const METRIC_KEYS = ['cpu', 'memory', 'heat'];
const HISTORY_WINDOW_MS = 300_000; // 5 minutes of history

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
                    /* Query our own width (not the viewport) so the layout adapts
                       as the WinBox window resizes — see @container rules below. */
                    container-type: inline-size;
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
                    display: flex;
                    align-items: center;
                    gap: 0.4em;
                }
                .title-logo {
                    height: 1em;
                    width: auto;
                    filter: drop-shadow(0 0 6px rgba(0, 255, 255, 0.6));
                }
                .overview-logo {
                    height: 1.2em;
                    width: auto;
                    vertical-align: middle;
                    margin-right: 0.3em;
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

                /* When the window is shrunk small, the tabs can't fit the text —
                   collapse each to just its (centered) icon. */
                @container (max-width: 380px) {
                    .metric-tab { justify-content: center; gap: 0; padding: 12px 6px; }
                    .metric-tab-info { display: none; }
                    h1 { font-size: 1.6em; margin-bottom: 18px; letter-spacing: 1px; }
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
                /* The graph now uses a pixel-space viewBox (set in renderGraph to
                   match the element size), so strokes/text are uniform and crisp
                   rather than stretched by a non-uniform 100x100 viewBox. */
                .grid-line { stroke: rgba(0, 255, 255, 0.14); stroke-width: 1; }
                .axis-label {
                    fill: rgba(0, 255, 255, 0.55);
                    font-size: 9px;
                    font-family: 'Share Tech Mono', monospace;
                }
                .graph-line {
                    stroke: #00ffff;
                    stroke-width: 1.5;
                    stroke-linejoin: round;
                    stroke-linecap: round;
                    fill: none;
                    filter: drop-shadow(0 0 2px #00ffff);
                }
                .graph-fill {
                    fill: url(#cyanFill);
                    opacity: 0.30;
                }
                .graph-dot { fill: #00ffff; filter: drop-shadow(0 0 3px #00ffff); }
                .graph-current {
                    fill: #00ffff;
                    font-size: 10px;
                    font-weight: bold;
                    font-family: 'Share Tech Mono', monospace;
                    paint-order: stroke;
                    stroke: rgba(0, 0, 0, 0.85);
                    stroke-width: 2.5px;
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
                <h1><img class="title-logo" src="/static/babelcom.webp" alt=""> System Monitor</h1>

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
                        <span class="right">last 5m</span>
                    </div>
                    <div class="graph-wrap">
                        <svg class="graph" id="graph-svg">
                            <defs>
                                <linearGradient id="cyanFill" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="0%" stop-color="#00ffff" stop-opacity="0.8"/>
                                    <stop offset="100%" stop-color="#00ffff" stop-opacity="0"/>
                                </linearGradient>
                            </defs>
                            <g id="graph-grid"></g>
                            <path class="graph-fill" id="graph-fill" d=""/>
                            <path class="graph-line" id="graph-line" d=""/>
                            <circle class="graph-dot" id="graph-dot" r="3" cx="0" cy="0" style="display:none"/>
                            <text class="graph-current" id="graph-current" style="display:none"></text>
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
                    <h3><img class="overview-logo" src="/static/babelcom.webp" alt="" /> Overview</h3>
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
        const svg = this.$('graph-svg');
        const grid = this.$('graph-grid');
        const linePath = this.$('graph-line');
        const fillPath = this.$('graph-fill');
        const dot = this.$('graph-dot');
        const cur = this.$('graph-current');
        if (!svg || !grid || !linePath || !fillPath || !dot) return;

        // Match the viewBox to the element's real pixel size so 1 SVG unit = 1px.
        // (The old fixed 100x100 viewBox with preserveAspectRatio="none" stretched
        // strokes/dots non-uniformly — that was the "glitchy" look.)
        const w = svg.clientWidth;
        const h = svg.clientHeight;
        if (!w || !h) return; // not laid out yet (e.g. minimized)
        svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

        const metric = METRICS[this.activeMetric];
        const data = this.history[this.activeMetric];

        // Plot area — leave a left gutter for the Y-axis labels.
        const padL = 36, padR = 12, padT = 10, padB = 10;
        const plotW = Math.max(1, w - padL - padR);
        const plotH = Math.max(1, h - padT - padB);
        const baseY = padT + plotH;
        const xAt = (frac) => padL + frac * plotW;
        const yAt = (value) => padT + (1 - Math.max(0, Math.min(metric.max, value)) / metric.max) * plotH;

        // Gridlines + Y-axis value labels at 0/25/50/75/100% of the metric's max.
        const unit = this.activeMetric === 'heat' ? '°' : '%';
        let gridHtml = '';
        for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
            const val = metric.max * frac;
            const y = yAt(val);
            gridHtml += `<line class="grid-line" x1="${padL}" y1="${y.toFixed(1)}" x2="${(w - padR).toFixed(1)}" y2="${y.toFixed(1)}"/>`;
            gridHtml += `<text class="axis-label" x="${(padL - 6).toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="end">${Math.round(val)}${unit}</text>`;
        }
        grid.innerHTML = gridHtml;

        if (!data.length) {
            linePath.setAttribute('d', '');
            fillPath.setAttribute('d', '');
            dot.style.display = 'none';
            if (cur) cur.style.display = 'none';
            return;
        }

        const now = Date.now();
        const windowStart = now - HISTORY_WINDOW_MS;
        const points = data.map(({ ts, value }) => {
            const frac = Math.max(0, Math.min(1, (ts - windowStart) / HISTORY_WINDOW_MS));
            return [xAt(frac), yAt(value)];
        });

        // Hold the latest sample's value out to the right edge ("now"). Each
        // sample's x drifts left as time passes, so without this anchor the
        // newest point recedes from the right between samples and the trace looks
        // only "partially wide". The held segment reads as "current value".
        const lastValue = data[data.length - 1].value;
        points.push([xAt(1), yAt(lastValue)]);

        const line = 'M' + points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L');
        const last = points[points.length - 1];
        const first = points[0];
        const fill = `${line} L${last[0].toFixed(1)},${baseY.toFixed(1)} L${first[0].toFixed(1)},${baseY.toFixed(1)} Z`;

        linePath.setAttribute('d', line);
        fillPath.setAttribute('d', fill);
        dot.setAttribute('cx', last[0].toFixed(1));
        dot.setAttribute('cy', last[1].toFixed(1));
        dot.style.display = 'block';

        // Live value label by the current point, nudged to stay on-canvas.
        if (cur) {
            cur.textContent = metric.format(lastValue);
            let lx = last[0] - 6, anchor = 'end';
            if (lx < padL + 24) { lx = last[0] + 6; anchor = 'start'; }
            let ly = last[1] - 6;
            if (ly < padT + 10) ly = last[1] + 14;
            cur.setAttribute('text-anchor', anchor);
            cur.setAttribute('x', lx.toFixed(1));
            cur.setAttribute('y', ly.toFixed(1));
            cur.style.display = 'block';
        }
    }
}

customElements.define('babel-system-monitor', BabelSystemMonitor);
