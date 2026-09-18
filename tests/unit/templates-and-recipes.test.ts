/**
 * tests/unit/templates-and-recipes.test.ts
 *
 * Hermetic unit tests for configuration templates and justfile automation recipes.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

describe("Milestone 3: Harness Configuration Templates", () => {
  const templatesDir = path.join(repoRoot, "templates");

  describe("Claude Code Configuration Templates", () => {
    const claudeDir = path.join(templatesDir, "claude");

    it("should provide valid settings.json with mcpServers, hooks, and permissions", () => {
      const settingsPath = path.join(claudeDir, "settings.json");
      assert.ok(fs.existsSync(settingsPath), "templates/claude/settings.json must exist");

      const raw = fs.readFileSync(settingsPath, "utf8");
      const parsed = JSON.parse(raw);

      assert.ok(parsed.mcpServers, "settings.json must define mcpServers");
      assert.ok(parsed.mcpServers["coms-net"], "settings.json must define mcpServers.coms-net");
      assert.equal(parsed.mcpServers["coms-net"].command, "node");
      assert.ok(
        parsed.mcpServers["coms-net"].args.some((arg: string) =>
          arg.includes("coms-net-mcp.js") || arg.includes("dist/mcp/server.js")
        ),
        "settings.json args must point to coms-net MCP server"
      );

      assert.ok(parsed.hooks, "settings.json must define hooks");
      assert.ok(Array.isArray(parsed.hooks.PreToolUse), "settings.json must define PreToolUse hook");
      assert.ok(Array.isArray(parsed.hooks.Stop), "settings.json must define Stop hook");

      assert.ok(parsed.permissions, "settings.json must define permissions");
      assert.ok(Array.isArray(parsed.permissions.allow), "settings.json must define permissions.allow");
      const allowed = parsed.permissions.allow;
      assert.ok(allowed.includes("mcp__coms_net__coms_net_list"));
      assert.ok(allowed.includes("mcp__coms_net__coms_net_send"));
      assert.ok(allowed.includes("mcp__coms_net__coms_net_get"));
      assert.ok(allowed.includes("mcp__coms_net__coms_net_await"));
    });

    it("should provide valid CLAUDE.md with coms-net rules and anti-looping protocol", () => {
      const claudeMdPath = path.join(claudeDir, "CLAUDE.md");
      assert.ok(fs.existsSync(claudeMdPath), "templates/claude/CLAUDE.md must exist");

      const content = fs.readFileSync(claudeMdPath, "utf8");
      assert.ok(content.length > 100, "CLAUDE.md must not be empty");
      assert.ok(content.includes("coms-net"), "CLAUDE.md must reference coms-net");
      assert.ok(content.includes("ANTI-LOOPING"), "CLAUDE.md must contain anti-looping rules");
      assert.ok(
        content.includes("coms_net_send") && content.includes("coms_net_await"),
        "CLAUDE.md must document coms-net tools"
      );
    });

    it("should provide valid mcp_config.json for claude --mcp-config", () => {
      const mcpConfigPath = path.join(claudeDir, "mcp_config.json");
      assert.ok(fs.existsSync(mcpConfigPath), "templates/claude/mcp_config.json must exist");

      const raw = fs.readFileSync(mcpConfigPath, "utf8");
      const parsed = JSON.parse(raw);

      assert.ok(parsed.mcpServers, "mcp_config.json must define mcpServers");
      assert.ok(parsed.mcpServers["coms-net"], "mcp_config.json must define mcpServers.coms-net");
      assert.equal(parsed.mcpServers["coms-net"].command, "node");
    });
  });

  describe("OpenAI Codex Configuration Templates", () => {
    const codexDir = path.join(templatesDir, "codex");

    it("should provide valid config.toml with sandbox and mcp settings", () => {
      const tomlPath = path.join(codexDir, "config.toml");
      assert.ok(fs.existsSync(tomlPath), "templates/codex/config.toml must exist");

      const content = fs.readFileSync(tomlPath, "utf8");
      assert.ok(content.length > 50, "config.toml must not be empty");
      assert.ok(content.includes("[sandbox]"), "config.toml must contain [sandbox] section");
      assert.ok(content.includes("workspace-write"), "config.toml sandbox mode must be workspace-write");
      assert.ok(content.includes("ask_for_approval = \"never\""), "config.toml must configure ask_for_approval");
      assert.ok(content.includes("skip_git_repo_check = true"), "config.toml must configure skip_git_repo_check");
      assert.ok(content.includes("[mcp.servers.coms-net]"), "config.toml must define coms-net MCP server");

      // Strict TOML validation via Python tomllib if available
      try {
        execFileSync("python3", ["-c", `import tomllib; tomllib.loads('''${content}''')`]);
      } catch (err) {
        assert.fail(`config.toml is not valid TOML: ${(err as Error).message}`);
      }
    });

    it("should provide valid mcp.json stdio definition", () => {
      const mcpPath = path.join(codexDir, "mcp.json");
      assert.ok(fs.existsSync(mcpPath), "templates/codex/mcp.json must exist");

      const raw = fs.readFileSync(mcpPath, "utf8");
      const parsed = JSON.parse(raw);

      assert.ok(parsed.mcpServers, "mcp.json must define mcpServers");
      assert.ok(parsed.mcpServers["coms-net"], "mcp.json must define mcpServers.coms-net");
      assert.equal(parsed.mcpServers["coms-net"].command, "node");
    });

    it("should provide CODEX.md with instructions and anti-looping rules", () => {
      const codexMdPath = path.join(codexDir, "CODEX.md");
      assert.ok(fs.existsSync(codexMdPath), "templates/codex/CODEX.md must exist");

      const content = fs.readFileSync(codexMdPath, "utf8");
      assert.ok(content.length > 100, "CODEX.md must not be empty");
      assert.ok(content.includes("coms-net"), "CODEX.md must reference coms-net");
      assert.ok(content.includes("ANTI-LOOPING"), "CODEX.md must contain anti-looping rules");
      assert.ok(content.includes("codex exec"), "CODEX.md must document codex exec headless mode");
    });
  });

  describe("Aider Configuration Templates", () => {
    const aiderDir = path.join(templatesDir, "aider");

    it("should provide valid .aider.conf.yml with required headless flags", () => {
      const confPath = path.join(aiderDir, ".aider.conf.yml");
      assert.ok(fs.existsSync(confPath), "templates/aider/.aider.conf.yml must exist");

      const content = fs.readFileSync(confPath, "utf8");
      assert.ok(content.includes("yes-always: true"), ".aider.conf.yml must have yes-always: true");
      assert.ok(content.includes("no-auto-commits: true"), ".aider.conf.yml must have no-auto-commits: true");
      assert.ok(content.includes("no-dirty-commits: true"), ".aider.conf.yml must have no-dirty-commits: true");
      assert.ok(content.includes("show-diffs: false"), ".aider.conf.yml must have show-diffs: false");
      assert.ok(content.includes("stream: false"), ".aider.conf.yml must have stream: false");

      // Strict YAML validation via Python yaml if available
      try {
        execFileSync("python3", ["-c", `import yaml; yaml.safe_load('''${content}''')`]);
      } catch (err) {
        assert.fail(`.aider.conf.yml is not valid YAML: ${(err as Error).message}`);
      }
    });

    it("should provide CONVENTIONS.md with mesh collaboration rules", () => {
      const convPath = path.join(aiderDir, "CONVENTIONS.md");
      assert.ok(fs.existsSync(convPath), "templates/aider/CONVENTIONS.md must exist");

      const content = fs.readFileSync(convPath, "utf8");
      assert.ok(content.length > 100, "CONVENTIONS.md must not be empty");
      assert.ok(content.includes("coms-net"), "CONVENTIONS.md must reference coms-net");
      assert.ok(content.includes("ANTI-LOOPING"), "CONVENTIONS.md must contain anti-looping rules");
      assert.ok(content.includes("no-auto-commits"), "CONVENTIONS.md must document commit hygiene");
    });
  });

  describe("Grok CLI Configuration Templates", () => {
    const grokDir = path.join(templatesDir, "grok");

    it("should provide valid config.toml with execution and mcp settings", () => {
      const tomlPath = path.join(grokDir, "config.toml");
      assert.ok(fs.existsSync(tomlPath), "templates/grok/config.toml must exist");

      const content = fs.readFileSync(tomlPath, "utf8");
      assert.ok(content.includes("[execution]"), "config.toml must contain [execution] section");
      assert.ok(content.includes("bypassPermissions"), "config.toml must set bypassPermissions");
      assert.ok(content.includes("always_approve = true"), "config.toml must set always_approve = true");
      assert.ok(content.includes("[mcp.servers.coms-net]"), "config.toml must define coms-net MCP server");

      try {
        execFileSync("python3", ["-c", `import tomllib; tomllib.loads('''${content}''')`]);
      } catch (err) {
        assert.fail(`config.toml is not valid TOML: ${(err as Error).message}`);
      }
    });

    it("should provide valid hooks.json with PreToolUse and Stop hooks", () => {
      const hooksPath = path.join(grokDir, "hooks.json");
      assert.ok(fs.existsSync(hooksPath), "templates/grok/hooks.json must exist");

      const raw = fs.readFileSync(hooksPath, "utf8");
      const parsed = JSON.parse(raw);

      assert.ok(Array.isArray(parsed.hooks), "hooks.json must define hooks array");
      const events = parsed.hooks.map((h: { event: string }) => h.event);
      assert.ok(events.includes("PreToolUse"), "hooks.json must include PreToolUse event");
      assert.ok(events.includes("Stop"), "hooks.json must include Stop event");
    });

    it("should provide GROK.md with mesh instructions and anti-looping rules", () => {
      const grokMdPath = path.join(grokDir, "GROK.md");
      assert.ok(fs.existsSync(grokMdPath), "templates/grok/GROK.md must exist");

      const content = fs.readFileSync(grokMdPath, "utf8");
      assert.ok(content.length > 100, "GROK.md must not be empty");
      assert.ok(content.includes("coms-net"), "GROK.md must reference coms-net");
      assert.ok(content.includes("ANTI-LOOPING"), "GROK.md must contain anti-looping rules");
      assert.ok(content.includes("grok -p"), "GROK.md must document grok -p headless execution");
    });
  });

  describe("Hermes Agent Configuration Templates", () => {
    const hermesDir = path.join(templatesDir, "hermes");

    it("should provide valid hermes-config-snippet.yaml with mcp_servers.coms-net", () => {
      const snippetPath = path.join(hermesDir, "hermes-config-snippet.yaml");
      assert.ok(fs.existsSync(snippetPath), "templates/hermes/hermes-config-snippet.yaml must exist");

      const content = fs.readFileSync(snippetPath, "utf8");
      assert.ok(content.includes("mcp_servers:"), "snippet must contain mcp_servers");
      assert.ok(content.includes("coms-net:"), "snippet must contain coms-net");
      assert.ok(content.includes("coms_net_list"), "snippet must include coms_net_list");
      assert.ok(content.includes("coms_net_send"), "snippet must include coms_net_send");
      assert.ok(content.includes("coms_net_get"), "snippet must include coms_net_get");
      assert.ok(content.includes("coms_net_await"), "snippet must include coms_net_await");

      try {
        execFileSync("python3", ["-c", `import yaml; yaml.safe_load('''${content}''')`]);
      } catch (err) {
        assert.fail(`hermes-config-snippet.yaml is not valid YAML: ${(err as Error).message}`);
      }
    });

    it("should provide AGENTS.md documenting mcp__coms_net__* namespaced tools and anti-loop rules", () => {
      const agentsMdPath = path.join(hermesDir, "AGENTS.md");
      assert.ok(fs.existsSync(agentsMdPath), "templates/hermes/AGENTS.md must exist");

      const content = fs.readFileSync(agentsMdPath, "utf8");
      assert.ok(content.length > 100, "AGENTS.md must not be empty");
      assert.ok(content.includes("mcp__coms_net__coms_net_list"), "AGENTS.md must document mcp__coms_net__coms_net_list");
      assert.ok(content.includes("mcp__coms_net__coms_net_send"), "AGENTS.md must document mcp__coms_net__coms_net_send");
      assert.ok(content.includes("mcp__coms_net__coms_net_get"), "AGENTS.md must document mcp__coms_net__coms_net_get");
      assert.ok(content.includes("mcp__coms_net__coms_net_await"), "AGENTS.md must document mcp__coms_net__coms_net_await");
      assert.ok(content.includes("ANTI-LOOPING"), "AGENTS.md must define strict anti-looping rules");
    });

    it("should provide executable setup-mcp.sh supporting --help and --dry-run", () => {
      const scriptPath = path.join(hermesDir, "setup-mcp.sh");
      assert.ok(fs.existsSync(scriptPath), "templates/hermes/setup-mcp.sh must exist");

      const stat = fs.statSync(scriptPath);
      const isExecutable = (stat.mode & 0o111) !== 0;
      assert.ok(isExecutable, "templates/hermes/setup-mcp.sh must have executable bit set (chmod +x)");

      const content = fs.readFileSync(scriptPath, "utf8");
      assert.ok(content.startsWith("#!/usr/bin/env bash"), "setup-mcp.sh must have bash shebang");

      // Test execution with --help
      const helpOutput = execFileSync(scriptPath, ["--help"], { encoding: "utf8" });
      assert.ok(helpOutput.includes("setup-mcp.sh [options]"), "--help must output usage information");

      // Test execution with --dry-run
      const dryRunOutput = execFileSync(scriptPath, ["--dry-run"], { encoding: "utf8" });
      assert.ok(dryRunOutput.includes("[dry-run]"), "--dry-run must indicate simulated actions");
      assert.ok(dryRunOutput.includes("Hermes MCP setup for coms-net complete!"), "--dry-run must exit successfully");
    });
  });
});

describe("Milestone 3: Justfile Poly-Harness Starter Recipes", () => {
  const justfilePath = path.join(repoRoot, "justfile");

  it("should verify justfile exists and preserves core baseline recipes", () => {
    assert.ok(fs.existsSync(justfilePath), "justfile must exist");
    const content = fs.readFileSync(justfilePath, "utf8");

    const baselineRecipes = ["build", "agy", "agy-live", "bridge", "peers", "monitor", "test"];
    for (const recipe of baselineRecipes) {
      const pattern = new RegExp(`^\\s*${recipe}[\\s:*]`, "m");
      assert.ok(pattern.test(content), `justfile must preserve baseline recipe: ${recipe}`);
    }
  });

  it("should contain all required poly-harness bridge and mesh recipes", () => {
    const content = fs.readFileSync(justfilePath, "utf8");

    const requiredRecipes = [
      "bridge-antigravity",
      "bridge-claude",
      "bridge-codex",
      "bridge-aider",
      "bridge-grok",
      "bridge-hermes",
      "bridge-mock",
      "claude-mesh",
      "hermes-mesh",
    ];

    for (const recipe of requiredRecipes) {
      const pattern = new RegExp(`^\\s*${recipe}[\\s:*]`, "m");
      assert.ok(pattern.test(content), `justfile must contain recipe: ${recipe}`);
    }
  });

  it("should be parseable by just CLI (just --list)", () => {
    try {
      const output = execSync("just --list", { cwd: repoRoot, encoding: "utf8" });
      assert.ok(output.includes("bridge-claude"), "just --list must include bridge-claude");
      assert.ok(output.includes("bridge-hermes"), "just --list must include bridge-hermes");
      assert.ok(output.includes("bridge-mock"), "just --list must include bridge-mock");
      assert.ok(output.includes("claude-mesh"), "just --list must include claude-mesh");
      assert.ok(output.includes("hermes-mesh"), "just --list must include hermes-mesh");
    } catch (err) {
      assert.fail(`just --list failed: ${(err as Error).message}`);
    }
  });

  it("should verify commands and recipe definitions for bridge-* and mesh recipes", () => {
    const runJust = (args: string) => execSync(`just ${args} 2>&1`, { cwd: repoRoot, encoding: "utf8" });

    const showMock = runJust("--show bridge-mock");
    assert.ok(showMock.includes("--harness mock"), "bridge-mock definition must invoke --harness mock");

    const showClaude = runJust("--show bridge-claude");
    assert.ok(showClaude.includes("--harness claude"), "bridge-claude definition must invoke --harness claude");

    const showCodex = runJust("--show bridge-codex");
    assert.ok(showCodex.includes("--harness codex"), "bridge-codex definition must invoke --harness codex");

    const showAider = runJust("--show bridge-aider");
    assert.ok(showAider.includes("--harness aider"), "bridge-aider definition must invoke --harness aider");

    const showGrok = runJust("--show bridge-grok");
    assert.ok(showGrok.includes("--harness grok"), "bridge-grok definition must invoke --harness grok");

    const showHermes = runJust("--show bridge-hermes");
    assert.ok(showHermes.includes("--harness hermes"), "bridge-hermes definition must invoke --harness hermes");

    const showAgy = runJust("--show bridge-antigravity");
    assert.ok(showAgy.includes("--harness antigravity"), "bridge-antigravity definition must invoke --harness antigravity");

    const showClaudeMesh = runJust("--show claude-mesh");
    assert.ok(
      showClaudeMesh.includes("claude --mcp-config templates/claude/mcp_config.json"),
      "claude-mesh definition must launch claude with templates/claude/mcp_config.json"
    );

    const showHermesMesh = runJust("--show hermes-mesh");
    assert.ok(showHermesMesh.includes("hermes"), "hermes-mesh definition must launch hermes");

    // Also verify dry-run execution
    const dryRunMock = runJust("--dry-run bridge-mock");
    assert.ok(dryRunMock.includes("--harness mock"), "bridge-mock dry-run must invoke --harness mock");

    const dryRunAgy = runJust("--dry-run bridge-antigravity");
    assert.ok(dryRunAgy.includes("--harness antigravity"), "bridge-antigravity dry-run must invoke --harness antigravity");
  });
});
