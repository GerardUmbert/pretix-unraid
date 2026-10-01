#!/bin/sh
# Started by supervisord (see supervisord-tasks.conf). Runs the Celery task
# worker only when the internal Redis is enabled; otherwise idles so that
# supervisord does not restart-loop an optional feature (pretix then runs
# tasks inline in the web process).
if [ "${PRETIX_INTERNAL_REDIS:-true}" != "true" ]; then
  echo "[tasks] disabled: PRETIX_INTERNAL_REDIS is not true, tasks run inline in the web process"
  exec sleep infinity
fi
exec /usr/local/bin/pretix taskworker --concurrency="${PRETIX_CELERY_CONCURRENCY:-4}"
