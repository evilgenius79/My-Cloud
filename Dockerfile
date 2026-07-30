FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    MYCLOUD_CONFIG_DIR=/config \
    MYCLOUD_DATA_DIR=/data \
    MYCLOUD_PORT=8686

VOLUME ["/config", "/data"]
EXPOSE 8686

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:8686/api/status || exit 1

CMD ["node", "server/index.js"]
