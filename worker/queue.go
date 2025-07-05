package main

import (
	"bufio"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"
)

func sanitizeFilename(name string) string {
	re := regexp.MustCompile(`[^a-zA-Z0-9_-]+`)
	return strings.Trim(re.ReplaceAllString(name, "_"), "_")
}

func ensureDir(path string) error {
	return os.MkdirAll(path, 0755)
}

func writeFile(path, content string) error {
	return os.WriteFile(path, []byte(content), 0644)
}

func logProcess(topic string, duration time.Duration, depth int, articleLen int) error {
	f, err := os.OpenFile("process.log", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer f.Close()
	timestamp := time.Now().Format(time.RFC3339)
	logLine := fmt.Sprintf("%s | topic: %q | duration: %s | depth: %d | article_length: %d\n", timestamp, topic, duration, depth, articleLen)
	_, err = f.WriteString(logLine)
	fmt.Print(logLine)
	return err
}

func readQueue(queuePath string) ([][2]string, error) {
	f, err := os.Open(queuePath)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var items [][2]string
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		parts := strings.SplitN(line, "|", 2)
		if len(parts) == 2 {
			items = append(items, [2]string{strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])})
		}
	}
	return items, scanner.Err()
}

func writeQueue(queuePath string, items [][2]string) error {
	f, err := os.Create(queuePath)
	if err != nil {
		return err
	}
	defer f.Close()
	for _, item := range items {
		_, err := fmt.Fprintf(f, "%s|%s\n", item[0], item[1])
		if err != nil {
			return err
		}
	}
	return nil
}

func isInQueue(queueItems [][2]string, topic string) bool {
	topicLower := strings.ToLower(topic)
	for _, item := range queueItems {
		if strings.ToLower(item[0]) == topicLower {
			return true
		}
	}
	return false
}
