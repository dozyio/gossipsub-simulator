NETWORK:=p2p-net-overlay

.PHONY: build ui controller stop

build:
	cd js-nodes && make build
	cd legacy-nodes && make build
	cd go-nodes && make build

ui:
	cd controller-ui && npm run dev

net:
	@# If we’re not already a Swarm manager, initialize Swarm
	@# Swarm allows for 40+ containers running without ARP issues
	@# Fixes `neighbour: arp_cache: neighbor table overflow!`
	@if [ "$$(docker info --format '{{.Swarm.ControlAvailable}}' 2>/dev/null)" != "true" ]; then \
	  echo "Node is not a Swarm manager — initializing Swarm..."; \
	  docker swarm init; \
	else \
	  echo "Already a Swarm manager."; \
	fi
	@# Create overlay network
	docker network create \
	  -d overlay \
	  --attachable \
	  --opt com.docker.network.bridge.name=tc-network \
	  ${NETWORK} || true

controller: net
	cd controller && go build -o controller main.go && NETWORK=${NETWORK} ./controller

stop:
	docker swarm leave --force || true
	docker network rm ${NETWORK} || true
	docker stop -s SIGKILL $$(docker ps -a -q) || true && docker rm $$(docker ps -a -q)
