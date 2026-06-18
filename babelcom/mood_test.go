package babelcom

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// Test that newMoodEngine finds wallpapers from the embedded FS and a tick
// populates currentMood with a well-formed mood_change message.
func TestMoodTickSetsCurrentMood(t *testing.T) {
	s := NewServer()
	s.moods = newMoodEngine(s)
	if s.moods.root == nil {
		t.Fatal("mood engine found no wallpapers (embedded FS)")
	}
	s.moods.tick("")

	if s.currentMood == nil {
		t.Fatal("currentMood is nil after tick")
	}
	var msg struct {
		Type      string `json:"type"`
		Mood      string `json:"mood"`
		Wallpaper string `json:"wallpaper"`
	}
	if err := json.Unmarshal(s.currentMood, &msg); err != nil {
		t.Fatalf("currentMood not valid JSON: %v", err)
	}
	if msg.Type != "mood_change" {
		t.Errorf("type = %q, want mood_change", msg.Type)
	}
	if msg.Mood == "" || msg.Wallpaper == "" {
		t.Errorf("mood=%q wallpaper=%q, want both non-empty", msg.Mood, msg.Wallpaper)
	}
	if !strings.HasPrefix(msg.Wallpaper, "/static/wallpaper/") {
		t.Errorf("wallpaper = %q, want /static/wallpaper/ prefix", msg.Wallpaper)
	}
}

// Test that preference entries resolve correctly: a leaf name to itself, the
// "Aero" group to its members, and an unknown name to nothing.
func TestResolveLeaves(t *testing.T) {
	s := NewServer()
	me := newMoodEngine(s)

	if got := me.resolveLeaves("Spook"); len(got) != 1 || got[0] != "Spook" {
		t.Errorf(`resolveLeaves("Spook") = %v, want ["Spook"]`, got)
	}
	aero := me.resolveLeaves("Aero")
	want := map[string]bool{"Top": true, "Tech": true, "Other": true}
	if len(aero) == 0 {
		t.Error(`resolveLeaves("Aero") returned nothing`)
	}
	for _, n := range aero {
		if !want[n] {
			t.Errorf(`resolveLeaves("Aero") contains unexpected %q`, n)
		}
	}
	if got := me.resolveLeaves("Nonsense"); got != nil {
		t.Errorf(`resolveLeaves("Nonsense") = %v, want nil`, got)
	}

	// Every preferred mood in the playlist table must resolve to a real leaf,
	// or it would silently never fire.
	for playlist, pref := range playlistMoods {
		for _, entry := range pref.moods {
			if len(me.resolveLeaves(entry)) == 0 {
				t.Errorf("playlist %q references mood %q that resolves to nothing", playlist, entry)
			}
		}
	}
}

// Test the connect-time replay: a client connecting to /ws must receive the
// cached mood_change without waiting for the next rotation tick. This is the
// path that makes "open Babelcom -> correct wallpaper immediately" work.
func TestMoodReplayedOnConnect(t *testing.T) {
	gin.SetMode(gin.TestMode)
	s := NewServer()
	s.setMood("Abstract", "/static/wallpaper/Abstract/test.jpg")

	r := gin.New()
	r.GET("/ws", s.handleBroadcastWebSocket)
	srv := httptest.NewServer(r)
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, http.Header{})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	// Read the burst of replayed messages and look for our mood_change.
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	var gotMood string
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		var m struct {
			Type      string `json:"type"`
			Wallpaper string `json:"wallpaper"`
		}
		if json.Unmarshal(data, &m) == nil && m.Type == "mood_change" {
			gotMood = m.Wallpaper
			break
		}
	}
	if gotMood != "/static/wallpaper/Abstract/test.jpg" {
		t.Fatalf("mood_change not replayed on connect (got %q)", gotMood)
	}
}
