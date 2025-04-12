.PHONY: build stop

build:
	npm run build
	docker build -t gossip:dev -f Dockerfile.gossip .
	docker build -t bootstrapper:dev -f Dockerfile.bootstrapper .
	docker build -t minimal:dev -f Dockerfile.minimal .
	docker build -t minimal:debug -f Dockerfile.minimal.debug .

stop:
	docker stop -s SIGKILL $$(docker ps -a -q) && docker rm $$(docker ps -a -q)
