/* eslint-disable no-console */

import { GossipsubOpts, gossipsub } from '@chainsafe/libp2p-gossipsub'
import { Ed25519PrivateKey } from '@libp2p/interface'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { tcp } from '@libp2p/tcp'
import { Libp2pOptions, createLibp2p } from 'libp2p'
import { applicationScore, generateKeyPair, removePublicAddressesLoopbackAddressesMapper } from './helpers'
import { ping } from '@libp2p/ping'
import { toString } from 'uint8arrays'
import { multiaddr } from '@multiformats/multiaddr'
import { kadDHT } from '@libp2p/kad-dht'
import { peerIdFromString } from '@libp2p/peer-id'
import { StatusServer } from './status-server'
import { bootstrapper1Ma, bootstrapper1PeerId, bootstrapper2Ma, bootstrapper2PeerId } from './consts'
import { Libp2pType } from './types'
import { createPeerScoreParams, createTopicScoreParams, defaultTopicScoreParams } from '@chainsafe/libp2p-gossipsub/score'

(async () => {
  try {
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
      dhtPrefix = process.env.DHTPREFIX
    }

    // Recommend setting D settings to 0 for bootstrapper
    // https://github.com/libp2p/specs/blob/master/pubsub/gossipsub/gossipsub-v1.1.md#recommendations-for-network-operators

    let D = 0
    if (process.env.GOSSIP_D !== undefined) {
      D = parseInt(process.env.GOSSIP_D)
    }

    let DLO = 0
    if (process.env.GOSSIP_DLO !== undefined) {
      DLO = parseInt(process.env.GOSSIP_DLO)
    }

    let DHI = 0
    if (process.env.GOSSIP_DHI !== undefined) {
      DHI = parseInt(process.env.GOSSIP_DHI)
    }

    let DOUT = 0
    if (process.env.GOSSIP_DOUT !== undefined) {
      DOUT = parseInt(process.env.GOSSIP_DOUT)
    }

    // Generate key pair
    const pKey: Ed25519PrivateKey = await generateKeyPair(seed)

    // Configure Gossipsub
    const gossipsubConfig: Partial<GossipsubOpts> = {
      enabled: true,
      D: D,
      Dlo: DLO,
      Dhi: DHI,
      Dout: DOUT,
      doPX: true,
      emitSelf: false,
      allowPublishToZeroTopicPeers: true, // don't throw if no peers
      scoreParams: createPeerScoreParams({
        appSpecificScore: applicationScore,
        topicScoreCap: 50,
        topics: {
          [topic]: createTopicScoreParams({
            topicWeight: 1,
            firstMessageDeliveriesWeight: 20,
            firstMessageDeliveriesDecay: 0.9,
            firstMessageDeliveriesCap: 50,
          })
        }
      }),
      scoreThresholds: {
        gossipThreshold: -10,
        publishThreshold: -50,
        graylistThreshold: -80,
        acceptPXThreshold: 100,
        opportunisticGraftThreshold: 20,
      },
      directConnectTicks: 30,
      // directConnectInitialDelay: 500,
    }

    // Configure direct peers based on seed
    if (seed === '0xddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd1') {
      gossipsubConfig.directPeers = [
        {
          id: peerIdFromString(bootstrapper2PeerId),
          addrs: [multiaddr(bootstrapper2Ma)]
        },
      ]
    }
    if (seed === '0xddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd2') {
      gossipsubConfig.directPeers = [
        {
          id: peerIdFromString(bootstrapper1PeerId),
          addrs: [multiaddr(bootstrapper1Ma)]
        },
      ]
    }

    // Configure Libp2p
    const libp2pConfig: Libp2pOptions = {
      privateKey: pKey,
      addresses: {
        listen: [
          `/ip4/0.0.0.0/tcp/${port}`,
        ]
      },
      transports: [
        tcp({
          maxConnections: 500,
          backlog: 30,
        })
      ],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      // peerDiscovery: [
      //   pubsubPeerDiscovery()
      // ],
      connectionManager: {
        maxConnections: 500,
        maxIncomingPendingConnections: 30,
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
          // networkDialTimeout: {
          //   minTimeout: 10_000,
          // }
        }),
      }
    }

    // Create Libp2p instance
    const server: Libp2pType = await createLibp2p(libp2pConfig) as Libp2pType

    // Set DHT mode
    await server.services.lanDHT.setMode("server")

    // Subscribe to topic
    server.services.pubsub.subscribe(topic)

    // Initialize StatusServer
    const type = 'bootstrapper'
    const statusServer = new StatusServer(server, type, topic)

    // // Listen for pubsub messages
    // server.services.pubsub.addEventListener('message', (evt) => {
    //   if (evt.detail.topic !== topic) {
    //     return
    //   }
    //
    //   statusServer.message = toString(evt.detail.data)
    // })

    console.log('Bootstrapper listening on multiaddr(s): ', server.getMultiaddrs().map((ma) => ma.toString()))

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
