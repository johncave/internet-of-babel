package librarian

import (
	"encoding/json"
	"fmt"
	"html/template"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"log"

	"github.com/blevesearch/bleve/v2"
	"github.com/gin-gonic/gin"
	"github.com/kaptinlin/jsonrepair"
)

// Global search index
var searchIndex bleve.Index

// popularCache holds the most-linked-to article list. Refreshed at startup
// and on every /api/upload (the only event that changes the link graph).
var (
	popularCache   []ArticleInfo
	popularCacheMu sync.RWMutex
)

// isEmbedded reports whether the request is rendered inside babelcom's iframe.
// Babelcom appends ?embed=1 when it loads the wiki in the library-browser app;
// templates use this to hide the "BABELCOM" link (and later, more chrome).
func isEmbedded(c *gin.Context) bool {
	return c.Query("embed") == "1"
}

// SearchResult represents a search result
type SearchResult struct {
	Title      string
	Filename   string
	Kind       string // "ai" or "wiki"
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

		// Kind field — "ai" or "wiki", for routing and badging in results
		kindFieldMapping := bleve.NewTextFieldMapping()
		kindFieldMapping.Analyzer = "keyword"
		articleMapping.AddFieldMappingsAt("kind", kindFieldMapping)

		indexMapping.AddDocumentMapping("article", articleMapping)

		index, err = bleve.New(indexPath, indexMapping)
		if err != nil {
			return fmt.Errorf("failed to create search index: %v", err)
		}
	} else {
		log.Printf("Opened existing search index at %s", indexPath)
	}

	searchIndex = index

	// Always re-index both dirs on startup. Re-indexing is idempotent
	// (same doc ID → overwrite). This catches articles added to disk
	// outside the upload flow — manual copies, restored backups, or
	// anything that landed before a schema change — that would otherwise
	// be invisible to search.
	if err := indexDir(index, articlesDir, "ai"); err != nil {
		log.Printf("Warning: failed to index AI articles: %v", err)
	}
	if err := indexDir(index, wikiDir, "wiki"); err != nil {
		log.Printf("Warning: failed to index wiki articles: %v", err)
	}

	return nil
}

// indexDir walks a directory of markdown files and indexes each one with the
// given kind. Doc IDs are namespaced for wiki entries ("wiki:<slug>") so they
// can't collide with AI articles that share a slug.
func indexDir(index bleve.Index, dir, kind string) error {
	files, err := os.ReadDir(dir)
	if err != nil {
		return err
	}

	count := 0
	for _, f := range files {
		if f.IsDir() || !strings.HasSuffix(f.Name(), ".md") {
			continue
		}
		filename := strings.TrimSuffix(f.Name(), ".md")
		title := desanitizeTitle(filename)

		content, err := os.ReadFile(filepath.Join(dir, f.Name()))
		if err != nil {
			log.Printf("Warning: failed to read %s: %v", f.Name(), err)
			continue
		}

		doc := map[string]interface{}{
			"title":    title,
			"content":  string(content),
			"filename": filename,
			"kind":     kind,
		}

		id := filename
		if kind != "ai" {
			id = kind + ":" + filename
		}
		if err := index.Index(id, doc); err != nil {
			log.Printf("Warning: failed to index %s (%s): %v", id, kind, err)
			continue
		}
		count++
	}

	log.Printf("Indexed %d %s articles", count, kind)
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
	searchRequest.Fields = []string{"title", "filename", "kind"}
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
		kind, _ := hit.Fields["kind"].(string)
		if kind == "" {
			kind = "ai" // legacy docs indexed before the kind field existed
		}

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
			Kind:       kind,
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

// ClippyComment is one saved Clippy reaction tied to an article.
type ClippyComment struct {
	Quote     string `json:"quote"`
	Comment   string `json:"comment"`
	Timestamp string `json:"timestamp"`
}

// ClippyCommentUpload is the wire payload accepted by /api/clippy-comments.
// Title identifies the article (server slug-sanitizes it the same way uploads
// do, so a comment posted mid-write lands beside the finished article).
type ClippyCommentUpload struct {
	Title     string `json:"title"`
	Quote     string `json:"quote"`
	Comment   string `json:"comment"`
	Timestamp string `json:"timestamp,omitempty"`
}

// clippyCommentsDir returns the directory comments are appended into. Co-located
// with articles so a finished article and its Clippy chatter ship together.
func clippyCommentsDir() string {
	return filepath.Join(articlesDir, "clippy")
}

// clippyCommentsHandler appends one Clippy reaction to a per-article JSON
// array on disk. Append-only: babelcom POSTs each comment as it's generated
// so a crash mid-article doesn't lose what's already been said.
func clippyCommentsHandler(c *gin.Context) {
	providedKey := c.GetHeader("X-API-Key")
	if providedKey == "" {
		providedKey = c.Query("api_key")
	}
	if providedKey != apiKey {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid API key"})
		return
	}

	var upload ClippyCommentUpload
	if err := c.ShouldBindJSON(&upload); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON format"})
		return
	}
	if strings.TrimSpace(upload.Title) == "" || strings.TrimSpace(upload.Comment) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "title and comment are required"})
		return
	}

	filename := sanitizeFilename(upload.Title)
	if filename == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "title sanitizes to empty"})
		return
	}

	dir := clippyCommentsDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create clippy directory"})
		return
	}

	path := filepath.Join(dir, filename+".json")

	entry := ClippyComment{
		Quote:     upload.Quote,
		Comment:   upload.Comment,
		Timestamp: upload.Timestamp,
	}
	if entry.Timestamp == "" {
		entry.Timestamp = time.Now().UTC().Format(time.RFC3339)
	}

	// Read-modify-write under a per-file mutex so two simultaneous appends
	// don't lose one of the comments.
	mu := clippyCommentsLock(filename)
	mu.Lock()
	defer mu.Unlock()

	var existing []ClippyComment
	if data, err := os.ReadFile(path); err == nil && len(data) > 0 {
		if err := json.Unmarshal(data, &existing); err != nil {
			// Corrupt file — rotate it aside rather than overwrite silently,
			// so we can investigate later but the new comment still lands.
			_ = os.Rename(path, path+".corrupt")
			existing = nil
		}
	}
	existing = append(existing, entry)

	data, err := json.MarshalIndent(existing, "", "  ")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to marshal comments"})
		return
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to write comments"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"saved": len(existing), "filename": filename})
}

var (
	clippyLocksMu sync.Mutex
	clippyLocks   = make(map[string]*sync.Mutex)
)

func clippyCommentsLock(filename string) *sync.Mutex {
	clippyLocksMu.Lock()
	defer clippyLocksMu.Unlock()
	mu, ok := clippyLocks[filename]
	if !ok {
		mu = &sync.Mutex{}
		clippyLocks[filename] = mu
	}
	return mu
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
		keywordsPath := filepath.Join(keywordsDir, filename+".md")
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
			"kind":     "ai",
		}
		if err := searchIndex.Index(filename, doc); err != nil {
			log.Printf("Warning: failed to index article %s for search: %v", filename, err)
		} else {
			log.Printf("Indexed article %s for search", filename)
		}
	}

	// The link graph changed — refresh the popular cache in the background
	// so the overlay reflects the new article's keywords without blocking
	// this request.
	go refreshPopular(20)

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

// refreshPopular walks every keyword file, counts inbound references per
// slug, and rebuilds popularCache as the top N most-linked-to articles.
// Cheap (~O(n) over the keywords dir); safe to call from upload handler.
func refreshPopular(limit int) {
	keywordsDir := filepath.Join(articlesDir, "keywords")
	files, err := os.ReadDir(keywordsDir)
	if err != nil {
		return
	}

	counts := make(map[string]int)
	for _, f := range files {
		if f.IsDir() {
			continue
		}
		ext := filepath.Ext(f.Name())
		if ext != ".md" && ext != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(keywordsDir, f.Name()))
		if err != nil {
			continue
		}
		for _, kw := range parseKeywordsFile(data) {
			slug := sanitizeFilename(kw)
			if slug == "" {
				continue
			}
			counts[slug]++
		}
	}

	type ranked struct {
		slug  string
		count int
	}
	var list []ranked
	for slug, count := range counts {
		// Only include articles that actually exist on disk
		if _, err := os.Stat(filepath.Join(articlesDir, slug+".md")); err != nil {
			continue
		}
		list = append(list, ranked{slug, count})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].count > list[j].count })
	if len(list) > limit {
		list = list[:limit]
	}

	out := make([]ArticleInfo, 0, len(list))
	for _, r := range list {
		out = append(out, ArticleInfo{
			Filename: r.slug,
			Title:    desanitizeTitle(r.slug),
		})
	}

	popularCacheMu.Lock()
	popularCache = out
	popularCacheMu.Unlock()
}

func getPopular() []ArticleInfo {
	popularCacheMu.RLock()
	defer popularCacheMu.RUnlock()
	out := make([]ArticleInfo, len(popularCache))
	copy(out, popularCache)
	return out
}

// parseKeywordsFile is a thin wrapper that tries JSON first, then falls
// back to a markdown bullet list — matches the dual format handled by
// addKeywordLinks in template.go.
func parseKeywordsFile(data []byte) []string {
	str := strings.TrimSpace(string(data))
	if str == "" {
		return nil
	}
	if strings.HasPrefix(str, "[") {
		var list []string
		if fixed, err := jsonrepair.JSONRepair(str); err == nil {
			if err := json.Unmarshal([]byte(fixed), &list); err == nil && len(list) > 0 {
				return list
			}
		}
	}
	return parseMarkdownList(str)
}

// computeSimilar returns articles linked from the given slug — the
// LLM's own judgment of related material via its keyword list.
func computeSimilar(slug string, limit int) []ArticleInfo {
	keywordsPath := filepath.Join(articlesDir, "keywords", slug+".md")
	data, err := os.ReadFile(keywordsPath)
	if err != nil {
		keywordsPath = filepath.Join(articlesDir, "keywords", slug+".json")
		data, err = os.ReadFile(keywordsPath)
		if err != nil {
			return nil
		}
	}

	seen := make(map[string]bool)
	var out []ArticleInfo
	for _, kw := range parseKeywordsFile(data) {
		target := sanitizeFilename(kw)
		if target == "" || seen[target] {
			continue
		}
		seen[target] = true
		if _, err := os.Stat(filepath.Join(articlesDir, target+".md")); err != nil {
			continue
		}
		out = append(out, ArticleInfo{
			Filename: target,
			Title:    desanitizeTitle(target),
		})
		if len(out) >= limit {
			break
		}
	}
	return out
}

// computeGenerationRate returns articles per hour over the window covered by
// the passed list (oldest to newest). Returns 0 when the window is too small
// or degenerate to give a meaningful number.
func computeGenerationRate(articles []ArticleInfo) float64 {
	if len(articles) < 2 {
		return 0
	}
	newest := articles[0].CreatedTime
	oldest := articles[len(articles)-1].CreatedTime
	hours := newest.Sub(oldest).Hours()
	if hours <= 0 {
		return 0
	}
	return float64(len(articles)-1) / hours
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
		Rate:     computeGenerationRate(articleList),
		Embedded: isEmbedded(c),
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
		Embedded     bool
	}{
		Title:        fmt.Sprintf("All Articles - Page %d", page),
		Count:        totalCount,
		Articles:     recentArticles,
		PageArticles: pageArticles,
		Pagination:   pagination,
		Embedded:     isEmbedded(c),
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
			Embedded: isEmbedded(c),
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
		Embedded: isEmbedded(c),
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

func wikiArticleHandler(c *gin.Context) {
	articleName := c.Param("article")
	if articleName == "" {
		c.Redirect(http.StatusSeeOther, "/")
		return
	}
	if strings.Contains(articleName, "..") || strings.Contains(articleName, "/") {
		c.String(http.StatusBadRequest, "Invalid wiki page name")
		return
	}

	mdContent, err := os.ReadFile(filepath.Join(wikiDir, articleName+".md"))
	if err != nil {
		c.String(http.StatusNotFound, "Wiki page not found")
		return
	}

	htmlContent := mdToHTML(mdContent)
	recentArticles := getRecentArticles(articlesDir)
	data := PageData{
		Title:    desanitizeTitle(articleName),
		Content:  template.HTML(htmlContent),
		Count:    getTotalArticleCount(articlesDir),
		Articles: recentArticles,
		IsWiki:   true,
		Embedded: isEmbedded(c),
	}

	tmpl, err := template.ParseFS(templates, "templates/base.html", "templates/article.html")
	if err != nil {
		c.String(http.StatusInternalServerError, "Template error")
		return
	}

	err = tmpl.Execute(c.Writer, data)
	if err != nil {
		c.String(http.StatusInternalServerError, "Template execution error")
		return
	}
}

// suggestHandler powers the Cmd+K overlay's typeahead. Fast prefix match on
// title (boosted) plus a weaker content match. Capped small for round-trip
// budget on every keystroke.
func suggestHandler(c *gin.Context) {
	q := strings.TrimSpace(c.Query("q"))
	if q == "" || searchIndex == nil {
		c.JSON(http.StatusOK, gin.H{"hits": []interface{}{}})
		return
	}

	limit := 8
	if v := c.Query("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 30 {
			limit = n
		}
	}

	qLower := strings.ToLower(q)
	parts := strings.Fields(qLower)
	lastPart := parts[len(parts)-1]

	titlePrefix := bleve.NewPrefixQuery(lastPart)
	titlePrefix.SetField("title")
	titlePrefix.SetBoost(3.0)

	titleMatch := bleve.NewMatchQuery(q)
	titleMatch.SetField("title")
	titleMatch.SetBoost(2.0)

	// Prefix on content too — without this, typing "nuc" wouldn't surface
	// articles whose body has "nuclear" until you finish the word, even
	// though MatchQuery would catch them once fully typed.
	contentPrefix := bleve.NewPrefixQuery(lastPart)
	contentPrefix.SetField("content")
	contentPrefix.SetBoost(0.5)

	contentMatch := bleve.NewMatchQuery(q)
	contentMatch.SetField("content")
	contentMatch.SetBoost(0.3)

	combined := bleve.NewDisjunctionQuery(titlePrefix, titleMatch, contentPrefix, contentMatch)
	req := bleve.NewSearchRequest(combined)
	req.Size = limit
	req.Fields = []string{"title", "filename", "kind"}

	res, err := searchIndex.Search(req)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	hits := make([]gin.H, 0, len(res.Hits))
	for _, h := range res.Hits {
		title, _ := h.Fields["title"].(string)
		filename, _ := h.Fields["filename"].(string)
		kind, _ := h.Fields["kind"].(string)
		if kind == "" {
			kind = "ai"
		}
		match := "content"
		titleLower := strings.ToLower(title)
		if strings.HasPrefix(titleLower, qLower) || strings.Contains(titleLower, " "+lastPart) || strings.HasPrefix(titleLower, lastPart) {
			match = "title"
		}
		hits = append(hits, gin.H{
			"slug":  filename,
			"title": title,
			"kind":  kind,
			"match": match,
		})
	}

	c.JSON(http.StatusOK, gin.H{"hits": hits})
}

// overlayHandler returns the three static columns the Cmd+K overlay shows
// when opened: recent / random / similar. Single round trip.
//
// "random" beats "popular" for an exploration-shaped site — popular biases
// toward already-discovered nodes; random nudges visitors into corners of
// the corpus they'd never click into otherwise.
func overlayHandler(c *gin.Context) {
	slug := strings.TrimSpace(c.Query("slug"))

	recent := getRecentArticles(articlesDir)
	if len(recent) > 5 {
		recent = recent[:5]
	}
	random := getRandomArticles(5)
	var similar []ArticleInfo
	if slug != "" {
		similar = computeSimilar(slug, 8)
	}

	c.JSON(http.StatusOK, gin.H{
		"recent":  articlesToHits(recent),
		"random":  articlesToHits(random),
		"similar": articlesToHits(similar),
	})
}

// getRandomArticles returns up to `limit` randomly-shuffled articles. Walks
// the articles directory every call; cheap enough for the overlay's once-per-
// open use, and gives genuinely fresh picks each time.
func getRandomArticles(limit int) []ArticleInfo {
	all := getAllArticles(articlesDir)
	if len(all) == 0 || limit <= 0 {
		return nil
	}
	rand.Shuffle(len(all), func(i, j int) { all[i], all[j] = all[j], all[i] })
	if limit > len(all) {
		limit = len(all)
	}
	return all[:limit]
}

func articlesToHits(list []ArticleInfo) []gin.H {
	out := make([]gin.H, 0, len(list))
	for _, a := range list {
		out = append(out, gin.H{
			"slug":  a.Filename,
			"title": a.Title,
			"kind":  "ai",
		})
	}
	return out
}

func searchHandler(c *gin.Context) {
	query := c.Query("q")

	// If no query, show empty search page
	if query == "" {
		recentArticles := getRecentArticles(articlesDir)
		data := struct {
			Title      string
			Count      int
			Articles   []ArticleInfo
			Query      string
			Results    []SearchResult
			HasResults bool
			Embedded   bool
		}{
			Title:      "Search",
			Count:      getTotalArticleCount(articlesDir),
			Articles:   recentArticles,
			Query:      "",
			Results:    []SearchResult{},
			HasResults: false,
			Embedded:   isEmbedded(c),
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
		Embedded   bool
	}{
		Title:      fmt.Sprintf("Search: %s", query),
		Count:      getTotalArticleCount(articlesDir),
		Articles:   recentArticles,
		Query:      query,
		Results:    results,
		HasResults: len(results) > 0,
		Embedded:   isEmbedded(c),
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
