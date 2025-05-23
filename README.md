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

If the controller fails to run, you may need to set the path to the docker socket:

```sh
DOCKER_HOST=unix:///Users/YOUR_USERNAME/.docker/run/docker.sock make controller
```

### Stop

```sh
make stop
```

### Related Projects and info

* [Libp2p](https://github.com/libp2p/)

* [Gossipsub Specs](https://github.com/libp2p/specs/tree/master/pubsub/gossipsub)

* [Testground](https://github.com/testground/testground)

* [Shadow](https://github.com/shadow/shadow)
