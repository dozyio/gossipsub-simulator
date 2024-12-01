import Head from "next/head";
import { FaCircleNodes } from "react-icons/fa6";
import { FaRegCircle } from "react-icons/fa";
import { useEffect, useRef, useState } from 'react';

interface PortMapping {
  ip: string;
  private_port: number;
  public_port: number;
  type: string;
}

interface ContainerInfo {
  id: string;
  names: string[];
  image: string;
  status: string;
  state: string;
  ports: PortMapping[];
}

interface Stream {
  protocol: string;
  direction: "inbound" | "outbound";
}

interface StreamsByPeer {
  [peerId: string]: Stream[];
}

interface PeerScores {
  [peerId: string]: number;
}

interface ContainerData {
  id: string; // Unique identifier
  peerId: string;
  pubsubPeers: string[];
  subscribers: string[];
  libp2pPeers: string[];
  meshPeers: string[];
  dhtPeers: string[];
  connections: string[]; // IDs of connected containers
  protocols: string[];
  multiaddrs: string[];
  streams: StreamsByPeer;
  topics: string[];
  type: string;
  lastMessage: string;
  peerScores: PeerScores;
  x: number; // Position X
  y: number; // Position Y
  vx: number; // Velocity X
  vy: number; // Velocity Y
}

type MapType = 'pubsubPeers' | 'libp2pPeers' | 'meshPeers' | 'dhtPeers' | 'subscribers' | 'connections' | 'streams';

type ClickType = 'kill' | 'info';

type MapView = 'circle' | 'graph';

const DEBUG_STRING = 'DEBUG=*,*:trace,-*peer-store:trace';

// Latency settings
const LATENCY_MIN = 5;
const LATENCY_MAX = 250;


// Constants for force calculations
const NODE_SIZE = 30; // Fixed node size
const MIN_DISTANCE = NODE_SIZE; // Minimum distance between nodes

// Container dimensions
const CONTAINER_WIDTH = 800;
const CONTAINER_HEIGHT = 800;

// Force strengths
const REPULSION_FORCE = 1_000_000; // Adjusted for CSE
const ATTRACTION_FORCE = 0.25; // Adjusted for CSE
const COLLISION_FORCE = 500; // Adjusted for CSE
const GRAVITY_FORCE = 0.75; // Central gravity strength
const DAMPING = 0.15; // Velocity damping factor
const MAX_VELOCITY = 5; // Maximum velocity cap
const NATURAL_LENGTH = 125; // Natural length for springs (ideal distance between connected nodes)

// Utility function to generate random positions within the container
const getRandomPosition = () => ({
  x: Math.random() * (CONTAINER_WIDTH - NODE_SIZE) + NODE_SIZE / 2,
  y: Math.random() * (CONTAINER_HEIGHT - NODE_SIZE) + NODE_SIZE / 2,
});

export default function Home() {
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [imageName, setImageName] = useState<string>('gossip:dev');
  const [containerData, setContainerData] = useState<{ [id: string]: ContainerData }>({});
  const containerRefs = useRef<{ [id: string]: HTMLDivElement | null }>({});
  const containerSockets = useRef<{ [id: string]: WebSocket | null }>({});
  const [connections, setConnections] = useState<{ from: string; to: string }[]>([]);
  const [mapType, setMapType] = useState<MapType>('connections');
  const [hoveredContainerId, setHoveredContainerId] = useState<string | null>(null);
  const [converge, setConverge] = useState<boolean>(false);
  const [clickType, setClickType] = useState<ClickType>('info');
  const [autoPublish, setAutoPublish] = useState<boolean>(false);
  const [protocols, setProtocols] = useState<string[]>([]);
  const [selectedProtocols, setSelectedProtocols] = useState<string[]>([]);
  const [debugContainer, setDebugContainer] = useState<boolean>(false);
  const [latencyContainer, setLatencyContainer] = useState<boolean>(false);
  const [selectedContainer, setSelectedContainer] = useState<string>('');
  const [mapView, setMapView] = useState<MapView>('graph');

  // Function to fetch containers from the backend
  const fetchContainers = async () => {
    try {
      const response = await fetch('http://localhost:8080/containers');
      if (!response.ok) {
        throw new Error(`Error fetching containers: ${response.statusText}`);
      }
      const data: ContainerInfo[] = await response.json();
      const runningContainers = data.filter((c) => c.state === 'running');
      setContainers(runningContainers);

      // Initialize container data with positions and velocities
      initializeContainerData(runningContainers);
    } catch (error) {
      console.error('Error fetching containers:', error);
      setContainers([]);
      setContainerData({});
      setConnections([]);
    }
  };

  const initializeContainerData = (runningContainers: ContainerInfo[]) => {
    setContainerData((prevData) => {
      const newData: { [id: string]: ContainerData } = {};

      runningContainers.forEach((container) => {
        if (prevData[container.id]) {
          // Retain existing data for running containers
          newData[container.id] = prevData[container.id];
        } else {
          // Initialize data for new containers
          const { x, y } = getRandomPosition();
          newData[container.id] = {
            id: container.id,
            peerId: '',
            pubsubPeers: [],
            subscribers: [],
            libp2pPeers: [],
            meshPeers: [],
            dhtPeers: [],
            connections: [], // Will be updated via WebSocket
            protocols: [],
            multiaddrs: [],
            streams: {},
            topics: [],
            type: '',
            lastMessage: '',
            peerScores: {},
            x,
            y,
            vx: 0,
            vy: 0,
          };
        }
      });

      return newData;
    });
  };

  const startContainer = async (image: string, env: string[], hostname: string = ""): Promise<ContainerInfo | void> => {
    try {
      const response = await fetch('http://localhost:8080/containers/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          image,
          env,
          hostname,
          port: 80,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Error starting container: ${errorText}`);
      }

      const data = await response.json();
      console.log('Container started:', data);
      await fetchContainers(); // Refresh the container list
      return data;
    } catch (error) {
      console.error('Error starting container:', error);
    }
  };

  const handleStartBootstrap1 = async () => {
    // 12D3KooWJwYWjPLsTKiZ7eMjDagCZh9Fqt1UERLKoPb5QQNByrAF
    const env = [
      'SEED=0xddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd1'
    ];

    if (debugContainer) {
      env.push(DEBUG_STRING);
    }

    if (latencyContainer) {
      env.push(`NETWORK_CONFIG=delay=${Math.floor(Math.random() * (LATENCY_MAX - LATENCY_MIN)) + LATENCY_MIN}ms`);
    }

    await startContainer('bootstrapper:dev', env, "bootstrapper1");
  };

  const handleStartBootstrap2 = async () => {
    // 12D3KooWAfBVdmphtMFPVq3GEpcg3QMiRbrwD9mpd6D6fc4CswRw
    const env = [
      'SEED=0xddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd2'
    ];

    if (debugContainer) {
      env.push(DEBUG_STRING);
    }

    if (latencyContainer) {
      env.push(`NETWORK_CONFIG=delay=${Math.floor(Math.random() * (LATENCY_MAX - LATENCY_MIN)) + LATENCY_MIN}ms`);
    }

    await startContainer('bootstrapper:dev', env, "bootstrapper2");
  };

  // Function to start a new container
  const handleStartContainer = async () => {
    const env = [];

    if (debugContainer) {
      env.push(DEBUG_STRING);
    }

    if (latencyContainer) {
      env.push(`NETWORK_CONFIG=delay=${Math.floor(Math.random() * (LATENCY_MAX - LATENCY_MIN)) + LATENCY_MIN}ms`);
    }

    await startContainer(imageName, env);
  };

  const handleStartXContainers = async (amount = 12) => {
    const env = [];

    if (debugContainer) {
      env.push(DEBUG_STRING);
    }

    try {
      const promises = [];
      for (let i = 0; i < amount; i++) {
        if (latencyContainer) {
          env.push(`NETWORK_CONFIG=delay=${Math.floor(Math.random() * (LATENCY_MAX - LATENCY_MIN)) + LATENCY_MIN}ms`);
        }

        promises.push(
          startContainer(imageName, env)
        );
      }
      await Promise.all(promises);
      await fetchContainers(); // Refresh the container list
    } catch (error) {
      console.error('Error starting containers:', error);
    }
  };

  // Function to stop a container
  const stopContainer = async (containerID: string) => {
    try {
      const response = await fetch('http://localhost:8080/containers/stop', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          container_id: containerID,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Error stopping container: ${errorText}`);
      }

      console.log(`Container ${containerID} stopped`);
      await fetchContainers(); // Refresh the container list
    } catch (error) {
      console.error('Error stopping container:', error);
    }
  };

  // Function to stop all containers
  const stopAllContainers = async () => {
    try {
      const response = await fetch('http://localhost:8080/containers/stopall', {
        method: 'POST',
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Error stopping all containers: ${errorText}`);
      }

      await fetchContainers(); // Refresh the container list
    } catch (error) {
      console.error('Error stopping all containers:', error);
    }
  };

  const stopXContainers = async (amount = 5) => {
    // Only stop gossip containers
    const gossipContainers = containers.filter((c) => c.image.includes('gossip'));
    const shuffled = gossipContainers.slice();

    for (let i = shuffled.length - 1; i > 0; i--) {
      // Generate a random index from 0 to i
      const j = Math.floor(Math.random() * (i + 1));
      // Swap elements at indices i and j
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // Return the first x elements
    const toStop = shuffled.slice(0, amount);

    for (const container of toStop) {
      try {
        if (containerData[container.id]?.type === 'bootstrapper') {
          continue;
        }

        const response = await fetch('http://localhost:8080/containers/stop', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            container_id: container.id,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Error stopping container: ${errorText}`);
        }

      } catch (error) {
        console.error('Error stopping container:', error);
      }
    }

    await fetchContainers();
  };

  const getRandomColor = () => {
    const letters = '0123456789ABCDEF';
    let color = '#';
    for (let i = 0; i < 6; i++) {
      color += letters[Math.floor(Math.random() * 16)];
    }
    return color;
  };

  const publishToTopic = async (amount = 1000) => {
    setConverge(true);

    try {
      // Extract all WebSocket instances, filtering out nulls
      const sockets = Object.values(containerSockets.current).filter(
        (socket): socket is WebSocket => socket !== null
      );

      if (sockets.length === 0) {
        console.warn('No active WebSocket connections available.');
        return null;
      }

      for (let i = 0; i < amount; i++) {
        const randomIndex = Math.floor(Math.random() * sockets.length);

        const s = sockets[randomIndex];

        const message = {
          type: 'publish',
          message: getRandomColor()
        };

        s.send(JSON.stringify(message));
      }
    } catch (error) {
      console.error('Error publishing to topic:', error);
    }
  };

  const publishToPeer = async (containerId: string, amount = 1) => {
    setConverge(true);

    try {
      const s = containerSockets.current[containerId];
      if (!s) {
        console.log('No WebSocket connection available for container ID');
        return;
      }
      for (let i = 0; i < amount; i++) {
        const message = {
          type: 'publish',
          message: getRandomColor()
        };

        s.send(JSON.stringify(message));
      }
    } catch (error) {
      console.error('Error publishing to topic:', error);
    }
  };

  const showContainerInfo = (containerId: string) => {
    console.log('Checking containerData for:', containerId);
    console.log('Current containerData:', containerData);

    const data = containerData[containerId];
    if (data) {
      console.log(`Container Data for ID ${containerId}:`, data);
    } else {
      console.log(`No data available for container ID ${containerId}`);
    }
    try {
      // Extract the WebSocket instance
      const s = containerSockets.current[containerId];

      if (!s) {
        throw new Error('No WebSocket connection available for container ID');
      }

      const message = {
        type: 'info',
        message: ''
      };

      s.send(JSON.stringify(message));

      console.log('Info message sent to container');
    } catch (error) {
      console.error('Error sending info message:', error);
    }
  };

  const handleClickType = () => {
    if (clickType === 'kill') {
      setClickType('info');
    } else {
      setClickType('kill');
    }
  };

  const handleContainerClick = (containerId: string) => {
    if (clickType === 'kill') {
      stopContainer(containerId);
    } else {
      setSelectedContainer(containerId);
      showContainerInfo(containerId);
    }
  };

  const handleProtocolSelect = (protocol: string) => {
    setSelectedProtocols((prevSelected) => {
      if (prevSelected.includes(protocol)) {
        // Deselect the protocol
        return prevSelected.filter((p) => p !== protocol);
      } else {
        // Select the protocol
        return [...prevSelected, protocol];
      }
    });
  };

  const getBackgroundColor = (containerId: string) => {
    if (containerData[containerId]?.[mapType] === undefined) {
      return 'red';
    } else if (converge) {
      return containerData[containerId]?.lastMessage;
    } else {
      return `#${containerId.substring(0, 6)}`;
    }
  };

  const getBorderStyle = (containerId: string) => {
    if (containerData[containerId]?.type === 'bootstrapper') {
      return '2px solid DarkBlue';
    }

    if (selectedContainer === containerId) {
      return '2px solid White';
    }

    return '0px';
  };

  // Manage WebSocket connections
  useEffect(() => {
    // Function to handle WebSocket messages and update containerData
    const handleWebSocketMessage = (containerId: string, data: ContainerData) => {
      setContainerData((prevData) => {
        const existing = prevData[containerId];
        if (!existing) return prevData; // If container is not in the data, skip

        // Merge new data with existing containerData while preserving positions and velocities
        return {
          ...prevData,
          [containerId]: {
            ...existing,
            ...data, // Merge new data
            x: existing.x,
            y: existing.y,
            vx: existing.vx,
            vy: existing.vy,
          },
        };
      });

      // Extract protocols from streams
      if (data.streams) {
        const newProtocols = new Set<string>();
        Object.values(data.streams).forEach((streamsArray) => {
          streamsArray.forEach((stream) => {
            newProtocols.add(stream.protocol);
          });
        });

        // Update the protocols state with new unique protocols
        setProtocols((prevProtocols) => {
          const updatedProtocols = [...prevProtocols];
          newProtocols.forEach((protocol) => {
            if (!updatedProtocols.includes(protocol)) {
              updatedProtocols.push(protocol);
            }
          });
          return updatedProtocols;
        });
      }
    };

    containers.forEach((container) => {
      // If we don't already have a WebSocket connection for this container
      if (!containerSockets.current[container.id]) {
        // Find the public port that maps to container's port 80
        const portMapping = container.ports.find(
          (port) => port.private_port === 80 && port.type === 'tcp'
        );

        if (portMapping && portMapping.public_port) {
          const wsUrl = `ws://localhost:${portMapping.public_port}/`;
          const ws = new WebSocket(wsUrl);

          ws.onopen = () => {
            console.log(`WebSocket connected for container ${container.id}`);
          };

          ws.onmessage = (event) => {
            try {
              const data: ContainerData = JSON.parse(event.data);
              handleWebSocketMessage(container.id, data);
            } catch (error) {
              console.error(
                `Error parsing WebSocket message from container ${container.id}:`,
                error
              );
            }
          };

          ws.onerror = (error) => {
            console.error(`WebSocket error for container ${container.id}:`, error);
          };

          ws.onclose = () => {
            console.log(`WebSocket closed for container ${container.id}`);
            // Remove the WebSocket from the map
            containerSockets.current[container.id] = null;
          };

          // Store the WebSocket
          containerSockets.current[container.id] = ws;
        }
      }
    });

    // Clean up WebSocket connections for containers that no longer exist
    Object.keys(containerSockets.current).forEach((containerId) => {
      if (!containers.find((c) => c.id === containerId)) {
        // Container no longer exists, close the WebSocket
        const ws = containerSockets.current[containerId];
        if (ws) {
          console.log('Closing WebSocket for container', containerId);
          ws.close();
        }
        containerSockets.current[containerId] = null;
      }
    });
  }, [containers]);

  // Update connections based on current containerData and mapType
  useEffect(() => {
    const newConnections: { from: string; to: string }[] = [];

    Object.keys(containerData).forEach((containerId) => {
      const data = containerData[containerId];

      let connectionList: string[] = [];

      if (mapType === 'streams') {
        const streamsByPeer = data.streams;
        if (streamsByPeer && typeof streamsByPeer === 'object') {
          connectionList = Object.keys(streamsByPeer);
        }
      } else {
        const mapValue = data[mapType];
        if (Array.isArray(mapValue)) {
          connectionList = mapValue;
        }
      }

      connectionList.forEach((peerId) => {
        // Find the container that has this peerId
        const targetContainerId = Object.keys(containerData).find(
          (id) => containerData[id]?.peerId === peerId
        );

        if (targetContainerId) {
          // Avoid duplicate connections
          const exists = newConnections.some(
            (conn) =>
              (conn.from === containerId && conn.to === targetContainerId) ||
              (conn.from === targetContainerId && conn.to === containerId)
          );

          if (!exists) {
            newConnections.push({ from: containerId, to: targetContainerId });
          }
        }
      });
    });

    setConnections(newConnections);
  }, [containerData, mapType]);

  // Fetch containers periodically
  useEffect(() => {
    fetchContainers();

    const interval = setInterval(async () => {
      await fetchContainers();
    }, 200);
    return () => clearInterval(interval);
  }, []);

  // Auto publish if enabled
  useEffect(() => {
    const interval = setInterval(() => {
      if (autoPublish) {
        publishToTopic(1);
      }
    }, 250);
    return () => clearInterval(interval);
  }, [autoPublish]);

  // Compound Spring Embedder Force-Directed Layout Implementation
  useEffect(() => {
    if (mapView !== 'graph') {
      return
    }

    const centerX = CONTAINER_WIDTH / 2;
    const centerY = CONTAINER_HEIGHT / 2;

    const interval = setInterval(() => {
      setContainerData((prevData) => {
        const updatedData: { [id: string]: ContainerData } = { ...prevData };

        Object.values(updatedData).forEach((node) => {
          let fx = 0;
          let fy = 0;

          // 1. Repulsive Forces between all node pairs
          Object.values(updatedData).forEach((otherNode) => {
            if (node.id === otherNode.id) return;

            const dx = node.x - otherNode.x;
            const dy = node.y - otherNode.y;
            let distance = Math.sqrt(dx * dx + dy * dy) || 1;

            // Prevent division by zero and excessive repulsion
            distance = Math.max(distance, MIN_DISTANCE);

            // Repulsive force calculation
            const repulsion = REPULSION_FORCE / (distance * distance);
            fx += (dx / distance) * repulsion;
            fy += (dy / distance) * repulsion;
          });

          // 2. Attractive Forces for connected nodes
          connections.forEach(conn => {
            if (conn.from === node.id) {
              const targetNode = updatedData[conn.to];
              if (targetNode) {
                const dx = targetNode.x - node.x;
                const dy = targetNode.y - node.y;
                const distance = Math.sqrt(dx * dx + dy * dy) || 1;

                // Attractive force calculation following spring-like behavior
                const attraction = (distance - NATURAL_LENGTH) * ATTRACTION_FORCE;
                fx += (dx / distance) * attraction;
                fy += (dy / distance) * attraction;
              }
            } else if (conn.to === node.id) {
              const targetNode = updatedData[conn.from];
              if (targetNode) {
                const dx = targetNode.x - node.x;
                const dy = targetNode.y - node.y;
                const distance = Math.sqrt(dx * dx + dy * dy) || 1;

                // Attractive force calculation following spring-like behavior
                const attraction = (distance - NATURAL_LENGTH) * ATTRACTION_FORCE;
                fx += (dx / distance) * attraction;
                fy += (dy / distance) * attraction;
              }
            }
          });

          // 3. Central Gravity Force
          const dxCenter = centerX - node.x;
          const dyCenter = centerY - node.y;
          fx += dxCenter * GRAVITY_FORCE;
          fy += dyCenter * GRAVITY_FORCE;

          // 4. Collision Detection and Resolution
          Object.values(updatedData).forEach((otherNode) => {
            if (node.id === otherNode.id) return;

            const dx = node.x - otherNode.x;
            const dy = node.y - otherNode.y;
            const distance = Math.sqrt(dx * dx + dy * dy) || 1;

            if (distance < MIN_DISTANCE) {
              const overlap = MIN_DISTANCE - distance;
              const collision = (overlap / distance) * COLLISION_FORCE;
              fx += (dx / distance) * collision;
              fy += (dy / distance) * collision;
            }
          });

          // 5. Update Velocities with Damping
          node.vx = (node.vx + fx) * DAMPING;
          node.vy = (node.vy + fy) * DAMPING;

          // 6. Cap Velocities to Prevent Overshooting
          node.vx = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, node.vx));
          node.vy = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, node.vy));

          // 7. Update Positions
          node.x += node.vx;
          node.y += node.vy;

          // 8. Boundary Enforcement: Keep Nodes Within Container
          node.x = Math.max(NODE_SIZE / 2, Math.min(CONTAINER_WIDTH - NODE_SIZE / 2, node.x));
          node.y = Math.max(NODE_SIZE / 2, Math.min(CONTAINER_HEIGHT - NODE_SIZE / 2, node.y));
        });

        return updatedData;
      });
    }, 30); // Update every 30ms for smooth animation

    return () => clearInterval(interval); // Cleanup on unmount
  }, [connections, mapView]);

  return (
    <>
      <Head>
        <title>GossipSub Simulator</title>
        <meta name="description" content="Manage Docker containers" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <div className="app-container">
        {/* Sidebar 1: Controls */}
        <div className="sidebar sidebar1">

          <h3>Start Containers</h3>
          <div className="input-group">
            <label>
              Container Image Name:
              <input
                type="text"
                value={imageName}
                onChange={(e) => setImageName(e.target.value)}
              />
            </label>
          </div>
          <div className="input-group">
            <label>
              <input
                type="checkbox"
                checked={debugContainer}
                onChange={() => setDebugContainer(!debugContainer)}
              />
              <span style={{ marginLeft: '5px' }}>
                Start with debug
              </span>
            </label>
          </div>
          <div className="input-group">
            <label>
              <input
                type="checkbox"
                checked={latencyContainer}
                onChange={() => setLatencyContainer(!latencyContainer)}
              />
              <span style={{ marginLeft: '5px' }}>
                Start with Latency
              </span>
            </label>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0px 10px' }}>
            <button onClick={handleStartBootstrap1}>Bootstrap1</button>
            <button onClick={handleStartBootstrap2}>Bootstrap2</button>
            <button onClick={handleStartContainer}>Container</button>
            <button onClick={() => handleStartXContainers(12)}>12 Containers</button>
          </div>
          <h3>Stop Containers</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0px 10px' }}>
            <button onClick={() => stopXContainers(5)}>Stop 5</button>
            <button onClick={stopAllContainers} style={{ backgroundColor: '#e62020' }}>Stop All</button>
          </div>
          <h3>Show</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0px 10px' }}>
            <button onClick={() => setMapType('connections')} className={mapType === 'connections' ? 'selected' : ''}>Connections</button>
            <button onClick={() => setMapType('meshPeers')} className={mapType === 'meshPeers' ? 'selected' : ''}>Mesh Peers</button>
            <button onClick={() => setMapType('streams')} className={mapType === 'streams' ? 'selected' : ''}>Streams</button>
            <button onClick={() => setMapType('subscribers')} className={mapType === 'subscribers' ? 'selected' : ''}>Subscribers</button>
            <button onClick={() => setMapType('pubsubPeers')} className={mapType === 'pubsubPeers' ? 'selected' : ''}>Pubsub Peer Store</button>
            <button onClick={() => setMapType('libp2pPeers')} className={mapType === 'libp2pPeers' ? 'selected' : ''}>Libp2p Peer Store</button>
            <button onClick={() => setMapType('dhtPeers')} className={mapType === 'dhtPeers' ? 'selected' : ''}>DHT Known Peers</button>
          </div>
          {/* Conditionally render protocols when mapType is 'streams' */}
          {mapType === 'streams' && (
            <div className="protocol-list">
              <h3>Stream Protocols</h3>
              {protocols.length > 0 ? (
                <div>
                  {/* "Select All" and "Clear Selection" Buttons */}
                  <div style={{ marginBottom: '10px' }}>
                    <button onClick={() => setSelectedProtocols(protocols)} style={{ marginRight: '10px' }}>
                      Select All
                    </button>
                    <button onClick={() => setSelectedProtocols([])}>
                      Clear Selection
                    </button>
                  </div>
                  {/* Protocol Checkboxes */}
                  <ul>
                    {protocols.map((protocol, index) => (
                      <li key={index}>
                        <label>
                          <input
                            type="checkbox"
                            checked={selectedProtocols.includes(protocol)}
                            onChange={() => handleProtocolSelect(protocol)}
                          />
                          {protocol}
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p>No protocols available.</p>
              )}
            </div>
          )}

        </div>

        {/* Middle Section: Graph */}
        <div className="middle">
          <div style={{ position: 'absolute', top: '0px', left: '0px', zIndex: 10 }}>
            <h1>{mapType}</h1>
            <div>{`Total containers: ${containers.length}`}</div>
            <div>{`Bootstrap containers: ${containers.filter((c) => c.image.includes('bootstrap')).length}`}</div>

            <div>{`Gossip containers: ${containers.filter((c) => c.image.includes('gossip')).length}`}</div>

            <div>{`Containers without ${mapType}: ${containers.filter((c) => containerData[c.id]?.[mapType] === undefined).length}`}</div>
          </div>
          <div style={{ position: 'absolute', top: '0px', right: '0px', fontSize: '30px', zIndex: 10, textAlign: 'center' }}>
            <h6 style={{ marginBottom: '10px' }}>View:</h6>
            {mapView === 'graph' ? (
              <div>
                <span style={{ color: 'white', marginRight: '10px' }}>
                  <FaCircleNodes />
                </span>
                <span style={{ color: 'gray' }} onClick={() => setMapView('circle')}>
                  <FaRegCircle />
                </span>
              </div>
            ) : (
              <div>
                <span style={{ color: 'gray', marginRight: '10px' }} onClick={() => setMapView('graph')}>
                  <FaCircleNodes />
                </span>
                <span style={{ color: 'white' }}>
                  <FaRegCircle />
                </span>
              </div>
            )}
          </div>
          <div className="container-circle">
            {mapView === 'graph' && (
              <div>
                <svg className="connections">
                  {connections.map((conn, index) => {
                    const fromNode = containerData[conn.from];
                    const toNode = containerData[conn.to];

                    if (fromNode && toNode) {
                      // Ensure both nodes have valid positions
                      if (fromNode.x === undefined || fromNode.y === undefined || toNode.x === undefined || toNode.y === undefined) {
                        return null;
                      }

                      // Determine the protocol associated with this connection
                      let connectionProtocol: string | null = null;

                      if (mapType === 'streams') {
                        const toPeerId = containerData[conn.to]?.peerId;
                        const fromStreams = containerData[conn.from]?.streams[toPeerId];

                        if (
                          toPeerId &&
                          fromStreams &&
                          fromStreams.length > 0 &&
                          typeof fromStreams[0].protocol === 'string' &&
                          fromStreams[0].protocol.trim() !== ''
                        ) {
                          connectionProtocol = fromStreams[0].protocol.trim().toLowerCase();
                        } else {
                          // Try the reverse: from to to from
                          const fromPeerId = containerData[conn.from]?.peerId;
                          const toStreams = containerData[conn.to]?.streams[fromPeerId];

                          if (
                            fromPeerId &&
                            toStreams &&
                            toStreams.length > 0 &&
                            typeof toStreams[0].protocol === 'string' &&
                            toStreams[0].protocol.trim() !== ''
                          ) {
                            connectionProtocol = toStreams[0].protocol.trim().toLowerCase();
                          }
                        }
                      }

                      // If protocols are selected, filter connections
                      if (selectedProtocols.length > 0 && mapType === 'streams') {
                        if (!connectionProtocol || !selectedProtocols.includes(connectionProtocol)) {
                          return null; // Do not render this connection
                        }
                      }

                      // Determine the stroke color based on the protocol
                      let strokeColor = '#ffffff'; // Default color

                      if (connectionProtocol) {
                        // Define a color mapping based on protocol
                        const protocolColorMap: { [key: string]: string } = {
                          '/meshsub/1.2.0': '#0fff00',
                          '/ipfs/id/1.0.0': '#00ff00',
                          '/ipfs/ping/1.0.0': '#000ff0',
                          // Add more protocols and their corresponding colors here
                        };
                        strokeColor = protocolColorMap[connectionProtocol] || '#000000';
                      } else {
                        // For connections without a protocol, use default coloring
                        strokeColor = `#${conn.from.substring(0, 6)}`;
                      }
                      if (hoveredContainerId === conn.from || hoveredContainerId === conn.to) {
                        strokeColor = '#ffffff';
                      }

                      return (
                        <line
                          key={index}
                          x1={fromNode.x}
                          y1={fromNode.y}
                          x2={toNode.x}
                          y2={toNode.y}
                          stroke={strokeColor}
                          strokeWidth="2"
                        />
                      );
                    }
                    return null;
                  })}
                </svg>

                {containers.map((container) => {
                  const node = containerData[container.id];
                  if (!node) return null; // Ensure node data exists

                  return (
                    <div
                      key={container.id}
                      ref={(el) => { containerRefs.current[container.id] = el; }}
                      className="container-item"
                      onClick={() => handleContainerClick(container.id)}
                      onMouseEnter={() => setHoveredContainerId(container.id)}
                      onMouseLeave={() => setHoveredContainerId(null)}
                      style={{
                        width: `${NODE_SIZE}px`,
                        height: `${NODE_SIZE}px`,
                        lineHeight: `${NODE_SIZE}px`,
                        left: `${node.x}px`,
                        top: `${node.y}px`,
                        fontSize: `${Math.max(8, NODE_SIZE / 3)}px`,
                        backgroundColor: `${getBackgroundColor(container.id)}`,
                        border: `${getBorderStyle(container.id)}`,
                        position: 'absolute',
                        transform: `translate(-50%, -50%)`, // Center the node
                        transition: 'left 0.1s, top 0.1s, background-color 0.3s, border 0.3s', // Smooth transitions
                      }}
                      title={`Container ID: ${container.id}\nPeer ID: ${containerData[container.id]?.peerId || 'Loading...'}`}
                    >
                      {container.image.split(':')[0]}
                    </div>
                  );
                })}
              </div>
            )}

            {mapView === 'circle' && (
              <div>
                <svg className="connections">
                  {connections.map((conn, index) => {
                    const fromEl = containerRefs.current[conn.from];
                    const toEl = containerRefs.current[conn.to];

                    if (fromEl && toEl) {
                      const fromRect = fromEl.getBoundingClientRect();
                      const toRect = toEl.getBoundingClientRect();

                      const svgRect = fromEl.parentElement!.getBoundingClientRect();

                      const x1 = fromRect.left + fromRect.width / 2 - svgRect.left;
                      const y1 = fromRect.top + fromRect.height / 2 - svgRect.top;

                      const x2 = toRect.left + toRect.width / 2 - svgRect.left;
                      const y2 = toRect.top + toRect.height / 2 - svgRect.top;

                      // Determine the protocol associated with this connection
                      let connectionProtocol: string | null = null;

                      if (mapType === 'streams') {
                        const toPeerId = containerData[conn.to]?.peerId;
                        const fromStreams = containerData[conn.from]?.streams[toPeerId];

                        if (
                          toPeerId &&
                          fromStreams &&
                          fromStreams.length > 0 &&
                          typeof fromStreams[0].protocol === 'string' &&
                          fromStreams[0].protocol.trim() !== ''
                        ) {
                          connectionProtocol = fromStreams[0].protocol.trim().toLowerCase();
                        } else {
                          // Try the reverse: from to to from
                          const fromPeerId = containerData[conn.from]?.peerId;
                          const toStreams = containerData[conn.to]?.streams[fromPeerId];

                          if (
                            fromPeerId &&
                            toStreams &&
                            toStreams.length > 0 &&
                            typeof toStreams[0].protocol === 'string' &&
                            toStreams[0].protocol.trim() !== ''
                          ) {
                            connectionProtocol = toStreams[0].protocol.trim().toLowerCase();
                          }
                        }
                      }

                      // If protocols are selected, filter connections
                      if (selectedProtocols.length > 0 && mapType === 'streams') {
                        if (!connectionProtocol || !selectedProtocols.includes(connectionProtocol)) {
                          return null; // Do not render this connection
                        }
                      }

                      // Determine the stroke color based on the protocol
                      let strokeColor = '#ffffff'; // Default color

                      if (connectionProtocol) {
                        // Define a color mapping based on protocol
                        const protocolColorMap: { [key: string]: string } = {
                          '/meshsub/1.2.0': '#0fff00',
                          '/ipfs/id/1.0.0': '#00ff00',
                          '/ipfs/ping/1.0.0': '#000ff0',
                          // Add more protocols and their corresponding colors here
                        };
                        strokeColor = protocolColorMap[connectionProtocol] || '#000000';
                      } else {
                        // For connections without a protocol, use default coloring
                        strokeColor = `#${conn.from.substring(0, 6)}`;
                      }
                      if (hoveredContainerId === conn.from || hoveredContainerId === conn.to) {
                        strokeColor = '#ffffff';
                      }

                      return (
                        <line
                          key={index}
                          x1={x1}
                          y1={y1}
                          x2={x2}
                          y2={y2}
                          stroke={strokeColor}
                          strokeWidth="2"
                        />
                      );
                    }
                    return null;
                  })}
                </svg>

                {containers.map((container, index) => {
                  const numContainers = containers.length;

                  // Arrange containers in a single circle
                  const angle = (index / numContainers) * 360;
                  const radius = 320; // Fixed radius

                  // Adjust item size based on number of containers
                  const minItemSize = 20;
                  const maxItemSize = 80;
                  const itemSize = Math.max(minItemSize, maxItemSize - numContainers);

                  const fontSize = itemSize / 4; // Adjust font size proportionally

                  return (
                    <div
                      key={container.id}
                      ref={(el) => { containerRefs.current[container.id] = el; }}
                      className="container-item"
                      onClick={() => handleContainerClick(container.id)}
                      onMouseEnter={() => setHoveredContainerId(container.id)}
                      onMouseLeave={() => setHoveredContainerId(null)}
                      style={{
                        width: `${itemSize}px`,
                        height: `${itemSize}px`,
                        lineHeight: `${itemSize}px`,
                        left: '50%',
                        top: '50%',
                        transform: `rotate(${angle}deg) translate(0, -${radius}px) rotate(-${angle}deg)`,
                        fontSize: `${fontSize}px`,
                        backgroundColor: `${getBackgroundColor(container.id)}`,
                        border: `${getBorderStyle(container.id)}`
                      }}
                      title={`Container ID: ${container.id}\nPeer ID: ${containerData[container.id]?.peerId || 'Loading...'}`}
                    >
                      {container.image.split(':')[0]}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Sidebar 2: Information and Actions */}
        <div className="sidebar sidebar2">
          <h1>GossipSub Simulator</h1>
          <button onClick={handleClickType}>Clicks: {clickType}</button>
          <button onClick={() => setConverge(!converge)}>Show Convergence is: {converge ? 'ON' : 'OFF'}</button>
          <button onClick={() => publishToTopic(1)}>Publish to random peer</button>
          <button onClick={() => publishToTopic(1000)}>Publish 1k to random peers</button>
          <button onClick={() => setAutoPublish(!autoPublish)}>Auto Publish is: {autoPublish ? 'ON' : 'OFF'}</button>
          {selectedContainer && (
            <div>
              <h3>Peer Info</h3>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0px 10px' }}>
                <button onClick={() => publishToPeer(selectedContainer, 1)}>Publish 1</button>
                <button onClick={() => publishToPeer(selectedContainer, 1_000)}>Publish 1k</button>
                <button onClick={() => publishToPeer(selectedContainer, 100_000)}>Publish 100k</button>
                <button onClick={() => stopContainer(selectedContainer)} style={{ backgroundColor: '#e62020' }}>Stop</button>
              </div>
              <div>Container ID: {selectedContainer}</div>
              <p>Type: {containerData[selectedContainer]?.type}</p>
              <p>Peer ID: {containerData[selectedContainer]?.peerId}</p>
              <div>Outbound Connections: {connections.filter(conn => conn.from === selectedContainer).length}</div>
              <div>Inbound Connections: {connections.filter(conn => conn.to === selectedContainer).length}</div>
              <div>Mesh Peers: {containerData[selectedContainer]?.meshPeers?.length}</div>
              <div>Subscribers: {containerData[selectedContainer]?.subscribers?.length}</div>
              <div>Pubsub Peer Store: {containerData[selectedContainer]?.pubsubPeers?.length}</div>
              <div>Libp2p Peer Store: {containerData[selectedContainer]?.libp2pPeers?.length}</div>
              <div>Protocols: {containerData[selectedContainer]?.protocols?.map((p, index) => <p key={index}>{p}</p>)}</div>
              <div>Multiaddrs: {containerData[selectedContainer]?.multiaddrs?.map((p, index) => <p key={index}>{p}</p>)}</div>
            </div>
          )}
        </div>

        {/* Styling */}
        <style jsx>{`
        .app-container {
          display: flex;
          min-height: 100vh;
        }

        .sidebar {
          width: 250px;
          padding: 15px;
          background-color: #111111;
          color: white;
          overflow-y: auto;
          max-height: 100vh;
        }

        .sidebar h1 {
          text-align: center;
          margin-bottom: 30px;
        }

        .input-group {
          margin-bottom: 10px;
        }

        .input-group label {
          flex-direction: column;
          font-size: 16px;
        }

        .input-group input {
          padding: 5px;
          font-size: 16px;
        }

        p {
          word-wrap: break-word;
        }

        .sidebar1 p {
          font-size: 18px;
          margin-bottom: 20px;
          text-align: center;
        }

        .sidebar button {
          display: block;
          margin-bottom: 10px;
          padding: 10px;
          font-size: 16px;
          cursor: pointer;
          width: 100%;
          border: none;
          border-radius: 4px;
          background-color: #0070f3;
          color: white;
        }

        .sidebar button:hover {
          background-color: #005bb5;
        }

        .sidebar button.selected {
          background-color: #005bb5;
        }

        .middle {
          flex-grow: 1;
          display: flex;
          justify-content: center;
          align-items: center;
          position: relative;
        }

        .container-circle {
          position: relative;
          width: ${CONTAINER_WIDTH}px;
          height: ${CONTAINER_HEIGHT}px;
          margin: 0 auto;
          overflow: hidden;
          user-select: none;
        }

        .connections {
          position: absolute;
          width: 100%;
          height: 100%;
          top: 0;
          left: 0;
          pointer-events: none; /* Allow clicks to pass through */
        }

        .container-item {
          position: absolute;
          background-color: #0070f3;
          color: white;
          border-radius: 50%;
          text-align: center;
          cursor: pointer;
          transform-origin: 50% 50%;
          transition: left 0.1s, top 0.1s, background-color 0.3s, border 0.3s; /* Smooth transitions */
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
        }

        .protocol-list button {
          padding: 5px 10px;
          font-size: 14px;
          cursor: pointer;
          border: none;
          border-radius: 4px;
          background-color: #0070f3;
          color: white;
        }

        .protocol-list button:hover {
          background-color: #005bb5;
        }

        .protocol-list ul {
          list-style-type: none;
          padding-left: 0;
          max-height: 200px;
          overflow-y: auto;
        }

        .protocol-list li {
          margin-bottom: 5px;
        }

        .protocol-list label {
          cursor: pointer;
        }

        /* Sidebar 2 Styles */
        .sidebar2 {
          width: 250px;
          padding: 15px;
          background-color: #222222;
          color: white;
        }

        .sidebar2 button {
          display: block;
          margin-bottom: 10px;
          padding: 10px;
          font-size: 16px;
          cursor: pointer;
          width: 100%;
          border: none;
          border-radius: 4px;
          background-color: #0070f3;
          color: white;
        }

        .sidebar2 button:hover {
          background-color: #005bb5;
        }

        .sidebar2 h3 {
          margin-top: 20px;
        }

        /* Scrollbar Styles */
        .sidebar::-webkit-scrollbar,
        .sidebar2::-webkit-scrollbar {
          width: 8px;
        }

        .sidebar::-webkit-scrollbar-track,
        .sidebar2::-webkit-scrollbar-track {
          background: #333333;
        }

        .sidebar::-webkit-scrollbar-thumb,
        .sidebar2::-webkit-scrollbar-thumb {
          background-color: #555555;
          border-radius: 4px;
        }
      `}</style>
      </div >
    </>
  );
}
