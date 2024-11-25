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
import { peerIdFromString } from '@libp2p/peer-id'
import { kadDHT, removePublicAddressesMapper } from '@libp2p/kad-dht'
import { ping } from '@libp2p/ping'

let topic = 'pubXXX-dev'
if (process.env.TOPIC !== undefined) {
  topic = process.env.TOPIC
}

let dhtPrefix = 'local'
if (process.env.DHTPREFIX !== undefined) {
  dhtPrefix = process.env.dhtPrefix
}

const bootstrapper1PeerId = '12D3KooWJwYWjPLsTKiZ7eMjDagCZh9Fqt1UERLKoPb5QQNByrAF'
const bootstrapper1Ma = `/dns/bootstrapper1/tcp/42069/ws/p2p/${bootstrapper1PeerId}`

const bootstrapper2PeerId = '12D3KooWAfBVdmphtMFPVq3GEpcg3QMiRbrwD9mpd6D6fc4CswRw'
const bootstrapper2Ma = `/dns/bootstrapper2/tcp/42069/ws/p2p/${bootstrapper2PeerId}`

function applicationScore(p) {
  if (p === bootstrapper1PeerId || p === bootstrapper2PeerId) {
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
    // bootstrap({
    //   list: [bootstrapMa]
    // }),
    // pubsubPeerDiscovery()
  ],
  connectionManager: {
    maxConnections: 20,
  },
  services: {
    identify: identify(),
    ping: ping(),
    pubsub: gossipsub({
      D: 6,
      Dlo: 4,
      Dhi: 10,
      doPX: false,
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
    }),
    lanDHT: kadDHT({
      protocol: `/${dhtPrefix}/lan/kad/1.0.0`,
      clientMode: true
      // peerInfoMapper: removePublicAddressesMapper,
    }),
  }
})

console.log('Gossip peer listening on multiaddr(s): ', server.getMultiaddrs().map((ma) => ma.toString()))


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

  for (const addr of addrs) {
    // server.services.pubsub.addCandidate(evt.detail.id, addr)
  }
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
    meshPeers,
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

  // if (subscribersChanged || pubsubPeersChanged || libp2pPeersChanged || connectionsChanged || streamsChanged || lastMessageChanged) {
  //   // Prepare the data to send
  //   const updateData = {
  //     peerId,
  //     subscribers,
  //     pubsubPeers,
  //     libp2pPeers,
  //     meshPeers,
  //     connections,
  //     streams,
  //     topics: server.services.pubsub.getTopics(),
  //     type,
  //     lastMessage,
  //   };
  //
  //   // Send the data to all connected WebSocket clients
  //   wss.clients.forEach((ws) => {
  //     if (ws.readyState === ws.OPEN) {
  //       ws.send(JSON.stringify(updateData));
  //     }
  //   });
  // }

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


try {
  await server.dial(multiaddr(bootstrapper1Ma))
} catch (e) {
  console.log('Error dialing bootstrapper1 peer', e)
}
try {
  await server.dial(multiaddr(bootstrapper2Ma))
} catch (e) {
  console.log('Error dialing bootstrapper2 peer', e)
}

// connect to bootstrapper 1
setInterval(async () => {
  let hasBootstrapperConn = false

  server.getConnections(bootstrapper1PeerId).forEach(conn => {
    hasBootstrapperConn = true
  })

  if (!hasBootstrapperConn) {
    try {
      console.log('dialing bootstrapper1...')
      const bsConn = await server.dial(multiaddr(bootstrapper1Ma))
      if (!bsConn) {
        console.log('no connection')
        return
      }
      console.log('connected to bootstrapper1')
    } catch (e) {
      console.log(e)
    }
  }
}, 20_000)

// connect to bootstrapper 2
setInterval(async () => {
  let hasBootstrapperConn = false

  server.getConnections(bootstrapper2PeerId).forEach(conn => {
    hasBootstrapperConn = true
  })

  if (!hasBootstrapperConn) {
    try {
      console.log('dialing bootstrapper2...')
      const bsConn = await server.dial(multiaddr(bootstrapper2Ma))
      if (!bsConn) {
        console.log('no connection')
        return
      }
      console.log('connected to bootstrapper2')
    } catch (e) {
      console.log(e)
    }
  }
}, 20_000)

