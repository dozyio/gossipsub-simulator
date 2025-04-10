.PHONY: build stop

build:
	rm -rf dist
	npm run build
	docker build -t legacy:dev -f Dockerfile.legacy .

stop:
	docker stop -s SIGKILL $$(docker ps -a -q) && docker rm $$(docker ps -a -q)
