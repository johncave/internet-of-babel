const WebSocket = require('ws');

// Connect to the LLM WebSocket endpoint with authentication
const ws = new WebSocket('ws://localhost:8080/ws/llm?api_key=babelcom-secret-key');

ws.on('open', function open() {
    console.log('Connected to LLM WebSocket');
    
    // Example 1: Send system status update
    const systemStatusMessage = {
        "type": "system_status",
        "data": {
            "status": "Online",
            "uptime": "2h 15m",
            "memory_usage": 67.3,
            "cpu_usage": 82.1,
            "disk_usage": 45.7,
            "articles_count": 127,
            "generation_rate": 3.2,
            "queue_size": 5,
            "last_updated": new Date().toISOString()
        }
    };
    
    // Example 2: Send generation status update
    const generationStatusMessage = {
        "type": "generation_status",
        "data": {
            "current_task": "Generating article about quantum computing",
            "progress": 45.5,
            "current_word": "entanglement",
            "words_written": 1250,
            "total_words": 2750,
            "time_remaining": "15m 30s",
            "last_updated": new Date().toISOString()
        }
    };
    
    // Example 3: Send output log message
    const outputMessage = {
        "type": "output",
        "data": {
            "message": "Successfully generated section on quantum superposition",
            "type": "success",
            "timestamp": new Date().toISOString()
        }
    };
    
    // Example 4: Send current word update (for real-time word-by-word generation)
    const currentWordMessage = {
        "type": "current_word",
        "word": "quantum"
    };
    
    // Send messages with delays to simulate real-time updates
    setTimeout(() => {
        console.log('Sending system status...');
        ws.send(JSON.stringify(systemStatusMessage));
    }, 1000);
    
    setTimeout(() => {
        console.log('Sending generation status...');
        ws.send(JSON.stringify(generationStatusMessage));
    }, 2000);
    
    setTimeout(() => {
        console.log('Sending output message...');
        ws.send(JSON.stringify(outputMessage));
    }, 3000);
    
    setTimeout(() => {
        console.log('Sending current word...');
        ws.send(JSON.stringify(currentWordMessage));
    }, 4000);
    
    // Simulate ongoing updates
    let progress = 45.5;
    const progressInterval = setInterval(() => {
        progress += 2.5;
        if (progress > 100) {
            progress = 100;
            clearInterval(progressInterval);
        }
        
        const progressUpdate = {
            "type": "generation_status",
            "data": {
                "current_task": "Generating article about quantum computing",
                "progress": progress,
                "current_word": "processing",
                "words_written": Math.floor(1250 + (progress - 45.5) * 30),
                "total_words": 2750,
                "time_remaining": Math.max(0, Math.floor((100 - progress) * 0.3)) + "m",
                "last_updated": new Date().toISOString()
            }
        };
        
        ws.send(JSON.stringify(progressUpdate));
    }, 5000);
});

ws.on('message', function message(data) {
    console.log('Received:', data.toString());
});

ws.on('error', function error(err) {
    console.error('WebSocket error:', err);
});

ws.on('close', function close() {
    console.log('Disconnected from WebSocket');
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Closing connection...');
    ws.close();
    process.exit(0);
}); 