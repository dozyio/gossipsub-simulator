package interfaces

import (
	"fmt"
	"net"
	"reflect"
)

func GetAddresses() ([]string, []string) {
	ipv4Addrs := []string{}
	ipv6Addrs := []string{}

	ifaces, err := net.Interfaces()
	if err != nil {
		fmt.Printf("Error: could not get interfaces: %s\n", err.Error())
		return ipv4Addrs, ipv6Addrs
	}

	for _, i := range ifaces {
		addrs, err := i.Addrs()
		if err != nil {
			fmt.Printf("%s: Error getting address of interface: %s\n", i.Name, err.Error())
			continue
		}

		if !(i.Flags&net.FlagUp != 0) {
			// fmt.Printf("%s: Interface is down, skipping\n", i.Name)
			continue
		}

		if !(i.Flags&net.FlagRunning != 0) {
			// fmt.Printf("%s: Interface not running, skipping\n", i.Name)
			continue
		}

		// isLoopback := true
		if !(i.Flags&net.FlagLoopback != 0) {
			// fmt.Printf("Interface is loopback %+v %+v\n", i.Name, a)
			// isLoopback = false
		}

		// supportMulitcast := true
		if !(i.Flags&net.FlagMulticast != 0) {
			// fmt.Printf("Interface supports multicast %+v %+v\n", i.Name, a)
			// supportMulitcast = false
		}

		if i.Flags&net.FlagPointToPoint != 0 {
			// fmt.Printf("%s: point-to-point, skipping\n", i.Name)
			continue
		}

		for _, a := range addrs {
			// fmt.Printf("Interface: %+v\n", i)
			// fmt.Printf("Flags : %+v\n", i.Flags)
			// ip := "v4"

			switch v := a.(type) {
			case *net.IPAddr:
				if IsIPv6(v.IP) {
					// ip = "v6"

					if isIPv6LocalLink(v.IP) {
						// skip local link
						continue
					}

					ipv6Addrs = append(ipv6Addrs, v.String())
				} else {
					ipv4Addrs = append(ipv4Addrs, v.String())
				}

				// fmt.Printf("IPAddr %v: %s IP%s Loopback: %t Multicast: %t\n", i.Name, v, ip, isLoopback, supportMulitcast)
			case *net.IPNet:
				if IsIPv6(v.IP) {
					// ip = "v6"

					if isIPv6LocalLink(v.IP) {
						// skip local link
						continue
					}
					ipv6Addrs = append(ipv6Addrs, v.IP.String())
				} else {
					ipv4Addrs = append(ipv4Addrs, v.IP.String())
				}

				// fmt.Printf("IPNet %v: %s IP%s Loopback: %t Multicast: %t\n", i.Name, v.IP, ip, isLoopback, supportMulitcast)
			default:
				fmt.Printf("Unknown address type: %s\n", reflect.TypeOf(a))
			}
		}
	}

	return ipv4Addrs, ipv6Addrs
}

func IsIPv6(ip net.IP) bool {
	return ip.To4() == nil
}

func isIPv6LocalLink(ip net.IP) bool {
	return ip.IsLinkLocalUnicast()
}
