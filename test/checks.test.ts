import { describe, expect, it } from "vitest";
import { commentGroup, duplicateMarks, mssAfterAccept, mssRaise, zeroHitGroups } from "../src/checks/firewall.js";
import { RULE_IDS } from "../src/checks/index.js";
import type { Dataset } from "./helpers/fake-router.js";
import { fakeRouter, loadDataset } from "./helpers/fake-router.js";
import { CREDS, runCli, TEST_PROFILE } from "./helpers/run.js";

type Rows = Array<Record<string, string>>;

async function alertIds(mutate?: (ds: Dataset) => void, profile: unknown = TEST_PROFILE): Promise<{ ids: string[]; out: string }> {
  const ds = loadDataset("ccr2004");
  mutate?.(ds);
  const { out } = await runCli([], { transport: fakeRouter(ds, CREDS).transport, profile });
  const block = /^alerts\[\d+\]\{id,message\}:\n((?: {2}.*\n)+)/m.exec(out)?.[1] ?? "";
  return { ids: block.split("\n").filter(Boolean).map((l) => l.trim().split(",")[0]!), out };
}

const BASELINE = ["no-netwatch", "mac-server", "loop-protect", "zero-hit", "dup-mark", "version"];

describe("alerts on the CCR2004 fixture (mirrors the documented real state)", () => {
  it("baseline", async () => {
    expect((await alertIds()).ids).toEqual(BASELINE);
  });

  it("pppoe-down uses expect.pppoe_running when set", async () => {
    const profile = structuredClone(TEST_PROFILE) as typeof TEST_PROFILE & { devices: { ccr2004: { expect?: object } } };
    profile.devices.ccr2004.expect = { pppoe_running: 41 };
    const { ids, out } = await alertIds(undefined, profile);
    expect(ids[0]).toBe("pppoe-down");
    expect(out).toContain("pppoe-down,40/41 pppoe running");
  });

  it("main-default fires on two active defaults and on an unexpected gateway", async () => {
    const two = await alertIds((ds) => {
      (ds["/ip/route"] as Rows).find((r) => r["gateway"] === "pppoe-out2" && r["routing-table"] === "main")!["active"] = "true";
    });
    expect(two.out).toContain("main-default,table main has 2 active default routes (expected 1)");

    const profile = structuredClone(TEST_PROFILE) as typeof TEST_PROFILE & { devices: { ccr2004: { expect?: object } } };
    profile.devices.ccr2004.expect = { main_default_gateway: "pppoe-out9" };
    expect((await alertIds(undefined, profile)).out).toContain("main-default,\"main default via pppoe-out1, expected pppoe-out9\"");
  });

  it("no-netwatch clears once an enabled netwatch exists", async () => {
    const { ids } = await alertIds((ds) => (ds["/tool/netwatch"] = [{ ".id": "*1", host: "1.1.1.1", disabled: "false" }]));
    expect(ids).not.toContain("no-netwatch");
  });

  it("mss-order: a change-mss moved after the first forward accept", async () => {
    const { ids, out } = await alertIds((ds) => {
      const m = ds["/ip/firewall/mangle"] as Rows;
      const [mss] = m.splice(3, 1); // GIA_DINH_FIX_MSS_1
      m.push(mss!);
    });
    expect(ids).toContain("mss-order");
    expect(out).toContain("GIA_DINH_FIX_MSS_1");
  });

  it("mss-raise: numeric new-mss without tcp-mss", async () => {
    const { ids } = await alertIds((ds) => delete (ds["/ip/firewall/mangle"] as Rows)[0]!["tcp-mss"]);
    expect(ids).toContain("mss-raise");
  });

  it("service-open reads available-from, never address", async () => {
    const open = await alertIds((ds) => ((ds["/ip/service"] as Rows).find((s) => s["name"] === "ssh")!["available-from"] = ""));
    expect(open.out).toContain('service-open,"management service(s) open to any source: ssh"');
    // address có giá trị nhưng available-from rỗng ⇒ vẫn mở (bẫy #5)
    const trap = await alertIds((ds) => {
      const www = (ds["/ip/service"] as Rows).find((s) => s["name"] === "www")!;
      www["address"] = "192.168.100.0/24";
      www["available-from"] = "";
    });
    expect(trap.out).toContain("open to any source: www");
  });

  it("zero-hit is skipped right after a reboot", async () => {
    const { ids } = await alertIds((ds) => ((ds["/system/resource"] as Record<string, string>)["uptime"] = "3h"));
    expect(ids).not.toContain("zero-hit");
  });

  it("alerts.disabled in the profile silences rules", async () => {
    const profile = structuredClone(TEST_PROFILE) as typeof TEST_PROFILE & { devices: { ccr2004: { alerts?: object } } };
    profile.devices.ccr2004.alerts = { disabled: ["zero-hit", "version"] };
    expect((await alertIds(undefined, profile)).ids).toEqual(["no-netwatch", "mac-server", "loop-protect", "dup-mark"]);
  });

  it("missing data is reported as checks_skipped, not silently ignored", async () => {
    const ds = loadDataset("ccr2004");
    const router = fakeRouter(ds, CREDS, {
      fail: { "/ip/firewall/mangle": { status: 403, headers: { "content-type": "application/json" }, body: "{}" } },
    });
    const { out, code } = await runCli([], { transport: router.transport });
    expect(code).toBe(0);
    expect(out).toMatch(/^checks_skipped: "dup-mark, mss-order, mss-raise, zero-hit \(data unavailable\)"$/m);
  });

  it("caps the home view at 20 lines even when every rule fires", async () => {
    const ds = loadDataset("ccr2004");
    (ds["/ip/route"] as Rows).forEach((r) => (r["active"] = "true"));
    (ds["/ip/service"] as Rows).forEach((s) => (s["available-from"] = ""));
    const m = ds["/ip/firewall/mangle"] as Rows;
    delete m[0]!["tcp-mss"];
    m.push(m.splice(3, 1)[0]!);
    (ds["/interface/pppoe-client"] as Rows).slice(0, 3).forEach((p) => (p["running"] = "false"));
    const { out } = await runCli([], { transport: fakeRouter(ds, CREDS).transport });
    expect(out.trimEnd().split("\n").length).toBeLessThanOrEqual(20);
    expect(out).toMatch(/^ {2}more,"?\d+ more/m);
  });

  it("profile validation knows every rule id", () => {
    expect(RULE_IDS).toHaveLength(11);
  });
});

describe("firewall analysis (pure)", () => {
  const r = (o: Record<string, string>) => ({ disabled: "false", ...o });

  it("mssAfterAccept is per chain", () => {
    const rules = [
      r({ chain: "prerouting", action: "accept" }),
      r({ chain: "forward", action: "change-mss", "new-mss": "1452" }),
      r({ chain: "forward", action: "accept" }),
      r({ chain: "forward", action: "change-mss", "new-mss": "1452", comment: "late" }),
      r({ chain: "forward", action: "change-mss", disabled: "true" }),
    ];
    expect(mssAfterAccept(rules)).toEqual([{ idx: 3, chain: "forward", comment: "late", firstAccept: 2 }]);
  });

  it("mssRaise ignores clamp-to-pmtu and filtered rules", () => {
    const rules = [
      r({ action: "change-mss", "new-mss": "clamp-to-pmtu" }),
      r({ action: "change-mss", "new-mss": "1452", "tcp-mss": "1453-65535" }),
      r({ action: "change-mss", "new-mss": "1400", chain: "forward" }),
    ];
    expect(mssRaise(rules).map((x) => x.idx)).toEqual([2]);
  });

  it("duplicateMarks groups by chain + source + mark", () => {
    const m = { chain: "prerouting", action: "mark-routing", "src-address": "10.0.0.0/24", "new-routing-mark": "t1", comment: "Mark-V1" };
    expect(duplicateMarks([r(m), r({ ...m, "new-routing-mark": "t2" }), r(m)])).toEqual([
      { key: "prerouting|10.0.0.0/24|t1", label: "Mark-V1", idx: [0, 2] },
    ]);
  });

  it("zero-hit groups by comment stem; partially used groups are fine", () => {
    expect(commentGroup("TRF-grass-po12")).toBe("TRF-grass-po*");
    expect(commentGroup("drop invalid")).toBe("drop invalid");
    const rules = [
      r({ comment: "A-1", packets: "0" }),
      r({ comment: "A-2", packets: "0" }),
      r({ comment: "B-1", packets: "0" }),
      r({ comment: "B-2", packets: "5" }),
      r({ comment: "Camera 192.168.10.0", packets: "0" }),
      r({ packets: "0" }),
      r({ packets: "0", dynamic: "true" }),
    ];
    expect(zeroHitGroups({ mangle: rules })).toEqual([
      { group: "A-*", table: "mangle", count: 2 },
      { group: "(no comment)", table: "mangle", count: 1 },
      { group: "Camera 192.168.10.0", table: "mangle", count: 1 },
    ]);
  });
});
