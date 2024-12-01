.PHONY: build stop

build:
	npm run build
	docker build -t gossip:dev -f Dockerfile.gossip .
	docker build -t bootstrapper:dev -f Dockerfile.bootstrapper .

stop:
	docker stop -s SIGKILL $$(docker ps -a -q) && docker rm $$(docker ps -a -q)
