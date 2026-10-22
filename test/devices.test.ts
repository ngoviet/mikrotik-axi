import { describe, expect, it } from "vitest";
import { TransportError, type Transport } from "../src/ros/transport.js";
import { fakeRouter, loadDataset } from "./helpers/fake-router.js";
import { CREDS, runCli } from "./helpers/run.js";

// TEST_PROFILE: ccr2004 @ https://192.168.100.1, crs326 @ http://192.168.100.254.
function network(opts: { crs326Down?: boolean } = {}): Transport {
  const ccr = fakeRouter(loadDataset("ccr2004"), CREDS).transport;
  const crs = fakeRouter(loadDataset("crs326"), CREDS).transport;
  return async (req) => {
    if (req.url.hostname === "192.168.100.254") {
      if (opts.crs326Down) throw new TransportError("timeout", "timeout");
      return crs(req);
    }
    return ccr(req);
  };
}

describe("switch (CRS326) home view", () => {
  it("no router-only noise: only switch-relevant alerts", async () => {
    const { out, code, err } = await runCli(["home", "--device", "crs326"], { transport: network() });
    expect(code).toBe(0);
    expect(out).toMatch(/^device: "crs326 \(identity CRS326 ok, RouterOS 7\.24\.4 \(stable\), up 30d1h\)"$/m);
    expect(out).toMatch(/^wan: no pppoe clients$/m);
    expect(out).toMatch(/^main_default: 192\.168\.100\.1 \(1 active of 1\)$/m);
    expect(out).toMatch(/^dhcp: 0 servers · 0 bound$/m);
    expect(out).toContain(
      "alerts[2]{id,message}:\n  service-open,reverse-proxy enabled with no proxy rules (not listening yet); disable it or set available-from\n  loop-protect,\"bridge ports without loop-protect or bpdu-guard: 24\"\n",
    );
    expect(out).not.toMatch(/no-netwatch|main-default|version/);
    expect(err).toBe("warning: plaintext credentials to crs326 (use https)\n");
  });

  it("switch health reads the plain `temperature` sensor", async () => {
    const { out } = await runCli(["health", "--device", "crs326", "--fields", "board,temp,version_check"], { transport: network() });
    expect(out).toBe('board: CRS326-24G-2S+\ntemp: 39C\nversion_check: "unknown (router has not checked for updates, channel stable)"\n');
  });
});

describe("devices", () => {
  it("checks every profile device in parallel", async () => {
    const { out, code } = await runCli(["devices"], { transport: network() });
    expect(code).toBe(0);
    expect(out).toMatch(/^ok: 2\/2$/m);
    expect(out).toContain("devices[2]{name,status,identity,version}:\n  ccr2004,ok,CCR2004,7.24.4 (stable)\n  crs326,ok,CRS326,7.24.4 (stable)\n");
  });

  it("one unreachable device does not hide the others", async () => {
    const { out, code } = await runCli(["devices"], { transport: network({ crs326Down: true }) });
    expect(code).toBe(0);
    expect(out).toMatch(/^ok: 1\/2$/m);
    expect(out).toMatch(/^ {2}crs326,unreachable,crs326 \(192\.168\.100\.254\) unreachable/m);
  });

  it("home on a multi-device profile points at `devices` when there is room", async () => {
    const ds = loadDataset("crs326");
    ds["/interface/bridge/port"] = [];
    const { out } = await runCli(["home", "--device", "crs326"], { transport: fakeRouter(ds, CREDS).transport });
    expect(out).toContain("Run `mikrotik-axi devices` for all 2 devices in the profile");
  });
});

describe("reverse-proxy is only 'open' when it can listen", () => {
  const home = async (mutate: (ds: ReturnType<typeof loadDataset>) => void, failRp?: number) => {
    const ds = loadDataset("crs326");
    mutate(ds);
    const r = fakeRouter(ds, CREDS, failRp ? { fail: { "/ip/reverse-proxy": { status: failRp, headers: { "content-type": "application/json" }, body: "{}" } } } : {});
    return (await runCli(["home", "--device", "crs326"], { transport: r.transport })).out;
  };

  it("with an active proxy rule it is open to any source", async () => {
    const out = await home((ds) => (ds["/ip/reverse-proxy"] = [{ ".id": "*1", disabled: "false" }]));
    expect(out).toContain('service-open,"management service(s) open to any source: reverse-proxy"');
  });

  it("disabled proxy rules do not count", async () => {
    const out = await home((ds) => (ds["/ip/reverse-proxy"] = [{ ".id": "*1", disabled: "true" }]));
    expect(out).toContain("service-open,reverse-proxy enabled with no proxy rules (not listening yet)");
  });

  it("older RouterOS without the menu (400 no such command) means no rules", async () => {
    const out = await home((ds) => delete ds["/ip/reverse-proxy"]);
    expect(out).toContain("reverse-proxy enabled with no proxy rules");
    expect(out).not.toMatch(/checks_skipped/);
  });

  it("cannot read the rules (403) ⇒ conservative: open", async () => {
    const out = await home(() => {}, 403);
    expect(out).toContain('service-open,"management service(s) open to any source: reverse-proxy"');
  });

  it("services command explains the idle service", async () => {
    const { out } = await runCli(["services", "--device", "crs326"], { transport: fakeRouter(loadDataset("crs326"), CREDS).transport });
    expect(out).toMatch(/^open_to_any: none$/m);
    expect(out).toMatch(/^idle: "reverse-proxy: enabled with no proxy rules, not listening \(disable it or set available-from\)"$/m);
  });
});
