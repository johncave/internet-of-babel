package main

import (
	"html/template"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

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

	sort.Slice(articleList, func(i, j int) bool {
		return articleList[i].CreatedTime.After(articleList[j].CreatedTime)
	})

	if len(articleList) > 10 {
		articleList = articleList[:10]
	}

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
