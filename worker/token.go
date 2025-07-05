package main

import (
	"encoding/json"
	"fmt"
	"log"

	"github.com/gorilla/websocket"
)

var tokenConn *websocket.Conn

func SendReset() {
	if tokenConn == nil {
		return
	}

	message := map[string]interface{}{
		"type": "reset",
	}

	data, err := json.Marshal(message)
	if err != nil {
		log.Printf("Failed to marshal reset message: %v", err)
		return
	}

	err = tokenConn.WriteMessage(websocket.TextMessage, data)
	if err != nil {
		log.Printf("Failed to send reset message: %v", err)
		return
	}

	log.Println("Sent reset message to WebSocket")
}

// SendToken sends a single token to the WebSocket
func SendToken(token string) {
	//return // Disable token sending for now

	if tokenConn == nil {
		return
	}

	message := map[string]interface{}{
		"type":  "token",
		"token": token,
	}

	data, err := json.Marshal(message)
	if err != nil {
		log.Printf("Failed to marshal token: %v", err)
		return
	}

	err = tokenConn.WriteMessage(websocket.TextMessage, data)
	if err != nil {
		log.Printf("Failed to send token: %v", err)
		return
	}

	//log.Printf("Sent token: %s", token)
}

// ConnectTokenWebSocket connects to the token WebSocket
func ConnectTokenWebSocket(url string) error {
	var err error
	tokenConn, _, err = websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		return fmt.Errorf("failed to connect to token WebSocket: %v", err)
	}
	log.Printf("Connected to token WebSocket: %s", url)
	return nil
}
