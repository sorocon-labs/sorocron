# Build context is the repository root (docker-compose.yml sets this up),
# because config.ts reads ../deployments/<network>.json by default.
#
#   docker build -f keeper-bot/Dockerfile -t sorocron-keeper .
#   docker run --env-file keeper-bot/.env sorocron-keeper

# ---- deps: full install (incl. devDependencies) for the TypeScript build --
FROM node:22-slim AS deps
WORKDIR /app
COPY keeper-bot/package.json keeper-bot/package-lock.json ./
RUN npm ci

# ---- build: compile TypeScript to plain ESM JS (test files excluded) -----
FROM deps AS build
COPY keeper-bot/tsconfig.json keeper-bot/tsconfig.build.json ./
COPY keeper-bot/src ./src
RUN npx tsc -p tsconfig.build.json

# ---- prod-deps: production-only node_modules ------------------------------
FROM node:22-slim AS prod-deps
WORKDIR /app
COPY keeper-bot/package.json keeper-bot/package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ---------------------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN useradd --create-home --shell /usr/sbin/nologin keeper
COPY --from=prod-deps /app/node_modules ./node_modules
COPY keeper-bot/package.json ./
COPY --from=build /app/dist ./dist
COPY deployments ./deployments
USER keeper
ENTRYPOINT ["node", "dist/keeper.js"]
