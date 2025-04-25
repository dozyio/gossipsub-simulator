import Head from 'next/head'
import { FaCircleNodes } from 'react-icons/fa6'
import { FaRegCircle } from 'react-icons/fa'
import { useEffect, useMemo, useRef, useState } from 'react'

interface PortMapping {
  ip: string
  private_port: number
  public_port: number
  type: string
}

interface ContainerData {
  id: string
  names: string[]
  image: string
  status: string
  state: string
  ports: PortMapping[]
}

interface Stream {
  protocol: string
  direction: 'inbound' | 'outbound'
}

interface StreamsByPeer {
  [peerId: string]: Stream[]
}

interface PeerScores {
  [peerId: string]: number
}

// round trip times
interface RRTs {
  [peerId: string]: number
}

interface RemotePeerData {
  multiaddrs: string[]
  protocols: string[]
  x?: number
  y?: number
  vx?: number // Velocity X
  vy?: number // Velocity Y
}

interface RemotePeers {
  [peerId: string]: RemotePeerData
}

interface PeerData {
  containerId: string
  id: string // Unique identifier
  peerId: string
  tcpdumping: boolean
  pubsubPeers: string[]
  subscribersList: Record<string, string[]>
  libp2pPeers: string[]
  meshPeersList: Record<string, string[]>
  fanoutList: Map<string, Set<string>>
  dhtPeers: string[]
  connections: string[] // peer ids of connections
  remotePeers: RemotePeers
  protocols: string[]
  multiaddrs: string[]
  streams: StreamsByPeer
  topics: string[]
  type: string
  lastMessage: string
  peerScores: PeerScores
  rtts: RRTs
  connectTime: number
  x: number
  y: number
  vx: number // Velocity X
  vy: number // Velocity Y
}

type MapType = 'pubsubPeers' | 'libp2pPeers' | 'meshPeers' | 'dhtPeers' | 'subscribers' | 'connections' | 'streams'
type ClickType = 'kill' | 'info' | 'connect' | 'connectTo'
type HoverType = 'peerscore' | 'rtt'
type MapView = 'circle' | 'graph'
type ControllerStatus = 'offline' | 'online' | 'connecting'

const ENDPOINT = 'http://localhost:8080'
const WS_ENDPOINT = 'ws://localhost:8080/ws'
const DEBUG_STRING = 'DEBUG=*,*:trace,-*libp2p:peer-store:trace'

// Container dimensions
const CONTAINER_WIDTH = 800
const CONTAINER_HEIGHT = 800

// Force strengths
// Compound Spring Embedder layout
const DEFAULT_FORCES = {
  repulsion: 100_000, // Adjusted for CSE
  attraction: 0.2, // Adjusted for CSE
  collision: 100, // Adjusted for CSE
  gravity: 0.05, // Central gravity strength
  damping: 0.1, // Velocity damping factor
  maxVelocity: 80, // Maximum velocity cap
  naturalLength: 100, // Natural length for springs (ideal distance between connected nodes)
}

const mapTypeForces = {
  pubsubPeers: DEFAULT_FORCES,
  libp2pPeers: DEFAULT_FORCES,
  meshPeers: DEFAULT_FORCES,
  dhtPeers: DEFAULT_FORCES,
  subscribers: DEFAULT_FORCES,
  connections: DEFAULT_FORCES,
  streams: DEFAULT_FORCES,
}

export default function Home() {
  // container stuff
  const [containers, setContainers] = useState<ContainerData[]>([])

  // peer and remote peer stuff
  const [peerData, setPeerData] = useState<{ [containerId: string]: PeerData }>({})
  const [remotePeerData, setRemotePeerData] = useState<RemotePeers>({})

  // ui config
  const [imageName, setImageName] = useState<string>('gossip:dev')
  const [hoveredContainerId, setHoveredContainerId] = useState<string | null>(null)
  const [converge, setConverge] = useState<boolean>(true)
  const [clickType, setClickType] = useState<ClickType>('info')
  const [hoverType, setHoverType] = useState<HoverType>('rtt')
  const [autoPublish, setAutoPublish] = useState<boolean>(false)
  const [protocols, setProtocols] = useState<string[]>([])
  const [topics, setTopics] = useState<string[]>([])
  const [selectedProtocols, setSelectedProtocols] = useState<string[]>([])
  const [selectedTopic, setSelectedTopics] = useState<string>('')
  const [selectedContainer, setSelectedContainer] = useState<string>('')
  const [selectedRemotePeer, setSelectedRemotePeer] = useState<string>('')
  const [autoPublishInterval, setAutoPublishInterval] = useState<string>('1000')
  const [connectMultiaddr, setConnectMultiaddr] = useState<string>('')

  // network config
  const [topicsName, setTopicsName] = useState<string>('pubXXX-dev')
  const [debugContainer, setDebugContainer] = useState<boolean>(false)
  const [debugStr, setDebugStr] = useState<string>(DEBUG_STRING)
  const [hasGossipDSettings, setHasGossipDSettings] = useState<boolean>(false)
  const [gossipD, setGossipD] = useState<string>('8')
  const [gossipDlo, setGossipDlo] = useState<string>('6')
  const [gossipDhi, setGossipDhi] = useState<string>('12')
  const [gossipDout, setGossipDout] = useState<string>('2')
  const [hasLatencySettings, setHasLatencySettings] = useState<boolean>(false)
  const [minLatency, setMinLatency] = useState<string>('20')
  const [maxLatency, setMaxLatency] = useState<string>('200')
  const [hasPacketLossSetting, setHasPacketLossSettings] = useState<boolean>(false)
  const [packetLoss, setPacketLoss] = useState<string>('5')
  const [hasPerfSetting, setHasPerfSetting] = useState<boolean>(false)
  const [perfBytes, setPerfBytes] = useState<string>('1')
  const [disableNoise, setDisableNoise] = useState<boolean>(false)

  // graph stuff
  const [edges, setEdges] = useState<{ from: string; to: string }[]>([])
  const prevEdgesRef = useRef(edges) // Store previous connections for comparison
  const containerRefs = useRef<{ [id: string]: HTMLDivElement | null }>({})
  const remotePeerRefs = useRef<{ [id: string]: HTMLDivElement | null }>({})
  const [mapType, setMapType] = useState<MapType>('connections')
  const [mapView, setMapView] = useState<MapView>('graph')
  const stableCountRef = useRef(0) // Track stable state count
  const stabilizedRef = useRef(false) // Track if graph is already stabilized
  const intervalIdRef = useRef<number | null>(null) // Store interval ID
  const [nodeSize, setNodeSize] = useState<number>(35)
  const [minDistance, setMinDistance] = useState<number>(nodeSize * 4)

  // controller websocket stuff
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeout = useRef<number | null>(null)
  const [controllerStatus, setControllerStatus] = useState<ControllerStatus>('connecting')

  const initializeContainerData = (runningContainers: ContainerData[]): void => {
    setPeerData((prevData) => {
      const newData: { [id: string]: PeerData } = {}

      runningContainers.forEach((container) => {
        if (prevData[container.id]) {
          // Retain existing data for running containers
          newData[container.id] = prevData[container.id]
        } else {
          // Initialize data for new containers
          const { x, y } = getRandomPosition()
          newData[container.id] = {
            containerId: container.id,
            id: container.id,
            peerId: '',
            tcpdumping: false,
            pubsubPeers: [],
            subscribersList: {},
            libp2pPeers: [],
            meshPeersList: {},
            fanoutList: new Map<string, Set<string>>(),
            dhtPeers: [],
            connections: [],
            remotePeers: {},
            protocols: [],
            multiaddrs: [],
            streams: {},
            topics: [],
            type: '',
            lastMessage: '',
            peerScores: {},
            rtts: {},
            connectTime: -1,
            x,
            y,
            vx: 0,
            vy: 0,
          }
        }
      })

      return newData
    })
  }

  const startContainer = async (image: string, env: string[], hostname: string = ''): Promise<ContainerData | void> => {
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
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Error starting container: ${errorText}`)
      }

      const data = await response.json()
      console.log('Container starting:', data)

      return data
    } catch (error) {
      console.error('Error starting container:', error)
    }
  }

  const envSetter = (env: string[] = [], isBootstrap: boolean = false): string[] => {
    env.push(`TOPICS=${topicsName}`)

    if (debugContainer) {
      env.push(debugStr)
    }

    if (hasLatencySettings || hasPacketLossSetting) {
      let str = 'NETWORK_CONFIG='

      if (hasLatencySettings && minLatency !== '0' && maxLatency !== '0') {
        str = `${str}delay=${Math.floor(Math.random() * (parseInt(maxLatency) - parseInt(minLatency)) + parseInt(minLatency))}ms`
      }

      if (
        hasLatencySettings &&
        minLatency !== '0' &&
        maxLatency !== '0' &&
        hasPacketLossSetting &&
        packetLoss !== '0'
      ) {
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
      env.push('GOSSIP_D=0')
      env.push('GOSSIP_DLO=0')
      env.push('GOSSIP_DHI=0')
      env.push('GOSSIP_DOUT=0')
    } else {
      if (hasGossipDSettings) {
        env.push(`GOSSIP_D=${gossipD}`)
        env.push(`GOSSIP_DLO=${gossipDlo}`)
        env.push(`GOSSIP_DHI=${gossipDhi}`)
        env.push(`GOSSIP_DOUT=${gossipDout}`)
      }
    }

    if (hasPerfSetting && perfBytes) {
      env.push(`PERF=${perfBytes}`)
    }

    if (disableNoise) {
      env.push('DISABLE_NOISE=1')
    }

    return env
  }

  const handleStartBootstrap1 = async (): Promise<void> => {
    // 12D3KooWJwYWjPLsTKiZ7eMjDagCZh9Fqt1UERLKoPb5QQNByrAF
    let env = ['SEED=0xddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd1']

    env = envSetter(env, true)

    await startContainer('bootstrapper:dev', env, 'bootstrapper1')
  }

  const handleStartBootstrap2 = async (): Promise<void> => {
    // 12D3KooWAfBVdmphtMFPVq3GEpcg3QMiRbrwD9mpd6D6fc4CswRw
    let env = ['SEED=0xddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd2']

    env = envSetter(env, true)

    await startContainer('bootstrapper:dev', env, 'bootstrapper2')
  }

  // Function to start a new container
  const handleStartContainer = async (): Promise<void> => {
    const env = envSetter()

    await startContainer(imageName, env)
  }

  const handleStartXContainers = async (amount = 12): Promise<void> => {
    try {
      const promises = []
      for (let i = 0; i < amount; i++) {
        const env = envSetter()

        promises.push(startContainer(imageName, env))
      }
      await Promise.all(promises)
    } catch (error) {
      console.error('Error starting containers:', error)
    }
  }

  const stopContainer = async (containerID: string): Promise<void> => {
    try {
      const response = await fetch(`${ENDPOINT}/containers/stop`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          container_id: containerID,
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Error stopping container: ${errorText}`)
      }

      console.log(`Container ${containerID} stopped`)
    } catch (error) {
      console.error('Error stopping container:', error)
    }
  }

  const stopAllContainers = async (): Promise<void> => {
    setRemotePeerData({})
    setPeerData({})
    setContainers([])

    try {
      const response = await fetch(`${ENDPOINT}/containers/stopall`, {
        method: 'POST',
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Error stopping all containers: ${errorText}`)
      }
    } catch (error) {
      console.error('Error stopping all containers:', error)
    }
  }

  const stopXContainers = async (amount = 5): Promise<void> => {
    // Only stop gossip containers
    const gossipContainers = containers.filter((c) => c.image.includes('gossip'))
    const shuffled = gossipContainers.slice()

    for (let i = shuffled.length - 1; i > 0; i--) {
      // Generate a random index from 0 to i
      const j = Math.floor(Math.random() * (i + 1))
      // Swap elements at indices i and j
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }

    // Return the first x elements
    const toStop = shuffled.slice(0, amount)

    for (const container of toStop) {
      try {
        if (peerData[container.id]?.type === 'bootstrapper') {
          continue
        }

        const response = await fetch(`${ENDPOINT}/containers/stop`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            container_id: container.id,
          }),
        })

        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(`Error stopping container: ${errorText}`)
        }
      } catch (error) {
        console.error('Error stopping container:', error)
      }
    }
  }

  const getLogs = async (containerId: string): Promise<void> => {
    try {
      const res = await fetch(`${ENDPOINT}/logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ container_id: containerId }),
      })
      if (!res.ok) {
        console.error('Error fetching logs:', res.status)
        return
      }

      const text = await res.text()
      console.log(text)
      const blob = new Blob([text], { type: 'text/plain' })

      // Create a download link and click it
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${containerId}.log`
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.URL.revokeObjectURL(url)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      console.error('Error downloading logs:', err)
    }
  }

  const startTCPDump = async (containerId: string): Promise<void> => {
    try {
      const res = await fetch(`${ENDPOINT}/tcpdump/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          container_id: containerId,
        }),
      })

      if (!res.ok) {
        console.log('Error starting tcpdump:', res.status)
        throw new Error(`Error starting tcpdump ${res.status}`)
      }

      setPeerData((prevData) => {
        const existing = prevData[containerId]
        if (!existing) return prevData

        return {
          ...prevData,
          [containerId]: {
            ...existing,
            tcpdumping: true,
          },
        }
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      console.log('Error starting tcpdump:', err)
    }
  }

  const stopTCPDump = async (containerId: string): Promise<void> => {
    try {
      const res = await fetch(`${ENDPOINT}/tcpdump/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          container_id: containerId,
        }),
      })
      if (!res.ok) {
        throw new Error(`Status ${res.status}`)
      }

      setPeerData((prevData) => {
        const existing = prevData[containerId]
        if (!existing) return prevData

        return {
          ...prevData,
          [containerId]: {
            ...existing,
            tcpdumping: false,
          },
        }
      })

      const blob = await res.blob()
      const downloadUrl = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = downloadUrl
      a.download = `${containerId}.pcap`
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.URL.revokeObjectURL(downloadUrl)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      console.error('Error stopping tcpdump:', err)
    }
  }

  const publishToTopic = async (containerId: string = '', amount = 1): Promise<void> => {
    if (containers.length === 0) {
      return
    }

    interface Body {
      amount: number
      topic: string
      containerId?: string
    }

    const body: Body = {
      amount: amount,
      topic: selectedTopic,
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
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Error publishing: ${errorText}`)
      }
    } catch (error) {
      console.error('Error publishing:', error)
    }
  }

  const showContainerInfo = (containerId: string): void => {
    console.log('Current containerData:', peerData)

    const data = peerData[containerId]
    if (data) {
      console.log(`Container Data for ID ${containerId}:`, data)
      console.log(`Container Data for ID ${containerId}:`, data.remotePeers)
    }
  }

  const showRemotePeerInfo = (peerId: string): void => {
    console.log('Current remotePeer:', peerId)

    const data = remotePeerData[peerId]
    if (data) {
      console.log(`Container Data for ID ${peerId}:`, data)
    }
  }

  const connectContainers = async (srcContainerId: string, dstContainerId: string) => {
    if (containers.length === 0) {
      return
    }

    // only supports ipv4 for now
    const firstNonLoopback = peerData[dstContainerId]?.multiaddrs.find((addr) => {
      const ipMatch = addr.match(/\/ip4\/([\d.]+)/)
      if (ipMatch && ipMatch[1]) {
        const ip = ipMatch[1]
        return ip !== '127.0.0.1'
      }
      return false
    })

    if (!firstNonLoopback) {
      console.log('No non-loopback IPv4 address found for container', dstContainerId)
      return
    }

    await connectTo(srcContainerId, firstNonLoopback)
  }

  const connectTo = async (srcContainerId: string, toMultiaddr: string): Promise<void> => {
    if (containers.length === 0) {
      return
    }

    interface Body {
      containerId: string
      toMultiaddr: string
    }

    const body: Body = {
      containerId: srcContainerId,
      toMultiaddr,
    }

    try {
      console.log('Sending connect', body)

      const response = await fetch(`${ENDPOINT}/connect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Error connecting: ${errorText}`)
      }
    } catch (error) {
      console.error('Error connecting:', error)
    }
  }

  const getLabel = (containerId: string): string => {
    const container = containers.find((c) => c.id === containerId)
    const node = peerData[containerId]

    if (!container || !node) {
      return ''
    }

    let label = container.image.split(':')[0]

    // Determine the source of interaction: Hovered or Selected
    const sourceContainerId = hoveredContainerId || selectedContainer

    if (sourceContainerId) {
      const sourceData = peerData[sourceContainerId]
      if (sourceData) {
        let relatedPeerIds: string[] = []
        let relatedContainerIds: string[] = []

        switch (mapType) {
          case 'streams':
            relatedPeerIds = Object.keys(sourceData.streams) // Peer IDs from streams
            break
          case 'connections':
            relatedPeerIds = sourceData[mapType]
            break
          case 'pubsubPeers':
            relatedPeerIds = sourceData[mapType]
            break
          case 'meshPeers':
            relatedPeerIds = sourceData['meshPeersList'][selectedTopic]
            break
          case 'subscribers':
            relatedPeerIds = sourceData['subscribersList'][selectedTopic]
            break
          case 'libp2pPeers':
            relatedPeerIds = sourceData[mapType]
            break
          case 'dhtPeers':
            relatedPeerIds = sourceData[mapType]
            break

          default:
            relatedPeerIds = sourceData[mapType] // Peer IDs
            break
        }

        // Map peer IDs to container IDs if necessary
        if (relatedPeerIds?.length > 0) {
          relatedContainerIds = Object.keys(peerData).filter((id) => relatedPeerIds.includes(peerData[id]?.peerId))
        }

        // Check if the current container is related
        // if (relatedContainerIds.includes(container.id)) {
        const peerId = node.peerId
        if (hoverType === 'peerscore') {
          const score = sourceData?.peerScores[peerId]
          if (score !== undefined) {
            label = String(score.toFixed(1)) // Use peerScore for label
          }
        } else if (hoverType === 'rtt') {
          const rtt = sourceData?.rtts[peerId]
          if (rtt !== undefined) {
            label = String(rtt) // Use rtt for label
          }
        }
        // }
      }
    }

    return label
  }

  const handleClickType = (): void => {
    if (clickType === 'kill') {
      setClickType('info')
    }

    if (clickType === 'info') {
      setClickType('connect')
    }

    if (clickType === 'connect') {
      setClickType('kill')
    }

    if (clickType === 'connectTo') {
      setClickType('connect')
    }
  }

  const handleContainerClick = (containerId: string): void => {
    setSelectedRemotePeer('')
    showRemotePeerInfo('')

    if (clickType === 'kill') {
      stopContainer(containerId)
    }

    if (clickType === 'info') {
      if (selectedContainer == containerId) {
        setSelectedContainer('')
        showContainerInfo('')
      } else {
        setSelectedContainer(containerId)
        showContainerInfo(containerId)
      }
    }

    if (clickType === 'connect') {
      setSelectedContainer(containerId)
      showContainerInfo(containerId)
      setClickType('connectTo')
    }

    if (clickType === 'connectTo') {
      connectContainers(selectedContainer, containerId)
      setClickType('connect')
    }
  }

  const handleRemotePeerClick = (peerId: string): void => {
    setSelectedContainer('')
    showContainerInfo('')
    console.log(remotePeerData[peerId])
    setSelectedRemotePeer(peerId)
    showRemotePeerInfo(peerId)
  }

  const handleHoverType = (): void => {
    if (hoverType === 'peerscore') {
      setHoverType('rtt')
    } else {
      setHoverType('peerscore')
    }
  }

  const handleProtocolSelect = (protocol: string) => {
    setSelectedProtocols((prevSelected) => {
      if (prevSelected.includes(protocol)) {
        // Deselect the protocol
        return prevSelected.filter((p) => p !== protocol)
      } else {
        // Select the protocol
        return [...prevSelected, protocol]
      }
    })
  }

  const handleTopicSelect = (topic: string): void => {
    setSelectedTopics(topic)
  }

  const getBackgroundColor = (containerId: string): string => {
    if (converge) {
      return peerData[containerId]?.lastMessage
    } else {
      return `#${containerId.substring(0, 6)}`
    }
  }

  const getOpacity = (containerId: string): number => {
    if (peerData[containerId]?.multiaddrs.length >= 1) {
      return 1
    }

    return 0.65 // semi transparent when no multiaddrs
  }

  const getBorderStyle = (containerId: string): string => {
    if (selectedContainer === containerId) {
      return '2px solid White'
    }

    return '0px'
  }

  const getBorderRadius = (containerId: string): string => {
    if (peerData[containerId]?.type === 'bootstrapper') {
      return '4px'
    }

    return '50%'
  }

  // Utility function to generate random positions within the container
  const getRandomPosition = () => ({
    x: Math.random() * (CONTAINER_WIDTH - nodeSize) + nodeSize / 2,
    y: Math.random() * (CONTAINER_HEIGHT - nodeSize) + nodeSize / 2,
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const areEdgesEqual = (prevConnections: any[], newConnections: any[]) => {
    if (prevConnections.length !== newConnections.length) return false
    return prevConnections.every(
      (conn, index) => conn.from === newConnections[index].from && conn.to === newConnections[index].to,
    )
  }

  // Function to handle WebSocket messages and update containerData
  const handleNodeStatusUpdate = (data: PeerData) => {
    if (isPeerIdAssignedToContainer(data.peerId)) {
      setRemotePeerData((remotePeerPrev) => {
        const merged: RemotePeers = { ...remotePeerPrev }
        if (merged[data.peerId]) {
          delete merged[data.peerId]
        }
        return merged
      })
    }
    setPeerData((prev) => {
      const peer = prev[data.containerId]
      if (!peer) {
        // If peer is not in the peerData, skip
        // Currently we need to wait for containerList update - #TODO
        // But we can remove from remote peers as we know its a container

        setRemotePeerData((remotePeerPrev) => {
          const merged: RemotePeers = { ...remotePeerPrev }
          if (merged[data.peerId]) {
            delete merged[data.peerId]
          }
          return merged
        })

        return prev
      }

      if (data.remotePeers) {
        setRemotePeerData((remotePeerPrev) => {
          const merged: RemotePeers = { ...remotePeerPrev }

          for (const [remotePeerId, remotePeerDetails] of Object.entries(data.remotePeers)) {
            const isContainer = Object.values(prev).some((container) => container.peerId === remotePeerId)
            if (isContainer) {
              if (merged[remotePeerId]) {
                delete merged[remotePeerId]
              }
              continue
            }

            const existing = remotePeerPrev[remotePeerId]
            if (existing) {
              // already tracked
              merged[remotePeerId] = {
                ...existing,
                ...remotePeerDetails,
              }
            } else {
              // new remote peer
              const { x, y } = getRandomPosition()
              merged[remotePeerId] = {
                ...remotePeerDetails,
                x,
                y,
                vx: 0,
                vy: 0,
              }
            }
          }

          return merged
        })
      }

      return {
        ...prev,
        [data.containerId]: {
          ...peer,
          ...data,
        },
      }
    })

    // Extract protocols from streams
    if (data.streams) {
      const newProtocols = new Set<string>()
      Object.values(data.streams).forEach((streamsArray) => {
        streamsArray.forEach((stream) => {
          newProtocols.add(stream.protocol)
        })
      })

      // Update the protocols state with new unique protocols
      setProtocols((prevProtocols) => {
        const updatedProtocols = [...prevProtocols]
        newProtocols.forEach((protocol) => {
          if (!updatedProtocols.includes(protocol)) {
            updatedProtocols.push(protocol)
          }
        })
        return updatedProtocols
      })
    }

    // Update topics
    if (data.topics) {
      const newTopics = new Set<string>()
      data.topics.forEach((topic) => {
        newTopics.add(topic)
      })

      // Update the protocols state with new unique protocols
      setTopics((prevTopics) => {
        const updatedTopics = [...prevTopics]
        newTopics.forEach((topic) => {
          if (!updatedTopics.includes(topic)) {
            updatedTopics.push(topic)
          }
        })
        return updatedTopics
      })
    }
  }

  const isPeerIdAssignedToContainer = (peerId: string): boolean => {
    return Object.values(peerData).some((pd) => pd.peerId === peerId)
  }

  const allNodes = useMemo(() => {
    const nodes: Record<string, { x: number; y: number; vx: number; vy: number }> = {}

    Object.values(peerData).forEach((p) => {
      nodes[p.containerId] = { x: p.x, y: p.y, vx: p.vx, vy: p.vy }
    })

    Object.entries(remotePeerData).forEach(([id, r]) => {
      if (!isPeerIdAssignedToContainer(id)) {
        nodes[id] = { x: r.x || 0, y: r.y || 0, vx: r.vx || 0, vy: r.vy || 0 }
      }
    })

    return nodes
  }, [peerData, remotePeerData])

  // WebSocket for controller
  // Receives containers list and node updates
  useEffect(() => {
    const connectWebSocket = () => {
      // Check if a WebSocket connection already exists
      if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
        console.log('WebSocket is already connected or connecting.')
        return // Do not create a new connection if one already exists
      }

      console.log('Attempting to connect WebSocket...')
      setControllerStatus('connecting')
      const ws = new WebSocket(WS_ENDPOINT)

      ws.onopen = () => {
        console.log('Controller WebSocket: connected')
        setControllerStatus('online')
        wsRef.current = ws // Store the connected WebSocket instance
      }

      ws.onmessage = (event) => {
        try {
          const json = JSON.parse(event.data)
          switch (json.mType) {
            case 'containerList':
              // console.log('containerList', json)
              const updatedContainers: ContainerData[] = json.data
              const runningContainers = updatedContainers.filter((c) => c.state === 'running')
              setContainers(runningContainers)
              initializeContainerData(runningContainers)
              break
            case 'nodeStatus':
              handleNodeStatusUpdate(json)
              break
            default:
              console.log('Controller WebSocket: unknown type', json.mType)
          }
        } catch (error) {
          console.error('Controller WebSocket: Error parsing message:', error)
        }
      }

      ws.onerror = (error) => {
        setControllerStatus('offline')
        console.error('Controller WebSocket: Error:', error)
      }

      ws.onclose = () => {
        console.log('Controller WebSocket: closed. Attempting to reconnect...')
        attemptReconnect()
      }

      wsRef.current = ws // Store the WebSocket instance
    }

    const attemptReconnect = () => {
      if (reconnectTimeout.current) {
        clearTimeout(reconnectTimeout.current) // Clear any existing reconnect timeouts
      }
      reconnectTimeout.current = window.setTimeout(() => {
        connectWebSocket()
      }, 3000) // Attempt reconnect after 3000ms
    }

    connectWebSocket() // Initial connection

    return () => {
      if (reconnectTimeout.current) {
        clearTimeout(reconnectTimeout.current)
      }

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current?.close() // Close the WebSocket connection on unmount
      }
    }
  }, [])

  // Edge generation
  useEffect(() => {
    const newEdges: { from: string; to: string }[] = []

    // Build edges based on selected mapType
    Object.entries(peerData).forEach(([containerId, data]) => {
      let connectionList: string[] = []
      switch (mapType) {
        case 'streams':
          connectionList = data.streams ? Object.keys(data.streams) : []
          break
        case 'subscribers':
          connectionList = data.subscribersList?.[selectedTopic] ?? []
          break
        case 'meshPeers':
          connectionList = data.meshPeersList?.[selectedTopic] ?? []
          break
        default:
          // connections, pubsubPeers, libp2pPeers, dhtPeers

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (Array.isArray((data as any)[mapType])) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            connectionList = (data as any)[mapType] as string[]
          }
          break
      }

      // 1) container → container
      connectionList.forEach((peerId) => {
        const targetCid = Object.keys(peerData).find((k) => peerData[k].peerId === peerId)
        if (targetCid) {
          newEdges.push({ from: containerId, to: targetCid })
        }
      })

      // 2) container → remote via remotePeers if not assigned to a container
      Object.keys(data.remotePeers || {}).forEach((remotePeerId) => {
        if (!isPeerIdAssignedToContainer(remotePeerId)) {
          newEdges.push({ from: containerId, to: remotePeerId })
        }
      })
    })

    // 3) orphans via  remotePeerData links
    Object.keys(remotePeerData).forEach((remotePeerId) => {
      if (!isPeerIdAssignedToContainer(remotePeerId)) {
        Object.entries(peerData).forEach(([containerId, data]) => {
          if (data.remotePeers?.[remotePeerId]) {
            newEdges.push({ from: containerId, to: remotePeerId })
          }
        })
      }
    })

    // dedupe on unordered pairs
    const uniq = newEdges.filter(
      (e, i) =>
        newEdges.findIndex((f) => (f.from === e.from && f.to === e.to) || (f.from === e.to && f.to === e.from)) === i,
    )

    if (
      uniq.length !== prevEdgesRef.current.length ||
      !uniq.every((e, i) => e.from === prevEdgesRef.current[i]?.from && e.to === prevEdgesRef.current[i]?.to)
    ) {
      prevEdgesRef.current = uniq
      setEdges(uniq)
      console.log('Updated edges:', uniq)
    }
  }, [peerData, remotePeerData, mapType, selectedTopic])

  // // Update node size based on number of containers
  // useEffect(() => {
  //   const minSize = 35 // Minimum node size
  //   const maxSize = 45 // Maximum node size
  //   const scalingFactor = 5 // Adjust this to control sensitivity
  //
  //   if (containers.length === 0) {
  //     setNodeSize(maxSize) // Default size when no containers
  //     return
  //   }
  //
  //   // Dynamically scale the node size
  //   const size = Math.max(minSize, Math.min(maxSize, maxSize - Math.log(containers.length) * scalingFactor))
  //
  //   setNodeSize(size)
  // }, [containers])

  // Update min distance
  // useEffect(() => {
  //   const minDistanceMin = nodeSize * 2 // Minimum allowable distance
  //   const minDistanceMax = nodeSize * 4 // Maximum allowable distance
  //   const scalingFactor = 1 // Adjust for sensitivity
  //
  //   if (containers.length === 0) {
  //     setMinDistance(minDistanceMax) // Default when no containers
  //     return
  //   }
  //
  //   // Dynamically scale the minDistance
  //   const distance = Math.max(
  //     minDistanceMin,
  //     Math.min(minDistanceMax, minDistanceMax - Math.log(containers.length) * scalingFactor),
  //   )
  //
  //   setMinDistance(distance)
  // }, [containers, nodeSize])

  // Compound Spring Embedder Force-Directed Layout Implementation
  // useEffect(() => {
  //   // console.log('useEffect triggered');
  //   if (mapView !== 'graph') return
  //
  //   const centerX = CONTAINER_WIDTH / 2
  //   const centerY = CONTAINER_HEIGHT / 2
  //   const VELOCITY_THRESHOLD = 0.015 // Threshold for stability
  //   const STABLE_ITERATIONS = 25 // Number of iterations required to consider stable
  //
  //   const edgesHaveChanged = !areEdgesEqual(prevEdgesRef.current, edges)
  //
  //   if (edgesHaveChanged) {
  //     // console.log('Edges changed. Resetting stabilization.')
  //     stableCountRef.current = 0 // Reset stability count
  //     stabilizedRef.current = false // Mark the graph as not stabilized
  //     prevEdgesRef.current = edges // Update stored edges
  //     if (intervalIdRef.current !== null) {
  //       window.clearInterval(intervalIdRef.current) // Clear the existing interval
  //     }
  //   }
  //
  //   const interval = window.setInterval(() => {
  //     if (stabilizedRef.current) {
  //       window.clearInterval(intervalIdRef.current!) // Stop the interval if already stabilized
  //       return
  //     }
  //
  //     let allStable = true // Flag to check if all nodes are stable
  //
  //     setPeerData((prevData) => {
  //       const updatedData: { [id: string]: PeerData } = { ...prevData }
  //
  //       Object.values(updatedData).forEach((node) => {
  //         let fx = 0
  //         let fy = 0
  //
  //         // Check node stability
  //         if (Math.abs(node.vx) > VELOCITY_THRESHOLD || Math.abs(node.vy) > VELOCITY_THRESHOLD) {
  //           allStable = false // Node is still moving
  //           // console.log(`Node ${node.id} not stable. Velocity: (${node.vx}, ${node.vy})`);
  //           stableCountRef.current = 0
  //         }
  //
  //         // 1. Repulsive Forces between all node pairs
  //         Object.values(updatedData).forEach((otherNode) => {
  //           if (node.id === otherNode.id) return
  //
  //           const dx = node.x - otherNode.x
  //           const dy = node.y - otherNode.y
  //           let distance = Math.sqrt(dx * dx + dy * dy) || 1
  //
  //           // Prevent division by zero and excessive repulsion
  //           distance = Math.max(distance, minDistance)
  //
  //           const repulsion = mapTypeForces[mapType].repulsion / (distance * distance)
  //           fx += (dx / distance) * repulsion
  //           fy += (dy / distance) * repulsion
  //         })
  //
  //         // 2. Attractive Forces for connected nodes
  //         edges.forEach((conn) => {
  //           if (conn.from === node.id) {
  //             const targetNode = updatedData[conn.to]
  //             if (targetNode) {
  //               const dx = targetNode.x - node.x
  //               const dy = targetNode.y - node.y
  //               const distance = Math.sqrt(dx * dx + dy * dy) || 1
  //
  //               const attraction = (distance - mapTypeForces[mapType].naturalLength) * mapTypeForces[mapType].attraction
  //               fx += (dx / distance) * attraction
  //               fy += (dy / distance) * attraction
  //             }
  //           } else if (conn.to === node.id) {
  //             const targetNode = updatedData[conn.from]
  //             if (targetNode) {
  //               const dx = targetNode.x - node.x
  //               const dy = targetNode.y - node.y
  //               const distance = Math.sqrt(dx * dx + dy * dy) || 1
  //
  //               const attraction = (distance - mapTypeForces[mapType].naturalLength) * mapTypeForces[mapType].attraction
  //
  //               fx += (dx / distance) * attraction
  //               fy += (dy / distance) * attraction
  //             }
  //           }
  //         })
  //
  //         // 3. Central Gravity Force
  //         const dxCenter = centerX - node.x
  //         const dyCenter = centerY - node.y
  //         fx += dxCenter * mapTypeForces[mapType].gravity
  //         fy += dyCenter * mapTypeForces[mapType].gravity
  //
  //         // 4. Collision Detection and Resolution
  //         Object.values(updatedData).forEach((otherNode) => {
  //           if (node.id === otherNode.id) return
  //
  //           const dx = node.x - otherNode.x
  //           const dy = node.y - otherNode.y
  //           const distance = Math.sqrt(dx * dx + dy * dy) || 1
  //
  //           if (distance < minDistance) {
  //             const overlap = minDistance - distance
  //             const collision = (overlap / distance) * mapTypeForces[mapType].collision
  //             fx += (dx / distance) * collision
  //             fy += (dy / distance) * collision
  //           }
  //         })
  //
  //         // 5. Update Velocities with Damping
  //         node.vx = (node.vx + fx) * mapTypeForces[mapType].damping
  //         node.vy = (node.vy + fy) * mapTypeForces[mapType].damping
  //
  //         // 6. Cap Velocities to Prevent Overshooting
  //         node.vx = Math.max(-mapTypeForces[mapType].maxVelocity, Math.min(mapTypeForces[mapType].maxVelocity, node.vx))
  //         node.vy = Math.max(-mapTypeForces[mapType].maxVelocity, Math.min(mapTypeForces[mapType].maxVelocity, node.vy))
  //
  //         // 7. Update Positions
  //         node.x += node.vx
  //         node.y += node.vy
  //
  //         // 8. Boundary Enforcement: Keep Nodes Within Container
  //         node.x = Math.max(nodeSize / 2, Math.min(CONTAINER_WIDTH - nodeSize / 2, node.x))
  //         node.y = Math.max(nodeSize / 2, Math.min(CONTAINER_HEIGHT - nodeSize / 2, node.y))
  //       })
  //
  //       return updatedData
  //     })
  //
  //     // Update stability state
  //     if (allStable) {
  //       stableCountRef.current += 1
  //       // console.log(`Stable Count: ${stableCountRef.current}, All Stable: true`);
  //       if (stableCountRef.current >= STABLE_ITERATIONS) {
  //         // console.log('Graph has stabilized.');
  //         stabilizedRef.current = true // Mark the graph as stabilized
  //         window.clearInterval(intervalIdRef.current!) // Stop the interval
  //       }
  //     } else {
  //       if (stableCountRef.current > 0) {
  //         console.log('Graph became unstable again. Resetting stable count.')
  //       }
  //       stableCountRef.current = 0 // Reset stability count if instability is detected
  //     }
  //   }, 30) // Update every 30ms for smooth animation
  //
  //   intervalIdRef.current = interval // Store the interval ID for cleanup
  //
  //   return () => {
  //     if (intervalIdRef.current !== null) {
  //       window.clearInterval(intervalIdRef.current) // Ensure interval is cleared on unmount
  //     }
  //   }
  // }, [edges, mapView, mapType, containers, selectedTopic])
  useEffect(() => {
    if (mapView !== 'graph') return

    const centerX = CONTAINER_WIDTH / 2
    const centerY = CONTAINER_HEIGHT / 2
    const VELOCITY_THRESHOLD = 0.015
    const STABLE_ITERATIONS = 25

    const edgesChanged = !areEdgesEqual(prevEdgesRef.current, edges)
    if (edgesChanged) {
      stableCountRef.current = 0
      stabilizedRef.current = false
      prevEdgesRef.current = edges
      if (intervalIdRef.current) window.clearInterval(intervalIdRef.current)
    }

    intervalIdRef.current = window.setInterval(() => {
      if (stabilizedRef.current && intervalIdRef.current) {
        window.clearInterval(intervalIdRef.current)
        return
      }

      let allStable = true
      // Clone positions & velocities
      const updated = { ...allNodes }

      // Compute forces for each nodeId in allNodes
      Object.entries(updated).forEach(([id, node]) => {
        let fx = 0,
          fy = 0
        // stability
        if (Math.abs(node.vx) > VELOCITY_THRESHOLD || Math.abs(node.vy) > VELOCITY_THRESHOLD) {
          allStable = false
          stableCountRef.current = 0
        }

        // 1. Repulsion among all nodes
        Object.entries(updated).forEach(([oid, other]) => {
          if (id === oid) return
          const dx = node.x - other.x
          const dy = node.y - other.y
          let dist = Math.sqrt(dx * dx + dy * dy) || 1
          dist = Math.max(dist, nodeSize)
          const rep = mapTypeForces[mapType].repulsion / (dist * dist)
          fx += (dx / dist) * rep
          fy += (dy / dist) * rep
        })

        // 2. Attraction along edges
        edges.forEach((e) => {
          if (e.from === id || e.to === id) {
            const otherId = e.from === id ? e.to : e.from
            const other = updated[otherId]
            if (!other) return
            const dx = other.x - node.x
            const dy = other.y - node.y
            const dist = Math.sqrt(dx * dx + dy * dy) || 1
            const attr = (dist - mapTypeForces[mapType].naturalLength) * mapTypeForces[mapType].attraction
            fx += (dx / dist) * attr
            fy += (dy / dist) * attr
          }
        })

        // 3. Central gravity
        fx += (centerX - node.x) * mapTypeForces[mapType].gravity
        fy += (centerY - node.y) * mapTypeForces[mapType].gravity

        // 4. Collision
        Object.entries(updated).forEach(([oid, other]) => {
          if (id === oid) return
          const dx = node.x - other.x
          const dy = node.y - other.y
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          if (dist < nodeSize) {
            const overlap = nodeSize - dist
            const col = (overlap / dist) * mapTypeForces[mapType].collision
            fx += (dx / dist) * col
            fy += (dy / dist) * col
          }
        })

        // 5. Damping
        node.vx = (node.vx + fx) * mapTypeForces[mapType].damping
        node.vy = (node.vy + fy) * mapTypeForces[mapType].damping
        // 6. Cap velocity
        node.vx = Math.max(-mapTypeForces[mapType].maxVelocity, Math.min(mapTypeForces[mapType].maxVelocity, node.vx))
        node.vy = Math.max(-mapTypeForces[mapType].maxVelocity, Math.min(mapTypeForces[mapType].maxVelocity, node.vy))
        // 7. Update pos
        node.x += node.vx
        node.y += node.vy
        // 8. Boundaries
        node.x = Math.max(nodeSize / 2, Math.min(CONTAINER_WIDTH - nodeSize / 2, node.x))
        node.y = Math.max(nodeSize / 2, Math.min(CONTAINER_HEIGHT - nodeSize / 2, node.y))
      })

      // Separate updates back to states
      // Containers
      setPeerData((prev) => {
        const next = { ...prev }
        Object.entries(prev).forEach(([cid]) => {
          const u = updated[cid]
          if (u) next[cid] = { ...next[cid], x: u.x, y: u.y, vx: u.vx, vy: u.vy }
        })
        return next
      })
      // Remotes
      setRemotePeerData((prev) => {
        const next: RemotePeers = { ...prev }
        Object.keys(prev).forEach((rid) => {
          const u = updated[rid]
          if (u) next[rid] = { x: u.x, y: u.y, vx: u.vx, vy: u.vy }
        })
        return next
      })

      // stability
      if (allStable) {
        stableCountRef.current += 1
        if (stableCountRef.current >= STABLE_ITERATIONS) {
          stabilizedRef.current = true
          if (intervalIdRef.current) window.clearInterval(intervalIdRef.current)
        }
      }
    }, 30)

    return () => {
      if (intervalIdRef.current) window.clearInterval(intervalIdRef.current)
    }
  }, [allNodes, edges, mapView, mapType, setPeerData, setRemotePeerData])

  // Auto publish if enabled
  useEffect(() => {
    const interval = setInterval(() => {
      if (autoPublish) {
        publishToTopic('', 1)
      }
    }, Number(autoPublishInterval))
    return () => clearInterval(interval)
  }, [autoPublish, containers])

  return (
    <>
      <Head>
        <title>GossipSub Simulator</title>
        <meta name='description' content='Manage Docker containers' />
        <meta name='viewport' content='width=device-width, initial-scale=1' />
        <link rel='icon' href='/favicon.ico' />
      </Head>
      <div className='app-container'>
        {/* Sidebar 1: Controls */}
        <div className='sidebar sidebar1'>
          <h3>Container Settings</h3>
          <div className='input-group'>
            <label>
              Image name:
              <input type='text' value={imageName} onChange={(e) => setImageName(e.target.value)} />
            </label>
          </div>
          <div className='input-group'>
            <label>
              PubSub Topics (comma sep):
              <input type='text' value={topicsName} onChange={(e) => setTopicsName(e.target.value)} />
            </label>
          </div>
          <div className='input-group'>
            <label>
              <input type='checkbox' checked={debugContainer} onChange={() => setDebugContainer(!debugContainer)} />
              <span style={{ marginLeft: '5px' }}>Start with debug</span>
            </label>
          </div>
          {debugContainer && (
            <div className='input-group'>
              <label>
                Debug String:
                <input type='text' value={debugStr} onChange={(e) => setDebugStr(e.target.value)} />
              </label>
            </div>
          )}
          <div className='input-group'>
            <label>
              <input
                type='checkbox'
                checked={hasLatencySettings}
                onChange={() => setHasLatencySettings(!hasLatencySettings)}
              />
              <span style={{ marginLeft: '5px' }}>Start with latency</span>
            </label>
          </div>
          {hasLatencySettings && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0px 10px' }}>
              <div className='input-group'>
                <label>
                  Min
                  <input value={minLatency} onChange={(e) => setMinLatency(e.target.value)} style={{ width: '4em' }} />
                </label>
              </div>
              <div className='input-group'>
                <label>
                  Max
                  <input value={maxLatency} onChange={(e) => setMaxLatency(e.target.value)} style={{ width: '4em' }} />
                </label>
              </div>
            </div>
          )}
          <div className='input-group'>
            <label>
              <input
                type='checkbox'
                checked={hasPacketLossSetting}
                onChange={() => setHasPacketLossSettings(!hasPacketLossSetting)}
              />
              <span style={{ marginLeft: '5px' }}>Start with packet loss</span>
            </label>
          </div>
          {hasPacketLossSetting && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0px 10px' }}>
              <div className='input-group'>
                <label>
                  Loss %
                  <input value={packetLoss} onChange={(e) => setPacketLoss(e.target.value)} style={{ width: '4em' }} />
                </label>
              </div>
            </div>
          )}
          <div className='input-group'>
            <label>
              <input
                type='checkbox'
                checked={hasGossipDSettings}
                onChange={() => setHasGossipDSettings(!hasGossipDSettings)}
              />
              <span style={{ marginLeft: '5px' }}>Gossip D Settings (not bootstrappers)</span>
            </label>
          </div>
          {hasGossipDSettings && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0px 10px' }}>
              <div className='input-group'>
                <label>
                  D
                  <input value={gossipD} onChange={(e) => setGossipD(e.target.value)} style={{ width: '2em' }} />
                </label>
              </div>
              <div className='input-group'>
                <label>
                  Dlo
                  <input value={gossipDlo} onChange={(e) => setGossipDlo(e.target.value)} style={{ width: '2em' }} />
                </label>
              </div>
              <div className='input-group'>
                <label>
                  Dhi
                  <input value={gossipDhi} onChange={(e) => setGossipDhi(e.target.value)} style={{ width: '2em' }} />
                </label>
              </div>
              <div className='input-group'>
                <label>
                  Dout
                  <input value={gossipDout} onChange={(e) => setGossipDout(e.target.value)} style={{ width: '2em' }} />
                </label>
              </div>
            </div>
          )}
          <div className='input-group'>
            <label>
              <input type='checkbox' checked={hasPerfSetting} onChange={() => setHasPerfSetting(!hasPerfSetting)} />
              <span style={{ marginLeft: '5px' }}>Run Perf on connect</span>
            </label>
          </div>
          {hasPerfSetting && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0px 10px' }}>
              <div className='input-group'>
                <label>
                  Bytes:
                  <input value={perfBytes} onChange={(e) => setPerfBytes(e.target.value)} style={{ width: '4em' }} />
                </label>
              </div>
            </div>
          )}
          <div className='input-group'>
            <label>
              <input type='checkbox' checked={disableNoise} onChange={() => setDisableNoise(!disableNoise)} />
              <span style={{ marginLeft: '5px' }}>Disable Noise</span>
            </label>
          </div>

          <h3>Containers</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0px 10px' }}>
            <div style={{ display: 'flex', gap: '0px 15px' }}>
              <button onClick={handleStartBootstrap1}>Bootstrap 1</button>
              <button onClick={handleStartBootstrap2}>Bootstrap 2</button>
            </div>
            <button onClick={handleStartContainer}>Container</button>
            <button onClick={() => handleStartXContainers(10)}>10 Containers</button>
          </div>

          <div style={{ display: 'flex', gap: '0px 10px' }}>
            <button onClick={() => stopXContainers(5)}>Stop 5</button>
            <button onClick={stopAllContainers} style={{ backgroundColor: '#e62020' }}>
              Stop All
            </button>
          </div>
          <h3>Show</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0px 10px' }}>
            <button onClick={() => setMapType('connections')} className={mapType === 'connections' ? 'selected' : ''}>
              Connections
            </button>
            <button onClick={() => setMapType('meshPeers')} className={mapType === 'meshPeers' ? 'selected' : ''}>
              Mesh Peers
            </button>
            {mapType === 'meshPeers' && (
              <div className='selection-list'>
                <h3>Mesh Topics</h3>
                {topics.length > 0 ? (
                  <div>
                    <ul>
                      {[...topics].sort().map((topic, index) => (
                        <li key={index}>
                          <label>
                            <input
                              type='checkbox'
                              checked={selectedTopic === topic}
                              onChange={() => handleTopicSelect(topic)}
                            />
                            {topic}
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p>No topics available.</p>
                )}
              </div>
            )}
            <button onClick={() => setMapType('subscribers')} className={mapType === 'subscribers' ? 'selected' : ''}>
              Subscribers
            </button>
            {mapType === 'subscribers' && (
              <div className='selection-list'>
                <h3>Subscription Topics</h3>
                {topics.length > 0 ? (
                  <div>
                    <ul>
                      {[...topics].sort().map((topic, index) => (
                        <li key={index}>
                          <label>
                            <input
                              type='checkbox'
                              checked={selectedTopic === topic}
                              onChange={() => handleTopicSelect(topic)}
                            />
                            {topic}
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p>No topics available.</p>
                )}
              </div>
            )}
            <button onClick={() => setMapType('pubsubPeers')} className={mapType === 'pubsubPeers' ? 'selected' : ''}>
              Pubsub Peer Store
            </button>
            <button onClick={() => setMapType('streams')} className={mapType === 'streams' ? 'selected' : ''}>
              Streams
            </button>
            {/* Conditionally render protocols when mapType is 'streams' */}
            {mapType === 'streams' && (
              <div className='selection-list'>
                <h3>Stream Protocols</h3>
                {protocols.length > 0 ? (
                  <div>
                    <div style={{ marginBottom: '10px' }}>
                      <button onClick={() => setSelectedProtocols(protocols)} style={{ marginRight: '10px' }}>
                        Select All
                      </button>
                      <button onClick={() => setSelectedProtocols([])}>Clear</button>
                    </div>
                    {/* Protocol Checkboxes */}
                    <ul>
                      {[...protocols].sort().map((protocol, index) => (
                        <li key={index}>
                          <label>
                            <input
                              type='checkbox'
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
            <button onClick={() => setMapType('libp2pPeers')} className={mapType === 'libp2pPeers' ? 'selected' : ''}>
              Libp2p Peer Store
            </button>
            <button onClick={() => setMapType('dhtPeers')} className={mapType === 'dhtPeers' ? 'selected' : ''}>
              DHT Known Peers
            </button>
          </div>
        </div>

        {/* Middle Section: Graph */}
        <div className='middle'>
          {controllerStatus === 'connecting' && (
            <div
              style={{ position: 'absolute', top: '0px', left: '0px', zIndex: -1, color: 'green', fontSize: '20px' }}
            >
              Connecting to controller...
            </div>
          )}
          {controllerStatus === 'offline' && (
            <div style={{ position: 'absolute', top: '0px', left: '0px', zIndex: -1, color: 'red', fontSize: '20px' }}>
              Controller offline
            </div>
          )}
          {controllerStatus === 'online' && (
            <div style={{ position: 'absolute', top: '0px', left: '0px', zIndex: -1 }}>
              <h1>{mapType}</h1>
              <div>{`Total containers: ${containers.length}`}</div>
              <div>{`Bootstrap containers: ${containers.filter((c) => c.image.includes('bootstrap')).length}`}</div>

              <div>{`Gossip containers: ${containers.filter((c) => c.image.includes('gossip')).length}`}</div>
            </div>
          )}
          <div
            style={{
              position: 'absolute',
              top: '0px',
              right: '0px',
              fontSize: '30px',
              zIndex: 10,
              textAlign: 'center',
            }}
          >
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
          <div className='graph'>
            {mapView === 'graph' && (
              <div>
                <svg className='edges'>
                  {edges.map((conn, index) => {
                    const fromNode = allNodes[conn.from]
                    const toNode = allNodes[conn.to]
                    if (!fromNode || !toNode) return null
                    // const fromNode = peerData[conn.from]
                    // const toNode = peerData[conn.to]

                    if (fromNode && toNode) {
                      // Ensure both nodes have valid positions
                      if (
                        fromNode.x === undefined ||
                        fromNode.y === undefined ||
                        toNode.x === undefined ||
                        toNode.y === undefined
                      ) {
                        return null
                      }

                      // Determine the protocol associated with this connection
                      let connectionProtocol: string | null = null

                      if (mapType === 'streams') {
                        const toPeerId = peerData[conn.to]?.peerId
                        const fromStreams = peerData[conn.from]?.streams[toPeerId]

                        if (
                          toPeerId &&
                          fromStreams &&
                          fromStreams.length > 0 &&
                          typeof fromStreams[0].protocol === 'string' &&
                          fromStreams[0].protocol.trim() !== ''
                        ) {
                          connectionProtocol = fromStreams[0].protocol.trim().toLowerCase()
                        } else {
                          // Try the reverse: from to to from
                          const fromPeerId = peerData[conn.from]?.peerId
                          const toStreams = peerData[conn.to]?.streams[fromPeerId]

                          if (
                            fromPeerId &&
                            toStreams &&
                            toStreams.length > 0 &&
                            typeof toStreams[0].protocol === 'string' &&
                            toStreams[0].protocol.trim() !== ''
                          ) {
                            connectionProtocol = toStreams[0].protocol.trim().toLowerCase()
                          }
                        }
                      }

                      // If protocols are selected, filter edges
                      if (selectedProtocols.length > 0 && mapType === 'streams') {
                        if (!connectionProtocol || !selectedProtocols.includes(connectionProtocol)) {
                          return null // Do not render this connection
                        }
                      }

                      // Determine the stroke color based on the protocol
                      let strokeColor = '#ffffff' // Default color
                      let strokeWidth = 2 // Default strokeWidth
                      let opacity = 0.8 // Default opacity

                      if (connectionProtocol) {
                        // Define a color mapping based on protocol
                        const protocolColorMap: { [key: string]: string } = {
                          '/meshsub/1.2.0': '#0fff00',
                          '/ipfs/id/1.0.0': '#00ff00',
                          '/ipfs/ping/1.0.0': '#000ff0',
                          // Add more protocols and their corresponding colors here
                        }
                        strokeColor = protocolColorMap[connectionProtocol] || '#000000'
                      } else {
                        // For connections without a protocol, use default coloring
                        strokeColor = `#${conn.from.substring(0, 6)}`
                      }
                      if (hoveredContainerId === conn.from || hoveredContainerId === conn.to) {
                        strokeColor = '#ffffff'
                        strokeWidth = 4
                        opacity = 1
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
                      )
                    }
                    return null
                  })}
                </svg>

                {containers.map((container) => {
                  const node = peerData[container.id]
                  if (!node) return null // Ensure node data exists

                  return (
                    <div
                      key={container.id}
                      ref={(el) => {
                        containerRefs.current[container.id] = el
                      }}
                      className='container'
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
                        opacity: `${getOpacity(container.id)}`,
                        border: `${getBorderStyle(container.id)}`,
                        borderRadius: `${getBorderRadius(container.id)}`,
                        position: 'absolute',
                        transform: `translate(-50%, -50%)`, // Center the node
                        transition: 'background-color 0.1s, border 0.1s', // Smooth transitions
                      }}
                      title={`Container ID: ${container.id}\nPeer ID: ${peerData[container.id]?.peerId || 'Loading...'}`}
                    >
                      {getLabel(container.id)}
                    </div>
                  )
                })}

                {Object.keys(remotePeerData).map((k) => {
                  // eslint-disable-next-line @typescript-eslint/no-unused-vars
                  for (const [_, containerDetails] of Object.entries(peerData)) {
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    for (const [remotePeerId, _] of Object.entries(containerDetails.remotePeers)) {
                      if (k === remotePeerId) {
                        return (
                          <div
                            key={k}
                            ref={(el) => {
                              remotePeerRefs.current[k] = el
                            }}
                            className='container remotepeer'
                            onClick={() => handleRemotePeerClick(k)}
                            // onMouseEnter={() => setHoveredContainerId(container.id)}
                            // onMouseLeave={() => setHoveredContainerId(null)}
                            style={{
                              width: `${nodeSize}px`,
                              height: `${nodeSize}px`,
                              lineHeight: `${nodeSize}px`,
                              left: `${remotePeerData[k].x}px`,
                              top: `${remotePeerData[k].y}px`,
                              fontSize: `${Math.max(8, nodeSize / 3)}px`,
                              backgroundColor: `darkorange`, //`${getBackgroundColor(container.id)}`,
                              // opacity: 1, // `${getOpacity(container.id)}`,
                              // border: `${getBorderStyle(container.id)}`,
                              // borderRadius: `${getBorderRadius(container.id)}`,
                              position: 'absolute',
                              transform: `translate(-50%, -50%)`, // Center the node
                              transition: 'background-color 0.1s, border 0.1s', // Smooth transitions
                            }}
                            title={`Remote Peer\nPeer ID: ${k}`}
                          >
                            {k}
                          </div>
                        )
                      }
                    }
                  }
                })}
              </div>
            )}

            {mapView === 'circle' && (
              <div>
                <svg className='edges'>
                  {edges.map((conn, index) => {
                    const fromEl = containerRefs.current[conn.from]
                    const toEl = containerRefs.current[conn.to]

                    if (fromEl && toEl) {
                      const fromRect = fromEl.getBoundingClientRect()
                      const toRect = toEl.getBoundingClientRect()

                      const svgRect = fromEl.parentElement!.getBoundingClientRect()

                      const x1 = fromRect.left + fromRect.width / 2 - svgRect.left
                      const y1 = fromRect.top + fromRect.height / 2 - svgRect.top

                      const x2 = toRect.left + toRect.width / 2 - svgRect.left
                      const y2 = toRect.top + toRect.height / 2 - svgRect.top

                      // Determine the protocol associated with this connection
                      let connectionProtocol: string | null = null

                      if (mapType === 'streams') {
                        const toPeerId = peerData[conn.to]?.peerId
                        const fromStreams = peerData[conn.from]?.streams[toPeerId]

                        if (
                          toPeerId &&
                          fromStreams &&
                          fromStreams.length > 0 &&
                          typeof fromStreams[0].protocol === 'string' &&
                          fromStreams[0].protocol.trim() !== ''
                        ) {
                          connectionProtocol = fromStreams[0].protocol.trim().toLowerCase()
                        } else {
                          // Try the reverse: from to to from
                          const fromPeerId = peerData[conn.from]?.peerId
                          const toStreams = peerData[conn.to]?.streams[fromPeerId]

                          if (
                            fromPeerId &&
                            toStreams &&
                            toStreams.length > 0 &&
                            typeof toStreams[0].protocol === 'string' &&
                            toStreams[0].protocol.trim() !== ''
                          ) {
                            connectionProtocol = toStreams[0].protocol.trim().toLowerCase()
                          }
                        }
                      }

                      // If protocols are selected, filter connections
                      if (selectedProtocols.length > 0 && mapType === 'streams') {
                        if (!connectionProtocol || !selectedProtocols.includes(connectionProtocol)) {
                          return null // Do not render this connection
                        }
                      }

                      let strokeColor = '#ffffff' // Default color

                      if (connectionProtocol) {
                        const protocolColorMap: { [key: string]: string } = {
                          '/meshsub/1.2.0': '#0fff00',
                          '/ipfs/id/1.0.0': '#00ff00',
                          '/ipfs/ping/1.0.0': '#000ff0',
                        }
                        strokeColor = protocolColorMap[connectionProtocol] || '#000000'
                      } else {
                        strokeColor = `#${conn.from.substring(0, 6)}`
                      }
                      if (hoveredContainerId === conn.from || hoveredContainerId === conn.to) {
                        strokeColor = '#ffffff'
                      }

                      return <line key={index} x1={x1} y1={y1} x2={x2} y2={y2} stroke={strokeColor} strokeWidth='2' />
                    }
                    return null
                  })}
                </svg>

                {containers.map((container, index) => {
                  const numContainers = containers.length

                  // Arrange containers in a single circle
                  const angle = (index / numContainers) * 360
                  const radius = 320 // Fixed radius

                  // Adjust item size based on number of containers
                  const minItemSize = 20
                  const maxItemSize = 80
                  const itemSize = Math.max(minItemSize, maxItemSize - numContainers)

                  const fontSize = itemSize / 4 // Adjust font size proportionally

                  return (
                    <div
                      key={container.id}
                      ref={(el) => {
                        containerRefs.current[container.id] = el
                      }}
                      className='container'
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
                        opacity: `${getOpacity(container.id)}`,
                        border: `${getBorderStyle(container.id)}`,
                        borderRadius: `${getBorderRadius(container.id)}`,
                        transition: 'background-color 0.1s, border 0.1s',
                      }}
                      title={`Container ID: ${container.id}\nPeer ID: ${peerData[container.id]?.peerId || 'Loading...'}`}
                    >
                      {getLabel(container.id)}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* Sidebar 2: Information and Actions */}
        <div className='sidebar sidebar2'>
          <h1>GossipSub Simulator</h1>
          <button onClick={handleClickType}>Clicks: {clickType}</button>
          <button onClick={handleHoverType}>Hover Shows: {hoverType}</button>
          <button onClick={() => setConverge(!converge)}>Show Convergence is: {converge ? 'ON' : 'OFF'}</button>
          <button onClick={() => setAutoPublish(!autoPublish)}>Auto Publish is: {autoPublish ? 'ON' : 'OFF'}</button>
          {autoPublish && (
            <div className='input-group'>
              <label>
                Interval
                <input
                  value={autoPublishInterval}
                  onChange={(e) => setAutoPublishInterval(e.target.value)}
                  style={{ width: '5em' }}
                />{' '}
                ms
              </label>
              <div className='selection-list'>
                {topics.length > 0 ? (
                  <div>
                    <ul>
                      {[...topics].sort().map((topic, index) => (
                        <li key={index}>
                          <label>
                            <input
                              type='checkbox'
                              checked={selectedTopic === topic}
                              onChange={() => handleTopicSelect(topic)}
                            />
                            {topic}
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p>No topics available.</p>
                )}
              </div>
            </div>
          )}
          <button onClick={() => publishToTopic('', 1)}>Publish to random peer</button>
          <button onClick={() => publishToTopic('', 1000)}>Publish 1k to random peers</button>
          {selectedRemotePeer && remotePeerData[selectedRemotePeer] && (
            <div>
              <h3>Remote Peer</h3>
              <p>Peer ID: {selectedRemotePeer}</p>
              <div>
                Protocols:{' '}
                {remotePeerData[selectedRemotePeer]?.protocols?.map((p, index) => (
                  <p key={index} style={{ marginLeft: '1rem' }}>
                    {p}
                  </p>
                ))}
              </div>
              <div>
                Multiaddrs: {remotePeerData[selectedRemotePeer]?.multiaddrs?.map((p, index) => <p key={index}>{p}</p>)}
              </div>
              <div>x: {remotePeerData[selectedRemotePeer].x}</div>
              <div>y: {remotePeerData[selectedRemotePeer].y}</div>
            </div>
          )}
          {selectedContainer && peerData[selectedContainer] && (
            <div>
              <h3>Peer Info</h3>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0px 10px' }}>
                <button onClick={() => publishToTopic(selectedContainer, 1)}>Publish 1</button>
                <button onClick={() => publishToTopic(selectedContainer, 1_000)}>Publish 1k</button>
                <button onClick={() => publishToTopic(selectedContainer, 100_000)}>Publish 100k</button>
                <div className='input-group'>
                  <label>
                    Connect to multiaddr:
                    <input type='text' value={connectMultiaddr} onChange={(e) => setConnectMultiaddr(e.target.value)} />
                  </label>
                </div>
                <button onClick={() => connectTo(selectedContainer, connectMultiaddr)}>Connect</button>
                <button onClick={() => stopContainer(selectedContainer)} style={{ backgroundColor: '#e62020' }}>
                  Stop
                </button>
                <button onClick={() => getLogs(selectedContainer)}>Logs</button>
                {!peerData[selectedContainer].tcpdumping && (
                  <button onClick={() => startTCPDump(selectedContainer)}>Start TCPDump</button>
                )}
                {peerData[selectedContainer].tcpdumping && (
                  <button onClick={() => stopTCPDump(selectedContainer)}>Stop TCPDump</button>
                )}
              </div>
              <div>Container ID: {selectedContainer}</div>
              <p>Type: {peerData[selectedContainer]?.type}</p>
              <p>Peer ID: {peerData[selectedContainer]?.peerId}</p>
              <div>Connections: {peerData[selectedContainer]?.connections.length}</div>
              {/*<div>
                {peerData[selectedContainer]?.remotePeers.map((r) => (
                  <div key={r.peerId} style={{ marginLeft: '1rem' }}>
                    {r.multiaddrs}
                  </div>
                ))}
              </div>*/}
              <div>Connect+perf: {Math.round(peerData[selectedContainer]?.connectTime)}ms</div>
              <div>Mesh Peers:</div>
              {Object.keys(peerData[selectedContainer]?.meshPeersList || {}).length > 0 ? (
                <div>
                  {Object.entries(peerData[selectedContainer]?.meshPeersList || {}).map(([topic, peers]) => (
                    <div key={topic} style={{ marginLeft: '1rem' }}>
                      {topic}: {Array.isArray(peers) ? peers.length : 0} peers
                    </div>
                  ))}
                </div>
              ) : (
                <div>No mesh peers available for topics.</div>
              )}
              {/* <div>Outbound Edges: {edges.filter(conn => conn.from === selectedContainer).length}</div> */}
              {/* <div>Inbound Edges: {edges.filter(conn => conn.to === selectedContainer).length}</div> */}
              <div>Subscribers</div>
              {Object.keys(peerData[selectedContainer]?.subscribersList || {}).length > 0 ? (
                <div>
                  {Object.entries(peerData[selectedContainer]?.subscribersList || {}).map(([topic, peers]) => (
                    <div key={topic} style={{ marginLeft: '1rem' }}>
                      {topic}: {Array.isArray(peers) ? peers.length : 0} peers
                    </div>
                  ))}
                </div>
              ) : (
                <div>No mesh peers available for topics.</div>
              )}
              <div>
                Topics:{' '}
                {peerData[selectedContainer]?.topics?.map((p, index) => (
                  <p key={index} style={{ marginLeft: '1rem' }}>
                    {p}
                  </p>
                ))}
              </div>
              <div>Pubsub Peer Store: {peerData[selectedContainer]?.pubsubPeers?.length}</div>
              <div>Libp2p Peer Store: {peerData[selectedContainer]?.libp2pPeers?.length}</div>
              <div>
                Protocols:{' '}
                {peerData[selectedContainer]?.protocols?.map((p, index) => (
                  <p key={index} style={{ marginLeft: '1rem' }}>
                    {p}
                  </p>
                ))}
              </div>
              <div>
                Multiaddrs: {peerData[selectedContainer]?.multiaddrs?.map((p, index) => <p key={index}>{p}</p>)}
              </div>
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
            user-select: none;
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
            transition:
              left 0.1s,
              top 0.1s,
              background-color 0.2s,
              border 0.1s;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
          }

          .selection-list {
            width: 100%;
          }

          .selection-list button {
            padding: 5px 10px;
            font-size: 14px;
            cursor: pointer;
            border: none;
            border-radius: 4px;
            background-color: #0070f3;
            color: white;
          }

          .selection-list button:hover {
            background-color: #005bb5;
          }

          .selection-list ul {
            list-style-type: none;
            padding-left: 0;
            max-height: 200px;
            overflow-y: auto;
          }

          .selection-list li {
            margin-bottom: 5px;
          }

          .selection-list label {
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
      </div>
    </>
  )
}
