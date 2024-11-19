package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
)

var (
	DockerClient *client.Client
	// Slice to store IDs of started containers
	startedContainers []string
	// Mutex to ensure thread-safe access to startedContainers
	startedContainersMutex sync.Mutex
)

type ContainerInfo struct {
	ID     string   `json:"id"`
	Names  []string `json:"names"`
	Image  string   `json:"image"`
	Status string   `json:"status"`
	State  string   `json:"state"`
}

// ListContainers lists all Docker containers (running and stopped)
func ListContainers() ([]ContainerInfo, error) {
	ctx := context.Background()

	containers, err := DockerClient.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return nil, fmt.Errorf("failed to list containers: %w", err)
	}

	var containerInfos []ContainerInfo

	for _, c := range containers {
		containerInfos = append(containerInfos, ContainerInfo{
			ID:     c.ID[:12],
			Names:  c.Names,
			Image:  c.Image,
			Status: c.Status,
			State:  c.State,
		})
	}

	return containerInfos, nil
}

// StartContainer starts a Docker container given its container ID or name
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
	}

	var reqBody RequestBody
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	containerID, err := CreateAndStartContainer(reqBody.Image, reqBody.Name)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to create and start container: %v", err), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"container_id": containerID})
}

func CreateAndStartContainer(imageName, containerName string) (string, error) {
	// Initialize Docker client
	cli, err := client.NewClientWithOpts(client.FromEnv)
	if err != nil {
		return "", fmt.Errorf("failed to create Docker client: %w", err)
	}
	defer cli.Close()

	ctx := context.Background()

	// Pull the image if not available locally
	reader, err := cli.ImagePull(ctx, imageName, image.PullOptions{})
	if err != nil {
		return "", fmt.Errorf("failed to pull image %s: %w", imageName, err)
	}
	defer reader.Close()

	out, _ := io.ReadAll(reader)
	fmt.Printf("Pulling image: %s\n", out)

	// Create the container
	resp, err := cli.ContainerCreate(ctx, &container.Config{
		Image: imageName,
	}, nil, nil, nil, containerName)
	if err != nil {
		return "", fmt.Errorf("failed to create container: %w", err)
	}

	// Start the container
	if err := cli.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
		return "", fmt.Errorf("failed to start container %s: %w", resp.ID, err)
	}

	fmt.Printf("Container %s started successfully\n", resp.ID)

	// Add the container ID to the list of started containers
	startedContainersMutex.Lock()
	startedContainers = append(startedContainers, resp.ID)
	startedContainersMutex.Unlock()

	return resp.ID, nil
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
		if err := DockerClient.ContainerStop(ctx, containerID, container.StopOptions{Timeout: &timeout}); err != nil {
			return fmt.Errorf("failed to stop container %s: %w", containerID, err)
		}
		fmt.Printf("Container %s stopped successfully.\n", containerID)
	}

	// // Remove the container ID from the list of started containers
	// startedContainersMutex.Lock()
	// for i, id := range startedContainers {
	// 	if id == containerID {
	// 		startedContainers = append(startedContainers[:i], startedContainers[i+1:]...)
	// 		break
	// 	}
	// }
	// startedContainersMutex.Unlock()

	return nil
}

// RemoveContainer removes a Docker container given its container ID or name
func RemoveContainer(containerID string) error {
	ctx := context.Background()
	if err := DockerClient.ContainerRemove(ctx, containerID, container.RemoveOptions{}); err != nil {
		return fmt.Errorf("failed to remove container %s: %w", containerID, err)
	}
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

	// Remove the container ID from the list of started containers
	// (Already handled in StopContainer function)

	w.WriteHeader(http.StatusNoContent)
}

func cleanup() {
	fmt.Println("Cleaning up started containers...")

	startedContainersMutex.Lock()
	defer startedContainersMutex.Unlock()

	for _, containerID := range startedContainers {
		fmt.Printf("Stopping container %s...\n", containerID)
		if err := StopContainer(containerID); err != nil {
			fmt.Printf("Error stopping container %s: %v\n", containerID, err)
		}

		fmt.Printf("Removing container %s...\n", containerID)
		if err := RemoveContainer(containerID); err != nil {
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

	// Handle SIGTERM and SIGINT for graceful shutdown
	c := make(chan os.Signal, 1)
	signal.Notify(c, syscall.SIGTERM, os.Interrupt)
	go func() {
		<-c
		cleanup()
		os.Exit(0)
	}()

	fmt.Println("Starting server on port 8080...")
	log.Fatal(http.ListenAndServe(":8080", mux))
}
