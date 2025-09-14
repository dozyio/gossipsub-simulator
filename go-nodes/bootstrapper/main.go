package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"fmt"
	"os"

	"github.com/caarlos0/env/v11"
	"github.com/dozyio/gossipsub-simulator/go-nodes/bootstrapper/internal/config"
	"github.com/dozyio/gossipsub-simulator/go-nodes/bootstrapper/internal/consts"
	"github.com/dozyio/gossipsub-simulator/go-nodes/bootstrapper/internal/gossip"
	"github.com/dozyio/gossipsub-simulator/go-nodes/bootstrapper/internal/node"
	"github.com/dozyio/gossipsub-simulator/go-nodes/bootstrapper/internal/statusserver"
	"github.com/dozyio/gossipsub-simulator/go-nodes/bootstrapper/internal/utils"
	datastore "github.com/ipfs/go-datastore"
	dssync "github.com/ipfs/go-datastore/sync"
	logging "github.com/ipfs/go-log/v2"
	pubsub "github.com/libp2p/go-libp2p-pubsub"
	"github.com/libp2p/go-libp2p/core/crypto"
)

var logger = logging.Logger(consts.AppName)

func main() {
	logging.SetLogLevel("*", "WARN")
	logging.SetLogLevel(consts.AppName, "INFO")

	cfg := config.Config{}
	err := env.Parse(&cfg)
	if err != nil {
		panic(fmt.Errorf("unable to parse env: %w", err))
	}

	fmt.Printf("cfg: %+v\n", cfg)

	privKey, pubKey, err := NewKeyPairFromSeed(cfg.Seed)
	if err != nil {
		panic(err)
	}

	ds := dssync.MutexWrap(datastore.NewMapDatastore())

	// create libp2p node
	n, err := node.New(context.Background(), &cfg, privKey, pubKey, ds, logger)
	if err != nil {
		panic(err)
	}

	// create statusserver
	ss := statusserver.New(n, "bootstrapper", cfg.Topics, 0, logger)

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

		ctx := context.Background()
		gossipSub, err := gossip.New(ctx, n.Host, gossipSubOpts...)
		if err != nil {
			logger.Errorf("gossip.New %s", err)
			os.Exit(1)
		}

		topicOpts := []pubsub.TopicOpt{}

		subOpts := []pubsub.SubOpt{}

		topicScoreParams := gossip.BootstrapperTopicScoreParams()

		gossipMsgHandler := ss.HandlePubsubMessageEvent

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

		n.Topic = topic
		n.TopicRelayCancel = topicRelayCancel
		n.TopicSub = topicSub
	}

	logger.Infof("Peer ID: %s", n.Host.ID())
	nodeAddresses := utils.NodeAddressesWithPeerID(n.Host)
	for _, a := range nodeAddresses {
		logger.Infof("Address: %s", a)
	}

	select {}
}

func NewKeyPairFromSeed(seed string) (crypto.PrivKey, crypto.PubKey, error) {
	seed32Bytes, err := hex.DecodeString(utils.Trim0x(seed))
	if err != nil {
		return nil, nil, err
	}

	if len(seed32Bytes) != 32 {
		return nil, nil, fmt.Errorf("seed must be exactly 32 bytes long, but got %d", len(seed32Bytes))
	}

	reader := bytes.NewReader(seed32Bytes)

	return crypto.GenerateKeyPairWithReader(crypto.Ed25519, -1, reader)
}
