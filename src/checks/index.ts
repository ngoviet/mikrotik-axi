import type { DefaultRoute } from "../commands/routes.js";
import type { Health } from "../commands/health.js";
import type { WanSummary } from "../commands/wan.js";
import type { DeviceProfile } from "../config/profile.js";
import { formatDuration, toBool, type RosRecord } from "../ros/normalize.js";
import { classifyOpen } from "./services.js";
import { naturalCompare } from "../views/format.js";
import { duplicateMarks, mssAfterAccept, mssRaise, zeroHitGroups } from "./firewall.js";

/** Dữ liệu đã tải cho home view. Luật KHÔNG được gọi REST thêm (§7). */
export interface CheckData {
  resource: Health;
  update: RosRecord;
  wan: WanSummary;
  routes: Map<string, DefaultRoute[]>;
  mangle: RosRecord[];
  filter: RosRecord[];
  nat: RosRecord[];
  raw: RosRecord[];
  services: RosRecord[];
  /** Số rule reverse-proxy đang bật; undefined khi không đọc được (luật coi như có thể đang nghe). */
  reverseProxyRules: number | undefined;
  macServer: RosRecord;
  macWinbox: RosRecord;
  netwatch: RosRecord[];
  bridgePorts: RosRecord[];
  ethernet: RosRecord[];
}

export type DataKey = keyof CheckData;

export interface Rule {
  id: string;
  /** Một câu cho SKILL.md / tài liệu. */
  summary: string;
  needs: readonly DataKey[];
  /** Trả thông điệp (không kèm id) hoặc null khi ổn. */
  run: (d: CheckData, device: DeviceProfile) => string | null;
}

const enabled = (r: RosRecord) => !toBool(r["disabled"], "disabled");
const list = (xs: string[], max = 4) => (xs.length > max ? `${xs.slice(0, max).join(", ")}, …` : xs.join(", "));

/** Đủ lâu để "0 packet" có ý nghĩa — counter reset khi khởi động lại. */
export const ZERO_HIT_MIN_UPTIME_S = 86400;

export const RULES: readonly Rule[] = [
  {
    id: "pppoe-down",
    summary: "fewer PPPoE sessions running than expected (profile expect.pppoe_running, else all enabled)",
    needs: ["wan"],
    run: ({ wan }, device) => {
      const expected = device.expect?.pppoe_running ?? wan.total;
      if (wan.running >= expected) return null;
      return `${wan.running}/${expected} pppoe running${wan.down.length ? ` (down: ${list(wan.down)})` : ""}`;
    },
  },
  {
    id: "main-default",
    summary: "table main does not have exactly one active default, or its gateway differs from expect.main_default_gateway",
    needs: ["routes"],
    run: ({ routes }, device) => {
      const main = routes.get("main") ?? [];
      // Thiết bị không có default nào (switch L2 thuần) và profile không kỳ vọng gì ⇒ bỏ qua.
      if (main.length === 0 && !device.expect?.main_default_gateway) return null;
      const active = main.filter((r) => r.active);
      if (active.length !== 1) return `table main has ${active.length} active default routes (expected 1)`;
      const want = device.expect?.main_default_gateway;
      const got = active[0]!.gateway;
      return want && got !== want ? `main default via ${got}, expected ${want}` : null;
    },
  },
  {
    id: "no-netwatch",
    summary: "on PPPoE routers: nothing would notice the main default losing the Internet behind a live session",
    needs: ["routes", "netwatch", "wan"],
    run: ({ routes, netwatch, wan }) => {
      const main = routes.get("main") ?? [];
      // Chỉ có nghĩa với router ra Internet qua PPPoE; switch có default tĩnh về router ⇒ bỏ qua.
      if (main.length === 0 || wan.total === 0) return null;
      if (netwatch.some(enabled) || main.some((r) => r.checkGateway)) return null;
      return "no netwatch or check-gateway for main default (ISP route loss undetected)";
    },
  },
  {
    id: "mss-order",
    summary: "a change-mss rule sits after the first accept of its mangle chain and never runs",
    needs: ["mangle"],
    run: ({ mangle }) => {
      const bad = mssAfterAccept(mangle);
      if (!bad.length) return null;
      const where = bad.map((b) => `#${b.idx}${b.comment ? ` ${b.comment}` : ""}`);
      return `${bad.length} change-mss rule(s) after the first accept in their chain never run: ${list(where, 3)}`;
    },
  },
  {
    id: "mss-raise",
    summary: "numeric new-mss without a tcp-mss filter raises smaller MSS values",
    needs: ["mangle"],
    run: ({ mangle }) => {
      const bad = mssRaise(mangle);
      if (!bad.length) return null;
      return `${bad.length} change-mss rule(s) without tcp-mss filter will RAISE smaller MSS: ${list(bad.map((b) => `#${b.idx} new-mss=${b.newMss}`), 3)}`;
    },
  },
  {
    id: "service-open",
    summary: "an enabled /ip/service has an empty available-from (reverse-proxy with no rules is reported as idle, not open)",
    needs: ["services"],
    run: ({ services, reverseProxyRules }) => {
      // Bẫy #5: ACL thật ở available-from; `address` luôn rỗng nên không đọc.
      const { open, idle } = classifyOpen(services, reverseProxyRules);
      const idleNote = idle.length ? `${idle.join(", ")} enabled with no proxy rules (not listening yet); disable it or set available-from` : "";
      if (open.length) return `management service(s) open to any source: ${open.join(", ")}${idleNote ? `; ${idleNote}` : ""}`;
      return idleNote || null;
    },
  },
  {
    id: "mac-server",
    summary: "MAC telnet/winbox allowed on all interfaces",
    needs: ["macServer", "macWinbox"],
    run: ({ macServer, macWinbox }) => {
      const all = [
        macServer["allowed-interface-list"] === "all" ? "mac-telnet" : "",
        macWinbox["allowed-interface-list"] === "all" ? "mac-winbox" : "",
      ].filter(Boolean);
      return all.length ? `${all.join(" and ")} allowed on all interfaces` : null;
    },
  },
  {
    id: "loop-protect",
    summary: "enabled bridge ports with neither loop-protect nor bpdu-guard",
    needs: ["bridgePorts", "ethernet"],
    run: ({ bridgePorts, ethernet }) => {
      const lp = new Map(ethernet.map((e) => [e["name"] ?? "", e["loop-protect"] ?? ""]));
      const bare = bridgePorts.filter(
        (p) => enabled(p) && !toBool(p["dynamic"], "dynamic") && !toBool(p["bpdu-guard"], "bpdu-guard") && lp.get(p["interface"] ?? "") !== "on",
      );
      return bare.length ? `bridge ports without loop-protect or bpdu-guard: ${bare.length}` : null;
    },
  },
  {
    id: "zero-hit",
    summary: "rule groups (by comment stem) with 0 packets after at least a day of uptime",
    needs: ["resource", "mangle", "filter", "nat", "raw"],
    run: ({ resource, mangle, filter, nat, raw }) => {
      if ((resource.uptimeS ?? 0) < ZERO_HIT_MIN_UPTIME_S) return null;
      const groups = zeroHitGroups({ filter, nat, mangle, raw });
      if (!groups.length) return null;
      const total = groups.reduce((n, g) => n + g.count, 0);
      const top = groups.slice(0, 3).map((g) => `${g.group} ×${g.count} (${g.table})`);
      return `${total} enabled rule(s) with 0 packets after ${formatDuration(resource.uptimeS ?? 0)}: ${top.join(", ")}${groups.length > 3 ? ", …" : ""}`;
    },
  },
  {
    id: "dup-mark",
    summary: "duplicate mangle mark-routing (same chain, source and mark)",
    needs: ["mangle"],
    run: ({ mangle }) => {
      const dups = duplicateMarks(mangle);
      if (!dups.length) return null;
      return `duplicate mark-routing: ${list(dups.map((d) => `${d.label} ×${d.idx.length}`))}`;
    },
  },
  {
    id: "version",
    summary: "a newer RouterOS is reported by the router's own last update check",
    needs: ["update"],
    run: ({ update }) => {
      const installed = update["installed-version"];
      const latest = update["latest-version"];
      return latest && installed && latest !== installed ? `RouterOS ${latest} available (installed ${installed})` : null;
    },
  },
];

export const RULE_IDS = RULES.map((r) => r.id);

export interface Alert {
  id: string;
  message: string;
}

export interface CheckResult {
  alerts: Alert[];
  /** Luật không chạy được vì thiếu dữ liệu — in ra, không im lặng. */
  skipped: string[];
}

export function runChecks(
  data: Partial<CheckData>,
  device: DeviceProfile,
  disabled: readonly string[] = device.alerts?.disabled ?? [],
): CheckResult {
  const alerts: Alert[] = [];
  const skipped: string[] = [];
  for (const rule of RULES) {
    if (disabled.includes(rule.id)) continue;
    if (rule.needs.some((k) => data[k] === undefined)) {
      skipped.push(rule.id);
      continue;
    }
    const msg = rule.run(data as CheckData, device);
    if (msg) alerts.push({ id: rule.id, message: msg });
  }
  return { alerts, skipped: skipped.sort(naturalCompare) };
}
