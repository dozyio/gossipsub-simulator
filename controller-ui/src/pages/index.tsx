import Head from "next/head";
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

interface ContainerData {
  peerId: string;
  pubsubPeers: string[];
  subscribers: string[];
  libp2pPeers: string[];
  meshPeers: string[];
  dhtPeers: string[];
  connections: string[];
  protocols: string[];
  multiaddrs: string[];
  streams: StreamsByPeer;
  topics: string[];
  type: string;
  lastMessage: string;
}

type MapType = 'pubsubPeers' | 'libp2pPeers' | 'meshPeers' | 'dhtPeers' | 'subscribers' | 'connections' | 'streams';
type ClickType = 'kill' | 'info'

const DEBUG_STRING = 'DEBUG=*,*:trace,-*peer-store:trace'

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
  const [selectedContainer, setSelectedContainer] = useState<string>('');

  // Function to fetch containers from the backend
  const fetchContainers = async () => {
    try {
      const response = await fetch('http://localhost:8080/containers');
      if (!response.ok) {
        throw new Error(`Error fetching containers: ${response.statusText}`);
      }
      const data: ContainerInfo[] = await response.json();
      const runningContainers = data.filter((c) => c.state === 'running');
      setContainers(runningContainers)

      const runningContainerIds = new Set(runningContainers.map((c) => c.id));
      setContainerData((prevData) => {
        const newData = { ...prevData };
        Object.keys(newData).forEach((id) => {
          if (!runningContainerIds.has(id)) {
            delete newData[id];
          }
        });
        return newData;
      });

    } catch (error) {
      console.error('Error fetching containers:', error);
      setContainers([])
      setContainerData({})
      setConnections([])
    }
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
      console.log('Bootstrap Container started:', data);
      await fetchContainers(); // Refresh the container list
      return data
    } catch (error) {
      console.error('Error starting container:', error);
    }
  }

  // Function to start a bootstrapper container
  const handleStartBootstrap1 = async () => {
    // 12D3KooWJwYWjPLsTKiZ7eMjDagCZh9Fqt1UERLKoPb5QQNByrAF
    const env = [
      'SEED=0xddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd1'
    ]

    if (debugContainer) {
      env.push(DEBUG_STRING)
    }

    await startContainer('bootstrapper:dev', env, "bootstrapper1")
  };
  const handleStartBootstrap2 = async () => {
    // 12D3KooWAfBVdmphtMFPVq3GEpcg3QMiRbrwD9mpd6D6fc4CswRw
    const env = [
      'SEED=0xddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd2'
    ]

    if (debugContainer) {
      env.push(DEBUG_STRING)
    }

    await startContainer('bootstrapper:dev', env, "bootstrapper2")
  };

  // Function to start a new container
  const handleStartContainer = async () => {
    const env = []

    if (debugContainer) {
      env.push(DEBUG_STRING)
    }

    await startContainer(imageName, env)
  };

  const handleStartXContainers = async () => {
    const env = []

    if (debugContainer) {
      env.push(DEBUG_STRING)
    }

    try {
      const promises = [];
      for (let i = 0; i < 12; i++) {
        promises.push(
          startContainer(imageName, env)
        );
      }
      await Promise.all(promises);
      // for (const response of responses) {
      //   if (!response.ok) {
      //     const errorText = await response.text();
      //     throw new Error(`Error starting container: ${errorText}`);
      //   }
      // }
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

  const stopXContainers = async (amount = 10) => {
    const shuffled = containers.slice();

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
        if (containerData[container.id].type === 'bootstrapper') {
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
          throw new Error(`Error stopping all containers: ${errorText}`);
        }

        // fetchContainers(); // Refresh the container list
      } catch (error) {
        console.error('Error stopping all containers:', error);
      }
    }
  };

  const getRandomColor = () => {
    const letters = '0123456789ABCDEF';
    let color = '#';
    for (let i = 0; i < 6; i++) {
      color += letters[Math.floor(Math.random() * 16)];
    }
    return color;
  }

  const publishToTopic = async (amount = 1000) => {
    setConverge(true)

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
        // Generate a random index
        const randomIndex = Math.floor(Math.random() * sockets.length);

        // Return the randomly selected WebSocket
        const s = sockets[randomIndex]

        const message = {
          type: 'publish',
          message: getRandomColor()
        }

        s.send(JSON.stringify(message))
      }

      console.log('Message published to topic');
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
      // Extract all WebSocket instances, filtering out nulls
      const s = containerSockets.current[containerId]

      if (!s) {
        throw new Error('No WebSocket connection available for container ID');
      }

      const message = {
        type: 'info',
        message: ''
      }

      s.send(JSON.stringify(message))

      console.log('Info message sent to container');
    } catch (error) {
      console.error('Error sending info message:', error);
    }
  }

  const handleClickType = () => {
    if (clickType === 'kill') {
      setClickType('info')
    } else {
      setClickType('kill')
    }
  }

  const handleContainerClick = (containerId: string) => {
    if (clickType === 'kill') {
      stopContainer(containerId)
    } else {
      if (selectedContainer === containerId) {
        setSelectedContainer('')
        return
      }

      setSelectedContainer(containerId)
      console.log('handleContainerClick', containerId)
      showContainerInfo(containerId)
    }
  }

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

  // Manage WebSocket connections
  useEffect(() => {
    // Function to handle WebSocket messages and update containerData
    const handleWebSocketMessage = (containerId: string, data: ContainerData) => {
      setContainerData((prevData) => ({
        ...prevData,
        [containerId]: {
          ...prevData[containerId],
          ...data, // Merge new data with existing containerData
        },
      }));

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
        )

        if (portMapping && portMapping.public_port) {
          const wsUrl = `ws://localhost:${portMapping.public_port}/`;
          const ws = new WebSocket(wsUrl);

          ws.onopen = () => {
            console.log(`WebSocket connected for container ${container.id}`);
          };

          ws.onmessage = (event) => {
            try {
              const data: ContainerData = JSON.parse(event.data);
              console.log('Received WebSocket message:', data);
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

  useEffect(() => {
    const interval = setInterval(async () => {
      await fetchContainers()
    }, 200)
    return () => clearInterval(interval);
  }, [containers, fetchContainers]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (autoPublish) {
        publishToTopic(1)
      }
    }, 250)
    return () => clearInterval(interval);
  }, [autoPublish]);

  return (
    <>
      <Head>
        <title>Docker Containers</title>
        <meta name="description" content="Manage Docker containers" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <div className="app-container">
        <div className="sidebar sidebar1">
          {/* Input box for Docker image name */}
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

          {/* Display the number of running containers */}
          <p>{`Running containers: ${containers.length}`}</p>
          <p>{`Showing ${mapType}`}</p>

          <h3>Start Containers</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0px 10px' }}>
            <button onClick={handleStartBootstrap1}>Bootstrap1</button>
            <button onClick={handleStartBootstrap2}>Bootstrap2</button>
            <button onClick={handleStartContainer}>Container</button>
            <button onClick={handleStartXContainers}>X Containers</button>
            <label>
              <input
                type="checkbox"
                checked={debugContainer}
                onChange={() => setDebugContainer(!debugContainer)}
              />
              Start with debug
            </label>
          </div>
          <h3>Stop Containers</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0px 10px' }}>
            <button onClick={() => stopXContainers(Math.floor(containers.length / 4))}>Stop Some</button>
            <button onClick={stopAllContainers} style={{ backgroundColor: '#e62020' }}>Stop All</button>
          </div>
          <h3>Show</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0px 10px' }}>
            <button onClick={() => setMapType('connections')}>Connections</button>
            <button onClick={() => setMapType('meshPeers')}>Mesh Peers</button>
            <button onClick={() => setMapType('streams')}>Streams</button>
            <button onClick={() => setMapType('subscribers')}>Subscribers</button>
            <button onClick={() => setMapType('pubsubPeers')}>Pubsub Peer Store</button>
            <button onClick={() => setMapType('libp2pPeers')}>Libp2p Peer Store</button>
            <button onClick={() => setMapType('dhtPeers')}>DHT Known Peers</button>
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
        <div className="middle">
          <div className="container-circle">
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
                    transform: `rotate(${angle}deg) translate(0, -${radius}px) rotate(-${angle}deg)`,
                    fontSize: `${fontSize}px`,
                    backgroundColor: `${converge ? containerData[container.id]?.lastMessage : `#${container.id.substring(0, 6)}`}`,
                    border: `${containerData[container.id]?.type === 'bootstrapper' ? '3px solid white' : '0px'}`
                  }}
                  title={`Container ID: ${container.id}\nPeer ID: ${containerData[container.id]?.peerId || 'Loading...'}\nConnections: ${connections.filter(conn => conn.from === container.id || conn.to === container.id).length}`}
                >
                  {container.image.split(':')[0]}
                </div>
              );})}
          </div>
        </div>
        <div className="sidebar sidebar2">
          <h1>Gossip Simulator</h1>
          <button onClick={handleClickType}>Clicks: {clickType}</button>
          <button onClick={() => setConverge(!converge)}>Show Convergence is: {converge ? 'ON' : 'OFF'}</button>
          <button onClick={() => publishToTopic(1)}>Publish to topic</button>
          <button onClick={() => publishToTopic(1000)}>Publish 1000 to topic</button>
          <button onClick={() => setAutoPublish(!autoPublish)}>Auto Publish is: {autoPublish ? 'ON' : 'OFF'}</button>
          {selectedContainer && (
            <div>
              <h3>Info</h3>
              <button onClick={() => stopContainer(selectedContainer)}>Kill</button>
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
        <style jsx>{`
        .app-container {
          display: flex;
          min-height: 100vh;
        }

        .sidebar {
          width: 250px;
          padding: 15px;
          background-color: #111111;
        }

        .sidebar h1 {
          text-align: center;
          margin-bottom: 30px;
        }

        .input-group {
          margin-bottom: 20px;
        }

        .input-group label {
          display: flex;
          flex-direction: column;
          font-size: 16px;
        }

        .input-group input {
          margin-top: 5px;
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
          padding: 5px;
          font-size: 16px;
          cursor: pointer;
        }

        .middle {
          flex-grow: 1;
        }

        .container-circle {
          position: relative;
          width: 800px;
          height: 800px;
          margin: 0 auto;
          overflow: hidden;
        }

        .connections {
          position: absolute;
          width: 100%;
          height: 100%;
          top: 0;
          left: 0;
        }

        .container-item {
          position: absolute;
          background-color: #0070f3;
          color: white;
          border-radius: 50%;
          text-align: center;
          cursor: pointer;
          left: 50%;
          top: 50%;
          transform-origin: 0 0;
          transition: transform 0.5s;
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
        }

        .protocol-list li {
          margin-bottom: 5px;
        }

        .protocol-list label {
          cursor: pointer;
        }
      `}</style>
      </div>
    </>
  );
}
