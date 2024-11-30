/* eslint-disable no-console */

//import Fastify from 'fastify'
import { WebSocketServer } from 'ws';
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { webSockets } from '@libp2p/websockets'
import { tcp } from '@libp2p/tcp'
import { keys } from '@libp2p/crypto'
import * as filters from '@libp2p/websockets/filters'
import { createLibp2p } from 'libp2p'
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'
import { isEqual, hexStringToUint8Array, getStreams } from './helpers.js'
import { ping } from '@libp2p/ping'
import { fromString, toString } from 'uint8arrays'
import { multiaddr } from '@multiformats/multiaddr'
import { kadDHT, removePublicAddressesMapper } from '@libp2p/kad-dht'
import { peerIdFromString } from '@libp2p/peer-id'
import { isPrivateIp } from '@libp2p/utils/private-ip'
// import pRetry from 'p-retry'
// import delay from 'delay'

let seed = '0x1111111111111111111111111111111111111111111111111111111111111111'
if (process.env.SEED !== undefined) {
  seed = process.env.SEED
}

let port = '42069'
if (process.env.PORT !== undefined) {
  port = process.env.PORT
}

let topic = 'pubXXX-dev'
if (process.env.TOPIC !== undefined) {
  topic = process.env.TOPIC
}

let dhtPrefix = 'local'
if (process.env.DHTPREFIX !== undefined) {
  dhtPrefix = process.env.dhtPrefix
}

//'0xddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd1'
const bootstrapper1PeerId = '12D3KooWJwYWjPLsTKiZ7eMjDagCZh9Fqt1UERLKoPb5QQNByrAF'
const bootstrapper1Ma = `/dns/bootstrapper1/tcp/42069/p2p/${bootstrapper1PeerId}`

//'0xddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd2'
const bootstrapper2PeerId = '12D3KooWAfBVdmphtMFPVq3GEpcg3QMiRbrwD9mpd6D6fc4CswRw'
const bootstrapper2Ma = `/dns/bootstrapper2/tcp/42069/p2p/${bootstrapper2PeerId}`

function applicationScore(p) {
  if (p === bootstrapper1PeerId || p === bootstrapper2PeerId) {
    return 150
  }

  return 0
}

const pKey = await keys.generateKeyPairFromSeed('Ed25519', hexStringToUint8Array(seed))
const gossipsubConfig = {
  enabled: true,
  D: 8,
  Dlo: 6,
  Dhi: 12,
  doPX: true,
  emitSelf: false,
  allowPublishToZeroTopicPeers: true, // don't throw if no peers
  scoreParams: {
    IPColocationFactorWeight: 0,
    // behaviourPenaltyWeight: 0,
    appSpecificScore: applicationScore
  },
  scoreThresholds: {
    gossipThreshold: -4000,
    publishThreshold: -8000,
    graylistThreshold: -16000,
    acceptPXThreshold: 100,
    opportunisticGraftThreshold: 5,
  },
  directConnectTicks: 30,
  directConnectInitialDelay: 500,
  // directPeers: [
  //   {
  //     id: peerIdFromString(bootstrapper1PeerId),
  //     addrs: multiaddr(bootstrapper1Ma)
  //   },
  //   {
  //     id: peerIdFromString(bootstrapper2PeerId),
  //     addrs: multiaddr(bootstrapper2Ma)
  //   },
  // ],
}

if (process.env.SEED === '0xddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd1') {
  gossipsubConfig.directPeers = [
    {
      id: peerIdFromString(bootstrapper2PeerId),
      addrs: [multiaddr(bootstrapper2Ma)]
    },
  ]
}
if (process.env.SEED === '0xddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd2') {
  gossipsubConfig.directPeers = [
    {
      id: peerIdFromString(bootstrapper1PeerId),
      addrs: [multiaddr(bootstrapper1Ma)]
    },
  ]
}

const removePublicAddressesLoopbackAddressesMapper = (peer) => {
  const newMultiaddrs = peer.multiaddrs.filter(multiaddr => {
    const [[type, addr]] = multiaddr.stringTuples()

    if (addr === 'localhost') {
      return false
    }

    if (addr === '127.0.0.1') {
      return false
    }

    if (type !== 4 && type !== 6) {
      return false
    }

    if (addr == null) {
      return false
    }

    const isPrivate = isPrivateIp(addr)

    if (isPrivate == null) {
      // not an ip address
      return false
    }

    return isPrivate
  })

  // console.log('newMultiaddrs', newMultiaddrs)

  return {
    ...peer,
    multiAddrs: newMultiaddrs
  }
}

const libp2pConfig = {
  privateKey: pKey,
  addresses: {
    listen: [
      // `/ip4/0.0.0.0/tcp/${port}/ws`,
      `/ip4/0.0.0.0/tcp/${port}`,
    ]
  },
  transports: [
    webSockets({
      filter: filters.all
    }),
    tcp()
  ],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  // peerDiscovery: [
  //   pubsubPeerDiscovery()
  // ],
  connectionManager: {
    maxConnections: Infinity
  },
  services: {
    identify: identify(),
    ping: ping(),
    pubsub: gossipsub(gossipsubConfig),
    lanDHT: kadDHT({
      protocol: `/${dhtPrefix}/lan/kad/1.0.0`,
      clientMode: false,
      peerInfoMapper: removePublicAddressesLoopbackAddressesMapper,
      allowQueryWithZeroPeers: true,
      // initialQuerySelfInterval: 0,
      networkDialTimeout: {
        minTimeout: 10_000,
      }
    }),
  }
}

const server = await createLibp2p(libp2pConfig)
await server.services.lanDHT.setMode("server")


let lastMessage = ''
let message = ''

// server.services.pubsub.addEventListener('gossipsub:heartbeat', async (evt) => {
//   console.log('relay heartbeat', evt.detail)
// })

// server.services.pubsub.addEventListener('gossipsub:graft', async (evt) => {
//   console.log('relay gossip:graft', evt.detail)
// })

// server.services.pubsub.addEventListener('gossipsub:prune', async (evt) => {
//   console.log('relay gossip:prune', evt.detail)
// })

server.services.pubsub.addEventListener('message', (evt) => {
  if (evt.detail.topic !== topic) {
    // ignore messages on other topics
    return
  }

  message = toString(evt.detail.data)
})


server.services.pubsub.subscribe(topic)

const type = 'bootstrapper'
const peerId = server.peerId.toString()

// initial state
let topics = server.services.pubsub.getTopics()
let subscriberList = server.services.pubsub.getSubscribers(topic)
let pubsubPeerList = server.services.pubsub.getPeers()
let meshPeerList = server.services.pubsub.getMeshPeers(topic)
let libp2pPeerList = await server.peerStore.all()
let connectionList = server.getConnections()
let protocols = server.getProtocols()
let multiaddrList = server.getMultiaddrs()
let dhtPeerList = [...server.services.lanDHT.routingTable.kb.toIterable()];

let subscribers = subscriberList.map((peerId) => peerId.toString())
let pubsubPeers = pubsubPeerList.map((peerId) => peerId.toString())
let meshPeers = meshPeerList.map((peer) => peer.toString())
let libp2pPeers = libp2pPeerList.map((peer) => peer.id.toString())
let connections = connectionList.map((connection) => connection.remotePeer.toString())
let multiaddrs = multiaddrList.map((ma) => ma.toString())
let dhtPeers = dhtPeerList.map((peer) => peer.peerId.toString())
let streams = getStreams(server)

let isAlive = true
const heartbeat = () => {
  isAlive = true;
}

const wss = new WebSocketServer({ host: '0.0.0.0', port: 80 });
wss.on('connection', function connection(ws) {
  ws.isAlive = true;
  ws.on('error', console.error);
  ws.on('pong', heartbeat);
  ws.on('message', function incoming(msg) {
    const newMessage = JSON.parse(msg)

    switch (newMessage.type) {
      case 'info':
        server.services.pubsub.score.refreshScores()
        console.log(server.services.pubsub.dumpPeerScoreStats())
        break;
      case 'publish':
        message = newMessage.message
        try {
          // server.services.pubsub.publish(topic, fromString(message))
        } catch (e) {
          console.log(e)
        }
        break;
      default:
        console.log('unknown message type', newMessage.type)
        break;
    }
  });

  const updateData = {
    peerId,
    subscribers,
    pubsubPeers,
    meshPeers,
    libp2pPeers,
    connections,
    protocols,
    streams,
    multiaddrs,
    topics,
    dhtPeers,
    type,
    lastMessage,
  };

  ws.send(JSON.stringify(updateData));
});

// const interval = setInterval(function ping() {
//   wss.clients.forEach(function each(ws) {
//     if (ws.isAlive === false) return ws.terminate();
//
//     ws.isAlive = false;
//     ws.ping();
//   });
// }, 30000);

wss.on('close', function close() {
  clearInterval(interval);
});

setInterval(async () => {
  let subscribersChanged = false;
  const newSubscriberList = server.services.pubsub.getSubscribers(topic)
  const newSubscribers = newSubscriberList.map((peerId) => peerId.toString())

  if (!isEqual(subscribers, newSubscribers)) {
    subscribers = newSubscribers
    subscribersChanged = true;
  }

  let pubsubPeersChanged = false;
  const newPubsubPeerList = server.services.pubsub.getPeers()
  const newPubsubPeers = newPubsubPeerList.map((peerId) => peerId.toString())

  if (!isEqual(pubsubPeers, newPubsubPeers)) {
    pubsubPeers = newPubsubPeers
    pubsubPeersChanged = true;
  }

  let libp2pPeersChanged = false;
  const newLibp2pPeerList = await server.peerStore.all()
  const newLibp2pPeers = newLibp2pPeerList.map((peer) => peer.id.toString())

  if (!isEqual(libp2pPeers, newLibp2pPeers)) {
    libp2pPeers = newLibp2pPeers
    libp2pPeersChanged = true;
  }

  let meshPeersChanged = false;
  const newMeshPeerList = await server.services.pubsub.getMeshPeers(topic)
  const newMeshPeers = newMeshPeerList.map((peer) => peer.toString())

  if (!isEqual(meshPeers, newMeshPeers)) {
    meshPeers = newMeshPeers
    meshPeersChanged = true;
  }

  let connectionsChanged = false;
  const newConnectionsList = server.getConnections()
  const newConnections = newConnectionsList.map((connection) => connection.remotePeer.toString())

  if (!isEqual(connections, newConnections)) {
    connections = newConnections
    connectionsChanged = true;
  }

  let streamsChanged = false;
  const newStreams = getStreams(server)

  if (!isEqual(streams, newStreams)) {
    streams = newStreams
    streamsChanged = true;
  }

  let protocolsChanged = false;
  const newProtocols = server.getProtocols()

  if (!isEqual(protocols, newProtocols)) {
    protocols = newProtocols
    protocolsChanged = true;
  }

  let multiaddrsChanged = false;
  const newMultiaddrList = server.getMultiaddrs()
  const newMultiaddrs = newMultiaddrList.map((ma) => ma.toString())

  if (!isEqual(multiaddrs, newMultiaddrs)) {
    multiaddrs = newMultiaddrs
    multiaddrsChanged = true;
  }

  let dhtPeersChanged = false;
  const newDhtPeerList = [...server.services.lanDHT.routingTable.kb.toIterable()]
  const newDhtPeers = newDhtPeerList.map((peer) => peer.peerId.toString())

  if (!isEqual(dhtPeers, newDhtPeers)) {
    dhtPeers = newDhtPeers
    dhtPeersChanged = true;
  }

  let lastMessageChanged = false;
  if (lastMessage !== message) {
    lastMessage = message
    lastMessageChanged = true;
  }

  if (subscribersChanged || pubsubPeersChanged || meshPeersChanged || libp2pPeersChanged || connectionsChanged || protocolsChanged || streamsChanged || lastMessageChanged || multiaddrsChanged || dhtPeersChanged) {
    const updateData = {}

    if (subscribersChanged) {
      updateData.subscribers = subscribers
    }

    if (pubsubPeersChanged) {
      updateData.pubsubPeers = pubsubPeers
    }

    if (meshPeersChanged) {
      updateData.meshPeers = meshPeers
    }

    if (libp2pPeersChanged) {
      updateData.libp2pPeers = libp2pPeers
    }

    if (connectionsChanged) {
      updateData.connections = connections
    }

    if (protocolsChanged) {
      updateData.protocols = protocols
    }

    if (streamsChanged) {
      updateData.streams = streams
    }

    if (multiaddrsChanged) {
      updateData.mulitaddrs = multiaddrs
    }

    if (dhtPeersChanged) {
      updateData.dhtPeers = dhtPeers
    }

    if (lastMessageChanged) {
      updateData.lastMessage = lastMessage
    }

    // Send the data to all connected WebSocket clients
    wss.clients.forEach((ws) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(updateData));
      }
    });
  }
}, 100)

console.log('Bootstrapper listening on multiaddr(s): ', server.getMultiaddrs().map((ma) => ma.toString()))


// const fastify = Fastify({
//   logger: false
// })
//
// fastify.get('/', async function handler(request, reply) {
//   reply.header("Access-Control-Allow-Origin", "*");
//   reply.header("Access-Control-Allow-Header", "*");
//   reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
//
//   const subscriberList = server.services.pubsub.getSubscribers(topic)
//   const peerList = server.services.pubsub.getPeers()
//   const connections = server.getConnections()
//
//   return {
//     peerId: server.peerId.toString(),
//     subscribers: subscriberList.map((peerId) => peerId.toString()),
//     peers: peerList.map((peerId) => peerId.toString()),
//     connections: connections.map((connection) => connection.remotePeer.toString()),
//     topics: server.services.pubsub.getTopics(),
//     type: 'relay'
//   }
// })
//
// try {
//   await fastify.listen({ host: '0.0.0.0', port: 80 })
// } catch (err) {
//   fastify.log.error(err)
//   process.exit(1)
// }

// setInterval(() => {
//   const peerList = server.services.pubsub.getSubscribers(topic)
//   console.log('Relay Gossip Peers: ', peerList)
// }, 1000)
