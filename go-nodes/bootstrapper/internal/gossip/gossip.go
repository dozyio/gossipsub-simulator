package gossip

import (
	"context"
	"errors"
	"fmt"

	logging "github.com/ipfs/go-log/v2"
	pubsub "github.com/libp2p/go-libp2p-pubsub"
	"github.com/libp2p/go-libp2p/core/host"
)

type Gossip struct {
	Pubsub *pubsub.PubSub
	h      host.Host
}

func New(ctx context.Context, h host.Host, opts ...pubsub.Option) (*Gossip, error) {
	gossipSub, err := pubsub.NewGossipSub(ctx, h, opts...)
	if err != nil {
		return nil, fmt.Errorf("NewGossipSub %w", err)
	}

	res := &Gossip{
		Pubsub: gossipSub,
		h:      h,
	}

	return res, nil
}

func (g *Gossip) JoinSubscribe(
	ctx context.Context,
	gossipTopic string,
	connectionWeight int,
	joinOpts []pubsub.TopicOpt,
	subOpts []pubsub.SubOpt,
	topicScoreParams *pubsub.TopicScoreParams,
	msgProcessor func(*pubsub.Message) error,
	logger logging.EventLogger,
) (*pubsub.Topic, *pubsub.Subscription, error) {
	topic, err := g.Pubsub.Join(gossipTopic, joinOpts...)
	if err != nil {
		return nil, nil, fmt.Errorf("gossipSub.Join %w", err)
	}

	err = topic.SetScoreParams(topicScoreParams)
	if err != nil {
		return nil, nil, fmt.Errorf("topic.SetScoreParams %w", err)
	}

	topicSub, err := topic.Subscribe(subOpts...)
	if err != nil {
		return nil, nil, fmt.Errorf("topic.Subscribe %w", err)
	}

	// Read loop for the topic, adding peers to connection manager
	go func() {
		for {
			msg, err2 := topicSub.Next(ctx)
			if err2 != nil {
				if !errors.Is(err2, context.Canceled) {
					logger.Warnf("topicSub.Next %s", err2)
				}

				break
			}

			// skip messages from self
			if msg.ReceivedFrom == g.h.ID() {
				continue
			}

			// logger.Debugf("Gossip (%s) Received message from %s", gossipTopic, msg.ReceivedFrom.String())
			g.h.ConnManager().TagPeer(msg.ReceivedFrom, gossipTopic, connectionWeight)

			if msgProcessor != nil {
				err = msgProcessor(msg)
				if err != nil {
					logger.Error("msgProcessor %s", err)
				}
			}
		}
	}()

	return topic, topicSub, err
}

// // pinger sends a ping message to the network every x seconds.
// func Pinger(ctx context.Context, topic *pubsub.Topic, text string, interval time.Duration, logger logging.EventLogger) {
// 	go func() {
// 		for {
// 			select {
// 			case <-ctx.Done():
// 				logger.Infof("Gossipsub %s pinger stopped", topic.String())
// 				return
// 			default:
// 				logger.Infof("Gossipsub pinging %s", topic.String())
//
// 				err := topic.Publish(ctx, []byte(text))
// 				if err != nil {
// 					logger.Warn(err)
// 				}
//
// 				time.Sleep(interval)
// 			}
// 		}
// 	}()
// }
