import { describe, expect, it } from "vitest";
import { AUDIT_IDS, runAudit, type AuditData } from "../src/checks/audit.js";
import { dnsFromWan, listResolver, neverFromWan } from "../src/checks/firewall-sim.js";
import { wanSet } from "../src/commands/audit.js";
import { egressesOf } from "../src/commands/routes.js";
import { validateProfile } from "../src/config/profile.js";
import type { Dataset } from "./helpers/fake-router.js";
import { fakeRouter, loadDataset } from "./helpers/fake-router.js";
import { CREDS, runCli, TEST_PROFILE } from "./helpers/run.js";

/** Router "sạch": mọi luật qua. Mỗi test đổi đúng một chỗ. */
function clean(): AuditData {
  return {
    services: [
      { name: "ssh", disabled: "false", "available-from": "192.0.2.0/24" },
      { name: "www-ssl", disabled: "false", "available-from": "192.0.2.0/24" },
      { name: "telnet", disabled: "true" },
    ],
    reverseProxyRules: 0,
    macServer: { "allowed-interface-list": "LAN" },
    macWinbox: { "allowed-interface-list": "LAN" },
    users: [{ name: "ops", group: "full", address: "192.0.2.10/32", disabled: "false" }],
    groups: [
      { name: "full", policy: "read,write,policy" },
      { name: "axi-read", policy: "read,api,rest-api,!write" },
    ],
    pptp: { enabled: "false" },
    l2tp: { enabled: "false", "use-ipsec": "no" },
    ssh: { "strong-crypto": "true", "host-key-type": "ed25519", "host-key-size": "256" },
    dns: { "allow-remote-requests": "true" },
    filter: [{ chain: "input", action: "drop", disabled: "false", "in-interface-list": "!LAN" }],
    upnp: { enabled: "false" },
    socks: { enabled: "false" },
    proxy: { enabled: "false" },
    snmp: { enabled: "false" },
    snmpCommunities: [{ name: "public", addresses: "::/0", disabled: "false" }],
    neighbor: { "discover-interface-list": "LAN" },
    routerboard: { "current-firmware": "7.25.1", "upgrade-firmware": "7.25.1" },
    romon: { enabled: "false" },
    wan: { interfaces: ["ether1"], unknown: [] },
    interfaceLists: [{ name: "LAN" }, { name: "WAN" }],
    listMembers: [
      { list: "LAN", interface: "bridge", disabled: "false" },
      { list: "WAN", interface: "ether1", disabled: "false" },
    ],
  };
}

/** Bối cảnh mô phỏng: WAN, list (tên ⇒ thành viên trực tiếp), list thêm (include/exclude), route chưa rõ cổng ra. */
function sim(wans: string[], lists: Record<string, string[]>, extraLists: Array<Record<string, string>> = [], unknown: string[] = []) {
  const interfaceLists = [...Object.keys(lists).map((name) => ({ name })), ...extraLists];
  const listMembers = Object.entries(lists).flatMap(([list, ifaces]) => ifaces.map((i) => ({ list, interface: i, disabled: "false" })));
  return (filter: Array<Record<string, string>>) => dnsFromWan(filter, { interfaces: wans, unknown }, listResolver(interfaceLists, listMembers));
}

const ids = (d: Partial<AuditData>, disabled: string[] = []) => runAudit(d, disabled).findings.map((f) => `${f.id}:${f.severity}`);

describe("audit rules", () => {
  it("a clean router passes every check", () => {
    const r = runAudit(clean());
    expect(r.findings).toEqual([]);
    expect(r.passed).toHaveLength(AUDIT_IDS.length);
  });

  it("admin user, and write-capable users without address", () => {
    const d = clean();
    d.users.push({ name: "admin", group: "full", address: "", disabled: "false" });
    d.users.push({ name: "bob", group: "full", address: "", disabled: "false" });
    d.users.push({ name: "reader", group: "axi-read", address: "", disabled: "false" });
    d.users.push({ name: "old", group: "full", address: "", disabled: "true" });
    const r = runAudit(d);
    expect(r.findings.map((f) => f.id)).toEqual(["admin-user", "user-open"]);
    expect(r.findings[1]!.message).toBe("write-capable users without address restriction: bob");
  });

  it("plaintext services: telnet is high, www/api alone are medium", () => {
    const d = clean();
    d.services.push({ name: "www", disabled: "false", "available-from": "10.0.0.0/8" });
    expect(ids(d)).toEqual(["plaintext-service:medium"]);
    d.services.push({ name: "telnet", disabled: "false", "available-from": "10.0.0.0/8" });
    expect(ids(d)).toEqual(["plaintext-service:high"]);
  });

  it("pptp, l2tp without ipsec, ssh, upnp, socks, snmp public, neighbor all, romon, routerboot", () => {
    const d = clean();
    d.pptp = { enabled: "true" };
    d.l2tp = { enabled: "true", "use-ipsec": "no" };
    d.ssh = { "strong-crypto": "false", "host-key-type": "rsa", "host-key-size": "1024" };
    d.upnp = { enabled: "true" };
    d.socks = { enabled: "true", "auth-method": "none" };
    d.snmp = { enabled: "true" };
    d.neighbor = { "discover-interface-list": "all" };
    d.romon = { enabled: "true" };
    d.routerboard = { "current-firmware": "7.24.4", "upgrade-firmware": "7.25.1" };
    const r = runAudit(d);
    expect(r.findings.map((f) => f.id)).toEqual(["pptp-server", "ssh-weak", "upnp", "proxy-socks", "snmp-public", "neighbor-all", "romon", "routerboot"]);
    expect(r.findings[0]!.message).toContain("L2TP server enabled without IPsec");
    expect(r.findings[1]!.message).toBe("SSH: strong-crypto=no, RSA host key 1024 bits");
  });

  it("dns-open only without a port-53 drop or an input catch-all", () => {
    const d = clean();
    d.filter = [{ chain: "input", action: "drop", disabled: "false", protocol: "tcp", "dst-port": "22" }];
    expect(ids(d)).toEqual(["dns-open:medium"]);
    d.filter.push({ chain: "input", action: "drop", disabled: "false", protocol: "udp", "dst-port": "50-60" });
    expect(ids(d)).toEqual([]);
    d.dns = { "allow-remote-requests": "false" };
    d.filter = [];
    expect(ids(d)).toEqual([]);
  });

  const drop = (extra: Record<string, string>) => ({ chain: "input", action: "drop", disabled: "false", ...extra });
  const accept = (extra: Record<string, string>) => ({ chain: "input", action: "accept", disabled: "false", ...extra });

  it("dnsFromWan: membership read from the router, never guessed from list names", () => {
    const one = sim(["ether1"], { LAN: ["bridge"], WAN: ["ether1"] });
    // Review vòng 1: drop chỉ áp LAN/một interface khác/một nguồn không bảo vệ WAN.
    expect(one([drop({ "in-interface-list": "LAN" })]).state).toBe("open");
    expect(one([drop({ "in-interface": "ether5" })]).state).toBe("open");
    expect(one([drop({ "in-interface": "ether1" })]).state).toBe("closed");
    expect(one([drop({ protocol: "tcp", "dst-port": "53", "src-address": "10.0.0.5" })]).state).toBe("open");
    expect(one([accept({ protocol: "udp", "dst-port": "53" }), drop({})])).toMatchObject({ state: "open", rule: "#1", wan: "ether1" });
    // Review vòng 2: list tên "WAN2" chỉ phủ WAN thứ hai, WAN đầu vẫn mở.
    const two = sim(["ether1", "lte1"], { WAN: ["ether1"], WAN2: ["lte1"] });
    expect(two([drop({ "in-interface-list": "WAN2" })])).toMatchObject({ state: "open", wan: "ether1" });
    expect(two([drop({ "in-interface-list": "WAN2" }), drop({ "in-interface-list": "WAN" })]).state).toBe("closed");
    // Review vòng 2: "ISP_VLAN" chứa chữ "lan" nhưng là uplink; accept trên nó mở DNS.
    const vlan = sim(["vlan100"], { ISP_VLAN: ["vlan100"], LAN: ["bridge"] });
    expect(vlan([accept({ protocol: "udp", "dst-port": "53", "in-interface-list": "ISP_VLAN" }), drop({})])).toMatchObject({ state: "open", rule: "#1" });
    // List không có trong dữ liệu ⇒ không đoán.
    expect(one([drop({ "in-interface-list": "MYSTERY" })])).toMatchObject({ state: "uncertain", why: "in-interface-list=MYSTERY" });
  });

  it("dnsFromWan: include/exclude, built-in lists, invalid rules, defconf", () => {
    // WAN_ALL include WAN1,WAN2 exclude BACKUP.
    const inc = sim(["e1", "e2"], { WAN1: ["e1"], WAN2: ["e2"], BACKUP: ["e2"] }, [{ name: "WAN_ALL", include: "WAN1,WAN2", exclude: "BACKUP" }]);
    expect(inc([drop({ "in-interface-list": "WAN_ALL" })])).toMatchObject({ state: "open", wan: "e2" });
    const all = sim(["ether1"], { LAN: ["bridge"] }, [{ name: "dynamic" }]);
    expect(all([drop({ "in-interface-list": "all" })]).state).toBe("closed");
    expect(all([drop({ "in-interface-list": "dynamic" })]).state).toBe("uncertain");
    // Rule invalid (RouterOS không áp): drop không được tính là chặn; accept không dùng để kết luận chặn.
    const one = sim(["ether1"], { LAN: ["bridge"] });
    expect(one([drop({ invalid: "true" })]).state).toBe("open");
    expect(one([accept({ invalid: "true", protocol: "udp" }), drop({})])).toMatchObject({ state: "uncertain", why: "invalid=true" });
    // Defconf đầy đủ, kể cả "accept to local loopback (for CAPsMAN)" dst-address=127.0.0.1 (review vòng 2).
    expect(
      one([
        accept({ "connection-state": "established,related,untracked", comment: "defconf: accept established,related,untracked" }),
        drop({ "connection-state": "invalid", comment: "defconf: drop invalid" }),
        accept({ protocol: "icmp", comment: "defconf: accept ICMP" }),
        accept({ "dst-address": "127.0.0.1", comment: "defconf: accept to local loopback (for CAPsMAN)" }),
        drop({ "in-interface-list": "!LAN", comment: "defconf: drop all not coming from LAN" }),
      ]),
    ).toMatchObject({ state: "closed", rule: '#5 "defconf: drop all not coming from LAN"' });
    // Không có route mặc định ⇒ không biết WAN nào.
    expect(sim([], {})([drop({})])).toMatchObject({ state: "uncertain", wans: 0 });
  });

  it("dnsFromWan: order, unknown matchers, private sources, jumps", () => {
    const one = sim(["ether1"], { LAN: ["bridge"], WAN: ["ether1"] });
    expect(one([drop({ "src-address-list": "bad" }), drop({ "in-interface-list": "WAN" })]).state).toBe("closed");
    expect(one([accept({ "src-address-list": "trusted" }), drop({})])).toMatchObject({ state: "uncertain", rule: "#1" });
    expect(one([{ chain: "input", action: "jump", "jump-target": "wan-in", disabled: "false" }])).toMatchObject({ state: "uncertain", why: "jump to wan-in" });
    // Đo thật: ALLOW_DNS_INPUT src-address=192.168.0.0/16 không khớp gói từ Internet.
    expect(one([accept({ protocol: "udp", "dst-port": "53", "src-address": "192.168.0.0/16" }), drop({ "in-interface-list": "WAN" })]).state).toBe("closed");
    expect(one([accept({ "src-address": "!192.168.0.0/16" }), drop({})]).state).toBe("open");
    expect(one([accept({ "src-address": "100.64.0.0/10" }), drop({})]).state).toBe("uncertain");
    // Review vòng 3: nhà mạng dùng 10/8, 172.16/12 cho thuê bao CGNAT ⇒ không được coi là "không từ WAN".
    expect(one([accept({ protocol: "udp", "dst-port": "53", "src-address": "10.0.0.0/8" }), drop({ "in-interface-list": "WAN" })]).state).toBe("uncertain");
    expect(one([accept({ "src-address": "172.16.0.0/12" }), drop({})]).state).toBe("uncertain");
    expect(one([drop({ limit: "10,5:packet" })]).state).toBe("uncertain");
    expect(one([drop({ disabled: "true" }), { chain: "input", action: "log", disabled: "false" }]).state).toBe("open");
    expect(one([]).state).toBe("open");
  });

  it("neverFromWan: whole 192.168/16 or 127/8 only", () => {
    for (const p of ["192.168.0.0/16", "192.168.1.0/24", "192.168.255.255", "127.0.0.1", "127.0.0.0/8"]) expect(neverFromWan(p), p).toBe(true);
    for (const p of ["10.0.0.0/8", "10.1.2.3", "172.16.0.0/12", "0.0.0.0/0", "192.0.0.0/8", "192.169.0.0/16", "100.64.0.0/10", "8.8.8.8", "192.168.1.1-192.168.1.9", "fd00::/8"]) {
      expect(neverFromWan(p), p).toBe(false);
    }
  });

  it("listResolver follows the manual's order: include, then exclude, then direct members (review round 3)", () => {
    // Repro: ether1 là thành viên TRỰC TIẾP của MGMT, MGMT exclude WANS (chứa ether1). Theo manual thành viên
    // trực tiếp được thêm SAU exclude ⇒ ether1 thuộc MGMT ⇒ accept khớp ⇒ open (bản trước: closed sai).
    const mgmt = sim(["ether1"], { WANS: ["ether1"], MGMT: ["ether1", "bridge"] }, [{ name: "MGMT", exclude: "WANS" }]);
    expect(mgmt([accept({ protocol: "udp", "dst-port": "53", "in-interface-list": "MGMT" }), drop({})])).toMatchObject({ state: "open", rule: "#1" });
    // include/exclude của list không có trong dữ liệu, hoặc vòng include ⇒ maybe, không bao giờ closed.
    const unk = sim(["ether1"], { WAN: ["ether1"] }, [{ name: "X", include: "WAN", exclude: "GHOST" }, { name: "A", include: "B" }, { name: "B", include: "A" }]);
    expect(unk([drop({ "in-interface-list": "X" })]).state).toBe("uncertain");
    expect(unk([drop({ "in-interface-list": "A" })]).state).toBe("uncertain");
  });

  it("built-in lists are recognised by name, without a builtin field (review round 3)", () => {
    const lists = sim(["ether1"], { LAN: ["bridge"] }, [{ name: "static" }, { name: "all" }, { name: "ANY", include: "all" }]);
    // Bản trước: list không có builtin ⇒ tập rỗng ⇒ accept bị bỏ qua ⇒ closed sai.
    expect(lists([accept({ "in-interface-list": "static" }), drop({})]).state).toBe("uncertain");
    expect(lists([accept({ "in-interface-list": "ANY" }), drop({})])).toMatchObject({ state: "open", rule: "#1" });
    expect(lists([accept({ "in-interface-list": "none" }), drop({})]).state).toBe("closed");
  });

  it("a default route with unknown egress forbids 'closed'; wanSet resolves ip%iface and keeps the rest as unknown", () => {
    const one = sim(["ether1"], { WAN: ["ether1"] }, [], ["203.0.113.1"]);
    expect(one([drop({ "in-interface": "ether1" })])).toMatchObject({ state: "uncertain", why: expect.stringContaining("1 default route(s) with unknown egress") });
    expect(sim([], {}, [], ["203.0.113.1"])([drop({})])).toMatchObject({ state: "uncertain", wans: 0, why: expect.stringContaining("203.0.113.1") });
    expect(
      wanSet([
        { via: "pppoe-out1", gateway: "9.9.9.9" },
        { via: "203.0.113.1", gateway: "203.0.113.1" },
        { via: "192.0.2.1%ether2", gateway: "192.0.2.1%ether2" },
        { via: "pppoe-out1", gateway: "pppoe-out1" },
      ]),
    ).toEqual({ interfaces: ["ether2", "pppoe-out1"], unknown: ["203.0.113.1"] });
  });

  it("port= matches source OR destination; dstnat state is unknown (review round 4)", () => {
    const one = sim(["ether1"], { WAN: ["ether1"] });
    // Kẻ gửi chọn cổng nguồn 123 ⇒ accept port=123 khớp được ⇒ không được kết luận closed.
    expect(one([accept({ protocol: "udp", port: "123" }), drop({})]).state).toBe("uncertain");
    expect(one([accept({ protocol: "udp", port: "1024-65535" }), drop({})]).state).toBe("uncertain");
    expect(one([accept({ protocol: "udp", port: "53" }), drop({})])).toMatchObject({ state: "open", rule: "#1" });
    expect(one([drop({ protocol: "udp", port: "53" })]).state).toBe("closed");
    expect(one([accept({ port: "!53" }), drop({})]).state).toBe("closed");
    expect(one([accept({ port: "!123" }), drop({})]).state).toBe("uncertain");
    // Một rule redirect/dst-nat cổng 53 có thể đặt trạng thái dstnat cho gói mới.
    expect(one([accept({ "connection-nat-state": "dstnat" }), drop({})]).state).toBe("uncertain");
    expect(one([accept({ "connection-nat-state": "srcnat" }), drop({})]).state).toBe("closed");
  });

  it("every ECMP next-hop is a WAN; blackhole routes are not; a route with no gateway is unknown (review round 4)", () => {
    expect(egressesOf("198.51.100.1%ether1,203.0.113.1%ether2", "198.51.100.1")).toEqual(["ether1", "ether2"]);
    expect(egressesOf(undefined, "pppoe-out1")).toEqual(["pppoe-out1"]);
    expect(wanSet([{ via: "ether1", vias: ["ether1", "ether2"], gateway: "198.51.100.1" }])).toEqual({ interfaces: ["ether1", "ether2"], unknown: [] });
    expect(wanSet([{ via: "?", vias: ["?"], gateway: "?", blackhole: true }, { via: "ether1", gateway: "ether1" }])).toEqual({ interfaces: ["ether1"], unknown: [] });
    expect(wanSet([{ via: "?", vias: ["?"], gateway: "?" }])).toEqual({ interfaces: [], unknown: ["(none)"] });
  });

  it("dns-open severity: open = medium, uncertain = low", () => {
    const d = clean();
    d.filter = [];
    expect(ids(d)).toEqual(["dns-open:medium"]);
    d.filter = [{ chain: "input", action: "drop", disabled: "false", "in-interface-list": "dynamic" }];
    expect(ids(d)).toEqual(["dns-open:low"]);
  });

  it("missing data goes to skipped, disabled ids are not run", () => {
    const d: Partial<AuditData> = clean();
    delete d.snmp;
    const r = runAudit(d, ["routerboot"]);
    expect(r.skipped).toEqual(["snmp-public"]);
    expect(r.passed).not.toContain("routerboot");
  });

  it("profile accepts audit ids in alerts.disabled", () => {
    expect(() => validateProfile({ devices: { a: { url: "https://x", alerts: { disabled: ["admin-user"] } } } })).not.toThrow();
  });
});

describe("audit command", () => {
  it("reads every menu read-only, lists findings high first, skips unreadable menus", async () => {
    const ds: Dataset = loadDataset("ccr2004");
    ds["/user"] = [{ ".id": "*1", name: "admin", group: "full", address: "", disabled: "false" }];
    ds["/user/group"] = [{ ".id": "*3", name: "full", policy: "read,write" }];
    ds["/ip/upnp"] = { enabled: "true" };
    const router = fakeRouter(ds, { ...CREDS, readOnly: true });
    const r = await runCli(["audit"], { transport: router.transport });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^verdict: "1 high, \d+ medium, \d+ low"$/m);
    expect(r.out).toMatch(/findings\[\d+\]\{id,severity,message\}:\n {2}admin-user,high,/);
    expect(r.out).toContain("upnp,medium,");
    expect(r.out).toMatch(/^checks_skipped: /m);
    expect(router.requests.every((q) => q.method === "GET")).toBe(true);
    // Không bao giờ xin mật khẩu user.
    const userReq = router.requests.find((q) => q.url.pathname === "/rest/user")!;
    expect(userReq.url.search).not.toContain("password");
  });

  it("every one of the 14 checks fires through the real read path (proplists carry the fields each rule needs)", async () => {
    // Router "tệ" theo đủ 14 luật, dữ liệu đặt đúng tên trường đã đọc trên 7.25.1. Luật nào thiếu trường
    // trong proplist sẽ không bắn ⇒ test bắt được (review: trước chỉ 5/14 luật đi qua đường lệnh).
    const ds: Dataset = loadDataset("ccr2004");
    ds["/ip/service"] = [
      { ".id": "*0", name: "telnet", port: "23", disabled: "false", dynamic: "false", "available-from": "" },
      { ".id": "*2", name: "www", port: "80", disabled: "false", dynamic: "false", "available-from": "192.0.2.0/24" },
    ];
    ds["/tool/mac-server"] = { "allowed-interface-list": "all" };
    ds["/tool/mac-server/mac-winbox"] = { "allowed-interface-list": "all" };
    ds["/user"] = [
      { ".id": "*1", name: "admin", group: "full", address: "", disabled: "false" },
      { ".id": "*5", name: "bob", group: "full", address: "", disabled: "false" },
    ];
    ds["/user/group"] = [{ ".id": "*3", name: "full", policy: "read,write,policy" }];
    ds["/interface/pptp-server/server"] = { enabled: "true" };
    ds["/interface/l2tp-server/server"] = { enabled: "false", "use-ipsec": "no" };
    ds["/ip/ssh"] = { "strong-crypto": "false", "host-key-type": "rsa", "host-key-size": "1024" };
    ds["/ip/dns"] = { "allow-remote-requests": "true" };
    ds["/ip/firewall/filter"] = [{ ".id": "*A", chain: "input", action: "drop", disabled: "false", "in-interface-list": "LAN" }];
    // WAN lấy từ route mặc định của fixture (pppoe-outN); drop chỉ áp list LAN ⇒ DNS mở từ WAN.
    ds["/interface/list"] = [{ ".id": "*1", name: "LAN", include: "", exclude: "", builtin: "false" }];
    ds["/interface/list/member"] = [{ ".id": "*1", list: "LAN", interface: "bridge", disabled: "false" }];
    ds["/ip/upnp"] = { enabled: "true" };
    ds["/ip/socks"] = { enabled: "true", "auth-method": "none" };
    ds["/ip/proxy"] = { enabled: "false" };
    ds["/snmp"] = { enabled: "true" };
    ds["/snmp/community"] = [{ ".id": "*0", name: "public", addresses: "::/0", disabled: "false" }];
    ds["/ip/neighbor/discovery-settings"] = { "discover-interface-list": "all" };
    ds["/system/routerboard"] = { "current-firmware": "7.24.4", "upgrade-firmware": "7.25.1" };
    ds["/tool/romon"] = { enabled: "true" };
    const router = fakeRouter(ds, { ...CREDS, readOnly: true });
    const r = await runCli(["audit", "--full"], { transport: router.transport });
    expect(r.code).toBe(0);
    for (const id of AUDIT_IDS) expect(r.out, id).toMatch(new RegExp(`^ {2}${id},`, "m"));
    expect(r.out).not.toContain("checks_skipped");
    expect(r.out).toMatch(/^passed: none$/m);
  });

  it("a menu absent on the model vs a failed read are told apart; nothing readable ⇒ exit 1", async () => {
    const ds: Dataset = loadDataset("ccr2004");
    const err500 = { status: 500, headers: { "content-type": "application/json" }, body: '{"error":500,"message":"Internal Server Error"}' };
    const absent = { status: 400, headers: { "content-type": "application/json" }, body: '{"error":400,"message":"Bad Request","detail":"no such command or directory (romon)"}' };
    const some = fakeRouter(ds, { ...CREDS, readOnly: true }, { fail: { "/tool/romon": absent, "/snmp": err500 } });
    const a = await runCli(["audit"], { transport: some.transport });
    expect(a.code).toBe(0);
    expect(a.out).toContain("romon (not on this device)");
    expect(a.out).toContain("snmp-public (read failed: ROS_ERROR");

    const menus = ["/ip/service", "/tool/mac-server", "/tool/mac-server/mac-winbox", "/user", "/user/group", "/interface/pptp-server/server", "/interface/l2tp-server/server", "/ip/ssh", "/ip/dns", "/ip/firewall/filter", "/ip/upnp", "/ip/socks", "/ip/proxy", "/snmp", "/snmp/community", "/ip/neighbor/discovery-settings", "/system/routerboard", "/tool/romon", "/ip/reverse-proxy"];
    const all = fakeRouter(ds, { ...CREDS, readOnly: true }, { fail: Object.fromEntries(menus.map((m) => [m, err500])) });
    const b = await runCli(["audit"], { transport: all.transport });
    expect(b.code).toBe(1);
    expect(b.out).toContain("audit: no check could run on ccr2004");
  });

  it("prints how many WAN interfaces dns-open tested, and routes it could not test", async () => {
    const ds: Dataset = loadDataset("ccr2004");
    ds["/ip/dns"] = { "allow-remote-requests": "true" };
    ds["/ip/firewall/filter"] = [{ ".id": "*A", chain: "input", action: "drop", disabled: "false" }];
    ds["/interface/list"] = [];
    ds["/interface/list/member"] = [];
    const a = await runCli(["audit"], { transport: fakeRouter(ds, { ...CREDS, readOnly: true }).transport });
    // Fixture: 80 route mặc định qua pppoe-out1..40 ⇒ 40 interface, drop tất cả ⇒ dns-open passed.
    expect(a.out).toMatch(/^wan_tested: 40 interface\(s\) carrying a default route$/m);
    expect(a.out).toMatch(/^passed: .*dns-open/m);
    // Thêm một route mặc định chưa resolve (gateway IP, không immediate-gw) ⇒ không được "passed".
    (ds["/ip/route"] as Array<Record<string, string>>).push({ ".id": "*FF", "dst-address": "0.0.0.0/0", gateway: "203.0.113.1", "routing-table": "main", distance: "9", active: "false" });
    const b = await runCli(["audit"], { transport: fakeRouter(ds, { ...CREDS, readOnly: true }).transport });
    expect(b.out).toMatch(/^wan_tested: 40 interface\(s\) carrying a default route; 1 route\(s\) with unknown egress not tested$/m);
    expect(b.out).toMatch(/ {2}dns-open,low,/);
    // DNS không nhận truy vấn từ xa ⇒ luật dừng sớm, không in wan_tested.
    ds["/ip/dns"] = { "allow-remote-requests": "false" };
    const c = await runCli(["audit"], { transport: fakeRouter(ds, { ...CREDS, readOnly: true }).transport });
    expect(c.out).toMatch(/^passed: .*dns-open/m);
    expect(c.out).not.toContain("wan_tested");
  });

  it("review round 4 repro: the second ECMP egress is tested, a blackhole default is ignored", async () => {
    const ds: Dataset = loadDataset("ccr2004");
    ds["/ip/dns"] = { "allow-remote-requests": "true" };
    ds["/ip/firewall/filter"] = [{ ".id": "*A", chain: "input", action: "drop", disabled: "false", "in-interface": "ether1" }];
    ds["/interface/list"] = [];
    ds["/interface/list/member"] = [];
    ds["/ip/route"] = [
      { ".id": "*1", "dst-address": "0.0.0.0/0", gateway: "198.51.100.1", "immediate-gw": "198.51.100.1%ether1,203.0.113.1%ether2", "routing-table": "main", distance: "1", active: "true" },
      { ".id": "*2", "dst-address": "0.0.0.0/0", blackhole: "true", "routing-table": "to-x", distance: "1", active: "true" },
    ];
    const r = await runCli(["audit", "--full"], { transport: fakeRouter(ds, { ...CREDS, readOnly: true }).transport });
    expect(r.out).toMatch(/ {2}dns-open,medium,.*arriving on ether2/);
    expect(r.out).toMatch(/^wan_tested: 2 interface\(s\) carrying a default route$/m);
    expect(r.out).not.toContain("arriving on ?");
  });

  it("every check disabled in the profile is not a read error (review repro)", async () => {
    const profile = structuredClone(TEST_PROFILE) as { devices: Record<string, Record<string, unknown>> };
    profile.devices["ccr2004"]!["alerts"] = { disabled: [...AUDIT_IDS] };
    const router = fakeRouter(loadDataset("ccr2004"), { ...CREDS, readOnly: true });
    const r = await runCli(["audit"], { transport: router.transport, profile });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^verdict: no checks enabled/m);
  });
});
