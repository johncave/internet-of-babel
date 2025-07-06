package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"unicode"

	"github.com/kaptinlin/jsonrepair"
)

// stripInvalidChars removes characters that aren't letters, numbers, or valid JSON symbols
func stripInvalidChars(input string) string {
	// Define valid JSON symbols: quotes, brackets, braces, colons, commas, periods, plus, minus, true, false, null
	validJSONSymbols := regexp.MustCompile(`["{}[\]:,.\-+tfalsnue]`)

	var result []rune
	for _, char := range input {
		// Keep letters, digits, whitespace, and valid JSON symbols
		if unicode.IsLetter(char) || unicode.IsDigit(char) || unicode.IsSpace(char) || validJSONSymbols.MatchString(string(char)) {
			result = append(result, char)
		}
	}

	return string(result)
}

// extractJSONContent extracts content between the first [ or { and the matching closing bracket
func extractJSONContent(input string) string {
	// Find the first opening bracket (either [ or {)
	firstArray := strings.Index(input, "[")
	firstObject := strings.Index(input, "{")

	var startPos int
	var startChar, endChar string

	if firstArray == -1 && firstObject == -1 {
		// No JSON structure found, return original input
		return input
	} else if firstArray == -1 {
		// Only object found
		startPos = firstObject
		startChar = "{"
		endChar = "}"
	} else if firstObject == -1 {
		// Only array found
		startPos = firstArray
		startChar = "["
		endChar = "]"
	} else {
		// Both found, use the earlier one
		if firstArray < firstObject {
			startPos = firstArray
			startChar = "["
			endChar = "]"
		} else {
			startPos = firstObject
			startChar = "{"
			endChar = "}"
		}
	}

	// Find the matching closing bracket
	bracketCount := 0
	endPos := -1

	for i := startPos; i < len(input); i++ {
		char := string(input[i])
		if char == startChar {
			bracketCount++
		} else if char == endChar {
			bracketCount--
			if bracketCount == 0 {
				endPos = i
				break
			}
		}
	}

	if endPos == -1 {
		// No matching closing bracket found, return original input
		return input
	}

	// Extract content between opening and closing brackets
	return input[startPos : endPos+1]
}

func main() {
	// Read input from stdin
	reader := bufio.NewReader(os.Stdin)
	input, err := io.ReadAll(reader)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error reading from stdin: %v\n", err)
		os.Exit(1)
	}

	// Convert input to string
	inputStr := string(input)

	// Strip invalid characters first
	cleanedInput := stripInvalidChars(inputStr)

	// Extract JSON array content
	arrayContent := extractJSONContent(cleanedInput)

	// Fix the JSON using jsonrepair
	fixedJSON, err := jsonrepair.JSONRepair(arrayContent)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error fixing JSON: %v\n", err)
		os.Exit(1)
	}

	// Output the fixed JSON to stdout
	fmt.Print(fixedJSON)
}
