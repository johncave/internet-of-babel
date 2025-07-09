package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

var generationStatus GenerationStatus

type GenerationStatus struct {
	Title string `json:"title"`
	Phase string `json:"phase"` // Either writing or analyzing
}

type SystemStatus struct {
	Status         string    `json:"status"`
	Uptime         string    `json:"uptime"`
	MemoryUsage    float64   `json:"memory_usage"`
	CPUUsage       float64   `json:"cpu_usage"`
	DiskUsage      float64   `json:"disk_usage"`
	ArticlesCount  int       `json:"articles_count"`
	GenerationRate float64   `json:"generation_rate"`
	LastUpdated    time.Time `json:"last_updated"`
	CurrentTitle   string    `json:"current_title,omitempty"` // Current article title being processed
	CurrentPhase   string    `json:"current_phase,omitempty"` // Current phase of the article
}

type StatusMonitor struct {
	conn      *websocket.Conn
	startTime time.Time
	interval  time.Duration
}

func NewStatusMonitor(websocketURL string, interval time.Duration) *StatusMonitor {
	return &StatusMonitor{
		startTime: time.Now(),
		interval:  interval,
	}
}

func (sm *StatusMonitor) Connect(websocketURL string) error {
	var err error
	sm.conn, _, err = websocket.DefaultDialer.Dial(websocketURL, nil)
	if err != nil {
		return fmt.Errorf("failed to connect to WebSocket: %v", err)
	}
	//log.Printf("Connected to WebSocket: %s", websocketURL)
	return nil
}

func (sm *StatusMonitor) Disconnect() {
	if sm.conn != nil {
		sm.conn.Close()
	}
}

func (sm *StatusMonitor) getUptime() string {
	// duration := time.Since(sm.startTime)
	// hours := int(duration.Hours())
	// minutes := int(duration.Minutes()) % 60
	uptime, err := os.ReadFile("/proc/uptime")
	if err != nil {
		log.Printf("Failed to read uptime: %v", err)
		return "unknown"
	}
	var totalSeconds float64
	_, err = fmt.Sscanf(string(uptime), "%f", &totalSeconds)
	if err != nil {
		log.Printf("Failed to parse uptime: %v", err)
		return "unknown"
	}
	hours := int(totalSeconds / 3600)
	minutes := int(totalSeconds/60) % 60
	return fmt.Sprintf("%dh %dm", hours, minutes)
}

func (sm *StatusMonitor) getCPUUsage() float64 {
	// Simple CPU usage simulation - in a real implementation, you'd use gopsutil
	// For now, return a simulated value that varies over time
	// Get the system's overall CPU usage using /proc/stat
	stat, err := os.ReadFile("/proc/stat")
	if err != nil {
		log.Printf("Failed to read /proc/stat: %v", err)
		return 0.0
	}

	var user, nice, system, idle, iowait, irq, softirq, steal uint64
	_, err = fmt.Sscanf(string(stat), "cpu  %d %d %d %d %d %d %d %d", &user, &nice, &system, &idle, &iowait, &irq, &softirq, &steal)
	if err != nil {
		log.Printf("Failed to parse /proc/stat: %v", err)
		return 0.0
	}

	total := user + nice + system + idle + iowait + irq + softirq + steal
	active := total - idle

	// Calculate CPU usage percentage
	if total == 0 {
		return 0.0
	}
	return float64(active) / float64(total) * 100.0
}

func (sm *StatusMonitor) getMemoryUsage() float64 {
	// Simple memory usage simulation - in a real implementation, you'd use gopsutil
	// For now, return a simulated value that varies over time
	memInfo, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		log.Printf("Failed to read /proc/meminfo: %v", err)
		return 0.0
	}

	var totalMem, freeMem uint64
	lines := strings.Split(string(memInfo), "\n")
	for _, line := range lines {
		if _, err := fmt.Sscanf(line, "MemTotal: %d kB", &totalMem); err == nil {
			continue
		}
		if _, err := fmt.Sscanf(line, "MemAvailable: %d kB", &freeMem); err == nil {
			break
		}
	}

	if totalMem == 0 {
		return 0.0
	}

	usedMem := totalMem - freeMem
	return float64(usedMem) / float64(totalMem) * 100.0
}

func (sm *StatusMonitor) getDiskUsage() float64 {
	// Simple disk usage simulation
	return 45.0
}

func (sm *StatusMonitor) getArticlesCount() int {
	// Count files in the articles directory
	entries, err := os.ReadDir("articles")
	if err != nil {
		return 0
	}
	return len(entries)
}

func (sm *StatusMonitor) getCpuTemperature() float64 {
	// Run 'sensors' and parse for coretemp-isa-0000 section, Core N: temperature
	cmdOutput, err := exec.Command("sensors").Output()
	if err != nil {
		log.Printf("Failed to run sensors: %v", err)
		return 0.0
	}
	lines := strings.Split(string(cmdOutput), "\n")
	inCoretemp := false
	coreTempRe := regexp.MustCompile(`^Core \\d+:\\s+\\+([0-9]+\\.[0-9])\\xB0C`)
	for _, line := range lines {
		if strings.HasPrefix(line, "coretemp-isa-0000") {
			inCoretemp = true
			continue
		}
		if inCoretemp {
			if strings.TrimSpace(line) == "" || (!strings.HasPrefix(line, "Core ")) {
				// End of section or not a core line
				if strings.TrimSpace(line) == "" {
					break
				}
				continue
			}
			matches := coreTempRe.FindStringSubmatch(line)
			if len(matches) == 2 {
				temp, err := strconv.ParseFloat(matches[1], 64)
				if err == nil {
					return temp
				}
			}
		}
	}
	// Not found
	return 0.0
}

func (sm *StatusMonitor) generateStatus() SystemStatus {
	return SystemStatus{
		Status:         "Online",
		Uptime:         sm.getUptime(),
		MemoryUsage:    sm.getMemoryUsage(),
		CPUUsage:       sm.getCPUUsage(),
		DiskUsage:      sm.getDiskUsage(),
		ArticlesCount:  sm.getArticlesCount(),
		GenerationRate: 2.5, // Placeholder - could be calculated from recent activity
		LastUpdated:    time.Now(),
		CurrentTitle:   generationStatus.Title,
		CurrentPhase:   generationStatus.Phase,
	}
}

func (sm *StatusMonitor) sendStatus(status SystemStatus) error {
	message := map[string]interface{}{
		"type": "system_status",
		"data": status,
	}

	data, err := json.Marshal(message)
	if err != nil {
		return fmt.Errorf("failed to marshal status: %v", err)
	}

	err = sm.conn.WriteMessage(websocket.TextMessage, data)
	if err != nil {
		return fmt.Errorf("failed to send status: %v", err)
	}

	//log.Printf("Sent status update: CPU=%.1f%%, Memory=%.1f%%, Uptime=%s",
	//	status.CPUUsage, status.MemoryUsage, status.Uptime)
	return nil
}

func (sm *StatusMonitor) Start(websocketURL string) error {
	log.Printf("Starting status monitor with %v interval", sm.interval)

	// Establish initial connection
	if err := sm.Connect(websocketURL); err != nil {
		return fmt.Errorf("failed to establish initial connection: %v", err)
	}

	// Send initial status
	status := sm.generateStatus()
	if err := sm.sendStatus(status); err != nil {
		log.Printf("Failed to send initial status: %v", err)
	}

	ticker := time.NewTicker(sm.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			status := sm.generateStatus()
			if err := sm.sendStatus(status); err != nil {
				log.Printf("Failed to send status: %v", err)
				// Try to reconnect with exponential backoff
				if err := sm.reconnectWithBackoff(websocketURL); err != nil {
					log.Printf("Failed to reconnect after retries: %v", err)
					return err
				}
			}
		}
	}
}

// reconnectWithBackoff attempts to reconnect with exponential backoff
func (sm *StatusMonitor) reconnectWithBackoff(websocketURL string) error {
	delay := 5 * time.Second
	attempt := 0

	for {
		attempt++
		log.Printf("Attempting to reconnect in %v (attempt %d)...", delay, attempt)
		time.Sleep(delay)

		// Close existing connection if any
		sm.Disconnect()

		// Try to connect
		if err := sm.Connect(websocketURL); err != nil {
			log.Printf("Reconnection attempt %d failed: %v", attempt, err)
			continue
		}

		log.Printf("Successfully reconnected to status WebSocket after %d attempts", attempt)
		return nil
	}
}

// StartStatusMonitor starts the status monitoring in a goroutine with improved retry logic
func StartStatusMonitor(interval time.Duration) {
	go func() {
		monitor := NewStatusMonitor(WebSocketURL, interval)
		for {
			if err := monitor.Start(WebSocketURL); err != nil {
				log.Printf("Status monitor error: %v", err)
				log.Printf("Restarting status monitor in 30 seconds...")
				time.Sleep(30 * time.Second)
			}
		}
	}()
}

// SendManualStatusUpdate sends a status update immediately
func SendManualStatusUpdate() {
	// Create a temporary monitor to send one status update
	monitor := NewStatusMonitor("", 0) // URL and interval don't matter for manual send

	// Try to connect to the WebSocket
	if err := monitor.Connect(WebSocketURL); err != nil {
		log.Printf("Failed to connect for manual status update: %v", err)
		return
	}
	defer monitor.Disconnect()

	// Generate and send status
	status := monitor.generateStatus()
	if err := monitor.sendStatus(status); err != nil {
		log.Printf("Failed to send manual status update: %v", err)
	}
}
