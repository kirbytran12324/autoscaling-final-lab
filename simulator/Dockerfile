FROM node:24.20.0-bookworm-slim AS test

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts

COPY src ./src
COPY test ./test

RUN npm test


FROM node:24.20.0-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

WORKDIR /app

COPY --from=test /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

USER node

EXPOSE 3000

HEALTHCHECK \
  --interval=30s \
  --timeout=3s \
  --start-period=10s \
  --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health/live').then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "src/server.js"]