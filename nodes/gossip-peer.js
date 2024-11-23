/* eslint-disable no-console */

import { WebSocketServer } from 'ws';
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { webSockets } from '@libp2p/websockets'
import * as filters from '@libp2p/websockets/filters'
import { createLibp2p } from 'libp2p'
import { fromString, toString } from 'uint8arrays'
import { bootstrap } from '@libp2p/bootstrap'
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'
import { isEqual, stringToDialable } from './helpers.js'
import { multiaddr } from '@multiformats/multiaddr'
import { ping } from '@libp2p/ping'

let topic = 'pubXXX-dev'
if (process.env.TOPIC !== undefined) {
  topic = process.env.TOPIC
}

const bootstrapMa = multiaddr('/ip4/172.17.0.2/tcp/42069/ws/p2p/12D3KooWPqT2nMDSiXUSx5D7fasaxhxKigVhcqfkKqrLghCq9jxz')
const bootstrapPeerId = '12D3KooWPqT2nMDSiXUSx5D7fasaxhxKigVhcqfkKqrLghCq9jxz'

function applicationScore(p) {
  if (p === bootstrapPeerId) {
    return 150
  }

  return 0
}

const server = await createLibp2p({
  addresses: {
    listen: [`/ip4/0.0.0.0/tcp/0/ws`]
  },
  transports: [
    webSockets({
      filter: filters.all
    })
  ],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  peerDiscovery: [
    bootstrap({
      list: [bootstrapMa]
    }),
    pubsubPeerDiscovery()
  ],
  // peerDiscovery: [
  //   pubsubPeerDiscovery({
  //     listenOnly: false
  //   })
  // ],
  connectionManager: {
    maxConnections: 6,
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
    ping: ping()
  }
})

let lastMessage = '' 
let message = ''

server.services.pubsub.addEventListener('message', (evt) => {
  if (evt.detail.topic !== topic) {
    // ignore messages on other topics
    return
  }

  message = toString(evt.detail.data)
})


server.services.pubsub.subscribe(topic)

// server.services.pubsub.addCandidate(bootstrapPeerId, bootstrapMa)

server.addEventListener('peer:discovery', async (evt) => {
  if (!evt.detail.multiaddrs) {
    // throw new Error('no multiaddrs set', evt.detail.id.toString())
    // console.log('no multiaddrs')
    return
  }

  if (evt.detail.multiaddrs.length === 0) {
    // throw new Error('no multiaddrs length 0', evt.detail.id.toString())
    // console.log('no multiaddrs')
    return
  }

  const addrs = evt.detail.multiaddrs.filter((ma) => {
    if (ma.toString().includes('127.0.0.1')) {
      return
    }
    return ma
  })

  if (addrs.length === 0) {
    return
  }

  // for (const addr of addrs) {
  //   server.services.pubsub.addCandidate(evt.detail.id, addr)
  // }
})

// server.services.pubsub.addEventListener('gossipsub:heartbeat', async (evt) => {
//   console.log('gossip heartbeat', evt.detail)
// })

// server.services.pubsub.addEventListener('gossipsub:graft', async (evt) => {
//   // ignore graft to relay
//   if (evt.detail.peerId === '12D3KooWPqT2nMDSiXUSx5D7fasaxhxKigVhcqfkKqrLghCq9jxz') {
//     return
//   }
//
//   console.log('gossip gossip:graft', evt.detail)
// })

// server.services.pubsub.addEventListener('gossipsub:prune', async (evt) => {
//   // ignore graft to relay
//   if (evt.detail.peerId === '12D3KooWPqT2nMDSiXUSx5D7fasaxhxKigVhcqfkKqrLghCq9jxz') {
//     return
//   }
//   console.log('gossip gossip:prune', evt.detail)
// })

// server.services.pubsub.addEventListener('gossipsub:message', async (evt) => {
//   console.log('relay gossip:message', evt.detail)
// })

let isAlive = true

const type = 'gossip'
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
      lastMessage,
    };

    // Send the data to all connected WebSocket clients
    wss.clients.forEach((ws) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(updateData));
      }
    });
  }
}, 100)

console.log('Gossip peer listening on multiaddr(s): ', server.getMultiaddrs().map((ma) => ma.toString()))

// try {
//   const conn = await server.dial(stringToDialable('/ip4/172.17.0.2/tcp/42069/ws/p2p/12D3KooWPqT2nMDSiXUSx5D7fasaxhxKigVhcqfkKqrLghCq9jxz'))
//   console.log('Dialed peer: ', conn.remotePeer.toString())
//
// } catch (err) {
//   console.log(err)
// }

// setInterval(() => {
//   server.services.pubsub.publish(topic, fromString('Hello world'))
// }, 5000)

// setInterval(async () => {
//   const allPeers = await server.peerStore.all()
//
//   allPeers.forEach(peer => {
//     console.log('peerstore', peer.id.toString(), peer.tags.get('pubXXX-dev'))
//   })
// }, 1000)

// let hasSetBootstrapScore = false
// setInterval(async () => {
//   try {
//   if (!hasSetBootstrapScore) {
//     if (server.services.pubsub.score.score(bootstrapPeerId) > 0) {
//       hasSetBootstrapScore = true
//     } else {
//       server.services.pubsub.score.addPenalty(bootstrapPeerId, 100, 'bootstrap')
//     }
//   }
//   } catch (e) {
//     console.log(e)
//   }
//   console.log(server.services.pubsub.score.dumpPeerScoreStats())
// }, 1000)


// setInterval(async () => {
//   console.log(server.services.pubsub.dumpPeerScoreStats())
// }, 5000)
