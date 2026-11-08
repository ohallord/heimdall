# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Bust BuildKit cache when deploy-cluster passes git SHA (stale COPY/.next otherwise).
ARG CACHEBUST=0
RUN printf 'cachebust=%s\n' "$CACHEBUST"
COPY . .
# Next standalone runner expects ./public; keep an empty dir if the app has none.
RUN mkdir -p public
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Phase 31: agent binaries + host installers served at /downloads and /install.sh.
# Named build contexts (compose additional_contexts / buildx --build-context):
#   agent=apps/agent  scripts=scripts  deploy=deploy
FROM golang:1.26-bookworm AS dist
ARG AGENT_VERSION=dev
WORKDIR /src
COPY --from=agent . apps/agent
COPY --from=scripts . scripts
COPY --from=deploy . deploy
RUN cd apps/agent && go mod download
RUN SRC_ROOT=/src AGENT_VERSION="$AGENT_VERSION" ./scripts/build-dist.sh /dist

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=43123
ENV HOSTNAME=0.0.0.0
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder /app/db ./db
COPY --from=dist /dist ./dist
ENV HEIMDALL_DIST_DIR=/app/dist
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 43123
CMD ["node", "server.js"]
