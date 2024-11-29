NETWORK:=p2p-net

.PHONY: build ui controller stop

build:
	cd nodes && make build

ui:
	cd controller-ui && yarn dev

net:
	docker network create -d bridge --subnet=172.20.0.0/16 --opt com.docker.network.bridge.name=tc-network ${NETWORK} || true

controller: net
	cd controller && NETWORK=${NETWORK} go run main.go

stop:
	docker network rm ${NETWORK} || true
	docker stop -s SIGKILL $$(docker ps -a -q) && docker rm $$(docker ps -a -q)
