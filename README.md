# GossipSub Simulator

![GossipSub Simulator](https://github.com/dozyio/gossipsub-simulator/blob/main/docs/images/screenshot.png?raw=true "GossipSub Simulator")

## Setup

Require `npm` and `golang`

```sh
cd nodes && npm i
```

```sh
cd controller-ui && npm i
```

## Usage

### Build Bootstrap/Relay and Gossipsub Nodes

```sh
make build
```

### Run UI

```sh
make ui
```

### Run Controller

```sh
make controller
```

### Stop

```sh
make stop
```

### Related Projects and info

* [Gossipsub Specs](https://github.com/libp2p/specs/tree/master/pubsub/gossipsub)

* [Testground](https://github.com/testground/testground)
