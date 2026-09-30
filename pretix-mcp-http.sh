#!/bin/sh
# Started by supervisord (see supervisord-mcp.conf). Runs the bundled MCP
# HTTP server only when it is fully configured; otherwise idles so that
# supervisord does not restart-loop an optional feature.
if [ -n "$PRETIX_MCP_TOKEN" ] && [ -n "$PRETIX_API_TOKEN" ] && [ -n "$PRETIX_ORGANIZER" ]; then
  exec node /opt/pretix-mcp/dist/http.js
fi
echo "[mcp] disabled: set PRETIX_MCP_TOKEN, PRETIX_API_TOKEN and PRETIX_ORGANIZER to enable /mcp"
exec sleep infinity
