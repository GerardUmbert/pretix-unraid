# Wraps the official pretix/standalone image with a first-boot plugin
# installer, driven by the PRETIX_PLUGINS env var (comma-separated pip
# package names, e.g. "pretix-passbook,pretix-someplugin"). Empty by
# default - installs nothing extra unless PRETIX_PLUGINS is set.
#
# Why runtime install instead of baking plugins in at build time: on
# Unraid, changing the plugin list this way is just editing the
# container's env var and restarting it, no image rebuild needed.
# Build stage for the bundled MCP server (mcp/). Only the compiled output and
# production dependencies are copied into the final image below.
FROM node:22-bookworm-slim AS mcp-build
WORKDIR /mcp
COPY mcp/package.json mcp/package-lock.json ./
RUN npm ci
COPY mcp/tsconfig.json ./
COPY mcp/src ./src
RUN npm run build && npm prune --omit=dev

FROM pretix/standalone:stable

# Config defaults via pretix's PRETIX_<SECTION>_<KEY> env vars, so no
# pretix.cfg needs to be mounted. PRETIX_PRETIX_URL is deliberately not set
# here - it is host-specific and comes from the Unraid template.
#
# Database: a Postgres 17 installed below runs inside this container (started
# by docker-entrypoint-plugins.sh, data in /data/postgres) and pretix talks to
# it over a unix socket only - no TCP port is opened or published. SQLite hit
# "database is locked" once several workers wrote at the same time. Set
# PRETIX_INTERNAL_POSTGRES=false to fall back to the old SQLite file
# (/data/db.sqlite3). NUM_WORKERS caps the base image's 2 x CPU cores default.
#
# Redis + Celery: a Redis installed below also runs inside this container
# (unix socket only, no persistence) and serves as cache, session store and
# Celery broker. A Celery task worker and the periodic-task runner
# (order expiry etc.) run under supervisord, so slow jobs such as big order
# imports run in the background instead of inside the web request. Set
# PRETIX_INTERNAL_REDIS=false to go back to running tasks inline with no
# Redis (see docker-entrypoint-plugins.sh for the env vars it exports).
ENV PRETIX_PRETIX_DATADIR=/data \
    PRETIX_PRETIX_INSTANCE_NAME=pretix-test \
    PRETIX_DATABASE_BACKEND=postgresql \
    PRETIX_DATABASE_NAME=pretix \
    PRETIX_DATABASE_USER=pretixuser \
    PRETIX_DATABASE_HOST=/run/pretix-pg \
    NUM_WORKERS=4

USER root
RUN mkdir -p /etc/postgresql-common \
 && echo 'create_main_cluster = false' > /etc/postgresql-common/createcluster.conf \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql redis-server \
 && rm -rf /var/lib/apt/lists/* \
 && test -x /usr/lib/postgresql/17/bin/initdb \
 && test -x /usr/bin/redis-server
COPY docker-entrypoint-plugins.sh /usr/local/bin/docker-entrypoint-plugins.sh
COPY pretix-db-copy.py /usr/local/bin/pretix-db-copy.py
RUN chmod +x /usr/local/bin/docker-entrypoint-plugins.sh

# Bundled pretix MCP server (base image already ships Node). Two ways in:
#   - HTTP: supervised on 127.0.0.1:3000 and exposed by nginx at /mcp, only
#     when PRETIX_MCP_TOKEN (bearer secret), PRETIX_API_TOKEN and
#     PRETIX_ORGANIZER are all set; the node process rejects requests
#     without the secret.
#   - stdio: docker exec -i pretix node /opt/pretix-mcp/dist/index.js
COPY --from=mcp-build /mcp/dist /opt/pretix-mcp/dist
COPY --from=mcp-build /mcp/node_modules /opt/pretix-mcp/node_modules
COPY mcp/package.json /opt/pretix-mcp/package.json
COPY pretix-mcp-http.sh /usr/local/bin/pretix-mcp-http.sh
COPY pretix-task.sh /usr/local/bin/pretix-task.sh
COPY pretix-cron.sh /usr/local/bin/pretix-cron.sh
COPY supervisord-mcp.conf /etc/supervisord/pretixmcp.conf
COPY supervisord-tasks.conf /etc/supervisord/pretixtasks.conf
COPY nginx-mcp-location.conf /tmp/nginx-mcp-location.conf
RUN chmod +x /usr/local/bin/pretix-mcp-http.sh /usr/local/bin/pretix-task.sh /usr/local/bin/pretix-cron.sh \
 && sed -i 's#pretixweb.conf#pretixweb.conf /etc/supervisord/pretixmcp.conf /etc/supervisord/pretixtasks.conf#' /etc/supervisord.web.conf \
 && awk '/^        location \/ \{/ && !done { while ((getline line < "/tmp/nginx-mcp-location.conf") > 0) print line; done=1 } { print }' /etc/nginx/nginx.conf > /tmp/nginx.conf.new \
 && mv /tmp/nginx.conf.new /etc/nginx/nginx.conf \
 && rm /tmp/nginx-mcp-location.conf \
 && grep -q 'location = /mcp' /etc/nginx/nginx.conf \
 && grep -q pretixmcp.conf /etc/supervisord.web.conf \
 && grep -q pretixtasks.conf /etc/supervisord.web.conf

# nginx listens on 8345 instead of 80 so the container port equals the host
# port in the Unraid template. Unraid's Tailscale Serve/Funnel hook proxies
# to localhost:<host-mapped port> from inside the container, so an 8345->80
# mapping leaves it pointing at a port nothing listens on.
RUN sed -i 's/listen 80 /listen 8345 /; s/listen \[::\]:80 /listen [::]:8345 /' /etc/nginx/nginx.conf \
 && test "$(grep -c 'listen .*8345' /etc/nginx/nginx.conf)" = 2

# Stays as root: the entrypoint needs root to pip-install into
# site-packages, then drops to pretixuser itself via setpriv before
# running pretix. Do not add "USER pretixuser" here.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint-plugins.sh"]
CMD ["web"]
