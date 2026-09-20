import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");

describe("Build & Project Integrity Verification", () => {
  it("should have a valid LICENSE file with MIT license and upstream attribution", () => {
    const licensePath = path.join(REPO_ROOT, "LICENSE");
    assert.ok(fs.existsSync(licensePath), "LICENSE file must exist");
    const content = fs.readFileSync(licensePath, "utf-8");
    assert.match(content, /MIT License/, "LICENSE must specify MIT License");
    assert.match(content, /IndyDevDan/, "LICENSE must attribute upstream creator IndyDevDan");
    assert.match(content, /Matt Thom/, "LICENSE must include project maintainer");
  });

  it("should have correct package.json configuration including MIT license and zero runtime deps", () => {
    const pkgPath = path.join(REPO_ROOT, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));

    assert.strictEqual(pkg.name, "poly-coms-net");
    assert.strictEqual(pkg.type, "module");
    assert.strictEqual(pkg.license, "MIT");
    assert.strictEqual(pkg.main, "./dist/index.js");
    assert.strictEqual(pkg.types, "./dist/index.d.ts");

    // Zero runtime dependency architecture
    const deps = pkg.dependencies || {};
    assert.strictEqual(Object.keys(deps).length, 0, "Runtime dependencies must be 0");

    // Scripts
    assert.strictEqual(pkg.scripts.build, "tsc");
    assert.strictEqual(pkg.scripts.typecheck, "tsc --noEmit");
    assert.ok(pkg.scripts.test, "Test script must be defined");

    // Binaries
    assert.strictEqual(pkg.bin["coms-net-bridge"], "./bin/coms-net-bridge.js");
    assert.strictEqual(pkg.bin["coms-net-mcp"], "./bin/coms-net-mcp.js");
  });

  it("should verify tsconfig.json specifies correct outDir, module, and declarations", () => {
    const tsconfigPath = path.join(REPO_ROOT, "tsconfig.json");
    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf-8"));
    const compilerOpts = tsconfig.compilerOptions;

    assert.strictEqual(compilerOpts.outDir, "./dist");
    assert.strictEqual(compilerOpts.module, "NodeNext");
    assert.strictEqual(compilerOpts.declaration, true);
  });

  it("should verify compiled distribution artifacts exist in dist/", () => {
    const requiredDistFiles = [
      "index.js",
      "index.d.ts",
      "cli.js",
      "cli.d.ts",
      "mcp/server.js",
      "mcp/server.d.ts",
      "protocol/client.js",
      "protocol/client.d.ts",
      "protocol/discovery.js",
      "protocol/discovery.d.ts",
      "protocol/types.js",
      "protocol/types.d.ts",
      "bridge/daemon.js",
      "bridge/daemon.d.ts",
      "bridge/turn-executor.js",
      "bridge/turn-executor.d.ts",
    ];

    for (const relPath of requiredDistFiles) {
      const fullPath = path.join(REPO_ROOT, "dist", relPath);
      assert.ok(fs.existsSync(fullPath), `Compiled artifact missing: dist/${relPath}`);
    }
  });

  it("should verify all 5 harness templates and configs exist", () => {
    const requiredTemplates = [
      "templates/claude/settings.json",
      "templates/claude/mcp_config.json",
      "templates/claude/CLAUDE.md",
      "templates/codex/config.toml",
      "templates/codex/mcp.json",
      "templates/codex/CODEX.md",
      "templates/aider/.aider.conf.yml",
      "templates/aider/CONVENTIONS.md",
      "templates/grok/config.toml",
      "templates/grok/hooks.json",
      "templates/grok/GROK.md",
      "templates/hermes/hermes-config-snippet.yaml",
      "templates/hermes/setup-mcp.sh",
      "templates/hermes/AGENTS.md",
    ];

    for (const relPath of requiredTemplates) {
      const fullPath = path.join(REPO_ROOT, relPath);
      assert.ok(fs.existsSync(fullPath), `Template file missing: ${relPath}`);
    }
  });

  it("should verify distribution index exports core components cleanly", async () => {
    const distIndexPath = path.join(REPO_ROOT, "dist", "index.js");
    const exported = await import(distIndexPath);

    assert.ok(exported.ComsNetClient, "ComsNetClient must be exported");
    assert.ok(exported.BridgeDaemon, "BridgeDaemon must be exported");
    assert.ok(exported.SUPPORTED_HARNESSES, "SUPPORTED_HARNESSES must be exported");
    assert.ok(exported.createTurnExecutor, "createTurnExecutor must be exported");
    assert.ok(exported.discoverHub, "discoverHub must be exported");
    assert.ok(exported.renderComsNetBox, "renderComsNetBox must be exported");
  });
});
