package main

import (
	"encoding/json"
	"fmt"
	"html/template"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/gomarkdown/markdown"
	"github.com/gomarkdown/markdown/html"
	"github.com/gomarkdown/markdown/parser"
)

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
