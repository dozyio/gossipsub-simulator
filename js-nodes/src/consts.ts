// js bootstrapper 1
//'0xddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd1'
export const bootstrapper1PeerId = '12D3KooWJwYWjPLsTKiZ7eMjDagCZh9Fqt1UERLKoPb5QQNByrAF'
export const bootstrapper1Ma = `/dns/bootstrapper1/tcp/42069/p2p/${bootstrapper1PeerId}`

// js bootstrapper 2
//'0xddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd2'
export const bootstrapper2PeerId = '12D3KooWAfBVdmphtMFPVq3GEpcg3QMiRbrwD9mpd6D6fc4CswRw'
export const bootstrapper2Ma = `/dns/bootstrapper2/tcp/42069/p2p/${bootstrapper2PeerId}`

// go bootstrapper 3
//'0xddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd3'
export const bootstrapper3PeerId = '12D3KooWD6d3jiuv2fuSDTBH2eWZN8aYYKzHTrquZF4dta1BYEgB'
export const bootstrapper3Ma = `/dns/bootstrapper3/tcp/42069/p2p/${bootstrapper3PeerId}`

export const topicScoreCap = 50
export const topicWeight = 1

// P1
export const timeInMeshQuantum = 1 * 1000 //  10 second
export const timeInMeshCap = 3
export const timeInMeshWeight = 0.1

// P2
export const firstMessageDeliveriesDecay = 0.9
export const firstMessageDeliveriesCap = 5
export const firstMessageDeliveriesWeight = 1

export const gossipScoreThreshold = -500
export const publishScoreThreshold = -1000
export const graylistScoreThreshold = -2500
export const acceptPXScoreThreshold = 1000
export const opportunisticGraftScoreThreshold = 3.5
