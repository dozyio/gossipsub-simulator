/* eslint-disable no-console */

import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { identify } from '@libp2p/identify'
import { webSockets } from '@libp2p/websockets'
import { keys } from '@libp2p/crypto'
import * as filters from '@libp2p/websockets/filters'
import { createLibp2p } from 'libp2p'

const trim0x = (x) => {
  return x.startsWith('0x') ? x.slice(2) : x
}

const hexStringToUint8Array = (hexString) => {
  hexString = trim0x(hexString)

  // Ensure the hex string length is even
  if (hexString.length % 2 !== 0) {
    console.warn('Hex string has an odd length, adding leading 0')
    hexString = `0${hexString}`
  }

  // Convert each hex pair to a byte
  const byteArray = new Uint8Array(hexString.length / 2)

  for (let i = 0; i < hexString.length; i += 2) {
    const byte = parseInt(hexString.substring(i, i + 2), 16)

    byteArray[i / 2] = byte
  }

  return byteArray
}

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
  services: {
    identify: identify(),
    relay: circuitRelayServer({
      reservations: {
        maxReservations: Infinity
      }
    }),
    pubsub: gossipsub({
      doPX: true,
    }),
  }
})

server.services.pubsub.subscribe(topic)
console.log('Relay listening on multiaddr(s): ', server.getMultiaddrs().map((ma) => ma.toString()))

