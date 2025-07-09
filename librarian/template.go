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
	"github.com/kaptinlin/jsonrepair"
)

type PageData struct {
	Title    string
	Content  template.HTML
	Count    int
	Articles []ArticleInfo
}

type IndexData struct {
	Title    string
	Count    int
	Articles []ArticleInfo
}

type ArticleInfo struct {
	Filename      string
	Title         string
	CreatedTime   time.Time
	FormattedTime string
}

// formatTime formats time as relative time for recent articles (less than a day)
// and with UTC suffix for older articles
func formatTime(t time.Time) string {
	now := time.Now()
	duration := now.Sub(t)

	// If less than 24 hours, show relative time
	if duration < 24*time.Hour {
		hours := int(duration.Hours())
		minutes := int(duration.Minutes()) % 60

		if hours > 0 {
			if minutes > 0 {
				return fmt.Sprintf("%dh %dm ago", hours, minutes)
			}
			return fmt.Sprintf("%dh ago", hours)
		}
		return fmt.Sprintf("%dm ago", minutes)
	}

	// For older articles, show date and time with UTC
	return t.Format("2006-01-02 15:04") + " UTC"
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

// parseMarkdownList parses a markdown unordered list and returns the items
func parseMarkdownList(input string) []string {
	var items []string
	lines := strings.Split(input, "\n")

	for _, line := range lines {
		line = strings.TrimSpace(line)
		// Match markdown list items: * item, - item, + item
		if strings.HasPrefix(line, "* ") || strings.HasPrefix(line, "- ") || strings.HasPrefix(line, "+ ") {
			item := strings.TrimSpace(line[2:]) // Remove the list marker and space
			if item != "" {
				items = append(items, item)
			}
		}
	}

	return items
}

func addKeywordLinks(mdContent string, keywordsPath string, articlesDir string) string {
	// Try to read keywords from JSON file first
	keywordsData, err := os.ReadFile(keywordsPath)
	if err != nil {
		// If JSON file doesn't exist, try markdown file
		mdKeywordsPath := strings.TrimSuffix(keywordsPath, ".json") + ".md"
		keywordsData, err = os.ReadFile(mdKeywordsPath)
		if err != nil {
			// If neither file exists, return original content
			return mdContent
		}
	}

	keywordsStr := string(keywordsData)
	var keywords []string

	// Try to parse as JSON first (for backward compatibility)
	if strings.TrimSpace(keywordsStr) != "" {
		// Try to fix malformed JSON before unmarshaling
		fixedJSON, err := jsonrepair.JSONRepair(keywordsStr)
		if err != nil {
			// If JSON repair fails, try original data
			fixedJSON = keywordsStr
		}

		if err := json.Unmarshal([]byte(fixedJSON), &keywords); err == nil && len(keywords) > 0 {
			// Successfully parsed as JSON
		} else {
			// Try to parse as markdown list
			keywords = parseMarkdownList(keywordsStr)
		}
	}

	if len(keywords) == 0 {
		// If no keywords found, return original content
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
