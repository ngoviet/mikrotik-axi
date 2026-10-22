import { parseCommandArgs } from "../args.js";
import { connect, type Runtime } from "../context.js";
import { fail } from "../errors.js";
import type { RosClient } from "../ros/client.js";
import { toBool, toNumber } from "../ros/normalize.js";
import { naturalCompare } from "../views/format.js";
import { assertFields, renderList } from "../views/list.js";

export interface WanLine {
  /** Cổng vật lý suy ra (ether1…) */
  port: string;
  /** Nhãn từ profile.line_map, mặc định = port */
  label: string;
  running: number;
  total: number;
}

export interface WanSession {
  name: string;
  /** Interface cha trực tiếp (vrrpN…) */
  parent: string;
  port: string;
  line: string;
  running: boolean;
  disabled: boolean;
}

export interface WanSummary {
  /** Phiên đang bật (không tính disabled) */
  total: number;
  running: number;
  disabled: number;
  down: string[];
  lines: WanLine[];
  sessions: WanSession[];
}

const MAX_HOPS = 6;

/**
 * Cổng vật lý của mỗi phiên PPPoE do TOOL tự suy: pppoe-outN.interface → vrrpN (→ vlan…) →
 * etherX. Profile chỉ đặt nhãn (line_map). Lý do: quan hệ phiên↔line đã từng đổi (out32 chuyển
 * Line 5 → Line 4); chép tay vào profile sẽ lặng lẽ sai.
 */
export async function readWan(client: RosClient, lineMap: Record<string, string> = {}): Promise<WanSummary> {
  const [pppoe, vrrp, vlan] = await Promise.all([
    client.list("/interface/pppoe-client", { proplist: ["name", "interface", "running", "disabled"] }),
    client.list("/interface/vrrp", { proplist: ["name", "interface"] }),
    client.list("/interface/vlan", { proplist: ["name", "interface"] }),
  ]);
  const parent = new Map<string, string>();
  for (const r of [...vrrp, ...vlan]) {
    if (r["name"] && r["interface"]) parent.set(r["name"], r["interface"]);
  }
  const physical = (iface: string): string => {
    let cur = iface;
    for (let i = 0; i < MAX_HOPS && parent.has(cur); i++) cur = parent.get(cur) as string;
    return cur;
  };

  const sessions: WanSession[] = pppoe
    .map((p) => {
      const port = physical(p["interface"] ?? "?");
      return {
        name: p["name"] ?? "?",
        parent: p["interface"] ?? "?",
        port,
        line: lineMap[port] ?? port,
        running: toBool(p["running"], "running"),
        disabled: toBool(p["disabled"], "disabled"),
      };
    })
    .sort((a, b) => naturalCompare(a.name, b.name));

  const byPort = new Map<string, WanLine>();
  for (const s of sessions.filter((x) => !x.disabled)) {
    const line = byPort.get(s.port) ?? { port: s.port, label: s.line, running: 0, total: 0 };
    line.total++;
    if (s.running) line.running++;
    byPort.set(s.port, line);
  }
  const enabled = sessions.filter((s) => !s.disabled);
  return {
    total: enabled.length,
    running: enabled.filter((s) => s.running).length,
    disabled: sessions.length - enabled.length,
    down: enabled.filter((s) => !s.running).map((s) => s.name),
    lines: [...byPort.values()].sort((a, b) => naturalCompare(a.port, b.port)),
    sessions,
  };
}

/** Một dòng cho home view: "40/40 pppoe running · lines 8/8/8/8/8". */
export function wanLine(w: WanSummary): string {
  if (w.total === 0 && w.disabled === 0) return "no pppoe clients";
  let s = `${w.running}/${w.total} pppoe running`;
  if (w.disabled) s += ` (${w.disabled} disabled)`;
  if (w.lines.length > 1) {
    s += ` · lines ${w.lines.map((l) => l.running).join("/")}`;
    const short = w.lines.filter((l) => l.running < l.total);
    if (short.length) s += ` (short: ${short.map((l) => `${l.label} ${l.running}/${l.total}`).join(", ")})`;
  }
  return s;
}

export const WAN_HELP = `usage: mikrotik-axi wan [flags]
       mikrotik-axi wan ips [flags]
description: PPPoE sessions with the physical line each one rides on (derived from pppoe → vrrp/vlan → port; labels from profile line_map). \`wan ips\` lists public IPs and flags sessions sharing one
flags[3]:
  --fields a,b: wan columns name,line,running,up_since (also port,parent,link_downs,disabled); wan ips columns name,line,public_ip
  --full: all rows
  --device <name>: device from the profile
`;

export async function wanCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { positionals, global } = parseCommandArgs("wan", args, {}, 1);
  const sub = positionals[0];
  if (sub !== undefined && sub !== "ips") {
    fail(`wan: unknown sub-command ${sub}`, "VALIDATION_ERROR", ["Run `mikrotik-axi wan` or `mikrotik-axi wan ips`"]);
  }
  const available = sub === "ips" ? ["name", "line", "public_ip"] : ["name", "line", "running", "up_since", "port", "parent", "link_downs", "disabled"];
  assertFields(global.fields, available);
  const ctx = await connect(global, rt);
  return sub === "ips" ? wanIps(ctx.client, ctx.device.line_map, global) : wanSessions(ctx.client, ctx.device.line_map, global);
}

async function wanSessions(client: RosClient, lineMap: Record<string, string> | undefined, global: Parameters<typeof renderList>[1]) {
  // Counter/uptime nằm ở /interface, KHÔNG ở /interface/pppoe-client.
  const [wan, ifaces] = await Promise.all([
    readWan(client, lineMap),
    client.list("/interface", { query: { type: "pppoe-out" }, proplist: ["name", "type", "last-link-up-time", "link-downs"] }),
  ]);
  const iface = new Map(ifaces.map((i) => [i["name"] ?? "", i]));
  const rows = wan.sessions.map((s) => ({
    name: s.name,
    line: s.line,
    running: s.running,
    up_since: s.running ? (iface.get(s.name)?.["last-link-up-time"] ?? "") : "",
    port: s.port,
    parent: s.parent,
    link_downs: toNumber(iface.get(s.name)?.["link-downs"]) ?? 0,
    disabled: s.disabled,
  }));
  const { out, help } = renderList(
    { key: "sessions", rows, fields: ["name", "line", "running", "up_since"], available: Object.keys(rows[0] ?? { name: 1 }), command: "mikrotik-axi wan" },
    global,
  );
  return {
    running: `${wan.running}/${wan.total}`,
    lines: wan.lines.length ? wan.lines.map((l) => ({ line: l.label, port: l.port, running: l.running, total: l.total })) : "0 lines found",
    down: wan.down.length ? wan.down.join(", ") : "none",
    ...(wan.disabled ? { disabled: wan.sessions.filter((s) => s.disabled).map((s) => s.name).join(", ") } : {}),
    ...out,
    help: [...help, "Run `mikrotik-axi wan ips` for public IPs per session"],
  };
}

async function wanIps(client: RosClient, lineMap: Record<string, string> | undefined, global: Parameters<typeof renderList>[1]) {
  const [wan, addrs] = await Promise.all([readWan(client, lineMap), client.list("/ip/address", { proplist: ["address", "interface", "disabled"] })]);
  const ipOf = new Map<string, string>();
  for (const a of addrs) {
    if (toBool(a["disabled"], "disabled") || !a["interface"] || !a["address"]) continue;
    ipOf.set(a["interface"], a["address"].replace(/\/32$/, ""));
  }
  const rows = wan.sessions.filter((s) => !s.disabled).map((s) => ({ name: s.name, line: s.line, public_ip: ipOf.get(s.name) ?? "" }));
  const byIp = new Map<string, string[]>();
  for (const r of rows) if (r.public_ip) byIp.set(r.public_ip, [...(byIp.get(r.public_ip) ?? []), r.name]);
  const shared = [...byIp.entries()].filter(([, names]) => names.length > 1);
  const noIp = rows.filter((r) => !r.public_ip).map((r) => r.name);
  const { out, help } = renderList(
    { key: "ips", rows, fields: ["name", "line", "public_ip"], available: ["name", "line", "public_ip"], command: "mikrotik-axi wan ips" },
    global,
  );
  return {
    with_ip: `${rows.length - noIp.length}/${rows.length}`,
    // Nhiều phiên cùng một IP = dấu hiệu lạ (BRAS gộp phiên, hoặc đọc nhầm bảng).
    shared_ips: shared.length ? shared.map(([ip, names]) => `${ip} (${names.join(", ")})`).join("; ") : "none",
    ...(noIp.length ? { without_ip: noIp.join(", ") } : {}),
    ...out,
    ...(help.length ? { help } : {}),
  };
}
