import { peerIdFromString } from '@libp2p/peer-id'
import { type PeerId, PeerInfo, Ed25519PrivateKey, SignedMessage, Message } from '@libp2p/interface'
import { Multiaddr, multiaddr } from '@multiformats/multiaddr'
import { bootstrapper1PeerId, bootstrapper2PeerId } from './consts';
import { keys } from '@libp2p/crypto'
import { isPrivateIp } from '@libp2p/utils/private-ip'
import { sha256 } from 'multiformats/hashes/sha2'

export const isEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;

  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }

  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);

  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    // Check if the second object has the key and recursively compare the values
    if (
      !keysB.includes(key) ||
      !isEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key]
      )
    ) {
      return false;
    }
  }

  return true;
};

export function stringToDialable(str: string): PeerId | Multiaddr {
  let mp: PeerId | Multiaddr | undefined

  try {
    mp = multiaddr(str)
    return mp
  } catch (_) {
    // ignore
  }

  try {
    mp = peerIdFromString(str)
    return mp
  } catch (_) {
    // ignore
  }

  throw new Error('invalid peerId or multiaddr')
}

export const trim0x = (x: string): string => {
  return x.startsWith('0x') ? x.slice(2) : x
}

export const hexStringToUint8Array = (hexString: string) => {
  hexString = trim0x(hexString)

  // Ensure the hex string length is even
  if (hexString.length % 2 !== 0) {
    console.warn('Hex string has an odd length, adding leading 0')
    hexString = `0${hexString}`
  }

  // Convert each hex pair to a byte
  const byteArray = new Uint8Array(hexString.length / 2)

  for (let i = 0; i < hexString.length; i += 2) {
    const byte = parseInt(hexString.substring(i, i + 2), 16)

    byteArray[i / 2] = byte
  }

  return byteArray
}

export function applicationScore(p: string) {
  if (p === bootstrapper1PeerId || p === bootstrapper2PeerId) {
    return 1200
  }

  return 0
}

export const generateKeyPair = async (seed: string): Promise<Ed25519PrivateKey> => {
  try {
    const pKey = await keys.generateKeyPairFromSeed('Ed25519', hexStringToUint8Array(seed));
    return pKey;
  } catch (error) {
    console.error('Error generating key pair:', error);
    throw error; // Re-throw if you want to handle it further up
  }
}

// Define mapper to remove loopback addresses
export const removePublicAddressesLoopbackAddressesMapper = (peer: PeerInfo): PeerInfo => {
  const newMultiaddrs = peer.multiaddrs.filter(multiaddr => {
    const tuples = multiaddr.stringTuples()
    if (tuples.length === 0) return false
    const [[type, addr]] = tuples

    if (addr === 'localhost' || addr === '127.0.0.1') {
      return false
    }

    if (type !== 4 && type !== 6) { // Assuming 4 is IPv4 and 6 is IPv6
      return false
    }

    if (addr == null) {
      return false
    }

    const isPrivate = isPrivateIp(addr)

    if (isPrivate == null) {
      // not an IP address
      return false
    }

    return isPrivate
  })

  return {
    ...peer,
    multiaddrs: newMultiaddrs
  }
}
