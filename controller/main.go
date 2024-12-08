package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/events"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	"github.com/docker/go-connections/nat"
	"github.com/gorilla/websocket"
)

var (
	DockerClient           *client.Client
	startedContainers      []string
	startedContainersMutex sync.Mutex
	logStreamers           = make(map[string]*ContainerLogStreamer)
	logStreamersMutex      sync.Mutex
)

const appLabel = "simulator"

type ContainerInfo struct {
	ID     string        `json:"id"`
	Names  []string      `json:"names"`
	Image  string        `json:"image"`
	Status string        `json:"status"`
	State  string        `json:"state"`
	Ports  []PortMapping `json:"ports"`
}

type PortMapping struct {
	IP          string `json:"ip"`
	PrivatePort uint16 `json:"private_port"`
	PublicPort  uint16 `json:"public_port"`
	Type        string `json:"type"`
}

type ContainerLogStreamer struct {
	containerID string
	stopChan    chan struct{}
}

type NetworkConfig struct {
	Delay string
	Loss  string
}

// WebSocket variables
var (
	clients   = make(map[*websocket.Conn]bool)
	clientsMu sync.Mutex
	upgrader  = websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool { return true },
	}
)

func listContainers() ([]ContainerInfo, error) {
	ctx := context.Background()

	containers, err := DockerClient.ContainerList(ctx, container.ListOptions{All: false})
	if err != nil {
		return nil, fmt.Errorf("failed to list containers: %w", err)
	}

	containerInfos := make([]ContainerInfo, 0, len(containers))
	for _, c := range containers {
		portMappings := make([]PortMapping, 0, len(c.Ports))
		for _, port := range c.Ports {
			portMappings = append(portMappings, PortMapping{
				IP:          port.IP,
				PrivatePort: port.PrivatePort,
				PublicPort:  port.PublicPort,
				Type:        port.Type,
			})
		}

		containerInfos = append(containerInfos, ContainerInfo{
			ID:     c.ID[:12],
			Names:  c.Names,
			Image:  c.Image,
			Status: c.Status,
			State:  c.State,
			Ports:  portMappings,
		})
	}

	return containerInfos, nil
}

// broadcastContainers sends the current list of running containers to all connected WebSocket clients
func broadcastContainers() {
	containerInfos, err := listContainers()
	if err != nil {
		fmt.Printf("Failed to list containers for broadcast: %v\n", err)
		return
	}

	message := map[string]interface{}{
		"type": "containerList",
		"data": containerInfos,
	}
	data, err := json.Marshal(message)
	if err != nil {
		fmt.Printf("Failed to marshal containers for broadcast: %v\n", err)
		return
	}

	broadcastToClients(data)
}

func broadcastToClients(data []byte) {
	clientsMu.Lock()
	defer clientsMu.Unlock()
	for c := range clients {
		if err := c.WriteMessage(websocket.TextMessage, data); err != nil {
			fmt.Printf("Failed to write message to client: %v\n", err)
			c.Close()
			delete(clients, c)
		}
	}
}

func startContainer(containerID string) error {
	ctx := context.Background()
	if err := DockerClient.ContainerStart(ctx, containerID, container.StartOptions{}); err != nil {
		return fmt.Errorf("failed to start container %s: %w", containerID, err)
	}

	startedContainersMutex.Lock()
	startedContainers = append(startedContainers, containerID)
	startedContainersMutex.Unlock()

	// Broadcast after start
	go broadcastContainers()

	return nil
}

func stopContainer(containerID string) error {
	ctx := context.Background()

	containerJSON, err := DockerClient.ContainerInspect(ctx, containerID)
	if err != nil {
		return fmt.Errorf("failed to inspect container %s: %w", containerID, err)
	}

	timeout := 0
	if !containerJSON.State.Running {
		fmt.Printf("Container %s is not running; skipping stop.\n", containerID)
	} else {
		if err := DockerClient.ContainerStop(ctx, containerID, container.StopOptions{Timeout: &timeout, Signal: "SIGKILL"}); err != nil {
			return fmt.Errorf("failed to stop container %s: %w", containerID, err)
		}
		fmt.Printf("Container %s stopped successfully.\n", containerID)
	}

	stopLogStreaming(containerID)

	// Broadcast after stop
	go broadcastContainers()

	return nil
}

func stopAllContainers() error {
	ctx := context.Background()

	filterArgs := filters.NewArgs()
	filterArgs.Add("label", "managed_by="+appLabel)

	containers, err := DockerClient.ContainerList(ctx, container.ListOptions{All: true, Filters: filterArgs})
	if err != nil {
		return fmt.Errorf("failed to list containers: %w", err)
	}

	var errorsList []string

	for _, c := range containers {
		if c.State == "running" {
			fmt.Printf("Stopping container %s...\n", c.ID)
			timeout := 0
			if err := DockerClient.ContainerStop(ctx, c.ID, container.StopOptions{Timeout: &timeout}); err != nil {
				errMsg := fmt.Sprintf("failed to stop container %s: %v", c.ID, err)
				fmt.Println(errMsg)
				errorsList = append(errorsList, errMsg)
				continue
			}
			fmt.Printf("Container %s stopped successfully.\n", c.ID)
		}

		fmt.Printf("Removing container %s...\n", c.ID)
		if err := DockerClient.ContainerRemove(ctx, c.ID, container.RemoveOptions{}); err != nil {
			errMsg := fmt.Sprintf("failed to remove container %s: %v", c.ID, err)
			fmt.Println(errMsg)
			errorsList = append(errorsList, errMsg)
		} else {
			fmt.Printf("Container %s removed successfully.\n", c.ID)
		}
		stopLogStreaming(c.ID)
	}

	// Broadcast after stop all
	go broadcastContainers()

	if len(errorsList) > 0 {
		return fmt.Errorf("errors occurred while stopping/removing containers: %s", strings.Join(errorsList, "; "))
	}

	return nil
}

func imageExists(cli *client.Client, ctx context.Context, imageName string) (bool, error) {
	images, err := cli.ImageList(ctx, image.ListOptions{})
	if err != nil {
		return false, err
	}

	for _, img := range images {
		for _, tag := range img.RepoTags {
			if tag == imageName {
				return true, nil
			}
		}
	}

	return false, nil
}

func ensureNetwork(cli *client.Client, networkName string) error {
	ctx := context.Background()

	networks, err := cli.NetworkList(ctx, network.ListOptions{
		Filters: filters.NewArgs(filters.Arg("name", networkName)),
	})
	if err != nil {
		return fmt.Errorf("failed to list networks: %w", err)
	}

	if len(networks) == 0 {
		return fmt.Errorf("network %s does not exist", networkName)
	}

	return nil
}

func createAndStartContainer(imageName, containerName string, containerPort int, env []string, hostname string) (string, int, error) {
	ctx := context.Background()
	cli := DockerClient

	networkName := os.Getenv("NETWORK")
	if networkName == "" {
		return "", 0, fmt.Errorf("NETWORK environment variable is not set")
	}

	if err := ensureNetwork(cli, networkName); err != nil {
		return "", 0, fmt.Errorf("network setup failed: %w", err)
	}

	imageExistsLocally, err := imageExists(cli, ctx, imageName)
	if err != nil {
		return "", 0, fmt.Errorf("failed to check if image exists: %w", err)
	}

	if !imageExistsLocally {
		fmt.Printf("Image %s not found locally. Pulling...\n", imageName)
		reader, err := cli.ImagePull(ctx, imageName, image.PullOptions{})
		if err != nil {
			return "", 0, fmt.Errorf("failed to pull image %s: %w", imageName, err)
		}
		defer reader.Close()

		out, _ := io.ReadAll(reader)
		fmt.Printf("Pulling image: %s\n", out)
	} else {
		fmt.Printf("Using local image %s\n", imageName)
	}

	exposedPorts := nat.PortSet{
		nat.Port(fmt.Sprintf("%d/tcp", containerPort)): struct{}{},
	}

	portBindings := nat.PortMap{
		nat.Port(fmt.Sprintf("%d/tcp", containerPort)): []nat.PortBinding{
			{
				HostPort: "0",
			},
		},
	}

	labels := map[string]string{
		"managed_by": appLabel,
	}

	config := &container.Config{
		Image:        imageName,
		ExposedPorts: exposedPorts,
		Labels:       labels,
		Env:          env,
	}

	if hostname != "" {
		config.Hostname = hostname
	}

	hostConfig := &container.HostConfig{
		PortBindings: portBindings,
		NetworkMode:  container.NetworkMode(networkName),
		Privileged:   true,
	}

	resp, err := cli.ContainerCreate(
		ctx,
		config,
		hostConfig,
		nil,
		nil,
		containerName,
	)
	if err != nil {
		return "", 0, fmt.Errorf("failed to create container: %w", err)
	}

	if err := cli.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
		return "", 0, fmt.Errorf("failed to start container: %w", err)
	}

	go startLogStreaming(resp.ID)

	networkConfigStr := getEnvValue(env, "NETWORK_CONFIG")
	if networkConfigStr != "" {
		fmt.Printf("Applying NETWORK_CONFIG to container %s: %s\n", resp.ID[:12], networkConfigStr)
		networkConfig, err := parseNetworkConfig(networkConfigStr)
		if err != nil {
			fmt.Printf("Failed to parse NETWORK_CONFIG for container %s: %v\n", resp.ID[:12], err)
		} else {
			if err := applyNetworkConfig(ctx, cli, resp.ID, networkConfig); err != nil {
				fmt.Printf("Failed to apply NETWORK_CONFIG to container %s: %v\n", resp.ID[:12], err)
			}
		}
	}

	containerJSON, err := cli.ContainerInspect(ctx, resp.ID)
	if err != nil {
		return "", 0, fmt.Errorf("failed to inspect container: %w", err)
	}

	var hostPort int
	portInfo, ok := containerJSON.NetworkSettings.Ports[nat.Port(fmt.Sprintf("%d/tcp", containerPort))]
	if ok && len(portInfo) > 0 {
		hostPort, _ = strconv.Atoi(portInfo[0].HostPort)
	}

	// fmt.Printf("Setting container ID: %s", containerJSON.ID[:12])
	err = setContainerID(hostPort, containerJSON.ID[:12])
	if err != nil {
		fmt.Printf("failed to set container id: %s, %s - stopping container", containerJSON.ID[:12], err)
		err = stopContainer(resp.ID)
		if err != nil {
			fmt.Printf("failed to stop container id: %s", containerJSON.ID[:12])
			return "", 0, err
		}
	}

	// Broadcast after creation/start
	go broadcastContainers()

	return resp.ID, hostPort, nil
}

func setContainerID(hostPort int, containerID string) error {
	const maxRetries = 5
	const retryDelay = time.Second

	var lastErr error
	for i := 1; i <= maxRetries; i++ {
		err := setContainerIDViaWebSocket(hostPort, containerID)
		if err == nil {
			return nil // Success on this attempt
		}
		lastErr = err
		fmt.Printf("Attempt %d/%d failed to set container ID: %v\n", i, maxRetries, err)

		if i < maxRetries {
			time.Sleep(retryDelay)
		}
	}

	return fmt.Errorf("all retries failed: %w", lastErr)
}

func setContainerIDViaWebSocket(hostPort int, containerID string) error {
	url := fmt.Sprintf("ws://localhost:%d", hostPort)
	c, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		return err
	}
	defer c.Close()

	// container sends details on new connection, ignore
	_, _, err = c.ReadMessage()
	if err != nil {
		return err
	}

	msg := map[string]string{
		"type":    "set-id",
		"message": containerID,
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := c.WriteMessage(websocket.TextMessage, data); err != nil {
		return err
	}

	// Optionally, read a response if the container sends one
	_, resp, err := c.ReadMessage()
	if err != nil {
		return err
	} else {
		fmt.Printf("Received response from container: %s\n", string(resp))
	}

	return nil
}

func startLogStreaming(containerID string) {
	ctx := context.Background()

	streamer := &ContainerLogStreamer{
		containerID: containerID,
		stopChan:    make(chan struct{}),
	}

	logStreamersMutex.Lock()
	logStreamers[containerID] = streamer
	logStreamersMutex.Unlock()

	options := container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Follow:     true,
		Tail:       "all",
	}

	out, err := DockerClient.ContainerLogs(ctx, containerID, options)
	if err != nil {
		fmt.Printf("Error getting logs for container %s: %v\n", containerID, err)
		return
	}
	defer out.Close()

	scanner := bufio.NewScanner(out)
	for scanner.Scan() {
		select {
		case <-streamer.stopChan:
			return
		default:
			line := scanner.Text()
			fmt.Printf("[%s] %s\n", containerID[:12], line)
		}
	}
	if err := scanner.Err(); err != nil {
		fmt.Printf("Error reading logs for container %s: %v\n", containerID, err)
	}
}

func stopLogStreaming(containerID string) {
	logStreamersMutex.Lock()
	defer logStreamersMutex.Unlock()

	if streamer, exists := logStreamers[containerID]; exists {
		close(streamer.stopChan)
		delete(logStreamers, containerID)
	}
}

func parseNetworkConfig(configStr string) (*NetworkConfig, error) {
	config := &NetworkConfig{}
	pairs := strings.Split(configStr, " ")
	for _, pair := range pairs {
		kv := strings.SplitN(pair, "=", 2)
		if len(kv) != 2 {
			return nil, fmt.Errorf("invalid network config pair: %s", pair)
		}

		key := strings.ToLower(strings.TrimSpace(kv[0]))
		value := strings.TrimSpace(kv[1])

		switch key {
		case "delay":
			config.Delay = value
		case "loss":
			config.Loss = value
		default:
			return nil, fmt.Errorf("unsupported network config key: %s", key)
		}
	}

	return config, nil
}

func executeTCCommand(ctx context.Context, cli *client.Client, containerID string, cmd []string) error {
	execConfig := container.ExecOptions{
		Cmd:          cmd,
		AttachStdout: true,
		AttachStderr: true,
	}
	execIDResp, err := cli.ContainerExecCreate(ctx, containerID, execConfig)
	if err != nil {
		return fmt.Errorf("failed to create exec instance: %w", err)
	}

	execAttachResp, err := cli.ContainerExecAttach(ctx, execIDResp.ID, container.ExecAttachOptions{})
	if err != nil {
		return fmt.Errorf("failed to attach to exec instance: %w", err)
	}
	defer execAttachResp.Close()

	output, err := io.ReadAll(execAttachResp.Reader)
	if err != nil {
		return fmt.Errorf("failed to read exec output: %w", err)
	}

	execInspect, err := cli.ContainerExecInspect(ctx, execIDResp.ID)
	if err != nil {
		return fmt.Errorf("failed to inspect exec instance: %w", err)
	}

	if execInspect.ExitCode != 0 {
		return fmt.Errorf("command %v exited with code %d: %s", cmd, execInspect.ExitCode, string(output))
	}

	return nil
}

func applyNetworkConfig(ctx context.Context, cli *client.Client, containerID string, config *NetworkConfig) error {
	installCmd := []string{"sh", "-c", "which tc || apk update && apk add iproute2 iptables"}
	if err := executeTCCommand(ctx, cli, containerID, installCmd); err != nil {
		return fmt.Errorf("failed to install iproute2 in container %s: %w", containerID[:12], err)
	}

	delCmd := []string{"tc", "qdisc", "del", "dev", "eth0", "root"}
	if err := executeTCCommand(ctx, cli, containerID, delCmd); err != nil {
		fmt.Printf("Warning: failed to delete existing qdisc for container %s: %v\n", containerID[:12], err)
	}

	var netemParams []string
	if config.Delay != "" {
		netemParams = append(netemParams, "delay", config.Delay)
	}
	if config.Loss != "" {
		netemParams = append(netemParams, "loss", config.Loss)
	}
	if len(netemParams) == 0 {
		return fmt.Errorf("no valid network configurations provided")
	}

	cmd := append([]string{"tc", "qdisc", "add", "dev", "eth0", "root", "netem"}, netemParams...)
	if err := executeTCCommand(ctx, cli, containerID, cmd); err != nil {
		return fmt.Errorf("failed to apply network config to container %s: %w", containerID[:12], err)
	}

	fmt.Printf("Network config applied successfully to container %s: %v\n", containerID[:12], netemParams)
	return nil
}

func getEnvValue(env []string, key string) string {
	prefix := key + "="
	for _, e := range env {
		if strings.HasPrefix(e, prefix) {
			return strings.TrimPrefix(e, prefix)
		}
	}
	return ""
}

// HTTP Handlers
func listContainersHandler(w http.ResponseWriter, r *http.Request) {
	containerInfos, err := listContainers()
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to list containers: %v", err), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(containerInfos)
}

func startContainerHandler(w http.ResponseWriter, r *http.Request) {
	type RequestBody struct {
		ContainerID string `json:"container_id"`
	}
	var reqBody RequestBody
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if err := startContainer(reqBody.ContainerID); err != nil {
		http.Error(w, fmt.Sprintf("Failed to start container %s: %v", reqBody.ContainerID, err), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func stopContainerHandler(w http.ResponseWriter, r *http.Request) {
	type RequestBody struct {
		ContainerID string `json:"container_id"`
	}
	var reqBody RequestBody
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if err := stopContainer(reqBody.ContainerID); err != nil {
		http.Error(w, fmt.Sprintf("Failed to stop container %s: %v", reqBody.ContainerID, err), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func stopAllContainersHandler(w http.ResponseWriter, r *http.Request) {
	if err := stopAllContainers(); err != nil {
		http.Error(w, fmt.Sprintf("Failed to stop all containers: %v", err), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func createContainerHandler(w http.ResponseWriter, r *http.Request) {
	type RequestBody struct {
		Image    string   `json:"image"`
		Name     string   `json:"name,omitempty"`
		Port     int      `json:"port,omitempty"`
		Env      []string `json:"env,omitempty"`
		Hostname string   `json:"hostname,omitempty"`
	}
	var reqBody RequestBody
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if reqBody.Port == 0 {
		http.Error(w, "Port number is required", http.StatusBadRequest)
		return
	}

	containerID, hostPort, err := createAndStartContainer(
		reqBody.Image,
		reqBody.Name,
		reqBody.Port,
		reqBody.Env,
		reqBody.Hostname,
	)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to create and start container: %v", err), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"container_id": containerID,
		"host_port":    hostPort,
	})
}

func wsHandler(w http.ResponseWriter, r *http.Request) {
	// Upgrade to websocket (clients)
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		http.Error(w, "Could not open websocket", http.StatusBadRequest)
		return
	}

	clientsMu.Lock()
	clients[conn] = true
	clientsMu.Unlock()

	// Send current list of containers immediately
	go broadcastContainers()

	// Keep connection alive, read messages
	go func() {
		defer func() {
			clientsMu.Lock()
			delete(clients, conn)
			clientsMu.Unlock()
			conn.Close()
		}()
		for {
			_, _, err := conn.ReadMessage()
			if err != nil {
				// Client disconnected
				return
			}
		}
	}()
}

func wsNodeUpdatesHandler(w http.ResponseWriter, r *http.Request) {
	// Upgrade to websocket for node updates
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		http.Error(w, "Could not open websocket for node updates", http.StatusBadRequest)
		return
	}

	go func() {
		defer conn.Close()

		for {
			mt, message, err := conn.ReadMessage()
			if err != nil {
				fmt.Printf("Error reading message from node: %v\n", err)
				return
			}

			if mt == websocket.TextMessage {
				// Expect message to have a "type": "nodeStatus" field or similar
				// Just broadcast the raw message to clients
				broadcastToClients(message)
			}
		}
	}()
}

func enableCors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

		if r.Method == "OPTIONS" {
			return
		}

		next.ServeHTTP(w, r)
	})
}

func cleanup() {
	fmt.Println("Cleaning up started containers...")

	logStreamersMutex.Lock()
	for containerID, streamer := range logStreamers {
		close(streamer.stopChan)
		delete(logStreamers, containerID)
	}
	logStreamersMutex.Unlock()

	startedContainersMutex.Lock()
	defer startedContainersMutex.Unlock()

	for _, containerID := range startedContainers {
		fmt.Printf("Attempting to stop and remove container %s...\n", containerID)
		timeout := 0
		if err := DockerClient.ContainerStop(context.Background(), containerID, container.StopOptions{Timeout: &timeout}); err != nil {
			fmt.Printf("Error stopping container %s: %v\n", containerID, err)
		}
		if err := DockerClient.ContainerRemove(context.Background(), containerID, container.RemoveOptions{}); err != nil {
			fmt.Printf("Error removing container %s: %v\n", containerID, err)
		}
	}
	startedContainers = nil
}

func main() {
	var err error

	networkName := os.Getenv("NETWORK")
	if networkName == "" {
		log.Fatalf("NETWORK environment variable is not set")
	}

	DockerClient, err = client.NewClientWithOpts(client.FromEnv)
	if err != nil {
		log.Fatalf("Failed to create Docker client: %v", err)
	}

	if err := ensureNetwork(DockerClient, networkName); err != nil {
		log.Fatalf("NETWORK %s does not exist", networkName)
	}

	// Subscribe to Docker events
	go func() {
		ctx := context.Background()
		// We want container start and stop events
		eventFilters := filters.NewArgs()
		eventFilters.Add("type", "container")
		eventFilters.Add("event", "start")
		eventFilters.Add("event", "stop")

		eventsChan, errsChan := DockerClient.Events(ctx, events.ListOptions{Filters: eventFilters})

		for {
			select {
			case event := <-eventsChan:
				// On start/stop event, broadcast the updated list
				if event.Type == events.ContainerEventType && (event.Action == "start" || event.Action == "stop") {
					go broadcastContainers()
				}
			case err := <-errsChan:
				if err != nil && err != io.EOF {
					log.Printf("Error receiving Docker events: %v", err)
				}
				return
			}
		}
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("/containers", listContainersHandler)
	mux.HandleFunc("/containers/start", startContainerHandler)
	mux.HandleFunc("/containers/stop", stopContainerHandler)
	mux.HandleFunc("/containers/create", createContainerHandler)
	mux.HandleFunc("/containers/stopall", stopAllContainersHandler)
	mux.HandleFunc("/ws", wsHandler)
	mux.HandleFunc("/ws/node-updates", wsNodeUpdatesHandler)

	handler := enableCors(mux)

	c := make(chan os.Signal, 1)
	signal.Notify(c, syscall.SIGTERM, os.Interrupt)

	go func() {
		<-c
		cleanup()
		os.Exit(0)
	}()

	fmt.Println("Starting server on port 8080...")
	log.Fatal(http.ListenAndServe(":8080", handler))
}
