import { describe, expect, it } from "vitest";
import type { Dataset } from "./helpers/fake-router.js";
import { fakeRouter, foreignDevice, loadDataset } from "./helpers/fake-router.js";
import { CREDS, runCli } from "./helpers/run.js";
import { MAX_CONCURRENT } from "../src/ros/client.js";
import { TransportError, type Transport } from "../src/ros/transport.js";

const ccr = (mutate?: (ds: Dataset) => void) => {
  const ds = loadDataset("ccr2004");
  mutate?.(ds);
  return fakeRouter(ds, CREDS);
};

/** Sau dòng header (bin/description), phần còn lại của home view. */
const body = (out: string) =>
  out
    .split("\n")
    .filter((l) => !/^(bin|description):/.test(l))
    .join("\n");

describe("home view", () => {
  it("summarises the CCR2004 fixture in the §3.3 shape", async () => {
    const { out, code, err } = await runCli([], { transport: ccr().transport });
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(body(out)).toBe(
      [
        'device: "ccr2004 (identity CCR2004 ok, RouterOS 7.24.4 (stable), up 12d4h)"',
        'health: "cpu 6%, mem 18%, temp 47C"',
        "wan: 40/40 pppoe running (1 disabled) · lines 8/8/8/8/8",
        "main_default: pppoe-out1 (1 active of 40)",
        "dhcp: 43 servers · 233 bound",
        "alerts[6]{id,message}:",
        "  no-netwatch,no netwatch or check-gateway for main default (ISP route loss undetected)",
        "  mac-server,mac-telnet and mac-winbox allowed on all interfaces",
        '  loop-protect,"bridge ports without loop-protect or bpdu-guard: 11"',
        '  zero-hit,"40 enabled rule(s) with 0 packets after 12d4h: TRF-grass-po* ×40 (mangle)"',
        '  dup-mark,"duplicate mark-routing: Mark-V239 ×2, Mark-V240 ×2"',
        "  version,RouterOS 7.24.5 available (installed 7.24.4)",
        "help[2]: Run `mikrotik-axi routes defaults` for default routes per table,Run `mikrotik-axi fw mangle check` to audit rule order",
        "",
      ].join("\n"),
    );
  });

  it("is short enough for a session hook (≤ 20 lines)", async () => {
    const { out } = await runCli([], { transport: ccr().transport });
    expect(out.trimEnd().split("\n").length).toBeLessThanOrEqual(20);
  });

  it("uses only .proplist GETs, runs the guard first, and never writes", async () => {
    const router = ccr();
    await runCli([], { transport: router.transport });
    const reqs = router.requests;
    expect(reqs[0]!.url.pathname).toBe("/rest/system/identity");
    expect(reqs[0]!.headers["Authorization"]).toBeUndefined();
    expect(reqs.every((r) => r.method === "GET")).toBe(true);
    expect(reqs.slice(1).every((r) => r.url.search.includes(".proplist="))).toBe(true);
  });

  it("names short lines and down sessions", async () => {
    const router = ccr((ds) => {
      const rows = ds["/interface/pppoe-client"] as Array<Record<string, string>>;
      for (const name of ["pppoe-out17", "pppoe-out20"]) rows.find((r) => r["name"] === name)!["running"] = "false";
    });
    const { out } = await runCli([], { transport: router.transport });
    expect(out).toContain('wan: "38/40 pppoe running (1 disabled) · lines 8/8/6/8/8 (short: Line 3 6/8)"');
    expect(out).toContain('wan_down: "pppoe-out17, pppoe-out20"');
  });

  it("fetches in parallel within the concurrency cap", async () => {
    // 50 ms mỗi request. Tuần tự ~21 request ≈ 1050 ms; guard 2 lượt + ⌈19/6⌉ = 4 lượt ≈ 300 ms.
    const router = fakeRouter(loadDataset("ccr2004"), CREDS, { latencyMs: 50 });
    let inFlight = 0;
    let peak = 0;
    const counting: Transport = async (req) => {
      peak = Math.max(peak, ++inFlight);
      try {
        return await router.transport(req);
      } finally {
        inFlight--;
      }
    };
    const t0 = performance.now();
    const { code } = await runCli([], { transport: counting });
    const ms = performance.now() - t0;
    expect(code).toBe(0);
    expect(router.requests.length).toBeGreaterThanOrEqual(19);
    expect(peak).toBe(MAX_CONCURRENT);
    expect(ms).toBeLessThan(router.requests.length * 50 * 0.5);
  });

  it("one failing menu degrades one line, not the whole view", async () => {
    const ds = loadDataset("ccr2004");
    const router = fakeRouter(ds, CREDS, {
      fail: { "/ip/dhcp-server": { status: 403, headers: { "content-type": "application/json" }, body: "{}" } },
    });
    const { out, code } = await runCli([], { transport: router.transport });
    expect(code).toBe(0);
    expect(out).toMatch(/^dhcp: unavailable \(permission denied on ccr2004 for GET \/ip\/dhcp-server\)$/m);
    expect(out).toContain("main_default: pppoe-out1");
  });

  it("a request timing out AFTER the identity check says 'timed out', not 'unreachable'", async () => {
    const base = ccr().transport;
    const flaky: Transport = async (req) => {
      if (req.url.pathname === "/rest/ip/dhcp-server") throw new TransportError("timeout", "timeout");
      return base(req);
    };
    const { out, code } = await runCli([], { transport: flaky });
    expect(code).toBe(0);
    expect(out).toMatch(
      /^dhcp: unavailable \(ccr2004 \(192\.168\.100\.1\) timed out on \/ip\/dhcp-server after 5s \(router busy\)\)$/m,
    );
    expect(out).not.toContain("unreachable");
  });

  it("unreachable device: header + error + help, exit 1, within the timeout", async () => {
    const down: Transport = async (req) => {
      throw new TransportError(`timeout ${req.timeoutMs / 1000}s`, "timeout");
    };
    const { out, code } = await runCli([], { transport: down });
    expect(code).toBe(1);
    expect(out).toMatch(/^bin: /m);
    expect(out).toMatch(/^error: ccr2004 \(192\.168\.100\.1\) unreachable \(timeout 5s\)$/m);
    expect(out).toMatch(/^code: UNREACHABLE$/m);
    expect(out).toMatch(/^help\[2\]:/m);
  });

  it("ZTE answering at the router address is blocked", async () => {
    const { out, code } = await runCli([], { transport: foreignDevice("zte-404.json").transport });
    expect(code).toBe(1);
    expect(out).toContain("is not RouterOS");
    expect(out).toMatch(/^code: NOT_ROUTEROS$/m);
  });

  it("missing credentials explain which env vars to set", async () => {
    const { out, code } = await runCli([], { transport: ccr().transport, env: { MIKROTIK_AXI_PASS: "" } });
    expect(code).toBe(1);
    expect(out).toContain("MIKROTIK_AXI_PASS not set");
  });

  it("`home --device` selects another device and warns about plaintext http on stderr", async () => {
    const ds = loadDataset("ccr2004");
    ds["/system/identity"] = { name: "CRS326" };
    ds["/interface/pppoe-client"] = [];
    const { out, err, code } = await runCli(["home", "--device", "crs326"], { transport: fakeRouter(ds, CREDS).transport });
    expect(code).toBe(0);
    expect(out).toMatch(/^bin: /m);
    expect(out).toContain("identity CRS326 ok");
    expect(out).toContain("wan: no pppoe clients");
    expect(err).toBe("warning: plaintext credentials to crs326 (use https)\n");
  });
});

describe("health", () => {
  it("reports resource, temperature and the router's existing update check", async () => {
    const { out, code } = await runCli(["health"], { transport: ccr().transport });
    expect(code).toBe(0);
    expect(out).toBe(
      [
        "device: ccr2004",
        "identity: CCR2004 (verified)",
        "board: CCR2004-16G-2S+",
        "version: 7.24.4 (stable)",
        "uptime: 12d4h",
        "cpu: 6%",
        "mem: 18% of 4.0GiB",
        "temp: 47C",
        'version_check: "7.24.5 available (installed 7.24.4, channel stable)"',
        "",
      ].join("\n"),
    );
  });

  it("--fields limits output; unknown field exits 2", async () => {
    const ok = await runCli(["health", "--fields", "cpu,temp"], { transport: ccr().transport });
    expect(ok.out).toBe("cpu: 6%\ntemp: 47C\n");
    const bad = await runCli(["health", "--fields", "cpu,nope"], { transport: ccr().transport });
    expect(bad.code).toBe(2);
    expect(bad.out).toContain("Available fields: device, identity");
  });

  it("identity mismatch stops the command (exit 1)", async () => {
    const { out, code } = await runCli(["health"], {
      transport: ccr((ds) => (ds["/system/identity"] = { name: "Neighbor-ZTE" })).transport,
    });
    expect(code).toBe(1);
    expect(out).toMatch(/^code: IDENTITY_MISMATCH$/m);
  });

  it("--no-identity-check lets a read through and says so", async () => {
    const { out, code } = await runCli(["health", "--no-identity-check"], {
      transport: ccr((ds) => (ds["/system/identity"] = { name: "Other" })).transport,
    });
    expect(code).toBe(0);
    expect(out).toContain("identity: Other (not checked)");
  });
});
