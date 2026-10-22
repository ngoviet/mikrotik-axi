import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { portSpecIncludes } from "../src/write/protected.js";
import { sameValue } from "../src/write/ops.js";
import type { Dataset, FakeRouter } from "./helpers/fake-router.js";
import { fakeRouter, loadDataset } from "./helpers/fake-router.js";
import { CREDS, runCli, TEST_PROFILE } from "./helpers/run.js";

type Rows = Array<Record<string, string>>;

const PROFILE = structuredClone(TEST_PROFILE) as typeof TEST_PROFILE & { devices: { ccr2004: Record<string, unknown> } };
PROFILE.devices.ccr2004["protected"] = { nat_dst_ports: [80, 443], comment_prefixes: ["HA_", "MSS_"] };

let snapDir: string;
let router: FakeRouter;
let ds: Dataset;

beforeEach(() => {
  snapDir = mkdtempSync(join(tmpdir(), "mikrotik-axi-snap-"));
  ds = loadDataset("ccr2004");
  router = fakeRouter(ds, CREDS);
});

const cli = (argv: string[], opts: { env?: Record<string, string>; transport?: FakeRouter["transport"] } = {}) =>
  runCli(argv, {
    transport: opts.transport ?? router.transport,
    profile: PROFILE,
    env: { MIKROTIK_AXI_SNAPSHOT_DIR: snapDir, ...opts.env },
    runtime: { restartWaitMs: 0 },
  });

const writes = () => router.requests.filter((r) => r.method !== "GET");
const filterRule = (id: string) => (ds["/ip/firewall/filter"] as Rows).find((r) => r[".id"] === id)!;
const snapshotPath = (out: string): string => JSON.parse(/^snapshot: (".*")$/m.exec(out)![1]!) as string;
const ISOLATE = () => (ds["/ip/firewall/filter"] as Rows).find((r) => r["comment"] === "drop invalid")![".id"]!;

describe("write flow (§6)", () => {
  it("dry-run by default: prints the plan, writes nothing, no snapshot", async () => {
    const id = ISOLATE();
    const { out, code } = await cli(["fw", "filter", "disable", id]);
    expect(code).toBe(0);
    expect(out).toMatch(/^result: dry-run \(nothing changed\)$/m);
    expect(out).toContain("disabled: false → true");
    expect(out).toContain(`PATCH,/ip/firewall/filter/${id},disabled=true`);
    expect(out).toMatch(/^revert: set disabled=false on \/ip\/firewall\/filter \*/m);
    expect(out).toContain("Run the same command with --confirm to apply");
    expect(writes()).toHaveLength(0);
    expect(readdirSync(snapDir)).toHaveLength(0);
  });

  it("--confirm: snapshot → write → read back → revert command; revert restores", async () => {
    const id = ISOLATE();
    const applied = await cli(["fw", "filter", "disable", id, "--confirm"]);
    expect(applied.code).toBe(0);
    expect(applied.out).toMatch(/^result: applied$/m);
    expect(applied.out).toMatch(/^verified: disabled=true$/m);
    expect(filterRule(id)["disabled"]).toBe("true");
    const snap = snapshotPath(applied.out);
    const saved = JSON.parse(readFileSync(snap, "utf8"));
    expect(saved).toMatchObject({ version: 1, device: "ccr2004", identity: "CCR2004", command: `fw filter disable ${id}` });
    expect(saved.before.disabled).toBe("false");
    expect(saved.revert).toEqual({ op: "set", menu: "/ip/firewall/filter", id, body: { disabled: "false" } });
    expect(applied.out).toContain(`mikrotik-axi revert`);

    const dry = await cli(["revert", snap]);
    expect(dry.out).toMatch(/^result: dry-run/m);
    expect(filterRule(id)["disabled"]).toBe("true");
    const undone = await cli(["revert", snap, "--confirm"]);
    expect(undone.code).toBe(0);
    expect(undone.out).toMatch(/^result: applied$/m);
    expect(undone.out).toMatch(/^reverting: /m);
    expect(filterRule(id)["disabled"]).toBe("false");
  });

  it("idempotent: already in the desired state ⇒ no-op, no write, no snapshot", async () => {
    const { out, code } = await cli(["fw", "filter", "enable", ISOLATE(), "--confirm"]);
    expect(code).toBe(0);
    expect(out).toMatch(/^result: no-op$/m);
    expect(out).toMatch(/^reason: already disabled=false$/m);
    expect(writes()).toHaveLength(0);
    expect(readdirSync(snapDir)).toHaveLength(0);
  });

  it("read-back mismatch ⇒ `write did not take effect`, exit 1, snapshot kept", async () => {
    const silent = fakeRouter(ds, CREDS, { ignoreWrites: true });
    const { out, code } = await cli(["fw", "filter", "disable", ISOLATE(), "--confirm"], { transport: silent.transport });
    expect(code).toBe(1);
    expect(out).toMatch(/^error: "write did not take effect: disabled is false, wanted true"$/m);
    expect(out).toContain("revert");
    expect(readdirSync(join(snapDir, "ccr2004"))).toHaveLength(1);
  });

  it("MIKROTIK_AXI_READ_ONLY=1 refuses --confirm (dry-run still allowed)", async () => {
    const env = { MIKROTIK_AXI_READ_ONLY: "1" };
    const dry = await cli(["fw", "filter", "disable", ISOLATE()], { env });
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("Writes are disabled here");
    const real = await cli(["fw", "filter", "disable", ISOLATE(), "--confirm"], { env });
    expect(real.code).toBe(1);
    expect(real.out).toMatch(/^code: WRITE_REFUSED$/m);
    expect(writes()).toHaveLength(0);
  });

  it("--no-identity-check is rejected for writes", async () => {
    const { code, out } = await cli(["fw", "filter", "disable", ISOLATE(), "--no-identity-check"]);
    expect(code).toBe(2);
    expect(out).toContain("not allowed for write commands");
    expect(router.requests).toHaveLength(0);
  });

  it("identity mismatch stops a write before reading the target", async () => {
    ds["/system/identity"] = { name: "other-router" };
    const { code } = await cli(["fw", "filter", "disable", ISOLATE(), "--confirm"]);
    expect(code).toBe(1);
    expect(router.requests.map((r) => r.url.pathname)).toEqual(["/rest/system/identity", "/rest/system/identity"]);
  });

  it("protected NAT port and comment prefix are refused, even as dry-run", async () => {
    const nat = ds["/ip/firewall/nat"] as Rows;
    const ha = nat.find((r) => r["comment"] === "HA_HTTPS")!;
    ha["comment"] = "public https"; // chỉ còn dst-port 443 bảo vệ nó
    const byPort = await cli(["fw", "nat", "disable", ha[".id"]!]);
    expect(byPort.code).toBe(1);
    expect(byPort.out).toContain("dst-port 443 includes protected port 443");

    const mss = (ds["/ip/firewall/mangle"] as Rows)[0]!;
    const byComment = await cli(["fw", "mangle", "disable", mss[".id"]!]);
    expect(byComment.out).toContain('comment \\"MSS_ALL_LAN_OUT\\" has protected prefix MSS_');
    expect(byComment.out).toMatch(/^code: WRITE_REFUSED$/m);
  });

  it("dynamic rules are refused at plan time", async () => {
    const { code, out } = await cli(["fw", "filter", "disable", "*1"]);
    expect(code).toBe(1);
    expect(out).toContain("is dynamic and cannot be modified");
  });

  it("only .id is accepted (idx shifts), unknown .id names the listing command", async () => {
    expect((await cli(["fw", "filter", "disable", "3"])).code).toBe(2);
    const missing = await cli(["fw", "filter", "disable", "*ABCDEF"]);
    expect(missing.code).toBe(2);
    expect(missing.out).toContain("fw filter --fields idx,id,chain,action,comment");
  });
});

describe("addr-list", () => {
  it("add → idempotent → remove → revert re-adds", async () => {
    const add = await cli(["addr-list", "add", "AXI_TEST", "192.0.2.7", "--comment", "AXI_TEST_unit", "--confirm"]);
    expect(add.code).toBe(0);
    expect(add.out).toMatch(/^changes\[1\]: add list=AXI_TEST address=192.0.2.7 comment=AXI_TEST_unit$/m);
    const list = () => (ds["/ip/firewall/address-list"] as Rows).filter((r) => r["list"] === "AXI_TEST");
    expect(list()).toHaveLength(1);

    expect((await cli(["addr-list", "add", "AXI_TEST", "192.0.2.7", "--confirm"])).out).toMatch(/^result: no-op$/m);

    const rm = await cli(["addr-list", "remove", "AXI_TEST", "192.0.2.7", "--confirm"]);
    expect(rm.code).toBe(0);
    expect(list()).toHaveLength(0);
    const back = await cli(["revert", snapshotPath(rm.out), "--confirm"]);
    expect(back.code).toBe(0);
    expect(list()).toEqual([expect.objectContaining({ address: "192.0.2.7", comment: "AXI_TEST_unit" })]);
  });

  it("rejects comma lists (trap #3), dynamic entries and protected comments", async () => {
    expect((await cli(["addr-list", "add", "X", "10.0.0.1,10.0.0.2"])).code).toBe(2);
    expect((await cli(["addr-list", "remove", "blocked", "203.0.113.66"])).out).toContain("is dynamic");
    expect((await cli(["addr-list", "remove", "HA_ALLOW", "192.168.100.10"])).out).toContain("protected prefix HA_");
  });
});

describe("pppoe restart", () => {
  it("disables then enables, warns when it carries the main default", async () => {
    const dry = await cli(["pppoe", "restart", "pppoe-out1"]);
    expect(dry.out).toContain("pppoe-out1 carries the active main default route");
    const { out, code } = await cli(["pppoe", "restart", "pppoe-out1", "--confirm"]);
    expect(code).toBe(0);
    expect(writes().map((r) => r.body)).toEqual(['{"disabled":"true"}', '{"disabled":"false"}']);
    expect(out).toMatch(/^verified: disabled=false; running=true$/m);
  });

  it("refuses disabled and unknown sessions", async () => {
    expect((await cli(["pppoe", "restart", "pppoe-out241"])).out).toContain("is disabled");
    expect((await cli(["pppoe", "restart", "pppoe-out99"])).code).toBe(2);
  });
});

describe("arp flush", () => {
  it("removes a dynamic entry; revert has nothing to do", async () => {
    const { out, code } = await cli(["arp", "flush", "10.100.0.240", "--confirm"]);
    expect(code).toBe(0);
    expect((ds["/ip/arp"] as Rows).some((r) => r["address"] === "10.100.0.240")).toBe(false);
    const rev = await cli(["revert", snapshotPath(out)]);
    expect(rev.out).toMatch(/^result: nothing to revert$/m);
  });

  it("refuses static entries; unknown address is a no-op", async () => {
    expect((await cli(["arp", "flush", "10.100.0.10", "--confirm"])).out).toMatch(/^code: WRITE_REFUSED$/m);
    expect((await cli(["arp", "flush", "10.9.9.9", "--confirm"])).out).toMatch(/^result: no-op$/m);
  });
});

describe("revert safety", () => {
  it("refuses when the device identity changed since the snapshot", async () => {
    const applied = await cli(["fw", "filter", "disable", ISOLATE(), "--confirm"]);
    const snap = snapshotPath(applied.out);
    const saved = JSON.parse(readFileSync(snap, "utf8"));
    saved.identity = "OTHER";
    writeFileSync(snap, JSON.stringify(saved));
    const { code, out } = await cli(["revert", snap, "--confirm"]);
    expect(code).toBe(1);
    expect(out).toMatch(/^code: IDENTITY_MISMATCH$/m);
  });

  it("rejects files that are not snapshots", async () => {
    const bogus = join(snapDir, "x.json");
    writeFileSync(bogus, "{}");
    expect((await cli(["revert", bogus])).out).toContain("not a mikrotik-axi snapshot");
    expect(existsSync(bogus)).toBe(true);
  });

  it("snapshots never contain secrets", async () => {
    (ds["/ip/firewall/filter"] as Rows).find((r) => r["comment"] === "drop invalid")!["password"] = "hunter2";
    const applied = await cli(["fw", "filter", "disable", ISOLATE(), "--confirm"]);
    expect(readFileSync(snapshotPath(applied.out), "utf8")).not.toContain("hunter2");
  });
});

describe("helpers", () => {
  it("portSpecIncludes", () => {
    expect(portSpecIncludes("80", 80)).toBe(true);
    expect(portSpecIncludes("8000-8100,443", 443)).toBe(true);
    expect(portSpecIncludes("8000-8100", 80)).toBe(false);
    expect(portSpecIncludes(undefined, 80)).toBe(false);
  });

  it("sameValue treats yes/true and missing/false as equal", () => {
    expect(sameValue("yes", "true")).toBe(true);
    expect(sameValue(undefined, "false")).toBe(true);
    expect(sameValue("1452", "1452")).toBe(true);
    expect(sameValue("a", "b")).toBe(false);
  });
});

describe("credential_env_write (least privilege)", () => {
  const RO = { user: "axi-ro", pass: "test-pass", readOnly: true };
  const RW = { user: "axi-rw", pass: "rw-pass" };
  const auth = (c: { user: string; pass: string }) => `Basic ${Buffer.from(`${c.user}:${c.pass}`).toString("base64")}`;
  const withWrite = (() => {
    const p = structuredClone(PROFILE) as typeof PROFILE & { devices: { ccr2004: Record<string, unknown> } };
    p.devices.ccr2004["credential_env_write"] = { user: "AXI_RW_USER", pass: "AXI_RW_PASS" };
    return p;
  })();
  const run = (argv: string[], profile: unknown, env: Record<string, string>, r: FakeRouter) =>
    runCli(argv, { transport: r.transport, profile, env: { MIKROTIK_AXI_SNAPSHOT_DIR: snapDir, ...env }, runtime: { restartWaitMs: 0 } });

  it("write commands authenticate as the write user; read commands never do", async () => {
    const r = fakeRouter(ds, [RO, RW]);
    const env = { AXI_RW_USER: RW.user, AXI_RW_PASS: RW.pass };
    const w = await run(["fw", "filter", "disable", ISOLATE(), "--confirm"], withWrite, env, r);
    expect(w.code).toBe(0);
    expect(new Set(r.requests.filter((q) => q.headers["Authorization"]).map((q) => q.headers["Authorization"]))).toEqual(new Set([auth(RW)]));
    r.requests.length = 0;
    const rd = await run(["health"], withWrite, env, r);
    expect(rd.code).toBe(0);
    expect(r.requests.filter((q) => q.headers["Authorization"]).every((q) => q.headers["Authorization"] === auth(RO))).toBe(true);
  });

  it("without credential_env_write a write runs as the read user, the router says 403, and the error points at the fix", async () => {
    const r = fakeRouter(ds, [RO, RW]);
    const { code, out } = await run(["fw", "filter", "disable", ISOLATE(), "--confirm"], PROFILE, {}, r);
    expect(code).toBe(1);
    expect(out).toMatch(/^code: AUTH_ERROR$/m);
    expect(out).toContain("set credential_env_write for this device in the profile");
  });

  it("credential_env_write configured but env missing: config error naming the variables, no request sent", async () => {
    const r = fakeRouter(ds, [RO, RW]);
    const { code, out } = await run(["fw", "filter", "disable", ISOLATE()], withWrite, {}, r);
    expect(code).toBe(1);
    expect(out).toContain("credentials for ccr2004 missing: AXI_RW_USER, AXI_RW_PASS not set");
    expect(r.requests).toHaveLength(0);
  });
});
