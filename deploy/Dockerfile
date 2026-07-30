# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

RUN mkdir -p /var/lib/kahanyaku \
    && chown node:node /var/lib/kahanyaku

USER node
WORKDIR /var/lib/kahanyaku

EXPOSE 3000
VOLUME ["/var/lib/kahanyaku"]

ENTRYPOINT ["node", "/app/dist/cli/index.js"]
CMD ["mcp-http", "--host", "127.0.0.1", "--port", "3000", "--actor", "agent:remote-mcp", "--data-dir", "/var/lib/kahanyaku"]
