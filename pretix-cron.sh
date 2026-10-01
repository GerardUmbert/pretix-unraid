#!/bin/sh
# Started by supervisord (see supervisord-tasks.conf). Runs pretix's periodic
# jobs (order expiry, reminders, cleanup) every 15 minutes, as pretix's docs
# recommend, when the internal Redis/Celery setup is enabled.
if [ "${PRETIX_INTERNAL_REDIS:-true}" != "true" ]; then
  echo "[cron] disabled: PRETIX_INTERNAL_REDIS is not true"
  exec sleep infinity
fi
while :; do
  /usr/local/bin/pretix cron || echo "[cron] run failed, retrying next round"
  sleep 900
done
