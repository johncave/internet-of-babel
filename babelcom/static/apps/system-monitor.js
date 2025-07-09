// System Monitor Application
const SystemMonitorApp = {
    name: 'System Monitor',
    icon: '📊',
    
    init: function(container, config) {
        this.container = container;
        this.config = config;
        this.updateInterval = null;
        this.generationLog = [];
        this.websocket = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        
        this.render();
        this.connectWebSocket();
        
        console.log('📊 System Monitor initialized');
    },
    
    render: function() {
        this.container.innerHTML = `
            <div class="app-window system-monitor">
                <h1>System Monitor</h1>

                <!-- Compact System Status -->
                <div class="compact-status">
                    <div class="status-card">
                        <div class="status-icon">
                            <img src="/static/babelcom.webp" alt="Babelcom" style="width: 1.8em; height: 1.8em; vertical-align: middle;" />
                        </div>
                        <div class="status-info">
                            <div class="status-label">babelcom</div>
                            <div class="status-value" id="system-status">Loading...</div>
                        </div>
                    </div>
                    
                    <div class="status-card">
                        <div class="status-icon">💾</div>
                        <div class="status-info">
                            <div class="status-label">Memory</div>
                            <div class="status-value" id="memory-usage">--</div>
                        </div>
                    </div>
                    
                    <div class="status-card">
                        <div class="status-icon">🔥</div>
                        <div class="status-info">
                            <div class="status-label">Compute</div>
                            <div class="status-value" id="cpu-usage">--</div>
                        </div>
                    </div>
                    
                    
                </div>
                
                <!-- Real-time Generation Output -->
                <div class="generation-section">
                    <h3>✨ Current Job</h3>
                    <div class="generation-status">
                        <div class="current-task">
                            <span class="task-label" id="task-label">Writing</span>
                            <span class="task-value" id="current-task">Waiting for babelcom...</span>
                        </div>
                        <div class="llm-output-container" id="llm-output-container">
                            <div class="output-line info">Waiting for babelcom...</div>
                        </div>
                    </div>
                    
                    <!--<div class="real-time-output">
                        
                        
                    </div> -->
                </div>
                
                <!-- Performance Metrics (Bottom) -->
                <div class="performance-metrics">
                    <h3>📈 Overview</h3>
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
                
                <!--<div class="system-actions">
                    <button class="action-btn" onclick="SystemMonitorApp.refreshData()">
                        🔄 Refresh
                    </button>
                    <button class="action-btn" onclick="SystemMonitorApp.clearOutput()">
                        🗑️ Clear Output
                    </button>
                    <button class="action-btn" onclick="SystemMonitorApp.exportReport()">
                        📊 Export
                    </button>
                </div> -->
            </div>
        `;
        
        // Add app-specific styles
        this.addStyles();
    },
    
    connectWebSocket: function() {
        const wsUrl = 'wss://babelcom.johncave.co.nz/ws';
        
        try {
            this.websocket = new WebSocket(wsUrl);
            
            this.websocket.onopen = () => {
                this.addOutputLine('Connected to backend', 'success');
                this.reconnectAttempts = 0;
            };
            
            this.websocket.onmessage = (event) => {
                this.handleWebSocketMessage(event.data);
            };
            
            this.websocket.onclose = () => {
                this.addOutputLine('Disconnected from backend', 'warning');
                this.scheduleReconnect();
            };
            
            this.websocket.onerror = (error) => {
                this.addOutputLine('WebSocket error: ' + error.message, 'error');
            };
            
        } catch (error) {
            this.addOutputLine('Failed to connect: ' + error.message, 'error');
            this.scheduleReconnect();
        }
    },
    
    scheduleReconnect: function() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000); // Exponential backoff, max 30s
            
            this.addOutputLine(`Reconnecting in ${delay/1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`, 'info');
            
            setTimeout(() => {
                this.connectWebSocket();
            }, delay);
        } else {
            this.addOutputLine('Max reconnection attempts reached', 'error');
        }
    },
    
    handleWebSocketMessage: function(data) {
        try {
            const message = JSON.parse(data);
            
            switch (message.type) {
                case 'initial_data':
                    this.handleInitialData(message.data);
                    break;
                    
                case 'system_status':
                    this.updateSystemStatus(message.data);
                    break;
                    
                case 'token':
                    this.addLLMOutput(message.token);
                    break;
                    
                case 'reset':
                    this.clearLLMOutput();
                    break;
                    
                    
                default:
                    console.log('Unknown message type:', message.type);
            }
        } catch (error) {
            console.error('Error parsing WebSocket message:', error);
        }
    },
    
    handleInitialData: function(data) {
        if (data.system_status) {
            this.updateSystemStatus(data.system_status);
        }
        if (data.generation_status) {
            this.updateGenerationStatus(data.generation_status);
        }
        if (data.output_log) {
            // Clear existing output and add historical log
            const container = document.getElementById('output-container');
            container.innerHTML = '';
            data.output_log.forEach(msg => {
                this.addOutputLine(msg.message, msg.type, false);
            });
        }
        
        // Clear LLM output on initial connection
        const llmContainer = document.getElementById('llm-output-container');
        llmContainer.innerHTML = '<div class="output-line info">Connected to LLM stream...</div>';
    },
    
    updateSystemStatus: function(status) {
        //console.log(status);
        document.getElementById('system-status').textContent = status.status;
        document.getElementById('memory-usage').textContent = status.memory_usage.toFixed(1) + '%';
        document.getElementById('cpu-usage').textContent = status.cpu_usage.toFixed(1) + '%';
        document.getElementById('articles-count').textContent = status.articles_count.toLocaleString();
        document.getElementById('system-uptime').textContent = status.uptime;
        document.getElementById('task-label').textContent = status.current_phase || 'Writing';
        document.getElementById('current-task').textContent = status.current_title || 'No current task';

        // Update colors based on usage
        this.updateStatusColor('memory-usage', status.memory_usage);
        this.updateStatusColor('cpu-usage', status.cpu_usage);
    },
    
    updateGenerationStatus: function(generation) {
        document.getElementById('current-task').textContent = generation.current_task;
        document.getElementById('generation-rate').textContent = generation.progress.toFixed(1) + '%';
        document.getElementById('queue-size').textContent = generation.time_remaining;
    },
    
    updateCurrentWord: function(data) {
        // Update the current word display if needed
        const taskElement = document.getElementById('current-task');
        const currentText = taskElement.textContent;
        
        // If we have a current word, append it to the task
        if (data.word) {
            const baseTask = currentText.split(' - ')[0]; // Remove any existing word
            taskElement.textContent = `${baseTask} - ${data.word}`;
        }
    },
    
    updateStatusColor: function(elementId, value) {
        const element = document.getElementById(elementId);
        if (value > 80) {
            element.style.color = '#ff0000';
        } else if (value > 60) {
            element.style.color = '#ffff00';
        } else {
            element.style.color = '#00ffff';
        }
    },
    
    addOutputLine: function(message, type = 'info', scroll = true) {
        const container = document.getElementById('output-container');
        const timestamp = new Date().toLocaleTimeString();
        
        const line = document.createElement('div');
        line.className = `output-line ${type}`;
        line.textContent = `[${timestamp}] ${message}`;
        
        container.appendChild(line);
        
        if (scroll) {
            container.scrollTop = container.scrollHeight;
        }
        
        // Keep only last 50 lines
        while (container.children.length > 50) {
            container.removeChild(container.firstChild);
        }
    },
    
    addLLMOutput: function(token) {
        const container = document.getElementById('llm-output-container');
        
        // Create a span for the token
        const tokenSpan = document.createElement('span');
        tokenSpan.className = 'llm-token';
        tokenSpan.textContent = token;
        
        // Add a space after the token (except for punctuation)
        // if (!token.match(/^[.,!?;:]$/)) {
        //     tokenSpan.textContent += ' ';
        // }

        tokenSpan.innerHTML = token.replace(/\n/g, '<br>');
        
        container.appendChild(tokenSpan);
        
        // Auto-scroll to bottom
        container.scrollTop = container.scrollHeight;
        
        // Keep only last 1000 tokens to prevent memory issues
        while (container.children.length > 1000) {
            container.removeChild(container.firstChild);
        }
    },
    
    clearLLMOutput: function() {
        const container = document.getElementById('llm-output-container');
        container.innerHTML = '';
        console.log('LLM output cleared');
    },
    
    addStyles: function() {
        const styleId = 'system-monitor-styles';
        if (document.getElementById(styleId)) return;
        
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
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
                font-family: 'Orbitron', sans-serif;
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
            
            .task-label {
                color: #ff6b9d;
                font-weight: bold;
            }
            
            .task-value {
                color: #00ffff;
                font-weight: bold;
                text-shadow: 0 0 5px rgba(0, 255, 255, 0.5);
            }
            
            .real-time-output {
                margin-top: 20px;
            }
            
            .real-time-output h4 {
                color: #ff6b9d;
                font-family: 'Orbitron', sans-serif;
                margin-bottom: 15px;
                text-shadow: 0 0 8px rgba(255, 107, 157, 0.5);
            }
            
            .output-container {
                background: rgba(0, 0, 0, 0.8);
                border: 1px solid rgba(0, 255, 255, 0.3);
                border-radius: 10px;
                padding: 15px;
                height: 200px;
                overflow-y: auto;
                font-family: 'Share Tech Mono', monospace;
                font-size: 0.9em;
                line-height: 1.4;
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
            
            .output-line:last-child {
                border-bottom: none;
            }
            
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
            
            .status-info {
                flex: 1;
            }
            
            .status-label {
                color: #ff6b9d;
                font-size: 0.8em;
                font-weight: bold;
                margin-bottom: 2px;
            }
            
            .status-value {
                color: #00ffff;
                font-weight: bold;
                text-shadow: 0 0 5px rgba(0, 255, 255, 0.5);
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
                font-family: 'Orbitron', sans-serif;
                margin-bottom: 15px;
                text-shadow: 0 0 8px rgba(255, 0, 128, 0.5);
            }
            
            .metrics-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 12px;
            }

            .system-monitor {
                padding: 10px;
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
            
            .system-actions {
                display: flex;
                gap: 15px;
                justify-content: center;
            }
            
            .action-btn {
                background: linear-gradient(45deg, rgba(0, 255, 255, 0.1), rgba(255, 0, 128, 0.1));
                border: 2px solid #00ffff;
                color: #00ffff;
                padding: 10px 20px;
                border-radius: 8px;
                cursor: pointer;
                font-family: 'Orbitron', sans-serif;
                font-weight: bold;
                font-size: 0.9em;
                transition: all 0.3s ease;
            }
            
            .action-btn:hover {
                background: linear-gradient(45deg, rgba(0, 255, 255, 0.2), rgba(255, 0, 128, 0.2));
                box-shadow: 0 0 15px rgba(0, 255, 255, 0.5);
                transform: translateY(-2px);
            }
        `;
        document.head.appendChild(style);
    },
    
    refreshData: function() {
        this.addOutputLine('Manual refresh requested', 'info');
    },
    
    clearOutput: function() {
        const container = document.getElementById('output-container');
        container.innerHTML = '<div class="output-line info">Output cleared...</div>';
    },
    
    exportReport: function() {
        this.addOutputLine('System report exported', 'success');
    },
    
    destroy: function() {
        if (this.websocket) {
            this.websocket.close();
        }
        console.log('📊 System Monitor destroyed');
    }
}; 