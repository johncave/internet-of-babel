package main

import (
	"embed"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/gin-contrib/gzip"
	"github.com/gin-gonic/gin"
)

var articlesDir = "../worker/articles"

//go:embed templates
var templates embed.FS

//go:embed static
var staticFiles embed.FS

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

// faviconHandler serves the favicon from the embedded static directory
func faviconHandler(c *gin.Context) {
	// Try to read the favicon from the embedded filesystem
	content, err := staticFiles.ReadFile("static/favicon.ico")
	if err != nil {
		c.Status(http.StatusNotFound)
		return
	}

	c.Header("Content-Type", "image/x-icon")
	c.Header("Cache-Control", "public, max-age=86400") // Cache for 24 hours
	c.Data(http.StatusOK, "image/x-icon", content)
}

// staticHandler serves static files from the embedded static directory
func staticHandler(c *gin.Context) {
	// Get the file path from the URL
	filePath := c.Param("filepath")

	if filePath == "" {
		c.Status(http.StatusNotFound)
		return
	}

	// Remove leading slash if present
	filePath = strings.TrimPrefix(filePath, "/")

	// Construct the full path within the embedded filesystem
	fullPath := "static/" + filePath

	// Try to read the file from the embedded filesystem
	content, err := staticFiles.ReadFile(fullPath)
	if err != nil {
		c.Status(http.StatusNotFound)
		return
	}

	// Set appropriate content type based on file extension
	contentType := "text/plain"
	if strings.HasSuffix(filePath, ".css") {
		contentType = "text/css"
	} else if strings.HasSuffix(filePath, ".js") {
		contentType = "application/javascript"
	} else if strings.HasSuffix(filePath, ".png") {
		contentType = "image/png"
	} else if strings.HasSuffix(filePath, ".jpg") || strings.HasSuffix(filePath, ".jpeg") {
		contentType = "image/jpeg"
	} else if strings.HasSuffix(filePath, ".gif") {
		contentType = "image/gif"
	} else if strings.HasSuffix(filePath, ".svg") {
		contentType = "image/svg+xml"
	}

	c.Header("Content-Type", contentType)

	c.Header("Cache-Control", "public, max-age=3600") // Cache for 1 hour
	c.Data(http.StatusOK, contentType, content)
}

func main() {
	// Check if ARTICLES_DIR environment variable exists
	envArticlesDir := os.Getenv("ARTICLES_DIR")
	if envArticlesDir != "" {
		articlesDir = envArticlesDir
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

	// Main routes
	r.GET("/", indexHandler)
	r.GET("/random", randomArticleHandler)
	r.GET("/:article", articleHandler)

	port := ":8080"
	fmt.Printf("Starting server on http://localhost%s\n", port)
	fmt.Println("Press Ctrl+C to stop the server")

	log.Fatal(r.Run(port))
}
