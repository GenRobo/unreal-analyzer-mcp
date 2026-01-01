#!/bin/bash
# Find the latest cursor-server node
CURSOR_NODE=$(ls -t /home/genrobo/.cursor-server/bin/*/node 2>/dev/null | head -1)
if [ -z "$CURSOR_NODE" ]; then
    # Fallback to system node
    CURSOR_NODE=$(which node)
fi

# Auto-initialization paths (set these for your environment)
export UNREAL_ENGINE_PATH="${UNREAL_ENGINE_PATH:-/data/Unreal/Unreal_Engine_5.7.1}"
export UNREAL_CUSTOM_CODEBASE="${UNREAL_CUSTOM_CODEBASE:-/data/Github/GR_UE3DGS}"

exec "$CURSOR_NODE" /data/Github/MCP_Servers/unreal-analyzer-mcp/build/index.js "$@"
