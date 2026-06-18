package babelcom

import (
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// newTestRouter mounts babelcom on a fresh engine in embedded (prod) mode and
// returns it. Setup also builds the asset cache, which is what we're exercising.
func newTestRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	if err := Setup(r); err != nil {
		t.Fatalf("Setup: %v", err)
	}
	return r
}

func do(t *testing.T, r *gin.Engine, method, path string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestIndexHTMLIsRevalidatedAndBusted(t *testing.T) {
	r := newTestRouter(t)
	w := do(t, r, "GET", "/", nil)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("index Cache-Control = %q, want no-cache (instant deploys)", cc)
	}
	if w.Header().Get("ETag") == "" {
		t.Error("index missing ETag")
	}
	// First-party CSS/JS must carry a ?v= content hash; immutable assets are
	// useless without it.
	busted := regexp.MustCompile(`/static/[a-z0-9/_.-]+\.(?:css|js)\?v=[a-f0-9]{8}`)
	body := w.Body.String()
	if !busted.MatchString(body) {
		t.Error("index.html has no ?v=-busted asset references")
	}
	// The external tracker URL must NOT be rewritten.
	if strings.Contains(body, "tianji.johncave.co.nz/tracker.js?v=") {
		t.Error("external script URL was incorrectly cache-busted")
	}
}

func TestStaticAssetImmutableAndCompressed(t *testing.T) {
	r := newTestRouter(t)

	// Brotli negotiated for a text asset.
	w := do(t, r, "GET", "/static/styles.css", map[string]string{"Accept-Encoding": "br, gzip"})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if enc := w.Header().Get("Content-Encoding"); enc != "br" {
		t.Errorf("Content-Encoding = %q, want br", enc)
	}
	if cc := w.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Errorf("Cache-Control = %q, want immutable", cc)
	}
	if v := w.Header().Get("Vary"); !strings.Contains(v, "Accept-Encoding") {
		t.Errorf("Vary = %q, want Accept-Encoding", v)
	}
	brBytes := w.Body.Len()

	// gzip fallback.
	wg := do(t, r, "GET", "/static/styles.css", map[string]string{"Accept-Encoding": "gzip"})
	if enc := wg.Header().Get("Content-Encoding"); enc != "gzip" {
		t.Errorf("gzip Content-Encoding = %q, want gzip", enc)
	}

	// No Accept-Encoding -> identity, and brotli should be smaller than identity.
	wi := do(t, r, "GET", "/static/styles.css", map[string]string{"Accept-Encoding": "identity"})
	if enc := wi.Header().Get("Content-Encoding"); enc != "" {
		t.Errorf("identity Content-Encoding = %q, want empty", enc)
	}
	if brBytes >= wi.Body.Len() {
		t.Errorf("brotli (%d) not smaller than identity (%d)", brBytes, wi.Body.Len())
	}
}

func TestConditionalGet304(t *testing.T) {
	r := newTestRouter(t)
	w := do(t, r, "GET", "/static/styles.css", map[string]string{"Accept-Encoding": "br"})
	etag := w.Header().Get("ETag")
	if etag == "" {
		t.Fatal("no ETag")
	}
	w2 := do(t, r, "GET", "/static/styles.css", map[string]string{
		"Accept-Encoding": "br",
		"If-None-Match":   etag,
	})
	if w2.Code != http.StatusNotModified {
		t.Errorf("revalidation status = %d, want 304", w2.Code)
	}
	if w2.Body.Len() != 0 {
		t.Errorf("304 returned %d body bytes, want 0", w2.Body.Len())
	}
}

func TestImageNotRecompressedAndRangeable(t *testing.T) {
	r := newTestRouter(t)

	// webp is already compressed: no Content-Encoding even when br is offered.
	w := do(t, r, "GET", "/static/wallpaper/Abstract/perfect_hue_3.webp",
		map[string]string{"Accept-Encoding": "br, gzip"})
	if w.Code != http.StatusOK {
		t.Fatalf("webp status = %d, want 200", w.Code)
	}
	if enc := w.Header().Get("Content-Encoding"); enc != "" {
		t.Errorf("webp Content-Encoding = %q, want empty (already compressed)", enc)
	}
	if ct := w.Header().Get("Content-Type"); ct != "image/webp" {
		t.Errorf("webp Content-Type = %q, want image/webp", ct)
	}

	// Identity assets support Range (video seeking).
	wr := do(t, r, "GET", "/static/wallpaper/Empty/353633_medium.mp4",
		map[string]string{"Range": "bytes=0-1023"})
	if wr.Code != http.StatusPartialContent {
		t.Errorf("range status = %d, want 206", wr.Code)
	}
	if cr := wr.Header().Get("Content-Range"); cr == "" {
		t.Error("206 missing Content-Range")
	}
}
