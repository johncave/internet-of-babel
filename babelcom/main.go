package main

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net/http"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

//go:embed static/*
var staticFiles embed.FS

// serveEmbeddedFile serves a file from the embedded filesystem
func serveEmbeddedFile(c *gin.Context, path string, contentType string) {
	content, err := staticFiles.ReadFile(path)
	if err != nil {
		c.String(http.StatusNotFound, "File not found")
		return
	}
	c.Data(http.StatusOK, contentType, content)
}

// Serve static files
func serveStatic(c *gin.Context) {
	serveEmbeddedFile(c, "static/index.html", "text/html")
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
	router.GET("/favicon.ico", func(c *gin.Context) {
		serveEmbeddedFile(c, "static/favicon.ico", "image/x-icon")
	})

	// Serve embedded static files
	staticFS, err := fs.Sub(staticFiles, "static")
	if err != nil {
		log.Fatal("Failed to create static filesystem:", err)
	}
	router.StaticFS("/static", http.FS(staticFS))

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
