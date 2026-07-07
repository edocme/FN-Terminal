package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

type WSMessage struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
	Cols int    `json:"cols,omitempty"`
	Rows int    `json:"rows,omitempty"`
	Code int    `json:"code,omitempty"`
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade error:", err)
		return
	}
	defer conn.Close()

	// Set up ping/pong keepalive
	conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	// Ping goroutine to keep connection alive
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := conn.WriteControl(websocket.PingMessage, []byte{}, time.Now().Add(10*time.Second)); err != nil {
					return
				}
			}
		}
	}()

	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/bash"
	}
	cwd := os.Getenv("HOME")
	if cwd == "" {
		cwd = "/root"
	}

	cmd := exec.Command(shell, "-l")
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"FORCE_COLOR=1",
		"CLICOLOR=1",
		"LS_COLORS=rs=0:di=01;34:ln=01;36:pi=40;33:so=01;35:do=01;35:bd=40;33;01:cd=40;33;01:or=40;31;01:ex=01;32:*.tar=01;31:*.gz=01;31:*.bz2=01;31:*.xz=01;31:*.zip=01;31:*.jpg=01;35:*.jpeg=01;35:*.png=01;35:*.gif=01;35:*.mp3=01;35:*.mp4=01;35",
	)

	ptmx, err := pty.Start(cmd)
	if err != nil {
		log.Println("PTY start error:", err)
		conn.WriteJSON(WSMessage{Type: "exit", Code: 1})
		return
	}
	defer func() {
		ptmx.Close()
		cmd.Process.Kill()
		cmd.Wait()
	}()

	pty.Setsize(ptmx, &pty.Winsize{Rows: 30, Cols: 80})

	done := make(chan bool)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if err != nil {
				break
			}
			msg := WSMessage{Type: "output", Data: string(buf[:n])}
			conn.WriteJSON(msg)
		}
		close(done)
	}()

	go func() {
		for {
			_, message, err := conn.ReadMessage()
			if err != nil {
				break
			}
			var msg WSMessage
			if err := json.Unmarshal(message, &msg); err != nil {
				continue
			}
			switch msg.Type {
			case "input":
				ptmx.Write([]byte(msg.Data))
			case "resize":
				if msg.Cols > 0 && msg.Rows > 0 {
					pty.Setsize(ptmx, &pty.Winsize{Cols: uint16(msg.Cols), Rows: uint16(msg.Rows)})
				}
			}
		}
	}()

	<-done
	conn.WriteJSON(WSMessage{Type: "exit", Code: 0})
}

func main() {
	socketPath := os.Getenv("SOCKET_PATH")
	if socketPath == "" {
		socketPath = "/var/apps/fn-terminal/target/app.sock"
	}

	httpDir := os.Getenv("HTTP_DIR")
	if httpDir == "" {
		httpDir = "../www"
	}

	// Unified routes - no duplicates
	http.Handle("/app/fn-terminal/", http.StripPrefix("/app/fn-terminal", http.FileServer(http.Dir(httpDir))))
	http.HandleFunc("/app/fn-terminal/ws", handleWebSocket)
	http.HandleFunc("/app/fn-terminal/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"status":"ok"}`)
	})

	os.Remove(socketPath)
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		log.Fatal("Failed to create socket:", err)
	}
	defer listener.Close()

	// Secure socket permissions - only owner and group can access
	os.Chmod(socketPath, 0660)

	server := &http.Server{Handler: nil}

	// Graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigChan
		log.Println("Shutting down...")

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.Shutdown(ctx)

		listener.Close()
		os.Remove(socketPath)
	}()

	log.Printf("Terminal server starting on socket: %s", socketPath)
	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
