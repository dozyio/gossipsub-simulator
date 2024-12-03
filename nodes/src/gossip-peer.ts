/* eslint-disable no-console */

import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { webSockets } from '@libp2p/websockets'
import { tcp } from '@libp2p/tcp'
import * as filters from '@libp2p/websockets/filters'
import { createLibp2p } from 'libp2p'
import { toString } from 'uint8arrays'
import { kadDHT, removePublicAddressesMapper } from '@libp2p/kad-dht'
import { ping } from '@libp2p/ping'
import { applicationScore } from './helpers'
import { Libp2pType } from './types'
import { StatusServer } from './status-server'
import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import { bootstrapper1Ma, bootstrapper1PeerId, bootstrapper2Ma, bootstrapper2PeerId } from './consts'
import { createPeerScoreParams, createTopicScoreParams, defaultTopicScoreParams } from '@chainsafe/libp2p-gossipsub/score'

(async () => {
  try {
    let topic = 'pubXXX-dev'
    if (process.env.TOPIC !== undefined) {
      topic = process.env.TOPIC
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
        pubsub: gossipsub({
          D: D,
          Dlo: DLO,
          Dhi: DHI,
          doPX: false,
          emitSelf: false,
          allowPublishToZeroTopicPeers: true, // don't throw if no peers
          scoreParams: createPeerScoreParams({
            // IPColocationFactorWeight: 0,
            // behaviourPenaltyWeight: 0,
            appSpecificScore: applicationScore,
            topics: {
              [topic]: createTopicScoreParams({
                topicWeight: 1
              })
            }
          }),
          scoreThresholds: {
            // gossipThreshold: -4000,
            // publishThreshold: -8000,
            // graylistThreshold: -16000,
            gossipThreshold: -10,
            publishThreshold: -50,
            graylistThreshold: -80,
            acceptPXThreshold: 100,
            opportunisticGraftThreshold: 5,
          }
        }),
        lanDHT: kadDHT({
          protocol: `/${dhtPrefix}/lan/kad/1.0.0`,
          clientMode: true,
          peerInfoMapper: removePublicAddressesMapper,
        }),
      }
    }

    // Create Libp2p instance
    const server: Libp2pType = await createLibp2p(libp2pConfig) as Libp2pType

    // Subscribe to topic
    server.services.pubsub.subscribe(topic)

    // Initialize StatusServer
    const type = 'gossip'
    const statusServer = new StatusServer(server, type, topic)

    // // Listen for pubsub messages
    // server.services.pubsub.addEventListener('message', (evt) => {
    //   if (evt.detail.topic !== topic) {
    //     return
    //   }
    //
    //   statusServer.message = toString(evt.detail.data)
    // })

    console.log('Gossip peerlistening on multiaddr(s): ', server.getMultiaddrs().map((ma) => ma.toString()))

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

    // reconnect to bootstrapper 1 - refresh peers
    setInterval(async () => {
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

    // reconnect to bootstrapper 2 - refresh peers
    setInterval(async () => {
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
