# Build stage
FROM golang:alpine AS builder

# Install git and ca-certificates (needed for go mod download)
RUN apk add --no-cache git ca-certificates

# Set working directory
WORKDIR /app

# Copy go mod files
COPY ./go.mod ./go.sum ./

# Download dependencies
RUN go mod download

# Copy source code (cmd/babelcom is the standalone entrypoint; babelcom is the
# package it mounts — no librarian dependency, so it isn't copied).
COPY ./babelcom ./babelcom
COPY ./cmd ./cmd

# Build the application. Output to /server so it doesn't collide with the
# ./babelcom source directory.
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o /server ./cmd/babelcom

# Final stage
FROM alpine:latest

# Install ca-certificates for HTTPS requests
RUN apk --no-cache add ca-certificates

# Create non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

# Set working directory
WORKDIR /app

# Copy the binary from builder stage
COPY --from=builder /server ./babelcom

# Change ownership to non-root user
RUN chown -R appuser:appgroup /app

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 8088

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8088/health || exit 1

# Run the application
CMD ["./babelcom"] 