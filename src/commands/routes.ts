import { parseCommandArgs } from "../args.js";
import { connect, type Runtime } from "../context.js";
import { fail } from "../errors.js";
import type { RosClient } from "../ros/client.js";
import { toBool } from "../ros/normalize.js";
import { naturalCompare } from "../views/format.js";
import { assertFields, countBy, renderList } from "../views/list.js";
import { MANGLE_PROPLIST, readRules } from "./fw.js";

export interface DefaultRoute {
  table: string;
  gateway: string;
  distance: string;
  active: boolean;
  dynamic: boolean;
  checkGateway: boolean;
  /**
   * Cổng ra thật (interface) suy từ `immediate-gw`. Default **đệ quy** (gateway là IP xa như
   * `9.9.9.9`, resolve qua host route `9.9.9.9/32 → pppoe-out1`) có `gateway=9.9.9.9` nhưng
   * `immediate-gw=9.9.9.9%pppoe-out1`. Hai default đệ quy cùng ra `pppoe-out1` là MỘT đường,
   * không phải ECMP hai đường (đo CCR2004 7.25.1, 2026-11-20). Thiếu `immediate-gw` (route
   * không active) ⇒ bằng `gateway`.
   */
  via: string;
  /**
   * MỌI cổng ra: CLI reference ghi `immediate-gw` kiểu `multi { gw: address }` (ECMP có nhiều next-hop).
   * `via` chỉ là cái đầu (giữ cho các lệnh cũ); audit dns-open phải xét hết (review vòng 4).
   */
  vias: string[];
  /** Route `blackhole` (CLI reference `/ip/route`: `blackhole switch`): không có cổng ra. */
  blackhole: boolean;
}

/** `9.9.9.9%pppoe-out1,203.0.113.1%ether2` → `[pppoe-out1, ether2]`; rỗng → `[gateway]`. */
export function egressesOf(immediateGw: string | undefined, gateway: string): string[] {
  const hops = (immediateGw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!hops.length) return [gateway];
  return hops.map((v) => {
    const pct = v.lastIndexOf("%");
    return pct >= 0 ? v.slice(pct + 1) : v;
  });
}

/** `9.9.9.9%pppoe-out1` → `pppoe-out1`; `pppoe-out2` → `pppoe-out2`; rỗng → gateway. Chỉ next-hop đầu. */
export function egressOf(immediateGw: string | undefined, gateway: string): string {
  return egressesOf(immediateGw, gateway)[0]!;
}

/** Số cổng ra khác nhau của các route active (đếm đường thật, không đếm route). */
export function activeEgress(routes: DefaultRoute[]): string[] {
  return [...new Set(routes.filter((r) => r.active).map((r) => r.via))];
}

/** `9.9.9.9 → pppoe-out1` khi gateway là IP đệ quy; nguyên gateway khi trùng cổng ra. */
function gatewayLabel(r: DefaultRoute, arrow = " → "): string {
  return r.via && r.via !== r.gateway ? `${r.gateway}${arrow}${r.via}` : r.gateway;
}

/**
 * Default route, TÁCH THEO routing-table. Không bao giờ gộp bảng: con số "41 route
 * distance=1" từng gây hiểu sai vì trộn `main` với các bảng theo phiên.
 */
export async function readDefaultRoutes(client: RosClient): Promise<Map<string, DefaultRoute[]>> {
  const rows = await client.list("/ip/route", {
    query: { "dst-address": "0.0.0.0/0" },
    proplist: ["dst-address", "routing-table", "gateway", "distance", "active", "dynamic", "disabled", "check-gateway", "immediate-gw", "blackhole"],
  });
  const byTable = new Map<string, DefaultRoute[]>();
  for (const r of rows) {
    // Lọc lại phía client: không phụ thuộc việc router có áp query hay không.
    if (r["dst-address"] !== "0.0.0.0/0" || toBool(r["disabled"], "disabled")) continue;
    const table = r["routing-table"] || "main";
    const list = byTable.get(table) ?? [];
    const gateway = r["gateway"] ?? "?";
    list.push({
      table,
      gateway,
      distance: r["distance"] ?? "?",
      active: toBool(r["active"], "active"),
      dynamic: toBool(r["dynamic"], "dynamic"),
      checkGateway: Boolean(r["check-gateway"]),
      via: egressOf(r["immediate-gw"], gateway),
      vias: egressesOf(r["immediate-gw"], gateway),
      blackhole: toBool(r["blackhole"], "blackhole"),
    });
    byTable.set(table, list);
  }
  return byTable;
}

/**
 * "pppoe-out1 (1 active of 40)" — chỉ bảng main. Default đệ quy cùng một cổng ra:
 * "pppoe-out1 via 9.9.9.9, 208.67.222.222 (2 active of 42)".
 */
export function mainDefaultLine(byTable: Map<string, DefaultRoute[]>): string {
  const main = byTable.get("main") ?? [];
  if (main.length === 0) return "none (no default route in table main)";
  const active = main.filter((r) => r.active);
  const tail = `(${active.length} active of ${main.length})`;
  if (active.length === 0) return `none active ${tail}`;
  const egress = activeEgress(main);
  // Chỉ gộp khi NHIỀU default cùng một cổng ra; một default đơn (switch: 192.168.100.1) giữ nguyên.
  if (active.length > 1 && egress.length === 1 && active.some((r) => r.gateway !== r.via)) {
    return `${egress[0]} via ${active.map((r) => r.gateway).join(", ")} ${tail}`;
  }
  return `${active.map((r) => (egress.length > 1 ? gatewayLabel(r) : r.gateway)).join(", ")} ${tail}`;
}

export const ROUTES_HELP = `usage: mikrotik-axi routes defaults [--table <name>] [flags]
       mikrotik-axi routes rules [flags]
description: \`routes defaults\` summarises default routes PER routing-table (never merged) and warns on tables whose active defaults egress via 0 or >1 interfaces (a recursive default such as 9.9.9.9 resolved over pppoe-out1 counts as pppoe-out1); \`--table\` lists that table's routes (\`--fields gateway,via,active\` shows the egress). \`routes rules\` lists /routing/rule and marks rules whose source a mangle mark-routing already decides (mangle wins over /routing/rule)
flags[4]:
  --table <name>: routes of one table (e.g. main)
  --fields a,b: columns
  --full: all rows
  --device <name>: device from the profile
`;

const RULE_FIELDS = ["idx", "src_address", "dst_address", "routing_mark", "interface", "action", "table", "disabled", "comment", "decided_by_mangle"];
const ROUTE_FIELDS = ["gateway", "distance", "active", "dynamic", "check_gateway", "via"];
const TABLE_FIELDS = ["table", "routes", "active", "gateway"];

export async function routesCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { positionals, global, flags } = parseCommandArgs("routes", args, { table: { type: "string", hint: "--table <name>" } }, 1);
  const sub = positionals[0];
  if (sub !== "defaults" && sub !== "rules") {
    fail(`routes: expected defaults or rules${sub ? `, got ${sub}` : ""}`, "VALIDATION_ERROR", ["Run `mikrotik-axi routes --help` for usage"]);
  }
  const table = typeof flags["table"] === "string" ? flags["table"] : undefined;
  if (sub === "rules") {
    assertFields(global.fields, RULE_FIELDS);
    const ctx = await connect(global, rt);
    return routingRules(ctx.client, global);
  }
  assertFields(global.fields, table ? ROUTE_FIELDS : TABLE_FIELDS);
  const ctx = await connect(global, rt);
  const byTable = await readDefaultRoutes(ctx.client);
  return table ? oneTable(byTable, table, global) : allTables(byTable, global);
}

type Flags = Parameters<typeof renderList>[1];

function oneTable(byTable: Map<string, DefaultRoute[]>, table: string, global: Flags): Record<string, unknown> {
  const routes = byTable.get(table);
  if (!routes) {
    const known = [...byTable.keys()].sort(naturalCompare);
    fail(`no default route in table ${table}`, "VALIDATION_ERROR", [
      `Tables with a default route: ${known.slice(0, 10).join(", ")}${known.length > 10 ? ", …" : ""}`,
    ]);
  }
  const rows = routes
    .map((r) => ({ gateway: r.gateway, distance: Number(r.distance), active: r.active, dynamic: r.dynamic, check_gateway: r.checkGateway, via: r.via }))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.distance - b.distance || naturalCompare(a.gateway, b.gateway));
  const { out, help } = renderList(
    {
      key: "routes",
      rows,
      fields: ["gateway", "distance", "active", "dynamic"],
      available: ROUTE_FIELDS,
      command: `mikrotik-axi routes defaults --table ${table}`,
    },
    global,
  );
  const active = routes.filter((r) => r.active);
  return {
    table,
    active: active.length ? active.map((r) => gatewayLabel(r)).join(", ") : "none",
    ...out,
    ...(rows.some((r) => r.dynamic)
      ? { note: "dynamic routes come from pppoe-client: change default-route-distance there, not on the route" }
      : {}),
    ...(help.length ? { help } : {}),
  };
}

function allTables(byTable: Map<string, DefaultRoute[]>, global: Flags): Record<string, unknown> {
  const rows = [...byTable.entries()]
    .sort(([a], [b]) => (a === "main" ? -1 : b === "main" ? 1 : naturalCompare(a, b)))
    .map(([t, rs]) => {
      const active = rs.filter((r) => r.active);
      const egress = activeEgress(rs).length;
      return { table: t, routes: rs.length, active: active.length, gateway: active.map((r) => gatewayLabel(r, "→")).join(" ") || "-", egress };
    });
  // Cảnh báo theo số CỔNG RA, không theo số route: 2 default đệ quy cùng ra pppoe-out1 là bình thường.
  const bad = rows
    .filter((r) => r.egress !== 1)
    .map((r) => (r.active > 1 ? `${r.table} (${r.active} active via ${r.egress} interfaces)` : `${r.table} (${r.active} active)`));
  const { out, help } = renderList(
    { key: "tables", rows, fields: TABLE_FIELDS, available: TABLE_FIELDS, command: "mikrotik-axi routes defaults" },
    global,
  );
  return {
    main: mainDefaultLine(byTable),
    warnings: bad.length ? bad.join(", ") : "none (every table has exactly 1 active egress)",
    ...out,
    help: [...help, "Run `mikrotik-axi routes defaults --table main` for the routes of one table"],
  };
}

async function routingRules(client: RosClient, global: Flags): Promise<Record<string, unknown>> {
  const [rules, mangle] = await Promise.all([
    client.list("/routing/rule", {
      proplist: ["src-address", "dst-address", "routing-mark", "interface", "action", "table", "disabled", "comment"],
    }),
    readRules(client, "mangle", MANGLE_PROPLIST),
  ]);
  // Mangle thắng /routing/rule: gói đã có routing-mark thì rule không còn được xét cho nó.
  // Heuristic: mangle prerouting mark-routing bật, CÙNG src-address ⇒ rule "đã bị mangle quyết".
  const marks = new Map<string, string>();
  mangle.forEach((m, idx) => {
    const src = m["src-address"];
    if (m["action"] !== "mark-routing" || m["chain"] !== "prerouting" || toBool(m["disabled"], "disabled") || !src) return;
    if (!marks.has(src)) marks.set(src, `mangle #${idx}${m["comment"] ? ` ${m["comment"]}` : ""}`);
  });
  const rows = rules.map((r, idx) => ({
    idx,
    src_address: r["src-address"] ?? "",
    dst_address: r["dst-address"] ?? "",
    routing_mark: r["routing-mark"] ?? "",
    interface: r["interface"] ?? "",
    action: r["action"] ?? "",
    table: r["table"] ?? "",
    disabled: toBool(r["disabled"], "disabled"),
    comment: r["comment"] ?? "",
    decided_by_mangle: (r["src-address"] && marks.get(r["src-address"])) || "",
  }));
  const decided = rows.filter((r) => r.decided_by_mangle && !r.disabled);
  const { out, help } = renderList(
    {
      key: "rules",
      rows,
      fields: ["idx", "src_address", "table", "decided_by_mangle"],
      available: RULE_FIELDS,
      command: "mikrotik-axi routes rules",
      textFields: ["comment"],
    },
    global,
  );
  return {
    by_action: countBy(rows, (r) => r.action) || "none",
    decided_by_mangle: `${decided.length} enabled rule(s) match a source that mangle already marks (mangle wins; the rule is not consulted for those packets)`,
    ...out,
    ...(help.length ? { help } : {}),
  };
}
