package babelcom

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

// The clippyjs agent is self-hosted as ES modules under static/vendor. The
// browser refuses to execute a module served as octet-stream, so the static
// handler must label .mjs as JavaScript and actually serve the vendored files.
func TestMjsServedAsJavaScript(t *testing.T) {
	if got := getContentTypeFromExtension("foo.mjs"); got != "application/javascript" {
		t.Fatalf(".mjs content type = %q, want application/javascript", got)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/static/*filepath", customStaticHandler("./static"))

	for _, p := range []string{
		"/static/vendor/clippyjs/dist/index.mjs",
		"/static/vendor/clippyjs/dist/agents/clippy/index.mjs",
		"/static/vendor/clippyjs/dist/agents/clippy/map.mjs",
		"/static/vendor/clippyjs/dist/agents/clippy/agent.mjs",
		"/static/vendor/clippyjs/dist/agents/clippy/sounds-mp3.mjs",
	} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, p, nil))
		if w.Code != http.StatusOK {
			t.Errorf("GET %s = %d, want 200", p, w.Code)
		}
		if ct := w.Header().Get("Content-Type"); ct != "application/javascript" {
			t.Errorf("GET %s content-type = %q, want application/javascript", p, ct)
		}
	}
}
