.PHONY: build stop

build:
	npm run build
	docker build -t gossip:dev -f Dockerfile.gossip .
	docker build -t bootstrapper:dev -f Dockerfile.bootstrapper .
	docker build -t minimal:dev -f Dockerfile.minimal .

stop:
	docker stop -s SIGKILL $$(docker ps -a -q) && docker rm $$(docker ps -a -q)
