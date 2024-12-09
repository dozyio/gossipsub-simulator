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

// round trip times
interface RRTs {
  [peerId: string]: number;
}

interface ContainerData {
  containerId: string
  id: string; // Unique identifier
  peerId: string;
  pubsubPeers: string[];
  subscribers: string[];
  libp2pPeers: string[];
  meshPeers: string[];
  fanoutList: Map<string, Set<string>>
  dhtPeers: string[];
  connections: string[]; // IDs of connected containers
  protocols: string[];
  multiaddrs: string[];
  streams: StreamsByPeer;
  topics: string[];
  type: string;
  lastMessage: string;
  peerScores: PeerScores;
  rtts: RRTs;
  x: number; // Position X
  y: number; // Position Y
  vx: number; // Velocity X
  vy: number; // Velocity Y
}

type MapType = 'pubsubPeers' | 'libp2pPeers' | 'meshPeers' | 'dhtPeers' | 'subscribers' | 'connections' | 'streams';

type ClickType = 'kill' | 'info';

type HoverType = 'peerscore' | 'rtt';

type MapView = 'circle' | 'graph';

const ENDPOINT = "http://localhost:8080"
const WS_ENDPOINT = "ws://localhost:8080/ws"
const DEBUG_STRING = 'DEBUG=*,*:trace,-*peer-store:trace';

// Container dimensions
const CONTAINER_WIDTH = 800;
const CONTAINER_HEIGHT = 800;

// Force strengths
// Compound Spring Embedder layout
const DEFAULT_FORCES = {
  repulsion: 100_000, // Adjusted for CSE
  attraction: 0.20, // Adjusted for CSE
  collision: 100, // Adjusted for CSE
  gravity: 0.05, // Central gravity strength
  damping: 0.10, // Velocity damping factor
  maxVelocity: 80, // Maximum velocity cap
  naturalLength: 60, // Natural length for springs (ideal distance between connected nodes)
}

const mapTypeForces = {
  "pubsubPeers": DEFAULT_FORCES,
  "libp2pPeers": {
    ...DEFAULT_FORCES,
    naturalLength: 250,
  },
  "meshPeers": DEFAULT_FORCES,
  "dhtPeers": DEFAULT_FORCES,
  "subscribers": DEFAULT_FORCES,
  "connections": DEFAULT_FORCES,
  "streams": DEFAULT_FORCES,
}

export default function Home() {
  // peer stuff
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [imageName, setImageName] = useState<string>('gossip:dev');
  const [containerData, setContainerData] = useState<{ [id: string]: ContainerData }>({});

  // ui config
  const [hoveredContainerId, setHoveredContainerId] = useState<string | null>(null);
  const [converge, setConverge] = useState<boolean>(true);
  const [clickType, setClickType] = useState<ClickType>('info');
  const [hoverType, setHoverType] = useState<HoverType>('rtt');
  const [autoPublish, setAutoPublish] = useState<boolean>(false);
  const [protocols, setProtocols] = useState<string[]>([]);
  const [selectedProtocols, setSelectedProtocols] = useState<string[]>([]);
  const [selectedContainer, setSelectedContainer] = useState<string>('');
  const [autoPublishInterval, setAutoPublishInterval] = useState<string>('1000')

  // network config
  const [debugContainer, setDebugContainer] = useState<boolean>(false);
  const [hasGossipDSettings, setHasGossipDSettings] = useState<boolean>(false);
  const [gossipD, setGossipD] = useState<string>('8');
  const [gossipDlo, setGossipDlo] = useState<string>('6');
  const [gossipDhi, setGossipDhi] = useState<string>('12');
  const [gossipDout, setGossipDout] = useState<string>('2');
  const [hasLatencySettings, setHasLatencySettings] = useState<boolean>(false);
  const [minLatency, setMinLatency] = useState<string>('20');
  const [maxLatency, setMaxLatency] = useState<string>('300');
  const [hasPacketLossSetting, setHasPacketLossSettings] = useState<boolean>(false);
  const [packetLoss, setPacketLoss] = useState<string>('10');

  // graph stuff
  const [edges, setEdges] = useState<{ from: string; to: string }[]>([]);
  const prevEdgesRef = useRef(edges); // Store previous connections for comparison
  const containerRefs = useRef<{ [id: string]: HTMLDivElement | null }>({});
  const [mapType, setMapType] = useState<MapType>('connections');
  const [mapView, setMapView] = useState<MapView>('graph');
  const stableCountRef = useRef(0); // Track stable state count
  const stabilizedRef = useRef(false); // Track if graph is already stabilized
  const intervalIdRef = useRef<number | null>(null); // Store interval ID
  const [nodeSize, setNodeSize] = useState<number>(35);
  const [minDistance, setMinDistance] = useState<number>(nodeSize * 4);

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
            containerId: container.id,
            id: container.id,
            peerId: '',
            pubsubPeers: [],
            subscribers: [],
            libp2pPeers: [],
            meshPeers: [],
            fanoutList: new Map<string, Set<string>>(),
            dhtPeers: [],
            connections: [], // Will be updated via WebSocket
            protocols: [],
            multiaddrs: [],
            streams: {},
            topics: [],
            type: '',
            lastMessage: '',
            peerScores: {},
            rtts: {},
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
      const response = await fetch(`${ENDPOINT}/containers/create`, {
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
      // No need to call fetchContainers here since WebSocket will handle updates now
      return data;
    } catch (error) {
      console.error('Error starting container:', error);
    }
  };

  const envSetter = (env: string[], isBootstrap: boolean = false): string[] => {
    if (debugContainer) {
      env.push(DEBUG_STRING);
    }

    if (hasLatencySettings || hasPacketLossSetting) {
      let str = "NETWORK_CONFIG="

      if (hasLatencySettings && minLatency !== '0' && maxLatency !== '0') {
        str = `${str}delay=${Math.floor(Math.random() * (parseInt(maxLatency) - parseInt(minLatency)) + parseInt(minLatency))}ms`;
      }

      if (hasLatencySettings && minLatency !== '0' && maxLatency !== '0' && hasPacketLossSetting && packetLoss !== '0') {
        str = `${str} `
      }

      if (hasPacketLossSetting && packetLoss !== '0') {
        str = `${str}loss=${packetLoss}%`
      }

      env.push(str)
    }

    if (isBootstrap) {
      // https://github.com/libp2p/specs/blob/master/pubsub/gossipsub/gossipsub-v1.1.md#recommendations-for-network-operators
      // D=D_lo=D_hi=D_out=0
      env.push(`GOSSIP_D=0`);
      env.push(`GOSSIP_DLO=0`);
      env.push(`GOSSIP_DHI=0`);
      env.push(`GOSSIP_DOUT=0`);
    } else {
      if (hasGossipDSettings) {
        env.push(`GOSSIP_D=${gossipD}`);
        env.push(`GOSSIP_DLO=${gossipDlo}`);
        env.push(`GOSSIP_DHI=${gossipDhi}`);
        env.push(`GOSSIP_DOUT=${gossipDout}`);
      }
    }

    return env
  }

  const handleStartBootstrap1 = async () => {
    // 12D3KooWJwYWjPLsTKiZ7eMjDagCZh9Fqt1UERLKoPb5QQNByrAF
    let env = [
      'SEED=0xddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd1'
    ];

    env = envSetter(env, true)

    await startContainer('bootstrapper:dev', env, "bootstrapper1");
  };

  const handleStartBootstrap2 = async () => {
    // 12D3KooWAfBVdmphtMFPVq3GEpcg3QMiRbrwD9mpd6D6fc4CswRw
    let env = [
      'SEED=0xddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd2'
    ];

    env = envSetter(env, true)

    await startContainer('bootstrapper:dev', env, "bootstrapper2");
  };

  // Function to start a new container
  const handleStartContainer = async () => {
    const env = envSetter([]);

    await startContainer(imageName, env);
  };

  const handleStartXContainers = async (amount = 12) => {

    try {
      const promises = [];
      for (let i = 0; i < amount; i++) {
        const env = envSetter([]);

        promises.push(
          startContainer(imageName, env)
        );
      }
      await Promise.all(promises);
      // No need to fetchContainers here, WebSocket updates container list
    } catch (error) {
      console.error('Error starting containers:', error);
    }
  };

  const stopContainer = async (containerID: string) => {
    try {
      const response = await fetch(`${ENDPOINT}/containers/stop`, {
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
      // No need to fetchContainers here, WebSocket updates container list
    } catch (error) {
      console.error('Error stopping container:', error);
    }
  };

  const stopAllContainers = async () => {
    try {
      const response = await fetch(`${ENDPOINT}/containers/stopall`, {
        method: 'POST',
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Error stopping all containers: ${errorText}`);
      }

      // No need to fetchContainers here, WebSocket updates container list
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

        const response = await fetch(`${ENDPOINT}/containers/stop`, {
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

    // No need to fetchContainers here, WebSocket updates container list
  };

  // const getRandomColor = () => {
  //   const letters = '0123456789ABCDEF';
  //   let color = '#';
  //   for (let i = 0; i < 6; i++) {
  //     color += letters[Math.floor(Math.random() * 16)];
  //   }
  //   return color;
  // };

  const publishToTopic = async (containerId: string = '', amount = 1) => {
    interface Body {
      amount: number
      containerId?: string

    }
    const body: Body = {
      amount: amount
    }

    if (containerId !== '') {
      body.containerId = containerId
    }

    try {
      const response = await fetch(`${ENDPOINT}/publish`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Error publishing: ${errorText}`);
      }

    } catch (error) {
      console.error('Error publishing:', error);
    }
  };

  const showContainerInfo = (containerId: string) => {
    console.log('Current containerData:', containerData);

    const data = containerData[containerId];
    if (data) {
      console.log(`Container Data for ID ${containerId}:`, data);
    } else {
      console.log(`No data available for container ID ${containerId}`);
    }
    // try {
    //   // Extract the WebSocket instance
    //   const s = containerSockets.current[containerId];
    //
    //   if (!s) {
    //     throw new Error('No WebSocket connection available for container ID');
    //   }
    //
    //   const message = {
    //     type: 'info',
    //     message: ''
    //   };
    //
    //   s.send(JSON.stringify(message));
    //
    //   console.log('Info message sent to container');
    // } catch (error) {
    //   console.error('Error sending info message:', error);
    // }
  };

  const getLabel = (containerId: string): string => {
    const container = containers.find((c) => c.id === containerId);
    const node = containerData[containerId];

    if (!container || !node) {
      return '';
    }

    let label = container.image.split(':')[0];

    // Determine the source of interaction: Hovered or Selected
    const sourceContainerId = hoveredContainerId || selectedContainer;

    if (sourceContainerId) {
      const sourceData = containerData[sourceContainerId];
      if (sourceData) {
        let relatedPeerIds: string[] = [];
        let relatedContainerIds: string[] = [];

        // Determine related peers/containers based on mapType
        if (mapType === 'streams') {
          relatedPeerIds = Object.keys(sourceData.streams); // Peer IDs from streams
        } else if (
          mapType === 'connections' ||
          mapType === 'pubsubPeers' ||
          mapType === 'meshPeers' ||
          mapType === 'libp2pPeers' ||
          mapType === 'dhtPeers'
        ) {
          relatedPeerIds = sourceData[mapType]; // Peer IDs
        }

        // Map peer IDs to container IDs if necessary
        if (relatedPeerIds.length > 0) {
          relatedContainerIds = Object.keys(containerData).filter(
            (id) => relatedPeerIds.includes(containerData[id]?.peerId)
          );
        }

        // Check if the current container is related
        // if (relatedContainerIds.includes(container.id)) {
        const peerId = node.peerId;
        if (hoverType === 'peerscore') {
          const score = sourceData?.peerScores[peerId];
          if (score !== undefined) {
            label = String(score.toFixed(1)); // Use peerScore for label
          }
        } else if (hoverType === 'rtt') {
          const rtt = sourceData?.rtts[peerId];
          if (rtt !== undefined) {
            label = String(rtt); // Use rtt for label
          }
        }
        // }
      }
    }

    return label
  }

  const handleClickType = () => {
    if (clickType === 'kill') {
      setClickType('info');
    } else {
      setClickType('kill');
    }
  };

  const handleHoverType = () => {
    if (hoverType === 'peerscore') {
      setHoverType('rtt');
    } else {
      setHoverType('peerscore');
    }
  };

  const handleContainerClick = (containerId: string) => {
    if (clickType === 'kill') {
      stopContainer(containerId);
    } else {
      if (selectedContainer == containerId) {
        setSelectedContainer('');
        showContainerInfo('');
      } else {
        setSelectedContainer(containerId);
        showContainerInfo(containerId);
      }
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
    if (selectedContainer === containerId) {
      return '2px solid White';
    }

    return '0px';
  };

  const getBorderRadius = (containerId: string) => {
    if (containerData[containerId]?.type === 'bootstrapper') {
      return '4px';
    }

    return '50%';
  };

  // Utility function to generate random positions within the container
  const getRandomPosition = () => ({
    x: Math.random() * (CONTAINER_WIDTH - nodeSize) + nodeSize / 2,
    y: Math.random() * (CONTAINER_HEIGHT - nodeSize) + nodeSize / 2,
  });

  const areEdgesEqual = (prevConnections: any[], newConnections: any[]) => {
    if (prevConnections.length !== newConnections.length) return false;
    return prevConnections.every(
      (conn, index) =>
        conn.from === newConnections[index].from &&
        conn.to === newConnections[index].to
    );
  };

  // Function to handle WebSocket messages and update containerData
  const handleWebSocketMessage = (data: ContainerData) => {
    setContainerData((prevData) => {
      const existing = prevData[data.containerId];
      if (!existing) return prevData; // If container is not in the data, skip

      // Merge new data with existing containerData while preserving positions and velocities
      return {
        ...prevData,
        [data.containerId]: {
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

  // WebSocket for controller
  // Receives containers list and node updates
  useEffect(() => {
    const ws = new WebSocket(WS_ENDPOINT);

    ws.onopen = () => {
      console.log("Main WebSocket connected - receiving container updates.");
    };

    ws.onmessage = (event) => {
      try {
        const json = JSON.parse(event.data)
        switch (json.mType) {
          case "containerList":
            const updatedContainers: ContainerInfo[] = json.data;
            const runningContainers = updatedContainers.filter((c) => c.state === 'running');
            setContainers(runningContainers);
            initializeContainerData(runningContainers);
            break
          case "nodeStatus":
            handleWebSocketMessage(json)
            break
          default:
            console.log('unknown type', json.type)
            return
        }

      } catch (error) {
        console.error("Error parsing containers from main WebSocket:", error);
      }
    };

    ws.onerror = (error) => {
      console.error("Main WebSocket error:", error);
    };

    ws.onclose = () => {
      console.log("Main WebSocket closed.");
    };

    return () => {
      ws.close();
    };
  }, []);

  // Update edges based on current containerData and mapType
  useEffect(() => {
    const newEdges: { from: string; to: string }[] = [];

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
          // Avoid duplicate edges
          const exists = newEdges.some(
            (conn) =>
              (conn.from === containerId && conn.to === targetContainerId) ||
              (conn.from === targetContainerId && conn.to === containerId)
          );

          if (!exists) {
            newEdges.push({ from: containerId, to: targetContainerId });
          }
        }
      });
    });

    const edgesHaveChanged = !areEdgesEqual(
      prevEdgesRef.current,
      newEdges
    );

    if (edgesHaveChanged) {
      setEdges(newEdges);
    }
  }, [containerData, mapType]);

  // Removed the polling-based fetchContainers interval. We rely on WebSocket updates now.

  // Auto publish if enabled
  useEffect(() => {
    const interval = setInterval(() => {
      if (autoPublish) {
        publishToTopic('', 1);
      }
    }, Number(autoPublishInterval));
    return () => clearInterval(interval);
  }, [autoPublish]);

  // Update node size based on number of containers
  useEffect(() => {
    const minSize = 35; // Minimum node size
    const maxSize = 45; // Maximum node size
    const scalingFactor = 5; // Adjust this to control sensitivity

    if (containers.length === 0) {
      setNodeSize(maxSize); // Default size when no containers
      return;
    }

    // Dynamically scale the node size
    const size = Math.max(
      minSize,
      Math.min(maxSize, maxSize - Math.log(containers.length) * scalingFactor)
    );

    setNodeSize(size);
  }, [containers]);

  // Update min distance
  useEffect(() => {
    const minDistanceMin = nodeSize * 2; // Minimum allowable distance
    const minDistanceMax = nodeSize * 4; // Maximum allowable distance
    const scalingFactor = 1; // Adjust for sensitivity

    if (containers.length === 0) {
      setMinDistance(minDistanceMax); // Default when no containers
      return;
    }

    // Dynamically scale the minDistance
    const distance = Math.max(
      minDistanceMin,
      Math.min(
        minDistanceMax,
        minDistanceMax - Math.log(containers.length) * scalingFactor
      )
    );

    setMinDistance(distance);
  }, [containers, nodeSize]);

  // Compound Spring Embedder Force-Directed Layout Implementation
  useEffect(() => {
    // console.log('useEffect triggered');
    if (mapView !== 'graph') return;

    const centerX = CONTAINER_WIDTH / 2;
    const centerY = CONTAINER_HEIGHT / 2;
    const VELOCITY_THRESHOLD = 0.015; // Threshold for stability
    const STABLE_ITERATIONS = 25; // Number of iterations required to consider stable

    const edgesHaveChanged = !areEdgesEqual(
      prevEdgesRef.current,
      edges
    );

    if (edgesHaveChanged) {
      console.log('Edges changed. Resetting stabilization.');
      stableCountRef.current = 0; // Reset stability count
      stabilizedRef.current = false; // Mark the graph as not stabilized
      prevEdgesRef.current = edges; // Update stored edges
      if (intervalIdRef.current !== null) {
        window.clearInterval(intervalIdRef.current); // Clear the existing interval
      }
    }

    const interval = window.setInterval(() => {
      if (stabilizedRef.current) {
        window.clearInterval(intervalIdRef.current!); // Stop the interval if already stabilized
        return;
      }

      let allStable = true; // Flag to check if all nodes are stable

      setContainerData((prevData) => {
        const updatedData: { [id: string]: ContainerData } = { ...prevData };

        Object.values(updatedData).forEach((node) => {
          let fx = 0;
          let fy = 0;

          // Check node stability
          if (Math.abs(node.vx) > VELOCITY_THRESHOLD || Math.abs(node.vy) > VELOCITY_THRESHOLD) {
            allStable = false; // Node is still moving
            // console.log(`Node ${node.id} not stable. Velocity: (${node.vx}, ${node.vy})`);
            stableCountRef.current = 0;
          }

          // 1. Repulsive Forces between all node pairs
          Object.values(updatedData).forEach((otherNode) => {
            if (node.id === otherNode.id) return;

            const dx = node.x - otherNode.x;
            const dy = node.y - otherNode.y;
            let distance = Math.sqrt(dx * dx + dy * dy) || 1;

            // Prevent division by zero and excessive repulsion
            distance = Math.max(distance, minDistance);

            const repulsion = mapTypeForces[mapType].repulsion / (distance * distance);
            fx += (dx / distance) * repulsion;
            fy += (dy / distance) * repulsion;
          });

          // 2. Attractive Forces for connected nodes
          edges.forEach((conn) => {
            if (conn.from === node.id) {
              const targetNode = updatedData[conn.to];
              if (targetNode) {
                const dx = targetNode.x - node.x;
                const dy = targetNode.y - node.y;
                const distance = Math.sqrt(dx * dx + dy * dy) || 1;

                const attraction = (distance - mapTypeForces[mapType].naturalLength) * mapTypeForces[mapType].attraction;
                fx += (dx / distance) * attraction;
                fy += (dy / distance) * attraction;
              }
            } else if (conn.to === node.id) {
              const targetNode = updatedData[conn.from];
              if (targetNode) {
                const dx = targetNode.x - node.x;
                const dy = targetNode.y - node.y;
                const distance = Math.sqrt(dx * dx + dy * dy) || 1;

                const attraction = (distance - mapTypeForces[mapType].naturalLength) * mapTypeForces[mapType].attraction;

                fx += (dx / distance) * attraction;
                fy += (dy / distance) * attraction;
              }
            }
          });

          // 3. Central Gravity Force
          const dxCenter = centerX - node.x;
          const dyCenter = centerY - node.y;
          fx += dxCenter * mapTypeForces[mapType].gravity;
          fy += dyCenter * mapTypeForces[mapType].gravity;

          // 4. Collision Detection and Resolution
          Object.values(updatedData).forEach((otherNode) => {
            if (node.id === otherNode.id) return;

            const dx = node.x - otherNode.x;
            const dy = node.y - otherNode.y;
            const distance = Math.sqrt(dx * dx + dy * dy) || 1;

            if (distance < minDistance) {
              const overlap = minDistance - distance;
              const collision = (overlap / distance) * mapTypeForces[mapType].collision;
              fx += (dx / distance) * collision;
              fy += (dy / distance) * collision;
            }
          });

          // 5. Update Velocities with Damping
          node.vx = (node.vx + fx) * mapTypeForces[mapType].damping;
          node.vy = (node.vy + fy) * mapTypeForces[mapType].damping;

          // 6. Cap Velocities to Prevent Overshooting
          node.vx = Math.max(-mapTypeForces[mapType].maxVelocity, Math.min(mapTypeForces[mapType].maxVelocity, node.vx));
          node.vy = Math.max(-mapTypeForces[mapType].maxVelocity, Math.min(mapTypeForces[mapType].maxVelocity, node.vy));

          // 7. Update Positions
          node.x += node.vx;
          node.y += node.vy;

          // 8. Boundary Enforcement: Keep Nodes Within Container
          node.x = Math.max(nodeSize / 2, Math.min(CONTAINER_WIDTH - nodeSize / 2, node.x));
          node.y = Math.max(nodeSize / 2, Math.min(CONTAINER_HEIGHT - nodeSize / 2, node.y));
        });

        return updatedData;
      });
      // Update stability state
      if (allStable) {
        stableCountRef.current += 1;
        // console.log(`Stable Count: ${stableCountRef.current}, All Stable: true`);
        if (stableCountRef.current >= STABLE_ITERATIONS) {
          // console.log('Graph has stabilized.');
          stabilizedRef.current = true; // Mark the graph as stabilized
          window.clearInterval(intervalIdRef.current!); // Stop the interval
        }
      } else {
        if (stableCountRef.current > 0) {
          console.log('Graph became unstable again. Resetting stable count.');
        }
        stableCountRef.current = 0; // Reset stability count if instability is detected
      }
    }, 30); // Update every 30ms for smooth animation

    intervalIdRef.current = interval; // Store the interval ID for cleanup

    return () => {
      if (intervalIdRef.current !== null) {
        window.clearInterval(intervalIdRef.current); // Ensure interval is cleared on unmount
      }
    };
  }, [edges, mapView, mapType]);

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
                checked={hasLatencySettings}
                onChange={() => setHasLatencySettings(!hasLatencySettings)}
              />
              <span style={{ marginLeft: '5px' }}>
                Start with latency
              </span>
            </label>
          </div>
          {hasLatencySettings && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0px 10px' }}>

              <div className="input-group">
                <label>
                  Min
                  <input
                    value={minLatency}
                    onChange={(e) => setMinLatency(e.target.value)}
                    style={{ width: '4em' }}
                  />
                </label>
              </div>
              <div className="input-group">
                <label>
                  Max
                  <input
                    value={maxLatency}
                    onChange={(e) => setMaxLatency(e.target.value)}
                    style={{ width: '4em' }}
                  />
                </label>
              </div>
            </div>
          )}
          <div className="input-group">
            <label>
              <input
                type="checkbox"
                checked={hasPacketLossSetting}
                onChange={() => setHasPacketLossSettings(!hasPacketLossSetting)}
              />
              <span style={{ marginLeft: '5px' }}>
                Start with packet loss
              </span>
            </label>
          </div>
          {hasPacketLossSetting && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0px 10px' }}>

              <div className="input-group">
                <label>
                  Loss %
                  <input
                    value={packetLoss}
                    onChange={(e) => setPacketLoss(e.target.value)}
                    style={{ width: '4em' }}
                  />
                </label>
              </div>
            </div>
          )}
          <div className="input-group">
            <label>
              <input
                type="checkbox"
                checked={hasGossipDSettings}
                onChange={() => setHasGossipDSettings(!hasGossipDSettings)}
              />
              <span style={{ marginLeft: '5px' }}>
                Gossip D Settings (not bootstrappers)
              </span>
            </label>
          </div>
          {hasGossipDSettings && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0px 10px' }}>
              <div className="input-group">
                <label>
                  D
                  <input
                    value={gossipD}
                    onChange={(e) => setGossipD(e.target.value)}
                    style={{ width: '2em' }}
                  />
                </label>
              </div>
              <div className="input-group">
                <label>
                  Dlo
                  <input
                    value={gossipDlo}
                    onChange={(e) => setGossipDlo(e.target.value)}
                    style={{ width: '2em' }}
                  />
                </label>
              </div>
              <div className="input-group">
                <label>
                  Dhi
                  <input
                    value={gossipDhi}
                    onChange={(e) => setGossipDhi(e.target.value)}
                    style={{ width: '2em' }}
                  />
                </label>
              </div>
              <div className="input-group">
                <label>
                  Dout
                  <input
                    value={gossipDout}
                    onChange={(e) => setGossipDout(e.target.value)}
                    style={{ width: '2em' }}
                  />
                </label>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0px 10px' }}>
            <div style={{ display: 'flex', gap: '0px 15px' }}>
              <button onClick={handleStartBootstrap1}>Bootstrap 1</button>
              <button onClick={handleStartBootstrap2}>Bootstrap 2</button>
            </div>
            <button onClick={handleStartContainer}>Container</button>
            <button onClick={() => handleStartXContainers(10)}>10 Containers</button>
          </div>

          <h3>Stop Containers</h3>
          <div style={{ display: 'flex', gap: '0px 10px' }}>
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
                    {[...protocols].sort().map((protocol, index) => (
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
          <div style={{ position: 'absolute', top: '0px', left: '0px', zIndex: -1 }}>
            <h1>{mapType}</h1>
            <div>{`Total containers: ${containers.length}`}</div>
            <div>{`Bootstrap containers: ${containers.filter((c) => c.image.includes('bootstrap')).length}`}</div>

            <div>{`Gossip containers: ${containers.filter((c) => c.image.includes('gossip')).length}`}</div>
            <div>
              {`Containers without ${mapType}: ${containers.filter((c) => {
                const data = containerData[c.id]?.[mapType];
                if (Array.isArray(data)) {
                  return data.length === 0;
                } else if (typeof data === 'object' && data !== null) {
                  return Object.keys(data).length === 0;
                }
                // If data is neither an array nor an object, consider it as no connection
                return true;
              }).length
                }`}
            </div>
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
          <div className="graph">
            {mapView === 'graph' && (
              <div>
                <svg className="edges">
                  {edges.map((conn, index) => {
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

                      // If protocols are selected, filter edges
                      if (selectedProtocols.length > 0 && mapType === 'streams') {
                        if (!connectionProtocol || !selectedProtocols.includes(connectionProtocol)) {
                          return null; // Do not render this connection
                        }
                      }

                      // Determine the stroke color based on the protocol
                      let strokeColor = '#ffffff'; // Default color
                      let strokeWidth = 2; // Default strokeWidth
                      let opacity = 0.8; // Default opacity

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
                        strokeWidth = 4;
                        opacity = 1;
                      }

                      return (
                        <line
                          key={index}
                          x1={fromNode.x}
                          y1={fromNode.y}
                          x2={toNode.x}
                          y2={toNode.y}
                          stroke={strokeColor}
                          strokeWidth={strokeWidth}
                          opacity={opacity}
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
                      className="container"
                      onClick={() => handleContainerClick(container.id)}
                      onMouseEnter={() => setHoveredContainerId(container.id)}
                      onMouseLeave={() => setHoveredContainerId(null)}
                      style={{
                        width: `${nodeSize}px`,
                        height: `${nodeSize}px`,
                        lineHeight: `${nodeSize}px`,
                        left: `${node.x}px`,
                        top: `${node.y}px`,
                        fontSize: `${Math.max(8, nodeSize / 3)}px`,
                        backgroundColor: `${getBackgroundColor(container.id)}`,
                        border: `${getBorderStyle(container.id)}`,
                        borderRadius: `${getBorderRadius(container.id)}`,
                        position: 'absolute',
                        transform: `translate(-50%, -50%)`, // Center the node
                        transition: 'background-color 0.2s, border 0.1s', // Smooth transitions
                      }}
                      title={`Container ID: ${container.id}\nPeer ID: ${containerData[container.id]?.peerId || 'Loading...'}`}
                    >
                      {getLabel(container.id)}
                    </div>
                  );
                })}
              </div>
            )}

            {mapView === 'circle' && (
              <div>
                <svg className="edges">
                  {edges.map((conn, index) => {
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

                      let strokeColor = '#ffffff'; // Default color

                      if (connectionProtocol) {
                        const protocolColorMap: { [key: string]: string } = {
                          '/meshsub/1.2.0': '#0fff00',
                          '/ipfs/id/1.0.0': '#00ff00',
                          '/ipfs/ping/1.0.0': '#000ff0',
                        };
                        strokeColor = protocolColorMap[connectionProtocol] || '#000000';
                      } else {
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
                      className="container"
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
                        border: `${getBorderStyle(container.id)}`,
                        borderRadius: `${getBorderRadius(container.id)}`
                      }}
                      title={`Container ID: ${container.id}\nPeer ID: ${containerData[container.id]?.peerId || 'Loading...'}`}
                    >
                      {getLabel(container.id)}
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
          <button onClick={handleHoverType}>Hover Shows: {hoverType}</button>
          <button onClick={() => setConverge(!converge)}>Show Convergence is: {converge ? 'ON' : 'OFF'}</button>
          <button onClick={() => setAutoPublish(!autoPublish)}>Auto Publish is: {autoPublish ? 'ON' : 'OFF'}</button>
          {autoPublish && (
            <div className="input-group">
              <label>
                Interval
                <input
                  value={autoPublishInterval}
                  onChange={(e) => setAutoPublishInterval(e.target.value)}
                  style={{ width: '5em' }}
                /> ms
              </label>
            </div>
          )}
          <button onClick={() => publishToTopic('', 1)}>Publish to random peer</button>
          <button onClick={() => publishToTopic('', 1000)}>Publish 1k to random peers</button>
          {selectedContainer && containerData[selectedContainer] && (
            <div>
              <h3>Peer Info</h3>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0px 10px' }}>
                <button onClick={() => publishToTopic(selectedContainer, 1)}>Publish 1</button>
                <button onClick={() => publishToTopic(selectedContainer, 1_000)}>Publish 1k</button>
                <button onClick={() => publishToTopic(selectedContainer, 100_000)}>Publish 100k</button>
                <button onClick={() => stopContainer(selectedContainer)} style={{ backgroundColor: '#e62020' }}>Stop</button>
              </div>
              <div>Container ID: {selectedContainer}</div>
              <p>Type: {containerData[selectedContainer]?.type}</p>
              <p>Peer ID: {containerData[selectedContainer]?.peerId}</p>
              <div>Outbound Connections: {edges.filter(conn => conn.from === selectedContainer).length}</div>
              <div>Inbound Connections: {edges.filter(conn => conn.to === selectedContainer).length}</div>
              <div>Mesh Peers: {containerData[selectedContainer]?.meshPeers?.length}</div>
              <div>Subscribers: {containerData[selectedContainer]?.subscribers?.length}</div>
              <div>Pubsub Peer Store: {containerData[selectedContainer]?.pubsubPeers?.length}</div>
              <div>Libp2p Peer Store: {containerData[selectedContainer]?.libp2pPeers?.length}</div>
              <div>Protocols: {containerData[selectedContainer]?.protocols?.map((p, index) => <p key={index}>{p}</p>)}</div>
              <div>Multiaddrs: {containerData[selectedContainer]?.multiaddrs?.map((p, index) => <p key={index}>{p}</p>)}</div>
            </div>
          )}
        </div>

        <style jsx>{`
        .app-container {
          display: flex;
          min-height: 100vh;
        }

        .sidebar {
          width: 250px;
          padding: 10px 15px 0px;
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

        .sidebar button.short {
          width: inherit;
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

        .graph {
          position: relative;
          width: ${CONTAINER_WIDTH}px;
          height: ${CONTAINER_HEIGHT}px;
          margin: 0 auto;
          overflow: hidden;
          user-select: none;
        }

        .edges {
          position: absolute;
          width: 100%;
          height: 100%;
          top: 0;
          left: 0;
          pointer-events: none; /* Allow clicks to pass through */
        }

        .container {
          position: absolute;
          background-color: #0070f3;
          color: white;
          border-radius: 50%;
          text-align: center;
          cursor: pointer;
          transform-origin: 50% 50%;
          transition: left 0.1s, top 0.1s, background-color 0.2s, border 0.1s;
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
