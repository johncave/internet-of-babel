// babelcom is the standalone babelcom service: the retro-futuristic desktop art
// piece and its WebSocket bus. It serves every host it receives (no dispatcher —
// it's deployed alone on its own hostname).
package main

import (
	"log"
	"os"

	"github.com/gin-gonic/gin"

	"internet-of-babel/babelcom"
)

func main() {
	gin.SetMode(gin.ReleaseMode)

	engine := gin.New()
	if err := babelcom.Setup(engine); err != nil {
		log.Fatalf("babelcom setup: %v", err)
	}

	port := ":8088"
	if v := os.Getenv("PORT"); v != "" {
		port = ":" + v
	}

	log.Printf("babelcom listening on %s", port)
	if err := engine.Run(port); err != nil {
		log.Fatal(err)
	}
}
