import { parseCommandArgs } from "../args.js";
import { duplicateMarks, mssAfterAccept, mssRaise } from "../checks/firewall.js";
import { connect, type Runtime } from "../context.js";
import { fail } from "../errors.js";
import type { RosClient } from "../ros/client.js";
import { toBool, toNumber, type RosRecord } from "../ros/normalize.js";
import { assertFields, countBy, renderList, type Row } from "../views/list.js";
import { setOp } from "../write/ops.js";
import { CONFIRM_FLAG, connectForWrite, runWrite } from "../write/run.js";

export const FW_TABLES = ["filter", "nat", "mangle", "raw"] as const;
export type FwTable = (typeof FW_TABLES)[number];

export const RULE_PROPLIST = [".id", "chain", "action", "comment", "disabled", "dynamic", "packets"] as const;
export const MANGLE_PROPLIST = [
  ...RULE_PROPLIST,
  "new-mss",
  "tcp-mss",
  "src-address",
  "src-address-list",
  "new-routing-mark",
  "passthrough",
] as const;

// Cột xem thêm qua --fields (tên output dùng "_", router dùng "-").
const EXTRA_FIELDS = [
  "bytes",
  "protocol",
  "src_address",
  "dst_address",
  "src_address_list",
  "dst_address_list",
  "src_port",
  "dst_port",
  "in_interface",
  "out_interface",
  "in_interface_list",
  "out_interface_list",
  "connection_state",
  "connection_mark",
  "new_routing_mark",
  "new_mss",
  "tcp_mss",
  "to_addresses",
  "to_ports",
  "passthrough",
] as const;
const DEFAULT_FIELDS = ["idx", "chain", "action", "comment", "packets"] as const;
const AVAILABLE = [...DEFAULT_FIELDS, "disabled", "dynamic", "id", ...EXTRA_FIELDS];

export function readRules(client: RosClient, table: FwTable, proplist: readonly string[]): Promise<RosRecord[]> {
  return client.list(`/ip/firewall/${table}`, { proplist });
}

/** Một bản ghi REST → hàng bảng. `idx` = vị trí trong danh sách = số `#` của `print`. */
function toRow(r: RosRecord, idx: number): Row {
  const row: Row = {
    idx,
    id: r[".id"] ?? "",
    chain: r["chain"] ?? "",
    action: r["action"] ?? "",
    comment: r["comment"] ?? "",
    packets: toNumber(r["packets"]) ?? 0,
    disabled: toBool(r["disabled"], "disabled"),
    dynamic: toBool(r["dynamic"], "dynamic"),
  };
  for (const f of EXTRA_FIELDS) {
    const v = r[f.replaceAll("_", "-")];
    row[f] = f === "bytes" ? (toNumber(v) ?? 0) : (v ?? "");
  }
  return row;
}

export const FW_HELP = `usage: mikrotik-axi fw <filter|nat|mangle|raw> [flags]
       mikrotik-axi fw mangle check
       mikrotik-axi fw <filter|nat|mangle|raw> enable|disable <.id> [--confirm]
description: Firewall rules in processing order (idx = print number), with per-chain counts. \`fw mangle check\` audits MSS rule order, MSS raising and duplicate routing marks
flags[4]:
  --chain <name>: only rules of this chain (idx keeps the original position)
  --fields a,b: columns (default idx,chain,action,comment,packets; also disabled,dynamic,id,bytes,protocol,src_address,dst_address,dst_port,in_interface,out_interface,new_routing_mark,new_mss,tcp_mss,to_addresses,to_ports,…)
  --full: all rows and untruncated comments
  --device <name>: device from the profile
writes: enable/disable is a dry-run unless --confirm; refuses dynamic and protected rules; snapshots before writing and prints the revert command
examples[4]:
  mikrotik-axi fw nat
  mikrotik-axi fw filter disable *3B --confirm
  mikrotik-axi fw mangle --chain forward --fields idx,action,new_mss,tcp_mss,comment
  mikrotik-axi fw mangle check
`;

export async function fwCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { positionals, global, flags } = parseCommandArgs(
    "fw",
    args,
    { chain: { type: "string", hint: "--chain <name>" }, ...CONFIRM_FLAG },
    3,
  );
  const table = positionals[0] as FwTable | undefined;
  if (!table || !FW_TABLES.includes(table)) {
    fail(`fw: expected one of ${FW_TABLES.join(", ")}${table ? `, got ${table}` : ""}`, "VALIDATION_ERROR", [
      "Run `mikrotik-axi fw --help` for usage",
    ]);
  }
  const sub = positionals[1];
  if (sub === "enable" || sub === "disable") return toggleRule(table, sub, positionals[2], global, flags["confirm"] === true, rt);
  if (sub !== undefined) {
    if (table === "mangle" && sub === "check" && positionals.length === 2) return mangleCheck(global, rt);
    fail(`fw ${table}: unexpected argument ${sub}`, "VALIDATION_ERROR", [
      "Sub-commands: `fw <table> enable|disable <.id>`, `fw mangle check`",
    ]);
  }

  assertFields(global.fields, AVAILABLE);
  const wanted = new Set<string>([...RULE_PROPLIST, ...(global.fields ?? []).map((f) => f.replaceAll("_", "-"))]);
  wanted.delete("idx");
  wanted.delete("id");
  const ctx = await connect(global, rt);
  const rules = await readRules(ctx.client, table, [...wanted]);
  const chain = typeof flags["chain"] === "string" ? flags["chain"] : undefined;
  const rows = rules.map(toRow).filter((r) => !chain || r["chain"] === chain);

  const enabledRows = rows.filter((r) => !r["disabled"]);
  const { out, help } = renderList(
    {
      key: "rules",
      rows,
      // Nguyên tắc AXI #2 (≤ 4 cột): có --chain thì cột chain thừa.
      fields: chain ? DEFAULT_FIELDS.filter((f) => f !== "chain") : DEFAULT_FIELDS,
      available: AVAILABLE,
      command: `mikrotik-axi fw ${table}${chain ? ` --chain ${chain}` : ""}`,
      textFields: ["comment"],
    },
    global,
  );
  const disabled = rows.length - enabledRows.length;
  return {
    table,
    ...(chain ? { chain } : {}),
    summary: `${rows.length} rules (${enabledRows.length} enabled, ${disabled} disabled, ${rows.filter((r) => r["dynamic"]).length} dynamic)`,
    ...(chain ? {} : { by_chain: countBy(rows, (r) => String(r["chain"])) || "none" }),
    zero_packets: `${enabledRows.filter((r) => r["packets"] === 0).length} enabled rules`,
    ...out,
    help: [
      ...help,
      ...(table === "mangle" ? ["Run `mikrotik-axi fw mangle check` to audit rule order"] : []),
      ...(global.fields?.includes("id") ? [] : [`Add --fields idx,id,chain,action,comment to get the .id for \`fw ${table} enable|disable\``]),
    ],
  };
}

async function mangleCheck(global: Parameters<typeof connect>[0], rt: Runtime): Promise<Record<string, unknown>> {
  const ctx = await connect(global, rt);
  const mangle = await readRules(ctx.client, "mangle", MANGLE_PROPLIST);
  const order = mssAfterAccept(mangle);
  const raise = mssRaise(mangle);
  const dups = duplicateMarks(mangle);

  const firstAccept = new Map<string, number>();
  mangle.forEach((r, i) => {
    if (r["action"] === "accept" && !toBool(r["disabled"], "disabled") && !firstAccept.has(r["chain"] ?? "?")) {
      firstAccept.set(r["chain"] ?? "?", i);
    }
  });
  const mss = mangle
    .map((r, idx) => ({ r, idx }))
    .filter(({ r }) => r["action"] === "change-mss")
    .map(({ r, idx }) => ({
      idx,
      chain: r["chain"] ?? "",
      new_mss: r["new-mss"] ?? "",
      tcp_mss: r["tcp-mss"] ?? "",
      disabled: toBool(r["disabled"], "disabled"),
      packets: toNumber(r["packets"]) ?? 0,
      comment: r["comment"] ?? "",
    }));

  return {
    rules: mangle.length,
    mss_order: order.length
      ? `FAIL: ${order.length} change-mss rule(s) after the first accept in their chain never run (${order.map((o) => `#${o.idx} after #${o.firstAccept}`).join(", ")})`
      : "ok: every enabled change-mss is before the first accept of its chain",
    mss_raise: raise.length
      ? `FAIL: ${raise.map((r) => `#${r.idx} new-mss=${r.newMss}`).join(", ")} lack tcp-mss=<new-mss+1>-65535 and will raise smaller MSS`
      : "ok: every numeric new-mss has a tcp-mss filter",
    dup_mark: dups.length ? `WARN: ${dups.map((d) => `${d.label} at #${d.idx.join(", #")}`).join("; ")}` : "ok: no duplicate mark-routing",
    first_accept: [...firstAccept.entries()].map(([chain, idx]) => `${chain} #${idx}`).join(", ") || "none",
    change_mss: mss.length ? mss : "0 change-mss rules found",
    help: [
      "Mangle `accept` stops that chain: change-mss must sit before the first accept",
      "Run `mikrotik-axi fw mangle --chain forward` to see the surrounding rules",
    ],
  };
}

const ID_RE = /^\*[0-9A-F]+$/i;

async function toggleRule(
  table: FwTable,
  action: "enable" | "disable",
  id: string | undefined,
  global: Parameters<typeof connect>[0],
  confirm: boolean,
  rt: Runtime,
): Promise<Record<string, unknown>> {
  const listHint = `Run \`mikrotik-axi fw ${table} --fields idx,id,chain,action,comment\` to find the .id`;
  // .id ổn định; số idx đổi khi rule bị chèn/xoá ⇒ chỉ nhận .id cho thao tác ghi.
  if (!id || !ID_RE.test(id)) {
    fail(`fw ${table} ${action}: expected a rule .id like *3B${id ? `, got ${id}` : ""}`, "VALIDATION_ERROR", [listHint]);
  }
  const ctx = await connectForWrite(global, rt);
  const op = await setOp(ctx.client, ctx.device, {
    command: `fw ${table} ${action} ${id}`,
    menu: `/ip/firewall/${table}`,
    id,
    desired: { disabled: action === "disable" ? "true" : "false" },
    listHint,
  });
  return runWrite(ctx, op, confirm, rt);
}
