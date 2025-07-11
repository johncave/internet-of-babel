package main

import (
	"crypto/md5"
	"embed"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"github.com/gin-contrib/gzip"
	"github.com/gin-gonic/gin"
)

//go:embed static/*
var staticFiles embed.FS

// calculateETag generates an ETag for the given content
func calculateETag(content []byte) string {
	hash := md5.Sum(content)
	return fmt.Sprintf(`%x`, hash)
}

// serveEmbeddedFile serves a file from the embedded filesystem with ETag support
func serveEmbeddedFile(c *gin.Context, path string, contentType string) {
	content, err := staticFiles.ReadFile(path)
	if err != nil {
		c.String(http.StatusNotFound, "File not found")
		return
	}

	etag := calculateETag(content)

	// Check if client has the latest version
	if match := c.GetHeader("If-None-Match"); match == etag {
		c.Status(http.StatusNotModified)
		return
	}

	c.Header("ETag", etag)
	c.Header("Cache-Control", "public, max-age=3600, must-revalidate") // Cache for 1 hour
	c.Data(http.StatusOK, contentType, content)
}

// serveDiskFile serves a file from disk with ETag support
func serveDiskFile(c *gin.Context, filePath string, contentType string) {
	content, err := os.ReadFile(filePath)
	if err != nil {
		c.String(http.StatusNotFound, "File not found")
		return
	}

	etag := calculateETag(content)

	// Check if client has the latest version
	if match := c.GetHeader("If-None-Match"); match == etag {
		c.Status(http.StatusNotModified)
		return
	}

	c.Header("ETag", etag)
	c.Header("Cache-Control", "public, max-age=3600, must-revalidate") // Cache for 1 hour
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
			serveDiskFile(c, filePath, "text/html")
			return
		}
		// Fall back to embedded if file doesn't exist
	}

	serveEmbeddedFile(c, "static/index.html", "text/html")
}

// customStaticHandler handles static files with ETag support
func customStaticHandler(staticPath string) gin.HandlerFunc {
	return func(c *gin.Context) {
		filePath := filepath.Join(staticPath, c.Param("filepath"))

		// Check if file exists
		if _, err := os.Stat(filePath); err != nil {
			c.String(http.StatusNotFound, "File not found")
			return
		}

		// Determine content type based on file extension
		contentType := "application/octet-stream"
		switch filepath.Ext(filePath) {
		case ".html":
			contentType = "text/html"
		case ".css":
			contentType = "text/css"
		case ".js":
			contentType = "application/javascript"
		case ".png":
			contentType = "image/png"
		case ".jpg", ".jpeg":
			contentType = "image/jpeg"
		case ".gif":
			contentType = "image/gif"
		case ".svg":
			contentType = "image/svg+xml"
		case ".ico":
			contentType = "image/x-icon"
		case ".webp":
			contentType = "image/webp"
		case ".mp4":
			contentType = "video/mp4"
		case ".woff":
			contentType = "font/woff"
		case ".woff2":
			contentType = "font/woff2"
		case ".ttf":
			contentType = "font/ttf"
		case ".eot":
			contentType = "application/vnd.ms-fontobject"
		}

		serveDiskFile(c, filePath, contentType)
	}
}

// customEmbeddedStaticHandler handles embedded static files with ETag support
func customEmbeddedStaticHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		filePath := "static/" + c.Param("filepath")
		serveEmbeddedFile(c, filePath, "application/octet-stream")
	}
}

func main() {
	fmt.Println("Starting Babelcom WebSocket Message Bus")
	server := NewServer()

	// Setup Gin router
	router := gin.Default()

	// CORS configuration
	// router.Use(cors.New(cors.Config{
	// 	AllowOrigins:     []string{"*"},
	// 	AllowMethods:     []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
	// 	AllowHeaders:     []string{"Origin", "Content-Type", "Accept", "Authorization"},
	// 	ExposeHeaders:    []string{"Content-Length"},
	// 	AllowCredentials: true,
	// }))

	router.Use(gzip.Gzip(gzip.DefaultCompression))

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
				serveDiskFile(c, filePath, "image/x-icon")
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
			router.GET("/static/*filepath", customStaticHandler(staticPath))
		} else {
			log.Printf("Static directory not found at %s, falling back to embedded files", staticPath)
			// Fall back to embedded files
			router.GET("/static/*filepath", customEmbeddedStaticHandler())
		}
	} else {
		// Serve embedded static files
		router.GET("/static/*filepath", customEmbeddedStaticHandler())
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
