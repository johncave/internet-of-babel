package babelcom

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/ollama/ollama/api"
)

// Both backends share these generation knobs so Clippy behaves identically
// whichever transport is live: a high temperature pushes the model off
// "helpful writing advice" and into non-sequiturs, and a tight output cap keeps
// the one-sentence reply (and, on OpenRouter, the bill) small.
const (
	clippyTemperature = 1.4
	clippyTopP        = 0.95
	clippyMaxTokens   = 100
)

// ---- Ollama backend (local, dev default) ----

type ollamaBackend struct {
	client *api.Client
	model  string
}

func newOllamaBackend() (clippyBackend, error) {
	client, err := api.ClientFromEnvironment()
	if err != nil {
		return nil, fmt.Errorf("ollama client: %w", err)
	}
	model := os.Getenv("CLIPPY_MODEL")
	if model == "" {
		model = "granite4.1:8b"
	}
	return &ollamaBackend{client: client, model: model}, nil
}

func (b *ollamaBackend) describe() string { return "ollama model=" + b.model }

func (b *ollamaBackend) Chat(ctx context.Context, system, user string) (string, error) {
	req := &api.ChatRequest{
		Model: b.model,
		Messages: []api.Message{
			{Role: "system", Content: system},
			{Role: "user", Content: user},
		},
		Stream: boolPtr(false),
		// Ollama guarantees syntactically valid JSON; the model still has to fill
		// in the right fields, which parseClippyReply tolerates if it doesn't.
		Format: json.RawMessage(`"json"`),
		Options: map[string]interface{}{
			"temperature": clippyTemperature,
			"top_p":       clippyTopP,
			"num_predict": clippyMaxTokens,
		},
	}

	var out strings.Builder
	respFn := func(resp api.ChatResponse) error {
		out.WriteString(resp.Message.Content)
		return nil
	}
	if err := b.client.Chat(ctx, req, respFn); err != nil {
		return "", err
	}
	return out.String(), nil
}

func boolPtr(b bool) *bool { return &b }

// ---- OpenRouter backend (hosted, prod) ----

// openRouterClient is shared across calls; the per-request timeout comes from
// the context passed to Chat, but a client-level ceiling guards against a hung
// dial that somehow escapes the context.
var openRouterClient = &http.Client{Timeout: 60 * time.Second}

type openRouterBackend struct {
	apiKey  string
	baseURL string
	model   string
}

func newOpenRouterBackend() (clippyBackend, error) {
	key := os.Getenv("OPENROUTER_API_KEY")
	if key == "" {
		return nil, fmt.Errorf("OPENROUTER_API_KEY unset")
	}
	base := os.Getenv("OPENROUTER_BASE_URL")
	if base == "" {
		base = "https://openrouter.ai/api/v1"
	}
	model := os.Getenv("CLIPPY_MODEL")
	if model == "" {
		model = "ibm-granite/granite-4.1-8b"
	}
	return &openRouterBackend{apiKey: key, baseURL: strings.TrimRight(base, "/"), model: model}, nil
}

func (b *openRouterBackend) describe() string { return "openrouter model=" + b.model }

func (b *openRouterBackend) Chat(ctx context.Context, system, user string) (string, error) {
	body, err := json.Marshal(map[string]interface{}{
		"model": b.model,
		"messages": []map[string]string{
			{"role": "system", "content": system},
			{"role": "user", "content": user},
		},
		"temperature":     clippyTemperature,
		"top_p":           clippyTopP,
		"max_tokens":      clippyMaxTokens,
		"response_format": map[string]string{"type": "json_object"},
	})
	if err != nil {
		return "", fmt.Errorf("marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+b.apiKey)
	// Optional OpenRouter attribution headers (used for their dashboard rankings).
	req.Header.Set("X-Title", "Babelcom")
	if ref := os.Getenv("OPENROUTER_REFERER"); ref != "" {
		req.Header.Set("HTTP-Referer", ref)
	}

	resp, err := openRouterClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("openrouter %s: %s", resp.Status, strings.TrimSpace(string(raw)))
	}

	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", fmt.Errorf("decode response: %w", err)
	}
	if parsed.Error.Message != "" {
		return "", fmt.Errorf("openrouter error: %s", parsed.Error.Message)
	}
	if len(parsed.Choices) == 0 {
		return "", fmt.Errorf("openrouter: no choices in response")
	}
	return parsed.Choices[0].Message.Content, nil
}
