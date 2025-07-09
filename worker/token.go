package main

import (
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var tokenConn *websocket.Conn
var tokenConnMutex sync.RWMutex
var tokenReconnectChan chan bool
var lastReconnectRequest time.Time
var reconnectCooldown = 10 * time.Second

// Token batching system
var tokenChannel chan string
var tokenWorkerStop chan bool
var tokenWorkerWg sync.WaitGroup

func init() {
	tokenReconnectChan = make(chan bool, 1)
	tokenChannel = make(chan string, 1000) // Buffer for tokens
	tokenWorkerStop = make(chan bool, 1)

	go tokenConnectionManager()
	go tokenWorker() // Start the token batching worker
}

// tokenWorker batches tokens and sends them efficiently
func tokenWorker() {
	tokenWorkerWg.Add(1)
	defer tokenWorkerWg.Done()

	ticker := time.NewTicker(100 * time.Millisecond) // Send batch every 100ms
	defer ticker.Stop()

	var tokens []string
	maxBatchSize := 50 // Maximum tokens per batch

	for {
		select {
		case token := <-tokenChannel:
			tokens = append(tokens, token)

			// Send immediately if we have a full batch
			if len(tokens) >= maxBatchSize {
				sendTokenBatch(tokens)
				tokens = tokens[:0] // Clear slice but keep capacity
			}

		case <-ticker.C:
			// Send any remaining tokens
			if len(tokens) > 0 {
				sendTokenBatch(tokens)
				tokens = tokens[:0]
			}

		case <-tokenWorkerStop:
			// Send any remaining tokens before stopping
			if len(tokens) > 0 {
				sendTokenBatch(tokens)
			}
			return
		}
	}
}

// sendTokenBatch sends multiple tokens as individual WebSocket messages (compatibility mode)
func sendTokenBatch(tokens []string) {
	if len(tokens) == 0 {
		return
	}

	tokenConnMutex.Lock()
	defer tokenConnMutex.Unlock()

	if tokenConn == nil {
		requestTokenReconnect()
		return
	}

	for _, token := range tokens {
		message := map[string]interface{}{
			"type":  "token",
			"token": token,
		}
		data, err := json.Marshal(message)
		if err != nil {
			log.Printf("Failed to marshal token: %v", err)
			continue
		}
		if err := tokenConn.WriteMessage(websocket.TextMessage, data); err != nil {
			log.Printf("Error writing token to websocket: %v", err)
			requestTokenReconnect()
			return
		}
	}
}

// tokenConnectionManager manages the token WebSocket connection with automatic retry
func tokenConnectionManager() {
	for {
		if err := connectTokenWebSocketWithRetry(); err != nil {
			log.Printf("Token WebSocket connection failed: %v", err)
			log.Printf("Retrying token WebSocket connection in 30 seconds...")
			time.Sleep(30 * time.Second)
			continue
		}

		// Monitor connection health and wait for reconnection signal
		select {
		case <-tokenReconnectChan:
			log.Printf("Token WebSocket reconnection requested")
			// Continue to the next iteration to reconnect
		case <-time.After(30 * time.Second):
			// Check connection health every 30 seconds
			if !isTokenConnectionHealthy() {
				log.Printf("Token WebSocket connection appears unhealthy, requesting reconnection")
				// Don't request reconnection here, just continue to next iteration
			}
		}
	}
}

// isTokenConnectionHealthy checks if the token WebSocket connection is still alive
func isTokenConnectionHealthy() bool {
	tokenConnMutex.Lock()
	defer tokenConnMutex.Unlock()

	if tokenConn == nil {
		return false
	}

	// Check if connection is closed by trying to get a writer
	writer, err := tokenConn.NextWriter(websocket.TextMessage)
	if err != nil {
		return false
	}
	if writer != nil {
		writer.Close()
	}

	return true
}

// connectTokenWebSocketWithRetry attempts to connect with exponential backoff
func connectTokenWebSocketWithRetry() error {
	delay := 5 * time.Second
	attempt := 0

	for {
		attempt++
		log.Printf("Attempting to connect to token WebSocket in %v (attempt %d)...", delay, attempt)
		time.Sleep(delay)

		// Close existing connection if any
		disconnectTokenWebSocket()

		// Try to connect
		if err := ConnectTokenWebSocket(WebSocketURL); err != nil {
			log.Printf("Token WebSocket connection attempt %d failed: %v", attempt, err)
			continue
		}

		log.Printf("Successfully connected to token WebSocket after %d attempts", attempt)
		return nil
	}
}

func SendReset() {
	tokenConnMutex.Lock()
	defer tokenConnMutex.Unlock()

	if tokenConn == nil {
		log.Printf("Reset - token websocket is nil, requesting reconnection")
		requestTokenReconnect()
		return
	}

	message := map[string]interface{}{
		"type": "reset",
	}

	data, err := json.Marshal(message)
	if err != nil {
		log.Printf("Failed to marshal reset message: %v", err)
		return
	}

	err = tokenConn.WriteMessage(websocket.TextMessage, data)
	if err != nil {
		log.Printf("Failed to send reset message: %v", err)
		requestTokenReconnect()
		return
	}

	//log.Println("Sent reset message to WebSocket")
}

// SendToken sends a single token to the batching channel
func SendToken(token string) {
	//return // Disable token sending for now
	//fmt.Print(token)

	select {
	case tokenChannel <- token:
		// Token sent to channel successfully
	default:
		// Channel is full, log warning but don't block
		log.Printf("Warning: token channel is full, dropping token")
	}
}

// ConnectTokenWebSocket connects to the token WebSocket
func ConnectTokenWebSocket(url string) error {
	var err error

	// Configure dialer with timeouts
	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
	}

	conn, _, err := dialer.Dial(url, nil)
	if err != nil {
		return fmt.Errorf("failed to connect to token WebSocket: %v", err)
	}

	// Configure connection settings
	conn.SetReadLimit(512)                                 // Limit message size
	conn.SetReadDeadline(time.Now().Add(60 * time.Second)) // Read timeout
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	tokenConnMutex.Lock()
	tokenConn = conn
	tokenConnMutex.Unlock()

	log.Printf("Connected to token WebSocket: %s", url)

	// Create context for ping ticker
	//pingTickerCtx, pingTickerCancel = context.WithCancel(context.Background())

	// Start ping ticker to keep connection alive
	// go func() {
	// 	ticker := time.NewTicker(30 * time.Second)
	// 	defer ticker.Stop()

	// 	for {
	// 		select {
	// 		case <-ticker.C:
	// 			tokenConnMutex.Lock()

	// 			// Safety check: if connection is nil, stop the ticker
	// 			if tokenConn == nil {
	// 				log.Printf("Ping ticker: connection is nil, stopping ticker")
	// 				tokenConnMutex.Unlock()
	// 				return
	// 			}

	// 			if err := tokenConn.WriteControl(websocket.PingMessage, []byte{}, time.Now().Add(10*time.Second)); err != nil {
	// 				log.Printf("Failed to send ping: %v", err)
	// 				tokenConnMutex.Unlock()
	// 				requestTokenReconnect()
	// 				return
	// 			}

	// 			tokenConnMutex.Unlock()
	// 			// case <-pingTickerCtx.Done():
	// 			// 	// Context was cancelled, stop the ticker
	// 			// 	log.Printf("Ping ticker: context cancelled, stopping ticker")
	// 			// 	return
	// 		}
	// 	}
	// }()

	return nil
}

// disconnectTokenWebSocket safely disconnects the token WebSocket
func disconnectTokenWebSocket() {
	tokenConnMutex.Lock()
	if tokenConn != nil {
		log.Printf("Disconnecting token WebSocket")
		tokenConn.Close()
		tokenConn = nil
	}
	tokenConnMutex.Unlock()

	// Cancel the ping ticker context to stop the goroutine
	// if pingTickerCancel != nil {
	// 	log.Printf("Cancelling ping ticker context")
	// 	pingTickerCancel()
	// 	pingTickerCancel = nil // Reset to prevent double-cancellation
	// }
}

// requestTokenReconnect signals the connection manager to reconnect
func requestTokenReconnect() {
	now := time.Now()
	if now.Sub(lastReconnectRequest) < reconnectCooldown {
		// Still in cooldown period, ignore this request
		return
	}

	log.Println("Requesting token WebSocket reconnection")

	lastReconnectRequest = now
	select {
	case tokenReconnectChan <- true:
		// Signal sent successfully
	default:
		// Channel is full, ignore
	}
}

// StopTokenWorker stops the token batching worker
func StopTokenWorker() {
	select {
	case tokenWorkerStop <- true:
	default:
	}
	tokenWorkerWg.Wait()
}
