/* eslint-disable no-console */

import Fastify from 'fastify'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { webSockets } from '@libp2p/websockets'
import * as filters from '@libp2p/websockets/filters'
import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import { createLibp2p } from 'libp2p'
import { fromString } from 'uint8arrays'
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'

let topic = 'pubXXX-dev'
if (process.env.TOPIC !== undefined) {
  topic = process.env.TOPIC
}

const stringToDialable = (str) => {
  let mp

  try {
    mp = multiaddr(str)
    return mp
  } catch (_) {
    // ignore
  }

  try {
    mp = peerIdFromString(str)
    return mp
  } catch (_) {
    // ignore
  }

  throw new Error('invalid peerId or multiaddr')
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
    pubsubPeerDiscovery({
      listenOnly: false
    })
  ],
  services: {
    identify: identify(),
    pubsub: gossipsub({
      doPX: true,
      emitSelf: false,
    }),
  }
})

server.services.pubsub.subscribe(topic)

// server.services.pubsub.addEventListener('message', event => {
//   const topic = event.detail.topic
//   console.log(`Message received on topic '${topic}'`)
// })

server.addEventListener('peer:discovery', async (evt) => {
  const { multiaddrs, id } = evt.detail

  if (server.getConnections(id)?.length > 0) {
    console.log(`Already connected to peer %s. Will not try dialling`, id)
    return
  }

  for (const addr of multiaddrs) {
    try {
      console.log(`dialing multiaddr: %o`, addr)
      await server.dial(addr)
      return // if we succeed dialing the peer, no need to try another address
    } catch (error) {
      console.error(`failed to dial multiaddr: %o`, addr)
    }
  }
})

const fastify = Fastify({
  logger: true
})

fastify.get('/', async function handler (request, reply) {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Header", "*");
  reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");

  const peerList = server.services.pubsub.getSubscribers(topic)

  return { 
    peerId: server.peerId.toString(),
    peerList: peerList.map((peerId) => peerId.toString()),
    type: 'gossip'
  }
})

try {
  await fastify.listen({ host: '0.0.0.0', port: 80 })
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}

console.log('Gossip peer listening on multiaddr(s): ', server.getMultiaddrs().map((ma) => ma.toString()))

try {
  const conn = await server.dial(stringToDialable('/ip4/172.17.0.2/tcp/42069/ws/p2p/12D3KooWPqT2nMDSiXUSx5D7fasaxhxKigVhcqfkKqrLghCq9jxz'))
  console.log('Dialed peer: ', conn.remotePeer.toString())

  // setInterval(() => {
  //   const peerList = server.services.pubsub.getSubscribers(topic)
  //   console.log('Gossip Peers: ', peerList)
  // }, 1000)

  // setInterval(async () => {
  //   const res = await server.services.pubsub.publish(topic, fromString('hello world'))
  //   console.log('published message', res)
  // }, 5000)
} catch (err) {
  console.log(err)
}