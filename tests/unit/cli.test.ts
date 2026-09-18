/**
 * tests/unit/cli.test.ts
 *
 * Automated test suite for CLI entrypoint, argument parsing, wrapper scripts,
 * and package distribution scripts.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  parseCliArgs,
  runBridgeDaemon,
  getHelpText,
  formatHelpText,
  getVersion,
  SUPPORTED_HARNESSES,
  HARNESS_DEFAULTS,
  type SupportedHarness,
} from "../../src/cli.ts";
import { MockHub } from "../mocks/mock-hub.ts";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("CLI Tooling & Distribution Tests", () => {
  describe("Argument Parser (parseCliArgs)", () => {
    it("should parse default arguments correctly and default harness to antigravity", () => {
      const args = parseCliArgs([]);
      assert.strictEqual(args.harness, "antigravity");
      assert.strictEqual(args.mock, false);
      assert.strictEqual(args.help, false);
      assert.strictEqual(args.version, false);
      assert.strictEqual(args.project, undefined);
      assert.strictEqual(args.serverUrl, undefined);
      assert.strictEqual(args.name, undefined);
    });

    it("should parse --harness for all supported harnesses", () => {
      for (const harness of SUPPORTED_HARNESSES) {
        const args = parseCliArgs(["--harness", harness]);
        assert.strictEqual(args.harness, harness);
        if (harness === "mock") {
          assert.strictEqual(args.mock, true);
        }
      }
    });

    it("should parse -H short flag for all supported harnesses", () => {
      for (const harness of SUPPORTED_HARNESSES) {
        const args = parseCliArgs(["-H", harness]);
        assert.strictEqual(args.harness, harness);
      }
    });

    it("should normalize case and trim whitespace for --harness and -H", () => {
      assert.strictEqual(parseCliArgs(["--harness", "  Claude "]).harness, "claude");
      assert.strictEqual(parseCliArgs(["-H", "HERMES"]).harness, "hermes");
      assert.strictEqual(parseCliArgs(["-H", "CoDeX"]).harness, "codex");
      assert.strictEqual(parseCliArgs(["--harness", "AIDER"]).harness, "aider");
      assert.strictEqual(parseCliArgs(["-H", "GrOk"]).harness, "grok");
    });

    it("should set harness to 'mock' when --mock is passed without --harness", () => {
      const args = parseCliArgs(["--mock"]);
      assert.strictEqual(args.harness, "mock");
      assert.strictEqual(args.mock, true);
    });

    it("should allow explicit --harness to take precedence over --mock flag", () => {
      const args = parseCliArgs(["--mock", "--harness", "claude"]);
      assert.strictEqual(args.harness, "claude");

      const argsShort = parseCliArgs(["--mock", "-H", "hermes"]);
      assert.strictEqual(argsShort.harness, "hermes");
    });

    it("should reject invalid --harness values with informative error listing allowed options", () => {
      assert.throws(
        () => parseCliArgs(["--harness", "unknown_framework"]),
        (err: Error) => {
          assert.match(
            err.message,
            /Invalid --harness value 'unknown_framework': must be one of/
          );
          for (const h of SUPPORTED_HARNESSES) {
            assert.ok(
              err.message.includes(`'${h}'`),
              `Error message should mention '${h}'`
            );
          }
          return true;
        }
      );

      assert.throws(
        () => parseCliArgs(["-H", "bogus"]),
        /Invalid --harness value 'bogus': must be one of/
      );

      assert.throws(
        () => parseCliArgs(["--harness", ""]),
        /Invalid --harness value '': must be one of/
      );
    });

    it("should parse short flags (-p, -u, -t, -n, -m, -h, -v)", () => {
      const args = parseCliArgs([
        "-p", "my-project",
        "-u", "http://localhost:1234",
        "-t", "test-token",
        "-n", "agent-bob",
        "-m", "gemini-3.7-flash-high",
      ]);
      assert.strictEqual(args.project, "my-project");
      assert.strictEqual(args.serverUrl, "http://localhost:1234");
      assert.strictEqual(args.authToken, "test-token");
      assert.strictEqual(args.name, "agent-bob");
      assert.strictEqual(args.model, "gemini-3.7-flash-high");
    });

    it("should parse long flags including --mock and --mock-response", () => {
      const args = parseCliArgs([
        "--mock",
        "--mock-response", "Custom canned output",
        "--max-turns", "4",
        "--heartbeat-ms", "5000",
        "--cwd", "/tmp",
        "--explicit",
      ]);
      assert.strictEqual(args.mock, true);
      assert.strictEqual(args.mockResponse, "Custom canned output");
      assert.strictEqual(args.maxTurns, 4);
      assert.strictEqual(args.heartbeatMs, 5000);
      assert.strictEqual(args.cwd, "/tmp");
      assert.strictEqual(args.explicit, true);
    });

    it("should parse --help and --version", () => {
      assert.strictEqual(parseCliArgs(["-h"]).help, true);
      assert.strictEqual(parseCliArgs(["--help"]).help, true);
      assert.strictEqual(parseCliArgs(["-v"]).version, true);
      assert.strictEqual(parseCliArgs(["--version"]).version, true);
    });

    it("should reject invalid, non-numeric, or non-positive --max-turns", () => {
      assert.throws(
        () => parseCliArgs(["--max-turns", "abc"]),
        /must be a positive integer/
      );
      assert.throws(
        () => parseCliArgs(["--max-turns", "0"]),
        /must be a positive integer/
      );
      assert.throws(
        () => parseCliArgs(["--max-turns=-5"]),
        /must be a positive integer/
      );
    });

    it("should reject invalid, non-numeric, or non-positive --heartbeat-ms", () => {
      assert.throws(
        () => parseCliArgs(["--heartbeat-ms", "xyz"]),
        /must be a positive integer/
      );
      assert.throws(
        () => parseCliArgs(["--heartbeat-ms", "0"]),
        /must be a positive integer/
      );
      assert.throws(
        () => parseCliArgs(["--heartbeat-ms=-100"]),
        /must be a positive integer/
      );
    });
  });

  describe("Help & Version Strings", () => {
    it("should produce non-empty help text containing all flags and examples", () => {
      const help = getHelpText();
      assert.ok(help.includes("coms-net-bridge"));
      assert.ok(help.includes("--harness"));
      assert.ok(help.includes("-H"));
      assert.ok(help.includes("--project"));
      assert.ok(help.includes("--server-url"));
      assert.ok(help.includes("--mock"));
      assert.ok(help.includes("EXAMPLES:"));
    });

    it("should document -H, --harness and allowed harnesses in help text", () => {
      const help = getHelpText();
      assert.ok(help.includes("-H, --harness <name>"));
      assert.ok(help.includes("antigravity"));
      assert.ok(help.includes("claude"));
      assert.ok(help.includes("codex"));
      assert.ok(help.includes("aider"));
      assert.ok(help.includes("grok"));
      assert.ok(help.includes("hermes"));
      assert.ok(help.includes("mock"));
      assert.ok(help.includes("bridge worker for Claude Code"));
      assert.ok(help.includes("bridge worker for Hermes Agent"));
      assert.strictEqual(formatHelpText(), help);
    });

    it("should produce valid semantic version string matching package.json", () => {
      const version = getVersion();
      assert.match(version, /^\d+\.\d+\.\d+/);
      const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"));
      assert.strictEqual(version, pkg.version);
    });
  });

  describe("Harness Metadata Defaults (HARNESS_DEFAULTS)", () => {
    it("should contain valid configurations for all 7 supported harnesses", () => {
      assert.strictEqual(SUPPORTED_HARNESSES.length, 7);
      for (const harness of SUPPORTED_HARNESSES) {
        const defaults = HARNESS_DEFAULTS[harness];
        assert.ok(defaults, `Defaults missing for ${harness}`);
        assert.strictEqual(defaults.namePrefix, harness);
        assert.strictEqual(defaults.runtime, harness);
        assert.ok(defaults.purpose.length > 0);
        assert.ok(defaults.model.length > 0);
        assert.ok(defaults.provider.length > 0);
      }
    });

    it("should specify signature Hermes agent metadata defaults", () => {
      const hermes = HARNESS_DEFAULTS.hermes;
      assert.strictEqual(hermes.namePrefix, "hermes");
      assert.strictEqual(hermes.purpose, "Nous Research Hermes Agent autonomous worker");
      assert.strictEqual(hermes.model, "hermes-3-llama-3.1-70b");
      assert.strictEqual(hermes.provider, "nousresearch");
      assert.strictEqual(hermes.color, "#C792EA");
      assert.strictEqual(hermes.runtime, "hermes");
    });

    it("should specify correct providers and models for all other harnesses", () => {
      assert.strictEqual(HARNESS_DEFAULTS.antigravity.provider, "google");
      assert.strictEqual(HARNESS_DEFAULTS.antigravity.model, "gemini-2.5-pro");

      assert.strictEqual(HARNESS_DEFAULTS.claude.provider, "anthropic");
      assert.strictEqual(HARNESS_DEFAULTS.claude.model, "claude-sonnet-4-6");

      assert.strictEqual(HARNESS_DEFAULTS.codex.provider, "openai");
      assert.strictEqual(HARNESS_DEFAULTS.codex.model, "gpt-5.3-codex");

      assert.strictEqual(HARNESS_DEFAULTS.aider.provider, "openai");
      assert.strictEqual(HARNESS_DEFAULTS.aider.model, "claude-3-7-sonnet");

      assert.strictEqual(HARNESS_DEFAULTS.grok.provider, "xai");
      assert.strictEqual(HARNESS_DEFAULTS.grok.model, "grok-4.6");

      assert.strictEqual(HARNESS_DEFAULTS.mock.provider, "mock");
      assert.strictEqual(HARNESS_DEFAULTS.mock.model, "mock-model");
    });
  });

  describe("Executable Wrapper Scripts (bin/)", () => {
    const bridgeScript = path.join(REPO_ROOT, "bin", "coms-net-bridge.js");
    const mcpScript = path.join(REPO_ROOT, "bin", "coms-net-mcp.js");

    it("bin/coms-net-bridge.js should exist, be executable, and have node shebang", () => {
      assert.ok(fs.existsSync(bridgeScript), "bin/coms-net-bridge.js must exist");
      const content = fs.readFileSync(bridgeScript, "utf-8");
      assert.ok(content.startsWith("#!/usr/bin/env node"), "Must have #!/usr/bin/env node shebang");
      const stat = fs.statSync(bridgeScript);
      const isExecutable = (stat.mode & 0o111) !== 0;
      assert.ok(isExecutable, "bin/coms-net-bridge.js must be executable (chmod +x)");
    });

    it("bin/coms-net-mcp.js should exist, be executable, and have node shebang", () => {
      assert.ok(fs.existsSync(mcpScript), "bin/coms-net-mcp.js must exist");
      const content = fs.readFileSync(mcpScript, "utf-8");
      assert.ok(content.startsWith("#!/usr/bin/env node"), "Must have #!/usr/bin/env node shebang");
      const stat = fs.statSync(mcpScript);
      const isExecutable = (stat.mode & 0o111) !== 0;
      assert.ok(isExecutable, "bin/coms-net-mcp.js must be executable (chmod +x)");
    });

    it("should execute bin/coms-net-bridge.js --version and exit 0", async () => {
      const { stdout } = await execFileAsync(bridgeScript, ["--version"]);
      assert.ok(stdout.includes("coms-net-bridge v"));
    });

    it("should execute bin/coms-net-bridge.js --help and exit 0", async () => {
      const { stdout } = await execFileAsync(bridgeScript, ["--help"]);
      assert.ok(stdout.includes("USAGE:"));
      assert.ok(stdout.includes("OPTIONS:"));
    });
  });

  describe("Bridge Daemon CLI Subprocess Boot & Graceful Exit", () => {
    let hub: MockHub;

    before(async () => {
      hub = new MockHub();
      await hub.start();
    });

    after(async () => {
      await hub.stop();
    });

    it("should boot bridge daemon via CLI in mock mode and shut down cleanly on SIGINT", async () => {
      const bridgeScript = path.join(REPO_ROOT, "bin", "coms-net-bridge.js");
      const child = spawn(bridgeScript, [
        "--server-url", hub.baseUrl,
        "--auth-token", hub.token,
        "--project", "cli-test",
        "--name", "cli-mock-worker",
        "--mock",
        "--mock-response", "Hello from CLI mock",
      ]);

      let output = "";
      child.stdout.on("data", (d) => { output += d.toString(); });
      child.stderr.on("data", (d) => { output += d.toString(); });

      // Wait until registered and SSE connected
      const started = await new Promise<boolean>((resolve) => {
        const checkInterval = setInterval(() => {
          if (output.includes("Agent registered: cli-mock-worker") && output.includes("SSE event stream connected")) {
            clearInterval(checkInterval);
            resolve(true);
          }
        }, 50);

        setTimeout(() => {
          clearInterval(checkInterval);
          resolve(false);
        }, 5000);
      });

      assert.ok(started, `Daemon failed to start in time. Output:\n${output}`);

      // Verify presence in MockHub registry
      const project = hub.getProject("cli-test");
      let foundSessionId = "";
      for (const [id, agent] of project.agents.entries()) {
        if (agent.name === "cli-mock-worker") {
          foundSessionId = id;
          break;
        }
      }
      assert.ok(foundSessionId, "Agent must be registered in hub");

      // Dispatch SIGINT
      child.kill("SIGINT");

      const exitCode = await new Promise<number>((resolve) => {
        child.on("exit", (code) => resolve(code ?? 0));
      });

      assert.strictEqual(exitCode, 0, "Process must exit cleanly with code 0");

      // Verify agent was removed from hub registry
      assert.strictEqual(project.agents.has(foundSessionId), false, "Agent must unregister on exit");
    });

    it("should boot bridge daemon via CLI with -H mock and shut down cleanly on SIGINT", async () => {
      const bridgeScript = path.join(REPO_ROOT, "bin", "coms-net-bridge.js");
      const child = spawn(bridgeScript, [
        "-H", "mock",
        "--server-url", hub.baseUrl,
        "--auth-token", hub.token,
        "--project", "cli-harness-test",
        "--name", "cli-harness-worker",
        "--mock-response", "Hello from -H mock",
      ]);

      let output = "";
      child.stdout.on("data", (d) => { output += d.toString(); });
      child.stderr.on("data", (d) => { output += d.toString(); });

      // Wait until registered and SSE connected
      const started = await new Promise<boolean>((resolve) => {
        const checkInterval = setInterval(() => {
          if (output.includes("Agent registered: cli-harness-worker") && output.includes("SSE event stream connected")) {
            clearInterval(checkInterval);
            resolve(true);
          }
        }, 50);

        setTimeout(() => {
          clearInterval(checkInterval);
          resolve(false);
        }, 5000);
      });

      assert.ok(started, `Daemon failed to start in time with -H mock. Output:\n${output}`);

      // Verify presence in MockHub registry
      const project = hub.getProject("cli-harness-test");
      let foundSessionId = "";
      for (const [id, agent] of project.agents.entries()) {
        if (agent.name === "cli-harness-worker") {
          foundSessionId = id;
          break;
        }
      }
      assert.ok(foundSessionId, "Agent must be registered in hub via -H mock");

      // Dispatch SIGINT
      child.kill("SIGINT");

      const exitCode = await new Promise<number>((resolve) => {
        child.on("exit", (code) => resolve(code ?? 0));
      });

      assert.strictEqual(exitCode, 0, "Process must exit cleanly with code 0");

      // Verify agent was removed from hub registry
      assert.strictEqual(project.agents.has(foundSessionId), false, "Agent must unregister on exit");
    });
  });

  describe("Bridge Daemon Runtime Registration & Executor Propagation (runBridgeDaemon)", () => {
    let hub: MockHub;

    before(async () => {
      hub = new MockHub();
      await hub.start();
    });

    after(async () => {
      await hub.stop();
    });

    it("should register agent identity runtime matching selected harness (especially -H hermes)", async () => {
      for (const harness of SUPPORTED_HARNESSES) {
        const args = parseCliArgs([
          "-H", harness,
          "--server-url", hub.baseUrl,
          "--auth-token", hub.token,
          "--project", `runtime-test-${harness}`,
        ]);
        const daemon = await runBridgeDaemon(args);
        try {
          const id = daemon.lifecycle.getIdentity();
          assert.strictEqual(id.runtime, harness, `Registered runtime must match '${harness}'`);
          assert.strictEqual(id.model, HARNESS_DEFAULTS[harness].model);
          assert.strictEqual(id.provider, HARNESS_DEFAULTS[harness].provider);
          if (harness === "hermes") {
            assert.strictEqual(id.runtime, "hermes");
            assert.strictEqual(id.model, "hermes-3-llama-3.1-70b");
            assert.strictEqual(id.provider, "nousresearch");
            assert.strictEqual(id.color, "#C792EA");
          }
        } finally {
          await daemon.stop();
        }
      }
    });

    it("should propagate resolved default model and provider to createTurnExecutor", async () => {
      const args = parseCliArgs([
        "-H", "hermes",
        "--server-url", hub.baseUrl,
        "--auth-token", hub.token,
        "--project", "turn-executor-defaults-test",
      ]);
      const daemon = await runBridgeDaemon(args);
      try {
        const executor = daemon.turnExecutor;
        assert.strictEqual(Reflect.get(executor, "model"), "hermes-3-llama-3.1-70b");
        assert.strictEqual(Reflect.get(executor, "provider"), "nousresearch");
      } finally {
        await daemon.stop();
      }
    });

    it("should propagate explicit CLI --model override to both lifecycle and turnExecutor", async () => {
      const args = parseCliArgs([
        "-H", "hermes",
        "-m", "custom-hermes-test-model",
        "--server-url", hub.baseUrl,
        "--auth-token", hub.token,
        "--project", "turn-executor-model-override-test",
      ]);
      const daemon = await runBridgeDaemon(args);
      try {
        const id = daemon.lifecycle.getIdentity();
        const executor = daemon.turnExecutor;
        assert.strictEqual(id.model, "custom-hermes-test-model");
        assert.strictEqual(Reflect.get(executor, "model"), "custom-hermes-test-model");
        assert.strictEqual(Reflect.get(executor, "provider"), "nousresearch");
      } finally {
        await daemon.stop();
      }
    });
  });

  describe("package.json Configuration", () => {
    it("should have correct bin mappings and scripts", () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"));
      assert.strictEqual(pkg.bin["coms-net-bridge"], "./bin/coms-net-bridge.js");
      assert.strictEqual(pkg.bin["coms-net-mcp"], "./bin/coms-net-mcp.js");
      assert.strictEqual(pkg.scripts["bridge"], "tsx src/cli.ts");
      assert.strictEqual(pkg.scripts["mcp"], "tsx src/mcp/server.ts");
      assert.strictEqual(pkg.scripts["validate:plugin"], "agy plugin validate .agents/plugins/coms-net");
    });
  });
});
