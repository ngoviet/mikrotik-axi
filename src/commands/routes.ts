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
}

/**
 * Default route, TÁCH THEO routing-table. Không bao giờ gộp bảng: con số "41 route
 * distance=1" từng gây hiểu sai vì trộn `main` với các bảng theo phiên.
 */
export async function readDefaultRoutes(client: RosClient): Promise<Map<string, DefaultRoute[]>> {
  const rows = await client.list("/ip/route", {
    query: { "dst-address": "0.0.0.0/0" },
    proplist: ["dst-address", "routing-table", "gateway", "distance", "active", "dynamic", "disabled", "check-gateway"],
  });
  const byTable = new Map<string, DefaultRoute[]>();
  for (const r of rows) {
    // Lọc lại phía client: không phụ thuộc việc router có áp query hay không.
    if (r["dst-address"] !== "0.0.0.0/0" || toBool(r["disabled"], "disabled")) continue;
    const table = r["routing-table"] || "main";
    const list = byTable.get(table) ?? [];
    list.push({
      table,
      gateway: r["gateway"] ?? "?",
      distance: r["distance"] ?? "?",
      active: toBool(r["active"], "active"),
      dynamic: toBool(r["dynamic"], "dynamic"),
      checkGateway: Boolean(r["check-gateway"]),
    });
    byTable.set(table, list);
  }
  return byTable;
}

/** "pppoe-out1 (1 active of 40)" — chỉ bảng main. */
export function mainDefaultLine(byTable: Map<string, DefaultRoute[]>): string {
  const main = byTable.get("main") ?? [];
  if (main.length === 0) return "none (no default route in table main)";
  const active = main.filter((r) => r.active);
  const gws = active.length ? active.map((r) => r.gateway).join(", ") : "none active";
  return `${gws} (${active.length} active of ${main.length})`;
}

export const ROUTES_HELP = `usage: mikrotik-axi routes defaults [--table <name>] [flags]
       mikrotik-axi routes rules [flags]
description: \`routes defaults\` summarises default routes PER routing-table (never merged) and warns on tables with 0 or >1 active; \`--table\` lists that table's routes. \`routes rules\` lists /routing/rule and marks rules whose source a mangle mark-routing already decides (mangle wins over /routing/rule)
flags[4]:
  --table <name>: routes of one table (e.g. main)
  --fields a,b: columns
  --full: all rows
  --device <name>: device from the profile
`;

const RULE_FIELDS = ["idx", "src_address", "dst_address", "routing_mark", "interface", "action", "table", "disabled", "comment", "decided_by_mangle"];
const ROUTE_FIELDS = ["gateway", "distance", "active", "dynamic", "check_gateway"];
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
    .map((r) => ({ gateway: r.gateway, distance: Number(r.distance), active: r.active, dynamic: r.dynamic, check_gateway: r.checkGateway }))
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
  const active = rows.filter((r) => r.active);
  return {
    table,
    active: active.length ? active.map((r) => r.gateway).join(", ") : "none",
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
      return { table: t, routes: rs.length, active: active.length, gateway: active.map((r) => r.gateway).join(" ") || "-" };
    });
  const bad = rows.filter((r) => r.active !== 1).map((r) => `${r.table} (${r.active} active)`);
  const { out, help } = renderList(
    { key: "tables", rows, fields: TABLE_FIELDS, available: TABLE_FIELDS, command: "mikrotik-axi routes defaults" },
    global,
  );
  return {
    main: mainDefaultLine(byTable),
    warnings: bad.length ? bad.join(", ") : "none (every table has exactly 1 active default)",
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
