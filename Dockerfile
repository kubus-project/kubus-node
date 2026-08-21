FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:22-alpine
LABEL org.opencontainers.image.title="kubus Node" \
      org.opencontainers.image.description="Local and distributed Gaussian splatting plus IPFS spatial archive runtime for art.kubus" \
      org.opencontainers.image.source="https://github.com/kubus-project/kubus-node" \
      org.opencontainers.image.version="0.8.0-alpha.1"
WORKDIR /app
ENV NODE_ENV=production
ENV KUBUS_NODE_EXECUTION_MODE=container
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
RUN mkdir -p /var/lib/kubus-node \
	&& chown -R node:node /app /var/lib/kubus-node
USER node
CMD ["node", "dist/src/index.js", "start"]
