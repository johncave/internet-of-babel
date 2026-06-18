// librarian is the standalone public encyclopedia service: it renders the
// generated article corpus into a browsable wiki and exposes the upload and
// clippy-comment write APIs. Served alone on its own hostname(s).
package main

import (
	"log"
	"os"

	"github.com/gin-gonic/gin"

	"internet-of-babel/librarian"
)

func main() {
	gin.SetMode(gin.ReleaseMode)

	engine := gin.New()
	if err := librarian.Setup(engine); err != nil {
		log.Fatalf("librarian setup: %v", err)
	}

	port := ":8080"
	if v := os.Getenv("PORT"); v != "" {
		port = ":" + v
	}

	log.Printf("librarian listening on %s", port)
	if err := engine.Run(port); err != nil {
		log.Fatal(err)
	}
}
