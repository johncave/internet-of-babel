package babelcom

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"encoding/json"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// WebSocket connection wrapper
type Connection struct {
	conn     *websocket.Conn
	connType string // "broadcast" or "llm"
	mu       sync.Mutex
}

// Server holds all the server state
type Server struct {
	broadcastConnections map[*Connection]bool
	llmConnections       map[*Connection]bool
	upstreamRadioConn    *websocket.Conn
	// Last "now playing" payload per station shortcode (e.g. "night",
	// "psytrance"). We subscribe to several stations at once and replay the
	// latest of each to a freshly-connecting client so its station switcher is
	// populated immediately, not after the next upstream push.
	lastRadioMessages  map[string][]byte
	mu                 sync.RWMutex
	upgrader           websocket.Upgrader
	apiKey             string
	latestSystemStatus []byte
	currentArticle     []byte // accumulated token stream since the last reset
	currentTitle       string // latest article title parsed from system_status
	currentMood        []byte // last broadcast mood_change message; replayed on connect
	lastNightSong      string // sh_id of the Vaporwave station's current song; drives mood changes
	clippy             *Clippy
	moods              *MoodEngine
}

// CurrentTitle returns the most recent article title observed on the LLM bus,
// or empty string if none has been seen. Safe for concurrent use.
func (s *Server) CurrentTitle() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.currentTitle
}

// NewServer creates a new server instance
func NewServer() *Server {
	// Get API key from environment variable, fallback to default
	apiKey := os.Getenv("BABELCOM_API_KEY")
	if apiKey == "" {
		apiKey = "babelcom-secret-key" // Default fallback
		log.Printf("No BABELCOM_API_KEY environment variable set, using default key")
	} else {
		log.Printf("Using API key from BABELCOM_API_KEY environment variable")
	}

	return &Server{
		broadcastConnections: make(map[*Connection]bool),
		llmConnections:       make(map[*Connection]bool),
		apiKey:               apiKey,
		lastRadioMessages:    make(map[string][]byte),
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				return true // Allow all origins for development
			},
		},
	}
}

// Broadcast message to all broadcast connections
func (s *Server) broadcast(message []byte) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for conn := range s.broadcastConnections {
		conn.mu.Lock()
		err := conn.conn.WriteMessage(websocket.TextMessage, message)
		conn.mu.Unlock()
		if err != nil {
			log.Printf("Error broadcasting message: %v", err)
			delete(s.broadcastConnections, conn)
		}
	}
}

// Broadcast message to all radio connections
func (s *Server) broadcastRadio(message []byte) {
	// Wrap the upstream payload and ride the main /ws bus so the radio uses
	// the same auto-reconnecting connection as everything else.
	wrapped, err := json.Marshal(map[string]interface{}{
		"type":    "radio",
		"payload": json.RawMessage(message),
	})
	if err == nil {
		s.broadcast(wrapped)
	}
}

// Handle broadcast WebSocket connections
func (s *Server) handleBroadcastWebSocket(c *gin.Context) {
	conn, err := s.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("Error upgrading connection: %v", err)
		return
	}

	connection := &Connection{
		conn:     conn,
		connType: "broadcast",
	}

	s.mu.Lock()
	s.broadcastConnections[connection] = true
	s.mu.Unlock()

	s.mu.RLock()
	if s.latestSystemStatus != nil {
		connection.mu.Lock()
		err := connection.conn.WriteMessage(websocket.TextMessage, s.latestSystemStatus)
		connection.mu.Unlock()
		if err != nil {
			log.Printf("Error sending latest system status: %v", err)
		}
	}
	// Snapshot of the article so far so Writer (and future apps) can render
	// what's already been written when they connect or reconnect.
	snapshot := map[string]interface{}{
		"type": "article_snapshot",
		"text": string(s.currentArticle),
	}
	s.mu.RUnlock()
	if data, err := json.Marshal(snapshot); err == nil {
		connection.mu.Lock()
		if err := connection.conn.WriteMessage(websocket.TextMessage, data); err != nil {
			log.Printf("Error sending article snapshot: %v", err)
		}
		connection.mu.Unlock()
	}

	// Cached upstream-radio "now playing" per station, each wrapped as
	// {type:"radio", payload:...} so it rides the same connection as everything
	// else. One message per station the client could switch to.
	s.mu.RLock()
	cachedRadio := make([][]byte, 0, len(s.lastRadioMessages))
	for _, msg := range s.lastRadioMessages {
		cachedRadio = append(cachedRadio, msg)
	}
	s.mu.RUnlock()
	for _, lastRadio := range cachedRadio {
		wrapped := map[string]interface{}{
			"type":    "radio",
			"payload": json.RawMessage(lastRadio),
		}
		if data, err := json.Marshal(wrapped); err == nil {
			connection.mu.Lock()
			if err := connection.conn.WriteMessage(websocket.TextMessage, data); err != nil {
				log.Printf("Error sending cached radio: %v", err)
			}
			connection.mu.Unlock()
		}
	}

	// Current wallpaper mood, so a Babelcom-mode desktop lands on the shared
	// mood immediately instead of waiting for the next rotation tick.
	s.mu.RLock()
	currentMood := s.currentMood
	s.mu.RUnlock()
	if currentMood != nil {
		connection.mu.Lock()
		if err := connection.conn.WriteMessage(websocket.TextMessage, currentMood); err != nil {
			log.Printf("Error sending current mood: %v", err)
		}
		connection.mu.Unlock()
	}

	log.Printf("Broadcast client connected. Total connections: %d", len(s.broadcastConnections))

	// Handle incoming messages (mostly ping/pong)
	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			log.Printf("Broadcast client disconnected: %v", err)
			break
		}

		// Handle ping messages
		if string(message) == "ping" {
			connection.mu.Lock()
			err := connection.conn.WriteMessage(websocket.TextMessage, []byte("pong"))
			connection.mu.Unlock()
			if err != nil {
				log.Printf("Error sending pong: %v", err)
				break
			}
		}
	}

	s.mu.Lock()
	delete(s.broadcastConnections, connection)
	s.mu.Unlock()

	conn.Close()
	log.Printf("Broadcast client disconnected. Total connections: %d", len(s.broadcastConnections))
}

// Handle LLM WebSocket connections (authenticated)
func (s *Server) handleLLMWebSocket(c *gin.Context) {
	log.Printf("LLM WebSocket connection attempt from %s", c.ClientIP())

	// Simple authentication (in production, use proper auth)
	apiKey := c.Query("api_key")
	log.Printf("LLM WebSocket API key received: %s", apiKey)

	if apiKey != s.apiKey {
		log.Printf("LLM WebSocket authentication failed: invalid API key")
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid API key"})
		return
	}

	conn, err := s.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("Error upgrading LLM connection: %v", err)
		return
	}

	connection := &Connection{
		conn:     conn,
		connType: "llm",
	}

	s.mu.Lock()
	s.llmConnections[connection] = true
	s.mu.Unlock()

	log.Printf("LLM client connected. Total LLM connections: %d", len(s.llmConnections))

	// Handle incoming messages from LLM - just forward them to broadcast
	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			log.Printf("LLM client disconnected: %v", err)
			break
		}

		// Simply broadcast the raw message to all broadcast clients
		s.broadcast(message)

		// Parse and update cached state by type
		var msg map[string]interface{}
		if err := json.Unmarshal(message, &msg); err == nil {
			if msgType, ok := msg["type"].(string); ok {
				switch msgType {
				case "system_status":
					title := extractCurrentTitle(msg)
					s.mu.Lock()
					s.latestSystemStatus = message
					if title != "" {
						s.currentTitle = title
					}
					s.mu.Unlock()
				case "token":
					if tok, ok := msg["token"].(string); ok && tok != "" {
						s.mu.Lock()
						s.currentArticle = append(s.currentArticle, tok...)
						snapshot := make([]byte, len(s.currentArticle))
						copy(snapshot, s.currentArticle)
						s.mu.Unlock()
						s.clippy.OnArticleAppend(snapshot)
					}
				case "reset":
					s.mu.Lock()
					s.currentArticle = s.currentArticle[:0]
					s.mu.Unlock()
					s.clippy.OnReset()
				}
			}
		}
	}

	s.mu.Lock()
	delete(s.llmConnections, connection)
	s.mu.Unlock()

	conn.Close()
	log.Printf("LLM client disconnected. Total LLM connections: %d", len(s.llmConnections))
}

// extractCurrentTitle pulls msg.data.current_title from a parsed system_status
// message, if present. Returns "" if the shape doesn't match — system_status
// payloads vary, so callers should treat empty as "no update".
func extractCurrentTitle(msg map[string]interface{}) string {
	data, ok := msg["data"].(map[string]interface{})
	if !ok {
		return ""
	}
	title, _ := data["current_title"].(string)
	return title
}

// radioStationShortcode pulls the AzuraCast station shortcode (e.g. "night",
// "psytrance") out of an upstream "now playing" payload, or "" if the message
// isn't a station update (the upstream also sends connect/keepalive frames).
func radioStationShortcode(message []byte) string {
	var probe struct {
		Pub struct {
			Data struct {
				Np struct {
					Station struct {
						Shortcode string `json:"shortcode"`
					} `json:"station"`
				} `json:"np"`
			} `json:"data"`
		} `json:"pub"`
	}
	if err := json.Unmarshal(message, &probe); err != nil {
		return ""
	}
	return probe.Pub.Data.Np.Station.Shortcode
}

// nowPlaying pulls the currently playing track's "song history id" and source
// playlist out of an upstream payload. sh_id is unique per play, so it changes
// on every song boundary (unlike song.id, which repeats for the same track);
// the playlist (e.g. "Stellardrone", "Vaporwave") biases the wallpaper choice.
// Returns "" id if the message has no now_playing entry.
func nowPlaying(message []byte) (id, playlist string) {
	var probe struct {
		Pub struct {
			Data struct {
				Np struct {
					NowPlaying struct {
						ShID     int64  `json:"sh_id"`
						Playlist string `json:"playlist"`
					} `json:"now_playing"`
				} `json:"np"`
			} `json:"data"`
		} `json:"pub"`
	}
	if err := json.Unmarshal(message, &probe); err != nil {
		return "", ""
	}
	np := probe.Pub.Data.Np.NowPlaying
	if np.ShID == 0 {
		return "", np.Playlist
	}
	return strconv.FormatInt(np.ShID, 10), np.Playlist
}

// How long we'll wait for any upstream frame (data or keepalive ping) before
// declaring the link dead. AzuraCast/Centrifugo pings well inside this, so a
// silence this long means a half-open connection — which is exactly the failure
// that previously went undetected and left clients on stale/empty data.
const upstreamRadioReadTimeout = 60 * time.Second

// connectUpstreamRadio launches the background supervisor that keeps a
// connection to the upstream radio alive, reconnecting forever with backoff.
// It returns the result of the *first* connection attempt so startup can log a
// status; the supervisor keeps retrying regardless of that result.
func (s *Server) connectUpstreamRadio(upstreamURL string) error {
	firstErr := make(chan error, 1)
	go s.superviseUpstreamRadio(upstreamURL, firstErr)
	return <-firstErr
}

// superviseUpstreamRadio dials, streams, and on any disconnect reconnects with
// exponential backoff (capped). A connection that stayed up for a while resets
// the backoff so a one-off drop recovers fast, while genuine flapping backs off.
func (s *Server) superviseUpstreamRadio(upstreamURL string, firstErr chan<- error) {
	const minBackoff, maxBackoff = time.Second, 30 * time.Second
	backoff := minBackoff
	notified := false

	for {
		conn, err := s.dialUpstreamRadio(upstreamURL)
		if !notified {
			notified = true
			firstErr <- err
		}
		if err != nil {
			log.Printf("babelcom: upstream radio connect failed: %v — retrying in %s", err, backoff)
		} else {
			start := time.Now()
			s.streamUpstreamRadio(conn) // blocks until the link drops
			if time.Since(start) > maxBackoff {
				backoff = minBackoff // it was healthy for a while — treat next drop as fresh
			}
			log.Printf("babelcom: upstream radio disconnected — reconnecting in %s", backoff)
		}

		time.Sleep(backoff)
		if backoff < maxBackoff {
			if backoff *= 2; backoff > maxBackoff {
				backoff = maxBackoff
			}
		}
	}
}

// dialUpstreamRadio opens the connection and subscribes to every station the
// desktop's switcher offers. Each station's "now playing" arrives on its own
// channel and is rebroadcast verbatim (the frontend routes by the shortcode in
// the payload). "night" is the Vaporwave station.
func (s *Server) dialUpstreamRadio(upstreamURL string) (*websocket.Conn, error) {
	conn, _, err := websocket.DefaultDialer.Dial(upstreamURL, nil)
	if err != nil {
		return nil, fmt.Errorf("dial: %w", err)
	}
	// A protocol-level ping also counts as the link being alive — answer it and
	// push the read deadline out, so a quiet-but-healthy connection isn't reaped.
	conn.SetPingHandler(func(appData string) error {
		conn.SetReadDeadline(time.Now().Add(upstreamRadioReadTimeout))
		return conn.WriteControl(websocket.PongMessage, []byte(appData), time.Now().Add(10*time.Second))
	})
	subscriptionMsg := `{"subs":{"station:night":{"recover":true},"station:psytrance":{"recover":true}}}`
	if err := conn.WriteMessage(websocket.TextMessage, []byte(subscriptionMsg)); err != nil {
		conn.Close()
		return nil, fmt.Errorf("subscribe: %w", err)
	}
	s.mu.Lock()
	s.upstreamRadioConn = conn
	s.mu.Unlock()
	log.Printf("Connected to upstream radio WebSocket: %s", upstreamURL)
	return conn, nil
}

// streamUpstreamRadio reads from the upstream connection until it drops, caching
// and rebroadcasting each station update. It blocks; the caller reconnects.
func (s *Server) streamUpstreamRadio(conn *websocket.Conn) {
	defer func() {
		conn.Close()
		s.mu.Lock()
		if s.upstreamRadioConn == conn {
			s.upstreamRadioConn = nil
		}
		s.mu.Unlock()
	}()

	for {
		// A live link is never silent for long — AzuraCast/Centrifugo pings
		// keep it warm. If even those stop arriving, the deadline fires and we
		// treat the connection as dead instead of blocking on it forever.
		conn.SetReadDeadline(time.Now().Add(upstreamRadioReadTimeout))
		_, message, err := conn.ReadMessage()
		if err != nil {
			log.Printf("Upstream radio read error: %v", err)
			return
		}

		// Centrifugo keepalive: the server sends an empty object "{}" and
		// expects the same back, or it eventually drops us. Answer it and move
		// on without rebroadcasting.
		if strings.TrimSpace(string(message)) == "{}" {
			if err := conn.WriteMessage(websocket.TextMessage, []byte("{}")); err != nil {
				log.Printf("Upstream radio ping reply failed: %v", err)
				return
			}
			continue
		}

		// Cache the last message per station so a new client can be seeded for
		// whichever station it switches to. The station shortcode lives in the
		// payload; messages without one are still rebroadcast but not cached.
		if len(message) > 4 {
			if code := radioStationShortcode(message); code != "" {
				songChanged := false
				nightPlaylist := ""
				s.mu.Lock()
				s.lastRadioMessages[code] = message
				// The wallpaper follows the Vaporwave (night) station: when its
				// current song changes, pick a new mood (biased by the song's
				// playlist). AzuraCast also pushes now_playing frames for
				// non-musical events (listeners, etc.), so we key on sh_id
				// (unique per play) and ignore repeats. The first song we
				// observe just sets the baseline — no change.
				if code == "night" {
					if id, playlist := nowPlaying(message); id != "" && id != s.lastNightSong {
						songChanged = s.lastNightSong != ""
						s.lastNightSong = id
						nightPlaylist = playlist
					}
				}
				s.mu.Unlock()
				if songChanged && s.moods != nil {
					s.moods.tick(nightPlaylist)
				}
			}
		}

		s.broadcastRadio(message)
	}
}
