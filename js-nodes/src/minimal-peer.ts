/* eslint-disable no-console */

import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { tcp } from '@libp2p/tcp'
import { createLibp2p, Libp2pOptions } from 'libp2p'
import { Libp2pType } from './types.js'
import { StatusServer } from './status-server.js'
import { perf } from '@libp2p/perf'
import { plaintext } from '@libp2p/plaintext'

(async () => {
  try {
    let perfBytes = 0
    if (process.env.PERF !== undefined) {
      perfBytes = Number(process.env.PERF)
    }

    let encrypters = "noise"
    if (process.env.DISABLE_NOISE !== undefined) {
      encrypters = "plaintext"
    }

    // Configure Libp2p
    const libp2pConfig: Libp2pOptions = {
      addresses: {
        listen: [`/ip4/0.0.0.0/tcp/0`],
      },
      transports: [
        tcp(),
      ],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: {
        perf: perf(),
      }
    }

    if (encrypters === "noise") {
      libp2pConfig.connectionEncrypters = [noise()]
    } else {
      libp2pConfig.connectionEncrypters = [plaintext()]
    }

    // Create Libp2p instance
    const server: Libp2pType = await createLibp2p(libp2pConfig) as Libp2pType

    // Initialize StatusServer
    const type = 'gossip'
    const statusServer = new StatusServer(server, type, [], perfBytes)

    console.log('Gossip peer listening on multiaddr(s): ', server.getMultiaddrs().map((ma) => ma.toString()))

    const shutdown = async () => {
      // console.log('Shutting down Libp2p...')
      // await server.stop()
      process.exit(0)
    }

    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)

  } catch (error) {
    console.error('An error occurred during initialization:', error)
    process.exit(1)
  }
})()
