// babelcorp is the merged binary serving both the public encyclopedia
// (wiki.* hostnames) and the babelcom art piece (babelcom.* hostnames)
// from a single Go process. Routes are dispatched by Host header.
package main

import (
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/gin-gonic/gin"

	"internet-of-babel/babelcom"
	"internet-of-babel/librarian"
)

func main() {
	gin.SetMode(gin.ReleaseMode)

	wikiEngine := gin.New()
	if err := librarian.Setup(wikiEngine); err != nil {
		log.Fatalf("librarian setup: %v", err)
	}

	babelcomEngine := gin.New()
	if err := babelcom.Setup(babelcomEngine); err != nil {
		log.Fatalf("babelcom setup: %v", err)
	}

	port := ":8080"
	if v := os.Getenv("PORT"); v != "" {
		port = ":" + v
	}

	dispatcher := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch subdomain(r.Host) {
		case "babelcom":
			babelcomEngine.ServeHTTP(w, r)
		case "wiki", "web4":
			wikiEngine.ServeHTTP(w, r)
		default:
			// Bare localhost, IP-based access, or unknown hostname.
			// Default to wiki so curl/dev hits the encyclopedia.
			wikiEngine.ServeHTTP(w, r)
		}
	})

	log.Printf("babelcorp listening on %s (wiki.* + babelcom.* hosts)", port)
	if err := http.ListenAndServe(port, dispatcher); err != nil {
		log.Fatal(err)
	}
}

// subdomain returns the first dotted label of host, with any port stripped.
// "wiki.foo.bar:8080" -> "wiki", "babelcom.localhost" -> "babelcom",
// "localhost" -> "localhost", "127.0.0.1" -> "127".
func subdomain(host string) string {
	if i := strings.IndexByte(host, ':'); i >= 0 {
		host = host[:i]
	}
	if i := strings.IndexByte(host, '.'); i >= 0 {
		return host[:i]
	}
	return host
}
