package gossip

// https://github.com/OffchainLabs/prysm/blob/master/beacon-chain/p2p/gossip_scoring_params.go

import (
	"fmt"
	"math"
	"slices"
	"time"

	"github.com/dozyio/gossipsub-simulator/go-nodes/bootstrapper/internal/consts"
	pubsub "github.com/libp2p/go-libp2p-pubsub"
	"github.com/libp2p/go-libp2p/core/peer"
)

const (
	// keyBroadcastWeight specifies the scoring weight that we apply to the
	// keyBroadcast topic.
	keyBroadcastWeight = 0.8

	// maxInMeshScore describes the max score a peer can attain from being in the
	// mesh.
	maxInMeshScore = 10

	// maxFirstDeliveryScore describes the max score a peer can obtain from first
	// deliveries.
	maxFirstDeliveryScore = 40

	// decayToZero specifies the terminal value that we will use when decaying
	// a value.
	decayToZero = 0.01

	// dampeningFactor reduces the amount by which the various thresholds and
	// caps are created.
	dampeningFactor = 90
)

var (
	// Defines the variables representing the different time periods.
	oneHundredEpochs     = 100 * oneEpochDuration()
	invalidDecayPeriod   = 50 * oneEpochDuration()
	twentyEpochs         = 20 * oneEpochDuration()
	tenEpochs            = 10 * oneEpochDuration()
	meshDeliveryIsScored = true
)

func oneSlotDuration() time.Duration {
	return time.Duration(10) * time.Second
}

// new epoch every 5 minutes
func oneEpochDuration() time.Duration {
	return time.Duration(30) * oneSlotDuration()
}

// determines the decay rate from the provided time period till
// the decayToZero value. Ex: ( 1 -> 0.01)
func scoreDecay(totalDurationDecay time.Duration) float64 {
	numOfTimes := totalDurationDecay / oneSlotDuration()
	return math.Pow(decayToZero, 1/float64(numOfTimes))
}

// is used to determine the threshold from the decay limit with
// a provided growth rate. This applies the decay rate to a
// computed limit.
func decayThreshold(decayRate, rate float64) (float64, error) {
	d, err := decayLimit(decayRate, rate)
	if err != nil {
		return 0, err
	}
	return d * decayRate, nil
}

// decayLimit provides the value till which a decay process will
// limit till provided with an expected growth rate.
func decayLimit(decayRate, rate float64) (float64, error) {
	if 1 <= decayRate {
		return 0, fmt.Errorf("got an invalid decayLimit rate: %f", decayRate)
	}
	return rate / (1 - decayRate), nil
}

// provides the relevant score by the provided weight and threshold.
func scoreByWeight(weight, threshold float64) float64 {
	return maxScore() / (weight * threshold * threshold)
}

// maxScore attainable by a peer.
func maxScore() float64 {
	totalWeight := keyBroadcastWeight
	return (maxInMeshScore + maxFirstDeliveryScore) * totalWeight
}

// denotes the unit time in mesh for scoring tallying.
func inMeshTime() time.Duration {
	return 1 * oneSlotDuration()
}

// the cap for `inMesh` time scoring.
func inMeshCap() float64 {
	return float64((3600 * time.Second) / inMeshTime())
}

func PeerScoringParams() (*pubsub.PeerScoreParams, *pubsub.PeerScoreThresholds) {
	thresholds := &pubsub.PeerScoreThresholds{
		GossipThreshold:             -4000,
		PublishThreshold:            -8000,
		GraylistThreshold:           -16000,
		AcceptPXThreshold:           100,
		OpportunisticGraftThreshold: 5,
	}

	scoreParams := &pubsub.PeerScoreParams{
		Topics:        make(map[string]*pubsub.TopicScoreParams),
		TopicScoreCap: 32.72,
		AppSpecificScore: func(p peer.ID) float64 {
			if slices.Contains(consts.BootstrappersPeerId, p.String()) {
				return 400
			}
			return 0
		},
		AppSpecificWeight:           1,
		IPColocationFactorWeight:    -35.11,
		IPColocationFactorThreshold: 10,
		IPColocationFactorWhitelist: nil,
		BehaviourPenaltyWeight:      -15.92,
		BehaviourPenaltyThreshold:   6,
		BehaviourPenaltyDecay:       scoreDecay(tenEpochs),
		DecayInterval:               oneSlotDuration(),
		DecayToZero:                 decayToZero,
		RetainScore:                 oneHundredEpochs,
	}
	return scoreParams, thresholds
}

func BootstrapperTopicScoreParams() *pubsub.TopicScoreParams {
	return &pubsub.TopicScoreParams{
		TopicWeight: 1,

		// P1
		TimeInMeshWeight:  0.1,
		TimeInMeshQuantum: 1 * 1000,
		TimeInMeshCap:     3,

		// P2
		FirstMessageDeliveriesWeight: 1,
		FirstMessageDeliveriesDecay:  0.90,
		FirstMessageDeliveriesCap:    5,

		// P3
		MeshMessageDeliveriesWeight: 0,
		MeshMessageDeliveriesDecay:  0.90,
		// MeshMessageDeliveriesCap:
		// MeshMessageDeliveriesThreshold:
		// MeshMessageDeliveriesWindow:
		// MeshMessageDeliveriesActivation:

		// P3b
		MeshFailurePenaltyWeight: 0,
		MeshFailurePenaltyDecay:  0.90,

		// P4
		InvalidMessageDeliveriesWeight: 0,
		InvalidMessageDeliveriesDecay:  0.90,
	}
}

// func DefaultKeyBroadcastTopicParams(activeNodes uint64) *pubsub.TopicScoreParams {
// 	// Determine the expected message rate for the particular gossip topic.
// 	msgPerSlot := activeNodes / 10
//
// 	firstMessageCap, err := decayLimit(scoreDecay(1*oneEpochDuration()), float64(msgPerSlot*2/consts.GossipD))
// 	if err != nil {
// 		log.Printf("skipping initializing topic scoring: %v", err)
// 		return nil
// 	}
//
// 	firstMessageWeight := maxFirstDeliveryScore / firstMessageCap
// 	meshThreshold, err := decayThreshold(scoreDecay(1*oneEpochDuration()), float64(msgPerSlot)/dampeningFactor)
// 	if err != nil {
// 		log.Printf("skipping initializing topic scoring: %v", err)
// 		return nil
//
// 	}
// 	meshWeight := -scoreByWeight(keyBroadcastWeight, meshThreshold)
// 	meshCap := 4 * meshThreshold
//
// 	if !meshDeliveryIsScored {
// 		// Set the mesh weight as zero as a temporary measure, so as to prevent
// 		// the average nodes from being penalised.
// 		meshWeight = 0
// 	}
//
// 	return &pubsub.TopicScoreParams{
// 		TopicWeight:                     keyBroadcastWeight,
// 		TimeInMeshWeight:                maxInMeshScore / inMeshCap(),
// 		TimeInMeshQuantum:               inMeshTime(),
// 		TimeInMeshCap:                   inMeshCap(),
// 		FirstMessageDeliveriesWeight:    firstMessageWeight,
// 		FirstMessageDeliveriesDecay:     scoreDecay(1 * oneEpochDuration()),
// 		FirstMessageDeliveriesCap:       firstMessageCap,
// 		MeshMessageDeliveriesWeight:     meshWeight,
// 		MeshMessageDeliveriesDecay:      scoreDecay(1 * oneEpochDuration()),
// 		MeshMessageDeliveriesCap:        meshCap,
// 		MeshMessageDeliveriesThreshold:  meshThreshold,
// 		MeshMessageDeliveriesWindow:     2 * time.Second,
// 		MeshMessageDeliveriesActivation: 1 * oneEpochDuration(),
// 		MeshFailurePenaltyWeight:        meshWeight,
// 		MeshFailurePenaltyDecay:         scoreDecay(1 * oneEpochDuration()),
// 		InvalidMessageDeliveriesWeight:  -maxScore() / keyBroadcastWeight,
// 		InvalidMessageDeliveriesDecay:   scoreDecay(invalidDecayPeriod),
// 	}
// }
