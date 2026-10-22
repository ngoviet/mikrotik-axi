// Sinh fixture TỔNG HỢP cho test (không cần router), mô phỏng một CCR2004 đa WAN (40 PPPoE
// qua VRRP, 43 VLAN) và một switch CRS326. Mọi IP công khai thuộc dải tài liệu (RFC 5737).
// Thay bằng bản ghi thật: `pnpm fixtures:record`.
// Chạy: node scripts/gen-synthetic-fixtures.mjs test/fixtures   (ghi ccr2004/ và crs326/)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("usage: node scripts/gen-synthetic-fixtures.mjs <fixtures-dir>");
let dir = join(root, "ccr2004");
mkdirSync(dir, { recursive: true });
const w = (menu, data) =>
  writeFileSync(join(dir, `${menu.slice(1).replaceAll("/", "__")}.json`), `${JSON.stringify(data, null, 2)}\n`);
let seq = 0x10;
const nid = () => `*${(seq++).toString(16).toUpperCase()}`;
const b = (v) => (v ? "true" : "false");

// ---- hệ thống ----
w("/system/identity", { name: "CCR2004" });
w("/system/resource", {
  "architecture-name": "arm64", "board-name": "CCR2004-16G-2S+", "cpu-count": "4", "cpu-load": "6",
  "free-memory": "3521900544", "total-memory": "4294967296", uptime: "1w5d4h12m3s", version: "7.24.4 (stable)",
});
w("/system/clock", { date: "2026-10-13", time: "07:30:00", "time-zone-name": "Asia/Ho_Chi_Minh", "gmt-offset": "+07:00" });
w("/system/health", [
  { ".id": "*D", name: "cpu-temperature", type: "C", value: "47" },
  { ".id": "*E", name: "fan1-speed", type: "RPM", value: "3120" },
]);
w("/system/package/update", { channel: "stable", "installed-version": "7.24.4", "latest-version": "7.24.5", status: "New version is available" });

// ---- WAN: vrrpN bám thẳng etherX, 8 phiên/line; out241 + vrrp241 là nháp đã tắt ----
const pppoe = [], vrrp = [], ifaces = [], addrs = [];
for (let n = 1; n <= 16; n++) ifaces.push({ name: `ether${n}`, type: "ether", running: b(n <= 5 || (n >= 2 && n <= 19)), disabled: "false", "rx-byte": String(n * 1e9), "tx-byte": String(n * 5e8), "last-link-up-time": "2026-09-30 21:04:11", "link-downs": "1" });
for (let n = 1; n <= 2; n++) ifaces.push({ name: `sfp-sfpplus${n}`, type: "ether", running: "false", disabled: "false", "rx-byte": "0", "tx-byte": "0", "link-downs": "0" });
ifaces.push({ name: "bridge1", type: "bridge", running: "true", disabled: "false", "rx-byte": "9000000000", "tx-byte": "8000000000", "link-downs": "0" });
for (let n = 1; n <= 40; n++) {
  const port = `ether${Math.ceil(n / 8)}`;
  vrrp.push({ ".id": nid(), name: `vrrp${n}`, interface: port, vrid: String(n), priority: n === 1 ? "254" : "100", running: "true", disabled: "false" });
  pppoe.push({ ".id": nid(), name: `pppoe-out${n}`, interface: `vrrp${n}`, user: "***", running: "true", disabled: "false",
    "add-default-route": "true", "default-route-distance": n === 1 ? "1" : "2", comment: `Line-${Math.ceil(n / 8)}` });
  ifaces.push({ name: `pppoe-out${n}`, type: "pppoe-out", running: "true", disabled: "false", "rx-byte": String(1e8 * n), "tx-byte": String(2e7 * n), "last-link-up-time": `2026-10-0${1 + (n % 9)} 0${n % 10}:00:00`, "link-downs": String(n % 3) });
  addrs.push({ ".id": nid(), address: `203.0.113.${100 + n}/32`, network: `100.64.0.${n}`, interface: `pppoe-out${n}`, dynamic: "true", disabled: "false" });
}
vrrp.push({ ".id": nid(), name: "vrrp241", interface: "ether3", vrid: "241", priority: "100", running: "false", disabled: "true" });
pppoe.push({ ".id": nid(), name: "pppoe-out241", interface: "vrrp241", user: "***", running: "false", disabled: "true", "add-default-route": "true", "default-route-distance": "2" });
ifaces.push({ name: "pppoe-out241", type: "pppoe-out", running: "false", disabled: "true", "rx-byte": "0", "tx-byte": "0", "link-downs": "0" });
w("/interface/pppoe-client", pppoe);
w("/interface/vrrp", vrrp);

// ---- VLAN + DHCP: 43 VLAN (10, 20, 100, 101..140), mỗi VLAN 1 DHCP server + pool ----
const vlanIds = [10, 20, 100, ...Array.from({ length: 40 }, (_, i) => 101 + i)];
const vlans = [], servers = [], pools = [], used = [], leases = [];
for (const v of vlanIds) {
  vlans.push({ ".id": nid(), name: `vlan${v}`, interface: "bridge1", "vlan-id": String(v), running: "true", disabled: "false" });
  ifaces.push({ name: `vlan${v}`, type: "vlan", running: "true", disabled: "false", "rx-byte": String(v * 1e6), "tx-byte": String(v * 2e6), "link-downs": "0" });
  addrs.push({ ".id": nid(), address: `10.${v}.0.1/24`, network: `10.${v}.0.0`, interface: `vlan${v}`, dynamic: "false", disabled: "false" });
  servers.push({ ".id": nid(), name: `dhcp-vlan${v}`, interface: `vlan${v}`, "address-pool": `pool-vlan${v}`, disabled: "false" });
  // vlan100 pool nhỏ (10 địa chỉ) để có ca "pool sắp đầy"
  pools.push({ ".id": nid(), name: `pool-vlan${v}`, ranges: v === 100 ? "10.100.0.240-10.100.0.249" : `10.${v}.0.10-10.${v}.0.254` });
}
let bound = 0;
for (let i = 0; i < 250; i++) {
  const others = vlanIds.filter((x) => x !== 100);
  const v = i < 9 ? 100 : others[i % others.length];
  const isBound = bound < 233 && i % 15 !== 14;
  if (isBound) bound++;
  const addr = v === 100 ? `10.100.0.${240 + i}` : `10.${v}.0.${10 + Math.floor(i / others.length)}`;
  leases.push({ ".id": nid(), address: addr, "mac-address": `02:00:00:00:${(i >> 8).toString(16).padStart(2, "0")}:${(i & 255).toString(16).padStart(2, "0")}`.toUpperCase(),
    server: `dhcp-vlan${v}`, status: isBound ? "bound" : "waiting", dynamic: b(isBound), "host-name": `host-${i}` });
  if (isBound) used.push({ pool: `pool-vlan${v}`, address: addr, owner: "dhcp", info: `dhcp-vlan${v}` });
}
w("/interface/vlan", vlans);
w("/interface", ifaces.map((r) => ({ ".id": nid(), ...r })));
w("/ip/address", addrs);
w("/ip/dhcp-server", servers);
w("/ip/dhcp-server/lease", leases);
w("/ip/pool", pools);
w("/ip/pool/used", used);

// ---- ROUTE: main = po1 d=1 active + po2..po40 d=2 (động); mỗi phiên 1 bảng to-poN ----
const routes = [];
for (let n = 1; n <= 40; n++) {
  routes.push({ ".id": `*8000${(0x100 + n).toString(16).toUpperCase()}`, "dst-address": "0.0.0.0/0", gateway: `pppoe-out${n}`,
    distance: n === 1 ? "1" : "2", "routing-table": "main", active: b(n === 1), dynamic: "true", disabled: "false" });
  routes.push({ ".id": nid(), "dst-address": "0.0.0.0/0", gateway: `pppoe-out${n}`, distance: "1", "routing-table": `to-po${n}`, active: "true", dynamic: "false", disabled: "false" });
}
routes.push({ ".id": nid(), "dst-address": "10.100.0.0/24", gateway: "vlan100", distance: "0", "routing-table": "main", active: "true", dynamic: "true" });
w("/ip/route", routes);
const rules = [];
for (let n = 1; n <= 40; n++) rules.push({ ".id": nid(), "src-address": `10.${100 + n}.0.0/24`, action: "lookup-only-in-table", table: `to-po${n}`, disabled: "false", comment: `FARM-${n}` });
rules.push({ ".id": nid(), "dst-address": "10.0.0.0/8", action: "lookup", table: "main", disabled: "false" });
rules.push({ ".id": nid(), "dst-address": "192.168.0.0/16", action: "lookup", table: "main", disabled: "false" });
w("/routing/rule", rules);

// ---- MANGLE: thứ tự như thật — change-mss TRƯỚC TRF-* (accept) ----
const mangle = [];
const m = (r) => mangle.push({ ".id": nid(), disabled: "false", dynamic: "false", bytes: "0", packets: "0", ...r });
m({ chain: "forward", action: "change-mss", protocol: "tcp", "tcp-flags": "syn", "new-mss": "1452", "tcp-mss": "1453-65535", "out-interface-list": "WAN_TOTAL", comment: "MSS_ALL_LAN_OUT", packets: "90211" });
m({ chain: "prerouting", action: "accept", protocol: "udp", "dst-port": "53", comment: "DNS_BYPASS_PBR", packets: "52011" });
m({ chain: "forward", action: "change-mss", protocol: "tcp", "tcp-flags": "syn", "new-mss": "1452", "tcp-mss": "1453-65535", "in-interface-list": "WAN_TOTAL", comment: "MSS_ALL_LAN_IN", packets: "88012" });
m({ chain: "forward", action: "change-mss", protocol: "tcp", "tcp-flags": "syn", "new-mss": "1440", "tcp-mss": "1441-65535", comment: "GIA_DINH_FIX_MSS_1", packets: "1200" });
m({ chain: "forward", action: "change-mss", protocol: "tcp", "tcp-flags": "syn", "new-mss": "1440", "tcp-mss": "1441-65535", comment: "GIA_DINH_FIX_MSS_2", packets: "1100" });
m({ chain: "output", action: "change-mss", protocol: "tcp", "tcp-flags": "syn", "new-mss": "clamp-to-pmtu", comment: "MSS_ROUTER_OUT", packets: "310" });
for (const v of vlanIds.filter((x) => x >= 101)) {
  m({ chain: "prerouting", action: "mark-routing", "src-address": `10.${v}.0.0/24`, "new-routing-mark": `to-po${v - 100}`, passthrough: "false", comment: `Mark-V${v}`, packets: String(v * 1000) });
}
for (const v of [239, 240]) {
  for (let k = 0; k < 2; k++) m({ chain: "prerouting", action: "mark-routing", "src-address": `10.${v}.0.0/24`, "new-routing-mark": `to-po${v - 200}`, passthrough: "false", comment: `Mark-V${v}`, packets: k ? "0" : "4500" });
}
for (let n = 1; n <= 40; n++) m({ chain: "forward", action: "accept", "out-interface": `pppoe-out${n}`, "connection-mark": `grass-${n}`, comment: `TRF-grass-po${n}`, packets: "0" });
for (let n = 1; n <= 40; n++) m({ chain: "forward", action: "accept", "out-interface": `pppoe-out${n}`, comment: `TRF-web-po${n}`, packets: String(1000 + n) });
w("/ip/firewall/mangle", mangle);

// ---- FILTER / NAT / RAW ----
const fw = (chain, action, comment, packets, extra = {}) => ({ ".id": nid(), chain, action, comment, packets, bytes: String(Number(packets) * 900), disabled: "false", dynamic: "false", ...extra });
w("/ip/firewall/filter", [
  { ".id": "*1", chain: "forward", action: "passthrough", comment: "special dummy rule to show fasttrack counters", packets: "812345", dynamic: "true", disabled: "false" },
  fw("input", "accept", "accept established,related", "1203344", { "connection-state": "established,related" }),
  fw("input", "drop", "drop invalid", "301", { "connection-state": "invalid" }),
  fw("input", "accept", "MGMT from vlan100", "5512", { "in-interface": "vlan100" }),
  fw("input", "drop", "drop all else from WAN", "88211", { "in-interface-list": "WAN_TOTAL" }),
  fw("forward", "fasttrack-connection", "fasttrack", "9123341", { "connection-state": "established,related" }),
  fw("forward", "accept", "accept established,related", "9123341", { "connection-state": "established,related" }),
  fw("forward", "drop", "drop invalid", "1201", { "connection-state": "invalid" }),
  fw("forward", "drop", "ISOLATE_GUEST", "0", { "in-interface": "vlan20", disabled: "true" }),
  fw("forward", "drop", "drop WAN not DSTNATed", "4402", { "connection-nat-state": "!dstnat", "in-interface-list": "WAN_TOTAL" }),
]);
const nat = [fw("srcnat", "masquerade", "masq WAN", "7712003", { "out-interface-list": "WAN_TOTAL" })];
nat.push(fw("dstnat", "dst-nat", "HA_HTTP", "1201", { protocol: "tcp", "dst-port": "80", "to-addresses": "192.168.100.10", "to-ports": "8123" }));
nat.push(fw("dstnat", "dst-nat", "HA_HTTPS", "3311", { protocol: "tcp", "dst-port": "443", "to-addresses": "192.168.100.10", "to-ports": "443" }));
for (let n = 1; n <= 14; n++) nat.push(fw("srcnat", "src-nat", `FARM-SNAT-${n}`, String(n * 100), { "src-address": `10.${100 + n}.0.0/24`, "out-interface": `pppoe-out${n}` }));
w("/ip/firewall/nat", nat);
w("/ip/firewall/raw", []);

// ---- DỊCH VỤ / MAC-SERVER / NETWATCH / BRIDGE ----
const svc = (name, port, disabled, from) => ({ ".id": nid(), name, port: String(port), disabled: b(disabled), dynamic: "false", address: "", "available-from": from, invalid: "false" });
// Từ 7.2x /ip/service có cả entry ĐỘNG (bẫy #7): socket nội bộ + từng kết nối đang mở, không có
// available-from. Dạng dưới đây chép theo bản đo thật trên 7.24.4 (2026-10-14).
const dynSvc = (name, port, proto, extra = {}) => ({ ".id": nid(), name, port: String(port), proto, disabled: "false", dynamic: "true", invalid: "false", ...extra });
w("/ip/service", [
  svc("api", 8728, true, ""), svc("api-ssl", 8729, true, ""), svc("ftp", 21, true, ""),
  svc("ssh", 22222, false, "192.168.100.0/24"), svc("telnet", 23, true, ""),
  svc("winbox", 8291, false, "192.168.100.0/24"), svc("www", 80, false, "192.168.100.0/24"), svc("www-ssl", 443, true, ""),
  svc("reverse-proxy", 443, true, ""),
  dynSvc("resolver", 53, "udp"), dynSvc("dhcp", 67, "udp"), dynSvc("ntp", 123, "udp"),
  dynSvc("detnet", 32984, "udp"), dynSvc("detnet", 32985, "udp"), dynSvc("detnet", 32986, "udp"),
  dynSvc("www", 80, "tcp", { connection: "true", local: "192.168.100.1", remote: "192.168.100.50:59927" }),
  dynSvc("winbox", 8291, "tcp", { connection: "true", local: "192.168.100.1", remote: "192.168.100.50:59616" }),
]);
w("/ip/reverse-proxy", []);
w("/tool/mac-server", { "allowed-interface-list": "all" });
w("/tool/mac-server/mac-winbox", { "allowed-interface-list": "all" });
w("/tool/netwatch", []);
const ports = [];
for (let n = 6; n <= 15; n++) ports.push({ ".id": nid(), interface: `ether${n}`, bridge: "bridge1", disabled: "false", "bpdu-guard": "false", edge: "auto", dynamic: "false" });
for (let n = 1; n <= 2; n++) ports.push({ ".id": nid(), interface: `sfp-sfpplus${n}`, bridge: "bridge1", disabled: "false", "bpdu-guard": "false", dynamic: "false" });
ports.push({ ".id": nid(), interface: "ether16", bridge: "bridge1", disabled: "true", "bpdu-guard": "false", dynamic: "false" });
w("/interface/bridge/port", ports);
w("/interface/ethernet", [
  ...Array.from({ length: 16 }, (_, i) => ({ ".id": nid(), name: `ether${i + 1}`, "loop-protect": i === 5 ? "on" : "default" })),
  ...[1, 2].map((n) => ({ ".id": nid(), name: `sfp-sfpplus${n}`, "loop-protect": "default" })),
]);

// ---- ARP / ADDRESS-LIST ----
w("/ip/arp", [
  { ".id": nid(), address: "10.100.0.240", "mac-address": "02:00:00:00:00:00", interface: "vlan100", dynamic: "true", complete: "true", disabled: "false" },
  { ".id": nid(), address: "10.100.0.10", "mac-address": "02:00:00:00:AA:01", interface: "vlan100", dynamic: "false", complete: "true", disabled: "false", comment: "HA server" },
]);
w("/ip/firewall/address-list", [
  { ".id": nid(), list: "MGMT", address: "192.168.100.50", disabled: "false", dynamic: "false", "creation-time": "2026-09-26 12:00:00", comment: "admin-pc" },
  { ".id": nid(), list: "HA_ALLOW", address: "192.168.100.10", disabled: "false", dynamic: "false", "creation-time": "2026-09-26 12:00:00", comment: "HA_server" },
  { ".id": nid(), list: "blocked", address: "203.0.113.66", disabled: "false", dynamic: "true", timeout: "23:59:00", "creation-time": "2026-10-13 07:00:00" },
]);

// ---- LOG ----
const topics = ["system,info", "dhcp,info", "pppoe,ppp,info", "system,error,critical", "firewall,info"];
const msgs = ["user axi-ro logged in from 192.168.100.50 via rest", "dhcp-vlan120 assigned 10.120.0.14 to 02:00:00:00:00:1A", "pppoe-out17: connected", "login failure for user admin from 203.0.113.9 via ssh", "input: in:pppoe-out1 out:(unknown 0), proto TCP (SYN) 198.51.100.7:51515->203.0.113.101:23"];
const log = [];
for (let i = 0; i < 120; i++) {
  const sec = 3 * 3600 + 30 * 60 + i * 120; // 03:30 → 07:28 hôm nay (đồng hồ router 07:30)
  const t = `2026-10-13 ${String(Math.floor(sec / 3600)).padStart(2, "0")}:${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}:00`;
  log.push({ ".id": nid(), time: t, topics: topics[i % 5], message: msgs[i % 5] });
}
w("/log", log);
console.log(`wrote ${dir}`);

// ================================================================ CRS326 (switch L2, RouterOS)
seq = 0x10;
dir = join(root, "crs326");
mkdirSync(dir, { recursive: true });
w("/system/identity", { name: "CRS326" });
w("/system/resource", { "board-name": "CRS326-24G-2S+", "cpu-load": "3", "free-memory": "460000000", "total-memory": "536870912", uptime: "4w2d1h", version: "7.24.4 (stable)" });
w("/system/clock", { date: "2026-10-13", time: "07:30:00" });
w("/system/health", [{ ".id": "*1", name: "temperature", type: "C", value: "39" }]);
w("/system/package/update", { channel: "stable", "installed-version": "7.24.4" });
const swIfaces = [];
for (let n = 1; n <= 24; n++) swIfaces.push({ ".id": nid(), name: `ether${n}`, type: "ether", running: b(n <= 12), disabled: "false", "rx-byte": String(n * 1e8), "tx-byte": String(n * 9e7), "link-downs": "0" });
for (const n of [1, 2]) swIfaces.push({ ".id": nid(), name: `sfp-sfpplus${n}`, type: "ether", running: b(n === 1), disabled: "false", "rx-byte": "5000000000", "tx-byte": "4000000000", "link-downs": "0" });
swIfaces.push({ ".id": nid(), name: "bridge", type: "bridge", running: "true", disabled: "false", "rx-byte": "1", "tx-byte": "1", "link-downs": "0" });
swIfaces.push({ ".id": nid(), name: "vlan100", type: "vlan", running: "true", disabled: "false", "rx-byte": "1", "tx-byte": "1", "link-downs": "0" });
w("/interface", swIfaces);
w("/interface/pppoe-client", []);
w("/interface/vrrp", []);
w("/interface/vlan", [{ ".id": nid(), name: "vlan100", interface: "bridge", "vlan-id": "100", running: "true", disabled: "false" }]);
w("/interface/ethernet", [...Array.from({ length: 24 }, (_, i) => ({ ".id": nid(), name: `ether${i + 1}`, "loop-protect": "default" })), { ".id": nid(), name: "sfp-sfpplus1", "loop-protect": "default" }]);
w("/interface/bridge/port", [
  ...Array.from({ length: 23 }, (_, i) => ({ ".id": nid(), interface: `ether${i + 2}`, bridge: "bridge", disabled: "false", "bpdu-guard": "false", dynamic: "false" })),
  { ".id": nid(), interface: "sfp-sfpplus1", bridge: "bridge", disabled: "false", "bpdu-guard": "false", dynamic: "false" },
]);
w("/ip/address", [{ ".id": nid(), address: "192.168.100.254/24", network: "192.168.100.0", interface: "vlan100", dynamic: "false", disabled: "false" }]);
w("/ip/route", [
  { ".id": nid(), "dst-address": "0.0.0.0/0", gateway: "192.168.100.1", distance: "1", "routing-table": "main", active: "true", dynamic: "false", disabled: "false" },
  { ".id": "*80000001", "dst-address": "192.168.100.0/24", gateway: "vlan100", distance: "0", "routing-table": "main", active: "true", dynamic: "true" },
]);
w("/routing/rule", []);
for (const m of ["/ip/dhcp-server", "/ip/dhcp-server/lease", "/ip/pool", "/ip/pool/used", "/ip/firewall/filter", "/ip/firewall/nat", "/ip/firewall/mangle", "/ip/firewall/raw", "/ip/firewall/address-list", "/tool/netwatch"]) w(m, []);
w("/ip/arp", [{ ".id": nid(), address: "192.168.100.1", "mac-address": "02:00:00:00:01:01", interface: "vlan100", dynamic: "true", complete: "true" }]);
w("/ip/service", [
  svc("api", 8728, true, ""), svc("api-ssl", 8729, true, ""), svc("ftp", 21, true, ""), svc("ssh", 22, false, "192.168.100.0/24"),
  svc("telnet", 23, true, ""), svc("winbox", 8291, false, "192.168.100.0/24"), svc("www", 80, false, "192.168.100.0/24"), svc("www-ssl", 443, true, ""),
  // Đo thật CRS310/CRS326 7.24.4: reverse-proxy BẬT, available-from rỗng, nhưng 0 rule ⇒ không nghe 443.
  svc("reverse-proxy", 443, false, ""),
]);
w("/ip/reverse-proxy", []);
w("/tool/mac-server", { "allowed-interface-list": "LAN" });
w("/tool/mac-server/mac-winbox", { "allowed-interface-list": "LAN" });
w("/log", [
  { ".id": nid(), time: "2026-10-13 06:45:00", topics: "interface,info", message: "ether7 link down" },
  { ".id": nid(), time: "2026-10-13 06:45:09", topics: "interface,info", message: "ether7 link up (speed 1G, full duplex)" },
]);
console.log(`wrote ${dir}`);
