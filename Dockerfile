# Pinned to the 22 LTS alpine line. (Consider pinning by @sha256 digest in a
# release pipeline for fully reproducible builds.)
FROM node:22-alpine

WORKDIR /app

# su-exec lets the entrypoint drop from root to PUID:PGID before running node.
RUN apk add --no-cache su-exec

# Deterministic install from the committed lockfile.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV NODE_ENV=production \
    MYCLOUD_CONFIG_DIR=/config \
    MYCLOUD_DATA_DIR=/data \
    MYCLOUD_PORT=8686 \
    PUID=99 \
    PGID=100 \
    UMASK=022

VOLUME ["/config", "/data"]
EXPOSE 8686

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:8686/api/status || exit 1

# Starts as root only to fix volume ownership, then execs node as PUID:PGID.
ENTRYPOINT ["/docker-entrypoint.sh"]
