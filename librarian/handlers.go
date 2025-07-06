package main

import (
	"fmt"
	"html/template"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"log"

	"github.com/blevesearch/bleve/v2"
	"github.com/gin-gonic/gin"
)

// Global search index
var searchIndex bleve.Index

// SearchResult represents a search result
type SearchResult struct {
	Title      string
	Filename   string
	Score      float64
	Highlights []string
}

// initializeSearchIndex creates or opens the search index
func initializeSearchIndex() error {
	indexPath := filepath.Join(articlesDir, "search.bleve")

	// Try to open existing index
	index, err := bleve.Open(indexPath)
	if err != nil {
		// Create new index if it doesn't exist
		log.Printf("Creating new search index at %s", indexPath)

		// Create a simple index mapping
		indexMapping := bleve.NewIndexMapping()

		// Create document mapping for articles
		articleMapping := bleve.NewDocumentMapping()

		// Title field
		titleFieldMapping := bleve.NewTextFieldMapping()
		titleFieldMapping.Analyzer = "standard"
		articleMapping.AddFieldMappingsAt("title", titleFieldMapping)

		// Content field
		contentFieldMapping := bleve.NewTextFieldMapping()
		contentFieldMapping.Analyzer = "standard"
		articleMapping.AddFieldMappingsAt("content", contentFieldMapping)

		// Filename field
		filenameFieldMapping := bleve.NewTextFieldMapping()
		filenameFieldMapping.Analyzer = "keyword"
		articleMapping.AddFieldMappingsAt("filename", filenameFieldMapping)

		indexMapping.AddDocumentMapping("article", articleMapping)

		index, err = bleve.New(indexPath, indexMapping)
		if err != nil {
			return fmt.Errorf("failed to create search index: %v", err)
		}

		// Index all existing articles
		if err := indexAllArticles(index); err != nil {
			return fmt.Errorf("failed to index articles: %v", err)
		}
	} else {
		log.Printf("Opened existing search index at %s", indexPath)
	}

	searchIndex = index
	return nil
}

// indexAllArticles indexes all markdown files in the articles directory
func indexAllArticles(index bleve.Index) error {
	articles, err := os.ReadDir(articlesDir)
	if err != nil {
		return err
	}

	count := 0
	for _, article := range articles {
		if !article.IsDir() && strings.HasSuffix(article.Name(), ".md") {
			filename := strings.TrimSuffix(article.Name(), ".md")
			title := desanitizeTitle(filename)

			// Read article content
			articlePath := filepath.Join(articlesDir, article.Name())
			content, err := os.ReadFile(articlePath)
			if err != nil {
				log.Printf("Warning: failed to read article %s: %v", article.Name(), err)
				continue
			}

			// Create document for indexing
			doc := map[string]interface{}{
				"title":    title,
				"content":  string(content),
				"filename": filename,
			}

			// Index the document
			if err := index.Index(filename, doc); err != nil {
				log.Printf("Warning: failed to index article %s: %v", filename, err)
				continue
			}

			count++
		}
	}

	log.Printf("Indexed %d articles", count)
	return nil
}

// searchArticles performs a search and returns results
func searchArticles(query string, limit int) ([]SearchResult, error) {
	if searchIndex == nil {
		return nil, fmt.Errorf("search index not initialized")
	}

	// Create search query
	searchQuery := bleve.NewQueryStringQuery(query)
	searchRequest := bleve.NewSearchRequest(searchQuery)
	searchRequest.Size = limit
	searchRequest.Fields = []string{"title", "filename"}
	searchRequest.Highlight = bleve.NewHighlight()

	// Perform search
	searchResult, err := searchIndex.Search(searchRequest)
	if err != nil {
		return nil, fmt.Errorf("search failed: %v", err)
	}

	// Convert results
	var results []SearchResult
	for _, hit := range searchResult.Hits {
		title, _ := hit.Fields["title"].(string)
		filename, _ := hit.Fields["filename"].(string)

		// Extract highlights and strip mark tags
		var highlights []string
		if hit.Fragments != nil {
			for _, fragments := range hit.Fragments {
				for _, fragment := range fragments {
					// Strip <mark> tags from the fragment
					cleanFragment := strings.ReplaceAll(fragment, "<mark>", "")
					cleanFragment = strings.ReplaceAll(cleanFragment, "</mark>", "")
					highlights = append(highlights, cleanFragment)
				}
			}

		}

		results = append(results, SearchResult{
			Title:      title,
			Filename:   filename,
			Score:      hit.Score,
			Highlights: highlights,
		})
	}

	return results, nil
}

// ArticleUpload represents the structure of an uploaded article
type ArticleUpload struct {
	Title    string `json:"title"`
	Content  string `json:"content"`
	Keywords string `json:"keywords"`
}

func uploadArticleHandler(c *gin.Context) {
	// Check API key
	providedKey := c.GetHeader("X-API-Key")
	if providedKey == "" {
		providedKey = c.Query("api_key") // Also check query parameter
	}

	if providedKey != apiKey {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid API key"})
		return
	}

	// Parse the uploaded article
	var upload ArticleUpload
	if err := c.ShouldBindJSON(&upload); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON format"})
		return
	}

	// Validate required fields
	if upload.Title == "" || upload.Content == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Title and content are required"})
		return
	}

	// Sanitize the title for filename
	filename := sanitizeFilename(upload.Title)

	// Create the markdown file path
	mdPath := filepath.Join(articlesDir, filename+".md")

	// Check if file already exists
	if _, err := os.Stat(mdPath); err == nil {
		c.JSON(http.StatusConflict, gin.H{"error": "Article already exists"})
		return
	}

	// Write the markdown content
	err := os.WriteFile(mdPath, []byte(upload.Content), 0644)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save article"})
		return
	}

	// Save keywords if provided
	if upload.Keywords != "" {
		// Ensure keywords directory exists
		keywordsDir := filepath.Join(articlesDir, "keywords")
		if err := os.MkdirAll(keywordsDir, 0755); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create keywords directory"})
			return
		}

		// Write keywords string directly to file
		keywordsPath := filepath.Join(keywordsDir, filename+".json")
		err = os.WriteFile(keywordsPath, []byte(upload.Keywords), 0644)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save keywords"})
			return
		}
	}

	// Index the new article for search
	if searchIndex != nil {
		doc := map[string]interface{}{
			"title":    upload.Title,
			"content":  upload.Content,
			"filename": filename,
		}
		if err := searchIndex.Index(filename, doc); err != nil {
			log.Printf("Warning: failed to index article %s for search: %v", filename, err)
		} else {
			log.Printf("Indexed article %s for search", filename)
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"message":  "Article uploaded successfully",
		"filename": filename,
		"title":    upload.Title,
	})
}

func getRecentArticles(articlesDir string) []ArticleInfo {
	articles, err := os.ReadDir(articlesDir)
	if err != nil {
		return []ArticleInfo{}
	}

	var articleList []ArticleInfo
	for _, article := range articles {
		if !article.IsDir() && strings.HasSuffix(article.Name(), ".md") {
			filename := strings.TrimSuffix(article.Name(), ".md")
			title := desanitizeTitle(filename)
			fileInfo, err := article.Info()
			if err != nil {
				now := time.Now()
				articleList = append(articleList, ArticleInfo{
					Filename:      filename,
					Title:         title,
					CreatedTime:   now,
					FormattedTime: formatTime(now),
				})
				continue
			}
			modTime := fileInfo.ModTime()
			articleList = append(articleList, ArticleInfo{
				Filename:      filename,
				Title:         title,
				CreatedTime:   modTime,
				FormattedTime: formatTime(modTime),
			})
		}
	}

	sort.Slice(articleList, func(i, j int) bool {
		return articleList[i].CreatedTime.After(articleList[j].CreatedTime)
	})

	if len(articleList) > 7 {
		articleList = articleList[:7]
	}

	return articleList
}

func generateRandomPage(currentPage, totalPages int) int {
	if totalPages <= 1 {
		return 1
	}

	// Generate a random page that's different from the current page
	for {
		randomPage := rand.Intn(totalPages) + 1
		if randomPage != currentPage {
			return randomPage
		}
	}
}

func getAllArticles(articlesDir string) []ArticleInfo {
	articles, err := os.ReadDir(articlesDir)
	if err != nil {
		return []ArticleInfo{}
	}

	var articleList []ArticleInfo
	for _, article := range articles {
		if !article.IsDir() && strings.HasSuffix(article.Name(), ".md") {
			filename := strings.TrimSuffix(article.Name(), ".md")
			title := desanitizeTitle(filename)
			fileInfo, err := article.Info()
			if err != nil {
				now := time.Now()
				articleList = append(articleList, ArticleInfo{
					Filename:      filename,
					Title:         title,
					CreatedTime:   now,
					FormattedTime: formatTime(now),
				})
				continue
			}
			modTime := fileInfo.ModTime()
			articleList = append(articleList, ArticleInfo{
				Filename:      filename,
				Title:         title,
				CreatedTime:   modTime,
				FormattedTime: formatTime(modTime),
			})
		}
	}

	// Sort by modification time (most recent first)
	sort.Slice(articleList, func(i, j int) bool {
		return articleList[i].CreatedTime.After(articleList[j].CreatedTime)
	})

	return articleList
}

func indexHandler(c *gin.Context) {
	articleList := getRecentArticles(articlesDir)
	totalCount := getTotalArticleCount(articlesDir)
	data := IndexData{
		Title:    "Home",
		Count:    totalCount,
		Articles: articleList,
	}

	// Parse the embedded template
	tmpl, err := template.ParseFS(templates, "templates/base.html", "templates/index.html")
	if err != nil {
		c.String(http.StatusInternalServerError, "Template error")
		return
	}

	// Execute the template
	err = tmpl.Execute(c.Writer, data)
	if err != nil {
		c.String(http.StatusInternalServerError, "Template execution error")
		return
	}
}

func randomArticleHandler(c *gin.Context) {
	articles, err := os.ReadDir(articlesDir)
	if err != nil {
		c.String(http.StatusInternalServerError, "Could not read articles directory")
		return
	}

	var articleList []string
	for _, article := range articles {
		if !article.IsDir() && strings.HasSuffix(article.Name(), ".md") {
			filename := strings.TrimSuffix(article.Name(), ".md")
			articleList = append(articleList, filename)
		}
	}

	if len(articleList) == 0 {
		c.String(http.StatusNotFound, "No articles available")
		return
	}

	rand.Seed(time.Now().UnixNano())
	randomIndex := rand.Intn(len(articleList))
	randomArticle := articleList[randomIndex]
	c.Redirect(http.StatusSeeOther, "/"+randomArticle)
}

func allArticlesHandler(c *gin.Context) {
	pageStr := c.Param("page")
	page := 1 // default to page 1

	// Parse page number
	if pageStr != "" {
		if parsedPage, err := strconv.Atoi(pageStr); err == nil && parsedPage > 0 {
			page = parsedPage
		}
	}

	// Get all articles for pagination
	allArticles := getAllArticles(articlesDir)
	totalCount := len(allArticles)

	// Get recent articles for sidebar (limited to 7)
	recentArticles := getRecentArticles(articlesDir)

	// Pagination settings
	articlesPerPage := 50
	totalPages := (totalCount + articlesPerPage - 1) / articlesPerPage

	// Calculate start and end indices
	startIndex := (page - 1) * articlesPerPage
	endIndex := startIndex + articlesPerPage
	if endIndex > totalCount {
		endIndex = totalCount
	}

	// Get articles for current page
	var pageArticles []ArticleInfo
	if startIndex < totalCount {
		pageArticles = allArticles[startIndex:endIndex]
	}

	// Create pagination data
	pagination := struct {
		CurrentPage int
		TotalPages  int
		HasNext     bool
		HasPrev     bool
		NextPage    int
		PrevPage    int
		RandomPage  int
	}{
		CurrentPage: page,
		TotalPages:  totalPages,
		HasNext:     page < totalPages,
		HasPrev:     page > 1,
		NextPage:    page + 1,
		PrevPage:    page - 1,
		RandomPage:  generateRandomPage(page, totalPages), // Generate random page different from current
	}

	data := struct {
		Title        string
		Count        int
		Articles     []ArticleInfo
		PageArticles []ArticleInfo
		Pagination   interface{}
	}{
		Title:        fmt.Sprintf("All Articles - Page %d", page),
		Count:        totalCount,
		Articles:     recentArticles, // Use recent articles for sidebar
		PageArticles: pageArticles,   // Use paginated articles for main content
		Pagination:   pagination,
	}

	// Parse the embedded template
	tmpl, err := template.ParseFS(templates, "templates/base.html", "templates/all.html")
	if err != nil {
		c.String(http.StatusInternalServerError, "Template error")
		return
	}

	// Execute the template
	err = tmpl.Execute(c.Writer, data)
	if err != nil {
		c.String(http.StatusInternalServerError, "Template execution error")
		return
	}
}

func articleHandler(c *gin.Context) {
	articleName := c.Param("article")
	if articleName == "" {
		c.Redirect(http.StatusSeeOther, "/")
		return
	}
	if strings.Contains(articleName, "..") || strings.Contains(articleName, "/") {
		c.String(http.StatusBadRequest, "Invalid article name")
		return
	}
	mdPath := filepath.Join(articlesDir, articleName+".md")
	mdContent, err := os.ReadFile(mdPath)
	if err != nil {
		// Article not found - serve 404 page
		recentArticles := getRecentArticles(articlesDir)
		data := PageData{
			Title:    desanitizeTitle(articleName),
			Content:  template.HTML(""),
			Count:    getTotalArticleCount(articlesDir),
			Articles: recentArticles,
		}

		// Parse the embedded template
		tmpl, err := template.ParseFS(templates, "templates/base.html", "templates/404.html")
		if err != nil {
			c.String(http.StatusInternalServerError, "Template error")
			return
		}

		c.Writer.WriteHeader(http.StatusNotFound)
		// Execute the template
		err = tmpl.Execute(c.Writer, data)
		if err != nil {
			c.String(http.StatusInternalServerError, "Template execution error")
			return
		}
		return
	}
	keywordsPath := filepath.Join(articlesDir, "keywords", articleName+".json")
	mdContentWithLinks := addKeywordLinks(string(mdContent), keywordsPath, articlesDir)
	htmlContent := mdToHTML([]byte(mdContentWithLinks))
	recentArticles := getRecentArticles(articlesDir)
	data := PageData{
		Title:    desanitizeTitle(articleName),
		Content:  template.HTML(htmlContent),
		Count:    getTotalArticleCount(articlesDir),
		Articles: recentArticles,
	}

	// Parse the embedded template
	tmpl, err := template.ParseFS(templates, "templates/base.html", "templates/article.html")
	if err != nil {
		c.String(http.StatusInternalServerError, "Template error")
		return
	}

	// Execute the template
	err = tmpl.Execute(c.Writer, data)
	if err != nil {
		c.String(http.StatusInternalServerError, "Template execution error")
		return
	}
}

func searchHandler(c *gin.Context) {
	query := c.Query("q")
	if query == "" {
		// Redirect to home if no query
		c.Redirect(http.StatusSeeOther, "/")
		return
	}

	// Perform search
	results, err := searchArticles(query, 20)
	if err != nil {
		log.Printf("Search error: %v", err)
		c.String(http.StatusInternalServerError, "Search failed")
		return
	}

	// Get recent articles for sidebar
	recentArticles := getRecentArticles(articlesDir)

	// Create search data
	data := struct {
		Title      string
		Count      int
		Articles   []ArticleInfo
		Query      string
		Results    []SearchResult
		HasResults bool
	}{
		Title:      fmt.Sprintf("Search: %s", query),
		Count:      getTotalArticleCount(articlesDir),
		Articles:   recentArticles,
		Query:      query,
		Results:    results,
		HasResults: len(results) > 0,
	}

	// Parse the embedded template
	tmpl, err := template.ParseFS(templates, "templates/base.html", "templates/search.html")
	if err != nil {
		c.String(http.StatusInternalServerError, "Template error")
		return
	}

	// Execute the template
	err = tmpl.Execute(c.Writer, data)
	if err != nil {
		c.String(http.StatusInternalServerError, "Template execution error")
		return
	}
}
