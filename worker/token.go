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

func init() {
	tokenReconnectChan = make(chan bool, 1)
	go tokenConnectionManager()
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
	tokenConnMutex.RLock()
	conn := tokenConn
	tokenConnMutex.RUnlock()

	if conn == nil {
		return false
	}

	// Try to send a ping to check if connection is alive
	err := conn.WriteControl(websocket.PingMessage, []byte{}, time.Now().Add(5*time.Second))
	return err == nil
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
	tokenConnMutex.RLock()
	conn := tokenConn
	tokenConnMutex.RUnlock()

	if conn == nil {
		//log.Printf("Token WebSocket not connected, requesting reconnection")
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

	err = conn.WriteMessage(websocket.TextMessage, data)
	if err != nil {
		log.Printf("Failed to send reset message: %v", err)
		requestTokenReconnect()
		return
	}

	//log.Println("Sent reset message to WebSocket")
}

// SendToken sends a single token to the WebSocket
func SendToken(token string) {
	//return // Disable token sending for now

	tokenConnMutex.RLock()
	conn := tokenConn
	tokenConnMutex.RUnlock()

	if conn == nil {
		//log.Printf("Token WebSocket not connected, requesting reconnection")
		requestTokenReconnect()
		return
	}

	message := map[string]interface{}{
		"type":  "token",
		"token": token,
	}

	data, err := json.Marshal(message)
	if err != nil {
		log.Printf("Failed to marshal token: %v", err)
		return
	}

	err = conn.WriteMessage(websocket.TextMessage, data)
	if err != nil {
		log.Printf("Failed to send token: %v", err)
		requestTokenReconnect()
		return
	}

	//log.Printf("Sent token: %s", token)
}

// ConnectTokenWebSocket connects to the token WebSocket
func ConnectTokenWebSocket(url string) error {
	var err error
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		return fmt.Errorf("failed to connect to token WebSocket: %v", err)
	}

	tokenConnMutex.Lock()
	tokenConn = conn
	tokenConnMutex.Unlock()

	log.Printf("Connected to token WebSocket: %s", url)
	return nil
}

// disconnectTokenWebSocket safely disconnects the token WebSocket
func disconnectTokenWebSocket() {
	tokenConnMutex.Lock()
	if tokenConn != nil {
		tokenConn.Close()
		tokenConn = nil
	}
	tokenConnMutex.Unlock()
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
