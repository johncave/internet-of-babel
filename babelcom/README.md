# Babelcom Backend

A Go-based WebSocket backend for the Babelcom system monitor that provides real-time status updates and generation progress.

## Features

- **WebSocket Endpoints**: Two WebSocket endpoints for different purposes
- **Real-time Broadcasting**: Broadcast system status and generation updates to all connected clients
- **LLM Integration**: Authenticated endpoint for LLM systems to send updates
- **Output Logging**: Maintains a log of system messages with timestamps
- **Health Monitoring**: Health check endpoint for monitoring

## WebSocket Endpoints

### 1. Broadcast Endpoint (`/ws/broadcast`)
- **Purpose**: For clients (like the system monitor) to receive real-time updates
- **Authentication**: None required
- **Usage**: Connect to receive system status, generation progress, and output messages

### 2. LLM Endpoint (`/ws/llm`)
- **Purpose**: For LLM systems to send status updates and generation progress
- **Authentication**: API key required (configurable via `BABELCOM_API_KEY` environment variable)
- **Usage**: Send system status, generation status, current word, and output messages

## Message Types

### From LLM to Backend:
```json
{
  "type": "system_status",
  "data": {
    "status": "Online",
    "uptime": "2h 15m",
    "memory_usage": 65.2,
    "cpu_usage": 78.5,
    "disk_usage": 32.1,
    "articles_count": 150,
    "generation_rate": 3.2,
    "queue_size": 5
  }
}
```

```json
{
  "type": "generation_status",
  "data": {
    "current_task": "Generating article: 'Quantum Computing Fundamentals'",
    "progress": 45.2,
    "current_word": "",
    "words_written": 2260,
    "total_words": 5000,
    "time_remaining": "15 minutes"
  }
}
```

```json
{
  "type": "current_word",
  "data": {
    "word": "quantum"
  }
}
```

```json
{
  "type": "output",
  "data": {
    "message": "Processing generation queue...",
    "type": "info"
  }
}
```

### From Backend to Clients:
```json
{
  "type": "initial_data",
  "data": {
    "system_status": {...},
    "generation_status": {...},
    "output_log": [...]
  }
}
```

```json
{
  "type": "system_status",
  "data": {...}
}
```

```json
{
  "type": "generation_status",
  "data": {...}
}
```

```json
{
  "type": "current_word",
  "data": {
    "word": "quantum",
    "timestamp": "2024-01-01T12:00:00Z"
  }
}
```

```json
{
  "type": "output",
  "data": {
    "timestamp": "2024-01-01T12:00:00Z",
    "message": "Processing generation queue...",
    "type": "info"
  }
}
```

## Setup and Running

### Prerequisites
- Go 1.21 or later
- Node.js (for test client)

### Installation

1. **Install Go dependencies:**
   ```bash
   cd backend
   go mod tidy
   ```

2. **Install Node.js dependencies (for test client):**
   ```bash
   npm install
   ```

### Running the Backend

1. **Start the backend server:**
   ```bash
   go run main.go
   ```
   or
   ```bash
   npm start
   ```

2. **Test with the LLM client:**
   ```bash
   npm run test-client
   ```

### Building

```bash
go build -o babelcom-backend main.go
```

## API Endpoints

- `GET /` - Serve the frontend
- `GET /ws/broadcast` - WebSocket for receiving updates
- `GET /ws/llm?api_key=<your-api-key>` - WebSocket for LLM updates
- `GET /health` - Health check endpoint

## Configuration

### Environment Variables
- `PORT` - Server port (default: 8080)
- `BABELCOM_API_KEY` - API key for LLM authentication (default: "babelcom-secret-key")

### Security Notes
- The API key is configurable via the `BABELCOM_API_KEY` environment variable
- Default key is "babelcom-secret-key" for development
- In production, set a strong, unique API key using environment variables
- CORS is configured to allow all origins (restrict in production)

### Setting the API Key

**Local Development:**
```bash
export BABELCOM_API_KEY="your-secure-api-key-here"
go run main.go
```

**Docker:**
```bash
docker run -e BABELCOM_API_KEY="your-secure-api-key-here" -p 8080:8080 babelcom
```

**Kubernetes:**
The API key is configured via a Kubernetes secret. Update the secret in `kubernetes/babelcom.yaml`:
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: babelcom-secret
  namespace: internet-of-babel
type: Opaque
data:
  api-key: <base64-encoded-api-key>
```

## Integration with LLM Systems

To integrate with your LLM system:

1. **Connect to the LLM WebSocket:**
   ```javascript
   const ws = new WebSocket('ws://localhost:8080/ws/llm?api_key=your-api-key-here');
   ```

2. **Send system status updates:**
   ```javascript
   ws.send(JSON.stringify({
     type: 'system_status',
     data: {
       status: 'Online',
       uptime: '2h 15m',
       memory_usage: 65.2,
       cpu_usage: 78.5,
       disk_usage: 32.1,
       articles_count: 150,
       generation_rate: 3.2,
       queue_size: 5
     }
   }));
   ```

3. **Send generation progress:**
   ```javascript
   ws.send(JSON.stringify({
     type: 'generation_status',
     data: {
       current_task: 'Generating article: "Your Article Title"',
       progress: 45.2,
       current_word: '',
       words_written: 2260,
       total_words: 5000,
       time_remaining: '15 minutes'
     }
   }));
   ```

4. **Send current word updates:**
   ```javascript
   ws.send(JSON.stringify({
     type: 'current_word',
     data: {
       word: 'current'
     }
   }));
   ```

5. **Send output messages:**
   ```javascript
   ws.send(JSON.stringify({
     type: 'output',
     data: {
       message: 'Processing generation queue...',
       type: 'info' // info, success, warning, error
     }
   }));
   ```

## Development

The backend is built with:
- **Gin**: HTTP framework
- **Gorilla WebSocket**: WebSocket implementation
- **Gin CORS**: CORS middleware

The test client demonstrates all the message types and can be used to test the system monitor integration. 