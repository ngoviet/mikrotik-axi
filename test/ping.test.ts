import { describe, expect, it } from "vitest";
import { hopsFrom, summarizePing } from "../src/commands/ping.js";
import type { Dataset } from "./helpers/fake-router.js";
import { fakeRouter, loadDataset } from "./helpers/fake-router.js";
import { CREDS, runCli } from "./helpers/run.js";

function setup(plan: Record<string, string> = {}, opts: { test?: boolean; trace?: Array<Record<string, string>> } = {}) {
  const ds: Dataset = loadDataset("ccr2004");
  ds["/ping"] = plan;
  if (opts.trace) ds["/tool/traceroute"] = opts.trace;
  const router = fakeRouter(ds, { ...CREDS, readOnly: true, test: opts.test ?? true });
  return { router, run: (argv: string[]) => runCli(argv, { transport: router.transport }) };
}

const bodies = (r: ReturnType<typeof setup>["router"], path: string) =>
  r.requests.filter((q) => q.url.pathname === `/rest${path}`).map((q) => JSON.parse(q.body!) as Record<string, string>);

describe("summarizePing (manual REST example shape)", () => {
  it("uses the totals of the last record", () => {
    const p = summarizePing([
      { "avg-rtt": "551us", "max-rtt": "551us", "min-rtt": "551us", "packet-loss": "0", received: "1", sent: "1", time: "551us" },
      { "avg-rtt": "536us", "max-rtt": "551us", "min-rtt": "521us", "packet-loss": "0", received: "2", sent: "2", time: "521us" },
    ]);
    expect(p).toEqual({ sent: 2, received: 2, loss: 0, avgMs: 0.54, minMs: 0.52, maxMs: 0.55 });
  });

  it("all lost: no rtt, status kept", () => {
    expect(summarizePing([{ sent: "1", received: "0", "packet-loss": "100", status: "timeout" }])).toEqual({
      sent: 1,
      received: 0,
      loss: 100,
      status: "timeout",
    });
  });
});

describe("ping", () => {
  it("pings from the router with count and egress interface", async () => {
    const { run, router } = setup();
    const r = await run(["ping", "1.1.1.1", "--interface", "pppoe-out3", "--count", "2"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^result: "2\/2 replies, 0% loss"$/m);
    expect(r.out).toMatch(/^via: pppoe-out3$/m);
    expect(bodies(router, "/ping")).toEqual([{ address: "1.1.1.1", count: "2", interface: "pppoe-out3" }]);
  });

  it("without the test policy: AUTH_ERROR naming the fix", async () => {
    const { run } = setup({}, { test: false });
    const r = await run(["ping", "1.1.1.1"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("lacks the `test` policy");
    expect(r.out).toContain("/user group set");
  });

  it("validates before any request: address, count range, flag mix", async () => {
    const { run, router } = setup();
    expect((await run(["ping"])).code).toBe(2);
    expect((await run(["ping", "1.1.1.1;reboot"])).code).toBe(2);
    expect((await run(["ping", "1.1.1.1", "--count", "11"])).code).toBe(2);
    expect((await run(["ping", "1.1.1.1", "--count", "0"])).code).toBe(2);
    expect((await run(["ping", "1.1.1.1", "--interface", "a b"])).code).toBe(2);
    expect((await run(["ping", "1.1.1.1", "--each-wan", "--interface", "pppoe-out1"])).code).toBe(2);
    // RouterOS v7 ping không có routing-table (CLI reference): flag đã bỏ, gõ vào ⇒ exit 2.
    expect((await run(["ping", "1.1.1.1", "--routing-table", "to-po3"])).code).toBe(2);
    expect((await run(["traceroute", "1.1.1.1", "--routing-table", "to-po3"])).code).toBe(2);
    expect(router.requests).toHaveLength(0);
  });

  it("--each-wan pings once per running session and lists only the failing ones", async () => {
    const { run, router } = setup({ "*": "reply", "pppoe-out7": "timeout" });
    const r = await run(["ping", "9.9.9.9", "--each-wan"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^reach: 39\/40 running sessions reach 9\.9\.9\.9$/m);
    expect(r.out).toMatch(/^failing: pppoe-out7$/m);
    expect(r.out).toMatch(/sessions\[1\]\{name,line,result,rtt\}:\n {2}pppoe-out7,[^,]+,0\/1 timeout,"-"/);
    const pings = bodies(router, "/ping");
    expect(pings).toHaveLength(40);
    expect(pings.every((b) => b["count"] === "1" && b["interface"]?.startsWith("pppoe-out"))).toBe(true);
  });

  it("--each-wan without the test policy stops after the first refusal", async () => {
    const { run, router } = setup({}, { test: false });
    const r = await run(["ping", "9.9.9.9", "--each-wan"]);
    expect(r.code).toBe(1);
    expect(bodies(router, "/ping")).toHaveLength(1);
  });
});

describe("traceroute", () => {
  it("keeps only the last .section snapshot", () => {
    const hops = hopsFrom([
      { ".section": "0", address: "10.0.0.1", loss: "0%", last: "1ms" },
      { ".section": "1", address: "10.0.0.1", loss: "0%", last: "2ms" },
      { ".section": "1", address: "", loss: "100%", status: "timeout" },
      { ".section": "1", address: "1.1.1.1", loss: "0%", avg: "12ms" },
    ]);
    expect(hops).toEqual([
      { hop: 1, address: "10.0.0.1", loss: "0%", rtt: "2 ms" },
      { hop: 2, address: "*", loss: "100%", rtt: "timeout" },
      { hop: 3, address: "1.1.1.1", loss: "0%", rtt: "12 ms" },
    ]);
  });

  it("host name target: names the last hop instead of claiming it was not reached (review repro)", async () => {
    const { run } = setup({}, { trace: [{ address: "10.0.0.1", loss: "0", last: "1ms" }, { address: "1.1.1.1", loss: "0", last: "9ms" }] });
    const r = await run(["traceroute", "one.one.one.one"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^summary: "2 hops, last hop 1\.1\.1\.1 \(host name target: not compared\)"$/m);
    expect(r.out).not.toContain("destination not seen");
    expect(r.out).toContain("1,10.0.0.1,0%,1 ms");
  });

  it("a hop whose last probe timed out shows timeout", () => {
    expect(hopsFrom([{ address: "", loss: "100", last: "timeout" }])).toEqual([{ hop: 1, address: "*", loss: "100%", rtt: "timeout" }]);
  });

  it("runs /tool/traceroute with count=1 and reports whether the target was reached", async () => {
    const { run, router } = setup({}, { trace: [{ address: "10.0.0.1", loss: "0%", last: "1ms" }, { address: "1.1.1.1", loss: "0%", last: "9ms" }] });
    const r = await run(["traceroute", "1.1.1.1"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^summary: "2 hops, destination reached"$/m);
    expect(bodies(router, "/tool/traceroute")).toEqual([{ address: "1.1.1.1", count: "1", "max-hops": "30" }]);
  });
});
