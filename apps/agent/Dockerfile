# syntax=docker/dockerfile:1

FROM golang:1.22-bookworm AS builder
WORKDIR /src
COPY go.mod ./
RUN go mod download
# Bust BuildKit cache when deploy-cluster passes git SHA.
ARG CACHEBUST=0
ARG AGENT_VERSION=dev
RUN printf 'cachebust=%s\n' "$CACHEBUST"
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags "-X main.version=${AGENT_VERSION}" -o /out/heimdall-agent ./cmd/agent

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /out/heimdall-agent /heimdall-agent
ENTRYPOINT ["/heimdall-agent"]
CMD ["run", "--interval", "10s"]
