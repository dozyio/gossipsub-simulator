import { Libp2p, PubSub } from '@libp2p/interface'
import { GossipsubEvents } from '@chainsafe/libp2p-gossipsub'
import { KadDHT } from '@libp2p/kad-dht'
import { Identify } from '@libp2p/identify'
import { PingService } from '@libp2p/ping'
import { Perf } from '@libp2p/perf'

export type Libp2pType = Libp2p<{
  identify: Identify
  ping: PingService
  pubsub: PubSub<GossipsubEvents>
  lanDHT: KadDHT
  perf: Perf
}>
