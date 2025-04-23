/* eslint-disable no-console */

import { GossipsubOpts, gossipsub } from '@chainsafe/libp2p-gossipsub'
import { Ed25519PrivateKey } from '@libp2p/interface'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { tcp } from '@libp2p/tcp'
import { Libp2pOptions, createLibp2p } from 'libp2p'
import { applicationScore, generateKeyPair, removePublicAddressesLoopbackAddressesMapper } from './helpers.js'
import { ping } from '@libp2p/ping'
import { multiaddr } from '@multiformats/multiaddr'
import { kadDHT } from '@libp2p/kad-dht'
import { peerIdFromString } from '@libp2p/peer-id'
import { StatusServer } from './status-server.js'
import {
  acceptPXScoreThreshold,
  bootstrapper1Ma,
  bootstrapper1PeerId,
  bootstrapper2Ma,
  bootstrapper2PeerId,
  firstMessageDeliveriesCap,
  firstMessageDeliveriesDecay,
  firstMessageDeliveriesWeight,
  gossipScoreThreshold,
  graylistScoreThreshold,
  opportunisticGraftScoreThreshold,
  publishScoreThreshold,
  timeInMeshCap,
  timeInMeshQuantum,
  timeInMeshWeight,
  topicScoreCap,
  topicWeight,
} from './consts.js'
import { Libp2pType } from './types.js'
import {
  createPeerScoreParams,
  createTopicScoreParams,
  defaultTopicScoreParams,
} from '@chainsafe/libp2p-gossipsub/score'
import { perf } from '@libp2p/perf'
import { plaintext } from '@libp2p/plaintext'
;(async () => {
  try {
    let seed = '0x1111111111111111111111111111111111111111111111111111111111111111'
    if (process.env.SEED !== undefined) {
      seed = process.env.SEED
    }

    let port = '42069'
    if (process.env.PORT !== undefined) {
      port = process.env.PORT
    }

    let topics: string[] = []
    if (process.env.TOPICS !== undefined) {
      topics = process.env.TOPICS.split(',')
    } else {
      console.log('TOPICS env not set')
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

    let encrypters = 'noise'
    if (process.env.DISABLE_NOISE !== undefined) {
      encrypters = 'plaintext'
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
      globalSignaturePolicy: 'StrictSign',
      allowPublishToZeroTopicPeers: true, // don't throw if no peers
      scoreParams: createPeerScoreParams({
        // P5
        appSpecificScore: applicationScore,

        // P6
        IPColocationFactorWeight: 0,
        IPColocationFactorThreshold: 0,
        IPColocationFactorWhitelist: new Set<string>(),

        // P7
        behaviourPenaltyWeight: 0,
        behaviourPenaltyThreshold: 0,
        behaviourPenaltyDecay: 0,

        topicScoreCap: topicScoreCap,

        topics: topics.reduce(
          (acc, topic) => {
            acc[topic] = createTopicScoreParams({
              topicWeight: topicWeight,

              // P1
              timeInMeshWeight: timeInMeshWeight,
              timeInMeshQuantum: timeInMeshQuantum,
              timeInMeshCap: timeInMeshCap,

              // P2
              firstMessageDeliveriesWeight: firstMessageDeliveriesWeight,
              firstMessageDeliveriesDecay: firstMessageDeliveriesDecay,
              firstMessageDeliveriesCap: firstMessageDeliveriesCap,

              // P3
              meshMessageDeliveriesWeight: 0,
              // meshMessageDeliveriesDecay: 0,
              // meshMessageDeliveriesCap: 0,
              // meshMessageDeliveriesThreshold: 0,
              // meshMessageDeliveriesWindow: 0,
              // meshMessageDeliveriesActivation: 0,

              // P3b
              meshFailurePenaltyWeight: 0,
              // meshFailurePenaltyDecay: 0,

              // P4
              invalidMessageDeliveriesWeight: 0,
              // invalidMessageDeliveriesDecay: 0,
            })
            return acc
          },
          {} as Record<string, ReturnType<typeof createTopicScoreParams>>,
        ), // Map topics to params
      }),
      scoreThresholds: {
        gossipThreshold: gossipScoreThreshold,
        publishThreshold: publishScoreThreshold,
        graylistThreshold: graylistScoreThreshold,
        acceptPXThreshold: acceptPXScoreThreshold,
        opportunisticGraftThreshold: opportunisticGraftScoreThreshold,
      },
      directConnectTicks: 30,
      // directConnectInitialDelay: 500,
    }

    // Configure direct peers based on seed
    if (seed === '0xddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd1') {
      gossipsubConfig.directPeers = [
        {
          id: peerIdFromString(bootstrapper2PeerId),
          addrs: [multiaddr(bootstrapper2Ma)],
        },
      ]
    }
    if (seed === '0xddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd2') {
      gossipsubConfig.directPeers = [
        {
          id: peerIdFromString(bootstrapper1PeerId),
          addrs: [multiaddr(bootstrapper1Ma)],
        },
      ]
    }

    // Configure Libp2p
    const libp2pConfig: Libp2pOptions = {
      privateKey: pKey,
      addresses: {
        listen: [`/ip4/0.0.0.0/tcp/${port}`],
      },
      transports: [
        tcp({
          maxConnections: 500,
          backlog: 30,
        }),
      ],
      // connectionEncrypters: [noise()],
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
        perf: perf(),
        pubsub: gossipsub(gossipsubConfig),
        lanDHT: kadDHT({
          protocol: `/${dhtPrefix}/lan/kad/1.0.0`,
          clientMode: false,
          peerInfoMapper: removePublicAddressesLoopbackAddressesMapper,
          // allowQueryWithZeroPeers: true,
          // initialQuerySelfInterval: 0,
          // networkDialTimeout: {
          //   minTimeout: 10_000,
          // }
        }),
      },
    }

    if (encrypters === 'noise') {
      libp2pConfig.connectionEncrypters = [noise()]
    } else {
      libp2pConfig.connectionEncrypters = [plaintext()]
    }

    // Create Libp2p instance
    const server: Libp2pType = (await createLibp2p(libp2pConfig)) as Libp2pType

    // Set DHT mode
    await server.services.lanDHT.setMode('server')

    // Subscribe to topic
    for (let i = 0; i < topics.length; i++) {
      server.services.pubsub.subscribe(topics[i])
    }

    // Initialize StatusServer
    const type = 'bootstrapper'
    const statusServer = new StatusServer(server, type, topics, 0) // TODO perfBytes

    // // Listen for pubsub messages
    // server.services.pubsub.addEventListener('message', (evt) => {
    //   if (evt.detail.topic !== topic) {
    //     return
    //   }
    //
    //   statusServer.message = toString(evt.detail.data)
    // })

    console.log(
      'Bootstrapper listening on multiaddr(s): ',
      server.getMultiaddrs().map((ma) => ma.toString()),
    )

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
