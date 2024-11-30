import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'

export const isEqual = (a, b) => {
  if (a === b) return true;

  if (typeof a !== "object" || typeof b !== "object" || a == null || b == null) {
    return false;
  }

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);

  if (keysA.length !== keysB.length) return false;

  for (let key of keysA) {
    if (!keysB.includes(key) || !isEqual(a[key], b[key])) return false;
  }

  return true;
}

export const stringToDialable = (str) => {
  let mp

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

export const trim0x = (x) => {
  return x.startsWith('0x') ? x.slice(2) : x
}

export const hexStringToUint8Array = (hexString) => {
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

export const getStreams = (server) => {
  const connections = server.getConnections();

  return connections.reduce((accumulator, connection) => {
    // Ensure the connection has streams and a valid remotePeer
    if (connection.streams && connection.streams.length > 0 && connection.remotePeer) {
      const peerId = connection.remotePeer.toString();

      // Initialize the array for this peerId if it doesn't exist
      if (!accumulator[peerId]) {
        accumulator[peerId] = [];
      }

      // Map the streams to the desired format and append them to the peer's array
      const mappedStreams = connection.streams.map(stream => ({
        protocol: stream.protocol,
        direction: stream.direction
      }));

      accumulator[peerId].push(...mappedStreams);
    }

    return accumulator;
  }, {}); // Initialize accumulator as an empty object
};

export const newStatusServer = (server) => {
}
