import { PeerId } from '@libp2p/interface'
import { Libp2pType } from './types'
import { WebSocketServer } from 'ws';
import { isEqual } from './helpers.js';
import { PeerIdStr, TopicStr } from '@chainsafe/libp2p-gossipsub/types';
import { GossipSub } from '@chainsafe/libp2p-gossipsub';
import { fromString } from 'uint8arrays';
import { toString } from 'uint8arrays'

interface Stream {
  protocol: string,
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

export interface Update {
  containerId?: string
  peerId?: string,
  type?: string
  topic?: string
  subscribers?: string[],
  pubsubPeers?: string[],
  meshPeers?: string[],
  fanoutList?: Map<TopicStr, Set<PeerIdStr>>
  libp2pPeers?: string[],
  connections?: string[],
  protocols?: string[],
  streams?: Streams,
  multiaddrs?: string[],
  topics?: string[],
  dhtPeers?: string[],
  lastMessage?: string,
  peerScores?: PeerScores,
  rtts?: RTTs
}

export class StatusServer {
  // server details
  private server: Libp2pType
  private type: string
  private peerId: PeerId
  private topic: string
  private containerId: string = ''

  // libp2p
  private lastPeerId: string = ''
  private lastType: string = ''
  private lastTopic: string  = ''
  private lastLibp2pPeers: string[] = []
  private lastConnections: string[] = []
  private lastProtocols: string[] = []
  private lastStreams: Streams = {}
  private lastMultiaddrs: string[] = []
  private lastRTTs: RTTs = {} // round trip times

  // pubsub
  private lastTopics: string[] = []
  private lastSubscribers: string[] = []
  private lastPubsubPeers: string[] = []
  private lastMeshPeers: string[] = []
  private lastFanoutList: Map<TopicStr, Set<PeerIdStr>> = new Map<TopicStr, Set<PeerIdStr>>()
  private lastMessage: string = ''
  private lastPeerScores: PeerScores = {}
  private _message: string = ''

  // dht
  private lastDhtPeers: string[] = []

  private wss: WebSocketServer
  private wssAlive: boolean
  private started: boolean
  private scheduleUpdate!: NodeJS.Timeout
  private updateCount: number = 0
  private updateIntervalMs: number = 100
  private updatesBeforeFullData: number = 100 // (this.updateIntervalMs * 100) // 10s
  private rttUpdateIntervalMs: number = 1000

  constructor(server: Libp2pType, type: string, topic: string) {
    this.server = server
    this.type = type
    this.peerId = server.peerId
    this.topic = topic

    this.wssAlive = false
    this.started = false

    this.wss = new WebSocketServer({ host: '0.0.0.0', port: 80 });
    this.wssSetup(this.wss)

    server.addEventListener('connection:open', this.handleConnectionEvent)
    server.addEventListener('connection:close', this.handleConnectionEvent)
    server.addEventListener('connection:prune', this.handleConnectionEvent)
    server.services.pubsub.addEventListener('message', this.handlePubsubMessageEvent)

    this.rttSetup()
    this.started = true
  }

  private handleConnectionEvent = async (evt: CustomEvent) => {
    const connectionList = this.server.getConnections()
    const connections = connectionList.map((connection) => connection.remotePeer.toString())

    const update: Update = {
      connections
    }
    await this.sendUpdate(update)
  }

  private handlePubsubMessageEvent = async (evt: CustomEvent) => {
    if (evt.detail.topic !== this.topic) {
      return
    }

    this.message = toString(evt.detail.data)

    const update: Update = {
      lastMessage: this.message
    }

    await this.sendUpdate(update)
  }

  private getPeerScores = (): PeerScores => {
    const pubsubPeerList = this.server.services.pubsub.getPeers()
    const pubsubPeers = pubsubPeerList.map((peerId: PeerId) => peerId.toString())

    let peerScores: PeerScores = {}
    for (const peer of pubsubPeers) {
      // console.log(`Peerscore: ${peer}: ${(this.server.services.pubsub as GossipSub).getScore(peer)}`)
      peerScores[peer] = (this.server.services.pubsub as GossipSub).getScore(peer)
    }

    return peerScores
  }

  private wssSetup = (wss: WebSocketServer) => {
    const self = this

    wss.on('close', function close() {
      console.log('stopping scheduled updates')
      clearInterval(self.scheduleUpdate);
    });

    wss.on('connection', async function connection(ws) {
      console.log('new websocket connection')
      ws.on('error', console.error);
      ws.on('pong', self.heartbeat);
      ws.on('message', async function incoming(msg) {
        const newMessage = JSON.parse(msg.toString())

        switch (newMessage.mType) {
          case 'set-id': {
            console.log('setting container id', newMessage.message)
            self.containerId = newMessage.message
            const update = await self.fullUpdate()
            await self.sendUpdate(update)
            break
          }
          case 'info': {
            console.log(`${JSON.stringify((self.server.services.pubsub as GossipSub).dumpPeerScoreStats())}`)

            const update: Partial<Update> = {}
            self.lastPeerScores = self.getPeerScores()
            update.peerScores = self.lastPeerScores

            ws.send(JSON.stringify(update))
            break;
          }
          case 'publish': {
            self.message = newMessage.message
            self.lastMessage = newMessage.message

            try {
              self.server.services.pubsub.publish(self.topic, fromString(newMessage.message))
              const update: Update = {
                lastMessage: newMessage.message
              }
              await self.sendUpdate(update)
            } catch (e) {
              console.log(e)
            }
            break;
          }
          default:
            console.log('unknown message type', newMessage.type)
            break;
        }
      });

      ws.send(JSON.stringify(await self.newUpdate()))
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

  private newUpdate = async (): Promise<Update> => {
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

    const topic = this.topic
    if (topic !== this.lastTopic) {
      this.lastTopic = topic
      update.topic = topic
    }

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
    const topics = this.server.services.pubsub.getTopics()
    if (!isEqual(topics, this.lastTopics)) {
      this.lastTopics = topics
      update.topics = topics
    }

    const subscriberList = this.server.services.pubsub.getSubscribers(this.topic)
    const subscribers = subscriberList.map((peerId: PeerId) => peerId.toString())
    if (!isEqual(subscribers, this.lastSubscribers)) {
      this.lastSubscribers = subscribers
      update.subscribers = subscribers
    }

    const pubsubPeerList = this.server.services.pubsub.getPeers()
    const pubsubPeers = pubsubPeerList.map((peerId: PeerId) => peerId.toString())
    if (!isEqual(pubsubPeers, this.lastPubsubPeers)) {
      this.lastPubsubPeers = pubsubPeers
      update.pubsubPeers = pubsubPeers
    }

    const meshPeerList = (this.server.services.pubsub as GossipSub).getMeshPeers(this.topic)
    const meshPeers = meshPeerList.map((peer: PeerIdStr) => peer)
    if (!isEqual(meshPeers, this.lastMeshPeers)) {
      this.lastMeshPeers = meshPeers
      update.meshPeers = meshPeers
    }

    const fanoutList = (this.server.services.pubsub as GossipSub).fanout
    if (!isEqual(fanoutList, this.lastFanoutList)) {
      this.lastFanoutList= fanoutList
      update.fanoutList = fanoutList
    }

    const peerScores = this.getPeerScores()
    if (!isEqual(peerScores, this.lastPeerScores)) {
      this.lastPeerScores = peerScores
      update.peerScores = peerScores
    }

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
    // @ts-ignore-next-line
    const dhtPeerList = [...this.server.services.lanDHT.routingTable.kb.toIterable()];
    const dhtPeers = dhtPeerList.map((peer) => peer.peerId.toString())
    if (!isEqual(dhtPeers, this.lastDhtPeers)) {
      this.lastDhtPeers = dhtPeers
      update.dhtPeers = dhtPeers
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

    const topic = this.topic
    this.lastTopic = topic
    update.topic = topic

    const libp2pPeerList = await this.server.peerStore.all()
    const libp2pPeers = libp2pPeerList.map((peer) => peer.id.toString())
    this.lastLibp2pPeers = libp2pPeers
    update.libp2pPeers = libp2pPeers

    const connectionList = this.server.getConnections()
    const connections = connectionList.map((connection) => connection.remotePeer.toString())
    this.lastConnections = connections
    update.connections = connections

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
    const topics = this.server.services.pubsub.getTopics()
    this.lastTopics = topics
    update.topics = topics

    const subscriberList = this.server.services.pubsub.getSubscribers(this.topic)
    const subscribers = subscriberList.map((peerId: PeerId) => peerId.toString())
    this.lastSubscribers = subscribers
    update.subscribers = subscribers

    const pubsubPeerList = this.server.services.pubsub.getPeers()
    const pubsubPeers = pubsubPeerList.map((peerId: PeerId) => peerId.toString())
    this.lastPubsubPeers = pubsubPeers
    update.pubsubPeers = pubsubPeers

    const meshPeerList = (this.server.services.pubsub as GossipSub).getMeshPeers(this.topic)
    const meshPeers = meshPeerList.map((peer: PeerIdStr) => peer)
    this.lastMeshPeers = meshPeers
    update.meshPeers = meshPeers

    const fanoutList = (this.server.services.pubsub as GossipSub).fanout
    this.lastFanoutList= fanoutList
    update.fanoutList = fanoutList

    this.lastPeerScores = this.getPeerScores()
    update.peerScores = this.lastPeerScores

    this.lastRTTs = this.getRTTs()
    update.rtts = this.lastRTTs

    this.lastMessage = this._message
    update.lastMessage = this.lastMessage

    // dht
    // @ts-ignore-next-line
    const dhtPeerList = [...this.server.services.lanDHT.routingTable.kb.toIterable()];
    const dhtPeers = dhtPeerList.map((peer) => peer.peerId.toString())
    this.lastDhtPeers = dhtPeers
    update.dhtPeers = dhtPeers

    return update
  }

  private sendUpdate = async (update: Update) => {
    if (update.type || update.topic || update.subscribers || update.pubsubPeers || update.meshPeers || update.libp2pPeers || update.connections || update.protocols || update.streams || update.multiaddrs || update.dhtPeers || update.lastMessage || update.peerScores) {
      update.containerId = this.containerId

      this.wss.clients.forEach((ws) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify(update));
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
        await this.sendUpdate(update)
      } else {
        const update = await this.newUpdate()
        await this.sendUpdate(update)
      }
    }, this.updateIntervalMs)

    return updateInterval
  }

  private heartbeat = () => {
    this.wssAlive = true;
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
    const connections = this.server.getConnections();

    return connections.reduce((accumulator, connection) => {
      // Ensure the connection has streams and a valid remotePeer
      if (connection.streams && connection.streams.length > 0 && connection.remotePeer) {
        const peerId = connection.remotePeer.toString();

        // Initialize the array for this peerId if it doesn't exist
        if (!accumulator[peerId]) {
          accumulator[peerId] = [];
        }

        // Map the streams to the desired format and append them to the peer's array
        const mappedStreams: Stream[] = connection.streams.map(stream => ({
          protocol: stream.protocol || '',
          direction: stream.direction
        }));

        accumulator[peerId].push(...mappedStreams);
      }

      return accumulator;
    }, {} as Streams); // Initialize accumulator as an empty object
  };
}
