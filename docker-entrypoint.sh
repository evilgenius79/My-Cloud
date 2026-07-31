#!/bin/sh
# Drop from root to an unprivileged user before running the app. Uses the
# Unraid-standard PUID/PGID/UMASK so files land with the operator's ownership
# instead of root:root. Defaults are Unraid's nobody:users (99:100).
set -e

PUID="${PUID:-99}"
PGID="${PGID:-100}"
umask "${UMASK:-022}"

for d in /config /data; do
  mkdir -p "$d"
  # Recursively fix ownership only when the top-level owner doesn't already
  # match (first run, or PUID/PGID changed) — steady-state restarts skip it,
  # so a large /data mount isn't re-chowned every boot.
  if [ "$(stat -c %u "$d" 2>/dev/null)" != "$PUID" ] || [ "$(stat -c %g "$d" 2>/dev/null)" != "$PGID" ]; then
    echo "my-cloud: setting ownership of $d to ${PUID}:${PGID}…"
    chown -R "$PUID:$PGID" "$d" 2>/dev/null || echo "my-cloud: warning: could not chown $d (continuing)"
  fi
done

# su-exec accepts a numeric uid:gid directly — no user account needed.
exec su-exec "${PUID}:${PGID}" node server/index.js
