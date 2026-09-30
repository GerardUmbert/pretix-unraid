# Wraps the official pretix/standalone image with a first-boot plugin
# installer, driven by the PRETIX_PLUGINS env var (comma-separated pip
# package names, e.g. "pretix-passbook,pretix-someplugin"). Empty by
# default - installs nothing extra unless PRETIX_PLUGINS is set.
#
# Why runtime install instead of baking plugins in at build time: on
# Unraid, changing the plugin list this way is just editing the
# container's env var and restarting it, no image rebuild needed.
FROM pretix/standalone:stable

# Config defaults via pretix's PRETIX_<SECTION>_<KEY> env vars, so no
# pretix.cfg needs to be mounted. SQLite is pretix's default backend and
# the DB lands in <datadir>/db.sqlite3. PRETIX_PRETIX_URL is deliberately
# not set here - it is host-specific and comes from the Unraid template.
ENV PRETIX_PRETIX_DATADIR=/data \
    PRETIX_PRETIX_INSTANCE_NAME=pretix-test

USER root
COPY docker-entrypoint-plugins.sh /usr/local/bin/docker-entrypoint-plugins.sh
RUN chmod +x /usr/local/bin/docker-entrypoint-plugins.sh

# Stays as root: the entrypoint needs root to pip-install into
# site-packages, then drops to pretixuser itself via setpriv before
# running pretix. Do not add "USER pretixuser" here.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint-plugins.sh"]
CMD ["web"]
