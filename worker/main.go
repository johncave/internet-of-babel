package main

import (
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"
)

var shutdownRequested bool
var done chan (bool)

func init() {
	go work()

	// Start status monitor to send system status to WebSocket
	websocketURL := "ws://localhost:8080/ws/llm?api_key=babelcom-secret-key"
	interval := 10 * time.Second // Send status every 10 seconds
	StartStatusMonitor(websocketURL, interval)

	// Connect to token WebSocket
	if err := ConnectTokenWebSocket(websocketURL); err != nil {
		log.Printf("Failed to connect to token WebSocket: %v", err)
	}
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
		//done <- true
	}()

	log.Println("Worker started...")
	<-done
	fmt.Println("Worker exiting")
}
