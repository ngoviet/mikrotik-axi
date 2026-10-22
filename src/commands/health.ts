import { parseCommandArgs } from "../args.js";
import { connect, type Runtime } from "../context.js";
import type { RosClient } from "../ros/client.js";
import { formatDuration, normalize, toNumber } from "../ros/normalize.js";
import { bytes, percent, selectFields, unavailable } from "../views/format.js";

export interface Health {
  board?: string;
  version?: string;
  uptimeS?: number;
  cpuPct?: number;
  memPct?: number;
  memTotal?: number;
}

const RESOURCE_SCHEMA = {
  "board-name": "string",
  version: "string",
  uptime: "duration",
  "cpu-load": "number",
  "free-memory": "number",
  "total-memory": "number",
} as const;

// Tên cảm biến khác nhau theo model; lấy cái đầu tiên có trong danh sách ưu tiên.
const TEMP_SENSORS = ["cpu-temperature", "temperature", "board-temperature1", "switch-temperature"];

export async function readResource(client: RosClient): Promise<Health> {
  const r = normalize(await client.single("/system/resource", { proplist: Object.keys(RESOURCE_SCHEMA) }), RESOURCE_SCHEMA);
  const total = r["total-memory"];
  const free = r["free-memory"];
  return {
    ...(r["board-name"] ? { board: r["board-name"] } : {}),
    ...(r.version ? { version: r.version } : {}),
    ...(r.uptime !== undefined ? { uptimeS: r.uptime } : {}),
    ...(r["cpu-load"] !== undefined ? { cpuPct: r["cpu-load"] } : {}),
    ...(total && free !== undefined ? { memPct: ((total - free) / total) * 100, memTotal: total } : {}),
  };
}

/** /system/health là LIST ở v7: [{name, value, type}]. Không có cảm biến ⇒ undefined. */
export async function readTemperature(client: RosClient): Promise<number | undefined> {
  const items = await client.list("/system/health", { proplist: ["name", "value", "type"] });
  for (const sensor of TEMP_SENSORS) {
    const hit = items.find((i) => i["name"] === sensor);
    const v = toNumber(hit?.["value"]);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Dùng kết quả kiểm update ĐÃ CÓ trên router — không bao giờ tự bấm check-for-updates. */
export async function readVersionCheck(client: RosClient): Promise<string> {
  const u = await client.single("/system/package/update", { proplist: ["channel", "installed-version", "latest-version"] });
  const installed = u["installed-version"];
  const latest = u["latest-version"];
  const channel = u["channel"] ? `, channel ${u["channel"]}` : "";
  if (!latest) return `unknown (router has not checked for updates${channel})`;
  if (latest === installed) return `up to date${channel ? ` (${channel.slice(2)})` : ""}`;
  return `${latest} available (installed ${installed ?? "?"}${channel})`;
}

export function healthLine(h: Health, temp: string): string {
  return `cpu ${percent(h.cpuPct)}, mem ${percent(h.memPct)}, temp ${temp}`;
}

export const HEALTH_HELP = `usage: mikrotik-axi health [flags]
description: Identity, board, RouterOS version, uptime, CPU, memory, temperature and update status
flags[3]:
  --device <name>: device from the profile (default: profile default)
  --fields a,b: only these keys (device,identity,board,version,uptime,cpu,mem,temp,version_check)
  --no-identity-check: skip the identity name comparison (read commands only)
`;

export async function healthCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { global } = parseCommandArgs("health", args);
  const ctx = await connect(global, rt);
  const [res, temp, versionCheck] = await Promise.all([
    readResource(ctx.client),
    readTemperature(ctx.client).then(
      (t) => (t === undefined ? "n/a" : `${t}C`),
      (e: unknown) => unavailable(e),
    ),
    readVersionCheck(ctx.client).catch(unavailable),
  ]);
  const out: Record<string, string> = {
    device: ctx.name,
    identity: ctx.client.verified?.strict ? `${ctx.identity} (verified)` : `${ctx.identity} (not checked)`,
    board: res.board ?? "n/a",
    version: res.version ?? "n/a",
    uptime: res.uptimeS === undefined ? "n/a" : formatDuration(res.uptimeS),
    cpu: percent(res.cpuPct),
    mem: res.memTotal ? `${percent(res.memPct)} of ${bytes(res.memTotal)}` : "n/a",
    temp,
    version_check: versionCheck,
  };
  return selectFields(out, global.fields);
}
