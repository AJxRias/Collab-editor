# One image: the Node server serves the API, the WebSocket endpoint and the built client.
#   docker build -t collab-editor .
#   docker run -p 4000:4000 collab-editor            # in-memory, single instance
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY server/package.json server/
COPY client/package.json client/
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci
COPY server server
COPY client client
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    STATIC_DIR=/app/client/dist \
    PORT=4000
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci -w server --omit=dev && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
USER node
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" || exit 1
CMD ["node", "server/dist/index.js"]
