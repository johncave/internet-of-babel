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
            pixelRatio: window.devicePixelRatio || 1
        });

        // Feed audio into the visualizer so presets actually react to the music
        this.visualizer.connectAudio(this.source);

        // Load all presets
        const presets = window.butterchurnPresets.getPresets();
        const presetNames = Object.keys(presets);
        
        // Initialize preset cycling variables
        this.currentPresetIndex = Math.floor(Math.random() * presetNames.length);
        this.presetNames = presetNames;
        this.presets = presets;
        
        // Log the initial random preset
        const initialPresetName = presetNames[this.currentPresetIndex];
        console.log('📻 Visualizer: Initial random preset selected:', initialPresetName);
        
        // Load initial random preset
        this.visualizer.loadPreset(presets[initialPresetName], 0.0);
        
        // Start preset cycling
        this.startPresetCycling();
        
        // Animate
        this.visualizerEnabled = true;
        let fpsFrames = 0;
        let fpsLastT = performance.now();
        const fpsEl = document.getElementById('visualizer-fps');
        const renderFrame = () => {
            if (!this.visualizerEnabled) {
                this.visualizerFrame = null;
                return;
            }
            if (this.visualizer) this.visualizer.render();
            fpsFrames++;
            const now = performance.now();
            if (now - fpsLastT >= 1000) {
                if (fpsEl) fpsEl.textContent = `${Math.round(fpsFrames * 1000 / (now - fpsLastT))} fps`;
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

            const newWidth = canvas.clientWidth * window.devicePixelRatio;
            const newHeight = canvas.clientHeight * window.devicePixelRatio;

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
        
        // Listen for window resize
        window.addEventListener('resize', handleResize);
        
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
        
        // Add click handler to close visualizer menu when clicking outside
        document.addEventListener('click', (event) => {
            const menu = document.getElementById('visualizer-menu');
            const visualizerBtn = document.getElementById('visualizer-btn');
            
            if (menu && menu.classList.contains('active') && 
                !menu.contains(event.target) && 
                !visualizerBtn.contains(event.target)) {
                menu.classList.remove('active');
            }
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
            const menu = document.getElementById('visualizer-menu');
            if (menu) menu.classList.remove('active');
        }
    },

    // Enter wallpaper mode, deferring until the visualizer has finished its
    // async (Butterchurn) setup if it isn't ready yet. Used by session restore.
    requestWallpaper: function() {
        if (document.getElementById('desktop-visualizer')) return; // already wallpaper
        const canvas = document.getElementById('visualizer-canvas');
        if (canvas && this.visualizer) {
            this.setAsWallpaper();
            const menu = document.getElementById('visualizer-menu');
            if (menu) menu.classList.remove('active');
        } else {
            this._pendingWallpaper = true;
        }
    },

    handleUserInteraction: function() {
        const fadeControls = document.querySelector('.fade-controls');
        const fadeProgress = document.querySelector('.progress-container');
        const controlsOverlay = document.querySelector('.radio-controls-overlay');
        if (fadeControls) {
            fadeControls.classList.remove('faded');
        }
        if (fadeProgress) {
            fadeProgress.classList.remove('faded');
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
                <div class="radio-controls-overlay">
                    <div class="main-controls-row">
                        <div class="track-info-overlay">
                            <div class="cover-art-container">
                                <img id="cover-art" src="/static/icons/radio.png" alt="Cover Art" class="cover-art">
                            </div>
                            <div class="track-info">
                                <div class="track-title" id="track-title">Loading...</div>
                                <a href="https://kratzwerk.bandcamp.com/" target="_blank"><div class="track-artist" id="track-artist">Loading...</div></a>
                            </div>
                        </div>
                        <div class="controls-overlay">
                            <div class="fade-controls">
                                <div class="volume-container">
                                    <input type="range" id="volume-slider" min="0" max="100" value="85" 
                                           oninput="RadioApp.setVolume(this.value / 100)">
                                </div>
                                <button class="control-btn visualizer-btn" id="visualizer-btn" onclick="RadioApp.toggleVisualizerMenu()">
                                    <span class="visualizer-icon">🎨</span>
                                </button>
                            </div>
                            <button class="control-btn mute-btn" id="mute-btn" onclick="RadioApp.toggleMute()">
                                <span class="mute-icon">🔊</span>
                            </button>
                        </div>
                        <div class="visualizer-menu" id="visualizer-menu">
                            <div class="menu-item" onclick="RadioApp.changeToRandomPreset()">
                                <span class="menu-icon">🔀</span>
                                <span class="menu-text">Next Visual</span>
                            </div>
                            <div class="menu-item" onclick="RadioApp.toggleVisualizer()">
                                <span class="menu-icon">👁️</span>
                                <span class="menu-text" id="visualizer-toggle-text">Disable visual</span>
                            </div>
                            <div class="menu-item" onclick="RadioApp.setAsWallpaper()">
                                <span class="menu-icon">🖼️</span>
                                <span class="menu-text" id="visualizer-wallpaper-text">Wallpaper</span>
                            </div>
                            <div class="menu-item" onclick="RadioApp.toggleFullscreen()">
                                <span class="menu-icon">🖥️</span>
                                <span class="menu-text" id="visualizer-fullscreen-text">Full screen</span>
                            </div>
                        </div>
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
                </div>
            </div>
        `;
        // Create audio element
        this.createAudioElement();
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
            
            // Get stream URL from first mp3 mount
            let streamUrl = null;
            if (np.station && np.station.mounts) {
                const mp3Mount = np.station.mounts.find(m => m.format === 'mp3');
                if (mp3Mount && mp3Mount.url) {
                    streamUrl = mp3Mount.url;
                    //console.log('📻 Stream URL:', streamUrl);
                }
            }
            
            if (streamUrl && this.currentStreamUrl !== streamUrl) {
                this.currentStreamUrl = streamUrl;
                this.audio.src = streamUrl;
                // Always play; muting is volume 0, so the stream keeps feeding
                // the visualiser even when silent.
                this.playAudio();
            }
            
            // Update now playing info
            const nowPlaying = np.now_playing;
            if (nowPlaying && nowPlaying.song) {
                //console.log('📻 Current song:', nowPlaying.song);
                
                // Check if this is a new song
                const isNewSong = !this.currentTrack || this.currentTrack.song_id !== nowPlaying.song.id;
                
                this.currentTrack = {
                    song_id: nowPlaying.song.id,
                    title: nowPlaying.song.title,
                    artist: nowPlaying.song.artist,
                    artwork_url: nowPlaying.song.art,
                    duration: nowPlaying.duration,
                    elapsed: nowPlaying.elapsed,
                    is_playing: true
                };
                
                this.updateTrackInfo(this.currentTrack);
                
                // Update progress immediately with the elapsed time from the message
                if (this.currentTrack.elapsed !== undefined) {
                    this.lastElapsedUpdate = Date.now() / 1000;
                    this.updateProgress(this.currentTrack.elapsed, this.currentTrack.duration);
                }
                
                // Start progress timer for smooth updates between WebSocket messages
                this.startProgressTimer();
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
        document.getElementById('track-title').textContent = trackData.title || 'Unknown Title';
        document.getElementById('track-artist').textContent = trackData.artist || 'Unknown Artist';
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
            
            // Select next random preset
            const nextPresetIndex = Math.floor(Math.random() * this.presetNames.length);
            
            // Load new preset with 5-second cross-fade
            this.visualizer.loadPreset(this.presets[this.presetNames[nextPresetIndex]], 5.0);
            
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
        const text = document.getElementById('visualizer-fullscreen-text');
        if (text) text.textContent = goFull ? 'Exit full screen' : 'Full screen';
        const menu = document.getElementById('visualizer-menu');
        if (menu) menu.classList.remove('active');
        console.log(goFull ? '📻 Radio: Entered fullscreen' : '📻 Radio: Exited fullscreen');
    },

    toggleVisualizerMenu: function() {
        const menu = document.getElementById('visualizer-menu');
        if (menu) {
            menu.classList.toggle('active');
            console.log('📻 Visualizer: Menu toggled');
        }
    },

    changeToRandomPreset: function() {
        if (this.visualizer && this.presetNames && this.presets) {
            // Select next random preset
            const nextPresetIndex = Math.floor(Math.random() * this.presetNames.length);
            
            // Load new preset with 5-second cross-fade
            this.visualizer.loadPreset(this.presets[this.presetNames[nextPresetIndex]], 5.0);
            
            // Update current preset index
            this.currentPresetIndex = nextPresetIndex;
            
            console.log('📻 Visualizer: Changed to random preset:', this.presetNames[nextPresetIndex]);
        }
        
        // Close the menu
        this.toggleVisualizerMenu();
    },

    toggleVisualizer: function() {
        const canvas = document.getElementById('visualizer-canvas');
        const toggleText = document.getElementById('visualizer-toggle-text');

        if (canvas && toggleText) {
            if (canvas.style.display === 'none') {
                // Enable visualizer
                canvas.style.display = 'block';
                toggleText.textContent = 'Disable Visualizer';
                this.visualizerEnabled = true;
                if (!this.visualizerFrame && this.renderFrame) {
                    this.renderFrame();
                }
                this.startPresetCycling();
                console.log('📻 Visualizer: Enabled');
            } else {
                // Disable visualizer
                canvas.style.display = 'none';
                toggleText.textContent = 'Enable Visualizer';
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
        }

        // Close the menu
        this.toggleVisualizerMenu();
    },

    setAsWallpaper: function() {
        const canvas = document.getElementById('desktop-visualizer') || document.getElementById('visualizer-canvas');
        const radioApp = this.container.querySelector('.radio-app');
        const wallpaperMenuText = document.getElementById('visualizer-wallpaper-text');

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
                canvas.width = canvas.clientWidth * window.devicePixelRatio;
                canvas.height = canvas.clientHeight * window.devicePixelRatio;
                if (this.visualizer && this.visualizer.setRendererSize) {
                    this.visualizer.setRendererSize(canvas.width, canvas.height);
                }
            };
            resizeRadio();
            window.addEventListener('resize', resizeRadio);
            if (wallpaperMenuText) wallpaperMenuText.textContent = 'Wallpaper';
            console.log('📻 Visualizer: Restored to radio window');
        } else if (canvas) {
            // Going to wallpaper — the canvas is leaving the window, so a
            // fullscreen radio window would be empty. Exit fullscreen first.
            if (this.winboxWindow && this.winboxWindow.full) {
                this.winboxWindow.fullscreen(false);
                const ft = document.getElementById('visualizer-fullscreen-text');
                if (ft) ft.textContent = 'Full screen';
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
                canvas.width = window.innerWidth * window.devicePixelRatio;
                canvas.height = window.innerHeight * window.devicePixelRatio;
                if (this.visualizer && this.visualizer.setRendererSize) {
                    this.visualizer.setRendererSize(canvas.width, canvas.height);
                }
            };
            resizeWallpaper();
            window.addEventListener('resize', resizeWallpaper);
            if (wallpaperMenuText) wallpaperMenuText.textContent = 'Window';
            console.log('📻 Visualizer: Moved to desktop wallpaper');
        }
        this.toggleVisualizerMenu();
        // Always remove .faded from .fade-controls when setting as wallpaper
        const fadeControls = document.querySelector('.fade-controls');
        if (fadeControls) fadeControls.classList.remove('faded');
        if (this.fadeControlsTimer) { clearTimeout(this.fadeControlsTimer); this.fadeControlsTimer = null; }
    },

    initDesktopVisualizer: function(canvas) {
        // Create new audio context for desktop visualizer
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const audio = document.getElementById('radio-audio');
        
        if (!audio) {
            console.error('📻 Desktop Visualizer: No audio element found');
            return;
        }
        
        // Create media source
        const source = audioCtx.createMediaElementSource(audio);
        source.connect(audioCtx.destination);
        
        // Set canvas size
        canvas.width = window.innerWidth * window.devicePixelRatio;
        canvas.height = window.innerHeight * window.devicePixelRatio;
        
        // Create visualizer
        const api = window.butterchurn && window.butterchurn.default ? window.butterchurn.default : window.butterchurn;
        if (!api || !api.createVisualizer) {
            console.error('📻 Desktop Visualizer: Butterchurn API not available');
            return;
        }
        
        const visualizer = api.createVisualizer(audioCtx, canvas, {
            width: canvas.width,
            height: canvas.height,
            pixelRatio: window.devicePixelRatio || 1
        });
        
        // Load random preset
        if (this.presets && this.presetNames) {
            const presetIndex = Math.floor(Math.random() * this.presetNames.length);
            visualizer.loadPreset(this.presets[this.presetNames[presetIndex]], 0.0);
        }
        
        // Animate
        const renderFrame = () => {
            if (visualizer) visualizer.render();
            requestAnimationFrame(renderFrame);
        };
        renderFrame();
        
        // Handle window resize
        window.addEventListener('resize', () => {
            canvas.width = window.innerWidth * window.devicePixelRatio;
            canvas.height = window.innerHeight * window.devicePixelRatio;
            visualizer.setRendererSize(canvas.width, canvas.height);
        });
        
        console.log('📻 Desktop Visualizer: Initialized');
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
                gap: 15px;
                transition: background 0.5s;
            }
            .radio-controls-overlay.controls-faded {
                background: none;
            }
            
            .main-controls-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 20px;
                min-width: 0;
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
            
            .controls-overlay {
                display: flex;
                align-items: center;
                
                justify-content: center;
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
                min-width: 80px;
            }
            
            .volume-container input[type="range"] {
                width: 80px;
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
            
            .visualizer-menu {
                position: absolute;
                bottom: 100%;
                right: 0;
                background: rgba(0, 0, 0, 0.95);
                backdrop-filter: blur(15px);
                border: 2px solid #00ffff;
                border-radius: 10px;
                padding: 10px;
                margin-bottom: 10px;
                z-index: 20;
                display: none;
                min-width: 200px;
                box-shadow: 0 0 20px rgba(0, 255, 255, 0.3);
            }
            
            .visualizer-menu.active {
                display: block;
            }
            
            .menu-item {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 12px;
                cursor: pointer;
                border-radius: 6px;
                transition: all 0.3s ease;
                color: #00ffff;
                font-family: 'Orbitron', sans-serif;
                font-size: 0.9em;
            }
            
            .menu-item:hover {
                background: rgba(0, 255, 255, 0.1);
                transform: translateX(5px);
            }
            
            .menu-icon {
                font-size: 1.2em;
                width: 20px;
                text-align: center;
            }
            
            .menu-text {
                flex: 1;
            }

            .fade-controls {
                display: flex;
                flex-direction: row;
                align-items: center;
                gap: 8px;
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
        if (this.audioCtx) {
            this.audioCtx = null;
        }
        if (this.source) {
            this.source = null;
        }
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        
        // Reset visualizer state
        this.currentPresetIndex = null;
        this.presetNames = null;
        this.presets = null;
        
        this.currentTrack = null;
        this.currentStreamUrl = null;

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