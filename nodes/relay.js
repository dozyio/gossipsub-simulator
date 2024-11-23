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

const bootstrapPeerId = '12D3KooWPqT2nMDSiXUSx5D7fasaxhxKigVhcqfkKqrLghCq9jxz'

function applicationScore(p) {
  if (p === bootstrapPeerId) {
    return 50
  }

  return 0
}

const pKey = await keys.generateKeyPairFromSeed('Ed25519', hexStringToUint8Array(seed))
const server = await createLibp2p({
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
  peerDiscovery: [
    pubsubPeerDiscovery()
  ],
  connectionManager: {
    maxConnections: Infinity
  },
  services: {
    identify: identify(),
    pubsub: gossipsub({
      doPX: true,
      emitSelf: false,
      scoreParams: {
        IPColocationFactorWeight: 0,
        behaviourPenaltyWeight: 0,
        appSpecificScore: applicationScore
      },
      scoreThresholds: {
        gossipThreshold: -4000,
        publishThreshold: -8000,
        graylistThreshold: -16000,
        acceptPXThreshold: 100,
        opportunisticGraftThreshold: 5,
      },
      D: 5,
      Dlo: 4,
      Dhi: 6,
    }),
    ping: ping(),
  }
})

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

let isAlive = true

const type = 'relay'
const peerId = server.peerId.toString()

// initial state
let topics = server.services.pubsub.getTopics()
let subscriberList = server.services.pubsub.getSubscribers(topic)
let pubsubPeerList = server.services.pubsub.getPeers()
let libp2pPeerList = await server.peerStore.all()
let connectionList = server.getConnections()

let subscribers = subscriberList.map((peerId) => peerId.toString())
let pubsubPeers = pubsubPeerList.map((peerId) => peerId.toString())
let libp2pPeers = libp2pPeerList.map((peer) => peer.id.toString())
let connections = connectionList.map((connection) => connection.remotePeer.toString())

const heartbeat = () => {
  isAlive = true;
}

const wss = new WebSocketServer({ host: '0.0.0.0', port: 80 });
wss.on('connection', function connection(ws) {
  ws.isAlive = true;
  ws.on('error', console.error);
  ws.on('pong', heartbeat);
  ws.on('message', function incoming(msg) {
    message = toString(msg)
    server.services.pubsub.publish(topic, fromString(message))
  });

  const updateData = {
    peerId,
    subscribers,
    pubsubPeers,
    libp2pPeers,
    connections,
    topics,
    type,
    lastMessage,
  };

  ws.send(JSON.stringify(updateData));
});

const interval = setInterval(function ping() {
  wss.clients.forEach(function each(ws) {
    if (ws.isAlive === false) return ws.terminate();

    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', function close() {
  clearInterval(interval);
});


setInterval(async() => {
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

  let connectionsChanged = false;
  const newConnectionsList = server.getConnections()
  const newConnections = newConnectionsList.map((connection) => connection.remotePeer.toString())

  if (!isEqual(connections, newConnections)) {
    connections = newConnections
    connectionsChanged = true;
  }

  let lastMessageChanged = false;
  if (lastMessage !== message) {
    lastMessage = message
    lastMessageChanged = true;
  }

  if (subscribersChanged || pubsubPeersChanged || libp2pPeersChanged || connectionsChanged || lastMessageChanged) {
    // Prepare the data to send
    const updateData = {
      peerId,
      subscribers,
      pubsubPeers,
      libp2pPeers,
      connections,
      topics: server.services.pubsub.getTopics(),
      type,
      lastMessage
    };

    // Send the data to all connected WebSocket clients
    wss.clients.forEach((ws) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(updateData));
      }
    });
  }
}, 100)

console.log('Relay listening on multiaddr(s): ', server.getMultiaddrs().map((ma) => ma.toString()))

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
