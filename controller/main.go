package main

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"math/rand/v2"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
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
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/docker/go-connections/nat"
	"github.com/gorilla/websocket"
)

var (
	DockerClient        *client.Client
	runningContainers   []string
	runningContainersMu sync.Mutex
	logStreamers        = make(map[string]*ContainerLogStreamer)
	logStreamersMu      sync.Mutex

	// Map to track container WebSocket connections
	containerConns   = make(map[string]*websocket.Conn)
	containerConnsMu sync.RWMutex

	// Map to track frontend connections
	clients   = make(map[*websocket.Conn]bool)
	clientsMu sync.RWMutex
	upgrader  = websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool { return true },
	}
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

type ContainerWSReq struct {
	MType   string `json:"mType"`
	Message string `json:"message"`
	Topic   string `json:"topic,omitempty"`
}

type prefixWriter struct {
	prefix string
	out    io.Writer
}

func (pw *prefixWriter) Write(p []byte) (int, error) {
	parts := bytes.Split(p, []byte("\n"))
	for i, line := range parts {
		// skip the final empty trailing line if p ends with '\n'
		if i == len(parts)-1 && len(line) == 0 {
			continue
		}
		if _, err := fmt.Fprintf(pw.out, "[%s] %s\n", pw.prefix, line); err != nil {
			return 0, err // on error, report it
		}
	}
	return len(p), nil // signal that we've consumed all of p
}

func listContainers(ctx context.Context) ([]ContainerInfo, error) {
	containers, err := DockerClient.ContainerList(
		ctx,
		container.ListOptions{
			All:     false,
			Filters: filters.NewArgs(filters.Arg("status", "running")),
		},
	)
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
	ctx := context.Background()

	containerInfos, err := listContainers(ctx)
	if err != nil {
		fmt.Printf("Failed to list containers for broadcast: %v\n", err)
		return
	}
	// fmt.Printf("Broadcasting %d containers info\n", len(containerInfos))

	message := map[string]any{
		"mType": "containerList",
		"data":  containerInfos,
	}
	data, err := json.Marshal(message)
	if err != nil {
		fmt.Printf("Failed to marshal containers for broadcast: %v\n", err)
		return
	}

	broadcastToClients(data)
}

func broadcastToClients(data []byte) {
	// log.Printf("broadcasting to %d clients\n", len(clients))
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

func startContainer(ctx context.Context, containerID string) error {
	if err := DockerClient.ContainerStart(ctx, containerID, container.StartOptions{}); err != nil {
		return fmt.Errorf("failed to start container %s: %w", containerID, err)
	}

	runningContainersMu.Lock()
	runningContainers = append(runningContainers, containerID)
	runningContainersMu.Unlock()

	// Broadcast after start
	go broadcastContainers()

	return nil
}

func stopContainer(ctx context.Context, containerID string) error {
	containerJSON, err := DockerClient.ContainerInspect(ctx, containerID)
	if err != nil {
		return fmt.Errorf("failed to inspect container %s: %w", containerID, err)
	}

	timeout := 1
	if containerJSON.State.Running {
		if err := DockerClient.ContainerStop(ctx, containerID, container.StopOptions{Timeout: &timeout, Signal: "SIGKILL"}); err != nil {
			return fmt.Errorf("failed to stop container %s: %w", containerID, err)
		}
		fmt.Printf("Container %s stopped successfully.\n", containerID)
	} else {
		fmt.Printf("Container %s is not running; skipping stop.\n", containerID)
	}

	stopLogStreaming(containerID)

	// Close the container's WebSocket connection if it exists
	closeContainerConn(containerID)

	// Broadcast after stop
	go broadcastContainers()

	return nil
}

func stopAllContainers(ctx context.Context) error {
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

		// Close the container's WebSocket connection if it exists
		closeContainerConn(c.ID[:12])
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
		if slices.Contains(img.RepoTags, imageName) {
			return true, nil
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

func createAndStartContainer(ctx context.Context, imageName, containerName string, containerPort int, env []string, hostname string) (string, int, error) {
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

	// fmt.Printf("env: %v\n", env)

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

	go func(hostPort int, containerID string) {
		err := setContainerIDAndListen(hostPort, containerID)
		if err != nil {
			fmt.Printf("failed to set container id: %s, %s - stopping container\n", containerJSON.ID[:12], err)

			stopErr := stopContainer(ctx, resp.ID)
			if stopErr != nil {
				fmt.Printf("failed to stop container id: %s %s\n", containerJSON.ID[:12], stopErr)
			}
		} else {
			log.Printf("Set id for container %s", containerID)
		}

		go broadcastContainers()
	}(hostPort, containerJSON.ID[:12])

	// Broadcast after creation/start

	return resp.ID, hostPort, nil
}

func setContainerIDAndListen(hostPort int, containerID string) error {
	// over 5 seconds
	const maxRetries = 250
	const retryDelay = 20 * time.Millisecond

	var lastErr error
	for i := 1; i <= maxRetries; i++ {
		err := setContainerIDViaWebSocketAndListen(hostPort, containerID)
		if err == nil {
			return nil
		}
		lastErr = err
		fmt.Printf("Attempt %d/%d failed to set container ID %s and listen: %v\n", i, maxRetries, containerID, err)
		if i < maxRetries {
			time.Sleep(retryDelay)
		}
	}

	return fmt.Errorf("all attempts to set id failed: %s", lastErr)
}

func setContainerIDViaWebSocketAndListen(hostPort int, containerID string) error {
	url := fmt.Sprintf("ws://localhost:%d", hostPort)
	c, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		return err
	}

	// Read the initial message from the container if any
	_, _, err = c.ReadMessage()
	if err != nil {
		c.Close()
		return fmt.Errorf("failed to read initial message: %w", err)
	}

	msg := &ContainerWSReq{
		MType:   "set-id",
		Message: containerID,
	}

	data, err := json.Marshal(msg)
	if err != nil {
		c.Close()
		return fmt.Errorf("failed to marshal set-id message: %w", err)
	}

	c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := c.WriteMessage(websocket.TextMessage, data); err != nil {
		c.Close()
		return fmt.Errorf("failed to send set-id message: %w", err)
	}

	// Read response from container confirming the ID is set
	_, resp, err := c.ReadMessage()
	if err != nil {
		c.Close()
		return fmt.Errorf("failed to read response after set-id: %w", err)
	}
	// fmt.Printf("Received response from container after set-id: %s\n", string(resp))

	// Store the container connection
	setContainerConn(containerID, c)

	// send list of containers before sending this nodeStatus update
	broadcastContainers()

	outMsg, err := addTypeToMessage(resp, "nodeStatus")
	if err != nil {
		return fmt.Errorf("error adding type to message: %s", err)
	}

	// fmt.Printf("sending %s", outMsg)
	broadcastToClients(outMsg)

	// Start a goroutine to continuously read messages (node updates) from the container
	go func(containerID string, conn *websocket.Conn) {
		defer func() {
			closeContainerConn(containerID)
		}()

		for {
			mt, message, err := conn.ReadMessage()
			if err != nil {
				fmt.Printf("Error reading node updates from container %s: %v\n", containerID, err)
				return
			}

			// fmt.Printf("Received %s", message)

			if mt == websocket.TextMessage {
				outMsg, err := addTypeToMessage(message, "nodeStatus")
				if err != nil {
					fmt.Printf("Error adding type to message: %s", err)
					continue
				}

				// fmt.Printf("sending %s", outMsg)
				broadcastToClients(outMsg)
			}
		}
	}(containerID, c)

	return nil
}

func addTypeToMessage(msg []byte, msgType string) ([]byte, error) {
	var original map[string]any
	err := json.Unmarshal(msg, &original)
	if err != nil {
		return nil, err
	}

	original["mType"] = msgType

	return json.Marshal(original)
}

// Container connection management
func setContainerConn(containerID string, conn *websocket.Conn) {
	containerConnsMu.Lock()
	containerConns[containerID] = conn
	containerConnsMu.Unlock()
}

func closeContainerConn(containerID string) {
	containerConnsMu.Lock()
	if conn, ok := containerConns[containerID]; ok {
		conn.Close()
		delete(containerConns, containerID)
	}
	containerConnsMu.Unlock()

	runningContainersMu.Lock()
	runningContainers = removeValue(runningContainers, containerID)
	runningContainersMu.Unlock()
}

func removeValue(s []string, val string) []string {
	for i, v := range s {
		if v == val {
			return slices.Delete(s, i, i+1)
		}
	}
	return s
}

func startLogStreaming(containerID string) {
	ctx := context.Background()

	streamer := &ContainerLogStreamer{
		containerID: containerID,
		stopChan:    make(chan struct{}),
	}

	logStreamersMu.Lock()
	logStreamers[containerID] = streamer
	logStreamersMu.Unlock()

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

	pw := &prefixWriter{prefix: containerID[:12], out: os.Stdout}

	go func() {
		_, err := stdcopy.StdCopy(pw, pw, out)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error demultiplexing logs for %s: %v\n", containerID, err)
		}
	}()

	// Wait for stop signal
	<-streamer.stopChan
}

func stopLogStreaming(containerID string) {
	logStreamersMu.Lock()
	defer logStreamersMu.Unlock()

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

	// setup two-band prio qdisc so only internal traffic between containers is delayed/lossy
	bandCmd := []string{"tc", "qdisc", "add", "dev", "eth0", "root", "handle", "1:", "prio", "bands", "2", "priomap", "0", "0", "0", "0", "0", "0", "0", "0"}
	if err := executeTCCommand(ctx, cli, containerID, bandCmd); err != nil {
		return fmt.Errorf("failed to setup two band prio qdisc to container %s: %w", containerID[:12], err)
	}

	// apply delay / loss config for band 2
	configCmd := append([]string{"tc", "qdisc", "add", "dev", "eth0", "parent", "1:2", "handle", "20:", "netem"}, netemParams...)
	if err := executeTCCommand(ctx, cli, containerID, configCmd); err != nil {
		return fmt.Errorf("failed to apply network config to container %s: %w", containerID[:12], err)
	}

	// apply filter to match 172.20.0.0/16 docker network
	filterCmd := []string{"tc", "filter", "add", "dev", "eth0", "protocol", "ip", "parent", "1:", "prio", "1", "u32", "match", "ip", "dst", "172.20.0.0/16", "flowid", "1:2"}
	if err := executeTCCommand(ctx, cli, containerID, filterCmd); err != nil {
		return fmt.Errorf("failed to apply 172.20.0.0./16 filter to container %s: %w", containerID[:12], err)
	}

	// cmd := append([]string{"tc", "qdisc", "add", "dev", "eth0", "root", "netem"}, netemParams...)
	// if err := executeTCCommand(ctx, cli, containerID, cmd); err != nil {
	// 	return fmt.Errorf("failed to apply network config to container %s: %w", containerID[:12], err)
	// }

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
	containerInfos, err := listContainers(r.Context())
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

	if err := startContainer(r.Context(), reqBody.ContainerID); err != nil {
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

	if err := stopContainer(r.Context(), reqBody.ContainerID); err != nil {
		http.Error(w, fmt.Sprintf("Failed to stop container %s: %v", reqBody.ContainerID, err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func stopAllContainersHandler(w http.ResponseWriter, r *http.Request) {
	if err := stopAllContainers(r.Context()); err != nil {
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
		r.Context(),
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
	json.NewEncoder(w).Encode(map[string]any{
		"container_id": containerID,
		"host_port":    hostPort,
	})
}

func getRandomContainerConn() (string, *websocket.Conn) {
	containerConnsMu.RLock()
	defer containerConnsMu.RUnlock()

	if len(containerConns) == 0 {
		return "", nil
	}

	// Gather all containerIDs into a slice
	keys := make([]string, 0, len(containerConns))
	for cid := range containerConns {
		keys = append(keys, cid)
	}

	// Pick a random key
	randomKey := keys[rand.IntN(len(keys))]

	return randomKey, containerConns[randomKey]
}

// func getRandomColor() string {
// 	letters := "0123456789ABCDEF"
// 	color := "#"
// 	for i := 0; i < 6; i++ {
// 		idx := rand.IntN(16)
// 		color += string(letters[idx])
// 	}
// 	return color
// }

func getRandomColorV2() string {
	for {
		// Generate random color
		colorVal := rand.IntN(0xFFFFFF + 1)
		r := uint8((colorVal >> 16) & 0xFF)
		g := uint8((colorVal >> 8) & 0xFF)
		b := uint8(colorVal & 0xFF)

		// Inline channel luminance calculation:
		// Converts a channel from 0–255 to a linearized RGB value.
		channelLuminance := func(c uint8) float64 {
			sc := float64(c) / 255.0
			if sc <= 0.03928 {
				return sc / 12.92
			}
			return math.Pow((sc+0.055)/1.055, 2.4)
		}

		// Calculate relative luminance for the generated color
		R := channelLuminance(r)
		G := channelLuminance(g)
		B := channelLuminance(b)
		bgLum := 0.2126*R + 0.7152*G + 0.0722*B

		whiteLum := 1.0 // approximate luminance of white
		var brighter, darker float64
		if bgLum > whiteLum {
			brighter = bgLum
			darker = whiteLum
		} else {
			brighter = whiteLum
			darker = bgLum
		}

		// Contrast ratio calculation
		ratio := (brighter + 0.05) / (darker + 0.05)

		// If contrast ratio is acceptable (>= 4.5), return the color
		if ratio >= 4.5 {
			return fmt.Sprintf("#%06X", colorVal)
		}
	}
}

func publishHandler(w http.ResponseWriter, r *http.Request) {
	type RequestBody struct {
		Amount      int    `json:"amount"`
		Topic       string `json:"topic,omitempty"`
		ContainerID string `json:"containerId,omitempty"`
	}

	var reqBody RequestBody
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	amount := 1
	if reqBody.Amount <= 0 {
		amount = 1
	} else {
		amount = reqBody.Amount
	}

	containerID := ""
	var c *websocket.Conn

	for range amount {
		if reqBody.ContainerID != "" {
			var ok bool
			containerID = reqBody.ContainerID
			containerConnsMu.RLock()
			{
				c, ok = containerConns[containerID]
			}
			containerConnsMu.RUnlock()

			if !ok {
				http.Error(w, fmt.Sprintf("Failed to find container in conns id: %v", containerID), http.StatusInternalServerError)
				return
			}
		} else {
			containerID, c = getRandomContainerConn()
		}

		if c == nil {
			http.Error(w, fmt.Sprintf("Failed to write 'publish' to container - container not found: %s", containerID), http.StatusInternalServerError)
			return
		}

		message := &ContainerWSReq{
			MType:   "publish",
			Message: getRandomColorV2(),
			Topic:   reqBody.Topic,
		}

		msg, err := json.Marshal(message)
		if err != nil {
			http.Error(w, fmt.Sprintf("Failed to marshal: %v", err), http.StatusInternalServerError)
			return
		}

		c.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if err := c.WriteMessage(websocket.TextMessage, msg); err != nil {
			c.Close()
			http.Error(w, fmt.Sprintf("Failed to write 'publish' to container: %s, %v", containerID, err), http.StatusInternalServerError)
			return
		}
	}

	w.WriteHeader(http.StatusCreated)
}

// connectHandler sends a message to a container to connect to another host
func connectHandler(w http.ResponseWriter, r *http.Request) {
	type RequestBody struct {
		ContainerID  string `json:"containerId"`
		ToMultiaddrs string `json:"toMultiaddrs"` // comma separated string
	}

	var reqBody RequestBody
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	var c *websocket.Conn

	if reqBody.ContainerID == "" {
		http.Error(w, "Failed - FromContainerID is empty", http.StatusInternalServerError)
		return
	}

	var ok bool
	containerID := reqBody.ContainerID
	containerConnsMu.RLock()
	{
		c, ok = containerConns[containerID]
	}
	containerConnsMu.RUnlock()
	if !ok {
		http.Error(w, fmt.Sprintf("Failed to find container in conns id: %v", containerID), http.StatusInternalServerError)
		return
	}

	if c == nil {
		http.Error(w, fmt.Sprintf("container is nil: %s", containerID), http.StatusInternalServerError)
		return
	}

	message := &ContainerWSReq{
		MType:   "connect",
		Message: reqBody.ToMultiaddrs,
	}

	msg, err := json.Marshal(message)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal: %v", err), http.StatusInternalServerError)
		return
	}

	c.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := c.WriteMessage(websocket.TextMessage, msg); err != nil {
		c.Close()
		http.Error(w, fmt.Sprintf("Failed to write 'connect' to container: %s, %v", containerID, err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
}

// logHandler sends logs for a container
func logHandler(w http.ResponseWriter, r *http.Request) {
	type RequestBody struct {
		ContainerID string `json:"container_id"`
	}

	var reqBody RequestBody
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		log.Printf("logHandler: Failed to decode request body: %v", err)
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	var c *websocket.Conn

	if reqBody.ContainerID == "" {
		log.Printf("logHandler: container_id is empty")
		http.Error(w, "Failed - container_id is empty", http.StatusInternalServerError)
		return
	}

	var ok bool
	containerID := reqBody.ContainerID
	containerConnsMu.RLock()
	{
		c, ok = containerConns[containerID]
	}
	containerConnsMu.RUnlock()
	if !ok {
		log.Printf("logHandler: Failed to find container in conns id: %s", containerID)
		http.Error(w, fmt.Sprintf("Failed to find container in conns id: %s", containerID), http.StatusInternalServerError)
		return
	}

	if c == nil {
		log.Printf("logHandler: Container is nil: %s", containerID)
		http.Error(w, fmt.Sprintf("Container is nil: %s", containerID), http.StatusInternalServerError)
		return
	}

	logOptions := container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Timestamps: true,
		Details:    false,
	}

	lrc, err := DockerClient.ContainerLogs(context.Background(), containerID, logOptions)
	if err != nil {
		log.Printf("logHandler: failed getting container logs: %s", containerID)
		http.Error(w, fmt.Sprintf("failed getting container logs: %s", containerID), http.StatusInternalServerError)
		return
	}

	defer lrc.Close()

	var logs bytes.Buffer
	_, err = stdcopy.StdCopy(&logs, &logs, lrc)
	if err != nil {
		log.Printf("logHandler: failed copying container logs: %s", containerID)
		http.Error(w, fmt.Sprintf("failed copying container logs: %s", containerID), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
	w.Write(logs.Bytes())
}

// tcpdumpStartHandler start tcpdump on a container
func tcpdumpStartHandler(w http.ResponseWriter, r *http.Request) {
	type RequestBody struct {
		ContainerID string `json:"container_id"`
	}

	var reqBody RequestBody
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		log.Printf("logHandler: Failed to decode request body: %v", err)
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	var c *websocket.Conn

	if reqBody.ContainerID == "" {
		log.Printf("logHandler: container_id is empty")
		http.Error(w, "Failed - container_id is empty", http.StatusInternalServerError)
		return
	}

	var ok bool
	containerID := reqBody.ContainerID
	containerConnsMu.RLock()
	{
		c, ok = containerConns[containerID]
	}
	containerConnsMu.RUnlock()
	if !ok {
		log.Printf("logHandler: Failed to find container id: %s", containerID)
		http.Error(w, fmt.Sprintf("Failed to find container id: %s", containerID), http.StatusInternalServerError)
		return
	}

	if c == nil {
		log.Printf("logHandler: Container is nil: %s", containerID)
		http.Error(w, fmt.Sprintf("Container is nil: %s", containerID), http.StatusInternalServerError)
		return
	}

	filename := fmt.Sprintf("/tmp/%s.pcap", containerID)
	ctx := r.Context()

	execConfig := container.ExecOptions{
		Cmd:    []string{"sh", "-c", fmt.Sprintf("tcpdump -w %s", filename)},
		Detach: true,
		Tty:    false,
	}
	execResp, err := DockerClient.ContainerExecCreate(ctx, containerID, execConfig)
	if err != nil {
		http.Error(w, "failed to create tcpdump exec: "+err.Error(), http.StatusInternalServerError)
		return
	}

	startOpts := container.ExecStartOptions{Detach: true, Tty: false}
	if err := DockerClient.ContainerExecStart(ctx, execResp.ID, startOpts); err != nil {
		http.Error(w, "failed to start tcpdump: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusAccepted)
}

// tcpdumpStopHandler stops tcpdump and downloads the pcap file
func tcpdumpStopHandler(w http.ResponseWriter, r *http.Request) {
	type RequestBody struct {
		ContainerID string `json:"container_id"`
	}

	var reqBody RequestBody
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		log.Printf("logHandler: Failed to decode request body: %v", err)
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	var c *websocket.Conn

	if reqBody.ContainerID == "" {
		log.Printf("logHandler: container_id is empty")
		http.Error(w, "Failed - container_id is empty", http.StatusInternalServerError)
		return
	}

	var ok bool
	containerID := reqBody.ContainerID
	containerConnsMu.RLock()
	{
		c, ok = containerConns[containerID]
	}
	containerConnsMu.RUnlock()
	if !ok {
		log.Printf("logHandler: Failed to find container id: %s", containerID)
		http.Error(w, fmt.Sprintf("Failed to find container id: %s", containerID), http.StatusInternalServerError)
		return
	}

	if c == nil {
		log.Printf("logHandler: Container is nil: %s", containerID)
		http.Error(w, fmt.Sprintf("Container is nil: %s", containerID), http.StatusInternalServerError)
		return
	}

	filename := fmt.Sprintf("/tmp/%s.pcap", containerID)
	ctx := r.Context()

	// Best‑effort stop of tcpdump
	killExecConfig := container.ExecOptions{
		Cmd:          []string{"pkill", "tcpdump"},
		AttachStdout: true,
		AttachStderr: true,
	}
	if killResp, err := DockerClient.ContainerExecCreate(ctx, containerID, killExecConfig); err == nil {
		// run synchronously so we wait for the process to exit
		stopOpts := container.ExecStartOptions{Detach: false, Tty: false}
		_ = DockerClient.ContainerExecStart(ctx, killResp.ID, stopOpts)
	}

	// Copy the .pcap out of the container
	reader, stat, err := DockerClient.CopyFromContainer(ctx, containerID, filename)
	if err != nil {
		http.Error(w, "failed to copy pcap: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer reader.Close()

	w.Header().Set("Content-Type", "application/vnd.tcpdump.pcap")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.pcap"`, containerID))

	tr := tar.NewReader(reader)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		} else if err != nil {
			http.Error(w, "tar read error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		if strings.HasSuffix(hdr.Name, stat.Name) ||
			filepath.Base(hdr.Name) == filepath.Base(filename) {
			if _, err := io.Copy(w, tr); err != nil {
				http.Error(w, "failed streaming pcap: "+err.Error(), http.StatusInternalServerError)
			}
			return
		}
	}

	http.Error(w, "pcap not found in archive", http.StatusInternalServerError)
}

// dhtProvideHandler
func dhtProvideHandler(w http.ResponseWriter, r *http.Request) {
	type RequestBody struct {
		ContainerID string `json:"container_id"`
		CID         string `json:"cid"`
	}

	var reqBody RequestBody
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		log.Printf("dhtProviderHandler: Failed to decode request body: %v", err)
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	var c *websocket.Conn

	if reqBody.ContainerID == "" {
		log.Printf("dhtProvideHandler: container_id is empty")
		http.Error(w, "Failed - container_id is empty", http.StatusInternalServerError)
		return
	}

	var ok bool
	containerID := reqBody.ContainerID
	containerConnsMu.RLock()
	{
		c, ok = containerConns[containerID]
	}
	containerConnsMu.RUnlock()
	if !ok {
		log.Printf("dhtProvideHandler: Failed to find container in conns id: %s", containerID)
		http.Error(w, fmt.Sprintf("Failed to find container in conns id: %s", containerID), http.StatusInternalServerError)
		return
	}

	if c == nil {
		log.Printf("dhtProvideHandler: Container is nil: %s", containerID)
		http.Error(w, fmt.Sprintf("Container is nil: %s", containerID), http.StatusInternalServerError)
		return
	}

	message := &ContainerWSReq{
		MType:   "dhtprovide",
		Message: reqBody.CID,
	}

	msg, err := json.Marshal(message)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to marshal: %v", err), http.StatusInternalServerError)
		return
	}

	c.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if err := c.WriteMessage(websocket.TextMessage, msg); err != nil {
		c.Close()
		http.Error(w, fmt.Sprintf("Failed to write 'publish' to container: %s, %v", containerID, err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
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

func enableCors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

		if r.Method == "OPTIONS" {
			w.Header().Set("Access-Control-Max-Age", "3600")
			return
		}

		next.ServeHTTP(w, r)
	})
}

func cleanup(ctx context.Context) {
	fmt.Println("Cleaning up started containers...")

	logStreamersMu.Lock()
	{
		for containerID, streamer := range logStreamers {
			close(streamer.stopChan)
			delete(logStreamers, containerID)
		}
	}
	logStreamersMu.Unlock()

	for _, containerID := range runningContainers {
		closeContainerConn(containerID) // Ensure connections are closed
		fmt.Printf("Attempting to stop and remove container %s...\n", containerID)

		runningContainersMu.Lock()
		ctxTo, cancel := context.WithTimeout(ctx, 5*time.Second)
		timeout := 1

		if err := DockerClient.ContainerStop(ctxTo, containerID, container.StopOptions{Timeout: &timeout}); err != nil {
			fmt.Printf("Error stopping container %s: %v\n", containerID, err)
		}

		if err := DockerClient.ContainerRemove(ctxTo, containerID, container.RemoveOptions{}); err != nil {
			fmt.Printf("Error removing container %s: %v\n", containerID, err)
		}
		runningContainersMu.Unlock()

		cancel()
	}

	runningContainers = nil
}

func repopulateState() {
	ctx := context.Background()

	// List all running containers
	containers, err := DockerClient.ContainerList(ctx, container.ListOptions{
		All:     false,
		Filters: filters.NewArgs(filters.Arg("status", "running")),
	})
	if err != nil {
		log.Fatalf("Failed to list running containers: %v", err)
	}

	runningContainersMu.Lock()
	defer runningContainersMu.Unlock()

	for _, c := range containers {
		containerID := c.ID[:12]
		runningContainers = append(runningContainers, containerID)

		// Attempt to reconnect WebSocket for the container
		hostPort := 0
		for _, port := range c.Ports {
			if port.Type == "tcp" {
				hostPort = int(port.PublicPort)
				break
			}
		}

		if hostPort > 0 {
			go func(containerID string, hostPort int) {
				err := setContainerIDAndListen(hostPort, containerID)
				if err != nil {
					log.Printf("Failed to re-establish WebSocket for container %s: %v", containerID, err)
				} else {
					log.Printf("Re-established WebSocket for container %s", containerID)
				}
			}(containerID, hostPort)
		} else {
			log.Printf("No accessible TCP port found for container %s; skipping WebSocket reconnection.", containerID)
		}
	}

	log.Printf("Repopulated state: %d containers", len(runningContainers))
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

	repopulateState()

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

	go func() {
		for {
			time.Sleep(5 * time.Second)
			broadcastContainers()
		}
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("/containers", listContainersHandler)
	mux.HandleFunc("/containers/start", startContainerHandler)
	mux.HandleFunc("/containers/stop", stopContainerHandler)
	mux.HandleFunc("/containers/create", createContainerHandler)
	mux.HandleFunc("/containers/stopall", stopAllContainersHandler)
	mux.HandleFunc("/publish", publishHandler)
	mux.HandleFunc("/connect", connectHandler)
	mux.HandleFunc("POST /logs", logHandler)
	mux.HandleFunc("POST /tcpdump/start", tcpdumpStartHandler)
	mux.HandleFunc("POST /tcpdump/stop", tcpdumpStopHandler)
	mux.HandleFunc("POST /dht/provide", dhtProvideHandler)
	mux.HandleFunc("/ws", wsHandler)

	handler := enableCors(mux)

	srv := &http.Server{
		Addr:              ":8080",
		Handler:           handler,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      7 * time.Second,
		ReadHeaderTimeout: 3 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	c := make(chan os.Signal, 1)
	signal.Notify(c, syscall.SIGTERM, os.Interrupt)

	go func() {
		<-c
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		cleanup(ctx)
		cancel()
		os.Exit(0)
	}()

	fmt.Println("Starting server on port 8080...")
	log.Fatal(srv.ListenAndServe())
}
