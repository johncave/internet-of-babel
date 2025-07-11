package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"sync"

	"encoding/json"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// WebSocket connection wrapper
type Connection struct {
	conn     *websocket.Conn
	connType string // "broadcast" or "llm"
	mu       sync.Mutex
}

// Server holds all the server state
type Server struct {
	broadcastConnections map[*Connection]bool
	llmConnections       map[*Connection]bool
	radioConnections     map[*Connection]bool
	upstreamRadioConn    *websocket.Conn
	lastRadioMessage     []byte
	mu                   sync.RWMutex
	upgrader             websocket.Upgrader
	apiKey               string
	latestSystemStatus   []byte
}

// NewServer creates a new server instance
func NewServer() *Server {
	// Get API key from environment variable, fallback to default
	apiKey := os.Getenv("BABELCOM_API_KEY")
	if apiKey == "" {
		apiKey = "babelcom-secret-key" // Default fallback
		log.Printf("No BABELCOM_API_KEY environment variable set, using default key")
	} else {
		log.Printf("Using API key from BABELCOM_API_KEY environment variable")
	}

	return &Server{
		broadcastConnections: make(map[*Connection]bool),
		llmConnections:       make(map[*Connection]bool),
		radioConnections:     make(map[*Connection]bool),
		apiKey:               apiKey,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				return true // Allow all origins for development
			},
		},
	}
}

// Broadcast message to all broadcast connections
func (s *Server) broadcast(message []byte) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for conn := range s.broadcastConnections {
		conn.mu.Lock()
		err := conn.conn.WriteMessage(websocket.TextMessage, message)
		conn.mu.Unlock()
		if err != nil {
			log.Printf("Error broadcasting message: %v", err)
			delete(s.broadcastConnections, conn)
		}
	}
}

// Broadcast message to all radio connections
func (s *Server) broadcastRadio(message []byte) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for conn := range s.radioConnections {
		conn.mu.Lock()
		err := conn.conn.WriteMessage(websocket.TextMessage, message)
		conn.mu.Unlock()
		if err != nil {
			log.Printf("Error broadcasting radio message: %v", err)
			delete(s.radioConnections, conn)
		}
	}
}

// Handle broadcast WebSocket connections
func (s *Server) handleBroadcastWebSocket(c *gin.Context) {
	conn, err := s.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("Error upgrading connection: %v", err)
		return
	}

	connection := &Connection{
		conn:     conn,
		connType: "broadcast",
	}

	s.mu.Lock()
	s.broadcastConnections[connection] = true
	s.mu.Unlock()

	s.mu.RLock()
	if s.latestSystemStatus != nil {
		connection.mu.Lock()
		err := connection.conn.WriteMessage(websocket.TextMessage, s.latestSystemStatus)
		connection.mu.Unlock()
		if err != nil {
			log.Printf("Error sending latest system status: %v", err)
		}
	}
	s.mu.RUnlock()

	log.Printf("Broadcast client connected. Total connections: %d", len(s.broadcastConnections))

	// Handle incoming messages (mostly ping/pong)
	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			log.Printf("Broadcast client disconnected: %v", err)
			break
		}

		// Handle ping messages
		if string(message) == "ping" {
			connection.mu.Lock()
			err := connection.conn.WriteMessage(websocket.TextMessage, []byte("pong"))
			connection.mu.Unlock()
			if err != nil {
				log.Printf("Error sending pong: %v", err)
				break
			}
		}
	}

	s.mu.Lock()
	delete(s.broadcastConnections, connection)
	s.mu.Unlock()

	conn.Close()
	log.Printf("Broadcast client disconnected. Total connections: %d", len(s.broadcastConnections))
}

// Handle LLM WebSocket connections (authenticated)
func (s *Server) handleLLMWebSocket(c *gin.Context) {
	log.Printf("LLM WebSocket connection attempt from %s", c.ClientIP())

	// Simple authentication (in production, use proper auth)
	apiKey := c.Query("api_key")
	log.Printf("LLM WebSocket API key received: %s", apiKey)

	if apiKey != s.apiKey {
		log.Printf("LLM WebSocket authentication failed: invalid API key")
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid API key"})
		return
	}

	conn, err := s.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("Error upgrading LLM connection: %v", err)
		return
	}

	connection := &Connection{
		conn:     conn,
		connType: "llm",
	}

	s.mu.Lock()
	s.llmConnections[connection] = true
	s.mu.Unlock()

	log.Printf("LLM client connected. Total LLM connections: %d", len(s.llmConnections))

	// Handle incoming messages from LLM - just forward them to broadcast
	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			log.Printf("LLM client disconnected: %v", err)
			break
		}

		//log.Printf("LLM WebSocket received message: %s", string(message))
		fmt.Println(string(message))

		// Simply broadcast the raw message to all broadcast clients
		s.broadcast(message)

		// Parse message and check for system_status
		var msg map[string]interface{}
		if err := json.Unmarshal(message, &msg); err == nil {
			if msgType, ok := msg["type"].(string); ok && msgType == "system_status" {
				s.mu.Lock()
				s.latestSystemStatus = message
				s.mu.Unlock()
			}
		}
	}

	s.mu.Lock()
	delete(s.llmConnections, connection)
	s.mu.Unlock()

	conn.Close()
	log.Printf("LLM client disconnected. Total LLM connections: %d", len(s.llmConnections))
}

// Connect to upstream radio WebSocket
func (s *Server) connectUpstreamRadio(upstreamURL string) error {
	if s.upstreamRadioConn != nil {
		s.upstreamRadioConn.Close()
	}

	conn, _, err := websocket.DefaultDialer.Dial(upstreamURL, nil)
	if err != nil {
		return fmt.Errorf("failed to connect to upstream radio: %v", err)
	}

	s.upstreamRadioConn = conn
	log.Printf("Connected to upstream radio WebSocket: %s", upstreamURL)

	// Send subscription message
	subscriptionMsg := `{"subs":{"station:night":{"recover":true}}}`
	err = conn.WriteMessage(websocket.TextMessage, []byte(subscriptionMsg))
	if err != nil {
		log.Printf("Failed to send subscription message: %v", err)
	} else {
		log.Printf("Sent subscription message to upstream radio")
	}

	// Start listening for messages from upstream
	go func() {
		for {
			_, message, err := conn.ReadMessage()
			if err != nil {
				log.Printf("Upstream radio connection closed: %v", err)
				s.upstreamRadioConn = nil
				break
			}

			// Store the last message
			s.mu.Lock()
			if len(message) > 4 {
				s.lastRadioMessage = message
			}
			s.mu.Unlock()

			// Rebroadcast to all radio clients
			s.broadcastRadio(message)
		}
	}()

	return nil
}

// Handle radio WebSocket connections
func (s *Server) handleRadioWebSocket(c *gin.Context) {
	conn, err := s.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("Error upgrading radio connection: %v", err)
		return
	}

	connection := &Connection{
		conn:     conn,
		connType: "radio",
	}

	s.mu.Lock()
	s.radioConnections[connection] = true
	s.mu.Unlock()

	// Send the last message if available
	s.mu.RLock()
	if s.lastRadioMessage != nil {
		connection.mu.Lock()
		err := connection.conn.WriteMessage(websocket.TextMessage, s.lastRadioMessage)
		connection.mu.Unlock()
		if err != nil {
			log.Printf("Error sending last radio message: %v", err)
		} else {
			log.Printf("Sent last radio message to new client")
		}
	}
	s.mu.RUnlock()

	log.Printf("Radio client connected. Total radio connections: %d", len(s.radioConnections))

	// Handle incoming messages from radio clients
	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			log.Printf("Radio client disconnected: %v", err)
			break
		}

		// Forward messages to upstream if connected
		if s.upstreamRadioConn != nil {
			err := s.upstreamRadioConn.WriteMessage(websocket.TextMessage, message)
			if err != nil {
				log.Printf("Error forwarding message to upstream radio: %v", err)
			}
		}
	}

	s.mu.Lock()
	delete(s.radioConnections, connection)
	s.mu.Unlock()

	conn.Close()
	log.Printf("Radio client disconnected. Total radio connections: %d", len(s.radioConnections))
}
