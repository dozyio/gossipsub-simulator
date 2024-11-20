import Head from "next/head";
import { useEffect, useState } from 'react';

interface ContainerInfo {
  id: string;
  names: string[];
  image: string;
  status: string;
  state: string;
}

export default function Home() {
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [imageName, setImageName] = useState<string>('nginx:latest');

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
    }
  };

  // Function to start a relay container
  const startRelay = async () => {
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

  useEffect(() => {
    fetchContainers();
    const interval = setInterval(fetchContainers, 5000); // Refresh every 5 seconds
    return () => clearInterval(interval);
  }, []);

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
          <h1>Docker Containers</h1>

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

          {/* Buttons */}
          <button onClick={startRelay}>Start Relay Container</button>
          <button onClick={startContainer}>Start Container</button>
          <button onClick={startTenContainers}>Start 10 Containers</button>
          <button onClick={stopAllContainers}>Stop All Containers</button>
        </div>
        <div className="container-circle">
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
                className="container-item"
                onClick={() => stopContainer(container.id)}
                style={{
                  width: `${itemSize}px`,
                  height: `${itemSize}px`,
                  lineHeight: `${itemSize}px`,
                  transform: `rotate(${angle}deg) translate(0, -${radius}px) rotate(-${angle}deg)`,
                  fontSize: `${fontSize}px`,
                }}
                title={`Container ID: ${container.id}`}
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
