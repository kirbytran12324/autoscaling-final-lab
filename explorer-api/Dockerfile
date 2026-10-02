FROM node:24.20.0-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001

WORKDIR /app

COPY simulator/package.json simulator/package-lock.json ./simulator/
RUN cd simulator && npm ci --omit=dev --ignore-scripts
COPY --chown=node:node simulator/src ./simulator/src
COPY --chown=node:node explorer-api/package.json ./explorer-api/package.json
COPY --chown=node:node explorer-api/src ./explorer-api/src

USER node
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "explorer-api/src/server.js"]
