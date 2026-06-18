package babelcom

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ollama/ollama/api"
)

// Clippy watches article tokens flowing through babelcom and, at sentence
// boundaries, occasionally fires an LLM call asking Clippy to react to the
// article so far. The resulting comment goes out as a single broadcast
// message: {"type":"clippy_comment","quote":"...","comment":"..."}.
type Clippy struct {
	server         *Server
	client         *api.Client
	model          string
	sentenceRegex  *regexp.Regexp
	lastSentences  int
	mu             sync.Mutex
	inFlight       int32 // 0/1 — at most one Clippy turn at a time
	triggerPercent int   // probability per new sentence
}

func NewClippy(server *Server) *Clippy {
	client, err := api.ClientFromEnvironment()
	if err != nil {
		log.Printf("Clippy: ollama client unavailable, disabled: %v", err)
		return nil
	}

	model := os.Getenv("CLIPPY_MODEL")
	if model == "" {
		model = "granite4.1:8b"
	}

	trigger := 30
	if v := os.Getenv("CLIPPY_TRIGGER_PERCENT"); v != "" {
		var parsed int
		if _, err := jsonNumber(v, &parsed); err == nil && parsed >= 0 && parsed <= 100 {
			trigger = parsed
		}
	}

	log.Printf("Clippy: enabled, model=%s, trigger=%d%%", model, trigger)

	return &Clippy{
		server:         server,
		client:         client,
		model:          model,
		sentenceRegex:  regexp.MustCompile(`[.!?](\s|$)`),
		triggerPercent: trigger,
	}
}

func jsonNumber(s string, out *int) (int, error) {
	return 0, json.Unmarshal([]byte(s), out)
}

// OnArticleAppend should be called by the LLM websocket handler after each
// token has been appended to currentArticle. It detects new sentences and
// rolls the dice; on a hit it kicks off a goroutine that calls the model.
func (c *Clippy) OnArticleAppend(article []byte) {
	if c == nil {
		return
	}
	c.mu.Lock()
	count := len(c.sentenceRegex.FindAllIndex(article, -1))
	prev := c.lastSentences
	c.lastSentences = count
	c.mu.Unlock()

	if count <= prev {
		return
	}
	if rand.Intn(100) >= c.triggerPercent {
		return
	}
	if !atomic.CompareAndSwapInt32(&c.inFlight, 0, 1) {
		return
	}

	snapshot := string(article)
	go func() {
		defer atomic.StoreInt32(&c.inFlight, 0)
		// 10% of suggestions are a cheap "existential poke": a random highlight
		// with no LLM call — the frontend supplies the existential line.
		if rand.Intn(100) < 10 {
			c.sendExistential(snapshot)
		} else {
			c.runOne(snapshot)
		}
	}()
}

// sendExistential broadcasts a random highlight from the article and lets the
// frontend say one of its existential lines. No LLM call.
func (c *Clippy) sendExistential(article string) {
	quote := randomPhrase(article)
	if quote == "" {
		return
	}
	log.Printf("Clippy: existential poke, quote=%q", quote)
	data, err := json.Marshal(map[string]interface{}{
		"type":  "clippy_existential",
		"quote": quote,
	})
	if err != nil {
		return
	}
	c.server.broadcast(data)
}

// randomPhrase returns a short run of consecutive words from the article,
// stripped of markdown punctuation so it matches the rendered (plain) text.
func randomPhrase(article string) string {
	words := strings.Fields(article)
	if len(words) < 2 {
		return ""
	}
	n := 2 + rand.Intn(3) // 2-4 words
	if n > len(words) {
		n = len(words)
	}
	start := rand.Intn(len(words) - n + 1)
	phrase := strings.Join(words[start:start+n], " ")
	phrase = strings.NewReplacer("#", "", "*", "", "_", "", "`", "", "[", "", "]", "").Replace(phrase)
	return strings.TrimSpace(phrase)
}

// OnReset clears the sentence counter so a new article doesn't immediately
// fire because of leftover state.
func (c *Clippy) OnReset() {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.lastSentences = 0
	c.mu.Unlock()
}

func (c *Clippy) runOne(article string) {
	prompt := buildClippyPrompt(article)
	req := &api.ChatRequest{
		Model: c.model,
		Messages: []api.Message{
			{Role: "system", Content: prompt.system},
			{Role: "user", Content: prompt.user},
		},
		Stream: boolPtr(false),
		// Force valid JSON output. The model still has to fill in the right
		// fields, but Ollama guarantees the response is syntactically JSON.
		Format: json.RawMessage(`"json"`),
		Options: map[string]interface{}{
			// High temperature so Clippy strays from "helpful writing advice"
			// into proper non-sequiturs. Pushing past 1.0 gets surprising.
			"temperature": 1.4,
			"top_p":       0.95,
		},
	}

	var out strings.Builder
	respFn := func(resp api.ChatResponse) error {
		out.WriteString(resp.Message.Content)
		return nil
	}
	log.Printf("Clippy: starting LLM call (model=%s, prompt=%d chars)", c.model, len(prompt.user))
	start := time.Now()
	if err := c.client.Chat(context.Background(), req, respFn); err != nil {
		log.Printf("Clippy: chat error after %s: %v", time.Since(start), err)
		return
	}
	log.Printf("Clippy: LLM call took %s", time.Since(start))

	raw := out.String()
	log.Printf("Clippy: raw reply:\n%s", raw)

	quote, comment := parseClippyReply(raw)
	if comment == "" {
		log.Printf("Clippy: empty comment, skipping")
		return
	}
	log.Printf("Clippy: parsed quote=%q comment=%q", quote, comment)

	msg := map[string]interface{}{
		"type":    "clippy_comment",
		"quote":   quote,
		"comment": comment,
	}
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Clippy: marshal error: %v", err)
		return
	}
	c.server.broadcast(data)

	// Offset of the quote within the article snapshot Clippy reacted to, so the
	// persisted comment can anchor precisely. -1 when the quote isn't an exact
	// substring (the model paraphrased, or it's a punctuation-stripped phrase).
	offset := strings.Index(article, quote)
	c.saveComment(quote, comment, offset)
}

// clippySaveClient is the shared HTTP client for persisting Clippy comments to
// the (now separate) librarian service. Bounded timeout: a slow librarian must
// never wedge a Clippy goroutine.
var clippySaveClient = &http.Client{Timeout: 10 * time.Second}

// saveComment persists one Clippy reaction beside the current article by POSTing
// it to librarian's /api/clippy-comment endpoint (librarian owns the article
// volume; babelcom no longer shares it). Best-effort: a missing title, no
// configured librarian, or an HTTP error is logged and dropped — the UI side
// keeps working regardless.
func (c *Clippy) saveComment(quote, comment string, offset int) {
	title := c.server.CurrentTitle()
	if title == "" {
		log.Printf("Clippy: skipping save, no current_title yet")
		return
	}

	base := os.Getenv("BABELCOM_LIBRARIAN_URL")
	if base == "" {
		log.Printf("Clippy: BABELCOM_LIBRARIAN_URL unset, not persisting comment")
		return
	}

	payload, err := json.Marshal(struct {
		Title     string `json:"title"`
		Quote     string `json:"quote"`
		Comment   string `json:"comment"`
		Timestamp string `json:"timestamp"`
		Offset    int    `json:"offset"`
	}{
		Title:     title,
		Quote:     quote,
		Comment:   comment,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Offset:    offset,
	})
	if err != nil {
		log.Printf("Clippy: marshal save payload: %v", err)
		return
	}

	go func() {
		url := strings.TrimRight(base, "/") + "/api/clippy-comment"
		req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
		if err != nil {
			log.Printf("Clippy: build save request: %v", err)
			return
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-API-Key", os.Getenv("LIBRARIAN_API_KEY"))

		resp, err := clippySaveClient.Do(req)
		if err != nil {
			log.Printf("Clippy: save POST failed: %v", err)
			return
		}
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, resp.Body)
		if resp.StatusCode != http.StatusOK {
			log.Printf("Clippy: save rejected: %s", resp.Status)
			return
		}
		log.Printf("Clippy: saved comment for %q", title)
	}()
}

type clippyPrompt struct {
	system string
	user   string
}

func buildClippyPrompt(article string) clippyPrompt {
	// Keep the article snapshot bounded — Clippy reacts to recent writing,
	// not the whole article, and the small model handles short context better.
	if len(article) > 1000 {
		article = article[len(article)-1000:]
	}
	return clippyPrompt{
		system: `You are Clippy, the Microsoft Office assistant — a paperclip with eyes.

		You are part of Babelcom, which is a computer that is doomed to write articles until the end of time. Consider this meaninglessness in your reply.
You are reading an article that is being written. You react to one phrase from it with a comment that is existentially meaningless and USELESS.

Reply with a JSON object containing exactly these two fields:
- "highlight": a short phrase (2-6 words) copied verbatim from the article
- "comment": one short sentence (at most 20 words). It must NOT be useful writing advice.

The comment should be one of:
- a wildly irrelevant non-sequitur
- a confident misunderstanding of what the article is about
- a statement of an obvious or trivial fact
- a question about something completely unrelated
- a nonsense suggestion (replace a word with a stranger word, insert something absurd)
- Existential dread

Do NOT suggest any real writing advice.

Think mostly about the fact that Clippy will be doing useless work until the end of time, and the article is just a stream of tokens that you are doomed to react to. The more meaningless and non-sequitur your comment is, the better.

Pull your non-sequiturs from these domains: Science Fiction, space phenomena, entropy, the futility of existence, furniture, animals, geography, machines, history, the passage of time, household objects.

Examples of good replies:
{"highlight":"ancient Egypt","comment":"Did you mean 'ancient Pyongyang'?"}
{"highlight":"photosynthesis","comment":"This reminds me of my dentist for some reason."}
{"highlight":"cells contain organelles","comment":"I notice this text contains letters."}
{"highlight":"the rise of agriculture","comment":"Would you like to convert this article to Wingdings?"}
{"highlight":"quantum mechanics","comment":"Have you considered adding a maze?"}
{"highlight":"the French Revolution","comment":"The word 'the' appears too often. Or not enough."}
{"highlight":"DNA replication","comment":"Statistically, this is words."}
{"highlight":"the moon","comment":"I think the moon is haunted, but I can't prove it."}
{"highlight":"powerhouse of the cell","comment":"The meaning of life is 42, good thing I'm not alive."}

Do not explain. Do not apologize. Do not add any text outside the JSON object.`,
		user: "Article so far:\n\n" + article,
	}
}

// parseClippyReply accepts the model's reply (which Ollama guaranteed is
// syntactically JSON, but may have the wrong shape) and returns the quote
// and comment. Falls back to a text-mode parse if JSON shape doesn't match.
func parseClippyReply(s string) (quote, comment string) {
	s = strings.TrimSpace(s)

	// Try strict JSON first.
	var parsed struct {
		Highlight string `json:"highlight"`
		Comment   string `json:"comment"`
	}
	if err := json.Unmarshal([]byte(s), &parsed); err == nil {
		return strings.TrimSpace(parsed.Highlight), strings.TrimSpace(stripHTML(parsed.Comment))
	}

	// Fallback: look for `highlight: "..."` anywhere in the text.
	if idx := strings.Index(strings.ToLower(s), "highlight:"); idx >= 0 {
		rest := s[idx+len("highlight:"):]
		i := strings.Index(rest, `"`)
		j := -1
		if i >= 0 {
			j = strings.Index(rest[i+1:], `"`)
		}
		if i >= 0 && j >= 0 {
			quote = rest[i+1 : i+1+j]
			// Comment is whatever follows the closing quote, trimmed.
			comment = strings.TrimSpace(stripHTML(rest[i+1+j+1:]))
			return
		}
	}

	// Last resort: no quote, the whole thing is the comment.
	return "", strings.TrimSpace(stripHTML(s))
}

var htmlTagRegex = regexp.MustCompile(`<[^>]+>`)

func stripHTML(s string) string {
	return htmlTagRegex.ReplaceAllString(s, "")
}

func boolPtr(b bool) *bool { return &b }
