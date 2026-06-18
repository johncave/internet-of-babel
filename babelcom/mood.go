package babelcom

import (
	"encoding/json"
	"io/fs"
	"log"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// The wallpaper "mood" system. Babelcom has no real feelings to report (the
// Compute Stick sits at ~60°C forever), so its mood is pure whim: every few
// minutes backend Clippy picks a mood and a specific wallpaper from it, and
// broadcasts the exact file so every Babelcom-mode desktop shows the same thing.
//
// Selection is a tree of "bags" — draw without replacement until a bag is
// empty, then reshuffle. The top-level bag is {Empty, Anime, Aero, Spook} with
// equal odds; Aero is itself a bag of {Top, Tech, Other}; and each leaf folder
// has its own image bag so you cycle through a folder before any wallpaper
// repeats. The upshot: the small folders (Spook, the videos) are familiar
// regulars while the 22-deep Aero/Other folder slowly reveals fresh vaporwave
// over a long session.

// moodImageExts is the set of wallpaper file types we'll pick (images + the
// looping videos used by the Empty mood).
var moodImageExts = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true,
	".mp4": true, ".webm": true, ".mov": true, ".ogv": true, ".m4v": true,
}

// mood is a single leaf folder of wallpapers plus its no-repeat image bag.
type mood struct {
	name   string   // sent to clients; keys the frontend's Clippy line bank
	images []string // web paths, e.g. "/static/wallpaper/Aero/Top/x.jpg"
	order  []int    // shuffled draw order into images
	pos    int
}

func (m *mood) next() string {
	if m.pos >= len(m.order) {
		m.order = rand.Perm(len(m.images))
		m.pos = 0
	}
	p := m.images[m.order[m.pos]]
	m.pos++
	return p
}

// bagItem is one slot in a bag: either a leaf mood or a nested child bag.
type bagItem struct {
	leaf  *mood
	child *bag
}

// bag draws its items without replacement, reshuffling once exhausted.
type bag struct {
	items []*bagItem
	order []int
	pos   int
}

func newBag(items []*bagItem) *bag {
	if len(items) == 0 {
		return nil
	}
	b := &bag{items: items}
	b.order = rand.Perm(len(items))
	return b
}

// draw returns the next leaf mood, descending into a child bag when one is
// drawn. Returns nil only if the bag (and any drawn child) is empty.
func (b *bag) draw() *mood {
	if b == nil || len(b.items) == 0 {
		return nil
	}
	if b.pos >= len(b.order) {
		b.order = rand.Perm(len(b.items))
		b.pos = 0
	}
	it := b.items[b.order[b.pos]]
	b.pos++
	if it.child != nil {
		if m := it.child.draw(); m != nil {
			return m
		}
	}
	return it.leaf
}

// MoodEngine owns the selection tree and the rotation ticker.
type MoodEngine struct {
	server *Server
	root   *bag
	leaves map[string]*mood // name -> leaf, for playlist-driven preference picks
	mu     sync.Mutex
}

// playlistPref biases mood selection while a given AzuraCast playlist is the
// source of the current song. chance is the probability (0-1) of picking from
// moods instead of the normal rotation; moods may name a group (e.g. "Aero").
type playlistPref struct {
	chance float64
	moods  []string
}

// moodGroups lets a preference name a whole group of leaf moods.
var moodGroups = map[string][]string{
	"Aero": {"Top", "Tech", "Other"},
}

// playlistMoods biases the wallpaper toward moods that suit each Vaporwave-station
// playlist. Unlisted playlists (and "Vaporwave" itself) use the normal rotation.
// Easy to tune: edit a row's chance/moods, or add a new playlist.
var playlistMoods = map[string]playlistPref{
	"Stellardrone": {chance: 0.33, moods: []string{"Aero", "Spook"}},
	"Drone":        {chance: 0.33, moods: []string{"Spook", "Empty", "Anime"}},
}

// newMoodEngine builds the bag tree from whatever wallpapers exist on the
// active static FS. Empty folders are skipped, so a mood with no files simply
// never gets chosen (and a missing folder doesn't crash anything).
func newMoodEngine(s *Server) *MoodEngine {
	leaves := map[string]*mood{}
	leaf := func(name, folder string) *bagItem {
		imgs := listWallpapers(folder)
		if len(imgs) == 0 {
			log.Printf("mood: %q (%s) has no wallpapers, skipping", name, folder)
			return nil
		}
		log.Printf("mood: %q -> %d wallpapers", name, len(imgs))
		m := &mood{name: name, images: imgs, order: rand.Perm(len(imgs))}
		leaves[name] = m
		return &bagItem{leaf: m}
	}

	aero := newBag(compactItems([]*bagItem{
		leaf("Top", "Aero/Top"),
		leaf("Tech", "Aero/Tech"),
		leaf("Other", "Aero/Other"),
	}))

	// Themed "accent" moods, equal weight, sprinkled between Abstract runs.
	accents := compactItems([]*bagItem{
		leaf("Empty", "Empty"),
		leaf("Anime", "Anime"),
		leaf("Spook", "Spook"),
	})
	if aero != nil {
		accents = append(accents, &bagItem{child: aero})
	}

	top := append([]*bagItem(nil), accents...)

	// Abstract is the default set. We weight it to appear about as often as all
	// the accent moods combined (~half the rotation) by adding it to the bag
	// once per accent. The duplicates share one 43-deep image bag, so it still
	// never repeats a wallpaper until the whole set has been shown.
	if abstract := leaf("Abstract", "Abstract"); abstract != nil {
		weight := len(accents)
		if weight < 1 {
			weight = 1
		}
		for i := 0; i < weight; i++ {
			top = append(top, abstract)
		}
	}

	return &MoodEngine{server: s, root: newBag(compactItems(top)), leaves: leaves}
}

func compactItems(items []*bagItem) []*bagItem {
	out := items[:0]
	for _, it := range items {
		if it != nil {
			out = append(out, it)
		}
	}
	return out
}

// run picks an initial mood so there's a wallpaper before the first song
// arrives (and if the radio is ever unreachable). After that, wallpaper changes
// are driven by song changes on the Vaporwave (night) station — see
// streamUpstreamRadio, which calls tick() on each new song.
func (me *MoodEngine) run() {
	if me.root == nil {
		log.Printf("mood: no wallpapers found, rotation disabled")
		return
	}
	me.tick("") // initial wallpaper; later changes are driven by song changes
}

// tick picks a wallpaper (biased by the given playlist, "" for none) and
// broadcasts it.
func (me *MoodEngine) tick(playlist string) {
	name, wallpaper := me.pickForPlaylist(playlist)
	if wallpaper == "" {
		return
	}
	me.server.setMood(name, wallpaper)
}

// pickForPlaylist chooses the next (mood, wallpaper). With probability
// pref.chance — when the playlist has a preference — it picks from the
// playlist's preferred moods; otherwise it uses the normal weighted rotation.
// Either way the chosen mood draws from its own no-repeat image bag.
func (me *MoodEngine) pickForPlaylist(playlist string) (string, string) {
	me.mu.Lock()
	defer me.mu.Unlock()

	if pref, ok := playlistMoods[playlist]; ok && len(pref.moods) > 0 && rand.Float64() < pref.chance {
		if m := me.resolvePreferred(pref.moods); m != nil {
			return m.name, m.next()
		}
	}

	if me.root == nil {
		return "", ""
	}
	m := me.root.draw()
	if m == nil {
		return "", ""
	}
	return m.name, m.next()
}

// resolvePreferred picks one preference entry at random and expands group names
// (e.g. "Aero") to one of their existing leaves. Returns nil if none of the
// entries resolve to a mood that actually has wallpapers.
func (me *MoodEngine) resolvePreferred(prefs []string) *mood {
	var valid []string
	for _, p := range prefs {
		if len(me.resolveLeaves(p)) > 0 {
			valid = append(valid, p)
		}
	}
	if len(valid) == 0 {
		return nil
	}
	names := me.resolveLeaves(valid[rand.Intn(len(valid))])
	return me.leaves[names[rand.Intn(len(names))]]
}

// resolveLeaves turns a preference entry into the existing leaf names it covers:
// a leaf name -> itself; a group name -> its existing members; otherwise none.
func (me *MoodEngine) resolveLeaves(entry string) []string {
	if _, ok := me.leaves[entry]; ok {
		return []string{entry}
	}
	if members, ok := moodGroups[entry]; ok {
		var out []string
		for _, n := range members {
			if _, ok := me.leaves[n]; ok {
				out = append(out, n)
			}
		}
		return out
	}
	return nil
}

// listWallpapers returns the web paths of the wallpapers in
// static/wallpaper/<folder>, sorted for determinism. It mirrors main.go's
// disk-vs-embedded choice and falls back to the embed if disk reads turn up
// nothing.
func listWallpapers(folder string) []string {
	rel := "wallpaper/" + folder
	var names []string

	if os.Getenv("BABELCOM_USE_DISK_STATIC") == "true" {
		base := os.Getenv("BABELCOM_STATIC_PATH")
		if base == "" {
			base = "./static"
		}
		dir := filepath.Join(base, filepath.FromSlash(rel))
		if entries, err := os.ReadDir(dir); err == nil {
			for _, e := range entries {
				if !e.IsDir() {
					names = append(names, e.Name())
				}
			}
		}
	}

	if names == nil {
		if entries, err := fs.ReadDir(staticFiles, "static/"+rel); err == nil {
			for _, e := range entries {
				if !e.IsDir() {
					names = append(names, e.Name())
				}
			}
		}
	}

	sort.Strings(names)
	out := make([]string, 0, len(names))
	for _, n := range names {
		if strings.HasPrefix(n, ".") || strings.HasPrefix(n, "_") {
			continue
		}
		if !moodImageExts[strings.ToLower(filepath.Ext(n))] {
			continue
		}
		out = append(out, "/static/"+rel+"/"+n)
	}
	return out
}

// setMood caches the latest mood (replayed to new clients on connect) and
// broadcasts it to everyone currently connected.
func (s *Server) setMood(name, wallpaper string) {
	data, err := json.Marshal(map[string]interface{}{
		"type":      "mood_change",
		"mood":      name,
		"wallpaper": wallpaper,
		"changedAt": time.Now().Unix(),
	})
	if err != nil {
		log.Printf("mood: marshal error: %v", err)
		return
	}
	s.mu.Lock()
	s.currentMood = data
	s.mu.Unlock()
	log.Printf("mood: %s -> %s", name, wallpaper)
	s.broadcast(data)
}
