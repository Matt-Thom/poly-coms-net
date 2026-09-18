/**
 * src/protocol/monitor.ts
 *
 * Live terminal monitor for the coms-net mesh pool.
 * Continuously polls the hub and renders the pool box with right-aligned
 * status flags and truecolor ANSI formatting, updating in real time.
 * Designed to run as a docked companion pane in cmux or a split terminal.
 */

import { discoverHubSync } from "./discovery.ts";
import { ComsNetClient } from "./client.ts";
import { renderComsNetBox } from "./render.ts";
import type { AgentCard } from "./types.ts";

export interface MonitorOptions {
  project?: string;
  serverUrl?: string;
  authToken?: string;
  intervalMs?: number;
  agentName?: string;
  showRightFlag?: boolean;
}

export async function runMonitor(opts: MonitorOptions = {}): Promise<void> {
  const interval = opts.intervalMs ?? 1500;
  const agentName = opts.agentName ?? "antigravity";

  let discovery;
  try {
    discovery = discoverHubSync({
      project: opts.project,
      serverUrl: opts.serverUrl,
      authToken: opts.authToken,
    });
  } catch (err: unknown) {
    console.error(`[monitor] Discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const client = new ComsNetClient({
    baseUrl: discovery.config.baseUrl,
    authToken: discovery.config.authToken,
    project: discovery.config.project,
  });

  // Hide cursor on start
  process.stdout.write("\x1b[?25l");

  const cleanup = () => {
    // Show cursor and clear formatting on exit
    process.stdout.write("\x1b[?25h\n");
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  let lastBox = "";

  const renderCycle = async () => {
    try {
      const res = await client.listAgents();
      const cols = process.stdout.columns || 80;
      const useColor = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);

      const box = renderComsNetBox({
        agents: res.agents,
        currentAgentName: agentName,
        width: cols,
        useColor,
        showRightFlag: opts.showRightFlag ?? true,
      });

      if (box !== lastBox) {
        // Move cursor to top-left and clear to end of screen for flicker-free render
        process.stdout.write(`\x1b[H\x1b[2J${box}\n`);
        lastBox = box;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(
        `\x1b[H\x1b[2J[coms-net monitor] Hub unreachable: ${msg} (retrying...)\n`
      );
    }
  };

  // Initial immediate render
  await renderCycle();

  // Polling loop
  const timer = setInterval(renderCycle, interval);

  // Keep alive
  await new Promise<void>(() => {});
}

// CLI auto-run
if (process.argv[1]?.endsWith("monitor.ts") || process.argv[1]?.endsWith("monitor.js")) {
  runMonitor().catch((err) => {
    process.stdout.write("\x1b[?25h\n");
    console.error(err);
    process.exit(1);
  });
}
