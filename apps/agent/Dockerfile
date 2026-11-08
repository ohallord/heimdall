# syntax=docker/dockerfile:1

FROM golang:1.26-bookworm AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
# Bust BuildKit cache when deploy-cluster passes git SHA.
ARG CACHEBUST=0
ARG AGENT_VERSION=dev
RUN printf 'cachebust=%s\n' "$CACHEBUST"
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags "-X main.version=${AGENT_VERSION}" -o /out/heimdall-agent ./cmd/agent
# Empty state dir: a fresh named volume mounted here inherits 65532 ownership (nonroot can write).
RUN mkdir -p /out/state

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /out/heimdall-agent /heimdall-agent
COPY --from=builder --chown=65532:65532 /out/state /var/lib/heimdall
USER 65532:65532
ENTRYPOINT ["/heimdall-agent"]
CMD ["run", "--interval", "10s"]
