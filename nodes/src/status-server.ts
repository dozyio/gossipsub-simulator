import { PeerId } from '@libp2p/interface'
import { Libp2pType } from './types.js'
import { WebSocketServer } from 'ws'
import { isEqual } from './helpers.js'
import { PeerIdStr } from '@chainsafe/libp2p-gossipsub/types'
import { GossipSub } from '@chainsafe/libp2p-gossipsub'
import { fromString } from 'uint8arrays'
import { toString } from 'uint8arrays'
import { Multiaddr, multiaddr } from '@multiformats/multiaddr'
import { SingleKadDHT } from '@libp2p/kad-dht'
import { CID } from 'multiformats/cid'

interface Stream {
  protocol: string
  direction: string
}

interface Streams {
  [key: string]: Stream[]
}

interface PeerScores {
  [key: string]: number
}

interface RTTs {
  [key: string]: number
}

interface KadPeer {
  kadId: Uint8Array
  peerId: PeerId
  lastPing: number
}

interface RemotePeer {
  multiaddrs: string[]
  protocols: string[]
  // metadata: Map<string, Uint8Array>
  // tags: Map<string, Tag>
}

interface RemotePeers {
  [peerId: string]: RemotePeer
}

type DHTProvideStatus = null | 'error' | 'inprogress' | 'done'

type TopicsPeers = Record<string, string[]>

export interface Update {
  containerId?: string
  peerId?: string
  type?: string
  subscribersList?: TopicsPeers
  pubsubPeers?: string[]
  meshPeersList?: TopicsPeers
  fanoutList?: TopicsPeers
  libp2pPeers?: string[]
  connections?: string[] // peer ids
  remotePeers?: RemotePeers
  protocols?: string[]
  streams?: Streams
  multiaddrs?: string[]
  topics?: string[]
  dhtPeers?: string[]
  dhtProvideStatus?: DHTProvideStatus
  dhtFindProviderResult?: string[]
  lastMessage?: string
  messageCount?: number
  peerScores?: PeerScores
  rtts?: RTTs
  connectTime?: number
}

export class StatusServer {
  // server details
  private server: Libp2pType
  private type: string
  private peerId: PeerId
  private topics: string[]
  private containerId: string = ''
  private perfBytes: number = 0

  // libp2p
  private lastPeerId: string = ''
  private lastType: string = ''
  private lastLibp2pPeers: string[] = []
  private lastConnections: string[] = []
  private lastRemotePeers: RemotePeers = {}
  private lastProtocols: string[] = []
  private lastStreams: Streams = {}
  private lastMultiaddrs: string[] = []
  private lastRTTs: RTTs = {} // round trip times

  // pubsub
  private lastTopics: string[] = []
  private lastSubscribersList: TopicsPeers = {}
  private lastPubsubPeers: string[] = []
  private lastMeshPeersList: TopicsPeers = {}
  private lastFanoutList: TopicsPeers = {}
  private lastMessage: string = ''
  private messageCount: number = 0
  private lastPeerScores: PeerScores = {}
  private _message: string = ''

  // dht
  private lastDhtPeers: string[] = []
  private lastDhtProvideStatus: DHTProvideStatus = null
  private lastDhtFindProviderResult: string[] = []
  private dhtFindProviderSignalController: AbortController | undefined = undefined

  // perf
  private connectTime: number = 0
  private lastConnectTime: number = 0

  private wss: WebSocketServer
  private wssAlive: boolean
  private started: boolean
  private scheduleUpdate!: NodeJS.Timeout
  private updateCount: number = 0
  private updateIntervalMs: number = 100
  private updatesBeforeFullData: number = 100 // (this.updateIntervalMs * 100) // 10s
  private rttUpdateIntervalMs: number = 1000

  constructor(server: Libp2pType, type: string, topics: string[], perfBytes: number) {
    this.server = server
    this.type = type
    this.peerId = server.peerId
    this.topics = topics
    this.perfBytes = perfBytes

    this.wssAlive = false
    this.started = false

    this.wss = new WebSocketServer({ host: '0.0.0.0', port: 80 })
    this.wssSetup(this.wss)

    server.addEventListener('connection:open', this.handleConnectionEvent)
    server.addEventListener('connection:close', this.handleConnectionEvent)
    server.addEventListener('connection:prune', this.handleConnectionEvent)
    server.addEventListener('self:peer:update', this.handleSelfPeerUpdate)
    if (server.services.pubsub) {
      server.services.pubsub.addEventListener('message', this.handlePubsubMessageEvent)
    }

    this.rttSetup()
    this.started = true
  }

  private handleSelfPeerUpdate = async (evt: CustomEvent) => {
    console.log('handling self:peer:update')
    const update = await this.fullUpdate()
    await this.sendUpdate(update)
  }

  private handleConnectionEvent = async (evt: CustomEvent) => {
    const connectionList = this.server.getConnections()
    const connections = connectionList.map((connection) => connection.remotePeer.toString())

    const remotePeers = await this.getRemotePeers()

    await this.sendUpdate({ connections, remotePeers })
  }

  private handlePubsubMessageEvent = async (evt: CustomEvent) => {
    if (!this.topics.includes(evt.detail.topic)) {
      console.log('unknown topic', evt.detail.topic)
      return
    }

    this.message = toString(evt.detail.data)
    this.messageCount++

    await this.sendUpdate({ lastMessage: this.message, messageCount: this.messageCount })
  }

  private getRemotePeers = async (): Promise<RemotePeers> => {
    const connections = this.server.getConnections()
    const peerEntries = await Promise.all(
      connections.map(async (conn) => {
        try {
          const peer = await this.server.peerStore.get(conn.remotePeer)
          const rp: RemotePeer = {
            multiaddrs: peer.addresses.map((ma) => ma.multiaddr.toString()),
            protocols: peer.protocols,
          }
          // as const so tuple type is preserved
          return [peer.id.toString(), rp] as const
        } catch (e) {
          console.error(`error getting remote peer ${conn.remotePeer} from peerStore`, e)
          return undefined
        }
      }),
    )

    const validEntries = peerEntries.filter((entry): entry is readonly [string, RemotePeer] => entry !== undefined)

    const remotePeers: RemotePeers = Object.fromEntries(validEntries)

    return remotePeers
  }

  private getPeerScores = (): PeerScores => {
    if (!this.server.services.pubsub) {
      return {}
    }

    const pubsubPeerList = this.server.services.pubsub.getPeers()
    const pubsubPeers = pubsubPeerList.map((peerId: PeerId) => peerId.toString())

    let peerScores: PeerScores = {}
    for (const peer of pubsubPeers) {
      // console.log(`Peerscore: ${peer}: ${(this.server.services.pubsub as GossipSub).getScore(peer)}`)
      peerScores[peer] = (this.server.services.pubsub as GossipSub).getScore(peer)
    }

    return peerScores
  }

  private getRandomColor(): string {
    // Converts an 8-bit channel (0–255) into linearized RGB space
    const channelLuminance = (c: number): number => {
      const sc = c / 255
      return sc <= 0.03928 ? sc / 12.92 : Math.pow((sc + 0.055) / 1.055, 2.4)
    }

    for (;;) {
      // Generate a random 24-bit integer (0x000000–0xFFFFFF)
      const colorVal = Math.floor(Math.random() * 0x1000000)

      // Extract RGB channels
      const r = (colorVal >> 16) & 0xff
      const g = (colorVal >> 8) & 0xff
      const b = colorVal & 0xff

      // Compute relative luminance of the random colour
      const R = channelLuminance(r)
      const G = channelLuminance(g)
      const B = channelLuminance(b)
      const bgLum = 0.2126 * R + 0.7152 * G + 0.0722 * B

      // Luminance of white is 1.0
      const whiteLum = 1.0
      // Determine which is brighter/darker
      const brighter = Math.max(bgLum, whiteLum)
      const darker = Math.min(bgLum, whiteLum)

      // Contrast ratio per WCAG: (L1 + 0.05) / (L2 + 0.05)
      const ratio = (brighter + 0.05) / (darker + 0.05)

      // Return as soon as we find one with sufficient contrast
      if (ratio >= 4.5) {
        // Format as "#RRGGBB"
        return `#${colorVal.toString(16).padStart(6, '0').toUpperCase()}`
      }
    }
  }

  private wssSetup = (wss: WebSocketServer) => {
    const self = this

    wss.on('close', function close() {
      console.log('stopping scheduled updates')
      clearInterval(self.scheduleUpdate)
    })

    wss.on('connection', async function connection(ws) {
      console.log('new status server websocket connection')
      ws.on('error', console.error)
      ws.on('pong', self.heartbeat)
      ws.on('message', async function incoming(msg) {
        const newMessage = JSON.parse(msg.toString())

        switch (newMessage.mType) {
          case 'set-id': {
            try {
              console.log('setting container id', newMessage.message.id)
              self.containerId = newMessage.message.id
              await self.sendUpdate(await self.fullUpdate())
            } catch (e) {
              console.log('set-id error', e)
            }
            break
          }

          case 'publish': {
            if (!self.server.services.pubsub) {
              return
            }

            // todo handle size
            self.message = newMessage.message.message
            self.lastMessage = newMessage.message.message
            const topic = newMessage.message.topic
            console.log('publish msg', newMessage)

            let amount = 1
            if (newMessage.message.amount <= 0) {
              amount = 1
            } else {
              amount = newMessage.message.amount
            }

            for (let i = 0; i < amount; i++) {
              if (amount > 1) {
                self.message = self.getRandomColor()
                self.lastMessage = self.message
              }

              try {
                self.messageCount++
                const pubRes = await self.server.services.pubsub.publish(topic, fromString(self.message))
                // console.log('published', pubRes)
                await self.sendUpdate({ lastMessage: self.message, messageCount: self.messageCount })
              } catch (e) {
                console.log(e)
              }
            }
            break
          }

          case 'clearpubsub': {
            console.log('clearpubsub msg', newMessage)
            self.message = ''
            self.lastMessage = ''
            self.messageCount = 0

            break
          }

          case 'connect': {
            console.log('connect msg', newMessage)
            try {
              let maa: Multiaddr[] = []

              newMessage.message.multiaddrs.split(',').forEach((m: string) => {
                maa.push(multiaddr(m))
              })

              console.log('dialing', maa)
              const start = process.hrtime()
              const dRes = await self.server.dial(maa, { signal: AbortSignal.timeout(10_000) })

              if (self.perfBytes && self.server.services.perf) {
                try {
                  for await (const output of self.server.services.perf.measurePerformance(
                    dRes.remoteAddr,
                    self.perfBytes,
                    self.perfBytes,
                    { reuseExistingConnection: true },
                  )) {
                    console.log('perf', output)
                  }
                } catch (err: any) {
                  console.error('Error measuring performance:', err)
                }
              }
              const [seconds, nanoseconds] = process.hrtime(start)
              self.connectTime = seconds * 1000 + nanoseconds / 1e6
              console.log('dialed', dRes.remoteAddr.toString())
            } catch (e) {
              console.log(e)
            }

            break
          }

          case 'dhtprovide': {
            console.log('dhtprovide msg', newMessage)
            try {
              const c = CID.parse(newMessage.message.cid)

              self.lastDhtProvideStatus = 'inprogress'
              await self.sendUpdate({ dhtProvideStatus: self.lastDhtProvideStatus })
              await self.server.contentRouting.provide(c)
              self.lastDhtProvideStatus = 'done'

              await self.sendUpdate({ dhtProvideStatus: self.lastDhtProvideStatus })
            } catch (e: any) {
              console.log('provide failed: ', e)
              self.lastDhtProvideStatus = 'error'

              await self.sendUpdate({ dhtProvideStatus: self.lastDhtProvideStatus })
            }
            break
          }

          case 'dhtfindprovider': {
            console.log('dhtfindprovider msg', newMessage)

            let c: CID
            try {
              c = CID.parse(newMessage.message.cid)
            } catch (e: any) {
              self.lastDhtFindProviderResult = ['invalid CID']

              await self.sendUpdate({
                dhtFindProviderResult: self.lastDhtFindProviderResult,
              })
              break
            }

            if (self.dhtFindProviderSignalController) {
              self.dhtFindProviderSignalController.abort()
              self.lastDhtFindProviderResult = ['aborted']
              await self.sendUpdate({
                dhtFindProviderResult: self.lastDhtFindProviderResult,
              })
            }

            self.lastDhtFindProviderResult = ['searching']
            await self.sendUpdate({
              dhtFindProviderResult: self.lastDhtFindProviderResult,
            })
            try {
              self.dhtFindProviderSignalController = new AbortController()
              const timeoutSignal = AbortSignal.timeout(60_000)
              const signal = AbortSignal.any([timeoutSignal, self.dhtFindProviderSignalController.signal])

              for await (const provider of self.server.contentRouting.findProviders(c, {
                signal,
              })) {
                console.log(provider)

                if (self.lastDhtFindProviderResult.length === 1 && self.lastDhtFindProviderResult[0] === 'searching') {
                  self.lastDhtFindProviderResult = []
                  self.lastDhtFindProviderResult.push(provider.id.toString())
                } else {
                  self.lastDhtFindProviderResult.push(provider.id.toString())
                }

                await self.sendUpdate({ dhtFindProviderResult: self.lastDhtFindProviderResult })
              }
            } catch (e: any) {
              if (e.name === 'QueryAbortedError') {
                console.log('dhtFindProvider aborted')
                if (self.lastDhtFindProviderResult.length > 0) {
                  if (self.lastDhtFindProviderResult[0] === 'searching') {
                    self.lastDhtFindProviderResult[0] = 'no-providers-found'
                  } else {
                    self.lastDhtFindProviderResult.push('ended-after-60s')
                  }
                  await self.sendUpdate({ dhtFindProviderResult: self.lastDhtFindProviderResult })
                }
              } else {
                self.lastDhtFindProviderResult = [`error ${e}`]

                await self.sendUpdate({ dhtFindProviderResult: self.lastDhtFindProviderResult })
              }
            }
            break
          }

          case 'dhtfindpeer': {
            console.log('dhtfindprovider msg', newMessage)
            break
          }

          default:
            console.log('unknown message type', newMessage.type)
            break
        }
      })

      ws.send(JSON.stringify(await self.deltaUpdate()))
      self.scheduleUpdate = self.scheduleUpdates()
    })

    this.wssAlive = true
  }

  public get isStarted(): boolean {
    return this.started
  }

  get message(): string {
    return this._message
  }

  set message(message: string) {
    this._message = message
  }

  private getAllSubscribersAllTopics = (): TopicsPeers => {
    if (!this.server.services.pubsub) {
      return {}
    }

    const topics = this.server.services.pubsub.getTopics()

    const subscribersList: TopicsPeers = {}

    topics.forEach((topic) => {
      const subscriberList = this.server.services.pubsub.getSubscribers(topic)
      const subscribers = subscriberList.map((peerId: PeerId) => peerId.toString())

      subscribersList[topic] = subscribers
    })

    return subscribersList
  }

  private getAllMeshPeersAllTopics = (): TopicsPeers => {
    if (!this.server.services.pubsub) {
      return {}
    }

    const topics = this.server.services.pubsub.getTopics()

    const meshPeersList: TopicsPeers = {}

    topics.forEach((topic) => {
      const meshPeerList = (this.server.services.pubsub as GossipSub).getMeshPeers(topic)
      const meshPeers = meshPeerList.map((peer: PeerIdStr) => peer)
      meshPeersList[topic] = meshPeers
    })

    return meshPeersList
  }

  private getFanoutPeers = (): TopicsPeers => {
    if (!this.server.services.pubsub) {
      return {}
    }

    let topicsPeers: TopicsPeers = {}

    ;(this.server.services.pubsub as GossipSub).fanout.forEach((v: Set<string>, k: string) => {
      topicsPeers[k] = Array.from(v)
    })

    return topicsPeers
  }

  private getPubsubTopics = (): string[] => {
    if (!this.server.services.pubsub) {
      return []
    }

    return this.server.services.pubsub.getTopics()
  }

  private getPubsubPeers = (): PeerId[] => {
    if (!this.server.services.pubsub) {
      return []
    }

    return this.server.services.pubsub.getPeers()
  }

  private getDHTPeerList = (): KadPeer[] => {
    if (!this.server.services.dht) {
      return []
    }

    // @ts-ignore-next-line
    //console.log('DHT peers', ...(this.server.services.dht as SingleKadDHT).routingTable.kb.toIterable())
    // @ts-ignore-next-line
    return [...(this.server.services.dht as SingleKadDHT).routingTable.kb.toIterable()]
  }

  private deltaUpdate = async (): Promise<Update> => {
    const update: Update = {}

    // libp2p
    const peerId = this.peerId.toString()
    if (peerId !== this.lastPeerId) {
      this.lastPeerId = peerId
      update.peerId = peerId
    }

    const type = this.type
    if (type !== this.lastType) {
      this.lastType = type
      update.type = type
    }

    // const topics = this.topics
    // if (topics !== this.lastTopics) {
    //   this.lastTopics = topics
    //   update.topics = topics
    // }

    const libp2pPeerList = await this.server.peerStore.all()
    const libp2pPeers = libp2pPeerList.map((peer) => peer.id.toString())
    if (!isEqual(libp2pPeers, this.lastLibp2pPeers)) {
      this.lastLibp2pPeers = libp2pPeers
      update.libp2pPeers = libp2pPeers
    }

    // connections have own handler
    // const connectionList = this.server.getConnections()
    // const connections = connectionList.map((connection) => connection.remotePeer.toString())
    // if (!isEqual(connections, this.lastConnections)) {
    //   this.lastConnections = connections
    //   update.connections = connections
    // }

    const remotePeers = await this.getRemotePeers()
    if (!isEqual(remotePeers, this.lastRemotePeers)) {
      this.lastRemotePeers = remotePeers
      update.remotePeers = remotePeers
    }

    const streams = this.getStreams()
    if (!isEqual(streams, this.lastStreams)) {
      this.lastStreams = streams
      update.streams = streams
    }

    const protocols = this.server.getProtocols()
    if (!isEqual(protocols, this.lastProtocols)) {
      this.lastProtocols = protocols
      update.protocols = protocols
    }

    const multiaddrList = this.server.getMultiaddrs()
    const multiaddrs = multiaddrList.map((ma) => ma.toString())
    if (!isEqual(multiaddrs, this.lastMultiaddrs)) {
      this.lastMultiaddrs = multiaddrs
      update.multiaddrs = multiaddrs
    }

    // pubsub
    // pubsub topics
    const topics = this.getPubsubTopics()
    if (!isEqual(topics, this.lastTopics)) {
      this.lastTopics = topics
      update.topics = topics
    }

    // pubsub topic subscribers
    const subscribersList = this.getAllSubscribersAllTopics()
    if (!isEqual(subscribersList, this.lastSubscribersList)) {
      this.lastSubscribersList = subscribersList
      update.subscribersList = subscribersList
    }

    // pubsub peers
    const pubsubPeerList = this.getPubsubPeers()
    const pubsubPeers = pubsubPeerList.map((peerId: PeerId) => peerId.toString())
    if (!isEqual(pubsubPeers, this.lastPubsubPeers)) {
      this.lastPubsubPeers = pubsubPeers
      update.pubsubPeers = pubsubPeers
    }

    // pubsub mesh peers
    const meshPeersList = this.getAllMeshPeersAllTopics()
    if (!isEqual(meshPeersList, this.lastMeshPeersList)) {
      this.lastMeshPeersList = meshPeersList
      update.meshPeersList = meshPeersList
    }

    // gossipsub fanout peers
    const fanoutList = this.getFanoutPeers()
    if (!isEqual(fanoutList, this.lastFanoutList)) {
      this.lastFanoutList = fanoutList
      update.fanoutList = fanoutList
    }

    // gossipsub peer scores
    const peerScores = this.getPeerScores()
    if (!isEqual(peerScores, this.lastPeerScores)) {
      this.lastPeerScores = peerScores
      update.peerScores = peerScores
    }

    // Round trip times
    const rtts = this.getRTTs()
    if (!isEqual(rtts, this.lastRTTs)) {
      this.lastRTTs = rtts
      update.rtts = rtts
    }

    // messages have own handler
    // if (this.lastMessage !== this._message) {
    //   this.lastMessage = this._message
    //   update.lastMessage = this.lastMessage
    // }

    // dht
    const dhtPeerList = this.getDHTPeerList()
    const dhtPeers = dhtPeerList.map((peer) => peer.peerId.toString())
    if (!isEqual(dhtPeers, this.lastDhtPeers)) {
      this.lastDhtPeers = dhtPeers
      update.dhtPeers = dhtPeers
    }

    // skip dhtProvideStatus as has its own updater
    // skip dhtFindProviderResult as has its own updater

    if (!isEqual(this.connectTime, this.lastConnectTime)) {
      update.connectTime = this.connectTime
    }
    return update
  }

  private fullUpdate = async (): Promise<Update> => {
    const update: Update = {}

    // libp2p
    const peerId = this.peerId.toString()
    this.lastPeerId = peerId
    update.peerId = peerId

    const type = this.type
    this.lastType = type
    update.type = type

    // const topic = this.topic
    // this.lastTopic = topic
    // update.topic = topic

    const libp2pPeerList = await this.server.peerStore.all()
    const libp2pPeers = libp2pPeerList.map((peer) => peer.id.toString())
    this.lastLibp2pPeers = libp2pPeers
    update.libp2pPeers = libp2pPeers

    const connectionList = this.server.getConnections()
    const connections = connectionList.map((connection) => connection.remotePeer.toString())
    this.lastConnections = connections
    update.connections = connections

    const remotePeers = await this.getRemotePeers()
    this.lastRemotePeers = remotePeers
    update.remotePeers = remotePeers

    const streams = this.getStreams()
    this.lastStreams = streams
    update.streams = streams

    const protocols = this.server.getProtocols()
    this.lastProtocols = protocols
    update.protocols = protocols

    const multiaddrList = this.server.getMultiaddrs()
    const multiaddrs = multiaddrList.map((ma) => ma.toString())
    this.lastMultiaddrs = multiaddrs
    update.multiaddrs = multiaddrs

    // pubsub
    const topics = this.getPubsubTopics()
    this.lastTopics = topics
    update.topics = topics

    const subscribersList = this.getAllSubscribersAllTopics()
    this.lastSubscribersList = subscribersList
    update.subscribersList = subscribersList

    const pubsubPeerList = this.getPubsubPeers()
    const pubsubPeers = pubsubPeerList.map((peerId: PeerId) => peerId.toString())
    this.lastPubsubPeers = pubsubPeers
    update.pubsubPeers = pubsubPeers

    const meshPeersList = this.getAllMeshPeersAllTopics()
    this.lastMeshPeersList = meshPeersList
    update.meshPeersList = meshPeersList

    const fanoutList = this.getFanoutPeers()
    this.lastFanoutList = fanoutList
    update.fanoutList = fanoutList

    this.lastPeerScores = this.getPeerScores()
    update.peerScores = this.lastPeerScores

    this.lastRTTs = this.getRTTs()
    update.rtts = this.lastRTTs

    this.lastMessage = this._message
    update.lastMessage = this.lastMessage

    update.messageCount = this.messageCount

    // dht
    const dhtPeerList = this.getDHTPeerList()
    const dhtPeers = dhtPeerList.map((peer) => peer.peerId.toString())
    this.lastDhtPeers = dhtPeers
    update.dhtPeers = dhtPeers

    update.dhtProvideStatus = this.lastDhtProvideStatus
    update.dhtFindProviderResult = this.lastDhtFindProviderResult

    // perf connect
    this.lastConnectTime = this.connectTime
    update.connectTime = this.lastConnectTime

    return update
  }

  private sendUpdate = async (update: Update) => {
    if (
      update.type ||
      update.subscribersList ||
      update.pubsubPeers ||
      update.meshPeersList ||
      update.libp2pPeers ||
      update.connections ||
      update.remotePeers ||
      update.protocols ||
      update.streams ||
      update.multiaddrs ||
      update.dhtPeers ||
      update.dhtProvideStatus ||
      update.dhtFindProviderResult ||
      update.lastMessage ||
      update.peerScores ||
      update.rtts ||
      update.connectTime
    ) {
      update.containerId = this.containerId

      this.wss.clients.forEach((ws) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify(update))
        } else {
          console.log('websocket not open')
        }
      })
    }
  }

  private scheduleUpdates = () => {
    const updateInterval = setInterval(async () => {
      this.updateCount++

      if (this.updateCount >= this.updatesBeforeFullData) {
        this.updateCount = 0
        const update = await this.fullUpdate()
        // console.log('full update', update)
        await this.sendUpdate(update)
      } else {
        const update = await this.deltaUpdate()
        await this.sendUpdate(update)
      }
    }, this.updateIntervalMs)

    return updateInterval
  }

  private heartbeat = () => {
    this.wssAlive = true
  }

  private getRTTs = (): RTTs => {
    const rtts: RTTs = {}

    for (const conns of this.server.getConnections()) {
      rtts[conns.remotePeer.toString()] = conns.rtt ?? -1
    }

    return rtts
  }

  private rttSetup = () => {
    const self = this

    setInterval(async () => {
      self.lastRTTs = self.getRTTs()
    }, this.rttUpdateIntervalMs)
  }

  private getStreams = (): Streams => {
    const connections = this.server.getConnections()

    return connections.reduce((accumulator, connection) => {
      // Ensure the connection has streams and a valid remotePeer
      if (connection.streams && connection.streams.length > 0 && connection.remotePeer) {
        const peerId = connection.remotePeer.toString()

        // Initialize the array for this peerId if it doesn't exist
        if (!accumulator[peerId]) {
          accumulator[peerId] = []
        }

        // Map the streams to the desired format and append them to the peer's array
        const mappedStreams: Stream[] = connection.streams.map((stream) => ({
          protocol: stream.protocol || '',
          direction: stream.direction,
        }))

        accumulator[peerId].push(...mappedStreams)
      }

      return accumulator
    }, {} as Streams) // Initialize accumulator as an empty object
  }
}
