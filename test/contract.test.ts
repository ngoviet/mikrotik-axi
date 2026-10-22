import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";
import { fakeRouter, loadDataset } from "./helpers/fake-router.js";
import { CREDS, runCli } from "./helpers/run.js";

// Hợp đồng AXI (CLAUDE.md §9.2), chạy trong tiến trình với router giả.
const router = () => fakeRouter(loadDataset("ccr2004"), CREDS).transport;

describe("AXI contract", () => {
  it("no arguments renders the home view with header", async () => {
    const { out, code } = await runCli([], { transport: router() });
    expect(code).toBe(0);
    expect(out).toMatch(/^bin: /m);
    expect(out).toMatch(/^description: Inspect and safely operate MikroTik RouterOS v7/m);
    expect(out).toMatch(/^help\[\d+\]:/m);
  });

  it("--help prints top-level usage", async () => {
    const { out, code } = await runCli(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("usage: mikrotik-axi <command> [args] [flags]");
    expect(out).toMatch(/^ {2}health: /m);
  });

  it("<command> --help prints command usage without touching the network", async () => {
    const { out, code } = await runCli(["health", "--help"]);
    expect(code).toBe(0);
    expect(out).toMatch(/^usage: mikrotik-axi health/m);
  });

  it.each(["-v", "-V", "--version"])("%s prints the bare version", async (flag) => {
    const { out, code } = await runCli([flag]);
    expect(code).toBe(0);
    expect(out).toBe(`${VERSION}\n`);
  });

  it("unknown command exits 2 with a structured error on stdout", async () => {
    const { out, code } = await runCli(["nope"]);
    expect(code).toBe(2);
    expect(out).toMatch(/^error: "Unknown command: nope"$/m);
    expect(out).toMatch(/^code: VALIDATION_ERROR$/m);
  });

  it("unknown flag exits 2 and lists the valid flags", async () => {
    const { out, code } = await runCli(["health", "--bogus"], { transport: router() });
    expect(code).toBe(2);
    expect(out).toMatch(/^code: VALIDATION_ERROR$/m);
    expect(out).toContain("--device <name>");
    expect(out).toContain("--no-identity-check");
  });

  it("flag before the command exits 2", async () => {
    const { out, code } = await runCli(["--full"]);
    expect(code).toBe(2);
    expect(out).toMatch(/^error: Flags must come after the command/m);
  });

  it("errors go to stdout, not stderr", async () => {
    const { out, err, code } = await runCli(["health", "--device", "zz"], { transport: router() });
    expect(code).toBe(2);
    expect(out).toMatch(/^error: "unknown device: zz"$/m);
    expect(err).toBe("");
  });
});
