package main

import (
	"embed"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-contrib/gzip"
	"github.com/gin-gonic/gin"
)

var articlesDir = "../worker/articles"

//go:embed templates
var templates embed.FS

//go:embed static
var staticFiles embed.FS

// UseEmbeddedStatic controls whether to serve static files from embedded FS or disk
var UseEmbeddedStatic = true

// API key for worker uploads
var apiKey = ""

func getTotalArticleCount(articlesDir string) int {
	articles, err := os.ReadDir(articlesDir)
	if err != nil {
		return 0
	}

	count := 0
	for _, article := range articles {
		if !article.IsDir() && strings.HasSuffix(article.Name(), ".md") {
			count++
		}
	}
	return count
}

// getContentType determines the appropriate content type based on file extension
func getContentType(filePath string) string {
	ext := strings.ToLower(filepath.Ext(filePath))
	switch ext {
	case ".css":
		return "text/css"
	case ".js":
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
	case ".woff":
		return "font/woff"
	case ".woff2":
		return "font/woff2"
	case ".ttf":
		return "font/ttf"
	case ".eot":
		return "application/vnd.ms-fontobject"
	default:
		return "text/plain"
	}
}

// faviconHandler serves the favicon from the embedded static directory
func faviconHandler(c *gin.Context) {
	if UseEmbeddedStatic {
		// Try to read the favicon from the embedded filesystem
		content, err := staticFiles.ReadFile("static/favicon.ico")
		if err != nil {
			c.Status(http.StatusNotFound)
			return
		}

		c.Header("Content-Type", "image/x-icon")
		c.Header("Cache-Control", "public, max-age=86400") // Cache for 24 hours
		c.Data(http.StatusOK, "image/x-icon", content)
		return
	}

	// Serve from disk
	filePath := "static/favicon.ico"
	content, err := os.ReadFile(filePath)
	if err != nil {
		c.Status(http.StatusNotFound)
		return
	}

	c.Header("Content-Type", "image/x-icon")
	c.Header("Cache-Control", "public, max-age=86400") // Cache for 24 hours
	c.Data(http.StatusOK, "image/x-icon", content)
}

// staticHandler serves static files from either disk or embedded filesystem
func staticHandler(c *gin.Context) {
	// Get the file path from the URL
	filePath := c.Param("filepath")

	if filePath == "" {
		c.Status(http.StatusNotFound)
		return
	}

	// Remove leading slash if present
	filePath = strings.TrimPrefix(filePath, "/")

	if UseEmbeddedStatic {
		// Serve from embedded filesystem
		fullPath := "static/" + filePath

		// Try to read the file from the embedded filesystem
		content, err := staticFiles.ReadFile(fullPath)
		if err != nil {
			c.Status(http.StatusNotFound)
			return
		}

		contentType := getContentType(filePath)
		c.Header("Content-Type", contentType)
		c.Data(http.StatusOK, contentType, content)
		return
	}

	// Serve from disk
	diskPath := filepath.Join("static", filePath)

	// Security check: ensure the path is within the static directory
	absPath, err := filepath.Abs(diskPath)
	if err != nil {
		c.Status(http.StatusBadRequest)
		return
	}

	staticDir, err := filepath.Abs("static")
	if err != nil {
		c.Status(http.StatusInternalServerError)
		return
	}

	if !strings.HasPrefix(absPath, staticDir) {
		c.Status(http.StatusForbidden)
		return
	}

	content, err := os.ReadFile(diskPath)
	if err != nil {
		c.Status(http.StatusNotFound)
		return
	}

	contentType := getContentType(filePath)
	c.Header("Content-Type", contentType)
	c.Data(http.StatusOK, contentType, content)
}

func main() {
	// Check if ARTICLES_DIR environment variable exists
	envArticlesDir := os.Getenv("ARTICLES_DIR")
	if envArticlesDir != "" {
		articlesDir = envArticlesDir
	}

	// Check if USE_EMBEDDED_STATIC environment variable exists
	// Set to "false" to serve static files from disk instead of embedded FS
	useEmbedded := os.Getenv("USE_EMBEDDED_STATIC")
	if useEmbedded == "false" {
		UseEmbeddedStatic = false
		fmt.Println("Static files will be served from disk (USE_EMBEDDED_STATIC=false)")
	} else {
		UseEmbeddedStatic = true
		fmt.Println("Static files will be served from embedded filesystem")
	}

	// Initialize API key from environment variable
	apiKey = os.Getenv("LIBRARIAN_API_KEY")
	if apiKey == "" {
		fmt.Println("Warning: LIBRARIAN_API_KEY not set, upload endpoint will be disabled")
	} else {
		fmt.Println("API key loaded for upload endpoint")
	}

	// Check if articles directory exists
	if _, err := os.Stat(articlesDir); os.IsNotExist(err) {
		log.Fatal("Articles directory not found. Please run the article generator first.")
	}

	// Set Gin to release mode for production
	gin.SetMode(gin.ReleaseMode)

	// Create Gin router
	r := gin.New()

	// Add logging middleware
	r.Use(gin.LoggerWithFormatter(func(param gin.LogFormatterParams) string {
		timestamp := param.TimeStamp.Format("02/Jan/2006:15:04:05 -0700")
		clientIP := param.ClientIP
		userAgent := param.Request.UserAgent()
		if userAgent == "" {
			userAgent = "-"
		}
		referer := param.Request.Header.Get("Referer")
		if referer == "" {
			referer = "-"
		}
		return fmt.Sprintf(`%s - - [%s] "%s %s %s" %d %d "%s" "%s" %.3f`+"\n",
			clientIP,
			timestamp,
			param.Method,
			param.Path,
			param.Request.Proto,
			param.StatusCode,
			param.BodySize,
			referer,
			userAgent,
			param.Latency.Seconds(),
		)
	}))

	// Add recovery middleware
	r.Use(gin.Recovery())

	r.Use(gzip.Gzip(gzip.DefaultCompression))

	// Static file routes
	r.GET("/static/*filepath", staticHandler)
	r.GET("/favicon.ico", faviconHandler)

	// API routes
	r.POST("/api/upload", uploadArticleHandler)

	// Main routes
	r.GET("/", indexHandler)
	r.GET("/all/:page", allArticlesHandler)
	r.GET("/random", randomArticleHandler)
	r.GET("/:article", articleHandler)

	port := ":8080"
	fmt.Printf("Starting server on http://localhost%s\n", port)
	fmt.Println("Press Ctrl+C to stop the server")

	log.Fatal(r.Run(port))
}
