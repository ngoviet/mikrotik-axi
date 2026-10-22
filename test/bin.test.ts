import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

// dist/ do test/global-setup.ts build trước suite.
const BIN_URL = new URL("../dist/bin/mikrotik-axi.js", import.meta.url);
const BIN = fileURLToPath(BIN_URL);

function staticImportsOf(src: string): string[] {
  return [...src.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1] ?? "");
}

function runBin(args: string[]): string {
  return execFileSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
}

describe("built bin", () => {
  it("has a node shebang", () => {
    expect(readFileSync(BIN, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("fast path: static imports are only fast-path + leaf chunks; cli loads lazily", () => {
    const src = readFileSync(BIN, "utf8");
    const staticImports = staticImportsOf(src);
    expect(staticImports.filter((s) => !s.startsWith("."))).toEqual(["axi-sdk-js/fast-path"]);
    // esbuild có thể tách VERSION ra chunk chung — chunk đó phải là leaf (không import gì).
    for (const rel of staticImports.filter((s) => s.startsWith("."))) {
      expect(staticImportsOf(readFileSync(new URL(rel, BIN_URL), "utf8"))).toEqual([]);
    }
    expect(src).toMatch(/await import\(["']\.\.\/cli-[\w-]+\.js["']\)/);
  });

  it("-v prints the bare version", () => {
    expect(runBin(["-v"])).toBe(`${VERSION}\n`);
  });

  it("no arguments without a profile: header + error + help, exit 1 (never silent)", () => {
    const r = spawnSync(process.execPath, [BIN], {
      encoding: "utf8",
      env: { ...process.env, MIKROTIK_AXI_PROFILE: join(tmpdir(), "mikrotik-axi-missing", "profile.json") },
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^description: Inspect and safely operate/m);
    expect(r.stdout).toMatch(/^error: "no profile found at /m);
    expect(r.stdout).toMatch(/^code: CONFIG_ERROR$/m);
    expect(r.stdout).toMatch(/^help\[2\]:/m);
  });

  it("hook bin prints nothing outside MIKROTIK_AXI_HOOK_DIRS and exits 0", () => {
    const hookBin = fileURLToPath(new URL("../dist/bin/mikrotik-axi-hook.js", import.meta.url));
    const r = spawnSync(process.execPath, [hookBin], {
      encoding: "utf8",
      cwd: tmpdir(),
      env: { ...process.env, MIKROTIK_AXI_HOOK_DIRS: join(tmpdir(), "mikrotik-axi-not-here"), CLAUDE_PROJECT_DIR: "" },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("hook bin collapses a config error to one line", () => {
    const hookBin = fileURLToPath(new URL("../dist/bin/mikrotik-axi-hook.js", import.meta.url));
    const r = spawnSync(process.execPath, [hookBin], {
      encoding: "utf8",
      env: { ...process.env, MIKROTIK_AXI_HOOK_DIRS: "", MIKROTIK_AXI_PROFILE: join(tmpdir(), "mikrotik-axi-missing", "p.json") },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^mikrotik-axi: no profile found at [^\n]*\n$/);
  });
});
