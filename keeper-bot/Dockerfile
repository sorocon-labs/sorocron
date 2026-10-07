# Build context is the repository root (docker-compose.yml sets this up):
# the keeper is an npm workspace that depends on packages/sdk, and config.ts
# reads ../deployments/<network>.json.
#
#   docker build -f keeper-bot/Dockerfile -t sorocron-keeper .
#   docker run --env-file keeper-bot/.env sorocron-keeper

# ---- build: compile the SDK, then the keeper ------------------------------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/react/package.json packages/react/
COPY keeper-bot/package.json keeper-bot/
COPY app/package.json app/
RUN npm ci -w @sorocron/sdk -w sorocron-keeper-bot
COPY packages/sdk packages/sdk
COPY keeper-bot keeper-bot
RUN npm run build -w @sorocron/sdk && npm run build -w sorocron-keeper-bot

# ---- runtime: production dependencies and compiled JS only ----------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/react/package.json packages/react/
COPY keeper-bot/package.json keeper-bot/
COPY app/package.json app/
RUN npm ci --omit=dev -w @sorocron/sdk -w sorocron-keeper-bot && npm cache clean --force
COPY --from=build /app/packages/sdk/dist packages/sdk/dist
COPY --from=build /app/keeper-bot/dist keeper-bot/dist
COPY deployments deployments
RUN useradd --create-home --shell /usr/sbin/nologin keeper
USER keeper
WORKDIR /app/keeper-bot
ENV METRICS_PORT=9464
EXPOSE 9464
# /healthz turns 503 when ticks stop succeeding (RPC down, keeper out of XLM).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.METRICS_PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["node", "dist/keeper.js"]
