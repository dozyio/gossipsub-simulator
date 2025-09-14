.PHONY: build stop

build:
	cd bootstrapper && docker build -t bootstrapper-go:dev -f Dockerfile .

stop:
	docker stop -s SIGKILL $$(docker ps -a -q) && docker rm $$(docker ps -a -q)
