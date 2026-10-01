#!/bin/bash
# Runs as root (see Dockerfile: USER root, no USER pretixuser override).
# Installs extra pip-installable pretix plugins from PRETIX_PLUGINS
# (comma-separated package names) before handing off to the real pretix
# entrypoint as pretixuser - same user the upstream image runs as.
set -euo pipefail

# PUID/PGID: remap pretixuser so files in the data volume are owned by the
# host user Unraid expects (default nobody:users, 99:100) - same pattern
# as the LinuxServer.io images. Upstream pretixuser is 15371:15371 and
# owns thousands of files under /pretix (node_modules, static assets that
# updateassets rewrites), so those get re-owned too - once, only when the
# id actually changes, so restarts stay fast.
PUID="${PUID:-99}"
PGID="${PGID:-100}"
old_uid="$(id -u pretixuser)"
old_gid="$(id -g pretixuser)"
if [ "$old_gid" != "$PGID" ]; then
  groupmod -o -g "$PGID" pretixuser
  find / -xdev -group "$old_gid" -exec chgrp -h "$PGID" {} +
fi
if [ "$old_uid" != "$PUID" ]; then
  usermod -o -u "$PUID" pretixuser
  find / -xdev -user "$old_uid" -exec chown -h "$PUID" {} +
fi

# /data is a bind mount (different filesystem, so skipped by -xdev above).
# Only recurse when the top-level owner is wrong - a fresh Unraid appdata
# folder is typically root-owned.
data_dir="${PRETIX_PRETIX_DATADIR:-/data}"
mkdir -p "$data_dir"
if [ "$(stat -c '%u:%g' "$data_dir")" != "$PUID:$PGID" ]; then
  chown -R "$PUID:$PGID" "$data_dir"
fi

# Internal Postgres (see Dockerfile). Runs as pretixuser on a unix socket in
# /run/pretix-pg only, so nothing listens on the network; trust auth is safe
# because only processes inside this container can reach the socket. Started
# here (not under supervisord) because the pretix wrapper migrates the schema
# before supervisord starts, so the DB must already be up.
as_pretix() { setpriv --reuid=pretixuser --regid=pretixuser --clear-groups "$@"; }
PGBIN=/usr/lib/postgresql/17/bin
pgdata="$data_dir/postgres"
pg_running=false

pg_stop() {
  if [ "$pg_running" = true ]; then
    as_pretix "$PGBIN/pg_ctl" -D "$pgdata" -m fast -w stop || true
    pg_running=false
  fi
}

if [ "${PRETIX_INTERNAL_POSTGRES:-true}" = "true" ]; then
  mkdir -p /run/pretix-pg
  chown pretixuser /run/pretix-pg
  fresh_cluster=false
  if [ ! -s "$pgdata/PG_VERSION" ]; then
    echo "[postgres] Initialising a new cluster in $pgdata..."
    rm -rf "$pgdata"
    mkdir -p "$pgdata"
    chown pretixuser "$pgdata"
    chmod 700 "$pgdata"
    as_pretix "$PGBIN/initdb" -D "$pgdata" -U pretixuser --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null
    fresh_cluster=true
  fi
  echo "[postgres] Starting..."
  as_pretix "$PGBIN/pg_ctl" -D "$pgdata" -w -t 120 -l "$pgdata/server.log" \
    -o "-c listen_addresses='' -c unix_socket_directories=/run/pretix-pg -c synchronous_commit=off" start
  pg_running=true
  if [ "$fresh_cluster" = true ]; then
    as_pretix "$PGBIN/createdb" -h /run/pretix-pg -U pretixuser pretix

    # Existing SQLite data (users, teams, API tokens, events...) is copied
    # over once. The .sqlite3 file itself is only renamed after a
    # successful load, so a failure leaves the old data intact.
    if [ -s "$data_dir/db.sqlite3" ]; then
      echo "[postgres] Found $data_dir/db.sqlite3, copying its data into Postgres..."
      dump="$(mktemp --suffix=.json /tmp/pretix-sqlite-dump.XXXXXX)"
      chown pretixuser "$dump"
      copy_code="exec(open('/usr/local/bin/pretix-db-copy.py').read())"
      if as_pretix env -u PRETIX_DATABASE_NAME -u PRETIX_DATABASE_USER -u PRETIX_DATABASE_HOST \
            PRETIX_DATABASE_BACKEND=sqlite3 PRETIX_COPY_MODE=dump PRETIX_COPY_FILE="$dump" \
            python3 -m pretix shell -c "$copy_code" \
         && as_pretix python3 -m pretix migrate --noinput \
         && as_pretix env PRETIX_COPY_MODE=load PRETIX_COPY_FILE="$dump" \
            python3 -m pretix shell -c "$copy_code"; then
        mv "$data_dir/db.sqlite3" "$data_dir/db.sqlite3.migrated"
        echo "[postgres] Copy done; the old file is kept as db.sqlite3.migrated."
      else
        echo "[postgres] ERROR: copying SQLite data failed. The old db.sqlite3 is untouched." >&2
        echo "[postgres] Set PRETIX_INTERNAL_POSTGRES=false to keep using SQLite." >&2
        pg_stop
        rm -rf "$pgdata"
        rm -f "$dump"
        exit 1
      fi
      rm -f "$dump"
    fi
  fi
else
  echo "[postgres] PRETIX_INTERNAL_POSTGRES=false: using SQLite in $data_dir/db.sqlite3"
  unset PRETIX_DATABASE_BACKEND PRETIX_DATABASE_NAME PRETIX_DATABASE_USER PRETIX_DATABASE_HOST
fi

# Internal Redis (see Dockerfile): cache, sessions and Celery broker for the
# task worker that supervisord runs. Unix socket only (nothing listens on the
# network) and no persistence - losing queued jobs on a restart is fine for a
# test instance. pretix picks it all up from PRETIX_<SECTION>_<KEY> env vars,
# which are exported here so supervisord's child processes inherit them.
redis_running=false
redis_sock=/run/pretix-redis/redis.sock

redis_stop() {
  if [ "$redis_running" = true ]; then
    as_pretix /usr/bin/redis-cli -s "$redis_sock" shutdown nosave || true
    redis_running=false
  fi
}

if [ "${PRETIX_INTERNAL_REDIS:-true}" = "true" ]; then
  mkdir -p /run/pretix-redis
  chown pretixuser /run/pretix-redis
  echo "[redis] Starting..."
  as_pretix /usr/bin/redis-server --port 0 --unixsocket "$redis_sock" --unixsocketperm 700     --save "" --appendonly no --dir /run/pretix-redis --daemonize yes     --logfile /run/pretix-redis/redis.log >/dev/null
  for _ in $(seq 1 50); do
    as_pretix /usr/bin/redis-cli -s "$redis_sock" ping >/dev/null 2>&1 && break
    sleep 0.2
  done
  if ! as_pretix /usr/bin/redis-cli -s "$redis_sock" ping >/dev/null 2>&1; then
    echo "[redis] ERROR: did not start. Set PRETIX_INTERNAL_REDIS=false to run without it." >&2
    cat /run/pretix-redis/redis.log >&2 || true
    pg_stop
    exit 1
  fi
  redis_running=true
  export PRETIX_REDIS_LOCATION="unix://$redis_sock?db=0"
  export PRETIX_REDIS_SESSIONS=true
  export PRETIX_CELERY_BROKER="redis+socket://$redis_sock?virtual_host=1"
  export PRETIX_CELERY_BACKEND="redis+socket://$redis_sock?virtual_host=2"
else
  echo "[redis] PRETIX_INTERNAL_REDIS=false: no Redis/Celery, tasks run inline in the web process"
fi

if [ -n "${PRETIX_PLUGINS:-}" ]; then
  IFS=',' read -ra plugins <<< "$PRETIX_PLUGINS"
  for plugin in "${plugins[@]}"; do
    plugin="$(echo "$plugin" | xargs)" # trim whitespace
    [ -z "$plugin" ] && continue
    echo "[plugins] Installing $plugin..."
    pip3 install --no-cache-dir "$plugin"
  done

  # Django migrations are idempotent, so it's safe to run this here even
  # though "pretix all" below runs its own migrate too - this pass is
  # only to get tables in place (first boot) before updateassets, which
  # needs a working DB connection to read settings from.
  echo "[plugins] Running migrations before asset rebuild..."
  setpriv --reuid=pretixuser --regid=pretixuser --clear-groups \
    python3 -m pretix migrate --noinput

  echo "[plugins] Rebuilding static assets after plugin install..."
  setpriv --reuid=pretixuser --regid=pretixuser --clear-groups \
    python3 -m pretix updateassets
fi

if [ "$pg_running" != true ] && [ "$redis_running" != true ]; then
  exec setpriv --reuid=pretixuser --regid=pretixuser --clear-groups \
    /usr/local/bin/pretix "$@"
fi

# Postgres needs a clean shutdown, so stay around as the parent: forward
# stop signals to pretix and stop Redis and Postgres once it has exited.
as_pretix /usr/local/bin/pretix "$@" &
child=$!
trap 'kill -TERM "$child" 2>/dev/null || true' TERM INT
status=0
while :; do
  if wait "$child"; then status=0; break; fi
  status=$?
  kill -0 "$child" 2>/dev/null || break
done
trap - TERM INT
redis_stop
pg_stop
exit "$status"
