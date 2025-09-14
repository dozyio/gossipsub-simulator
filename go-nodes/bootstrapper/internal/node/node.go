package node

import (
	"context"
	"fmt"

	"github.com/dozyio/gossipsub-simulator/go-nodes/bootstrapper/internal/config"
	"github.com/dozyio/gossipsub-simulator/go-nodes/bootstrapper/internal/interfaces"
	"github.com/ipfs/boxo/blockservice"
	"github.com/ipfs/boxo/blockstore"
	exchange "github.com/ipfs/boxo/exchange"
	datastore "github.com/ipfs/go-datastore"
	logging "github.com/ipfs/go-log/v2"
	"github.com/libp2p/go-libp2p"
	dht "github.com/libp2p/go-libp2p-kad-dht"
	pubsub "github.com/libp2p/go-libp2p-pubsub"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/routing"
	"github.com/libp2p/go-libp2p/core/sec/insecure"
	"github.com/libp2p/go-libp2p/p2p/muxer/yamux"
	"github.com/libp2p/go-libp2p/p2p/security/noise"
)

type Node struct {
	Host             host.Host
	DHT              routing.Routing
	DS               datastore.Batching
	BS               blockstore.Blockstore
	BServ            blockservice.BlockService
	exch             exchange.Interface
	Log              logging.EventLogger
	Topic            *pubsub.Topic
	TopicRelayCancel pubsub.RelayCancelFunc
	TopicSub         *pubsub.Subscription
}

func New(
	ctx context.Context,
	cfg *config.Config,
	privKey crypto.PrivKey,
	pubKey crypto.PubKey,
	ds datastore.Batching,
	logger logging.EventLogger,
) (*Node, error) {
	ipv4Addrs, ipv6Addrs := interfaces.GetAddresses()

	listen := []string{}
	for _, addr := range ipv4Addrs {
		listen = append(listen, fmt.Sprintf("/ip4/%s/tcp/%d", addr, cfg.Port))
	}

	for _, addr := range ipv6Addrs {
		listen = append(listen, fmt.Sprintf("/ip6/%s/tcp/%d", addr, cfg.Port))
	}

	opts := []libp2p.Option{
		libp2p.Identity(privKey),
		libp2p.ListenAddrStrings(listen...),
		libp2p.Ping(true),
		libp2p.Muxer(yamux.ID, yamux.DefaultTransport),
	}

	if cfg.DisableNoise {
		peerID, err := peer.IDFromPublicKey(pubKey)
		if err != nil {
			panic(err)
		}
		opts = append(opts, libp2p.Security(insecure.ID, insecure.NewWithIdentity(insecure.ID, peerID, privKey)))
	} else {
		opts = append(opts, libp2p.Security(noise.ID, noise.New))
	}

	// start libp2p host
	h, err := libp2p.New(opts...)
	if err != nil {
		return nil, err
	}

	dhtOpts := []dht.Option{
		dht.Mode(dht.ModeServer),
		dht.ProtocolExtension("/lan"),
	}

	hDHT, err := dht.New(ctx, h, dhtOpts...)
	if err != nil {
		return nil, err
	}

	node := &Node{
		Host:             h,
		DHT:              hDHT,
		DS:               ds,
		Log:              logger,
		Topic:            &pubsub.Topic{},
		TopicRelayCancel: nil,
		TopicSub:         &pubsub.Subscription{},
	}

	return node, nil
}
