import { Libp2p } from '@libp2p/interface'
import { Perf } from '@libp2p/perf'

export type Libp2pType = Libp2p<{
  perf: Perf
}>
