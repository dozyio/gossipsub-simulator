package statusserver

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/dozyio/gossipsub-simulator/go-nodes/bootstrapper/internal/node"
	"github.com/gorilla/websocket"
	logging "github.com/ipfs/go-log/v2"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/tidwall/gjson"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type Stream struct {
	Protocol  string `json:"protocol"`
	Direction string `json:"direction"`
}

type Streams map[string][]Stream

type PeerScores map[string]int

type RTTs map[string]int

type KadPeer struct {
	KadId    []byte  `json:"kadId"`
	PeerId   peer.ID `json:"peerId"`
	LastPing int64   `json:"lastPing"`
}

type RemotePeer struct {
	Multiaddrs []string `json:"multiaddrs"`
	Protocols  []string `json:"protocols"`
}

type RemotePeers map[string]*RemotePeer

type DHTProvideStatus string

const (
	DHTProvideError      DHTProvideStatus = "error"
	DHTProvideInProgress DHTProvideStatus = "inprogress"
	DHTProvideDone       DHTProvideStatus = "done"
)

type TopicsPeers map[string][]string

type Update struct {
	ContainerId           string           `json:"containerId"`
	PeerId                string           `json:"peerId"`
	Type                  string           `json:"type"`
	SubscribersList       TopicsPeers      `json:"subscribersList"`
	PubsubPeers           []string         `json:"pubsubPeers"`
	MeshPeersList         TopicsPeers      `json:"meshPeersList"`
	FanoutList            TopicsPeers      `json:"fanoutList"`
	Libp2pPeers           []string         `json:"libp2pPeers"`
	Connections           []string         `json:"connections"`
	RemotePeers           RemotePeers      `json:"remotePeers"`
	Protocols             []string         `json:"protocols"`
	Streams               Streams          `json:"streams"`
	Multiaddrs            []string         `json:"multiaddrs"`
	Topics                []string         `json:"topics"`
	DhtPeers              []string         `json:"dhtPeers"`
	DhtProvideStatus      DHTProvideStatus `json:"dhtProvideStatus"`
	DhtFindProviderResult []string         `json:"dhtFindProviderResult"`
	DhtFindPeerResult     []string         `json:"dhtFindPeerResult"`
	LastMessage           string           `json:"lastMessage"`
	MessageCount          int              `json:"messageCount"`
	PeerScores            PeerScores       `json:"peerScores"`
	RTTs                  RTTs             `json:"rtts"`
	ConnectTime           int64            `json:"connectTime"`
}

type StatusServer struct {
	Node        *node.Node
	Type        string
	PeerId      peer.ID
	Topics      []string
	ContainerId string
	PerfBytes   int

	clients   map[*websocket.Conn]bool
	clientsMu sync.RWMutex

	LastPeerId      string
	LastType        string
	LastLibp2pPeers []string
	LastConnections []string
	LastRemotePeers RemotePeers
	LastProtocols   []string
	LastStreams     Streams
	LastMultiaddrs  []string
	LastRTTs        RTTs

	LastTopics          []string
	LastSubscribersList TopicsPeers
	LastPubsubPeers     []string
	LastMeshPeersList   TopicsPeers
	LastFanoutList      TopicsPeers
	LastMessage         string
	MessageCount        int
	LastPeerScores      PeerScores

	LastDhtPeers              []string
	LastDhtProvideStatus      DHTProvideStatus
	LastDhtFindProviderResult []string
	LastDhtFindPeerResult     []string
	ConnectTime               int64
	LastConnectTime           int64

	WssAlive              bool
	Started               bool
	ScheduleUpdate        *time.Ticker
	UpdateCount           int
	UpdateIntervalMs      int
	UpdatesBeforeFullData int
	RttUpdateIntervalMs   int
	Wss                   *websocket.Conn
	WssMutex              sync.Mutex
	log                   logging.EventLogger
}

func New(n *node.Node, typ string, topics []string, perfBytes int, log logging.EventLogger) *StatusServer {
	ss := &StatusServer{
		Node:                  n,
		Type:                  typ,
		PeerId:                n.Host.ID(),
		Topics:                topics,
		PerfBytes:             perfBytes,
		WssAlive:              false,
		Started:               false,
		UpdateIntervalMs:      100,
		UpdatesBeforeFullData: 100,
		RttUpdateIntervalMs:   1000,
		log:                   log,
		clients:               make(map[*websocket.Conn]bool),
	}

	// Event handlers
	ss.serverEventHandlers()

	mux := http.NewServeMux()
	mux.HandleFunc("/", ss.wsHandler)

	handler := enableCors(mux)

	srv := &http.Server{
		Addr:              ":80",
		Handler:           handler,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      7 * time.Second,
		ReadHeaderTimeout: 3 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ss.scheduleUpdates()

	go func() {
		log.Fatal(srv.ListenAndServe())
	}()

	return ss
}

func enableCors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

		if r.Method == "OPTIONS" {
			w.Header().Set("Access-Control-Max-Age", "3600")
			return
		}

		next.ServeHTTP(w, r)
	})
}

func (ss *StatusServer) wsHandler(w http.ResponseWriter, r *http.Request) {
	ss.log.Debugf("new statusserver conn: %s", r.RemoteAddr)
	c, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		ss.log.Debugf("upgrade failed: %s", err)
		return
	}

	go func() {
		ss.clientsMu.Lock()
		{
			ss.clients[c] = true
		}
		ss.clientsMu.Unlock()

		defer func() {
			ss.clientsMu.Lock()
			{
				delete(ss.clients, c)
			}
			ss.clientsMu.Unlock()
			c.Close()
		}()

		// send full update on connection
		fullUpdate, err := ss.fullUpdate()
		if err != nil {
			ss.log.Warnf("error getting full update", err)
		} else {
			err = ss.sendUpdate(c, fullUpdate)
			if err != nil {
				ss.log.Warnf("error sending update, closing connection %s", err)
				return
			}
		}

		for {
			_, b, err := c.ReadMessage()
			if err != nil {
				ss.log.Debugf("disconnected: %s %s", c.RemoteAddr(), err)
				// Client disconnected
				return
			}

			fmt.Printf("Received message: %s\n", string(b))

			mType := gjson.GetBytes(b, "mType").String()
			switch mType {
			case "set-id":
				ss.log.Infof("setting container id %s", gjson.GetBytes(b, "message.id").String())
				ss.ContainerId = gjson.GetBytes(b, "message.id").String()

				fullUpdate, err := ss.fullUpdate()
				if err != nil {
					ss.log.Warnf("error getting full update", err)
					continue
				}

				err = ss.sendUpdate(c, fullUpdate)
				if err != nil {
					ss.log.Warnf("error sending update, closing connection %s", err)
					return
				}
			}
		}
	}()
}

func (ss *StatusServer) setupWSS() {
	// Configure the WebSocket server
}

func (ss *StatusServer) serverEventHandlers() {
	// Setup event listeners from libp2p server (connection:open, etc.)
}

func (ss *StatusServer) handleSelfPeerUpdate() {
	// Handle peer update
}

func (ss *StatusServer) handleConnectionEvent() {
	// Handle connection event
}

func (ss *StatusServer) handlePubsubMessageEvent() {
	// Handle pubsub message
}

func (ss *StatusServer) getRemotePeers() (*RemotePeers, error) {
	connsRaw := ss.Node.Host.Network().Conns()
	remotePeers := make(RemotePeers)

	for _, c := range connsRaw {
		rAddrs := ss.Node.Host.Peerstore().PeerInfo(c.RemotePeer()).Addrs

		rawProtocols, err := ss.Node.Host.Peerstore().GetProtocols(c.RemotePeer())
		if err != nil {
			ss.log.Errorf("error getting protocols for remote peer: %s", err)
		}

		rp := &RemotePeer{
			Multiaddrs: []string{},
			Protocols:  []string{},
		}

		for _, rAddr := range rAddrs {
			rp.Multiaddrs = append(rp.Multiaddrs, rAddr.String())
		}

		for _, protocol := range rawProtocols {
			rp.Protocols = append(rp.Protocols, string(protocol))
		}

		remotePeers[c.RemotePeer().String()] = rp
	}

	return &remotePeers, nil
}

func (ss *StatusServer) getPeerScores() PeerScores {
	// Go doesn't expose the peer scores
	return PeerScores{}
}

func (ss *StatusServer) getRTTs() RTTs {
	// Go doesn't track RTTs, return -1
	rtts := RTTs{}

	connsRaw := ss.Node.Host.Network().Conns()
	for _, c := range connsRaw {
		rtts[c.RemotePeer().String()] = -1
	}

	// Get round-trip times
	return rtts
}

func (ss *StatusServer) deltaUpdate() (*Update, error) {
	// Perform a delta update
	// TODO
	return &Update{}, nil
}

func (ss *StatusServer) fullUpdate() (*Update, error) {
	// Perform a full update
	mas := ss.Node.Host.Addrs()
	maStrings := make([]string, len(mas))
	for i, ma := range mas {
		maStrings[i] = ma.String()
	}

	protocolsRaw := ss.Node.Host.Mux().Protocols()
	protocols := make([]string, len(protocolsRaw))
	for i, p := range protocolsRaw {
		protocols[i] = string(p)
	}

	peersRaw := ss.Node.Host.Peerstore().Peers()
	peers := make([]string, len(peersRaw))
	for i, p := range peersRaw {
		peers[i] = p.String()
	}

	connsRaw := ss.Node.Host.Network().Conns()
	conns := make([]string, len(connsRaw))
	for i, c := range connsRaw {
		conns[i] = c.RemotePeer().String()
	}

	remotePeers, err := ss.getRemotePeers()
	if err != nil {
		ss.log.Errorf("error getting remote peers: %s", err)
		return nil, err
	}

	subscribersList := ss.getSubscribersList()
	meshPeersList := ss.getMeshPeersList() // empty
	rtts := ss.getRTTs()                   // not tracked by Go, return -1

	u := &Update{
		ContainerId:           ss.ContainerId,
		PeerId:                ss.Node.Host.ID().String(),
		Type:                  ss.Type,
		SubscribersList:       subscribersList,
		MeshPeersList:         meshPeersList,
		Libp2pPeers:           peers,
		Connections:           conns,
		RemotePeers:           *remotePeers,
		Protocols:             protocols,
		Streams:               Streams{},
		Multiaddrs:            maStrings,
		Topics:                ss.Topics,
		DhtPeers:              []string{},
		DhtProvideStatus:      "",
		DhtFindProviderResult: []string{},
		DhtFindPeerResult:     []string{},
		LastMessage:           "",
		MessageCount:          0,
		PeerScores:            PeerScores{},
		RTTs:                  rtts,
		ConnectTime:           0,
	}
	return u, nil
}

func (ss *StatusServer) sendUpdate(c *websocket.Conn, update *Update) error {
	data, err := json.Marshal(update)
	if err != nil {
		ss.log.Warnf("error sendUpdate marshaling update", err)
		return err
	}

	err = c.WriteMessage(websocket.TextMessage, data)
	if err != nil {
		return err
	}

	return nil
}

// Schedule periodic updates
func (ss *StatusServer) scheduleUpdates() {
	go func() {
		for {
			u, err := ss.fullUpdate()
			if err != nil {
				ss.log.Warnf("error getting full update", err)
				return
			}

			ss.clientsMu.Lock()
			for c := range ss.clients {
				err := ss.sendUpdate(c, u)
				if err != nil {
					fmt.Printf("Failed to write message to client %s: %v\n", c.RemoteAddr().String(), err)
					c.Close()
					delete(ss.clients, c)
				}
			}
			ss.clientsMu.Unlock()

			time.Sleep(5 * time.Second)
		}
	}()
}

func (ss *StatusServer) getStreams() Streams {
	// Get active streams from connections
	// TODO
	return Streams{}
}

func (ss *StatusServer) getMeshPeersList() TopicsPeers {
	// Go doesn't expose the mesh peers list
	return TopicsPeers{}
}

func (ss *StatusServer) getSubscribersList() TopicsPeers {
	// only handle 1 topic for now
	topicsPeers := make(TopicsPeers)

	peers := ss.Node.Topic.ListPeers()
	ss.log.Infof("subscribers topiclistpeers peers: len: %d, %+v", len(peers), peers)

	var peerIds []string
	for _, p := range peers {
		peerIds = append(peerIds, p.String())
	}

	topicsPeers[ss.Node.Topic.String()] = peerIds

	ss.log.Infof("subscribers peers: %+v", topicsPeers)

	return topicsPeers
}
