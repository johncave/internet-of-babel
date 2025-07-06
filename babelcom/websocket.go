package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"sync"

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
	mu                   sync.RWMutex
	upgrader             websocket.Upgrader
	apiKey               string
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
	}

	s.mu.Lock()
	delete(s.llmConnections, connection)
	s.mu.Unlock()

	conn.Close()
	log.Printf("LLM client disconnected. Total LLM connections: %d", len(s.llmConnections))
}
