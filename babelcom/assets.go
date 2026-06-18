package babelcom

import (
	"bytes"
	"compress/gzip"
	"crypto/md5"
	"fmt"
	"io/fs"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/andybalholm/brotli"
	"github.com/gin-gonic/gin"
)

// staticAsset is a single embedded file, prepared once at startup: its ETag and
// (for text) its brotli- and gzip-precompressed variants. Everything here is
// immutable for the life of the process, so we never hash or compress per
// request — we just pick a variant and write it.
type staticAsset struct {
	contentType string
	etag        string
	identity    []byte
	gzip        []byte // nil unless smaller than identity
	brotli      []byte // nil unless smaller than identity
}

// assetCache maps embed paths ("static/styles.css") to prepared assets. Built
// once by buildAssetCache; nil in disk/dev mode (which serves from disk).
var assetCache map[string]*staticAsset

// assetRefRe matches first-party CSS/JS references in index.html so we can append
// a content-hash cache-buster. External URLs (no /static/ prefix) are untouched.
var assetRefRe = regexp.MustCompile(`(src|href)="(/static/[^"?]+\.(?:css|js))"`)

func etagOf(b []byte) string { return fmt.Sprintf(`"%x"`, md5.Sum(b)) }

// isCompressible reports whether precompressing this type is worthwhile. Images,
// video, and woff2 fonts are already compressed — re-compressing them wastes CPU
// and space for ~0 gain.
func isCompressible(contentType string) bool {
	switch {
	case strings.HasPrefix(contentType, "text/"),
		contentType == "application/javascript",
		contentType == "image/svg+xml",
		contentType == "application/json":
		return true
	}
	return false
}

func gzipBytes(b []byte) []byte {
	var buf bytes.Buffer
	w, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	_, _ = w.Write(b)
	_ = w.Close()
	return buf.Bytes()
}

func brotliBytes(b []byte) []byte {
	var buf bytes.Buffer
	w := brotli.NewWriterLevel(&buf, brotli.BestCompression) // level 11
	_, _ = w.Write(b)
	_ = w.Close()
	return buf.Bytes()
}

func newStaticAsset(content []byte, contentType string) *staticAsset {
	a := &staticAsset{contentType: contentType, etag: etagOf(content), identity: content}
	// Skip tiny files: the framing overhead isn't worth it.
	if isCompressible(contentType) && len(content) >= 256 {
		if g := gzipBytes(content); len(g) < len(content) {
			a.gzip = g
		}
		if br := brotliBytes(content); len(br) < len(content) {
			a.brotli = br
		}
	}
	return a
}

// buildAssetCache walks the embedded FS once, preparing every file, then rewrites
// index.html's first-party CSS/JS links with `?v=<etag>` so those assets can be
// served immutable while changes still appear instantly on the next deploy.
func buildAssetCache() error {
	cache := make(map[string]*staticAsset)
	err := fs.WalkDir(staticFiles, "static", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		content, rErr := staticFiles.ReadFile(path)
		if rErr != nil {
			return rErr
		}
		cache[path] = newStaticAsset(content, getContentTypeFromExtension(path))
		return nil
	})
	if err != nil {
		return err
	}

	if idx := cache["static/index.html"]; idx != nil {
		busted := bustAssetRefs(idx.identity, cache)
		cache["static/index.html"] = newStaticAsset(busted, idx.contentType)
	}

	assetCache = cache
	return nil
}

// bustAssetRefs appends `?v=<short etag>` to each first-party CSS/JS reference,
// keyed off that asset's own content hash, so only changed files bust.
func bustAssetRefs(html []byte, cache map[string]*staticAsset) []byte {
	return assetRefRe.ReplaceAllFunc(html, func(m []byte) []byte {
		sub := assetRefRe.FindSubmatch(m)
		attr, url := string(sub[1]), string(sub[2])
		key := "static" + strings.TrimPrefix(url, "/static")
		a := cache[key]
		if a == nil {
			return m
		}
		// etag is `"<hex>"`; take 8 hex chars without the quotes.
		ver := strings.Trim(a.etag, `"`)[:8]
		return []byte(fmt.Sprintf(`%s="%s?v=%s"`, attr, url, ver))
	})
}

// pickEncoding returns the best precompressed variant the client accepts.
func pickEncoding(a *staticAsset, acceptEncoding string) (body []byte, encoding string) {
	if a.brotli != nil && strings.Contains(acceptEncoding, "br") {
		return a.brotli, "br"
	}
	if a.gzip != nil && strings.Contains(acceptEncoding, "gzip") {
		return a.gzip, "gzip"
	}
	return a.identity, ""
}

// serveAsset serves a prepared embedded asset. immutable=true sends a year-long
// immutable cache (for /static/* — busted via ?v=); immutable=false sends
// no-cache + ETag (for the HTML entry — cached but revalidated every load, so a
// deploy is visible immediately). Identity responses go through http.ServeContent
// for free Range + conditional handling (video seeking); compressed responses are
// written directly (Range over a compressed body is meaningless).
func serveAsset(c *gin.Context, path string, immutable bool) {
	a := assetCache[path]
	if a == nil {
		c.String(http.StatusNotFound, "404: File Not Found")
		return
	}

	c.Header("ETag", a.etag)
	c.Header("Vary", "Accept-Encoding")
	if immutable {
		c.Header("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		c.Header("Cache-Control", "no-cache")
	}

	body, encoding := pickEncoding(a, c.GetHeader("Accept-Encoding"))
	if encoding != "" {
		if c.GetHeader("If-None-Match") == a.etag {
			c.Status(http.StatusNotModified)
			return
		}
		c.Header("Content-Encoding", encoding)
		c.Data(http.StatusOK, a.contentType, body)
		return
	}

	// Identity: ServeContent honors the ETag we set (304 / If-Range) and adds
	// Range support. A zero modtime suppresses Last-Modified so ETag drives it.
	c.Header("Content-Type", a.contentType)
	http.ServeContent(c.Writer, c.Request, path, time.Time{}, bytes.NewReader(a.identity))
}
