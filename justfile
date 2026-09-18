# Justfile for poly-coms-net
# Poly-harness multi-agent mesh integration & autonomous bridge

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
    # Render pool box at startup (non-blocking — 3s timeout, failures silenced)
    timeout 3 node --input-type=module -e '
    import { discoverHub } from "./dist/protocol/discovery.js";
    import { ComsNetClient } from "./dist/protocol/client.js";
    import { renderComsNetBox } from "./dist/protocol/render.js";
    const hub = await discoverHub();
    const client = new ComsNetClient(hub.config);
    const { agents } = await client.listAgents();
    if (agents.length > 0) {
      console.log(renderComsNetBox({
        agents,
        title: "coms-net",
        useColor: Boolean(process.stdout.isTTY && !process.env.NO_COLOR),
      }));
    }
    ' 2>/dev/null || true
    exec agy "$@"

# Run Antigravity CLI with a live docked coms-net monitor pane below it (in cmux)
agy-live *args:
    #!/usr/bin/env bash
    exec ./bin/agy-cmux.sh "$@"

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
    import { renderComsNetBox } from "./dist/protocol/render.js";
    const hub = await discoverHub();
    const client = new ComsNetClient(hub.config);
    const { agents } = await client.listAgents();
    console.log(renderComsNetBox({
      agents,
      title: "coms-net",
      useColor: Boolean(process.stdout.isTTY && !process.env.NO_COLOR),
    }));
    '

# Run live real-time pool monitor (auto-refreshes on terminal, ideal for cmux split pane)
monitor *args:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -d "dist" ]; then
        npm run build
    fi
    if [ -z "${PI_COMS_NET_SERVER_URL:-}" ]; then
        if [ -f "$HOME/.pi/coms-net/projects/forge.env" ]; then
            source "$HOME/.pi/coms-net/projects/forge.env"
        elif [ -f "$HOME/.pi/coms-net/env.sh" ]; then
            source "$HOME/.pi/coms-net/env.sh"
        fi
    fi
    exec node ./dist/protocol/monitor.js "$@"

# Run test suite
test:
    npm test

