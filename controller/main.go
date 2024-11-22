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

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
	"github.com/docker/go-connections/nat"
)

var (
	DockerClient *client.Client
	// Slice to store IDs of started containers
	startedContainers []string
	// Mutex to ensure thread-safe access to startedContainers
	startedContainersMutex sync.Mutex
	logStreamers           = make(map[string]*ContainerLogStreamer)
	logStreamersMutex      sync.Mutex
)

const appLabel = "punisher"

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

// ListContainers lists all Docker containers (running and stopped)
func ListContainers() ([]ContainerInfo, error) {
	ctx := context.Background()

	containers, err := DockerClient.ContainerList(ctx, container.ListOptions{All: false})
	if err != nil {
		return nil, fmt.Errorf("failed to list containers: %w", err)
	}

	containerInfos := make([]ContainerInfo, 0, len(containers))

	for _, c := range containers {
		// Extract port mappings from c.Ports
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

// / StartContainer starts a Docker container given its container ID or name
func StartContainer(containerID string) error {
	ctx := context.Background()
	if err := DockerClient.ContainerStart(ctx, containerID, container.StartOptions{}); err != nil {
		return fmt.Errorf("failed to start container %s: %w", containerID, err)
	}

	// Add the container ID to the list of started containers
	startedContainersMutex.Lock()
	startedContainers = append(startedContainers, containerID)
	startedContainersMutex.Unlock()

	return nil
}

func CreateContainerHandler(w http.ResponseWriter, r *http.Request) {
	type RequestBody struct {
		Image string `json:"image"`
		Name  string `json:"name,omitempty"`
		Port  int    `json:"port,omitempty"`
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

	containerID, hostPort, err := CreateAndStartContainer(reqBody.Image, reqBody.Name, reqBody.Port)
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

// Helper function to check if an image exists locally
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

func CreateAndStartContainer(imageName, containerName string, containerPort int) (string, int, error) {
	ctx := context.Background()
	cli := DockerClient

	// Check if the image exists locally
	imageExistsLocally, err := imageExists(cli, ctx, imageName)
	if err != nil {
		return "", 0, fmt.Errorf("failed to check if image exists: %w", err)
	}

	// Pull the image only if it doesn't exist locally
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

	// Expose container port
	exposedPorts := nat.PortSet{
		nat.Port(fmt.Sprintf("%d/tcp", containerPort)): struct{}{},
	}

	// Port bindings
	portBindings := nat.PortMap{
		nat.Port(fmt.Sprintf("%d/tcp", containerPort)): []nat.PortBinding{
			{
				HostPort: "0",
			},
		},
	}

	// Define labels to identify containers managed by this app
	labels := map[string]string{
		"managed_by": appLabel,
	}

	// Create the container with labels
	resp, err := cli.ContainerCreate(ctx, &container.Config{
		Image:        imageName,
		ExposedPorts: exposedPorts,
		Labels:       labels,
		Env:          []string{},
		// Env:          []string{"DEBUG=*"},
	}, &container.HostConfig{
		PortBindings: portBindings,
	}, nil, nil, containerName)
	if err != nil {
		return "", 0, fmt.Errorf("failed to create container: %w", err)
	}

	// Start the container
	if err := cli.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
		return "", 0, fmt.Errorf("failed to start container: %w", err)
	}

	go startLogStreaming(resp.ID)

	// Retrieve the host port
	containerJSON, err := cli.ContainerInspect(ctx, resp.ID)
	if err != nil {
		return "", 0, fmt.Errorf("failed to inspect container: %w", err)
	}

	var hostPort int
	portInfo, ok := containerJSON.NetworkSettings.Ports[nat.Port(fmt.Sprintf("%d/tcp", containerPort))]
	if ok && len(portInfo) > 0 {
		hostPort, _ = strconv.Atoi(portInfo[0].HostPort)
	}

	return resp.ID, hostPort, nil
}

func startLogStreaming(containerID string) {
	ctx := context.Background()

	// Create a log streamer
	streamer := &ContainerLogStreamer{
		containerID: containerID,
		stopChan:    make(chan struct{}),
	}

	// Add the streamer to the map
	logStreamersMutex.Lock()
	logStreamers[containerID] = streamer
	logStreamersMutex.Unlock()

	// Options for logs
	options := container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Follow:     true,
		Tail:       "all",
	}

	// Get the logs
	out, err := DockerClient.ContainerLogs(ctx, containerID, options)
	if err != nil {
		fmt.Printf("Error getting logs for container %s: %v\n", containerID, err)
		return
	}
	defer out.Close()

	// Stream the logs
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

// StopContainer stops a Docker container given its container ID or name
func StopContainer(containerID string) error {
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

	return nil
}

// StopAllContainers stops and removes all Docker containers managed by this app
func StopAllContainers() error {
	ctx := context.Background()

	// Filter containers by label
	filterArgs := filters.NewArgs()
	filterArgs.Add("label", "managed_by="+appLabel) // Use the same label as in container creation

	containers, err := DockerClient.ContainerList(ctx, container.ListOptions{All: true, Filters: filterArgs})
	if err != nil {
		return fmt.Errorf("failed to list containers: %w", err)
	}

	var errorsList []string

	for _, c := range containers {
		// Stop the container if it's running
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

		// Remove the container
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

	if len(errorsList) > 0 {
		return fmt.Errorf("errors occurred while stopping/removing containers: %s", strings.Join(errorsList, "; "))
	}

	return nil
}

// RemoveContainer removes a Docker container given its container ID or name
func RemoveContainer(containerID string) error {
	ctx := context.Background()
	if err := DockerClient.ContainerRemove(ctx, containerID, container.RemoveOptions{}); err != nil {
		return fmt.Errorf("failed to remove container %s: %w", containerID, err)
	}
	fmt.Printf("Container %s removed successfully.\n", containerID)
	return nil
}

// ListContainersHandler handles the GET /containers endpoint
func ListContainersHandler(w http.ResponseWriter, r *http.Request) {
	containerInfos, err := ListContainers()
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to list containers: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(containerInfos)
}

// StartContainerHandler handles the POST /containers/start endpoint
func StartContainerHandler(w http.ResponseWriter, r *http.Request) {
	type RequestBody struct {
		ContainerID string `json:"container_id"`
	}

	var reqBody RequestBody
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if err := StartContainer(reqBody.ContainerID); err != nil {
		http.Error(w, fmt.Sprintf("Failed to start container %s: %v", reqBody.ContainerID, err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// StopContainerHandler handles the POST /containers/stop endpoint
func StopContainerHandler(w http.ResponseWriter, r *http.Request) {
	type RequestBody struct {
		ContainerID string `json:"container_id"`
	}

	var reqBody RequestBody
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if err := StopContainer(reqBody.ContainerID); err != nil {
		http.Error(w, fmt.Sprintf("Failed to stop container %s: %v", reqBody.ContainerID, err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// StopAllContainersHandler handles the POST /containers/stopall endpoint
func StopAllContainersHandler(w http.ResponseWriter, r *http.Request) {
	if err := StopAllContainers(); err != nil {
		http.Error(w, fmt.Sprintf("Failed to stop all containers: %v", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
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

		// Attempt to stop the container
		timeout := 0
		if err := DockerClient.ContainerStop(context.Background(), containerID, container.StopOptions{Timeout: &timeout}); err != nil {
			fmt.Printf("Error stopping container %s: %v\n", containerID, err)
		}

		// Attempt to remove the container
		if err := DockerClient.ContainerRemove(context.Background(), containerID, container.RemoveOptions{}); err != nil {
			fmt.Printf("Error removing container %s: %v\n", containerID, err)
		}
	}

	// Clear the list
	startedContainers = nil
}

func main() {
	var err error

	DockerClient, err = client.NewClientWithOpts(client.FromEnv)
	if err != nil {
		log.Fatalf("Failed to create Docker client: %v", err)
	}

	// Register handlers
	mux := http.NewServeMux()

	mux.HandleFunc("/containers", ListContainersHandler)
	mux.HandleFunc("/containers/start", StartContainerHandler)
	mux.HandleFunc("/containers/stop", StopContainerHandler)
	mux.HandleFunc("/containers/create", CreateContainerHandler)
	mux.HandleFunc("/containers/stopall", StopAllContainersHandler)

	handler := enableCors(mux)

	// Handle SIGTERM and SIGINT for graceful shutdown
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
