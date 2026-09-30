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

exec setpriv --reuid=pretixuser --regid=pretixuser --clear-groups \
  /usr/local/bin/pretix "$@"
