# Justfile for antigravity-coms-net
# Multi-agent mesh integration for Google Antigravity CLI (agy)

set positional-arguments := true

# Default recipe: list available recipes
default:
    @just --list

# Compile TypeScript project to dist/
build:
    npm run build

# Run Antigravity CLI (agy) connected to the active coms-net mesh
agy *args:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -d "dist" ]; then
        echo "==> dist/ missing, running build..."
        npm run build
    fi
    if [ -z "${PI_COMS_NET_SERVER_URL:-}" ]; then
        if [ -f "$HOME/.pi/coms-net/projects/forge.env" ]; then
            source "$HOME/.pi/coms-net/projects/forge.env"
        elif [ -f "$HOME/.pi/coms-net/env.sh" ]; then
            source "$HOME/.pi/coms-net/env.sh"
        fi
    fi
    echo "==> Launching agy connected to coms-net (project: ${PI_COMS_NET_PROJECT:-default}, hub: ${PI_COMS_NET_SERVER_URL:-auto-discovery})"
    exec agy "$@"

# Run the Bridge Daemon (worker) connected to the active coms-net mesh
bridge *args:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -d "dist" ]; then
        echo "==> dist/ missing, running build..."
        npm run build
    fi
    if [ -z "${PI_COMS_NET_SERVER_URL:-}" ]; then
        if [ -f "$HOME/.pi/coms-net/projects/forge.env" ]; then
            source "$HOME/.pi/coms-net/projects/forge.env"
        elif [ -f "$HOME/.pi/coms-net/env.sh" ]; then
            source "$HOME/.pi/coms-net/env.sh"
        fi
    fi
    echo "==> Starting coms-net bridge daemon (project: ${PI_COMS_NET_PROJECT:-default})"
    exec ./bin/coms-net-bridge.js "$@"

# Query and display online peer agents on the current coms-net mesh
peers:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -z "${PI_COMS_NET_SERVER_URL:-}" ]; then
        if [ -f "$HOME/.pi/coms-net/projects/forge.env" ]; then
            source "$HOME/.pi/coms-net/projects/forge.env"
        elif [ -f "$HOME/.pi/coms-net/env.sh" ]; then
            source "$HOME/.pi/coms-net/env.sh"
        fi
    fi
    node --input-type=module -e '
    import { discoverHub } from "./dist/protocol/discovery.js";
    import { ComsNetClient } from "./dist/protocol/client.js";
    const hub = await discoverHub();
    const client = new ComsNetClient(hub.config);
    const { agents } = await client.listAgents();
    console.log(`Connected to hub at ${hub.config.baseUrl} [project: ${hub.config.project}]`);
    console.log(`Online peers (${agents.length}):`);
    for (const a of agents) {
      const mark = a.status === "online" ? "●" : "~";
      console.log(`  ${mark} ${a.name} (${a.model}) — ${a.purpose}`);
    }
    '

# Run test suite
test:
    npm test
