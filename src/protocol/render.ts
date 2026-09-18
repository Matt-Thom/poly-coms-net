/**
 * src/protocol/render.ts
 *
 * Terminal / ASCII box renderer for coms-net agent presence pool.
 * Matches the visual representation from the Pi agent harness:
 *
 * ┏━ coms-net ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ intake ━┓
 *  ● cheap        gemini-3.5-fla [---------------]   0%  —  Forge cheap lane (...)
 *  ● impl         grok-4.6       [####-----------]  27%  —  Forge implementer (...)
 *  ● orch         MiniMax-M3     [##-------------]  13%  —  Forge orchestrator (...)
 *  ● rev          gemini-3.8-fla [---------------]   0%  —  Forge reviewer (...)
 * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 */

import type { AgentCard, AgentStatus } from "./types.ts";

export interface RenderComsNetBoxOptions {
  /** List of agents to display in the table */
  agents: AgentCard[];
  /** Caller/current agent name to display in the top right header tag (e.g. "intake") */
  currentAgentName?: string;
  /** Hex color for current agent name in the header */
  currentAgentColor?: string;
  /** Session ID of the caller agent to filter out from rows if desired */
  currentSessionId?: string;
  /** Whether to filter out the current agent session if present in agents list */
  filterCurrentAgent?: boolean;
  /** Total target width of the box in terminal columns (min 16, default: auto) */
  width?: number;
  /** Whether to output ANSI color escape sequences (default: false or auto) */
  useColor?: boolean;
  /** Box header title (default: "coms-net") */
  title?: string;
  /** Whether to display right-aligned status flags (ON / STALE / OFF) */
  showRightFlag?: boolean;
  /** Include agents flagged explicit: true (default: false) */
  includeExplicit?: boolean;
}

// ── Color & String Utilities ────────────────────────────────────────────────

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

/**
 * Strips ANSI escape codes from a string.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

/**
 * Returns the visible terminal cell width of a string (ignoring ANSI escapes).
 */
export function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

/**
 * Truncates a string to at most maxWidth visible cells, preserving ANSI color codes.
 */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;

  let curWidth = 0;
  let result = "";
  let i = 0;

  while (i < text.length) {
    if (text.charCodeAt(i) === 27 && text[i + 1] === "[") {
      const end = text.indexOf("m", i);
      if (end !== -1) {
        result += text.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }

    if (curWidth + 1 > maxWidth) {
      break;
    }
    result += text[i];
    curWidth++;
    i++;
  }

  if (text.includes("\x1b[")) {
    result += "\x1b[0m";
  }
  return result;
}

/**
 * Validates a 6-digit hex color (#RRGGBB).
 */
export function isValidHex(hex?: string): boolean {
  return typeof hex === "string" && /^#[0-9a-fA-F]{6}$/.test(hex);
}

/**
 * Generates an ANSI 24-bit truecolor foreground escape sequence.
 */
export function hexFgAnsi(hex: string): string {
  if (!isValidHex(hex)) return "";
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * Wraps text in an ANSI 24-bit hex foreground color.
 */
export function colorizeHex(hex: string, text: string): string {
  if (!isValidHex(hex)) return text;
  return `${hexFgAnsi(hex)}${text}\x1b[39m`;
}

/**
 * Abbreviates model IDs for compact display.
 */
export function abbreviateModel(model?: string): string {
  let m = model || "";
  if (m.startsWith("claude-")) m = m.slice("claude-".length);
  if (m.length > 14) m = m.slice(0, 14);
  return m;
}

/**
 * Formats a 15-character context usage bar: [####-----------] 27%
 */
export function formatProgressBar(
  pct: number | null | undefined,
  options: { width?: number; useColor?: boolean; color?: string; pending?: boolean } = {}
): { bar: string; pctLabel: string } {
  const barWidth = options.width ?? 15;
  const pctNum =
    typeof pct === "number" && !isNaN(pct)
      ? Math.max(0, Math.min(100, Math.round(pct)))
      : null;
  const pctLabel = pctNum == null ? "--%" : `${pctNum}%`;

  if (pctNum == null || options.pending) {
    const rawBar = `[${"-".repeat(barWidth)}]`;
    if (options.useColor) {
      return {
        bar: `\x1b[33m[\x1b[2m${"-".repeat(barWidth)}\x1b[22;33m]\x1b[39m`,
        pctLabel,
      };
    }
    return { bar: rawBar, pctLabel };
  }

  const filled = Math.max(0, Math.min(barWidth, Math.round((pctNum / 100) * barWidth)));
  const empty = barWidth - filled;

  if (options.useColor) {
    const colorCode = options.color && isValidHex(options.color) ? hexFgAnsi(options.color) : "\x1b[36m";
    const fillStr = `${colorCode}${"#".repeat(filled)}\x1b[39m`;
    const emptyStr = `\x1b[2m${"-".repeat(empty)}\x1b[22m`;
    return {
      bar: `\x1b[33m[${fillStr}${emptyStr}\x1b[33m]\x1b[39m`,
      pctLabel,
    };
  }

  return {
    bar: `[${"#".repeat(filled)}${"-".repeat(empty)}]`,
    pctLabel,
  };
}

// ── Box Border and Row Generation ───────────────────────────────────────────

function statusFlag(status: AgentStatus, useColor: boolean): string {
  if (status === "online") return useColor ? "\x1b[32m    ON\x1b[39m" : "    ON";
  if (status === "stale") return useColor ? "\x1b[33m STALE\x1b[39m" : " STALE";
  return useColor ? "\x1b[2m   OFF\x1b[22m" : "   OFF";
}

/**
 * Computes individual lines of the coms-net box representation.
 */
export function renderComsNetBoxLines(options: RenderComsNetBoxOptions): string[] {
  const {
    agents = [],
    currentAgentName,
    currentAgentColor,
    currentSessionId,
    filterCurrentAgent = true,
    useColor = false,
    title = "coms-net",
    showRightFlag = false,
    includeExplicit = false,
  } = options;

  // Filter agents
  const filtered = agents.filter((a) => {
    if (filterCurrentAgent && currentSessionId && a.session_id === currentSessionId) {
      return false;
    }
    if (!includeExplicit && a.explicit) {
      return false;
    }
    return true;
  });

  // Sort alphabetically by agent name
  filtered.sort((a, b) => a.name.localeCompare(b.name));

  // Determine row data
  interface InternalRow {
    name: string;
    model: string;
    color: string;
    purpose: string;
    pct: number | null;
    status: AgentStatus;
  }

  const rows: InternalRow[] = filtered.map((a) => ({
    name: a.name,
    model: a.model,
    color: a.color,
    purpose: a.purpose || "",
    pct: typeof a.context_used_pct === "number" ? a.context_used_pct : null,
    status: (a.status === "offline" ? "offline" : a.status === "stale" ? "stale" : "online") as AgentStatus,
  }));

  // Calculate required width based on longest content
  let maxContentWidth = 0;
  for (const r of rows) {
    const rawLen =
      1 + // leading space
      1 + // bullet
      1 + // space
      Math.max(12, r.name.length) +
      1 + // space
      Math.max(14, abbreviateModel(r.model).length) +
      1 + // space
      17 + // bar [15 chars]
      1 + // space
      4 + // pct (4 chars)
      5 + // "  —  "
      r.purpose.length;
    if (rawLen > maxContentWidth) {
      maxContentWidth = rawLen;
    }
  }

  const minHeaderWidth =
    13 + // "┏━ coms-net ━"
    3 +  // "━" fill minimum
    (currentAgentName ? currentAgentName.length + 4 : 1); // " <name> ━┓" or "┓"

  let safeWidth: number;
  if (typeof options.width === "number" && options.width > 0) {
    safeWidth = Math.max(16, options.width);
  } else {
    // Auto calculate
    const preferred = Math.max(maxContentWidth + 2, minHeaderWidth + 4, 80);
    if (typeof process !== "undefined" && process.stdout?.columns && process.stdout.columns > 40) {
      safeWidth = Math.max(preferred, Math.min(process.stdout.columns, Math.max(100, preferred)));
    } else {
      safeWidth = preferred;
    }
  }

  // ── 1. Top Border ─────────────────────────────────────────────────────────
  let topBorder: string;
  if (safeWidth < 16) {
    topBorder = useColor ? `\x1b[2m${"━".repeat(safeWidth)}\x1b[22m` : "━".repeat(safeWidth);
  } else {
    const leftText = `┏━ ${title} `;
    const leftVis = leftText.length;
    const nameLen = currentAgentName ? currentAgentName.length : 0;
    const rightTagVis = currentAgentName ? nameLen + 3 : 0; // " <name> ━" has nameLen + 3 visible cells
    const remaining = safeWidth - leftVis - 1 /* leftFill */ - rightTagVis - 1 /* "┓" */;

    if (currentAgentName && remaining >= 1) {
      if (useColor) {
        const left = `\x1b[2m┏━\x1b[22;1;36m ${title} \x1b[22;39m`;
        const leftFill = `\x1b[2m━\x1b[22m`;
        const middle = `\x1b[2m${"━".repeat(remaining)}\x1b[22m`;
        const nameStyled = currentAgentColor && isValidHex(currentAgentColor)
          ? colorizeHex(currentAgentColor, currentAgentName)
          : `\x1b[36m${currentAgentName}\x1b[39m`;
        const rightTag = `\x1b[2m \x1b[22m${nameStyled}\x1b[2m ━\x1b[22m`;
        const right = `\x1b[2m┓\x1b[22m`;
        topBorder = left + leftFill + middle + rightTag + right;
      } else {
        const left = leftText;
        const leftFill = "━";
        const middle = "━".repeat(remaining);
        const rightTag = ` ${currentAgentName} ━`;
        const right = "┓";
        topBorder = left + leftFill + middle + rightTag + right;
      }
    } else {
      const fallbackRemaining = Math.max(0, safeWidth - leftVis - 1);
      if (useColor) {
        const left = `\x1b[2m┏━\x1b[22;1;36m ${title} \x1b[22;39m`;
        const right = `\x1b[2m${"━".repeat(fallbackRemaining)}┓\x1b[22m`;
        topBorder = left + right;
      } else {
        topBorder = leftText + "━".repeat(fallbackRemaining) + "┓";
      }
    }
  }

  // ── 2. Bottom Border ──────────────────────────────────────────────────────
  let bottomBorder: string;
  if (safeWidth < 16) {
    bottomBorder = useColor ? `\x1b[2m${"━".repeat(safeWidth)}\x1b[22m` : "━".repeat(safeWidth);
  } else {
    const raw = `┗${"━".repeat(Math.max(0, safeWidth - 2))}┛`;
    bottomBorder = useColor ? `\x1b[2m${raw}\x1b[22m` : raw;
  }

  // ── 3. Empty State ────────────────────────────────────────────────────────
  if (rows.length === 0) {
    const emptyMsg = useColor ? "\x1b[90mno peers connected\x1b[39m" : "no peers connected";
    const line = `  ${emptyMsg}`;
    return [topBorder, truncateToWidth(line, safeWidth), bottomBorder];
  }

  // ── 4. Rows ───────────────────────────────────────────────────────────────
  const out: string[] = [topBorder];
  const FLAG_W = 6;

  for (const r of rows) {
    const isStale = r.status === "stale";
    const isOffline = r.status === "offline";

    const { bar, pctLabel } = formatProgressBar(r.pct, {
      width: 15,
      useColor,
      color: r.color,
      pending: isStale || isOffline,
    });

    let swatch: string;
    if (useColor) {
      if (isOffline) {
        swatch = "\x1b[31m✗\x1b[39m";
      } else if (isStale) {
        swatch = "\x1b[33m~\x1b[39m";
      } else {
        swatch = r.color && isValidHex(r.color) ? colorizeHex(r.color, "●") : "\x1b[32m●\x1b[39m";
      }
    } else {
      swatch = isOffline ? "✗" : isStale ? "~" : "●";
    }

    const nameStr = r.name.padEnd(12);
    const namePart = useColor ? `\x1b[36m${nameStr}\x1b[39m` : nameStr;

    const modelStr = abbreviateModel(r.model).padEnd(14);
    const modelPart = useColor ? `\x1b[2m${modelStr}\x1b[22m` : modelStr;

    const pctStr = pctLabel.padStart(4);
    const pctPart = useColor ? ` \x1b[36m${pctStr}\x1b[39m` : ` ${pctStr}`;

    const sepStr = "  —  ";
    const sepPart = useColor ? `\x1b[2m${sepStr}\x1b[22m` : sepStr;

    const purposePart = useColor ? `\x1b[90m${r.purpose}\x1b[39m` : r.purpose;

    let line = ` ${swatch} ${namePart} ${modelPart} ${bar}${pctPart}${sepPart}${purposePart}`;

    if (showRightFlag) {
      const flag = statusFlag(r.status, useColor);
      const inner = Math.max(0, safeWidth - 1 - FLAG_W);
      const leftPart = truncateToWidth(line, inner);
      const pad = Math.max(1, safeWidth - visibleWidth(leftPart) - FLAG_W);
      line = leftPart + " ".repeat(pad) + flag;
    } else {
      if (visibleWidth(line) > safeWidth) {
        line = truncateToWidth(line, safeWidth);
      }
    }

    out.push(line);
  }

  out.push(bottomBorder);
  return out;
}

/**
 * Formats the coms-net agent pool box as a single string joined by newlines.
 */
export function renderComsNetBox(options: RenderComsNetBoxOptions): string {
  return renderComsNetBoxLines(options).join("\n");
}
