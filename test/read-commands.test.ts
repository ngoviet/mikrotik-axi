import { describe, expect, it } from "vitest";
import { poolSize } from "../src/commands/dhcp.js";
import { parseClock, parseLogTime } from "../src/commands/log.js";
import type { Dataset } from "./helpers/fake-router.js";
import { fakeRouter, loadDataset } from "./helpers/fake-router.js";
import { CREDS, runCli } from "./helpers/run.js";

type Rows = Array<Record<string, string>>;

async function run(argv: string[], mutate?: (ds: Dataset) => void) {
  const ds = loadDataset("ccr2004");
  mutate?.(ds);
  const router = fakeRouter(ds, CREDS);
  return { ...(await runCli(argv, { transport: router.transport })), requests: router.requests };
}

describe("wan", () => {
  it("per-line table derived from pppoe → vrrp → ether, labels from line_map", async () => {
    const { out, code } = await run(["wan"]);
    expect(code).toBe(0);
    expect(out).toMatch(/^running: 40\/40$/m);
    expect(out).toContain("lines[5]{line,port,running,total}:\n  Line 1,ether1,8,8\n");
    expect(out).toMatch(/^disabled: pppoe-out241$/m);
    expect(out).toMatch(/^sessions\[41\]\{name,line,running,up_since\}:$/m);
  });

  it("wan ips flags sessions sharing a public IP", async () => {
    const { out } = await run(["wan", "ips"], (ds) => {
      const a = ds["/ip/address"] as Rows;
      a.find((x) => x["interface"] === "pppoe-out9")!["address"] = a.find((x) => x["interface"] === "pppoe-out3")!["address"]!;
    });
    expect(out).toMatch(/^shared_ips: "203\.0\.113\.103 \(pppoe-out3, pppoe-out9\)"$/m);
  });

  it("unknown sub-command and field exit 2 before any request", async () => {
    const a = await run(["wan", "nope"]);
    expect(a.code).toBe(2);
    expect(a.requests).toHaveLength(0);
    const b = await run(["wan", "--fields", "name,bogus"]);
    expect(b.code).toBe(2);
    expect(b.out).toContain("Available fields: name, line, running");
    expect(b.requests).toHaveLength(0);
  });
});

describe("routes", () => {
  it("defaults: one row per routing-table, main first, no merged count", async () => {
    const { out } = await run(["routes", "defaults"]);
    expect(out).toMatch(/^main: pppoe-out1 \(1 active of 40\)$/m);
    expect(out).toMatch(/^warnings: none/m);
    expect(out).toContain("tables[41]{table,routes,active,gateway}:\n  main,40,1,pppoe-out1\n  to-po1,1,1,pppoe-out1\n");
  });

  it("defaults warns on a table with no active default", async () => {
    const { out } = await run(["routes", "defaults"], (ds) => {
      (ds["/ip/route"] as Rows).find((r) => r["routing-table"] === "to-po7")!["active"] = "false";
    });
    expect(out).toMatch(/^warnings: to-po7 \(0 active\)$/m);
  });

  it("--table main lists routes and explains dynamic ones", async () => {
    const { out } = await run(["routes", "defaults", "--table", "main"]);
    expect(out).toMatch(/^active: pppoe-out1$/m);
    expect(out).toContain("routes[40]{gateway,distance,active,dynamic}:\n  pppoe-out1,1,true,true\n");
    expect(out).toContain("default-route-distance");
  });

  it("rules marks rules whose source a mangle mark-routing already decides", async () => {
    const { out } = await run(["routes", "rules"]);
    expect(out).toMatch(/^decided_by_mangle: 40 enabled rule\(s\)/m);
    expect(out).toContain("rules[42]{idx,src_address,table,decided_by_mangle}:\n  0,10.101.0.0/24,to-po1,mangle #6 Mark-V101\n");
  });
});

describe("dhcp", () => {
  it("servers with pool usage; flags pools >= 90%", async () => {
    const { out } = await run(["dhcp"]);
    expect(out).toMatch(/^bound: 233 of 250 leases$/m);
    expect(out).toMatch(/^pools_near_full: pool-vlan100 9\/10$/m);
    expect(out).toContain("dhcp-vlan100,9,9,9/10 90%");
  });

  it("leases <server> explains waiting static reservations", async () => {
    const { out } = await run(["dhcp", "leases", "dhcp-vlan113"]);
    expect(out).toMatch(/^server: dhcp-vlan113$/m);
    expect(out).toMatch(/^note: "2 static reservation\(s\) waiting: normal when the device is offline"$/m);
  });

  it("leases of an unknown server lists valid names", async () => {
    const { out, code } = await run(["dhcp", "leases", "nope"]);
    expect(code).toBe(2);
    expect(out).toContain("Servers: dhcp-vlan10, dhcp-vlan20, dhcp-vlan100");
  });

  it("poolSize handles ranges and single addresses", () => {
    expect(poolSize("10.0.0.10-10.0.0.254")).toBe(245);
    expect(poolSize("10.0.0.1-10.0.0.2,10.0.1.5")).toBe(3);
    expect(poolSize("2001:db8::/64")).toBeUndefined();
  });
});

describe("fw", () => {
  it("lists rules in processing order with per-chain counts", async () => {
    const { out } = await run(["fw", "nat"]);
    expect(out).toMatch(/^summary: "17 rules \(17 enabled, 0 disabled, 0 dynamic\)"$/m);
    expect(out).toContain("rules[17]{idx,chain,action,comment,packets}:\n  0,srcnat,masquerade,masq WAN,7712003\n");
  });

  it("truncates long tables to 50 rows with a hint, --full shows all", async () => {
    const short = await run(["fw", "mangle"]);
    expect(short.out).toMatch(/^count: 50 of 130 total$/m);
    expect(short.out).toContain("Run `mikrotik-axi fw mangle --full` to list all 130");
    const full = await run(["fw", "mangle", "--full"]);
    expect(full.out).toMatch(/^count: 130$/m);
  });

  it("--chain filters but keeps the original idx; --fields adds columns and asks the router for them", async () => {
    const { out, requests } = await run(["fw", "mangle", "--chain", "output", "--fields", "idx,new_mss,comment"]);
    expect(out).toContain("rules[1]{idx,new_mss,comment}:\n  5,clamp-to-pmtu,MSS_ROUTER_OUT\n");
    expect(requests.at(-1)!.url.search).toContain("new-mss");
  });

  it("mangle check reports order, raise and duplicates", async () => {
    const ok = await run(["fw", "mangle", "check"]);
    expect(ok.out).toMatch(/^mss_order: "ok:/m);
    expect(ok.out).toMatch(/^dup_mark: "WARN: Mark-V239 at #46, #47; Mark-V240 at #48, #49"$/m);
    const bad = await run(["fw", "mangle", "check"], (ds) => {
      const m = ds["/ip/firewall/mangle"] as Rows;
      m.push(m.splice(0, 1)[0]!);
    });
    expect(bad.out).toMatch(/^mss_order: "FAIL: 1 change-mss rule\(s\) after the first accept/m);
  });

  it("rejects an unknown table", async () => {
    const { code, out } = await run(["fw", "bogus"]);
    expect(code).toBe(2);
    expect(out).toContain("expected one of filter, nat, mangle, raw");
  });
});

describe("services, vlans, iface", () => {
  it("services shows available_from, never address", async () => {
    const { out, requests } = await run(["services"]);
    expect(out).toMatch(/^open_to_any: none$/m);
    expect(out).toContain("ssh,22222,false,192.168.100.0/24");
    expect(out).not.toMatch(/\baddress\b/);
    const svcReq = requests.find((r) => r.url.pathname === "/rest/ip/service")!;
    expect(svcReq.url.search).toBe("?dynamic=false&.proplist=name,port,disabled,dynamic,available-from");
  });

  it("services ignores dynamic sockets and live connections (trap #7, RouterOS 7.2x)", async () => {
    const { out } = await run(["services"]);
    expect(out).toMatch(/^count: 9$/m);
    expect(out).not.toMatch(/resolver|detnet|ntp|dhcp/);
    // Router bỏ qua `?dynamic=false` ⇒ client vẫn tự lọc; home không báo service-open giả.
    const ds = loadDataset("ccr2004");
    const loose = fakeRouter(ds, CREDS, { ignoreQuery: true }).transport;
    const svc = await runCli(["services"], { transport: loose });
    expect(svc.out).toMatch(/^count: 9$/m);
    expect(svc.out).toMatch(/^open_to_any: none$/m);
    const home = await runCli([], { transport: loose });
    expect(home.out).not.toContain("service-open");
  });

  it("vlans sorted by id with addresses", async () => {
    const { out } = await run(["vlans"]);
    expect(out).toContain("vlans[43]{name,vlan_id,address,running}:\n  vlan10,10,10.10.0.1/24,true\n");
  });

  it("iface --type sfp, counters from /interface", async () => {
    const { out } = await run(["iface", "--type", "sfp"]);
    expect(out).toMatch(/^down: "2 \(sfp-sfpplus1, sfp-sfpplus2\)"$/m);
    const bad = await run(["iface", "--type", "wifi"]);
    expect(bad.code).toBe(2);
  });
});

describe("log", () => {
  it("--since uses the router clock; --topic and --grep filter", async () => {
    const { out } = await run(["log", "--since", "1h", "--topic", "error", "--grep", "login fail"]);
    // Đồng hồ router 07:30, log 03:30 → 07:28 mỗi 2 phút, topic error mỗi 5 dòng.
    expect(out).toMatch(/^matched: 6 of 120 entries$/m);
    expect(out).toMatch(/^by_topic: "system,error,critical 6"$/m);
  });

  it("states how much time the log buffer really covers", async () => {
    const { out } = await run(["log", "--since", "1h"]);
    expect(out).toMatch(/^covers: "2026-10-13 03:30:00 → 2026-10-13 07:28:00 \(3h58m\)"$/m);
    expect(out).not.toMatch(/^warning:/m);
    expect(out).toMatch(/^top_messages: /m);
  });

  it("warns when the buffer is shorter than --since (measured live: 2000 lines = 2.5 min)", async () => {
    const { out } = await run(["log", "--since", "1h"], (ds) => {
      const flood = Array.from({ length: 40 }, (_, i) => ({
        ".id": `*F${i}`,
        time: `2026-10-13 07:2${Math.floor(i / 20) + 7}:${String((i * 3) % 60).padStart(2, "0")}`,
        topics: "firewall,info",
        message: `DROP_INPUT: input: in:pppoe-out${(i % 40) + 1} proto TCP (SYN)`,
      }));
      ds["/log"] = flood;
    });
    expect(out).toMatch(/^warning: "log buffer holds only 1m57s, less than --since 1h: older entries are gone"$/m);
    expect(out).toMatch(/^top_messages: DROP_INPUT 40$/m);
    expect(out).toContain("raise /system/logging/action memory-lines");
  });

  it("keeps the newest 50 by default", async () => {
    const { out } = await run(["log"]);
    expect(out).toMatch(/^count: 50 of 120 total$/m);
    expect(out).toContain('"2026-10-13 07:28:00"');
  });

  it("invalid --since and --grep exit 2", async () => {
    expect((await run(["log", "--since", "soon"])).code).toBe(2);
    expect((await run(["log", "--grep", "("])).code).toBe(2);
  });

  it("parses every RouterOS log time format against the router clock", () => {
    const now = parseClock("2026-10-13", "07:30:00")!;
    expect(parseClock("oct/13/2026", "07:30:00")).toBe(now);
    const at = (v: string) => (parseLogTime(v, now)! - now) / 3600;
    expect(at("2026-10-13 06:30:00")).toBe(-1);
    expect(at("06:30:00")).toBe(-1);
    expect(at("10-13 06:30:00")).toBe(-1);
    expect(at("oct/13 06:30:00")).toBe(-1);
    expect(at("oct/12/2026 07:30:00")).toBe(-24);
    // Thiếu năm và rơi vào tương lai ⇒ năm trước.
    expect(at("dec/31 23:00:00")).toBeLessThan(-24 * 280);
    expect(parseLogTime("garbage", now)).toBeUndefined();
  });
});
