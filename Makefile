NETWORK:=p2p-net

.PHONY: build ui controller stop

build:
	cd nodes && make build
	cd legacy-nodes && make build

ui:
	cd controller-ui && npm run dev

net:
	docker network create -d bridge --subnet=172.20.0.0/16 --opt com.docker.network.bridge.name=tc-network ${NETWORK} || true

controller: net
	cd controller && go build -o controller main.go && NETWORK=${NETWORK} ./controller

stop:
	docker network rm ${NETWORK} || true
	docker stop -s SIGKILL $$(docker ps -a -q) || true && docker rm $$(docker ps -a -q)
