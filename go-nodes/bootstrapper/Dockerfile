FROM golang:1.25.1-alpine AS builder
WORKDIR /opt
COPY . /opt
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build go build -o app .

FROM alpine:latest AS final
WORKDIR /opt
RUN apk add --no-cache iproute2 iptables tcpdump
COPY --from=builder /opt/app /opt/app
CMD ["/opt/app"]
