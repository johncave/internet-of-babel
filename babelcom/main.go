package main

import (
	"fmt"
	"log"
	"net/http"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

// Serve static files
func serveStatic(c *gin.Context) {
	c.File("./static/index.html")
}

func main() {
	fmt.Println("Starting Babelcom WebSocket Message Bus")
	server := NewServer()

	// Setup Gin router
	router := gin.Default()

	// CORS configuration
	router.Use(cors.New(cors.Config{
		AllowOrigins:     []string{"*"},
		AllowMethods:     []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Accept", "Authorization"},
		ExposeHeaders:    []string{"Content-Length"},
		AllowCredentials: true,
	}))

	// Routes
	router.GET("/", serveStatic)
	router.Static("/static", "./static")
	router.GET("/ws", server.handleBroadcastWebSocket)
	router.GET("/ws/llm", server.handleLLMWebSocket)

	// Health check endpoint
	router.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status":                "healthy",
			"broadcast_connections": len(server.broadcastConnections),
			"llm_connections":       len(server.llmConnections),
		})
	})

	// Start server
	port := ":8080"
	log.Printf("Starting server on port %s", port)
	log.Printf("Broadcast WebSocket: ws://localhost%s/ws/broadcast", port)
	log.Printf("LLM WebSocket: ws://localhost%s/ws/llm?api_key=babelcom-secret-key", port)

	if err := router.Run(port); err != nil {
		log.Fatal("Failed to start server:", err)
	}
}
