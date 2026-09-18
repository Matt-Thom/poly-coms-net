/**
 * tests/unit/render.test.ts
 *
 * Unit tests for coms-net terminal box renderer:
 * - Exact visual rendering matching Pi agent harness
 * - Model abbreviation & progress bar formatting
 * - Status bullets & right-aligned status flags
 * - Header border with current agent tag and width calculation
 * - ANSI color & plain text modes
 * - Peer filtering & explicit agent gating
 * - BridgeDaemon peer pool tracking & renderPool() integration
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderComsNetBox,
  renderComsNetBoxLines,
  formatProgressBar,
  abbreviateModel,
  stripAnsi,
  visibleWidth,
  truncateToWidth,
  colorizeHex,
  isValidHex,
} from "../../src/protocol/render.ts";
import type { AgentCard } from "../../src/protocol/types.ts";
import { parseCliArgs, getHelpText } from "../../src/cli.ts";

describe("ComsNetBox Renderer Unit Tests", () => {
  // ━━ Sample dataset matching Pi agent harness prompt ━━━━━━━━━━━━━━━━━━━━━━
  const forgeAgents: AgentCard[] = [
    {
      session_id: "01J7CHEAP00000000000000001",
      name: "cheap",
      model: "gemini-3.5-flash-lite",
      color: "#72F1B8",
      purpose: "Forge cheap lane (google gemini-3.5-flash-lite, no local GPU)",
      cwd: "/workspace/cheap",
      project: "forge",
      explicit: false,
      started_at: "2026-09-16T00:00:00Z",
      context_used_pct: 0,
      queue_depth: 0,
      status: "online",
    },
    {
      session_id: "01J7IMPL000000000000000002",
      name: "impl",
      model: "grok-4.6",
      color: "#36F9F6",
      purpose: "Forge implementer — only product writer",
      cwd: "/workspace/impl",
      project: "forge",
      explicit: false,
      started_at: "2026-09-16T00:00:00Z",
      context_used_pct: 27,
      queue_depth: 0,
      status: "online",
    },
    {
      session_id: "01J7ORCH000000000000000003",
      name: "orch",
      model: "MiniMax-M3",
      color: "#FF7EDB",
      purpose: "Forge orchestrator / gatekeeper — never writes product code",
      cwd: "/workspace/orch",
      project: "forge",
      explicit: false,
      started_at: "2026-09-16T00:00:00Z",
      context_used_pct: 13,
      queue_depth: 0,
      status: "online",
    },
    {
      session_id: "01J7REV0000000000000000004",
      name: "rev",
      model: "gemini-3.8-flash-lite",
      color: "#FEDE5D",
      purpose: "Forge reviewer (read-only)",
      cwd: "/workspace/rev",
      project: "forge",
      explicit: false,
      started_at: "2026-09-16T00:00:00Z",
      context_used_pct: 0,
      queue_depth: 0,
      status: "online",
    },
  ];

  it("R1: should accurately render the exact coms-net box from the Pi agent harness", () => {
    const box = renderComsNetBox({
      agents: forgeAgents,
      currentAgentName: "intake",
      useColor: false,
      width: 140,
    });

    const lines = box.split("\n");
    assert.strictEqual(lines.length, 6); // top + 4 agents + bottom

    // Check top border
    assert.ok(lines[0].startsWith("┏━ coms-net ━"));
    assert.ok(lines[0].endsWith(" intake ━┓"));
    assert.strictEqual(visibleWidth(lines[0]), 140);

    // Check row 1: cheap
    assert.ok(
      lines[1].includes(
        " ● cheap        gemini-3.5-fla [---------------]   0%  —  Forge cheap lane (google gemini-3.5-flash-lite, no local GPU)"
      )
    );

    // Check row 2: impl
    assert.ok(
      lines[2].includes(
        " ● impl         grok-4.6       [####-----------]  27%  —  Forge implementer — only product writer"
      )
    );

    // Check row 3: orch
    assert.ok(
      lines[3].includes(
        " ● orch         MiniMax-M3     [##-------------]  13%  —  Forge orchestrator / gatekeeper — never writes product code"
      )
    );

    // Check row 4: rev
    assert.ok(
      lines[4].includes(
        " ● rev          gemini-3.8-fla [---------------]   0%  —  Forge reviewer (read-only)"
      )
    );

    // Check bottom border
    assert.strictEqual(lines[5], "┗" + "━".repeat(138) + "┛");
    assert.strictEqual(visibleWidth(lines[5]), 140);
  });

  it("R2: should render empty state when no peers are connected", () => {
    const box = renderComsNetBox({
      agents: [],
      currentAgentName: "orchestrator",
      useColor: false,
      width: 80,
    });

    const lines = box.split("\n");
    assert.strictEqual(lines.length, 3);
    assert.ok(lines[0].startsWith("┏━ coms-net ━"));
    assert.ok(lines[0].endsWith(" orchestrator ━┓"));
    assert.ok(lines[1].includes("no peers connected"));
    assert.strictEqual(lines[2], "┗" + "━".repeat(78) + "┛");
  });

  it("R3: should abbreviate model IDs properly", () => {
    assert.strictEqual(abbreviateModel("claude-3-5-sonnet-20241022"), "3-5-sonnet-202");
    assert.strictEqual(abbreviateModel("claude-opus-4-7"), "opus-4-7");
    assert.strictEqual(abbreviateModel("gemini-3.5-flash-lite"), "gemini-3.5-fla");
    assert.strictEqual(abbreviateModel("grok-4.6"), "grok-4.6");
    assert.strictEqual(abbreviateModel("MiniMax-M3"), "MiniMax-M3");
    assert.strictEqual(abbreviateModel(""), "");
    assert.strictEqual(abbreviateModel(undefined), "");
  });

  it("R4: should compute context progress bars with accurate fills", () => {
    // 0% -> all empty
    const p0 = formatProgressBar(0);
    assert.strictEqual(p0.bar, "[---------------]");
    assert.strictEqual(p0.pctLabel, "0%");

    // 27% of 15 chars = 4.05 -> 4 filled
    const p27 = formatProgressBar(27);
    assert.strictEqual(p27.bar, "[####-----------]");
    assert.strictEqual(p27.pctLabel, "27%");

    // 13% of 15 chars = 1.95 -> 2 filled
    const p13 = formatProgressBar(13);
    assert.strictEqual(p13.bar, "[##-------------]");
    assert.strictEqual(p13.pctLabel, "13%");

    // 100% -> all filled
    const p100 = formatProgressBar(100);
    assert.strictEqual(p100.bar, "[###############]");
    assert.strictEqual(p100.pctLabel, "100%");

    // null / undefined -> pending
    const pNull = formatProgressBar(null);
    assert.strictEqual(pNull.bar, "[---------------]");
    assert.strictEqual(pNull.pctLabel, "--%");
  });

  it("R5: should format status bullets for online, stale, and offline agents", () => {
    const mixedAgents: AgentCard[] = [
      {
        ...forgeAgents[0],
        name: "agent-online",
        status: "online",
      },
      {
        ...forgeAgents[1],
        name: "agent-stale",
        status: "stale",
      },
      {
        ...forgeAgents[2],
        name: "agent-offline",
        status: "offline",
      },
    ];

    const box = renderComsNetBox({
      agents: mixedAgents,
      useColor: false,
    });

    assert.ok(box.includes(" ● agent-online"));
    assert.ok(box.includes(" ~ agent-stale"));
    assert.ok(box.includes(" ✗ agent-offline"));
  });

  it("R6: should filter out caller session ID and explicit agents by default", () => {
    const agentsWithCallerAndExplicit: AgentCard[] = [
      ...forgeAgents,
      {
        session_id: "01J7CALLER0000000000000000",
        name: "intake",
        model: "gemini-3.7-flash",
        color: "#ffffff",
        purpose: "Caller self",
        cwd: "/",
        project: "forge",
        explicit: false,
        started_at: "2026-09-16T00:00:00Z",
        context_used_pct: 5,
        queue_depth: 0,
        status: "online",
      },
      {
        session_id: "01J7HIDDEN00000000000000000",
        name: "hidden-worker",
        model: "gpt-4o",
        color: "#ffffff",
        purpose: "Explicit agent",
        cwd: "/",
        project: "forge",
        explicit: true,
        started_at: "2026-09-16T00:00:00Z",
        context_used_pct: 0,
        queue_depth: 0,
        status: "online",
      },
    ];

    // Default: caller session filtered, explicit filtered
    const box1 = renderComsNetBox({
      agents: agentsWithCallerAndExplicit,
      currentSessionId: "01J7CALLER0000000000000000",
      currentAgentName: "intake",
      useColor: false,
    });
    assert.ok(!box1.includes(" ● intake "));
    assert.ok(!box1.includes("hidden-worker"));

    // With includeExplicit: true
    const box2 = renderComsNetBox({
      agents: agentsWithCallerAndExplicit,
      currentSessionId: "01J7CALLER0000000000000000",
      includeExplicit: true,
      useColor: false,
    });
    assert.ok(box2.includes("hidden-worker"));
  });

  it("R7: should support right status flags (ON, STALE, OFF)", () => {
    const box = renderComsNetBox({
      agents: [
        { ...forgeAgents[0], status: "online" },
        { ...forgeAgents[1], status: "stale" },
        { ...forgeAgents[2], status: "offline" },
      ],
      width: 140,
      showRightFlag: true,
      useColor: false,
    });

    const lines = box.split("\n");
    assert.ok(lines[1].endsWith("    ON"));
    assert.ok(lines[2].endsWith(" STALE"));
    assert.ok(lines[3].endsWith("   OFF"));
  });

  it("R8: should support ANSI 24-bit truecolor sequences in useColor mode", () => {
    const box = renderComsNetBox({
      agents: [forgeAgents[0]],
      currentAgentName: "intake",
      currentAgentColor: "#72F1B8",
      useColor: true,
      width: 120,
    });

    // Check that ANSI sequences are present
    assert.ok(box.includes("\x1b["));
    // Strip ANSI and verify visible content
    const plain = stripAnsi(box);
    assert.ok(plain.includes("● cheap"));
    assert.ok(plain.includes("intake"));
  });

  it("R9: should provide utilities stripAnsi, visibleWidth, truncateToWidth, and colorizeHex", () => {
    const raw = "\x1b[36mHello \x1b[32mWorld\x1b[0m";
    assert.strictEqual(stripAnsi(raw), "Hello World");
    assert.strictEqual(visibleWidth(raw), 11);

    const truncated = truncateToWidth(raw, 7);
    assert.strictEqual(stripAnsi(truncated), "Hello W");

    assert.strictEqual(isValidHex("#AABBCC"), true);
    assert.strictEqual(isValidHex("#invalid"), false);

    const colored = colorizeHex("#FF0000", "RedText");
    assert.ok(colored.includes("RedText"));
    assert.ok(colored.includes("\x1b[38;2;255;0;0m"));
  });

  it("R10: should parse CLI --peers and --status flags", () => {
    const args1 = parseCliArgs(["--peers"]);
    assert.strictEqual(args1.peers, true);
    assert.strictEqual(args1.status, false);

    const args2 = parseCliArgs(["-P"]);
    assert.strictEqual(args2.peers, true);

    const args3 = parseCliArgs(["--status"]);
    assert.strictEqual(args3.status, true);

    const help = getHelpText();
    assert.ok(help.includes("--peers"));
    assert.ok(help.includes("--status"));
  });
});
