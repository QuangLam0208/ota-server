FROM node:20-slim

WORKDIR /app

# Install dependencies first so this layer is cached unless package*.json changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application source.
COPY helpers.js server.js ./

# Published updates live here — mount a volume at this path to persist them
# across container restarts/recreates (see docker-compose.yml).
RUN mkdir -p /app/updates
VOLUME /app/updates

ENV PORT=3001
EXPOSE 3001

# PUBLISH_TOKEN must be provided at runtime (-e / --env-file / compose
# environment), not baked into the image.
CMD ["node", "server.js"]
