/* eslint-disable no-console */

import { GossipSub, gossipsub } from '@chainsafe/libp2p-gossipsub'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { webSockets } from '@libp2p/websockets'
import { tcp } from '@libp2p/tcp'
import * as filters from '@libp2p/websockets/filters'
import { createLibp2p } from 'libp2p'
import { kadDHT } from '@libp2p/kad-dht'
import { ping } from '@libp2p/ping'
import { applicationScore, removePublicAddressesLoopbackAddressesMapper } from './helpers.js'
import { Libp2pType } from './types.js'
import { StatusServer } from './status-server.js'
import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import { acceptPXScoreThreshold, bootstrapper1Ma, bootstrapper1PeerId, bootstrapper2Ma, bootstrapper2PeerId, firstMessageDeliveriesCap, firstMessageDeliveriesDecay, firstMessageDeliveriesWeight, gossipScoreThreshold, graylistScoreThreshold, opportunisticGraftScoreThreshold, publishScoreThreshold, timeInMeshCap, timeInMeshQuantum, timeInMeshWeight, topicScoreCap, topicWeight } from './consts.js'
import { createPeerScoreParams, createTopicScoreParams } from '@chainsafe/libp2p-gossipsub/score'
import { perf } from '@libp2p/perf'

(async () => {
  try {
    let topics: string[] = []
    if (process.env.TOPICS !== undefined) {
      topics = process.env.TOPICS.split(",")
    } else {
      console.log("TOPICS env not set")
    }

    let perfBytes = 0
    if (process.env.PERF !== undefined) {
      perfBytes = Number(process.env.PERF)
    }


    let dhtPrefix = 'local'
    if (process.env.DHTPREFIX !== undefined) {
      dhtPrefix = process.env.DHTPREFIX
    }

    let D = 8
    if (process.env.GOSSIP_D !== undefined) {
      D = parseInt(process.env.GOSSIP_D)
    }

    let DLO = 6
    if (process.env.GOSSIP_DLO !== undefined) {
      DLO = parseInt(process.env.GOSSIP_DLO)
    }

    let DHI = 12
    if (process.env.GOSSIP_DHI !== undefined) {
      DHI = parseInt(process.env.GOSSIP_DHI)
    }

    let DOUT = 2
    if (process.env.GOSSIP_DOUT !== undefined) {
      DOUT = parseInt(process.env.GOSSIP_DOUT)
    }

    // Configure Libp2p
    const libp2pConfig = {
      addresses: {
        listen: [`/ip4/0.0.0.0/tcp/0`],
      },
      transports: [
        webSockets({
          filter: filters.all
        }),
        tcp(),
      ],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      // peerDiscovery: [
      //   // Uncomment and configure if peer discovery is needed
      //   // bootstrap({
      //   //   list: [bootstrapMa]
      //   // }),
      //   // pubsubPeerDiscovery()
      // ],
      connectionManager: {
        maxConnections: 20,
      },
      services: {
        identify: identify(),
        ping: ping(),
        perf: perf(),
        pubsub: gossipsub({
          D: D,
          Dlo: DLO,
          Dhi: DHI,
          Dout: DOUT,
          doPX: false,
          emitSelf: false,
          globalSignaturePolicy: 'StrictSign',
          allowPublishToZeroTopicPeers: true, // don't throw if no peers
          pruneBackoff: 60 * 1000,
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

            topics: topics.reduce((acc, topic) => {
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
              });
              return acc;
            }, {} as Record<string, ReturnType<typeof createTopicScoreParams>>), // Map topics to params
          }),
          scoreThresholds: {
            gossipThreshold: gossipScoreThreshold,
            publishThreshold: publishScoreThreshold,
            graylistThreshold: graylistScoreThreshold,
            acceptPXThreshold: acceptPXScoreThreshold,
            opportunisticGraftThreshold: opportunisticGraftScoreThreshold,
          },
        }),
        lanDHT: kadDHT({
          protocol: `/${dhtPrefix}/lan/kad/1.0.0`,
          // clientMode: true,
          peerInfoMapper: removePublicAddressesLoopbackAddressesMapper,
        }),
      }
    }

    // Create Libp2p instance
    const server: Libp2pType = await createLibp2p(libp2pConfig) as Libp2pType

    // Subscribe to topic
    for (let i = 0; i < topics.length; i++) {
      server.services.pubsub.subscribe(topics[i])
    }


    // Initialize StatusServer
    const type = 'gossip'
    const statusServer = new StatusServer(server, type, topics, perfBytes)

    console.log('Gossip peer listening on multiaddr(s): ', server.getMultiaddrs().map((ma) => ma.toString()))

    try {
      await server.dial(multiaddr(bootstrapper1Ma), { signal: AbortSignal.timeout(10_000) })
    } catch (e) {
      console.log('Error dialing bootstrapper1 peer', e)
    }
    try {
      await server.dial(multiaddr(bootstrapper2Ma), { signal: AbortSignal.timeout(10_000) })
    } catch (e) {
      console.log('Error dialing bootstrapper2 peer', e)
    }

    // refresh peers via bootstrapper 1
    setInterval(async () => {
      if ((server.services.pubsub as GossipSub).getMeshPeers.length >= (server.services.pubsub as GossipSub).opts.D) {
        return
      }

      let hasBootstrapperConn = false

      server.getConnections(peerIdFromString(bootstrapper1PeerId)).forEach(conn => {
        hasBootstrapperConn = true
      })

      if (!hasBootstrapperConn) {
        try {
          console.log('dialing bootstrapper1...')
          const bsConn = await server.dial(multiaddr(bootstrapper1Ma), { signal: AbortSignal.timeout(5_000) })
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

    // refresh peers via bootstrapper 2
    setInterval(async () => {
      if ((server.services.pubsub as GossipSub).getMeshPeers.length >= (server.services.pubsub as GossipSub).opts.D) {
        return
      }
      let hasBootstrapperConn = false

      server.getConnections(peerIdFromString(bootstrapper2PeerId)).forEach(conn => {
        hasBootstrapperConn = true
      })

      if (!hasBootstrapperConn) {
        try {
          console.log('dialing bootstrapper2...')
          const bsConn = await server.dial(multiaddr(bootstrapper2Ma), { signal: AbortSignal.timeout(5_000) })
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
