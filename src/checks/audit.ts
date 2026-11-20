import { toBool, toNumber, type RosRecord } from "../ros/normalize.js";
import { classifyOpen } from "./services.js";
import { dnsFromWan, listResolver, type WanSet } from "./firewall-sim.js";

// Luật kiểm BẢO MẬT cho lệnh `audit` (tách khỏi home: home không được gọi thêm REST, §7). Tên trường
// đọc thật trên CCR2004 7.25.1 bằng axi-ro (2026-11-21). Mỗi luật là hàm thuần trên dữ liệu đã đọc;
// thiếu dữ liệu (menu không có / đọc lỗi) ⇒ luật vào `skipped`, không đoán.

export type Severity = "high" | "medium" | "low";

export interface AuditData {
  services: RosRecord[];
  reverseProxyRules: number | undefined;
  macServer: RosRecord;
  macWinbox: RosRecord;
  users: RosRecord[];
  groups: RosRecord[];
  pptp: RosRecord;
  l2tp: RosRecord;
  ssh: RosRecord;
  dns: RosRecord;
  filter: RosRecord[];
  upnp: RosRecord;
  socks: RosRecord;
  proxy: RosRecord;
  snmp: RosRecord;
  snmpCommunities: RosRecord[];
  neighbor: RosRecord;
  routerboard: RosRecord;
  romon: RosRecord;
  /** Cổng ra của mọi route mặc định đang bật (mọi bảng) + gateway của route chưa rõ cổng ra. */
  wan: WanSet;
  interfaceLists: RosRecord[];
  listMembers: RosRecord[];
}

export type AuditKey = keyof AuditData;

export interface AuditRule {
  id: string;
  severity: Severity;
  summary: string;
  needs: readonly AuditKey[];
  /** Thông điệp (mức của luật), hoặc kèm mức riêng khi một luật có hai mức; null = ổn. */
  run: (d: AuditData) => string | { message: string; severity: Severity } | null;
}

const on = (r: RosRecord | undefined, k: string) => toBool(r?.[k], k);
const enabled = (r: RosRecord) => !toBool(r["disabled"], "disabled");
const list = (xs: string[], max = 4) => (xs.length > max ? `${xs.slice(0, max).join(", ")}, …` : xs.join(", "));

/** Group có quyền ghi: `full`, hoặc policy chứa `write` (không phải `!write`). */
function writeGroups(groups: RosRecord[]): Set<string> {
  const out = new Set<string>(["full"]);
  for (const g of groups) {
    if ((g["policy"] ?? "").split(",").includes("write")) out.add(g["name"] ?? "");
  }
  return out;
}

/** Plaintext management protocol ⇒ mật khẩu đi trên dây. */
const PLAINTEXT = new Map([
  ["telnet", "high"],
  ["ftp", "high"],
  ["api", "medium"],
  ["www", "medium"],
] as const);

export const AUDIT_RULES: readonly AuditRule[] = [
  {
    id: "admin-user",
    severity: "high",
    summary: "the default `admin` user is enabled",
    needs: ["users"],
    run: ({ users }) => {
      const admin = users.find((u) => u["name"] === "admin" && enabled(u));
      if (!admin) return null;
      return `default user admin is enabled${admin["address"] ? "" : " with no address restriction"} (rename or disable it; use a named user)`;
    },
  },
  {
    id: "user-open",
    severity: "medium",
    summary: "an enabled user that can write has no `address` restriction",
    needs: ["users", "groups"],
    run: ({ users, groups }) => {
      const w = writeGroups(groups);
      const open = users.filter((u) => enabled(u) && w.has(u["group"] ?? "") && !u["address"] && u["name"] !== "admin");
      return open.length ? `write-capable users without address restriction: ${list(open.map((u) => u["name"] ?? "?"))}` : null;
    },
  },
  {
    id: "plaintext-service",
    severity: "high",
    summary: "telnet/ftp (high) or api/www (medium) management service enabled: passwords travel in clear text",
    needs: ["services"],
    run: ({ services }) => {
      const hits = services.filter((s) => enabled(s) && PLAINTEXT.has(s["name"] as never)).map((s) => s["name"] ?? "");
      if (!hits.length) return null;
      const severity: Severity = hits.some((h) => PLAINTEXT.get(h as never) === "high") ? "high" : "medium";
      const fix = [hits.includes("www") ? "www-ssl" : "", hits.includes("api") ? "api-ssl" : ""].filter(Boolean);
      return { severity, message: `plaintext management enabled: ${hits.join(", ")}${fix.length ? ` (use ${fix.join(", ")})` : ""}` };
    },
  },
  {
    id: "service-open",
    severity: "medium",
    summary: "an enabled management service has an empty available-from (open to any source)",
    needs: ["services"],
    run: ({ services, reverseProxyRules }) => {
      const { open } = classifyOpen(services, reverseProxyRules);
      return open.length ? `open to any source: ${open.join(", ")} (set available-from)` : null;
    },
  },
  {
    id: "mac-server",
    severity: "medium",
    summary: "mac-telnet or mac-winbox allowed on all interfaces",
    needs: ["macServer", "macWinbox"],
    run: ({ macServer, macWinbox }) => {
      const hits = [
        macServer["allowed-interface-list"] === "all" ? "mac-telnet" : "",
        macWinbox["allowed-interface-list"] === "all" ? "mac-winbox" : "",
      ].filter(Boolean);
      return hits.length ? `${hits.join(" and ")} allowed on all interfaces (limit to a LAN interface list)` : null;
    },
  },
  {
    id: "pptp-server",
    severity: "high",
    summary: "PPTP server enabled (MS-CHAPv2 is broken), or L2TP server enabled without IPsec",
    needs: ["pptp", "l2tp"],
    run: ({ pptp, l2tp }) => {
      const hits = [on(pptp, "enabled") ? "PPTP server enabled (broken crypto: use WireGuard or IKEv2)" : ""];
      if (on(l2tp, "enabled") && (l2tp["use-ipsec"] ?? "no") === "no") hits.push("L2TP server enabled without IPsec");
      const out = hits.filter(Boolean);
      return out.length ? out.join("; ") : null;
    },
  },
  {
    id: "ssh-weak",
    severity: "medium",
    summary: "SSH strong-crypto off, or an RSA host key shorter than 2048 bits",
    needs: ["ssh"],
    run: ({ ssh }) => {
      const hits: string[] = [];
      if (ssh["strong-crypto"] !== undefined && !on(ssh, "strong-crypto")) hits.push("strong-crypto=no");
      const size = toNumber(ssh["host-key-size"]);
      if (ssh["host-key-type"] === "rsa" && size !== undefined && size < 2048) hits.push(`RSA host key ${size} bits`);
      return hits.length ? `SSH: ${hits.join(", ")}` : null;
    },
  },
  {
    id: "dns-open",
    severity: "medium",
    summary:
      "DNS answers remote requests and the IPv4 input chain, simulated in order for every WAN interface (one carrying a default route; list membership read from the router), lets a new UDP/53 query from the Internet through (sources inside 192.168/16 are treated as local; low: cannot tell)",
    needs: ["dns", "filter", "wan", "interfaceLists", "listMembers"],
    run: ({ dns, filter, wan, interfaceLists, listMembers }) => {
      if (!on(dns, "allow-remote-requests")) return null;
      const v = dnsFromWan(filter, wan, listResolver(interfaceLists, listMembers));
      if (v.state === "closed") return null;
      if (v.state === "open") {
        return `DNS allow-remote-requests=yes and the input chain accepts a new UDP/53 query arriving on ${v.wan} (${v.rule ? `rule ${v.rule}` : "no rule drops it before the end of the chain"}): open resolver`;
      }
      return {
        severity: "low",
        message: `DNS allow-remote-requests=yes; could not confirm that UDP/53 from WAN is dropped (${v.wan ? `on ${v.wan}: ` : ""}${v.rule ? `rule ${v.rule} depends on ` : ""}${v.why})`,
      };
    },
  },
  {
    id: "upnp",
    severity: "medium",
    summary: "UPnP enabled (LAN devices can open ports on the router)",
    needs: ["upnp"],
    run: ({ upnp }) => (on(upnp, "enabled") ? "UPnP enabled: any LAN device can open inbound ports" : null),
  },
  {
    id: "proxy-socks",
    severity: "medium",
    summary: "web proxy or SOCKS enabled",
    needs: ["socks", "proxy"],
    run: ({ socks, proxy }) => {
      const hits = [on(socks, "enabled") ? `SOCKS (auth ${socks["auth-method"] ?? "?"})` : "", on(proxy, "enabled") ? "web proxy" : ""].filter(Boolean);
      return hits.length ? `${hits.join(" and ")} enabled: check they are not reachable from WAN` : null;
    },
  },
  {
    id: "snmp-public",
    severity: "medium",
    summary: "SNMP enabled with community `public` open to every address",
    needs: ["snmp", "snmpCommunities"],
    run: ({ snmp, snmpCommunities }) => {
      if (!on(snmp, "enabled")) return null;
      const bad = snmpCommunities.filter(
        (c) => enabled(c) && c["name"] === "public" && ["", "::/0", "0.0.0.0/0"].includes(c["addresses"] ?? ""),
      );
      return bad.length ? "SNMP community public answers every address (restrict addresses or rename it)" : null;
    },
  },
  {
    id: "neighbor-all",
    severity: "low",
    summary: "neighbor discovery runs on all interfaces (announces the router to WAN)",
    needs: ["neighbor"],
    run: ({ neighbor }) => (neighbor["discover-interface-list"] === "all" ? "neighbor discovery on interface list all (use a LAN list)" : null),
  },
  {
    id: "romon",
    severity: "low",
    summary: "RoMON enabled",
    needs: ["romon"],
    run: ({ romon }) => (on(romon, "enabled") ? "RoMON enabled: make sure its secrets are set" : null),
  },
  {
    id: "routerboot",
    severity: "low",
    summary: "RouterBOOT firmware older than the installed RouterOS (upgrade pending)",
    needs: ["routerboard"],
    run: ({ routerboard }) => {
      const cur = routerboard["current-firmware"];
      const up = routerboard["upgrade-firmware"];
      return cur && up && cur !== up ? `RouterBOOT ${cur}, RouterOS ships ${up}: run /system routerboard upgrade, then reboot` : null;
    },
  },
];

export const AUDIT_IDS = AUDIT_RULES.map((r) => r.id);

export interface AuditFinding {
  id: string;
  severity: Severity;
  message: string;
}

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export function runAudit(
  data: Partial<AuditData>,
  disabled: readonly string[] = [],
): { findings: AuditFinding[]; passed: string[]; skipped: string[] } {
  const findings: AuditFinding[] = [];
  const passed: string[] = [];
  const skipped: string[] = [];
  for (const rule of AUDIT_RULES) {
    if (disabled.includes(rule.id)) continue;
    if (rule.needs.some((k) => data[k] === undefined)) {
      skipped.push(rule.id);
      continue;
    }
    const res = rule.run(data as AuditData);
    if (res === null) {
      passed.push(rule.id);
      continue;
    }
    findings.push(typeof res === "string" ? { id: rule.id, severity: rule.severity, message: res } : { id: rule.id, ...res });
  }
  findings.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  return { findings, passed, skipped };
}
