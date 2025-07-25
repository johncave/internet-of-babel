package main

import (
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// Global constants
var WebSocketURL = getEnv("WEBSOCKET_URL", "ws://localhost:8080/ws/llm")

var shutdownRequested bool
var done chan (bool)

func init() {
	go work()

	// Start status monitor to send system status to WebSocket
	interval := 10 * time.Second // Send status every 10 seconds
	StartStatusMonitor(interval)

	// Token WebSocket connection is now managed automatically by tokenConnectionManager
}

func main() {
	sigs := make(chan os.Signal, 1)
	done = make(chan bool, 1)

	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		sig := <-sigs
		fmt.Println()
		log.Print("Signal: ", sig)
		log.Println("Worker will now finish remaining work and exit")
		shutdownRequested = true

		// Stop the token worker gracefully
		log.Println("Stopping token worker...")
		StopTokenWorker()

		//done <- true
	}()

	log.Println("Worker started...")
	<-done
	fmt.Println("Worker exiting")
}
