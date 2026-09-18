#!/usr/bin/env bash
# bin/agy-cmux.sh
#
# Launches Antigravity CLI (agy) inside cmux with a docked live coms-net monitor
# pane directly underneath the agy interface, providing the same continuous
# visibility as the Pi agent harness.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

# Source environment
if [ -z "${PI_COMS_NET_SERVER_URL:-}" ]; then
    if [ -f "$HOME/.pi/coms-net/projects/forge.env" ]; then
        source "$HOME/.pi/coms-net/projects/forge.env"
    elif [ -f "$HOME/.pi/coms-net/env.sh" ]; then
        source "$HOME/.pi/coms-net/env.sh"
    fi
fi

# Ensure build is ready
if [ ! -d "dist" ]; then
    npm run build
fi

# Check if cmux is available
if ! command -v cmux &>/dev/null; then
    echo "cmux not found on PATH. Falling back to standard 'just agy'..."
    exec just agy "$@"
fi

# Detect cmux socket and current surface
CMUX_SOCK="${CMUX_MUX_SOCKET:-}"
CMUX_SURF="${CMUX_MUX_SURFACE:-}"

# If not running directly inside a cmux pane, look for an active cmux session
if [ -z "$CMUX_SOCK" ]; then
    # Try finding active cmux socket
    RUN_SOCKETS=("/run/user/$(id -u)/cmux-$(id -u)/forge-harness.sock" "/run/user/$(id -u)/cmux-$(id -u)/main.sock")
    for s in "${RUN_SOCKETS[@]}"; do
        if [ -S "$s" ]; then
            CMUX_SOCK="$s"
            break
        fi
    done
fi

# If inside cmux, split the current pane down to dock the live monitor
if [ -n "$CMUX_SOCK" ] && [ -n "$CMUX_SURF" ]; then
    # Resolve the pane ID of the current surface
    CURRENT_PANE=$(cmux list-workspaces --socket "$CMUX_SOCK" --json 2>/dev/null | python3 -c "
import json, sys
try:
    data = json.loads(sys.stdin.read())
    surf = int('$CMUX_SURF')
    for ws in data.get('workspaces', []):
        for screen in ws.get('screens', []):
            for pane in screen.get('panes', []):
                for tab in pane.get('tabs', []):
                    if tab.get('surface') == surf:
                        print(pane['id'])
                        sys.exit(0)
except Exception:
    pass
" 2>/dev/null || true)

    if [ -n "$CURRENT_PANE" ]; then
        echo "==> Docking live coms-net monitor underneath agy in cmux..."
        # Split down
        SPLIT_JSON=$(cmux split --socket "$CMUX_SOCK" --pane "$CURRENT_PANE" --dir down --json 2>/dev/null || true)
        BOTTOM_SURF=$(echo "$SPLIT_JSON" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('surface', ''))" 2>/dev/null || true)

        if [ -n "$BOTTOM_SURF" ]; then
            # Adjust split ratio: top 82% (agy), bottom 18% (pool monitor)
            cmux set-ratio --socket "$CMUX_SOCK" --pane "$CURRENT_PANE" --dir down --ratio 0.82 2>/dev/null || true

            # Launch live monitor in the bottom pane
            cmux send --socket "$CMUX_SOCK" --surface "$BOTTOM_SURF" \
                --text "cd '$SCRIPT_DIR' && just monitor" --shell bash 2>/dev/null || true
            printf '\n' | cmux send --socket "$CMUX_SOCK" --surface "$BOTTOM_SURF" 2>/dev/null || true

            # Refocus the top pane for user input in agy
            cmux focus-pane --socket "$CMUX_SOCK" --pane "$CURRENT_PANE" 2>/dev/null || true

            # Register trap to close bottom surface when agy exits
            trap "cmux close-surface --socket '$CMUX_SOCK' --surface '$BOTTOM_SURF' 2>/dev/null || true" EXIT
        fi
    fi
fi

# Launch agy in the current pane
exec agy "$@"
