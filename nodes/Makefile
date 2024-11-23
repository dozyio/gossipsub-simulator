build:
	docker build -t gossip:dev -f Dockerfile.gossip .
	docker build -t relay:dev -f Dockerfile.relay .

stop:
	docker stop -s SIGKILL $$(docker ps -a -q) && docker rm $$(docker ps -a -q)
