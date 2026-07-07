#!/bin/bash
# Build script for FN-Terminal Go server

set -e

cd "$(dirname "$0")"

echo "Initializing Go module..."
go mod tidy

echo "Building for Linux amd64..."
CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build -o ../terminal-server -ldflags="-s -w" main.go

echo "Build complete: ../terminal-server"
ls -la ../terminal-server
