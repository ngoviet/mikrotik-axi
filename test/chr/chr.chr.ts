import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Suite on a throwaway RouterOS CHR (CI: .github/workflows/chr.yml; booted by scripts/chr/boot.sh,
// provisioned by scripts/chr/provision.mjs). Unlike test/live, every write command runs for real here,
// pppoe restart, arp flush and dhcp move included: the VM carries nobody's traffic.
//   MIKROTIK_AXI_CHR=1 MIKROTIK_AXI_PROFILE=… MIKROTIK_AXI_ENV_FILE=… MIKROTIK_AXI_CHR_FIXTURE=… pnpm test:chr
const BIN = fileURLToPath(new URL("../../dist/bin/mikrotik-axi.js", import.meta.url));
const enabled = process.env["MIKROTIK_AXI_CHR"] === "1";

interface Fixture {
  rule: string;
  dhcpServer: string;
  lease: string;
  pppoe: string;
  gateway: string;
}

function parseEnv(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

const fixture: Fixture = enabled ? JSON.parse(readFileSync(process.env["MIKROTIK_AXI_CHR_FIXTURE"]!, "utf8")) : ({} as Fixture);
const creds = enabled ? parseEnv(readFileSync(process.env["MIKROTIK_AXI_ENV_FILE"]!, "utf8")) : {};
const work = mkdtempSync(join(tmpdir(), "axi-chr-"));
const baseEnv = { MIKROTIK_AXI_SNAPSHOT_DIR: join(work, "snap"), MIKROTIK_AXI_EXPORT_DIR: join(work, "exp") };
/** Read commands as axi-ping (policy test) instead of axi-ro: the profile reads AXI_RO_*, process env wins over the env file. */
const asPingUser = () => ({ AXI_RO_USER: creds["AXI_PING_USER"]!, AXI_RO_PASS: creds["AXI_PING_PASS"]! });

function run(args: string[], env: Record<string, string> = {}): { out: string; code: number | null } {
  const e: NodeJS.ProcessEnv = { ...process.env, ...baseEnv, ...env };
  delete e["MIKROTIK_AXI_READ_ONLY"];
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: e });
  console.log(`$ mikrotik-axi ${args.join(" ")}  [exit ${r.status}]\n${r.stdout}`);
  return { out: r.stdout, code: r.status };
}

/** `snapshot: <path>`: TOON quotes the path only when it holds special characters (Windows does, Linux may not). */
function snapshotOf(out: string): string {
  const raw = /^snapshot: (.*)$/m.exec(out)?.[1];
  if (!raw) throw new Error(`no snapshot line in:\n${out}`);
  return raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
}

describe.skipIf(!enabled)("CHR (MIKROTIK_AXI_CHR=1)", () => {
  it("identity guard: the provisioned identity passes, a different expected identity stops the command", () => {
    const h = run(["health"]);
    expect(h.code, h.out).toBe(0);
    expect(h.out).toMatch(/^identity: AXI-CHR \(verified\)$/m);
    expect(h.out).toMatch(/^version: 7\./m);

    const wrong = join(work, "wrong-profile.json");
    const profile = JSON.parse(readFileSync(process.env["MIKROTIK_AXI_PROFILE"]!, "utf8"));
    profile.devices.chr.expect_identity = "NOT-THIS-ROUTER";
    writeFileSync(wrong, JSON.stringify(profile));
    const w = run(["health", "--profile", wrong]);
    expect(w.code).toBe(1);
    expect(w.out).toMatch(/identity/i);
  });

  it("every read command exits 0 on a router that has none of the site objects", () => {
    const reads = [
      ["home"],
      ["devices"],
      ["wan"],
      ["wan", "ips"],
      ["routes", "defaults"],
      ["routes", "rules"],
      ["dhcp"],
      ["dhcp", "leases", fixture.dhcpServer],
      ["vlans"],
      ["iface"],
      ["fw", "filter"],
      ["fw", "nat"],
      ["fw", "mangle"],
      ["fw", "raw"],
      ["fw", "mangle", "check"],
      ["services"],
      ["log", "--since", "1h"],
    ];
    for (const args of reads) {
      const r = run(args);
      expect(r.code, `${args.join(" ")}\n${r.out}`).toBe(0);
    }
  });

  it("audit flags the factory admin user", () => {
    const a = run(["audit"]);
    expect(a.code, a.out).toBe(0);
    expect(a.out).toMatch(/^verdict: /m);
    expect(a.out).toMatch(/^ {2}admin-user,high,/m);
  });

  it("export → change → export diff shows exactly that change → revert → identical", () => {
    expect(run(["export"]).code).toBe(0);
    const base = run(["export", "--section", "/ip/firewall"]);
    expect(base.code, base.out).toBe(0);
    expect(base.out).toMatch(/^lines: [1-9]\d*$/m);

    const add = run(["addr-list", "add", "AXI_TEST", "192.0.2.124", "--confirm"]);
    expect(add.code, add.out).toBe(0);
    const diff = run(["export", "diff", "--section", "/ip/firewall"]);
    expect(diff.code, diff.out).toBe(0);
    expect(diff.out).toMatch(/^summary: \+1 -0 lines in 1 menus$/m);
    expect(diff.out).toContain("/ip firewall address-list");

    expect(run(["revert", snapshotOf(add.out), "--confirm"]).code).toBe(0);
    expect(run(["export", "diff", "--section", "/ip/firewall"]).out).toMatch(/^summary: identical$/m);
  });

  it("addr-list: dry-run → confirm → read back → no-op → revert", () => {
    const LIST = "AXI_TEST";
    const ADDR = "192.0.2.123";
    const dry = run(["addr-list", "add", LIST, ADDR, "--comment", "AXI_TEST_chr"]);
    expect(dry.code, dry.out).toBe(0);
    expect(dry.out).toMatch(/^result: dry-run/m);
    const applied = run(["addr-list", "add", LIST, ADDR, "--comment", "AXI_TEST_chr", "--confirm"]);
    expect(applied.out).toMatch(/^result: applied$/m);
    expect(run(["addr-list", "add", LIST, ADDR, "--confirm"]).out).toMatch(/^result: no-op$/m);
    expect(run(["revert", snapshotOf(applied.out), "--confirm"]).code).toBe(0);
    expect(run(["addr-list", "remove", LIST, ADDR]).out).toMatch(/^result: no-op$/m);
  });

  it("fw filter disable on the AXI_TEST_ rule, then revert", () => {
    const applied = run(["fw", "filter", "disable", fixture.rule, "--confirm"]);
    expect(applied.code, applied.out).toBe(0);
    expect(applied.out).toMatch(/^result: applied$/m);
    const reverted = run(["revert", snapshotOf(applied.out), "--confirm"]);
    expect(reverted.code, reverted.out).toBe(0);
    expect(reverted.out).toMatch(/^verified: disabled=false$/m);
  });

  it("dhcp move: static lease to a new address, then revert", () => {
    const dry = run(["dhcp", "move", fixture.dhcpServer, fixture.lease, "192.0.2.60"]);
    expect(dry.code, dry.out).toBe(0);
    expect(dry.out).toMatch(/^result: dry-run/m);
    const applied = run(["dhcp", "move", fixture.dhcpServer, fixture.lease, "192.0.2.60", "--confirm"]);
    expect(applied.code, applied.out).toBe(0);
    expect(applied.out).toMatch(/^result: applied$/m);
    expect(run(["dhcp", "leases", fixture.dhcpServer, "--full"]).out).toContain("192.0.2.60");
    expect(run(["revert", snapshotOf(applied.out), "--confirm"]).code).toBe(0);
    expect(run(["dhcp", "leases", fixture.dhcpServer, "--full"]).out).toContain(fixture.lease);
  });

  it("arp flush removes the dynamic entry of the user-network gateway (or finds none)", () => {
    const r = run(["arp", "flush", fixture.gateway, "--confirm"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/^result: (applied|no-op)$/m);
  });

  it("pppoe restart on a client that dials nowhere: re-enabled, reported as not running", () => {
    const r = run(["pppoe", "restart", fixture.pppoe, "--confirm"]);
    expect(r.code, r.out).toBe(0);
    // TOON quotes the value: it holds ";" and backticks.
    expect(r.out).toMatch(/^verified: "?disabled=false; running=false/m);
  }, 60_000);

  it("ping/traceroute need the test policy; with it they run from the router", () => {
    const denied = run(["ping", fixture.gateway, "--count", "1"]);
    expect(denied.code).toBe(1);
    expect(denied.out).toContain("lacks the `test` policy");

    const ping = run(["ping", fixture.gateway, "--count", "2"], asPingUser());
    expect(ping.code, ping.out).toBe(0);
    expect(ping.out).toMatch(/^result: "?\d\/2 replies/m);

    // The gateway is directly connected: one hop, itself, with a numeric RTT in ms (CI 2026-11-21 showed
    // RouterOS returns `last` as a bare number, which the first version printed as "0").
    const trace = run(["traceroute", fixture.gateway], asPingUser());
    expect(trace.code, trace.out).toBe(0);
    expect(trace.out).toMatch(/^summary: "?1 hops, destination reached"?$/m);
    expect(trace.out).toMatch(new RegExp(`^ {2}1,${fixture.gateway.replace(/\./g, "\\.")},0%,"?\\d+(\\.\\d+)? ms"?$`, "m"));

    const each = run(["ping", fixture.gateway, "--each-wan"], asPingUser());
    expect(each.code).toBe(2);
    expect(each.out).toContain("no running PPPoE session");
  }, 90_000);
});
