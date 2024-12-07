# GossipSub Simulator

![GossipSub Simulator](https://github.com/dozyio/gossipsub-simulator/blob/main/docs/images/screenshot.png?raw=true "GossipSub Simulator")

## Setup

Require npm and golang

```
cd nodes && npm i
```

```
cd controller-ui && npm i
```

## Usage

### Build Bootstrap/Relay and Gossipsub Nodes

```
make build
```

### Run UI

```
make ui
```

### Run Controller

```
make controller
```

### Stop

```
make stop
```
