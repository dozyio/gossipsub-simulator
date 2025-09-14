package consts

const (
	AppName             = "go-bootstrapper"
	bootstrapper1Ma     = "/dns/bootstrapper1/tcp/42069/p2p/12D3KooWJwYWjPLsTKiZ7eMjDagCZh9Fqt1UERLKoPb5QQNByrAF"
	bootstrapper1PeerId = "12D3KooWJwYWjPLsTKiZ7eMjDagCZh9Fqt1UERLKoPb5QQNByrAF"
	bootstrapper2Ma     = "/dns/bootstrapper2/tcp/42069/p2p/12D3KooWAfBVdmphtMFPVq3GEpcg3QMiRbrwD9mpd6D6fc4CswRw"
	bootstrapper2PeerId = "12D3KooWAfBVdmphtMFPVq3GEpcg3QMiRbrwD9mpd6D6fc4CswRw"
	GossipTopic         = "pubXXX-dev"
	GossipPeerWeight    = 20
	GossipD             = 0
	GossipDLO           = 0
	GossipDHI           = 0
	GossipDOut          = 0
	GossipDScore        = 0
)

var (
	BootstrappersMa     = []string{bootstrapper1Ma, bootstrapper2Ma}
	BootstrappersPeerId = []string{bootstrapper1PeerId, bootstrapper2PeerId}
)
