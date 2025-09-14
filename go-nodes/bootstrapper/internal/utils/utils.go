package utils

import (
	"fmt"
	"strings"

	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/peer"
)

func Trim0x(s string) string {
	if len(s) > 2 && (s[:2] == "0x" || s[:2] == "0X") {
		return s[2:]
	}

	return s
}

func Prefix0x(s string) string {
	if strings.HasPrefix(s, "0x") {
		return s
	}

	return "0x" + s
}

func NodeAddressesWithPeerID(h host.Host) []string {
	addresses := []string{}
	for _, addr := range h.Addrs() {
		addresses = append(addresses, addr.String()+"/p2p/"+h.ID().String())
	}

	return addresses
}

func StringSliceToAddrInfoSlice(peerStrs []string) []peer.AddrInfo {
	var addrInfos []peer.AddrInfo

	if len(peerStrs) > 0 {
		for _, addr := range peerStrs {
			peerInfo, err := peer.AddrInfoFromString(addr)
			if err != nil {
				panic(fmt.Sprintf("Could not AddrInfoFromString: %v", err))
			}

			addrInfos = append(addrInfos, *peerInfo)
		}
	}

	return addrInfos
}
