package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	pluralize "github.com/gertd/go-pluralize"
	"github.com/ollama/ollama/api"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

func AllUpper(s string) bool {
	for _, r := range s {
		if !unicode.IsUpper(r) && unicode.IsLetter(r) {
			return false
		}
	}
	return true
}

// toTitleCase converts a string to proper title case
func toTitleCase(s string) string {
	if s == "" {
		return s
	}

	if AllUpper(s) {
		return s
	}

	// Convert to lowercase first, then capitalize
	s = strings.ToLower(s)
	words := strings.Fields(s)

	for i, word := range words {
		// Skip common words that should remain lowercase (except first and last word)
		if i > 0 && i < len(words)-1 {
			switch word {
			case "a", "an", "and", "as", "at", "but", "by", "for", "if", "in", "nor", "of", "on", "or", "so", "the", "to", "up", "yet":
				continue
			}
		}

		// Capitalize the word
		if len(word) > 0 {
			words[i] = strings.ToUpper(word[:1]) + word[1:]
			continue
		}

		caser := cases.Title(language.English)
		words[i] = caser.String(word)
	}

	return strings.Join(words, " ")
}

// singularize attempts to convert a word to its singular form
func singularize(word string) string {
	var clientShit = pluralize.NewClient()
	return clientShit.Singular(word)
}

// normalizeTitle normalizes a title for duplication checking
func normalizeTitle(title string) string {
	// Remove this - ask the LLM to write in title case
	// // Convert to title case
	// title = toTitleCase(title)

	// // Singularize the title
	// title = singularize(title)

	// Remove any underscores and replace with spaces
	title = strings.ReplaceAll(title, "_", " ")

	title = strings.TrimSpace(title)

	return title
}

// Add a set of basic English stopwords
var stopwords = map[string]struct{}{
	"the": {}, "and": {}, "a": {}, "an": {}, "of": {}, "to": {}, "in": {}, "is": {}, "it": {}, "you": {}, "that": {}, "he": {}, "was": {}, "for": {}, "on": {}, "are": {}, "as": {}, "with": {}, "his": {}, "they": {}, "I": {}, "at": {}, "be": {}, "this": {}, "have": {}, "from": {}, "or": {}, "one": {}, "had": {}, "by": {}, "word": {}, "but": {}, "not": {}, "what": {}, "all": {}, "were": {}, "we": {}, "when": {}, "your": {}, "can": {}, "said": {}, "there": {}, "use": {}, "each": {}, "which": {}, "she": {}, "do": {}, "how": {}, "their": {}, "if": {}, "will": {}, "up": {}, "other": {}, "about": {}, "out": {}, "many": {}, "then": {}, "them": {}, "these": {}, "so": {}, "some": {}, "her": {}, "would": {}, "make": {}, "like": {}, "him": {}, "into": {}, "time": {}, "has": {}, "look": {}, "two": {}, "more": {}, "write": {}, "go": {}, "see": {}, "number": {}, "no": {}, "way": {}, "could": {}, "people": {}, "my": {}, "than": {}, "first": {}, "water": {}, "been": {}, "call": {}, "who": {}, "oil": {}, "its": {}, "now": {}, "find": {}, "long": {}, "down": {}, "day": {}, "did": {}, "get": {}, "come": {}, "made": {}, "may": {}, "part": {},
}

func work() {
	client, err := api.ClientFromEnvironment()
	if err != nil {
		log.Fatal(err)
	}

	model := "llama3.2:1b"
	articlesDir := "articles"
	keywordsDir := filepath.Join(articlesDir, "keywords")
	queuePath := "queue.txt"
	if err := ensureDir(articlesDir); err != nil {
		log.Fatalf("Failed to create articles dir: %v", err)
	}
	if err := ensureDir(keywordsDir); err != nil {
		log.Fatalf("Failed to create keywords dir: %v", err)
	}

	maxDepth := 1000   // Change as needed
	maxQueueLen := 500 // Maximum number of topics in the queue

	for {

		// First, check if shutdown has been requested
		if shutdownRequested {
			done <- true
			return
		}

		queueItems, err := readQueue(queuePath)
		if err != nil {
			log.Fatalf("Failed to read queue.txt: %v", err)
		}
		if len(queueItems) == 0 {
			fmt.Println("Queue is empty. Done!")
			break
		}
		// Process the first item
		topic := queueItems[0][0]
		depth := 0
		fmt.Sscanf(queueItems[0][1], "%d", &depth)
		queueItems = queueItems[1:] // Remove from queue

		// Normalize the topic for better duplication checking
		normalizedTopic := normalizeTitle(topic)

		filename := sanitizeFilename(normalizedTopic) + ".md"
		articlePath := filepath.Join(articlesDir, filename)
		if _, err := os.Stat(articlePath); err == nil {
			// Already processed, skip
			_ = writeQueue(queuePath, queueItems)
			continue
		}

		log.Printf("Now writing: %s (depth %d) 🤔\n", topic, depth)
		startTime := time.Now()
		ctx := context.Background()
		messages := []api.Message{
			{
				Role:    "system",
				Content: "Write a detailed encyclopedia article about the given topic in markdown format.",
			},
			{
				Role:    "user",
				Content: fmt.Sprintf("Write a detailed encyclopedia article about \"%s\"", topic),
			},
		}

		log.Println("Generating article...")
		generationStatus.Title = topic
		generationStatus.Phase = "Writing"
		SendManualStatusUpdate()
		// Generate article
		articleContent := ""
		articleRespFunc := func(resp api.ChatResponse) error {
			go SendToken(resp.Message.Content) // Send each token to the WebSocket
			//fmt.Print(resp.Message.Content)
			articleContent += resp.Message.Content
			return nil
		}
		articleReq := &api.ChatRequest{
			Model:    model,
			Messages: messages,
		}
		err = client.Chat(ctx, articleReq, articleRespFunc)
		if err != nil {
			log.Printf("Error generating article for '%s': %v", topic, err)
			_ = writeQueue(queuePath, queueItems)
			continue
		}
		//fmt.Println("\nArticle:\n", articleContent)

		// Save article as markdown
		if err := writeFile(articlePath, articleContent); err != nil {
			log.Printf("Error writing article file for '%s': %v", topic, err)
		}

		log.Println("Extracting keywords...")
		// Ask for keywords in the same conversation
		messages = append(messages, api.Message{
			Role:    "assistant",
			Content: articleContent,
		})
		messages = append(messages, api.Message{
			Role:    "user",
			Content: "Extract a list of the most important words or concepts from the article you just wrote. Reply only with a json array of strings, no markdown. Format the strings in correct English title case and pluralize them if necessary as the title of an article.",
		})

		generationStatus.Phase = "Analyzing"
		SendManualStatusUpdate()

		keywordsContent := ""
		keywordsRespFunc := func(resp api.ChatResponse) error {
			go SendToken(resp.Message.Content) // Send each token to the WebSocket
			//fmt.Print(resp.Message.Content)
			keywordsContent += resp.Message.Content
			return nil
		}
		keywordsReq := &api.ChatRequest{
			Model:    model,
			Messages: messages,
		}
		err = client.Chat(ctx, keywordsReq, keywordsRespFunc)
		if err != nil {
			log.Printf("Error extracting keywords for '%s': %v", topic, err)
			_ = writeQueue(queuePath, queueItems)
			continue
		}
		//fmt.Println("\nExtracted Words:\n", keywordsContent)

		// Save keywords as JSON
		keywordsFilename := sanitizeFilename(topic) + ".json"
		keywordsPath := filepath.Join(keywordsDir, keywordsFilename)
		var prettyJSON bytes.Buffer
		if err := json.Indent(&prettyJSON, []byte(keywordsContent), "", "  "); err == nil {
			keywordsContent = prettyJSON.String()
		}
		if err := writeFile(keywordsPath, keywordsContent); err != nil {
			log.Printf("Error writing keywords file for '%s': %v", topic, err)
		}

		// Log processing
		duration := time.Since(startTime)
		if err := logProcess(topic, duration, depth, len(articleContent)); err != nil {
			log.Printf("Error logging process for '%s': %v", topic, err)
		}

		// Recursively enqueue new topics from keywords
		if depth < maxDepth {
			var keywords []string
			if err := json.Unmarshal([]byte(keywordsContent), &keywords); err == nil {

				//log.Println("Processing keywords for topic:", topic, keywords)
				// Read the current queue again to avoid duplicates
				currentQueue, _ := readQueue(queuePath)
				for _, kw := range keywords {
					kw = strings.TrimSpace(kw)
					if kw == "" {
						continue
					}
					if _, isStopword := stopwords[strings.ToLower(kw)]; isStopword {
						continue
					}

					// Normalize the keyword for better duplication checking
					normalizedKw := normalizeTitle(kw)

					// Make file existence check case-insensitive by checking all files in the directory
					alreadyProcessed := false
					files, _ := os.ReadDir(articlesDir)
					for _, f := range files {
						if strings.EqualFold(f.Name(), sanitizeFilename(normalizedKw)+".md") {
							alreadyProcessed = true
							break
						}
					}
					if alreadyProcessed {
						continue // Already processed
					}
					// Only add to queue if queue length is below the limit
					if len(queueItems) < maxQueueLen && !isInQueue(currentQueue, normalizedKw) && !isInQueue(queueItems, normalizedKw) {
						queueItems = append(queueItems, [2]string{normalizedKw, fmt.Sprintf("%d", depth+1)})
					}
				}
			}
		}
		// Write updated queue
		if err := writeQueue(queuePath, queueItems); err != nil {
			log.Fatalf("Failed to update queue.txt: %v", err)
		}

		SendReset() // Notify WebSocket of reset
	}
}
