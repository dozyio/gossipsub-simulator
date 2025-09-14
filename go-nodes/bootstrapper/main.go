package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"fmt"

	"github.com/caarlos0/env/v11"
	"github.com/dozyio/gossipsub-simulator/go-nodes/bootstrapper/internal/config"
	"github.com/dozyio/gossipsub-simulator/go-nodes/bootstrapper/internal/consts"
	"github.com/dozyio/gossipsub-simulator/go-nodes/bootstrapper/internal/node"
	"github.com/dozyio/gossipsub-simulator/go-nodes/bootstrapper/internal/statusserver"
	"github.com/dozyio/gossipsub-simulator/go-nodes/bootstrapper/internal/utils"
	datastore "github.com/ipfs/go-datastore"
	dssync "github.com/ipfs/go-datastore/sync"
	logging "github.com/ipfs/go-log/v2"
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
	n, err := node.New(context.Background(), &cfg, privKey, pubKey, ds, logger)
	if err != nil {
		panic(err)
	}

	_ = statusserver.New(n, "bootstrapper", cfg.Topics, 0, logger)

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
