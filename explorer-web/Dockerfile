FROM node:24.20.0-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts index.html ./
COPY src ./src
COPY scripts ./scripts
COPY vendor ./vendor
COPY public ./public
ARG VITE_SHOWDOWN_ASSET_BASE_URL=https://play.pokemonshowdown.com/
RUN npm run build

FROM nginx:1.27.4-alpine AS runtime

COPY nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/dist /usr/share/nginx/html

USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["wget", "-qO-", "http://127.0.0.1:8080/health/live"]

CMD ["nginx", "-g", "daemon off;"]
