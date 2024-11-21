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

interface ContainerData {
  peerId: string;
  peers: string[];
  subscribers: string[];
  connections: string[];
  topics: string[];
  type: string;
}

type MapType = 'peers' | 'subscribers' | 'connections';

export default function Home() {
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [imageName, setImageName] = useState<string>('gossip:dev');
  const [containerData, setContainerData] = useState<{ [id: string]: ContainerData }>({});
  const containerRefs = useRef<{ [id: string]: HTMLDivElement | null }>({});
  const [connections, setConnections] = useState<{ from: string; to: string }[]>([]);
  const [mapType, setMapType] = useState<MapType>('connections');

  // Function to fetch containers from the backend
  const fetchContainers = async () => {
    try {
      const response = await fetch('http://localhost:8080/containers');
      if (!response.ok) {
        throw new Error(`Error fetching containers: ${response.statusText}`);
      }
      const data: ContainerInfo[] = await response.json();
      setContainers(data.filter((c) => c.state === 'running'));
    } catch (error) {
      console.error('Error fetching containers:', error);
      setContainers([])
      setContainerData({})
      setConnections([])
    }
  };

  // Function to start a relay container
  const startBootstrap = async () => {
    try {
      const response = await fetch('http://localhost:8080/containers/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          image: 'relay:dev',
          port: 80,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Error starting container: ${errorText}`);
      }

      const data = await response.json();
      console.log('Container started:', data);
      fetchContainers(); // Refresh the container list
    } catch (error) {
      console.error('Error starting container:', error);
    }
  };

  // Function to start a new container
  const startContainer = async () => {
    try {
      const response = await fetch('http://localhost:8080/containers/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          image: imageName,
          port: 80,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Error starting container: ${errorText}`);
      }

      const data = await response.json();
      console.log('Container started:', data);
      fetchContainers(); // Refresh the container list
    } catch (error) {
      console.error('Error starting container:', error);
    }
  };

  // Function to start 10 containers
  const startTenContainers = async () => {
    try {
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          fetch('http://localhost:8080/containers/create', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              image: imageName,
              port: 80,
            }),
          })
        );
      }
      const responses = await Promise.all(promises);
      for (const response of responses) {
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Error starting container: ${errorText}`);
        }
      }
      console.log('10 containers started');
      fetchContainers(); // Refresh the container list
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
      fetchContainers(); // Refresh the container list
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

      console.log('All containers stopped');
      fetchContainers(); // Refresh the container list
    } catch (error) {
      console.error('Error stopping all containers:', error);
    }
  };

  // Update connections based on containerData
  useEffect(() => {
    const newConnections: { from: string; to: string }[] = [];

    Object.keys(containerData).forEach((containerId) => {
      const data = containerData[containerId];

      const connectionList = data && data[mapType]
      console.log({mapType, connectionList})
      if (connectionList && Array.isArray(connectionList)) {
        connectionList.forEach((peerId) => {
          // Find the container that has this peerId
          const targetContainerId = Object.keys(containerData).find(
            (id) => containerData[id]?.peerId === peerId
          );

          if (targetContainerId) {
            // Avoid duplicate connections
            if (!newConnections.some(conn => conn.from === containerId && conn.to === targetContainerId)) {
              newConnections.push({ from: containerId, to: targetContainerId });
            }
          }
        });
      }
    });

    setConnections(newConnections);
  }, [containerData, mapType]);

  useEffect(() => {
    const pollContainers = () => {
      if (containers.length === 0) {
        return
      }

      console.log('Polling containers');
      containers.forEach((container) => {
        console.log('Polling container', container.id);
        // Get the public port from the container's port mappings
        const portMapping = container.ports.find((port) => port.type === 'tcp');
        if (portMapping && portMapping.public_port) {
          const url = `http://localhost:${portMapping.public_port}/`;

          fetch(url)
            .then((response) => response.json())
            .then((data) => {
              setContainerData((prevData) => ({
                ...prevData,
                [container.id]: data,
              }));
            })
            .catch((error) => {
              console.error(`Error fetching data from container ${container.id}:`, error);
            });
        }
      });
    };


    const interval = setInterval(() => {
      fetchContainers()
      pollContainers()
    }, 100)
    return () => clearInterval(interval);
  }, [containers, fetchContainers]);


  return (
    <>
      <Head>
        <title>Docker Containers</title>
        <meta name="description" content="Manage Docker containers" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <div className="app-container">
        <div className="sidebar">
          <h1>Gossip Simulator</h1>

          {/* Input box for Docker image name */}
          <div className="input-group">
            <label>
              Docker Image Name:
              <input
                type="text"
                value={imageName}
                onChange={(e) => setImageName(e.target.value)}
              />
            </label>
          </div>

          {/* Display the number of running containers */}
          <p>{`Number of running containers: ${containers.length}`}</p>
          <p>{`Showing ${mapType}`}</p>

          {/* Buttons */}
          <button onClick={startBootstrap}>Start Bootstrap</button>
          <button onClick={startContainer}>Start Container</button>
          <button onClick={startTenContainers}>Start 10 Containers</button>
          <button onClick={stopAllContainers}>Stop All Containers</button>
          <button onClick={() => setMapType('connections')}>Show Connections</button>
          <button onClick={() => setMapType('peers')}>Show Known Peers</button>
          <button onClick={() => setMapType('subscribers')}>Show Subscribers</button>
        </div>
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

                return (
                  <line
                    key={index}
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    stroke={`#${conn.from.substring(0, 6)}`}
                    strokeWidth="2"
                  />
                );
              }
            })}
          </svg>
          {containers.map((container, index) => {
            const numContainers = containers.length;

            // Arrange containers in a single circle
            const angle = (index / numContainers) * 360;
            const radius = 300; // Fixed radius

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
                onClick={() => stopContainer(container.id)}
                style={{
                  width: `${itemSize}px`,
                  height: `${itemSize}px`,
                  lineHeight: `${itemSize}px`,
                  transform: `rotate(${angle}deg) translate(0, -${radius}px) rotate(-${angle}deg)`,
                  fontSize: `${fontSize}px`,
                  backgroundColor: `#${container.id.substring(0, 6)}`
                }}
                title={`Container ID: ${container.id}\nPeer ID: ${containerData[container.id]?.peerId || 'Loading...'}`}
              >
                {container.image}
              </div>
            );
          })}
        </div>
        <style jsx>{`
        .app-container {
          display: flex;
          min-height: 100vh;
        }

        .sidebar {
          width: 250px;
          padding: 20px;
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

        .sidebar p {
          font-size: 18px;
          margin-bottom: 20px;
          text-align: center;
        }

        .sidebar button {
          display: block;
          width: 100%;
          margin-bottom: 10px;
          padding: 10px;
          font-size: 16px;
          cursor: pointer;
        }

        .container-circle {
          position: relative;
          flex-grow: 1;
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
      `}</style>
      </div>
    </>
  );
}
