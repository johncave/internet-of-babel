// Radio App Component
const RadioApp = {
    name: 'Radio',
    icon: '📻',
    websocket: null,
    currentTrack: null,
    isPlaying: false,
    isMuted: false,
    volume: 0.85,
    progressInterval: null,
    lastElapsedUpdate: 0,
    currentStreamUrl: null,
    fadeControlsTimer: null, // Add to global state
    reconnectAttempts: 0,
    reconnectTimer: null,
    stallTimer: null,

    // --- Stations --------------------------------------------------------
    // The desktop offers two AzuraCast stations. `code` is the AzuraCast
    // shortcode (matches station:<code> on the upstream socket and the
    // shortcode carried in each "now playing" payload); `name` is the label
    // shown on the switcher. The backend subscribes to all of these and
    // rebroadcasts each; we route incoming messages to the right station by
    // shortcode and only play/show the selected one.
    STATIONS: [
        { code: 'night', name: 'Vaporwave' },
        { code: 'psytrance', name: 'Psytrance' },
    ],
    STATION_KEY: 'babelcom.radio.station',
    currentStation: 'night',
    // shortcode -> { streamUrl, track, receivedAt } cached from the bus so a
    // switch can render instantly instead of waiting for the next push.
    stationData: {},

    // Cap the visualizer's backing-store resolution on HiDPI/retina displays.
    // Butterchurn (MilkDrop) presets are soft, low-detail visuals, so rendering
    // at the full devicePixelRatio (2 on retina = 4x the pixels) is mostly
    // wasted GPU. Capping the ratio cuts the per-frame shader cost dramatically
    // with almost no visible difference, especially in full-screen wallpaper
    // mode. Bump toward devicePixelRatio for crispness, down toward 1 for FPS.
    VIZ_MAX_PIXEL_RATIO: 1.5,

    // --- Adaptive visualizer quality -------------------------------------
    // Butterchurn presets vary wildly in cost: on this class of machine most
    // run ~50fps full-screen, but some are ~10fps. Every preset starts at full
    // resolution (1.0x, reset on each preset change) and we adapt DOWN a ladder
    // of scale factors (applied on top of the HiDPI cap) to hold the framerate.
    // Because a heavy preset can be 5x too slow, we can step down several levels;
    // if we bottom out and still can't make budget, the preset is blacklisted
    // and skipped. We never step back up within a preset — the next preset
    // resets to 1.0x and re-assesses from scratch.
    VIZ_SCALE_STEPS: [1, 0.75, 0.5, 0.35, 0.25],
    VIZ_FPS_LOW: 30,    // below this → drop a level (matches the on-screen meter)
    VIZ_SETTLE_MARGIN_MS: 1500, // extra hold after a crossfade finishes before judging fps
    VIZ_STEP_SETTLE_MS: 1200,   // re-measure delay after we change a level
    _vizScaleIdx: 0,
    _vizSettleUntil: 0,     // performance.now() until which we hold steady (transition)

    vizPixelRatio: function() {
        const cap = Math.min(window.devicePixelRatio || 1, this.VIZ_MAX_PIXEL_RATIO);
        return cap * (this.VIZ_SCALE_STEPS[this._vizScaleIdx] || 1);
    },

    // Resize the live visualizer canvas + renderer to the current pixel ratio.
    // Finds the canvas in either mode (in-window or desktop wallpaper). Returns
    // the applied dimensions, or null if there's nothing to resize.
    applyVizResolution: function() {
        const canvas = document.getElementById('visualizer-canvas')
            || document.getElementById('desktop-visualizer');
        if (!canvas) return null;
        const r = this.vizPixelRatio();
        const w = Math.max(1, Math.round(canvas.clientWidth * r));
        const h = Math.max(1, Math.round(canvas.clientHeight * r));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
            if (this.visualizer && this.visualizer.setRendererSize) {
                this.visualizer.setRendererSize(w, h);
            }
        }
        return { w, h, r };
    },

    // Called whenever a new preset is loaded. Every preset starts fresh at full
    // resolution (1.0x) and adapts DOWN from there, rather than inheriting the
    // previous preset's scale — a light preset shouldn't be stuck at the low
    // resolution a previous heavy one forced. Opens a settle window covering the
    // crossfade (during which fps is unrepresentative) before judging begins.
    onVizPresetChanged: function(blendSeconds) {
        this._vizScaleIdx = 0;
        this.applyVizResolution();
        this._vizSettleUntil = performance.now() + (blendSeconds * 1000) + this.VIZ_SETTLE_MARGIN_MS;
    },

    // Adaptive controller, fed the latest 1-second fps sample from the render
    // loop. Each preset starts at full resolution (reset in onVizPresetChanged),
    // so we only ever adapt DOWNWARD: drop a level while under budget, and once
    // we bottom out and still can't make budget, blacklist + skip the preset.
    adaptVizQuality: function(fps) {
        // Never act on a hidden-tab sample — rAF is throttled there, so fps reads
        // near-zero and would wrongly downscale/blacklist. (Blacklisting persists,
        // so this guard matters even though the caller also checks.)
        if (document.hidden) return;
        if (performance.now() < this._vizSettleUntil) return; // mid-transition: hold steady
        if (fps >= this.VIZ_FPS_LOW) return; // making budget — leave it alone
        const steps = this.VIZ_SCALE_STEPS;
        if (this._vizScaleIdx < steps.length - 1) {
            // Too heavy — drop a level and re-measure after a short settle.
            this._vizScaleIdx++;
            const d = this.applyVizResolution();
            this._vizSettleUntil = performance.now() + this.VIZ_STEP_SETTLE_MS;
            console.warn(`📻 Visualizer: ${fps}fps < ${this.VIZ_FPS_LOW} — dropping to scale ${steps[this._vizScaleIdx]}x`
                + (d ? ` (${d.w}×${d.h})` : ''));
        } else {
            // Already at the lowest resolution and STILL under budget — this
            // preset is too heavy for this machine (often a GPU-choking effect).
            // Blacklist it so it never loads again here, and skip to another.
            this._skipHeavyPreset(fps);
        }
    },

    // --- Heavy-preset blacklist ------------------------------------------
    // Some presets use effects that can't reach a usable framerate on a given
    // machine even at the lowest resolution. When the adaptive controller bottoms
    // out and is still under budget, we blacklist that preset (persisted in
    // localStorage) and skip on, so it never wastes time again on this machine.
    VIZ_BLACKLIST_KEY: 'babelcom.viz.blacklist',
    _vizBlacklist: null, // Set<presetName>, lazily loaded from localStorage

    _loadVizBlacklist: function() {
        try {
            const arr = JSON.parse(localStorage.getItem(this.VIZ_BLACKLIST_KEY) || '[]');
            return new Set(Array.isArray(arr) ? arr : []);
        } catch (e) { return new Set(); }
    },
    _blacklistPreset: function(name) {
        if (!name) return;
        if (!this._vizBlacklist) this._vizBlacklist = this._loadVizBlacklist();
        if (this._vizBlacklist.has(name)) return;
        this._vizBlacklist.add(name);
        try {
            localStorage.setItem(this.VIZ_BLACKLIST_KEY, JSON.stringify([...this._vizBlacklist]));
        } catch (e) {}
        console.warn(`📻 Visualizer: blacklisted heavy preset "${name}" (won't load again on this machine)`);
    },
    // Pick a random preset index whose name isn't blacklisted. Falls back to the
    // full set if every preset has somehow been blacklisted.
    pickRandomPresetIndex: function() {
        if (!this.presetNames || !this.presetNames.length) return 0;
        if (!this._vizBlacklist) this._vizBlacklist = this._loadVizBlacklist();
        const allowed = [];
        for (let i = 0; i < this.presetNames.length; i++) {
            if (!this._vizBlacklist.has(this.presetNames[i])) allowed.push(i);
        }
        const pool = allowed.length ? allowed : this.presetNames.map((_, i) => i);
        return pool[Math.floor(Math.random() * pool.length)];
    },
    // Current preset can't sustain framerate even at min resolution: blacklist it
    // and jump straight to another. Short blend (0s) so the heavy preset stops
    // rendering immediately rather than cross-fading for 5s and dragging longer.
    _skipHeavyPreset: function(fps) {
        if (!this.visualizer || !this.presetNames || !this.presets) return;
        const deadName = this.presetNames[this.currentPresetIndex];
        this._blacklistPreset(deadName);
        const idx = this.pickRandomPresetIndex();
        this.currentPresetIndex = idx;
        this.visualizer.loadPreset(this.presets[this.presetNames[idx]], 0.0);
        this.onVizPresetChanged(0.0); // arm adaptive quality for the replacement
        console.warn(`📻 Visualizer: ${fps}fps at min resolution — skipped to "${this.presetNames[idx]}"`);
    },

    // --- Global listener bookkeeping -------------------------------------
    // Listeners on persistent targets (window/document) outlive the radio
    // window, so without tracking them each open→close cycle leaked a handler.
    // setupVisualizer/destroy clear these so they don't accumulate.
    _globalListeners: [],
    _addGlobalListener: function(target, type, fn) {
        target.addEventListener(type, fn);
        this._globalListeners.push({ target, type, fn });
    },
    _removeGlobalListeners: function() {
        for (const { target, type, fn } of this._globalListeners) {
            target.removeEventListener(type, fn);
        }
        this._globalListeners = [];
    },
    // The visualizer's window-resize handler differs between window and
    // wallpaper modes; setAsWallpaper toggles between them. Keep a single slot
    // so toggling swaps the handler instead of stacking a new one each time.
    _modeResizeHandler: null,
    _setModeResize: function(fn) {
        if (this._modeResizeHandler) window.removeEventListener('resize', this._modeResizeHandler);
        this._modeResizeHandler = fn;
        if (fn) window.addEventListener('resize', fn);
    },

    init: function(container, config, winboxWindow) {
        console.log('📻 Radio App: Initializing...');
        this.container = container;
        this.config = config;
        this.winboxWindow = winboxWindow; // Store reference to WinBox window
        this.currentTrack = null;
        this.currentStreamUrl = null;
        this.progressInterval = null;
        this.lastElapsedUpdate = 0;
        this.reconnectAttempts = 0;
        this.stationData = {};
        // Restore the last-picked station (validated against the known list so a
        // removed station can't strand the switcher on a dead shortcode).
        try {
            const saved = localStorage.getItem(this.STATION_KEY);
            if (saved && this.STATIONS.some(s => s.code === saved)) this.currentStation = saved;
        } catch (e) {}
        this.render();
        this.connectWebSocket();
        this.addStyles();
        this.createTaskbarMute();

        // Butterchurn visualizer integration
        if (!window.butterchurn) {
            console.log('📻 Radio App: Loading Butterchurn from CDN...');
            const script = document.createElement('script');
            script.src = '/static/vendor/butterchurn.min.js';
            script.onload = () => this.initVisualizer();
            document.head.appendChild(script);
        } else {
            console.log('📻 Radio App: Butterchurn already loaded, initializing visualizer...');
            this.initVisualizer();
        }
    },

    initVisualizer: function() {
        console.log('📻 Visualizer: Initializing...');
        if (!window.butterchurnPresets) {
            console.log('📻 Visualizer: Loading Butterchurn presets from CDN...');
            const presetScript = document.createElement('script');
            presetScript.src = '/static/vendor/butterchurnPresets.min.js';
            presetScript.onload = () => this.setupVisualizer();
            document.head.appendChild(presetScript);
        } else {
            console.log('📻 Visualizer: Butterchurn presets already loaded, setting up visualizer...');
            this.setupVisualizer();
        }
    },

    setupVisualizer: function() {
        this._setupCount = (this._setupCount || 0) + 1;
        console.log('📻 setupVisualizer call #' + this._setupCount);
        // Drop any global listeners from a previous setup so re-init doesn't
        // stack duplicate window-resize / document-click handlers.
        this._removeGlobalListeners();
        this._setModeResize(null);
        // Clean up any existing visualizer first
        if (this.visualizer) {
            console.log('📻 Visualizer: Cleaning up existing visualizer before reinitializing');
            if (this.visualizerFrame) {
                cancelAnimationFrame(this.visualizerFrame);
                this.visualizerFrame = null;
            }
            this.visualizer = null;
        }
        // --- Destroy and recreate AudioContext and MediaElementSource ---
        if (this.visualizerFrame) {
            cancelAnimationFrame(this.visualizerFrame);
            this.visualizerFrame = null;
        }
        if (this.source) {
            try { this.source.disconnect(); } catch (e) { console.warn('📻 Visualizer: Error disconnecting old source', e); }
            this.source = null;
        }
        if (this.audioCtx) {
            try { this.audioCtx.close(); } catch (e) { console.warn('📻 Visualizer: Error closing old audioCtx', e); }
            this.audioCtx = null;
        }
        // --- End destroy ---
        const audio = document.getElementById('radio-audio');
        const canvas = document.getElementById('visualizer-canvas');
        if (!audio || !canvas) {
            console.log('📻 Visualizer: Audio or canvas element not found');
            return;
        }
        
        // Create new audio context — 'playback' uses a larger buffer to avoid
        // underruns that crackle other page audio (e.g. Clippy chimes).
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({
            latencyHint: 'playback'
        });
        
        // Resume audio context if suspended (required for autoplay policies)
        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
        }
        
        // Create new media source
        this.source = this.audioCtx.createMediaElementSource(audio);
        this.source.connect(this.audioCtx.destination);
        
        // Butterchurn UMD: use .default if available, fallback to direct
        const api = window.butterchurn && window.butterchurn.default ? window.butterchurn.default : window.butterchurn;
        if (!api || !api.createVisualizer) {
            console.error('📻 Visualizer: Butterchurn API not available');
            return;
        }
        
        this.visualizer = api.createVisualizer(this.audioCtx, canvas, {
            width: canvas.width,
            height: canvas.height,
            pixelRatio: this.vizPixelRatio()
        });

        // Feed audio into the visualizer so presets actually react to the music
        this.visualizer.connectAudio(this.source);

        // Load all presets
        const presets = window.butterchurnPresets.getPresets();
        const presetNames = Object.keys(presets);
        
        // Initialize preset cycling variables (blacklist must be loaded before
        // picking so a known-heavy preset isn't chosen as the opener).
        this.presetNames = presetNames;
        this.presets = presets;
        this._vizBlacklist = this._loadVizBlacklist();
        this.currentPresetIndex = this.pickRandomPresetIndex();

        // Log the initial random preset
        const initialPresetName = presetNames[this.currentPresetIndex];
        console.log('📻 Visualizer: Initial random preset selected:', initialPresetName);
        
        // Load initial random preset
        this.visualizer.loadPreset(presets[initialPresetName], 0.0);
        this.onVizPresetChanged(0.0); // arm adaptive quality for the first preset

        // Start preset cycling
        this.startPresetCycling();
        
        // Animate (scale already reset to 1.0x by onVizPresetChanged above)
        this.visualizerEnabled = true;
        let fpsFrames = 0;
        let fpsLastT = performance.now();
        const fpsEl = document.getElementById('visualizer-fps');
        // When the tab becomes visible again, rAF resumes and the first window
        // would otherwise span the whole hidden period (fps ≈ 0). Reset the
        // measurement baseline and re-settle so we judge the preset fresh.
        const onVizVisible = () => {
            if (document.hidden) return;
            fpsFrames = 0;
            fpsLastT = performance.now();
            this._vizSettleUntil = performance.now() + this.VIZ_STEP_SETTLE_MS;
        };
        this._addGlobalListener(document, 'visibilitychange', onVizVisible);
        const renderFrame = () => {
            if (!this.visualizerEnabled) {
                this.visualizerFrame = null;
                return;
            }
            if (this.visualizer) this.visualizer.render();
            fpsFrames++;
            const now = performance.now();
            const elapsed = now - fpsLastT;
            if (elapsed >= 1000) {
                const fps = Math.round(fpsFrames * 1000 / elapsed);
                if (fpsEl) fpsEl.textContent = `${fps} fps`;
                // Only adapt on a TRUSTWORTHY sample. When the tab is hidden the
                // browser throttles/pauses rAF, so fps reads near-zero — feeding
                // that to the controller wrongly downscales and blacklists healthy
                // presets. A stretched window (elapsed ≫ 1s) means rAF was
                // throttled even if visibility didn't flip, so skip those too.
                // A genuinely heavy preset still ticks rAF every frame, so its
                // window stays ~1s and remains trustworthy.
                if (!document.hidden && elapsed < 1500) {
                    this.adaptVizQuality(fps);
                }
                fpsFrames = 0;
                fpsLastT = now;
            }
            this.visualizerFrame = requestAnimationFrame(renderFrame);
        };
        this.renderFrame = renderFrame;
        renderFrame();
        
        // Responsive - handle both window resize and container resize
        this._resizeCount = 0;
        const handleResize = () => {
            if (!canvas) return;

            const ratio = this.vizPixelRatio();
            const newWidth = canvas.clientWidth * ratio;
            const newHeight = canvas.clientHeight * ratio;

            // Skip if size hasn't actually changed — ResizeObserver fires on many layout changes
            if (canvas.width === newWidth && canvas.height === newHeight) return;

            this._resizeCount++;
            console.log('📻 handleResize #' + this._resizeCount, newWidth, 'x', newHeight);

            // Update canvas size
            canvas.width = newWidth;
            canvas.height = newHeight;
            
            // Update visualizer renderer size if it exists
            if (this.visualizer && this.visualizer.setRendererSize) {
                try {
                    this.visualizer.setRendererSize(newWidth, newHeight);
                    //console.log('📻 Visualizer: Resized to', newWidth, 'x', newHeight);
                } catch (error) {
                    console.error('📻 Visualizer: Failed to resize renderer:', error);
                }
            }
        };
        
        // Listen for window resize (tracked so destroy()/re-init can remove it)
        this._addGlobalListener(window, 'resize', handleResize);
        
        // Listen for container resize using ResizeObserver if available
        if (window.ResizeObserver && this.container) {
            const resizeObserver = new ResizeObserver(() => {
                handleResize();
            });
            resizeObserver.observe(this.container);
            
            // Store the observer for cleanup
            this.resizeObserver = resizeObserver;
        }
        
        // Add double-click handler for fullscreen toggle
        canvas.addEventListener('dblclick', () => {
            this.toggleFullscreen();
        });
        
        // Add event listeners for mousemove/touchstart on the radio window
        this.container.addEventListener('mousemove', this.handleUserInteraction.bind(this));
        this.container.addEventListener('touchstart', this.handleUserInteraction.bind(this));

        // Start the fade timer on setup
        this.handleUserInteraction();

        console.log('📻 Visualizer: Setup completed successfully');

        // Session restore asked for wallpaper mode before the visualizer was
        // ready — honor it now.
        if (this._pendingWallpaper) {
            this._pendingWallpaper = false;
            this.setAsWallpaper();
        }
    },

    // Enter wallpaper mode, deferring until the visualizer has finished its
    // async (Butterchurn) setup if it isn't ready yet. Used by session restore.
    requestWallpaper: function() {
        if (document.getElementById('desktop-visualizer')) return; // already wallpaper
        const canvas = document.getElementById('visualizer-canvas');
        if (canvas && this.visualizer) {
            this.setAsWallpaper();
        } else {
            this._pendingWallpaper = true;
        }
    },

    handleUserInteraction: function() {
        const fadeControls = document.querySelector('.fade-controls');
        const fadeProgress = document.querySelector('.progress-container');
        const stationSwitcher = document.querySelector('.station-switcher');
        const volumeContainer = document.querySelector('.volume-container');
        const controlsOverlay = document.querySelector('.radio-controls-overlay');
        if (fadeControls) {
            fadeControls.classList.remove('faded');
        }
        if (fadeProgress) {
            fadeProgress.classList.remove('faded');
        }
        if (stationSwitcher) {
            stationSwitcher.classList.remove('faded');
        }
        if (volumeContainer) {
            volumeContainer.classList.remove('faded');
        }
        if (controlsOverlay) {
            controlsOverlay.classList.remove('controls-faded');
        }
        // Restart the fade timer
        if (this.fadeControlsTimer) {
            clearTimeout(this.fadeControlsTimer);
        }
        this.fadeControlsTimer = setTimeout(() => {
            // Only fade if visualizer is in the window (not wallpaper)
            if (document.getElementById('visualizer-canvas')) {
                if (fadeControls) fadeControls.classList.add('faded');
                if (fadeProgress) fadeProgress.classList.add('faded');
                if (stationSwitcher) stationSwitcher.classList.add('faded');
                // Volume fades too — only the mute button stays on the bottom line.
                if (volumeContainer) volumeContainer.classList.add('faded');
                if (controlsOverlay) controlsOverlay.classList.add('controls-faded');
            }
        }, 5000);
    },

    render: function() {
        this.container.innerHTML = `
            <div class="radio-app">
                <audio id="radio-audio" preload="none" crossorigin="anonymous"></audio>
                <canvas id="visualizer-canvas" width="800" height="600" style="width:100%;height:100%;display:block;position:absolute;top:0;left:0;"></canvas>
                <div id="visualizer-fps" style="position:absolute;top:4px;right:8px;z-index:30;color:#0f0;font:11px monospace;text-shadow:0 0 2px #000;pointer-events:none;">— fps</div>
                <div class="station-bar">
                    <div class="station-switcher" id="station-switcher"></div>
                </div>
                <div class="radio-controls-overlay">
                    <div class="fade-controls viz-controls">
                        <button class="control-btn viz-btn" data-tooltip="Next visual" onclick="RadioApp.changeToRandomPreset()">🔀</button>
                        <button class="control-btn viz-btn" id="viz-toggle-btn" data-tooltip="Hide visual" onclick="RadioApp.toggleVisualizer()">👁️</button>
                        <button class="control-btn viz-btn" id="viz-wallpaper-btn" data-tooltip="Set as wallpaper" onclick="RadioApp.setAsWallpaper()">🖼️</button>
                        <button class="control-btn viz-btn" id="viz-fullscreen-btn" data-tooltip="Full screen" onclick="RadioApp.toggleFullscreen()">🖥️</button>
                    </div>
                    <div class="progress-container">
                        <div class="time-display">
                            <span id="current-time">0:00</span>
                            <span id="total-time">0:00</span>
                        </div>
                        <div class="progress-bar">
                            <div class="progress-fill" id="progress-fill"></div>
                        </div>
                    </div>
                    <div class="now-playing-row">
                        <div class="track-info-overlay">
                            <div class="cover-art-container">
                                <img id="cover-art" src="/static/icons/radio.png" alt="Cover Art" class="cover-art">
                            </div>
                            <div class="track-info">
                                <div class="track-title" id="track-title">Loading...</div>
                                <a id="track-artist-link" href="https://duckduckgo.com/" target="_blank" rel="noopener"><div class="track-artist" id="track-artist">Loading...</div></a>
                            </div>
                        </div>
                        <div class="audio-controls">
                            <div class="volume-container">
                                <input type="range" id="volume-slider" min="0" max="100" value="85"
                                       oninput="RadioApp.setVolume(this.value / 100)">
                            </div>
                            <button class="control-btn mute-btn" id="mute-btn" data-tooltip="Mute" onclick="RadioApp.toggleMute()">
                                <span class="mute-icon">🔊</span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        // Create audio element
        this.createAudioElement();
        // Populate the station switcher buttons.
        this.renderStationSwitcher();
    },

    // Build the segmented station toggle from STATIONS, highlighting the
    // selected one. Re-run cheaply; switchStation just flips the .active class.
    renderStationSwitcher: function() {
        const el = document.getElementById('station-switcher');
        if (!el) return;
        el.innerHTML = this.STATIONS.map(s =>
            `<button class="station-tab${s.code === this.currentStation ? ' active' : ''}"`
            + ` data-station="${s.code}" onclick="RadioApp.switchStation('${s.code}')">${s.name}</button>`
        ).join('');
    },

    updateStationUI: function() {
        const el = document.getElementById('station-switcher');
        if (!el) return;
        el.querySelectorAll('.station-tab').forEach(b => {
            b.classList.toggle('active', b.dataset.station === this.currentStation);
        });
    },

    // Switch the playing station. Re-points the audio at the new mount and
    // repaints track info from the cached payload (or shows "Loading..." until
    // the next push for that station arrives). Persists the choice.
    switchStation: function(code) {
        if (code === this.currentStation) return;
        if (!this.STATIONS.some(s => s.code === code)) return;
        this.currentStation = code;
        try { localStorage.setItem(this.STATION_KEY, code); } catch (e) {}
        this.updateStationUI();
        // Force applyStationData to re-point the audio even if the URL test
        // would otherwise short-circuit.
        this.currentStreamUrl = null;
        const data = this.stationData[code];
        if (data) {
            this.applyStationData(data);
            this.handleUserInteraction();
        } else {
            // No payload yet — keep the previous audio playing and show a
            // placeholder; the next bus message for this station fills it in.
            const t = document.getElementById('track-title');
            const a = document.getElementById('track-artist');
            if (t) t.textContent = 'Loading...';
            if (a) a.textContent = 'Loading...';
            this.handleUserInteraction();
        }
    },

    // Apply a station's cached payload to the audio element + UI. Shared by the
    // live message path (data just arrived) and switchStation (data may be a
    // few seconds old — receivedAt keeps the progress bar honest).
    applyStationData: function(data) {
        if (!data) return;
        if (data.streamUrl && this.currentStreamUrl !== data.streamUrl) {
            this.currentStreamUrl = data.streamUrl;
            this.audio.src = data.streamUrl;
            // Always play; muting is volume 0, so the stream keeps feeding
            // the visualiser even when silent.
            this.playAudio();
        }
        if (data.track) {
            this.updateTrackInfo(data.track);
            if (data.track.elapsed !== undefined) {
                // Anchor progress to when this payload was received so the
                // 1s timer extrapolates correctly even for cached data.
                this.lastElapsedUpdate = data.receivedAt || (Date.now() / 1000);
                this.updateProgress(data.track.elapsed, data.track.duration);
            }
            this.startProgressTimer();
        }
    },

    connectWebSocket: function() {
        // Now-playing rides the main /ws bus as {type:"radio", payload:<raw>}.
        // This gets us the bus's auto-reconnect for free.
        const onRadio = (msg) => {
            if (msg && msg.payload) this.handleMessage(JSON.stringify(msg.payload));
        };
        this._radioUnsub = BabelcomAPI.subscribe('radio', onRadio);
        // Hydrate from the bus's cached last message, if any.
        const cached = BabelcomAPI.getLatest('radio');
        if (cached) onRadio(cached);
    },

    handleMessage: function(data) {
        try {
            //console.log('📻 Received WebSocket message:', data);
            const message = JSON.parse(data);
            //console.log('📻 Parsed message:', message);
            
            let np = null;
            if (message && message.pub && message.pub.data && message.pub.data.np) {
                np = message.pub.data.np;
                //console.log('📻 Now playing data:', np);
            } else {
                //console.log('📻 No now playing data found in message structure');
                return;
            }
            
            if (!np) return;

            // Every station's "now playing" rides the one bus; route by the
            // shortcode in the payload. Ignore stations we don't offer.
            const code = np.station && np.station.shortcode;
            if (!code || !this.STATIONS.some(s => s.code === code)) return;

            // Get stream URL from first mp3 mount
            let streamUrl = null;
            if (np.station && np.station.mounts) {
                const mp3Mount = np.station.mounts.find(m => m.format === 'mp3');
                if (mp3Mount && mp3Mount.url) {
                    streamUrl = mp3Mount.url;
                    //console.log('📻 Stream URL:', streamUrl);
                }
            }

            // Build the track record (if a song is present).
            let track = null;
            const nowPlaying = np.now_playing;
            if (nowPlaying && nowPlaying.song) {
                track = {
                    song_id: nowPlaying.song.id,
                    title: nowPlaying.song.title,
                    artist: nowPlaying.song.artist,
                    artwork_url: nowPlaying.song.art,
                    duration: nowPlaying.duration,
                    elapsed: nowPlaying.elapsed,
                    is_playing: true
                };
            }

            // Cache for this station so a later switch renders instantly.
            this.stationData[code] = { streamUrl, track, receivedAt: Date.now() / 1000 };

            // Only the selected station drives the audio + UI.
            if (code === this.currentStation) {
                this.applyStationData(this.stationData[code]);
            }
        } catch (error) {
            console.error('📻 Parse error:', error);
            console.error('📻 Raw data that failed to parse:', data);
        }
    },

    updateTrackInfo: function(trackData) {
        this.currentTrack = trackData;
        // Update cover art
        const coverArt = document.getElementById('cover-art');
        if (trackData.artwork_url) {
            coverArt.src = trackData.artwork_url;
        } else {
            coverArt.src = '/static/icons/radio.png';
        }
        // Update title and artist
        const title = trackData.title || 'Unknown Title';
        const artist = trackData.artist || 'Unknown Artist';
        document.getElementById('track-title').textContent = title;
        document.getElementById('track-artist').textContent = artist;
        // Point the artist link at a DuckDuckGo search scoped to Bandcamp so it
        // lands on the track/artist's page when it exists.
        const artistLink = document.getElementById('track-artist-link');
        if (artistLink) {
            const query = `${title} (${artist}) site:bandcamp.com`;
            artistLink.href = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
        }
        // Update total time display
        if (trackData.duration) {
            document.getElementById('total-time').textContent = this.formatTime(trackData.duration);
        }
    },

    toggleMute: function() {
        this.isMuted = !this.isMuted;
        // Mute without pausing (keeps the stream/visualizer running).
        if (this.audio) this.audio.volume = this.isMuted ? 0 : this.volume;
        this.updateMuteUI();
    },

    // Keep the in-window mute button and the taskbar toggle in sync.
    updateMuteUI: function() {
        const icon = this.isMuted ? '🔇' : '🔊';
        const muteBtn = document.getElementById('mute-btn');
        if (muteBtn) {
            const muteIcon = muteBtn.querySelector('.mute-icon');
            if (muteIcon) muteIcon.textContent = icon;
            muteBtn.classList.toggle('muted', this.isMuted);
            muteBtn.setAttribute('data-tooltip', this.isMuted ? 'Unmute' : 'Mute');
        }
        const taskbarMute = document.getElementById('taskbar-mute');
        if (taskbarMute) {
            taskbarMute.textContent = icon;
            taskbarMute.classList.toggle('muted', this.isMuted);
        }
    },

    // Add a mute toggle to the taskbar, between the clock and the system
    // status indicator. Removed again in destroy().
    createTaskbarMute: function() {
        if (document.getElementById('taskbar-mute')) return;
        const clock = document.getElementById('clock');
        if (!clock || !clock.parentNode) return;
        const el = document.createElement('div');
        el.id = 'taskbar-mute';
        el.className = 'taskbar-mute';
        el.title = 'Mute / unmute radio';
        el.textContent = this.isMuted ? '🔇' : '🔊';
        el.classList.toggle('muted', this.isMuted);
        el.onclick = () => this.toggleMute();
        // Insert right after the clock → sits between clock and status.
        clock.parentNode.insertBefore(el, clock);
    },

    removeTaskbarMute: function() {
        const el = document.getElementById('taskbar-mute');
        if (el) el.remove();
    },

    // Start playback. If the browser blocks it (autoplay policy — e.g. the
    // radio was restored on boot without a user gesture), wait for the next
    // click/keypress and retry then.
    playAudio: function() {
        if (!this.audio) return;
        const p = this.audio.play();
        if (p && p.then) {
            p.then(() => {
                // Mute = volume 0 (still streaming), so the visualiser stays fed.
                this.audio.volume = this.isMuted ? 0 : this.volume;
                if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume();
            }).catch((error) => {
                if (error && error.name === 'NotAllowedError') {
                    console.warn('📻 Audio: autoplay blocked, waiting for user gesture', error);
                    this.armGesturePlay();
                } else {
                    // Network/source failure — the element's 'error' event also
                    // fires for these, but it doesn't for AbortError etc., so
                    // schedule from here too (scheduleReconnect dedupes).
                    console.warn('📻 Audio: play() failed', error);
                    this.scheduleReconnect('play() failed: ' + (error && error.name));
                }
            });
        }
    },

    armGesturePlay: function() {
        if (this._gestureArmed) return;
        this._gestureArmed = true;
        this.showAudioPrompt();
        const resume = () => {
            this._gestureArmed = false;
            document.removeEventListener('pointerdown', resume);
            document.removeEventListener('keydown', resume);
            this.hideAudioPrompt();
            this.playAudio();
        };
        document.addEventListener('pointerdown', resume, { once: true });
        document.addEventListener('keydown', resume, { once: true });
    },

    showAudioPrompt: function() {
        if (document.getElementById('audio-enable-prompt')) return;
        const el = document.createElement('div');
        el.id = 'audio-enable-prompt';
        el.textContent = '🔊 Click anywhere to enable audio';
        document.body.appendChild(el);
    },

    hideAudioPrompt: function() {
        const el = document.getElementById('audio-enable-prompt');
        if (el) el.remove();
    },

    createAudioElement: function() {
        // Create new audio element
        this.audio = document.getElementById('radio-audio'); // Get the existing audio element
        if (!this.audio) {
            this.audio = document.createElement('audio');
            this.audio.id = 'radio-audio';
            this.audio.preload = 'none';
            this.audio.setAttribute('crossorigin', 'anonymous');
            this.audio.volume = this.volume;
            // Insert after the main-info div
            const mainInfo = document.querySelector('.main-info');
            mainInfo.parentNode.insertBefore(this.audio, mainInfo.nextSibling);
        }
        // Recover from network hiccups: any fatal error schedules a reconnect
        // with backoff; stalls that don't recover within the watchdog window
        // are treated the same way.
        this.audio.addEventListener('error', (e) => {
            const err = e.currentTarget.error;
            let msg = 'Unknown error';
            if (err) {
                switch (err.code) {
                    case err.MEDIA_ERR_ABORTED: msg = 'You aborted the audio playback.'; break;
                    case err.MEDIA_ERR_NETWORK: msg = 'A network error caused the audio download to fail.'; break;
                    case err.MEDIA_ERR_DECODE: msg = 'The audio playback was aborted due to a corruption problem or because the media used features your browser did not support.'; break;
                    case err.MEDIA_ERR_SRC_NOT_SUPPORTED: msg = 'The audio could not be loaded, either because the server or network failed or because the format is not supported.'; break;
                }
            }
            console.error('📻 Audio: error event:', msg, err);
            this.scheduleReconnect('media error');
        });
        // A live stream should never end — if it does, the connection dropped.
        this.audio.addEventListener('ended', () => {
            this.scheduleReconnect('stream ended');
        });
        this.audio.addEventListener('stalled', () => {
            console.warn('📻 Audio: stalled event - media data is not available.');
            this.armStallWatchdog();
        });
        this.audio.addEventListener('waiting', () => {
            console.warn('📻 Audio: waiting event - playback has stopped because of a temporary lack of data.');
            this.armStallWatchdog();
        });
        this.audio.addEventListener('playing', () => {
            // Healthy again: reset backoff and cancel any pending watchdog.
            this.reconnectAttempts = 0;
            this.clearStallWatchdog();
        });

        // When connectivity returns, don't wait out the backoff timer.
        if (!this._onlineHandler) {
            this._onlineHandler = () => {
                if (this.reconnectTimer) {
                    console.log('📻 Audio: network back online, reconnecting now');
                    clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = null;
                    this.reconnectStream();
                }
            };
            window.addEventListener('online', this._onlineHandler);
        }
    },

    // --- Stream resilience -------------------------------------------------

    // If the stream stalls and doesn't start playing again within 10s,
    // assume the connection is dead and reconnect.
    armStallWatchdog: function() {
        if (this.stallTimer || !this.currentStreamUrl) return;
        this.stallTimer = setTimeout(() => {
            this.stallTimer = null;
            this.scheduleReconnect('stalled for 10s');
        }, 10000);
    },

    clearStallWatchdog: function() {
        if (this.stallTimer) {
            clearTimeout(this.stallTimer);
            this.stallTimer = null;
        }
    },

    scheduleReconnect: function(reason) {
        if (!this.currentStreamUrl || this.reconnectTimer) return;
        this.clearStallWatchdog();
        // 1s, 2s, 4s, ... capped at 30s between attempts, forever.
        const delay = Math.min(30000, 1000 * Math.pow(2, this.reconnectAttempts));
        this.reconnectAttempts++;
        console.warn(`📻 Audio: ${reason} — reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.reconnectStream();
        }, delay);
    },

    reconnectStream: function() {
        if (!this.audio || !this.currentStreamUrl) return;
        // Cache-buster forces the browser to open a fresh connection rather
        // than reviving the dead one.
        const sep = this.currentStreamUrl.includes('?') ? '&' : '?';
        this.audio.src = this.currentStreamUrl + sep + '_t=' + Date.now();
        this.audio.load();
        this.playAudio();
    },

    setVolume: function(volume) {
        this.volume = volume;
        if (!this.isMuted) {
            this.audio.volume = volume;
        }
    },



    reinitializeVisualizer: function() {
        console.log('📻 Reinitializing visualizer...');
        if (this.visualizer) {
            // Clean up existing visualizer
            if (this.visualizerFrame) {
                cancelAnimationFrame(this.visualizerFrame);
            }
            this.visualizer = null;
        }
        
        // Clear preset interval before recreating
        if (this.presetInterval) {
            clearInterval(this.presetInterval);
            this.presetInterval = null;
        }
        
        // Recreate the visualizer
        this.setupVisualizer();
    },



    formatTime: function(seconds) {
        if (!seconds || seconds < 0) return '0:00';
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = Math.floor(seconds % 60);
        return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
    },

    startProgressTimer: function() {
        if (this.progressInterval) clearInterval(this.progressInterval);
        this.progressInterval = setInterval(() => {
            if (!this.currentTrack || this.currentTrack.elapsed === undefined) return;
            
            // Calculate elapsed time since last WebSocket update
            const timeSinceLastUpdate = (Date.now() / 1000) - this.lastElapsedUpdate;
            let currentElapsed = this.currentTrack.elapsed + timeSinceLastUpdate;
            
            // Don't exceed the song duration
            if (this.currentTrack.duration && currentElapsed > this.currentTrack.duration) {
                currentElapsed = this.currentTrack.duration;
            }
            
            this.updateProgress(currentElapsed, this.currentTrack.duration);
        }, 1000);
    },

    updateProgress: function(current, total) {
        const progressFill = document.getElementById('progress-fill');
        const currentTime = document.getElementById('current-time');
        if (total > 0) {
            const progress = (current / total) * 100;
            progressFill.style.width = `${progress}%`;
        }
        currentTime.textContent = this.formatTime(current);
    },

    startPresetCycling: function() {
        // Clear any existing interval
        if (this.presetInterval) {
            clearInterval(this.presetInterval);
        }
        
        // Cycle presets every 25 seconds with 5-second cross-fade
        this.presetInterval = setInterval(() => {
            if (!this.visualizer || !this.presetNames || !this.presets) return;
            
            // Select next random preset (skipping blacklisted heavy ones)
            const nextPresetIndex = this.pickRandomPresetIndex();

            // Load new preset with 5-second cross-fade
            this.visualizer.loadPreset(this.presets[this.presetNames[nextPresetIndex]], 5.0);
            // Re-arm adaptive quality: hold through the 5s crossfade, then let
            // the (possibly lighter) new preset reclaim resolution.
            this.onVizPresetChanged(5.0);

            // Update current preset index
            this.currentPresetIndex = nextPresetIndex;
        }, 25000); // 25 seconds
    },

    toggleFullscreen: function() {
        if (!this.winboxWindow) {
            console.log('📻 Radio: WinBox window reference not available');
            return;
        }
        // .full is WinBox's current-state boolean (the .fullscreen method itself
        // is always truthy, which is the bug the old check had).
        const goFull = !this.winboxWindow.full;
        // Fullscreen shows the in-window visualizer, so if it's currently the
        // desktop wallpaper, recall it into the window first.
        if (goFull && document.getElementById('desktop-visualizer')) {
            this.setAsWallpaper();
        }
        this.winboxWindow.fullscreen(goFull);
        const btn = document.getElementById('viz-fullscreen-btn');
        if (btn) btn.setAttribute('data-tooltip', goFull ? 'Exit full screen' : 'Full screen');
        console.log(goFull ? '📻 Radio: Entered fullscreen' : '📻 Radio: Exited fullscreen');
    },

    changeToRandomPreset: function() {
        if (this.visualizer && this.presetNames && this.presets) {
            // Select next random preset (skipping blacklisted heavy ones)
            const nextPresetIndex = this.pickRandomPresetIndex();

            // Load new preset with 5-second cross-fade
            this.visualizer.loadPreset(this.presets[this.presetNames[nextPresetIndex]], 5.0);
            // Re-arm adaptive quality for the new (possibly lighter) preset.
            this.onVizPresetChanged(5.0);

            // Update current preset index
            this.currentPresetIndex = nextPresetIndex;

            console.log('📻 Visualizer: Changed to random preset:', this.presetNames[nextPresetIndex]);
        }
    },

    toggleVisualizer: function() {
        const canvas = document.getElementById('visualizer-canvas');
        const btn = document.getElementById('viz-toggle-btn');
        if (!canvas) return;

        if (canvas.style.display === 'none') {
            // Enable visualizer
            canvas.style.display = 'block';
            if (btn) {
                btn.setAttribute('data-tooltip', 'Hide visual');
                btn.classList.remove('viz-off');
            }
            this.visualizerEnabled = true;
            if (!this.visualizerFrame && this.renderFrame) {
                this.renderFrame();
            }
            this.startPresetCycling();
            console.log('📻 Visualizer: Enabled');
        } else {
            // Disable visualizer
            canvas.style.display = 'none';
            if (btn) {
                btn.setAttribute('data-tooltip', 'Show visual');
                btn.classList.add('viz-off');
            }
            this.visualizerEnabled = false;
            if (this.visualizerFrame) {
                cancelAnimationFrame(this.visualizerFrame);
                this.visualizerFrame = null;
            }
            if (this.presetInterval) {
                clearInterval(this.presetInterval);
                this.presetInterval = null;
            }
            console.log('📻 Visualizer: Disabled');
        }
    },

    setAsWallpaper: function() {
        const canvas = document.getElementById('desktop-visualizer') || document.getElementById('visualizer-canvas');
        const radioApp = this.container.querySelector('.radio-app');
        const wallpaperBtn = document.getElementById('viz-wallpaper-btn');

        // If the visualizer is already on the desktop, move it back to the radio window
        if (canvas && canvas.id === 'desktop-visualizer' && radioApp) {
            canvas.parentNode.removeChild(canvas);
            canvas.id = 'visualizer-canvas';
            canvas.style.position = 'absolute';
            canvas.style.top = '0';
            canvas.style.left = '0';
            canvas.style.width = '100%';
            canvas.style.height = '100%';
            canvas.style.zIndex = '1';
            canvas.style.pointerEvents = '';
            canvas.style.display = 'block';
            // Insert as the second child (after audio)
            radioApp.insertBefore(canvas, radioApp.children[1]);
            // Resize for radio window
            const resizeRadio = () => {
                const ratio = this.vizPixelRatio();
                canvas.width = canvas.clientWidth * ratio;
                canvas.height = canvas.clientHeight * ratio;
                if (this.visualizer && this.visualizer.setRendererSize) {
                    this.visualizer.setRendererSize(canvas.width, canvas.height);
                }
            };
            resizeRadio();
            this._setModeResize(resizeRadio);
            if (wallpaperBtn) wallpaperBtn.setAttribute('data-tooltip', 'Set as wallpaper');
            console.log('📻 Visualizer: Restored to radio window');
        } else if (canvas) {
            // Going to wallpaper — the canvas is leaving the window, so a
            // fullscreen radio window would be empty. Exit fullscreen first.
            if (this.winboxWindow && this.winboxWindow.full) {
                this.winboxWindow.fullscreen(false);
                const ft = document.getElementById('viz-fullscreen-btn');
                if (ft) ft.setAttribute('data-tooltip', 'Full screen');
            }
            // Move the canvas to the body as a desktop wallpaper
            canvas.parentNode.removeChild(canvas);
            canvas.id = 'desktop-visualizer';
            canvas.style.position = 'fixed';
            canvas.style.top = '0';
            canvas.style.left = '0';
            canvas.style.width = '100vw';
            canvas.style.height = '100vh';
            canvas.style.zIndex = '-1';
            canvas.style.pointerEvents = 'none';
            canvas.style.display = 'block';
            document.body.appendChild(canvas);
            // Resize the canvas to fill the screen
            const resizeWallpaper = () => {
                const ratio = this.vizPixelRatio();
                canvas.width = window.innerWidth * ratio;
                canvas.height = window.innerHeight * ratio;
                if (this.visualizer && this.visualizer.setRendererSize) {
                    this.visualizer.setRendererSize(canvas.width, canvas.height);
                }
            };
            resizeWallpaper();
            this._setModeResize(resizeWallpaper);
            if (wallpaperBtn) wallpaperBtn.setAttribute('data-tooltip', 'Back to window');
            console.log('📻 Visualizer: Moved to desktop wallpaper');
        }
        // Always reveal the fading controls when setting as wallpaper.
        const fadeControls = document.querySelector('.fade-controls');
        if (fadeControls) fadeControls.classList.remove('faded');
        const stationSwitcher = document.querySelector('.station-switcher');
        if (stationSwitcher) stationSwitcher.classList.remove('faded');
        const volumeContainer = document.querySelector('.volume-container');
        if (volumeContainer) volumeContainer.classList.remove('faded');
        if (this.fadeControlsTimer) { clearTimeout(this.fadeControlsTimer); this.fadeControlsTimer = null; }
    },

    addStyles: function() {
        const styleId = 'radio-app-styles';
        if (document.getElementById(styleId)) return;
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            .radio-app {
                position: relative;
                width: 100%;
                height: 100%;
                background: transparent; /* let the translucent .winbox show through */
                color: #00ffff;
                font-family: 'Orbitron', sans-serif;
                overflow: hidden;
            }
            
            #visualizer-canvas {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                z-index: 1;
            }
            
            .radio-controls-overlay {
                position: absolute;
                bottom: 0;
                left: 0;
                right: 0;
                background: linear-gradient(transparent, rgba(0, 0, 0, 0.9));
                padding: 20px;
                z-index: 10;
                display: flex;
                flex-direction: column;
                gap: 12px;
                transition: background 0.5s;
            }
            .radio-controls-overlay.controls-faded {
                background: none;
            }
            
            /* Station switcher sits as tabs at the top-center of the radio. It
               floats above the visualizer and fades on idle like the controls. */
            .station-bar {
                position: absolute;
                top: 12px;
                left: 0;
                right: 0;
                display: flex;
                justify-content: center;
                z-index: 15;
                pointer-events: none; /* only the pill itself is interactive */
            }
            .station-bar .station-switcher {
                pointer-events: auto;
            }

            /* The persistent bottom line: now-playing info on the left, audio
               controls (volume + mute) on the right. Stays put when the fading
               controls above it disappear. */
            .now-playing-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                min-width: 0;
            }

            /* Visual controls — their own right-aligned row above, fading on idle. */
            .viz-controls {
                justify-content: flex-end;
            }
            
            .track-info-overlay {
                display: flex;
                align-items: center;
                gap: 15px;
                min-width: 0;
                flex-shrink: 1;
            }
            
            .cover-art-container {
                position: relative;
                width: 60px;
                height: 60px;
                border-radius: 8px;
                overflow: hidden;
                flex-shrink: 0;
                box-shadow: 0 4px 8px rgba(0, 0, 0, 0.5);
            }
            
            .cover-art {
                width: 100%;
                height: 100%;
                object-fit: cover;
            }
            
            .track-info {
                flex-grow: 1;
                text-align: left;
                min-width: 0;
                overflow: hidden;
            }
            
            .track-title {
                font-size: 1.1em;
                font-weight: bold;
                color: #00ffff;
                margin-bottom: 3px;
                text-shadow: 0 0 8px rgba(0, 0, 0, 0.8);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            
            .track-artist {
                font-size: 0.9em;
                color: #ff6b9d;
                text-shadow: 0 0 8px rgba(0, 0, 0, 0.8);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            
            /* Audio controls (volume + mute), right-aligned, always visible. */
            .audio-controls {
                display: flex;
                align-items: center;
                gap: 6px;
            }

            .control-btn {
                background: linear-gradient(45deg, rgba(0, 255, 255, 0.0), rgba(255, 107, 157, 0.0));
                border: none;
                color: #00ffff;
                padding: 10px;
                border-radius: 8px;
                cursor: pointer;
                font-size: 1.1em;
                transition: all 0.3s ease;
                min-width: 45px;
                height: 45px;
                display: flex;
                align-items: center;
                justify-content: center;
                backdrop-filter: blur(10px);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            }
            
            .control-btn:hover {
                background: linear-gradient(45deg, rgba(0, 255, 255, 0.3), rgba(255, 107, 157, 0.3));
                box-shadow: 0 0 20px rgba(0, 255, 255, 0.6);
                transform: translateY(-2px);
            }
            
            .control-btn.muted {
                background: linear-gradient(45deg, rgba(255, 0, 0, 0.3), rgba(255, 107, 157, 0.3));
                border-color: #ff0000;
                color: #ff0000;
            }
            
            .volume-container {
                display: flex;
                align-items: center;
                gap: 8px;
                min-width: 60px;
                transition: opacity 0.5s;
            }
            .volume-container.faded {
                opacity: 0;
                pointer-events: none;
                display: none !important;
            }

            .volume-container input[type="range"] {
                width: 60px;
                height: 6px;
                background: rgba(0, 255, 255, 0.3);
                border-radius: 3px;
                outline: none;
                -webkit-appearance: none;
                cursor: pointer;
            }
            
            .volume-container input[type="range"]::-webkit-slider-thumb {
                -webkit-appearance: none;
                width: 16px;
                height: 16px;
                background: #00ffff;
                border-radius: 50%;
                cursor: pointer;
                box-shadow: 0 0 15px rgba(0, 255, 255, 0.7);
            }
            
            .progress-container {
                margin: 0;
                transition: opacity 0.5s;
            }
            .progress-container.faded {
                opacity: 0;
                pointer-events: none;
                display: none !important;
            }
            
            .progress-bar {
                width: 100%;
                height: 6px;
                background: rgba(0, 255, 255, 0.3);
                border-radius: 3px;
                overflow: hidden;
                margin-bottom: 8px;
                transition: opacity 0.5s;
            }
            .progress-container.faded .progress-bar {
                opacity: 0;
            }
            
            .progress-fill {
                height: 100%;
                background: linear-gradient(90deg, #00ffff, #ff6b9d);
                width: 0%;
                transition: width 0.3s ease;
                box-shadow: 0 0 10px rgba(0, 255, 255, 0.5);
            }
            
            .time-display {
                display: flex;
                justify-content: space-between;
                font-size: 0.9em;
                color: #00ffff;
                text-shadow: 0 0 5px rgba(0, 255, 255, 0.5);
            }
            
            /* Surfaced visualiser controls — compact so the four icons + volume
               fit alongside the track info in the narrow radio window. */
            .viz-btn {
                min-width: 38px;
                width: 38px;
                height: 38px;
                padding: 0;
                font-size: 1em;
            }
            .viz-btn.viz-off {
                opacity: 0.5;
            }

            /* Station switcher: a segmented pill that lives with the track info
               (so it stays visible while the action controls fade on idle). */
            .station-switcher {
                display: inline-flex;
                flex-shrink: 0;
                border: 1px solid rgba(0, 255, 255, 0.4);
                border-radius: 999px;
                overflow: hidden;
                background: rgba(0, 0, 0, 0.35);
                backdrop-filter: blur(8px);
                max-width: 100%;
                transition: opacity 0.5s;
            }
            .station-switcher.faded {
                opacity: 0;
                pointer-events: none;
            }
            .station-tab {
                border: none;
                background: transparent;
                color: rgba(0, 255, 255, 0.55);
                font-family: 'Orbitron', sans-serif;
                font-size: 0.7em;
                letter-spacing: 0.04em;
                text-transform: uppercase;
                padding: 4px 12px;
                cursor: pointer;
                white-space: nowrap;
                transition: all 0.25s ease;
            }
            .station-tab:hover {
                color: #00ffff;
                background: rgba(0, 255, 255, 0.12);
            }
            .station-tab.active {
                color: #0a0a14;
                background: linear-gradient(90deg, #00ffff, #ff6b9d);
                text-shadow: none;
                font-weight: bold;
            }

            .fade-controls {
                display: flex;
                flex-direction: row;
                align-items: center;
                gap: 6px;
                transition: opacity 0.5s;
            }
            .fade-controls.faded {
                opacity: 0;
                pointer-events: none;
                display: none !important;
            }
        `;
        document.head.appendChild(style);
    },

    destroy: function() {
        this.removeTaskbarMute();
        if (this._radioUnsub) { this._radioUnsub(); this._radioUnsub = null; }
        if (this.progressInterval) {
            clearInterval(this.progressInterval);
            this.progressInterval = null;
        }
        if (this.presetInterval) {
            clearInterval(this.presetInterval);
            this.presetInterval = null;
        }
        
        // Clean up visualizer resources
        if (this.visualizerFrame) {
            cancelAnimationFrame(this.visualizerFrame);
            this.visualizerFrame = null;
        }

        // If the visualizer was the desktop wallpaper, remove that canvas so it
        // doesn't linger (frozen) on the desktop after the radio closes.
        const wallpaperCanvas = document.getElementById('desktop-visualizer');
        if (wallpaperCanvas) wallpaperCanvas.remove();
        if (this.visualizer) {
            this.visualizer = null;
        }
        // Disconnect the media source, then close the context. Previously the
        // AudioContext was only nulled, leaking a live context every close —
        // browsers cap these at ~6, so repeated open/close would eventually fail.
        if (this.source) {
            try { this.source.disconnect(); } catch (e) {}
            this.source = null;
        }
        if (this.audioCtx) {
            try { this.audioCtx.close(); } catch (e) {}
            this.audioCtx = null;
        }
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        // Remove the window/document listeners + mode-resize handler the
        // visualizer attached, so they don't pile up across open/close cycles.
        this._removeGlobalListeners();
        this._setModeResize(null);
        
        // Reset visualizer state
        this.currentPresetIndex = null;
        this.presetNames = null;
        this.presets = null;
        
        this.currentTrack = null;
        this.currentStreamUrl = null;
        this.stationData = {};

        // Stop any pending stream reconnect / stall watchdog
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.clearStallWatchdog();
        this.reconnectAttempts = 0;
        if (this._onlineHandler) {
            window.removeEventListener('online', this._onlineHandler);
            this._onlineHandler = null;
        }

        // Destroy audio element if it exists
        if (this.audio) {
            this.audio.pause();
            this.audio.src = '';
            this.audio.remove();
            this.audio = null;
        }

        // Clear the fade timer on destroy
        if (this.fadeControlsTimer) {
            clearTimeout(this.fadeControlsTimer);
            this.fadeControlsTimer = null;
        }
    }
}; 