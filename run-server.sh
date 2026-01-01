#!/bin/bash
# Find the latest cursor-server node
CURSOR_NODE=$(ls -t /home/genrobo/.cursor-server/bin/*/node 2>/dev/null | head -1)
if [ -z "$CURSOR_NODE" ]; then
    # Fallback to system node
    CURSOR_NODE=$(which node)
fi
exec "$CURSOR_NODE" /data/Github/MCP_Servers/unreal-analyzer-mcp/build/index.js "$@"
