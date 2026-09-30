#!/bin/bash
# Runs as root (see Dockerfile: USER root, no USER pretixuser override).
# Installs extra pip-installable pretix plugins from PRETIX_PLUGINS
# (comma-separated package names) before handing off to the real pretix
# entrypoint as pretixuser - same user the upstream image runs as.
set -euo pipefail

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
