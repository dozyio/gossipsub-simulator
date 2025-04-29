import Head from 'next/head'
import { FaCircleNodes } from 'react-icons/fa6'
import { FaPause, FaPlay, FaRegCircle } from 'react-icons/fa'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import * as raw from 'multiformats/codecs/raw'
import { unstable_batchedUpdates } from 'react-dom'

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
  dhtProvideStatus: string
  dhtFindProviderResult: string[]
  connections: string[] // peer ids of connections
  remotePeers: RemotePeers
  protocols: string[]
  multiaddrs: string[]
  streams: StreamsByPeer
  topics: string[]
  type: string
  lastMessage: string
  messageCount: number
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
type HoverType = 'peerscore' | 'rtt' | 'messagecount'
type MapView = 'circle' | 'graph' | 'canvas'
type ControllerStatus = 'offline' | 'online' | 'connecting'

const ENDPOINT = 'http://localhost:8080'
const WS_ENDPOINT = 'ws://localhost:8080/ws'
const DEBUG_STRING = 'DEBUG=*,*:trace,-*libp2p:peer-store:trace'
const DHT_PREFIX = '/ipfs/lan'

// Container dimensions
const CONTAINER_WIDTH = 800
const CONTAINER_HEIGHT = 800

const centerX = CONTAINER_WIDTH / 2
const centerY = CONTAINER_HEIGHT / 2
const VELOCITY_THRESHOLD = 0.1
const STABLE_ITERATIONS = 20
const MAX_UNSTABLE_ITERATIONS = 15 * 30

// Force strengths
// Compound Spring Embedder layout
const DEFAULT_FORCES = {
  repulsion: 50_000, // Adjusted for CSE
  attraction: 0.09, // Adjusted for CSE
  collision: 10, // Adjusted for CSE
  gravity: 0.2, // Central gravity strength
  damping: 0.1, // Velocity damping factor
  maxVelocity: 40, // Maximum velocity cap
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

  // container config
  const [topicsName, setTopicsName] = useState<string>('pubXXX-dev')
  const [debugContainer, setDebugContainer] = useState<boolean>(false)
  const [debugStr, setDebugStr] = useState<string>(DEBUG_STRING)
  const [dhtPrefix, setDhtPrefix] = useState<string>(DHT_PREFIX)
  const [dhtAllowPublic, setDhtAllowPublic] = useState<boolean>(false)
  const [dhtAllowPrivate, setDhtAllowPrivate] = useState<boolean>(true)
  const [hasGossipDSettings, setHasGossipDSettings] = useState<boolean>(false)
  const [gossipD, setGossipD] = useState<string>('8')
  const [gossipDlo, setGossipDlo] = useState<string>('6')
  const [gossipDhi, setGossipDhi] = useState<string>('12')
  const [gossipDout, setGossipDout] = useState<string>('2')
  const [hasLatencySettings, setHasLatencySettings] = useState<boolean>(false)
  const [minLatency, setMinLatency] = useState<string>('20')
  const [maxLatency, setMaxLatency] = useState<string>('50')
  const [hasPacketLossSetting, setHasPacketLossSettings] = useState<boolean>(false)
  const [packetLoss, setPacketLoss] = useState<string>('1')
  const [hasPerfSetting, setHasPerfSetting] = useState<boolean>(false)
  const [perfBytes, setPerfBytes] = useState<string>('1')
  const [disableNoise, setDisableNoise] = useState<boolean>(false)
  const [transportCircuitRelay, setTransportCircuitRelay] = useState<boolean>(false)

  // dht stuff
  const [dhtProvideString, setDhtProvideString] = useState<string>('')
  const [dhtCidOfString, setDhtCidOfString] = useState<string>('')
  const [dhtFindProviderCid, setDhtFindProviderCid] = useState<string>('')

  /// gossip stuff
  const [trackConverge, setTrackConverge] = useState<boolean>(false)
  const [convergeStart, setConvergeStart] = useState<number>(0)
  const [convergeEnd, setConvergeEnd] = useState<number>(0)
  const [convergeCount, setConvergeCount] = useState<number>(0)
  const [converged, setConverged] = useState<boolean>(false)

  // graph stuff
  const [edges, setEdges] = useState<{ from: string; to: string }[]>([])
  const prevEdgesRef = useRef(edges) // Store previous connections for comparison
  const containerRefs = useRef<{ [id: string]: HTMLDivElement | null }>({})
  const remotePeerRefs = useRef<{ [id: string]: HTMLDivElement | null }>({})
  const [mapType, setMapType] = useState<MapType>('connections')
  const [mapView, setMapView] = useState<MapView>('graph')
  const stableCountRef = useRef(0) // Track stable state count
  const unstableCountRef = useRef(0) // Track unstable state count
  const stabilizedRef = useRef(false) // Track if graph is already stabilized
  const intervalIdRef = useRef<number | null>(null) // Store interval ID
  // const [nodeSize, setNodeSize] = useState<number>(35)
  // const [minDistance, setMinDistance] = useState<number>(nodeSize * 4)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // const nodesRef = useRef(allNodes)
  // const edgesRef = useRef(edges)
  const nodesRef = useRef<Record<string, { x: number; y: number; vx: number; vy: number }>>({})
  const edgesRef = useRef<{ from: string; to: string }[]>([])
  const rafIdRef = useRef<number | null>(null)
  const fpsRef = useRef<HTMLDivElement | null>(null)
  const frameTimesRef = useRef<number[]>([])
  const [pauseSim, setPauseSim] = useState<boolean>(false)

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
            dhtProvideStatus: '',
            dhtFindProviderResult: [],
            connections: [],
            remotePeers: {},
            protocols: [],
            multiaddrs: [],
            streams: {},
            topics: [],
            type: '',
            lastMessage: '',
            messageCount: 0,
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

  const envSetter = (baseEnv: string[] = [], isBootstrap: boolean = false): string[] => {
    const env = [...baseEnv]
    env.push(`TOPICS=${topicsName}`)

    env.push(`DHTPREFIX=${dhtPrefix}`)

    if (dhtAllowPublic) {
      env.push('DHTPUBLIC=true')
    }

    // if (dhtAllowPrivate) {
    //   env.push('DHTPRIVATE=true')
    // }

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

    if (transportCircuitRelay) {
      env.push('CIRCUIT_RELAY=1')
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

  const handleStartXContainers = async (amount = 10): Promise<void> => {
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

  const publishToTopic = async (
    containerId: string = '',
    amount = 1,
    size = 1,
    clearStats: boolean = false,
    trackConvergance: boolean = false,
  ): Promise<void> => {
    if (containers.length === 0) {
      return
    }

    interface Body {
      amount: number
      topic: string
      size: number
      containerId?: string
      clearStats?: boolean
    }

    const body: Body = {
      amount,
      topic: selectedTopic,
      size,
      clearStats,
    }

    if (containerId !== '') {
      body.containerId = containerId
    }

    if (trackConvergance) {
      // Reset all counts to 0
      setPeerData((prev) =>
        Object.fromEntries(Object.entries(prev).map(([cid, data]) => [cid, { ...data, messageCount: 0 }])),
      )
      setConvergeCount(amount)
      setConvergeStart(Date.now())
      setTrackConverge(true)
      setConverged(false)
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

  const handleDhtProvide = async (containerId: string = ''): Promise<void> => {
    if (containers.length === 0) {
      return
    }

    interface Body {
      cid: string
      container_id?: string
    }

    const body: Body = {
      cid: dhtCidOfString,
      container_id: containerId,
    }

    try {
      const response = await fetch(`${ENDPOINT}/dht/provide`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Error provide: ${errorText}`)
      }
    } catch (error) {
      console.error('Error provide:', error)
    }
  }

  const handleDhtFindProvider = async (containerId: string = ''): Promise<void> => {
    if (containers.length === 0) {
      return
    }

    interface Body {
      cid: string
      container_id?: string
    }

    const body: Body = {
      cid: dhtFindProviderCid,
      container_id: containerId,
    }

    try {
      const response = await fetch(`${ENDPOINT}/dht/findprovider`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Error provide: ${errorText}`)
      }
    } catch (error) {
      console.error('Error provide:', error)
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

  const connectTo = async (srcContainerId: string, toMultiaddrs: string | string[]): Promise<void> => {
    if (containers.length === 0) {
      return
    }

    interface Body {
      containerId: string
      toMultiaddrs: string
    }

    let toMa: string
    if (typeof toMultiaddrs === 'string') {
      toMa = toMultiaddrs
    } else if (Array.isArray(toMultiaddrs)) {
      toMa = toMultiaddrs.join(',')
    } else {
      console.error('Invalid toMultiaddrs type:', typeof toMultiaddrs)
      return
    }

    const body: Body = {
      containerId: srcContainerId,
      toMultiaddrs: toMa,
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
        } else if (hoverType === 'messagecount') {
          const messageCount = node?.messageCount
          if (messageCount !== undefined) {
            label = String(messageCount)
          } else {
            label = String(-1)
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

  const handleRemotePeerClick = async (peerId: string): Promise<void> => {
    if (clickType === 'connectTo') {
      const ma = remotePeerData[peerId].multiaddrs.map((m: string) => `${m}/p2p/${peerId}`)
      await connectTo(selectedContainer, ma)
      setClickType('connect')
    }

    setSelectedContainer('')
    showContainerInfo('')
    console.log(remotePeerData[peerId])
    setSelectedRemotePeer(peerId)
    showRemotePeerInfo(peerId)
  }

  const handleHoverType = (): void => {
    if (hoverType === 'peerscore') {
      setHoverType('rtt')
    } else if (hoverType === 'rtt') {
      setHoverType('messagecount')
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

  const handleDhtProvideString = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    setDhtProvideString(e.target.value)
    const cid = CID.create(1, raw.code, await sha256.digest(new TextEncoder().encode(e.target.value)))
    setDhtCidOfString(cid.toString())
  }

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { offsetX: x, offsetY: y } = e.nativeEvent
    const clicked = Object.entries(allNodes).find(
      ([id, node]) => Math.hypot(node.x - x, node.y - y) < nodeSize / 2,
    )?.[0]
    if (clicked) handleContainerClick(clicked)
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

  const isRemotePeerConnectedToContainer = (remotePeerId: string): boolean => {
    return Object.values(peerData).some((pd) => pd.remotePeers.hasOwnProperty(remotePeerId))
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

  const activeRemotePeers = useMemo(() => {
    return Object.entries(remotePeerData).filter(([peerId]) =>
      // keep only those peerIds that show up in some container.remotePeers
      Object.values(peerData).some((container) => Object.prototype.hasOwnProperty.call(container.remotePeers, peerId)),
    )
  }, [remotePeerData, peerData])

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

  useEffect(() => {
    const list = Object.values(peerData)
    const hasConverged = list.length > 0 && list.every((d) => d.messageCount >= convergeCount)

    if (trackConverge && hasConverged) {
      setConvergeEnd(Date.now())
      setConverged(true)
      setTrackConverge(false)
    }
  }, [peerData, trackConverge, convergeCount])

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
        } else {
          // container → remote (because peerId isn’t in any container)
          newEdges.push({ from: containerId, to: peerId })
        }
      })
    })

    const seen = new Set<string>()
    const uniq: { from: string; to: string }[] = []

    for (const { from, to } of newEdges) {
      // sort endpoints so “A–B” and “B–A” both map to “A--B”
      const [a, b] = [from, to].sort()
      const key = `${a}--${b}`

      if (!seen.has(key)) {
        seen.add(key)
        uniq.push({ from, to })
      }
    }

    if (
      uniq.length !== prevEdgesRef.current.length ||
      !uniq.every((e, i) => e.from === prevEdgesRef.current[i]?.from && e.to === prevEdgesRef.current[i]?.to)
    ) {
      prevEdgesRef.current = uniq
      setEdges(uniq)
      // console.log('Updated edges:', uniq)
    }
  }, [peerData, remotePeerData, mapType, selectedTopic])

  // Update node size based on number of containers
  const nodeSize = useMemo(() => {
    const minSize = 15
    const maxSize = 35
    const scalingFactor = 2.3
    const total = Object.keys(peerData).length + Object.keys(remotePeerData).length

    if (total <= 10) return maxSize

    return Math.max(minSize, Math.min(maxSize, maxSize - Math.log(total) * scalingFactor))
  }, [peerData, remotePeerData])

  // Update min distance
  const minDistance = useMemo(() => {
    const minDistanceMin = nodeSize * 2 // Minimum allowable distance
    const minDistanceMax = nodeSize * 4 // Maximum allowable distance
    const scalingFactor = 1.5 // Adjust for sensitivity

    const total = Object.keys(peerData).length + Object.keys(remotePeerData).length

    if (total <= 1) return minDistanceMax

    // Dynamically scale the minDistance
    let distance = Math.max(
      minDistanceMin,
      Math.min(minDistanceMax, minDistanceMax - Math.log(containers.length) * scalingFactor),
    )
    if (distance > CONTAINER_WIDTH / 2) {
      distance = CONTAINER_WIDTH / 4
    }

    return distance
  }, [peerData, remotePeerData, nodeSize])

  useEffect(() => {
    nodesRef.current = allNodes
  }, [allNodes])

  useEffect(() => {
    edgesRef.current = edges
  }, [edges])

  const stepSimulation = useCallback(() => {
    if (pauseSim) return
    let allStable = true
    const updated = { ...nodesRef.current }

    Object.entries(updated).forEach(([id, node]) => {
      let fx = 0
      let fy = 0

      const half = nodeSize / 2
      const W = CONTAINER_WIDTH
      const H = CONTAINER_HEIGHT
      const wallCharge = mapTypeForces[mapType].repulsion * 2 // tweak multiplier

      // left wall
      const dl = node.x - half
      if (dl > 0) fx += wallCharge / (dl * dl)

      // right wall
      const dr = W - half - node.x
      if (dr > 0) fx -= wallCharge / (dr * dr)

      // top wall
      const dt = node.y - half
      if (dt > 0) fy += wallCharge / (dt * dt)

      // bottom wall
      const db = H - half - node.y
      if (db > 0) fy -= wallCharge / (db * db)

      // 1) check stability
      if (Math.abs(node.vx) > VELOCITY_THRESHOLD || Math.abs(node.vy) > VELOCITY_THRESHOLD) {
        allStable = false
        stableCountRef.current = 0
      }

      // 2) repulsion
      try {
        Object.values(updated).forEach((other) => {
          if (other === node) return
          const dx = node.x - other.x
          const dy = node.y - other.y
          let dist = Math.hypot(dx, dy) || 1
          dist = Math.max(dist, nodeSize)
          const rep = mapTypeForces[mapType].repulsion / (dist * dist)
          fx += (dx / dist) * rep
          fy += (dy / dist) * rep
        })
      } catch (err: any) {
        console.error('Error applying repulsion force:', err)
        return
      }

      // 3) attraction
      try {
        edgesRef.current.forEach((e) => {
          if (e.from === id || e.to === id) {
            const other = updated[e.from === id ? e.to : e.from]
            if (!other) {
              return
            }
            const dx = other.x - node.x
            const dy = other.y - node.y
            const dist = Math.hypot(dx, dy) || 0.01
            const attr = (dist - mapTypeForces[mapType].naturalLength) * mapTypeForces[mapType].attraction
            fx += (dx / dist) * attr
            fy += (dy / dist) * attr
          }
        })
      } catch (err: any) {
        console.error('Error applying attraction force:', err, id, node)
        return
      }

      // 4) central gravity
      fx += (centerX - node.x) * mapTypeForces[mapType].gravity
      fy += (centerY - node.y) * mapTypeForces[mapType].gravity

      // // 4.5) SOFT-BOUNDARY FORCE
      // const margin = nodeSize // keep nodes at least one radius from wall
      // const boundaryStrength = 100_000_000 // tweak this to make the push gentler or stronger
      //
      // if (node.x < margin) {
      //   fx += (margin - node.x) * boundaryStrength
      // } else if (node.x > CONTAINER_WIDTH - margin) {
      //   fx += (CONTAINER_WIDTH - margin - node.x) * boundaryStrength
      // }
      //
      // if (node.y < margin) {
      //   fy += (margin - node.y) * boundaryStrength
      // } else if (node.y > CONTAINER_HEIGHT - margin) {
      //   fy += (CONTAINER_HEIGHT - margin - node.y) * boundaryStrength
      // }

      // 5) collision
      Object.values(updated).forEach((other) => {
        if (other === node) return
        const dx = node.x - other.x,
          dy = node.y - other.y
        const dist = Math.hypot(dx, dy) || 1
        if (dist < minDistance) {
          const overlap = minDistance - dist
          const col = (overlap / dist) * mapTypeForces[mapType].collision
          fx += (dx / dist) * col
          fy += (dy / dist) * col
        }
      })

      // 6) damping + cap + integrate
      node.vx = Math.max(
        -mapTypeForces[mapType].maxVelocity,
        Math.min(mapTypeForces[mapType].maxVelocity, (node.vx + fx) * mapTypeForces[mapType].damping),
      )
      node.vy = Math.max(
        -mapTypeForces[mapType].maxVelocity,
        Math.min(mapTypeForces[mapType].maxVelocity, (node.vy + fy) * mapTypeForces[mapType].damping),
      )

      node.x = Math.min(CONTAINER_WIDTH - nodeSize / 2, Math.max(nodeSize / 2, node.x + node.vx))
      node.y = Math.min(CONTAINER_HEIGHT - nodeSize / 2, Math.max(nodeSize / 2, node.y + node.vy))
    })

    // push back into React state:
    unstable_batchedUpdates(() => {
      setPeerData((prev) => {
        const next = { ...prev }
        Object.keys(prev).forEach((cid) => {
          const u = updated[cid]
          if (u) next[cid] = { ...next[cid], ...u }
        })
        return next
      })

      setRemotePeerData((prev) => {
        const next = { ...prev }
        Object.keys(prev).forEach((rid) => {
          const u = updated[rid]
          if (u) {
            // always update any remote peer that has a computed position
            next[rid] = {
              ...next[rid],
              x: u.x,
              y: u.y,
              vx: u.vx,
              vy: u.vy,
            }
          }
        })
        return next
      })
    })

    // track convergence / bail-out
    if (allStable) {
      stableCountRef.current += 1
      if (stableCountRef.current >= STABLE_ITERATIONS) stabilizedRef.current = true
    } else {
      unstableCountRef.current += 1
      if (unstableCountRef.current > MAX_UNSTABLE_ITERATIONS) {
        stabilizedRef.current = true
      }
    }
  }, [pauseSim, mapType, nodeSize, minDistance])

  // The rAF‐driven effect
  useEffect(() => {
    if (mapView !== 'graph' && mapView !== 'canvas') return

    // reset our counters whenever edges/mapType/view changes
    frameTimesRef.current = []
    stableCountRef.current = 0
    unstableCountRef.current = 0
    stabilizedRef.current = false

    // clear any prior frame
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current)
    }

    const loop = () => {
      stepSimulation()
      if (!stabilizedRef.current) {
        rafIdRef.current = requestAnimationFrame(loop)
      }
    }

    // kick it off
    rafIdRef.current = requestAnimationFrame(loop)

    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current)
      }
    }
  }, [mapView, mapType, stepSimulation, edges])

  useEffect(() => {
    let rafId: number
    let last = performance.now()
    const deltas: number[] = []
    const maxSamples = 60 // average over last 60 frames (~1s)

    const fpsLoop = (now: number) => {
      // 1) compute delta
      const delta = now - last
      last = now

      // 2) push & trim
      deltas.push(delta)
      if (deltas.length > maxSamples) deltas.shift()

      // 3) compute average delta & FPS
      const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length
      const fps = 1000 / avgDelta

      // 4) write into DOM once (no React state)
      if (fpsRef.current) fpsRef.current.textContent = `${fps.toFixed(1)} FPS`

      // 5) next tick
      rafId = requestAnimationFrame(fpsLoop)
    }

    // kick it off
    rafId = requestAnimationFrame((t) => {
      last = t
      fpsLoop(t)
    })

    return () => cancelAnimationFrame(rafId)
  }, []) // run once on mount

  useEffect(() => {
    if (mapView !== 'canvas') return

    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // clear
    ctx.clearRect(0, 0, CONTAINER_WIDTH, CONTAINER_HEIGHT)

    // draw edges
    ctx.lineWidth = 2
    edges.forEach(({ from, to }) => {
      const a = allNodes[from]
      const b = allNodes[to]
      if (!a || !b) return

      ctx.strokeStyle = '#aaa'
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    })

    // draw nodes
    Object.entries(allNodes).forEach(([id, node]) => {
      // Circle
      ctx.beginPath()
      ctx.arc(node.x, node.y, nodeSize / 2, 0, Math.PI * 2)
      ctx.fillStyle =
        id in peerData
          ? getBackgroundColor(id) // container color
          : 'darkorange' // remote peer color
      ctx.fill()

      // optional border
      if (selectedContainer === id) {
        ctx.lineWidth = 2
        ctx.strokeStyle = 'white'
        ctx.stroke()
      }

      // label
      const label = getLabel(id)
      if (label) {
        ctx.fillStyle = 'white'
        ctx.font = `${Math.max(8, nodeSize / 3)}px sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(label, node.x, node.y)
      }
    })
  }, [allNodes, edges, selectedContainer, nodeSize, mapView])

  useEffect(() => {
    // build a set of all remotePeerIds *still* in use
    const inUse = new Set<string>()
    Object.values(peerData).forEach((pd) => {
      Object.keys(pd.remotePeers).forEach((rid) => inUse.add(rid))
    })

    // prune your remotePeerData state down to only those still inUse
    setRemotePeerData((prev) => {
      const next: RemotePeers = {}
      inUse.forEach((rid) => {
        if (prev[rid]) next[rid] = prev[rid]
      })
      return next
    })
  }, [peerData])

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
              <span style={{ marginLeft: '5px' }}>Gossip D Settings (gossip peers only)</span>
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
              <span style={{ marginLeft: '5px' }}>Disable Noise (tcpdump)</span>
            </label>
          </div>
          <div className='input-group'>
            <label>
              DHT Prefix: *prefix*/kad/1.0.0
              <input type='text' value={dhtPrefix} onChange={(e) => setDhtPrefix(e.target.value)} />
            </label>
          </div>
          <div className='input-group'>
            <label>
              <input
                type='checkbox'
                checked={dhtAllowPrivate}
                onChange={() => {
                  setDhtAllowPrivate(!dhtAllowPrivate)
                  setDhtAllowPublic(dhtAllowPrivate)
                  if (dhtPrefix === '/ipfs') setDhtPrefix('/ipfs/lan')
                }}
              />
              <span style={{ marginLeft: '5px' }}>DHT Allow Private Addr</span>
            </label>
          </div>
          <div className='input-group'>
            <label>
              <input
                type='checkbox'
                checked={dhtAllowPublic}
                onChange={() => {
                  setDhtAllowPublic(!dhtAllowPublic)
                  setDhtAllowPrivate(dhtAllowPublic)
                  if (dhtPrefix === '/ipfs/lan') setDhtPrefix('/ipfs')
                }}
              />
              <span style={{ marginLeft: '5px' }}>DHT Allow Public Addr</span>
            </label>
          </div>
          <div className='input-group'>
            <label>
              <input
                type='checkbox'
                checked={transportCircuitRelay}
                onChange={() => {
                  setTransportCircuitRelay(!transportCircuitRelay)
                }}
              />
              <span style={{ marginLeft: '5px' }}>Enable circuit relay transport (gossip peers only)</span>
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
            <button onClick={() => setMapType('pubsubPeers')} className={mapType === 'pubsubPeers' ? 'selected' : ''}>
              Pubsub Peer Store
            </button>
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
          <div
            ref={fpsRef}
            style={{
              position: 'absolute',
              bottom: '8px',
              right: '8px',
              padding: '4px 8px',
              background: 'rgba(0,0,0,0.6)',
              color: 'white',
              fontSize: '12px',
              borderRadius: '4px',
              zIndex: 1000,
            }}
          >
            — FPS —
          </div>
          {controllerStatus === 'connecting' && (
            <div style={{ position: 'absolute', top: '8px', left: '8px', zIndex: -1, fontSize: '20px' }}>
              Connecting to controller...
            </div>
          )}
          {controllerStatus === 'offline' && (
            <div style={{ position: 'absolute', top: '8px', left: '8px', zIndex: -1, color: 'red', fontSize: '20px' }}>
              Controller offline
            </div>
          )}
          {controllerStatus === 'online' && (
            <div style={{ position: 'absolute', top: '8px', left: '8px', zIndex: -1 }}>
              <h1 style={{ textTransform: 'capitalize' }}>{mapType}</h1>
            </div>
          )}
          {controllerStatus === 'online' && (
            <div style={{ position: 'absolute', bottom: '8px', left: '8px', zIndex: -1 }}>
              <div>
                <p>{`Total containers: ${containers.length}`}</p>
                <p>{`Bootstrap containers: ${containers.filter((c) => c.image.includes('bootstrap')).length}`} </p>
                <p>{`Gossip containers: ${containers.filter((c) => c.image.includes('gossip')).length}`}</p>
                <p>{`Remote Peers: ${Object.keys(remotePeerData).length}`}</p>
              </div>
            </div>
          )}
          <div
            style={{
              position: 'absolute',
              top: '8px',
              right: '8px',
              fontSize: '30px',
              zIndex: 10,
              textAlign: 'center',
            }}
          >
            <h6 style={{ marginBottom: '10px' }}>View</h6>
            <div style={{ display: 'flex' }}>
              {mapView === 'graph' ? (
                <div>
                  <span style={{ color: 'white', marginRight: '10px' }}>
                    <FaCircleNodes style={{ cursor: 'pointer' }} />
                  </span>
                  <span style={{ color: 'gray' }} onClick={() => setMapView('circle')}>
                    <FaRegCircle style={{ cursor: 'pointer' }} />
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
              <div style={{ marginLeft: '10px' }}>
                {pauseSim ? (
                  <div>
                    <FaPlay style={{ cursor: 'pointer' }} onClick={() => setPauseSim(false)} />
                  </div>
                ) : (
                  <div>
                    <FaPause style={{ cursor: 'pointer' }} onClick={() => setPauseSim(true)} />
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className='graph'>
            {mapView === 'graph' && (
              <div>
                <svg className='edges'>
                  {edges.map((conn, index) => {
                    const fromNode = allNodes[conn.from]
                    const toNode = allNodes[conn.to]
                    if (!fromNode || !toNode) return null

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
                        strokeColor = protocolColorMap[connectionProtocol] || '#f0f0f0'
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
                        // transition: 'background-color 0.1s, border 0.1s', // Smooth transitions
                      }}
                      title={`Container ID: ${container.id}\nPeer ID: ${peerData[container.id]?.peerId || 'Loading...'}`}
                    >
                      {getLabel(container.id)}
                    </div>
                  )
                })}

                {activeRemotePeers.map(([peerId, peer]) => (
                  <div
                    key={peerId}
                    ref={(el) => {
                      remotePeerRefs.current[peerId] = el
                    }}
                    className='container remotepeer'
                    onClick={() => handleRemotePeerClick(peerId)}
                    style={{
                      width: `${nodeSize}px`,
                      height: `${nodeSize}px`,
                      lineHeight: `${nodeSize}px`,
                      left: `${remotePeerData[peerId].x}px`,
                      top: `${remotePeerData[peerId].y}px`,
                      fontSize: `${Math.max(8, nodeSize / 3)}px`,
                      backgroundColor: `darkorange`, //`${getBackgroundColor(container.id)}`,
                      // opacity: 1, // `${getOpacity(container.id)}`,
                      // border: `${getBorderStyle(container.id)}`,
                      // borderRadius: `${getBorderRadius(container.id)}`,
                      position: 'absolute',
                      transform: `translate(-50%, -50%)`, // Center the node
                      // transition: 'background-color 0.1s, border 0.1s', // Smooth transitions
                    }}
                    title={`Remote Peer\nPeer ID: ${peerId}`}
                  >
                    {peerId}
                  </div>
                ))}
              </div>
            )}
            {mapView === 'canvas' && (
              <canvas
                ref={canvasRef}
                width={CONTAINER_WIDTH}
                height={CONTAINER_HEIGHT}
                onClick={onCanvasClick}
                onMouseMove={(e) => {
                  const { offsetX: x, offsetY: y } = e.nativeEvent
                  const over =
                    Object.entries(allNodes).find(
                      ([id, node]) => Math.hypot(node.x - x, node.y - y) < nodeSize / 2,
                    )?.[0] || null
                  setHoveredContainerId(over)
                }}
                style={{ cursor: 'pointer' }}
              />
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
                        // transition: 'background-color 0.1s, border 0.1s',
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
          <button onClick={handleHoverType}>Hover/select Shows: {hoverType}</button>
          <h3>Gossipsub</h3>
          <button onClick={() => setConverge(!converge)}>Show Convergence: {converge ? 'ON' : 'OFF'}</button>
          <button onClick={() => setAutoPublish(!autoPublish)}>Auto Publish: {autoPublish ? 'ON' : 'OFF'}</button>
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
                  <p key={index}>
                    &bull;{'\u00A0'}
                    {p}
                  </p>
                ))}
              </div>
              <div>
                Multiaddrs:{' '}
                {remotePeerData[selectedRemotePeer]?.multiaddrs?.map((p, index) => (
                  <p key={index} style={{ marginBottom: '0.5rem' }}>
                    {p}
                  </p>
                ))}
              </div>
            </div>
          )}
          {selectedContainer && peerData[selectedContainer] && (
            <div>
              <p>
                <span title='clears Received Pubsub count'></span>Publish to selected peer
              </p>
              <div style={{ display: 'flex' }}>
                <button onClick={() => publishToTopic(selectedContainer, 1, 1, true, true)}>1</button>
                <button onClick={() => publishToTopic(selectedContainer, 1_000, 1, true, true)}>1k</button>
                <button onClick={() => publishToTopic(selectedContainer, 100_000, 1, true, true)}>100k</button>
              </div>
              <p>
                <span title='approximate time as websocket data updates to/from each host not instant'>
                  Time to converge
                </span>
                :{' '}
                {converged && (
                  <>
                    {convergeEnd - convergeStart}
                    <span>ms</span>
                  </>
                )}
                {!converged && trackConverge && <>waiting...</>}
              </p>

              <h3>DHT Commands</h3>
              <div className='input-group'>
                <label>
                  Provide: <input type='text' value={dhtProvideString} onChange={(e) => handleDhtProvideString(e)} />
                </label>
                <p>
                  CID: <span style={{ userSelect: 'text' }}>{dhtCidOfString}</span>
                </p>
                <p>Provide status: {peerData[selectedContainer].dhtProvideStatus}</p>
                <button onClick={() => handleDhtProvide(selectedContainer)}>Provide</button>
              </div>
              <div>
                <div className='input-group'>
                  <label>Find CID Provider: </label>
                  <input
                    type='text'
                    value={dhtFindProviderCid}
                    onChange={(e) => setDhtFindProviderCid(e.target.value)}
                  />

                  <button onClick={() => handleDhtFindProvider(selectedContainer)}>Find Providers</button>
                </div>
                <div>
                  Find Providers results:
                  {peerData[selectedContainer]?.dhtFindProviderResult?.map((p, index) => (
                    <p key={index} style={{ marginBottom: '0.5rem' }}>
                      {p}
                    </p>
                  ))}
                </div>
              </div>

              <h3>Connect</h3>
              <div className='input-group'>
                <label>
                  Connect to multiaddr:
                  <div style={{ display: 'flex' }}>
                    <input type='text' value={connectMultiaddr} onChange={(e) => setConnectMultiaddr(e.target.value)} />
                    <button onClick={() => connectTo(selectedContainer, connectMultiaddr)}>Go</button>
                  </div>
                </label>
              </div>
              <div className='input-group'>
                <label>
                  Dial public bootrapper:
                  <div style={{ display: 'flex', gap: '0px 15px' }}>
                    <button
                      onClick={() =>
                        connectTo(
                          selectedContainer,
                          '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
                        )
                      }
                    >
                      Qm..GAJN
                    </button>
                    <button
                      onClick={() =>
                        connectTo(
                          selectedContainer,
                          '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
                        )
                      }
                    >
                      Qm..uLTa
                    </button>
                  </div>
                  <div style={{ display: 'flex', gap: '0px 15px' }}>
                    <button
                      onClick={() =>
                        connectTo(
                          selectedContainer,
                          '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
                        )
                      }
                    >
                      Qm..75Nb
                    </button>
                    <button
                      onClick={() =>
                        connectTo(
                          selectedContainer,
                          '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
                        )
                      }
                    >
                      Qm..3dwt
                    </button>
                  </div>
                </label>
              </div>
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
              <h3>Peer Info</h3>
              <p>Peer ID: {peerData[selectedContainer]?.peerId}</p>
              <div>Container ID: {selectedContainer}</div>
              <p>Docker connect: docker exec -it {selectedContainer} /bin/sh</p>
              <p>Type: {peerData[selectedContainer]?.type}</p>
              <div>Connect+perf: {Math.round(peerData[selectedContainer]?.connectTime)}ms</div>
              <div>Received Pubsub: {peerData[selectedContainer]?.messageCount}</div>
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
              <div>Libp2p Peer Store: {peerData[selectedContainer]?.libp2pPeers?.length}</div>
              <div>Pubsub Peer Store: {peerData[selectedContainer]?.pubsubPeers?.length}</div>
              <div>DHT Peer Store: {peerData[selectedContainer]?.dhtPeers?.length}</div>
              <div>
                Protocols:{' '}
                {peerData[selectedContainer]?.protocols?.map((p, index) => (
                  <p key={index}>
                    &bull;{'\u00A0'}
                    {p}
                  </p>
                ))}
              </div>
              <div>
                Multiaddrs:{' '}
                {peerData[selectedContainer]?.multiaddrs?.map((p, index) => (
                  <p key={index} style={{ marginBottom: '0.5rem' }}>
                    {p}
                  </p>
                ))}
              </div>
              <div>Connections: {peerData[selectedContainer]?.connections.length}</div>
              <div>
                {Object.keys(peerData[selectedContainer]?.remotePeers).map((rpid) => (
                  <p key={rpid} style={{ marginBottom: '0.5rem' }}>
                    {rpid}
                  </p>
                ))}
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
