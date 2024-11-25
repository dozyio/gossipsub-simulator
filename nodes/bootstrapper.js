/* eslint-disable no-console */

//import Fastify from 'fastify'
import { WebSocketServer } from 'ws';
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { webSockets } from '@libp2p/websockets'
import { keys } from '@libp2p/crypto'
import * as filters from '@libp2p/websockets/filters'
import { createLibp2p } from 'libp2p'
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'
import { isEqual, hexStringToUint8Array } from './helpers.js'
import { ping } from '@libp2p/ping'
import { fromString, toString } from 'uint8arrays'
import { multiaddr } from '@multiformats/multiaddr'
import { kadDHT, removePublicAddressesMapper } from '@libp2p/kad-dht'
import { peerIdFromString } from '@libp2p/peer-id'

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
const bootstrapper1Ma = `/dns/bootstrapper1/tcp/42069/ws/p2p/${bootstrapper1PeerId}`

//'0xddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd2'
const bootstrapper2PeerId = '12D3KooWAfBVdmphtMFPVq3GEpcg3QMiRbrwD9mpd6D6fc4CswRw'
const bootstrapper2Ma = `/dns/bootstrapper2/tcp/42069/ws/p2p/${bootstrapper2PeerId}`

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
  directConnectTicks: 10,
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

const libp2pConfig = {
  privateKey: pKey,
  addresses: {
    listen: [`/ip4/0.0.0.0/tcp/${port}/ws`]
  },
  transports: [
    webSockets({
      filter: filters.all
    })
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
      // peerInfoMapper: removePublicAddressesMapper,
    }),
  }
}

const server = await createLibp2p(libp2pConfig)
server.services.lanDHT.setMode("server")


// try {
//   const dht1Conn = await server.dial(multiaddr(dht1Ma))
//   if (dht1Conn) {
//     console.log('dialed dht1')
//   }
//   const dht2Conn = await server.dial(multiaddr(dht2Ma))
//   if (dht2Conn) {
//     console.log('dialed dht2')
//   }
// } catch (e) {
//   console.log('Error dialing dht peerspeer', e)
// }


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

const getStreams = () => {
  const connections = server.getConnections();

  return connections.reduce((accumulator, connection) => {
    // Ensure the connection has streams and a valid remotePeer
    if (connection.streams && connection.streams.length > 0 && connection.remotePeer) {
      const peerId = connection.remotePeer.toString();

      // Initialize the array for this peerId if it doesn't exist
      if (!accumulator[peerId]) {
        accumulator[peerId] = [];
      }

      // Map the streams to the desired format and append them to the peer's array
      const mappedStreams = connection.streams.map(stream => ({
        protocol: stream.protocol,
        direction: stream.direction
      }));

      accumulator[peerId].push(...mappedStreams);
    }

    return accumulator;
  }, {}); // Initialize accumulator as an empty object
};

// initial state
let topics = server.services.pubsub.getTopics()
let subscriberList = server.services.pubsub.getSubscribers(topic)
let pubsubPeerList = server.services.pubsub.getPeers()
let libp2pPeerList = await server.peerStore.all()
let meshPeerList = server.services.pubsub.getMeshPeers(topic)
let connectionList = server.getConnections()

let subscribers = subscriberList.map((peerId) => peerId.toString())
let pubsubPeers = pubsubPeerList.map((peerId) => peerId.toString())
let libp2pPeers = libp2pPeerList.map((peer) => peer.id.toString())
let meshPeers = meshPeerList.map((peer) => peer.toString())
let connections = connectionList.map((connection) => connection.remotePeer.toString())
let streams = getStreams()

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
        console.log(server.services.pubsub.dumpPeerScoreStats())
        break;
      case 'publish':
        message = newMessage.message
        try {
          server.services.pubsub.publish(topic, fromString(message))
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
    libp2pPeers,
    connections,
    streams,
    topics,
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
  const newStreams = getStreams()

  if (!isEqual(streams, newStreams)) {
    streams = newStreams
    streamsChanged = true;
  }

  let lastMessageChanged = false;
  if (lastMessage !== message) {
    lastMessage = message
    lastMessageChanged = true;
  }

  if (subscribersChanged || pubsubPeersChanged || libp2pPeersChanged || meshPeersChanged || connectionsChanged || streamsChanged || lastMessageChanged) {
    const updateData = {}

    if (subscribersChanged) {
      updateData.subscribers = subscribers
    }

    if (pubsubPeersChanged) {
      updateData.pubsubPeers = pubsubPeers
    }

    if (libp2pPeersChanged) {
      updateData.libp2pPeers = libp2pPeers
    }

    if (meshPeersChanged) {
      updateData.meshPeers = meshPeers
    }

    if (connectionsChanged) {
      updateData.connections = connections
    }

    if (streamsChanged) {
      updateData.streams = streams
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
