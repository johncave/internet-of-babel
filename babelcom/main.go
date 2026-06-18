package babelcom

import (
	"crypto/md5"
	"embed"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"

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
		c.String(http.StatusNotFound, "404: File Not Found")
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

// serveDiskFile serves a file from disk with ETag support.
// Disk mode is dev-only, so we force revalidation every request — the ETag
// still gives cheap 304s when files haven't changed.
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
	c.Header("Cache-Control", "no-cache")
	c.Data(http.StatusOK, contentType, content)
}

// getContentTypeFromExtension determines the MIME type based on file extension
func getContentTypeFromExtension(filePath string) string {
	switch filepath.Ext(filePath) {
	case ".html":
		return "text/html"
	case ".css":
		return "text/css"
	case ".js", ".mjs":
		return "application/javascript"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".svg":
		return "image/svg+xml"
	case ".ico":
		return "image/x-icon"
	case ".webp":
		return "image/webp"
	case ".mp4":
		return "video/mp4"
	case ".woff":
		return "font/woff"
	case ".woff2":
		return "font/woff2"
	case ".ttf":
		return "font/ttf"
	case ".eot":
		return "application/vnd.ms-fontobject"
	default:
		return "application/octet-stream"
	}
}

// fileExists reports whether path exists and is statable.
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
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

		contentType := getContentTypeFromExtension(filePath)
		serveDiskFile(c, filePath, contentType)
	}
}

// Setup configures the passed gin engine with babelcom's middleware and routes.
// Creates the WebSocket server, Clippy, and connects to the upstream radio.
func Setup(router *gin.Engine) error {
	log.Println("babelcom: starting WebSocket message bus")
	server := NewServer()
	server.clippy = NewClippy(server)

	// Coordinated wallpaper "mood": one rotation, server-side, so every
	// Babelcom-mode desktop shows the same wallpaper.
	server.moods = newMoodEngine(server)
	go server.moods.run()

	upstreamRadioURL := os.Getenv("BABELCOM_UPSTREAM_RADIO_URL")
	if upstreamRadioURL == "" {
		upstreamRadioURL = "wss://radio.johncave.co.nz/api/live/nowplaying/websocket"
	}
	if err := server.connectUpstreamRadio(upstreamRadioURL); err != nil {
		log.Printf("babelcom: upstream radio connect failed: %v", err)
	}

	router.Use(gin.Logger())
	router.Use(gin.Recovery())
	// No global compression middleware: embedded assets are precompressed once
	// at startup (see assets.go) and served directly; disk/dev mode serves
	// uncompressed for simplicity. This avoids re-gzipping already-compressed
	// images/video on every request.

	diskPath := os.Getenv("BABELCOM_STATIC_PATH")
	if diskPath == "" {
		diskPath = "./static"
	}
	diskAvailable := false
	if os.Getenv("BABELCOM_USE_DISK_STATIC") == "true" {
		if _, err := os.Stat(diskPath); err == nil {
			diskAvailable = true
		} else {
			log.Printf("babelcom: static dir not found at %s, falling back to embedded", diskPath)
		}
	}

	if diskAvailable {
		// Dev: serve from disk for hot-reload, no caching; embed is the fallback.
		log.Printf("babelcom: serving static from disk: %s", diskPath)
		router.GET("/", func(c *gin.Context) {
			if f := filepath.Join(diskPath, "index.html"); fileExists(f) {
				serveDiskFile(c, f, "text/html")
				return
			}
			serveEmbeddedFile(c, "static/index.html", "text/html")
		})
		router.GET("/favicon.ico", func(c *gin.Context) {
			if f := filepath.Join(diskPath, "favicon.ico"); fileExists(f) {
				serveDiskFile(c, f, "image/x-icon")
				return
			}
			serveEmbeddedFile(c, "static/favicon.ico", "image/x-icon")
		})
		router.GET("/static/*filepath", customStaticHandler(diskPath))
	} else {
		// Prod: precompressed, content-hashed, immutable embedded assets. The
		// HTML entry is no-cache (revalidated every load) so deploys appear
		// instantly while its ?v=-busted assets stay immutable for a year.
		if err := buildAssetCache(); err != nil {
			return fmt.Errorf("babelcom: building asset cache: %w", err)
		}
		router.GET("/", func(c *gin.Context) { serveAsset(c, "static/index.html", false) })
		router.GET("/favicon.ico", func(c *gin.Context) { serveAsset(c, "static/favicon.ico", true) })
		router.GET("/static/*filepath", func(c *gin.Context) {
			serveAsset(c, "static"+c.Param("filepath"), true)
		})
	}

	router.GET("/ws", server.handleBroadcastWebSocket)
	router.GET("/ws/llm", server.handleLLMWebSocket)

	router.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status":                "healthy",
			"broadcast_connections": len(server.broadcastConnections),
			"llm_connections":       len(server.llmConnections),
			"static_mode":           getStaticMode(),
		})
	})

	log.Printf("babelcom: static mode=%s, upstream radio=%s", getStaticMode(), upstreamRadioURL)
	return nil
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
