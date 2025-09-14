package node

import (
	"context"
	"fmt"
	"os"

	"github.com/dozyio/gossipsub-simulator/go-nodes/bootstrapper/internal/config"
	"github.com/dozyio/gossipsub-simulator/go-nodes/bootstrapper/internal/consts"
	"github.com/dozyio/gossipsub-simulator/go-nodes/bootstrapper/internal/gossip"
	"github.com/dozyio/gossipsub-simulator/go-nodes/bootstrapper/internal/interfaces"
	"github.com/dozyio/gossipsub-simulator/go-nodes/bootstrapper/internal/utils"
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

	if len(cfg.Topics) > 0 {
		// Setup gossipsub
		bootstrapper1PeerId := "12D3KooWJwYWjPLsTKiZ7eMjDagCZh9Fqt1UERLKoPb5QQNByrAF"
		bootstrapper1Ma := "/dns/bootstrapper1/tcp/42069/p2p/" + bootstrapper1PeerId

		bootstrapper2PeerId := "12D3KooWAfBVdmphtMFPVq3GEpcg3QMiRbrwD9mpd6D6fc4CswRw"
		bootstrapper2Ma := "/dns/bootstrapper2/tcp/42069/p2p/" + bootstrapper2PeerId

		directPeers := utils.StringSliceToAddrInfoSlice([]string{bootstrapper1Ma, bootstrapper2Ma})

		gossipSubOpts := []pubsub.Option{
			pubsub.WithPeerScore(gossip.PeerScoringParams()),
			pubsub.WithDirectPeers(directPeers),
			pubsub.WithDirectConnectTicks(30),
		}

		gossipSub, err := gossip.New(ctx, h, gossipSubOpts...)
		if err != nil {
			logger.Errorf("gossip.New %s", err)
			os.Exit(1)
		}

		topicOpts := []pubsub.TopicOpt{}

		subOpts := []pubsub.SubOpt{}

		topicScoreParams := gossip.BootstrapperTopicScoreParams()

		gossipMsgHandler := func(m *pubsub.Message) error {
			logger.Infof("Received gossipsub message from %s: %s\n", m.GetFrom(), m.Data)

			return nil
		}

		// only join first topic for now
		topic, topicSub, err := gossipSub.JoinSubscribe(ctx, cfg.Topics[0], consts.GossipPeerWeight, topicOpts, subOpts, topicScoreParams, gossipMsgHandler, logger)
		if err != nil {
			logger.Errorf("NewGossipSub %s", err)
			os.Exit(1)
		}

		topicRelayCancel, err := topic.Relay()
		if err != nil {
			logger.Errorf("error relaying for %s: %s", topic.String(), err)
			os.Exit(1)
		}

		node.Topic = topic
		node.TopicRelayCancel = topicRelayCancel
		node.TopicSub = topicSub
	}

	return node, nil
}
