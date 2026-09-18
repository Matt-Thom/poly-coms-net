#!/usr/bin/env bash
# setup-mcp.sh — Helper script to register coms-net stdio MCP server with Hermes Agent

set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -P "${SCRIPT_DIR}/../.." && pwd -P)"
MCP_SERVER_PATH="${REPO_ROOT}/bin/coms-net-mcp.js"
HERMES_CONFIG_DIR="${HOME}/.hermes"
HERMES_CONFIG_FILE="${HERMES_CONFIG_DIR}/config.yaml"

DRY_RUN=0
SHOW_HELP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      SHOW_HELP=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [ "$SHOW_HELP" -eq 1 ]; then
  cat << 'EOF'
Usage: setup-mcp.sh [options]

Registers the coms-net stdio MCP server with Hermes Agent.

Options:
  --dry-run   Simulate registration without modifying files or invoking hermes CLI
  -h, --help  Show this help message
EOF
  exit 0
fi

echo "==> Configuring coms-net MCP server for Hermes Agent..."
echo "    Repository Root : ${REPO_ROOT}"
echo "    MCP Server Path : ${MCP_SERVER_PATH}"

# Ensure MCP entrypoint exists
if [ ! -f "${MCP_SERVER_PATH}" ]; then
  echo "Error: MCP server entrypoint not found at ${MCP_SERVER_PATH}" >&2
  exit 1
fi

# Build dist/ if not present
if [ ! -d "${REPO_ROOT}/dist" ]; then
  echo "==> dist/ directory missing. Building project..."
  if [ "$DRY_RUN" -eq 0 ]; then
    (cd "${REPO_ROOT}" && npm run build)
  else
    echo "    [dry-run] Would execute: npm run build in ${REPO_ROOT}"
  fi
fi

# Method 1: Use hermes CLI if available
if command -v hermes &>/dev/null; then
  echo "==> hermes CLI detected on PATH."
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "    [dry-run] Would execute: hermes mcp add coms-net --command node --args \"${MCP_SERVER_PATH}\""
  else
    echo "==> Registering coms-net via 'hermes mcp add'..."
    hermes mcp add coms-net --command node --args "${MCP_SERVER_PATH}" || {
      echo "Warning: 'hermes mcp add' returned non-zero; falling back to direct config update."
    }
  fi
fi

# Method 2: Update or verify ~/.hermes/config.yaml directly
if [ "$DRY_RUN" -eq 1 ]; then
  echo "    [dry-run] Would ensure coms-net entry in ${HERMES_CONFIG_FILE}"
else
  mkdir -p "${HERMES_CONFIG_DIR}"
  if [ -f "${HERMES_CONFIG_FILE}" ]; then
    if grep -q "coms-net:" "${HERMES_CONFIG_FILE}"; then
      echo "==> 'coms-net' already present in ${HERMES_CONFIG_FILE}."
    else
      echo "==> Creating backup: ${HERMES_CONFIG_FILE}.bak"
      cp "${HERMES_CONFIG_FILE}" "${HERMES_CONFIG_FILE}.bak"
      echo "==> Appending coms-net snippet to ${HERMES_CONFIG_FILE}..."
      cat << YAML >> "${HERMES_CONFIG_FILE}"

# Auto-configured by coms-net setup-mcp.sh
mcp_servers:
  coms-net:
    command: "node"
    args:
      - "${MCP_SERVER_PATH}"
    enabled: true
    timeout: 300
    connect_timeout: 60
    supports_parallel_tool_calls: false
    tools:
      include:
        - coms_net_list
        - coms_net_send
        - coms_net_get
        - coms_net_await
YAML
    fi
  else
    echo "==> Creating new ${HERMES_CONFIG_FILE}..."
    cat << YAML > "${HERMES_CONFIG_FILE}"
mcp_servers:
  coms-net:
    command: "node"
    args:
      - "${MCP_SERVER_PATH}"
    enabled: true
    timeout: 300
    connect_timeout: 60
    supports_parallel_tool_calls: false
    tools:
      include:
        - coms_net_list
        - coms_net_send
        - coms_net_get
        - coms_net_await
YAML
  fi
fi

echo "==> Hermes MCP setup for coms-net complete!"
echo "    Verify registration with: hermes mcp list"
