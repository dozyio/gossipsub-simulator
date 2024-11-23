build:
	cd nodes && make build

ui:
	cd controller-ui && yarn dev

controller:
	cd controller && go build . && ./controller

stop:
	docker stop -s SIGKILL $$(docker ps -a -q) && docker rm $$(docker ps -a -q)
