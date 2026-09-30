#!/bin/sh
# Started by supervisord (see supervisord-mcp.conf). Runs the bundled MCP
# HTTP server only when it is fully configured; otherwise idles so that
# supervisord does not restart-loop an optional feature.
if [ -z "$PRETIX_MCP_TOKEN" ] || [ -z "$PRETIX_API_TOKEN" ] || [ -z "$PRETIX_ORGANIZER" ]; then
  echo "[mcp] disabled: set PRETIX_MCP_TOKEN, PRETIX_API_TOKEN and PRETIX_ORGANIZER to enable /mcp"
  exec sleep infinity
fi
if [ "${#PRETIX_MCP_TOKEN}" -lt 24 ]; then
  echo "[mcp] disabled: PRETIX_MCP_TOKEN is only ${#PRETIX_MCP_TOKEN} characters; it must be at least 24 (use a long random secret)"
  exec sleep infinity
fi
exec node /opt/pretix-mcp/dist/http.js
