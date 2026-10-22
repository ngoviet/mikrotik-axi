import { parseCommandArgs } from "../args.js";
import { connect, type Runtime } from "../context.js";
import { fail } from "../errors.js";
import type { RosClient } from "../ros/client.js";
import { toBool, type RosRecord } from "../ros/normalize.js";
import { naturalCompare } from "../views/format.js";
import { assertFields, countBy, renderList } from "../views/list.js";

export interface DhcpSummary {
  servers: number;
  disabled: number;
  bound: number;
}

export async function readDhcp(client: RosClient): Promise<DhcpSummary> {
  const [servers, leases] = await Promise.all([
    client.list("/ip/dhcp-server", { proplist: ["name", "disabled"] }),
    client.list("/ip/dhcp-server/lease", { query: { status: "bound" }, proplist: ["status", "server"] }),
  ]);
  const disabled = servers.filter((s) => toBool(s["disabled"], "disabled")).length;
  return {
    servers: servers.length - disabled,
    disabled,
    // Lọc lại phía client cho chắc (query có thể không được áp).
    bound: leases.filter((l) => l["status"] === "bound").length,
  };
}

export function dhcpLine(d: DhcpSummary): string {
  return `${d.servers} servers${d.disabled ? ` (+${d.disabled} disabled)` : ""} · ${d.bound} bound`;
}

/** Ngưỡng "pool sắp đầy". */
export const POOL_FULL_PCT = 90;

function ipToInt(ip: string): number | undefined {
  const p = ip.trim().split(".").map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return undefined;
  return ((p[0]! << 24) >>> 0) + (p[1]! << 16) + (p[2]! << 8) + p[3]!;
}

/** "10.0.0.10-10.0.0.254,10.0.1.5" → số địa chỉ. Định dạng lạ (IPv6, CIDR) ⇒ undefined. */
export function poolSize(ranges: string | undefined): number | undefined {
  if (!ranges) return undefined;
  let total = 0;
  for (const part of ranges.split(",")) {
    const [a, b] = part.split("-");
    const lo = ipToInt(a ?? "");
    const hi = b === undefined ? lo : ipToInt(b);
    if (lo === undefined || hi === undefined || hi < lo) return undefined;
    total += hi - lo + 1;
  }
  return total;
}

export const DHCP_HELP = `usage: mikrotik-axi dhcp [flags]
       mikrotik-axi dhcp leases <server> [flags]
description: DHCP servers with bound/total leases and pool usage (pools >= ${POOL_FULL_PCT}% flagged). \`dhcp leases <server>\` lists one server's leases; a static reservation in \`waiting\` just means that device is offline
flags[3]:
  --fields a,b: dhcp columns name,bound,total,pool_used (also interface,pool,disabled); leases columns address,mac,host,status (also type,comment)
  --full: all rows
  --device <name>: device from the profile
`;

export async function dhcpCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { positionals, global } = parseCommandArgs("dhcp", args, {}, 2);
  const [sub, server] = positionals;
  if (sub !== undefined && sub !== "leases") {
    fail(`dhcp: unknown sub-command ${sub}`, "VALIDATION_ERROR", ["Run `mikrotik-axi dhcp` or `mikrotik-axi dhcp leases <server>`"]);
  }
  if (sub === "leases") {
    if (!server) fail("dhcp leases: missing <server>", "VALIDATION_ERROR", ["Run `mikrotik-axi dhcp` to list server names"]);
    assertFields(global.fields, LEASE_FIELDS);
    const ctx = await connect(global, rt);
    return leases(ctx.client, server, global);
  }
  assertFields(global.fields, SERVER_FIELDS);
  const ctx = await connect(global, rt);
  return servers(ctx.client, global);
}

type Flags = Parameters<typeof renderList>[1];
const SERVER_FIELDS = ["name", "interface", "bound", "total", "pool_used", "pool", "disabled"];
const LEASE_FIELDS = ["address", "mac", "host", "status", "type", "comment"];

async function servers(client: RosClient, global: Flags): Promise<Record<string, unknown>> {
  const [srv, leases, pools, used] = await Promise.all([
    client.list("/ip/dhcp-server", { proplist: ["name", "interface", "address-pool", "disabled"] }),
    client.list("/ip/dhcp-server/lease", { proplist: ["server", "status"] }),
    client.list("/ip/pool", { proplist: ["name", "ranges"] }),
    client.list("/ip/pool/used", { proplist: ["pool"] }),
  ]);
  const count = (xs: RosRecord[], key: string) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x[key] ?? "", (m.get(x[key] ?? "") ?? 0) + 1);
    return m;
  };
  const total = count(leases, "server");
  const bound = count(
    leases.filter((l) => l["status"] === "bound"),
    "server",
  );
  const usedBy = count(used, "pool");
  const size = new Map(pools.map((p) => [p["name"] ?? "", poolSize(p["ranges"])]));
  const nearFull: string[] = [];
  const rows = srv
    .map((s) => {
      const name = s["name"] ?? "";
      const pool = s["address-pool"] ?? "";
      const n = size.get(pool);
      const u = usedBy.get(pool) ?? 0;
      const pct = n ? Math.round((u / n) * 100) : undefined;
      if (pct !== undefined && pct >= POOL_FULL_PCT) nearFull.push(`${pool} ${u}/${n}`);
      return {
        name,
        interface: s["interface"] ?? "",
        bound: bound.get(name) ?? 0,
        total: total.get(name) ?? 0,
        pool_used: n ? `${u}/${n} ${pct}%` : pool ? "?" : "-",
        pool,
        disabled: toBool(s["disabled"], "disabled"),
      };
    })
    .sort((a, b) => naturalCompare(a.name, b.name));
  const { out, help } = renderList(
    { key: "servers", rows, fields: ["name", "bound", "total", "pool_used"], available: SERVER_FIELDS, command: "mikrotik-axi dhcp" },
    global,
  );
  return {
    bound: `${rows.reduce((a, r) => a + r.bound, 0)} of ${leases.length} leases`,
    pools_near_full: nearFull.length ? nearFull.join(", ") : "none",
    ...out,
    help: [...help, "Run `mikrotik-axi dhcp leases <server>` for one server's leases"],
  };
}

async function leases(client: RosClient, server: string, global: Flags): Promise<Record<string, unknown>> {
  const [srv, rows] = await Promise.all([
    client.list("/ip/dhcp-server", { proplist: ["name"] }),
    client.list("/ip/dhcp-server/lease", {
      query: { server },
      proplist: ["server", "address", "mac-address", "host-name", "status", "dynamic", "comment"],
    }),
  ]);
  if (!srv.some((s) => s["name"] === server)) {
    const names = srv.map((s) => s["name"] ?? "").sort(naturalCompare);
    fail(`unknown DHCP server: ${server}`, "VALIDATION_ERROR", [`Servers: ${names.slice(0, 12).join(", ")}${names.length > 12 ? ", …" : ""}`]);
  }
  const list = rows
    .filter((l) => l["server"] === server)
    .map((l) => ({
      address: l["address"] ?? "",
      mac: l["mac-address"] ?? "",
      host: l["host-name"] ?? "",
      status: l["status"] ?? "",
      type: toBool(l["dynamic"], "dynamic") ? "dynamic" : "static",
      comment: l["comment"] ?? "",
    }))
    .sort((a, b) => naturalCompare(a.address, b.address));
  const staticWaiting = list.filter((l) => l.type === "static" && l.status === "waiting").length;
  const { out, help } = renderList(
    { key: "leases", rows: list, fields: ["address", "mac", "host", "status"], available: LEASE_FIELDS, command: `mikrotik-axi dhcp leases ${server}`, textFields: ["comment", "host"] },
    global,
  );
  return {
    server,
    by_status: countBy(list, (l) => l.status) || "none",
    ...(staticWaiting ? { note: `${staticWaiting} static reservation(s) waiting: normal when the device is offline` } : {}),
    ...out,
    ...(help.length ? { help } : {}),
  };
}
