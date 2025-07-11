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

    init: function(container, config) {
        this.container = container;
        this.config = config;
        this.currentTrack = null;
        this.currentStreamUrl = null;
        this.progressInterval = null;
        this.lastElapsedUpdate = 0;
        this.render();
        this.connectWebSocket();
        this.addStyles();
    },

    render: function() {
        this.container.innerHTML = `
            <div class="radio-app">
                <audio id="radio-audio" preload="none"></audio>
                <div class="radio-content">
                    <div class="main-info">
                        <div class="cover-art-container">
                            <img id="cover-art" src="/static/icons/radio.png" alt="Cover Art" class="cover-art">
                        </div>
                        <div class="track-info">
                            <div class="track-title" id="track-title">Loading...</div>
                            <a href="https://kratzwerk.bandcamp.com/" target="_blank"><div class="track-artist" id="track-artist">Loading...</div></a>
                        </div>
                        <div class="controls">
                            <div class="volume-container">
                                <input type="range" id="volume-slider" min="0" max="100" value="85" 
                                       oninput="RadioApp.setVolume(this.value / 100)">
                            </div>
                            <button class="control-btn mute-btn" id="mute-btn" onclick="RadioApp.toggleMute()">
                                <span class="mute-icon">🔊</span>
                            </button>
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
        const wsUrl = 'wss://babelcom.johncave.co.nz/ws/radio';
        try {
            this.websocket = new WebSocket(wsUrl);
            this.websocket.onopen = () => {
                console.log('📻 Radio WebSocket connected');
            };
            this.websocket.onmessage = (event) => {
                this.handleMessage(event.data);
            };
            this.websocket.onclose = () => {
                console.log('📻 Radio WebSocket disconnected');
            };
            this.websocket.onerror = (error) => {
                console.error('📻 Radio WebSocket error:', error);
            };
        } catch (error) {
            console.error('📻 Failed to connect to radio WebSocket:', error);
        }
    },

    handleMessage: function(data) {
        try {
            console.log('📻 Received WebSocket message:', data);
            const message = JSON.parse(data);
            console.log('📻 Parsed message:', message);
            
            let np = null;
            if (message && message.pub && message.pub.data && message.pub.data.np) {
                np = message.pub.data.np;
                console.log('📻 Now playing data:', np);
            } else {
                console.log('📻 No now playing data found in message structure');
                return;
            }
            
            if (!np) return;
            
            // Get stream URL from first mp3 mount
            let streamUrl = null;
            if (np.station && np.station.mounts) {
                const mp3Mount = np.station.mounts.find(m => m.format === 'mp3');
                if (mp3Mount && mp3Mount.url) {
                    streamUrl = mp3Mount.url.replace(/^https?:/, '');
                    console.log('📻 Stream URL:', streamUrl);
                }
            }
            
            if (streamUrl && this.currentStreamUrl !== streamUrl) {
                this.currentStreamUrl = streamUrl;
                this.audio.src = streamUrl;
                if (!this.isMuted) this.audio.play();
            }
            
            // Update now playing info
            const nowPlaying = np.now_playing;
            if (nowPlaying && nowPlaying.song) {
                console.log('📻 Current song:', nowPlaying.song);
                
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
        const muteBtn = document.getElementById('mute-btn');
        const muteIcon = muteBtn.querySelector('.mute-icon');
        if (this.isMuted) {
            muteIcon.textContent = '🔇';
            muteBtn.classList.add('muted');
            // Destroy audio element when muted
            if (this.audio) {
                this.audio.pause();
                this.audio.src = '';
                this.audio.remove();
                this.audio = null;
            }
        } else {
            muteIcon.textContent = '🔊';
            muteBtn.classList.remove('muted');
            // Recreate audio element when unmuted
            this.createAudioElement();
            if (this.currentStreamUrl) {
                this.audio.src = this.currentStreamUrl;
                this.audio.volume = this.volume;
                this.audio.play();
            }
        }
    },

    createAudioElement: function() {
        // Create new audio element
        this.audio = document.getElementById('radio-audio'); // Get the existing audio element
        if (!this.audio) {
            this.audio = document.createElement('audio');
            this.audio.id = 'radio-audio';
            this.audio.preload = 'none';
            this.audio.volume = this.volume;
            this.audio.addEventListener('ended', () => {
                // No-op, as play/pause is removed
            });
            // Insert after the main-info div
            const mainInfo = document.querySelector('.main-info');
            mainInfo.parentNode.insertBefore(this.audio, mainInfo.nextSibling);
        }
    },

    setVolume: function(volume) {
        this.volume = volume;
        if (!this.isMuted) {
            this.audio.volume = volume;
        }
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

    addStyles: function() {
        const styleId = 'radio-app-styles';
        if (document.getElementById(styleId)) return;
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            .radio-app {
                padding: 10px;
                background: rgba(0, 0, 0, 0.8);
                border-radius: 15px;
                color: #00ffff;
                font-family: 'Orbitron', sans-serif;
            }
            .radio-content {
                display: flex;
                flex-direction: column;
                gap: 15px;
            }
            .main-info {
                display: flex;
                align-items: center;
                gap: 15px;
                
                
            }
            .cover-art-container {
                position: relative;
                width: 80px;
                height: 80px;
                border-radius: 8px;
                overflow: hidden;
                
                flex-shrink: 0;
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
            }
            .track-title {
                font-size: 1em;
                font-weight: bold;
                color: #00ffff;
                margin-bottom: 3px;
                text-shadow: 0 0 5px rgba(0, 255, 255, 0.5);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .track-artist {
                font-size: 0.85em;
                color: #ff6b9d;
                text-shadow: 0 0 5px rgba(255, 107, 157, 0.5);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .controls {
                display: flex;
                align-items: center;
                gap: 10px;
                flex-shrink: 0;
            }
            .control-btn {
                background: linear-gradient(45deg, rgba(0, 255, 255, 0.1), rgba(255, 107, 157, 0.1));
                border: 2px solid #00ffff;
                color: #00ffff;
                padding: 8px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 1em;
                transition: all 0.3s ease;
                min-width: 40px;
                height: 40px;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .control-btn:hover {
                background: linear-gradient(45deg, rgba(0, 255, 255, 0.2), rgba(255, 107, 157, 0.2));
                box-shadow: 0 0 15px rgba(0, 255, 255, 0.5);
                transform: translateY(-2px);
            }
            .control-btn.muted {
                background: linear-gradient(45deg, rgba(255, 0, 0, 0.2), rgba(255, 107, 157, 0.2));
                border-color: #ff0000;
                color: #ff0000;
            }
            .volume-container {
                display: flex;
                align-items: center;
                gap: 5px;
                min-width: 60px;
            }
            .volume-container input[type="range"] {
                width: 60px;
                height: 4px;
                background: rgba(0, 255, 255, 0.2);
                border-radius: 2px;
                outline: none;
                -webkit-appearance: none;
            }
            .volume-container input[type="range"]::-webkit-slider-thumb {
                -webkit-appearance: none;
                width: 12px;
                height: 12px;
                background: #00ffff;
                border-radius: 50%;
                cursor: pointer;
                box-shadow: 0 0 10px rgba(0, 255, 255, 0.5);
            }
            .progress-container {
                margin: 0;
            }
            .progress-bar {
                width: 100%;
                height: 4px;
                background: rgba(0, 255, 255, 0.2);
                border-radius: 2px;
                overflow: hidden;
                margin-bottom: 8px;
            }
            .progress-fill {
                height: 100%;
                background: linear-gradient(90deg, #00ffff, #ff6b9d);
                width: 0%;
                transition: width 0.3s ease;
            }
            .time-display {
                display: flex;
                justify-content: space-between;
                font-size: 0.8em;
                color: #00ffff;
            }
        `;
        document.head.appendChild(style);
    },

    destroy: function() {
        if (this.websocket) {
            this.websocket.close();
            this.websocket = null;
        }
        if (this.progressInterval) {
            clearInterval(this.progressInterval);
            this.progressInterval = null;
        }
        this.currentTrack = null;
        this.currentStreamUrl = null;
        // Destroy audio element if it exists
        if (this.audio) {
            this.audio.pause();
            this.audio.src = '';
            this.audio.remove();
            this.audio = null;
        }
    }
}; 