package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"math/rand"

	"github.com/gomarkdown/markdown"
	"github.com/gomarkdown/markdown/html"
	"github.com/gomarkdown/markdown/parser"
)

const articlesDir = "../articles"

//go:embed templates
var templates embed.FS

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

type PageData struct {
	Title   string
	Content template.HTML
	Count   int
}

type IndexData struct {
	Title    string
	Count    int
	Articles []ArticleInfo
}

type ArticleInfo struct {
	Filename    string
	Title       string
	CreatedTime time.Time
}

func mdToHTML(md []byte) []byte {
	// Create markdown parser with extensions
	extensions := parser.CommonExtensions | parser.AutoHeadingIDs
	parser := parser.NewWithExtensions(extensions)

	doc := parser.Parse(md)

	// Create HTML renderer with extensions
	htmlFlags := html.CommonFlags | html.HrefTargetBlank
	opts := html.RendererOptions{Flags: htmlFlags}
	renderer := html.NewRenderer(opts)

	return markdown.Render(doc, renderer)
}

func addKeywordLinks(mdContent string, keywordsPath string, articlesDir string) string {
	// Read keywords from JSON file
	keywordsData, err := os.ReadFile(keywordsPath)
	if err != nil {
		// If keywords file doesn't exist, return original content
		return mdContent
	}

	var keywords []string
	if err := json.Unmarshal(keywordsData, &keywords); err != nil {
		// If JSON parsing fails, return original content
		return mdContent
	}

	// Create a map for faster lookup
	keywordMap := make(map[string]bool)
	for _, kw := range keywords {
		keywordMap[strings.ToLower(kw)] = true
	}

	// Replace keywords with links
	// Use word boundaries to avoid partial matches
	for keyword := range keywordMap {
		// Create regex pattern with word boundaries
		pattern := regexp.MustCompile(`(?i)\b` + regexp.QuoteMeta(keyword) + `\b`)

		// Find the original keyword (preserving case) and create link
		mdContent = pattern.ReplaceAllStringFunc(mdContent, func(match string) string {
			// Find the original keyword from the keywords list to preserve case
			for _, originalKw := range keywords {
				if strings.EqualFold(originalKw, match) {
					// Check if the target article exists
					targetPath := filepath.Join(articlesDir, sanitizeFilename(originalKw)+".md")
					if _, err := os.Stat(targetPath); err == nil {
						// Article exists - normal markdown link
						return fmt.Sprintf("[%s](/%s)", originalKw, sanitizeFilename(originalKw))
					} else {
						// Article doesn't exist - insert raw HTML with missing-article class
						return fmt.Sprintf(`<a href="/%s" class="missing-article">%s</a>`, sanitizeFilename(originalKw), originalKw)
					}
				}
			}
			return match
		})
	}

	return mdContent
}

func sanitizeFilename(name string) string {
	re := regexp.MustCompile(`[^a-zA-Z0-9_-]+`)
	return strings.Trim(re.ReplaceAllString(name, "_"), "_")
}

func desanitizeTitle(filename string) string {
	// Remove .md extension if present
	filename = strings.TrimSuffix(filename, ".md")
	// Replace underscores with spaces
	title := strings.ReplaceAll(filename, "_", " ")
	// Capitalize first letter of each word
	words := strings.Fields(title)
	for i, word := range words {
		if len(word) > 0 {
			words[i] = strings.ToUpper(word[:1]) + strings.ToLower(word[1:])
		}
	}
	return strings.Join(words, " ")
}

func notFoundHandler(w http.ResponseWriter, r *http.Request, articleName string) {
	// Parse the embedded template
	tmpl, err := template.ParseFS(templates, "templates/base.html", "templates/404.html")
	if err != nil {
		http.Error(w, "Template error", http.StatusInternalServerError)
		return
	}

	// Prepare the page data
	data := PageData{
		Title:   desanitizeTitle(articleName),
		Content: template.HTML(""), // Content is handled by the 404 template
		Count:   getTotalArticleCount(articlesDir),
	}

	// Set 404 status
	w.WriteHeader(http.StatusNotFound)

	// Execute the template
	err = tmpl.Execute(w, data)
	if err != nil {
		http.Error(w, "Template execution error", http.StatusInternalServerError)
		return
	}
}

func articleHandler(w http.ResponseWriter, r *http.Request) {
	// Extract article name from URL path
	path := strings.TrimPrefix(r.URL.Path, "/")
	if path == "" {
		// Serve index page
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}

	// Sanitize the path to prevent directory traversal
	if strings.Contains(path, "..") || strings.Contains(path, "/") {
		http.Error(w, "Invalid article name", http.StatusBadRequest)
		return
	}

	// Construct the markdown file path
	mdPath := filepath.Join(articlesDir, path+".md")

	// Read the markdown file
	mdContent, err := os.ReadFile(mdPath)
	if err != nil {
		// Article not found - serve 404 page
		notFoundHandler(w, r, path)
		return
	}

	// Add keyword links before converting to HTML
	keywordsPath := filepath.Join(articlesDir, "keywords", path+".json")
	mdContentWithLinks := addKeywordLinks(string(mdContent), keywordsPath, articlesDir)

	// Convert markdown to HTML
	htmlContent := mdToHTML([]byte(mdContentWithLinks))

	// Parse the embedded template
	tmpl, err := template.ParseFS(templates, "templates/base.html", "templates/article.html")
	if err != nil {
		http.Error(w, "Template error", http.StatusInternalServerError)
		return
	}

	// Prepare the page data
	data := PageData{
		Title:   desanitizeTitle(path),
		Content: template.HTML(htmlContent),
		Count:   getTotalArticleCount(articlesDir),
	}

	// Execute the template
	err = tmpl.Execute(w, data)
	if err != nil {
		http.Error(w, "Template execution error", http.StatusInternalServerError)
		return
	}
}

func indexHandler(w http.ResponseWriter, r *http.Request) {
	// List all available articles
	articles, err := os.ReadDir(articlesDir)
	if err != nil {
		http.Error(w, "Could not read articles directory", http.StatusInternalServerError)
		return
	}

	var articleList []ArticleInfo
	for _, article := range articles {
		if !article.IsDir() && strings.HasSuffix(article.Name(), ".md") {
			// Remove .md extension
			filename := strings.TrimSuffix(article.Name(), ".md")
			title := desanitizeTitle(filename)

			// Get file info for creation time
			fileInfo, err := article.Info()
			if err != nil {
				// If we can't get file info, use current time
				articleList = append(articleList, ArticleInfo{
					Filename:    filename,
					Title:       title,
					CreatedTime: time.Now(),
				})
				continue
			}

			articleList = append(articleList, ArticleInfo{
				Filename:    filename,
				Title:       title,
				CreatedTime: fileInfo.ModTime(),
			})
		}
	}

	// Sort by creation time, most recent first
	sort.Slice(articleList, func(i, j int) bool {
		return articleList[i].CreatedTime.After(articleList[j].CreatedTime)
	})

	// Store total count before limiting
	totalCount := len(articleList)

	// Limit to 10 most recent articles
	if len(articleList) > 10 {
		articleList = articleList[:10]
	}

	// Parse the embedded template
	tmpl, err := template.ParseFS(templates, "templates/base.html", "templates/index.html")
	if err != nil {
		http.Error(w, "Template error", http.StatusInternalServerError)
		return
	}

	// Prepare the page data
	data := IndexData{
		Title:    "Articles",
		Count:    totalCount,
		Articles: articleList,
	}

	// Execute the template
	err = tmpl.Execute(w, data)
	if err != nil {
		http.Error(w, "Template execution error", http.StatusInternalServerError)
		return
	}
}

func randomArticleHandler(w http.ResponseWriter, r *http.Request) {
	// List all available articles
	articles, err := os.ReadDir(articlesDir)
	if err != nil {
		http.Error(w, "Could not read articles directory", http.StatusInternalServerError)
		return
	}

	var articleList []string
	for _, article := range articles {
		if !article.IsDir() && strings.HasSuffix(article.Name(), ".md") {
			// Remove .md extension
			filename := strings.TrimSuffix(article.Name(), ".md")
			articleList = append(articleList, filename)
		}
	}

	if len(articleList) == 0 {
		http.Error(w, "No articles available", http.StatusNotFound)
		return
	}

	// Pick a random article
	rand.Seed(time.Now().UnixNano())
	randomIndex := rand.Intn(len(articleList))
	randomArticle := articleList[randomIndex]

	// Redirect to the random article
	http.Redirect(w, r, "/"+randomArticle, http.StatusSeeOther)
}

func main() {
	// Check if articles directory exists
	if _, err := os.Stat(articlesDir); os.IsNotExist(err) {
		log.Fatal("Articles directory not found. Please run the article generator first.")
	}

	// Set up routes
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			indexHandler(w, r)
		} else if r.URL.Path == "/random" {
			randomArticleHandler(w, r)
		} else {
			articleHandler(w, r)
		}
	})

	port := ":8080"
	fmt.Printf("Starting server on http://localhost%s\n", port)
	fmt.Println("Press Ctrl+C to stop the server")

	log.Fatal(http.ListenAndServe(port, nil))
}
