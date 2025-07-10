package main

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"

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
	// Check if we should serve from disk
	if os.Getenv("BABELCOM_USE_DISK_STATIC") == "true" {
		staticPath := os.Getenv("BABELCOM_STATIC_PATH")
		if staticPath == "" {
			staticPath = "./static"
		}

		filePath := filepath.Join(staticPath, "index.html")
		if _, err := os.Stat(filePath); err == nil {
			c.File(filePath)
			return
		}
		// Fall back to embedded if file doesn't exist
	}

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
		if os.Getenv("BABELCOM_USE_DISK_STATIC") == "true" {
			staticPath := os.Getenv("BABELCOM_STATIC_PATH")
			if staticPath == "" {
				staticPath = "./static"
			}

			filePath := filepath.Join(staticPath, "favicon.ico")
			if _, err := os.Stat(filePath); err == nil {
				c.File(filePath)
				return
			}
		}
		serveEmbeddedFile(c, "static/favicon.ico", "image/x-icon")
	})

	// Serve static files
	if os.Getenv("BABELCOM_USE_DISK_STATIC") == "true" {
		staticPath := os.Getenv("BABELCOM_STATIC_PATH")
		if staticPath == "" {
			staticPath = "./static"
		}

		// Check if static directory exists
		if _, err := os.Stat(staticPath); err == nil {
			log.Printf("Serving static files from disk: %s", staticPath)
			router.Static("/static", staticPath)
		} else {
			log.Printf("Static directory not found at %s, falling back to embedded files", staticPath)
			// Fall back to embedded files
			staticFS, err := fs.Sub(staticFiles, "static")
			if err != nil {
				log.Fatal("Failed to create static filesystem:", err)
			}
			router.StaticFS("/static", http.FS(staticFS))
		}
	} else {
		// Serve embedded static files
		staticFS, err := fs.Sub(staticFiles, "static")
		if err != nil {
			log.Fatal("Failed to create static filesystem:", err)
		}
		router.StaticFS("/static", http.FS(staticFS))
	}

	router.GET("/ws", server.handleBroadcastWebSocket)
	router.GET("/ws/llm", server.handleLLMWebSocket)

	// Health check endpoint
	router.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status":                "healthy",
			"broadcast_connections": len(server.broadcastConnections),
			"llm_connections":       len(server.llmConnections),
			"static_mode":           getStaticMode(),
		})
	})

	// Start server
	port := ":8088"
	log.Printf("Starting server on port %s", port)
	log.Printf("Static files mode: %s", getStaticMode())
	log.Printf("Broadcast WebSocket: ws://localhost%s/ws/broadcast", port)
	log.Printf("LLM WebSocket: ws://localhost%s/ws/llm?api_key=<your-api-key>", port)
	log.Printf("API key can be configured via BABELCOM_API_KEY environment variable")

	if err := router.Run(port); err != nil {
		log.Fatal("Failed to start server:", err)
	}
}

// getStaticMode returns a string describing the current static file serving mode
func getStaticMode() string {
	if os.Getenv("BABELCOM_USE_DISK_STATIC") == "true" {
		staticPath := os.Getenv("BABELCOM_STATIC_PATH")
		if staticPath == "" {
			staticPath = "./static"
		}
		return fmt.Sprintf("disk (%s)", staticPath)
	}
	return "embedded"
}
