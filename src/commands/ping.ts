import { isIP } from "node:net";
import { parseCommandArgs } from "../args.js";
import { connect, type Runtime } from "../context.js";
import { fail } from "../errors.js";
import { toNumber, parseDuration, type RosRecord } from "../ros/normalize.js";
import { renderList } from "../views/list.js";
import { readWan } from "./wan.js";

// Chẩn đoán chạy TỪ router (không phải từ máy này): thấy được đường mà router thật sự đi, theo
// từng phiên PPPoE. Ca cần bắt: phiên vẫn `running` nhưng ISP mất định tuyến (luật no-netwatch).
// Dạng phản hồi ping theo manual REST chính thức: mỗi gói một bản ghi, bản ghi cuối mang số tổng
// sent/received/packet-loss/min-rtt/avg-rtt/max-rtt.

export const MAX_COUNT = 10;
const ADDRESS = /^[A-Za-z0-9.:-]{1,253}$/;
const NAME = /^[A-Za-z0-9._@-]{1,64}$/;

// RouterOS v7 ping/traceroute KHÔNG có tham số routing-table (CLI reference /tool/ping, /tool/traceroute,
// manual.mikrotik.com 2026-11-21): chỉ có `vrf`, và `vrf` từ chối bảng policy-routing (to-poN…). Muốn
// đi một bảng policy: đặt src-address mà routing rule đưa vào bảng đó. Review 2026-11-21 bắt lỗi này.
const POLICY_TABLE_TIP = "To test a policy-routing table, pass --src-address with an address a routing rule sends to that table (RouterOS ping has no routing-table argument)";

export const PING_HELP = `usage: mikrotik-axi ping <address> [--interface <name> | --each-wan] [--src-address a] [--count n] [flags]
description: Ping FROM the router (not from this machine), so the result shows the path the router really uses. --interface pins the egress (manual: "Interface the requests leave through"), e.g. one PPPoE session; --each-wan pings once through every running PPPoE session and lists the ones that fail: a session can be running while its ISP has lost routing. Needs the \`test\` policy on the user, which also allows fetch/email/bandwidth-test (no configuration change). Count 1-${MAX_COUNT} (REST ends a request at 60 s). ${POLICY_TABLE_TIP}
flags[5]:
  --interface <name>: send through this interface (e.g. pppoe-out3)
  --src-address <a>: source address (routing rules apply to the router's own pings)
  --each-wan: one ping through every running PPPoE session
  --count <n>: echo requests (default 3; --each-wan: 1)
  --device <name>: device from the profile
examples[3]:
  mikrotik-axi ping 1.1.1.1
  mikrotik-axi ping 1.1.1.1 --interface pppoe-out3
  mikrotik-axi ping 1.1.1.1 --each-wan
`;

export const TRACEROUTE_HELP = `usage: mikrotik-axi traceroute <address> [--interface <name>] [--src-address a] [flags]
description: Traceroute FROM the router, one probe per hop (count=1, max 30 hops). Needs the \`test\` policy on the user. Checked in CI against RouterOS CHR 7.25.1 (RTT in ms). ${POLICY_TABLE_TIP}
flags[3]:
  --interface <name>: send the probes out of this interface
  --src-address <a>: source address
  --device <name>: device from the profile
`;

const FLAGS = {
  interface: { type: "string", hint: "--interface <name>" },
  "src-address": { type: "string", hint: "--src-address <a>" },
} as const;

function target(raw: string | undefined, command: string): string {
  if (!raw || !ADDRESS.test(raw)) {
    fail(`${command}: needs an address or host name`, "VALIDATION_ERROR", [`Run \`mikrotik-axi ${command} --help\` for usage`]);
  }
  return raw;
}

const via = (route: Record<string, string>) =>
  route["interface"] ?? (route["src-address"] ? `source ${route["src-address"]} (routing rules decide)` : "router's routing");

/** Tham số định tuyến chung cho ping/traceroute; sai dạng ⇒ exit 2 trước mọi request. */
function routeBody(flags: Record<string, string | boolean | undefined>, command: string): Record<string, string> {
  const body: Record<string, string> = {};
  for (const k of ["interface", "src-address"] as const) {
    const v = flags[k];
    if (v === undefined) continue;
    if (typeof v !== "string" || !(k === "src-address" ? ADDRESS : NAME).test(v)) {
      fail(`${command}: invalid --${k} ${String(v)}`, "VALIDATION_ERROR");
    }
    body[k] = v;
  }
  return body;
}

export interface PingSummary {
  sent: number;
  received: number;
  loss: number;
  /** ms, có khi ít nhất một gói về. */
  avgMs?: number;
  minMs?: number;
  maxMs?: number;
  /** Lỗi router ghi trong bản ghi (no route to host, timeout…). */
  status?: string;
}

const ms = (v: string | undefined) => {
  const s = parseDuration(v);
  return s === undefined ? undefined : Math.round(s * 100000) / 100;
};

/** Bản ghi cuối mang số tổng; bản ghi mất gói thường có `status` (timeout, no route…). */
export function summarizePing(records: RosRecord[]): PingSummary {
  const last = records.at(-1) ?? {};
  const sent = toNumber(last["sent"]) ?? records.length;
  const received = toNumber(last["received"]) ?? records.filter((r) => r["time"]).length;
  const status = [...records].reverse().find((r) => r["status"])?.["status"];
  return {
    sent,
    received,
    loss: toNumber(last["packet-loss"]) ?? (sent ? Math.round(((sent - received) / sent) * 100) : 100),
    ...(received ? { avgMs: ms(last["avg-rtt"]), minMs: ms(last["min-rtt"]), maxMs: ms(last["max-rtt"]) } : {}),
    ...(status ? { status } : {}),
  };
}

const rtt = (p: PingSummary) => (p.avgMs !== undefined ? `${p.avgMs} ms` : "-");

export async function pingCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { positionals, global, flags } = parseCommandArgs(
    "ping",
    args,
    { ...FLAGS, "each-wan": { type: "boolean", hint: "--each-wan" }, count: { type: "string", hint: "--count <n>" } },
    1,
  );
  const address = target(positionals[0], "ping");
  const route = routeBody(flags, "ping");
  const eachWan = flags["each-wan"] === true;
  if (eachWan && route["interface"]) {
    fail("ping: --each-wan picks the interface itself (drop --interface)", "VALIDATION_ERROR");
  }
  const count = flags["count"] === undefined ? (eachWan ? 1 : 3) : Number(flags["count"]);
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    fail(`ping: --count must be 1-${MAX_COUNT}`, "VALIDATION_ERROR", ["REST ends a request after 60 s; one echo takes about 1 s"]);
  }
  const ctx = await connect(global, rt);
  // ~1 s mỗi gói + dư; vẫn dưới trần 60 s của REST.
  const timeoutMs = count * 1000 + 4000;
  const once = async (extra: Record<string, string>) =>
    summarizePing(await ctx.client.diagnose("/ping", { address, count: String(count), ...route, ...extra }, timeoutMs));

  if (!eachWan) {
    const p = await once({});
    return {
      target: address,
      via: via(route),
      result: `${p.received}/${p.sent} replies, ${p.loss}% loss`,
      ...(p.avgMs !== undefined ? { rtt: `min ${p.minMs} / avg ${p.avgMs} / max ${p.maxMs} ms` } : {}),
      ...(p.status ? { status: p.status } : {}),
      ...(p.received === 0 ? { help: ["No reply: try `mikrotik-axi ping <address> --each-wan` to see which sessions still reach it"] } : {}),
    };
  }

  const wan = await readWan(ctx.client, ctx.device.line_map ?? {});
  const sessions = wan.sessions.filter((s) => s.running && !s.disabled);
  if (!sessions.length) fail("ping --each-wan: no running PPPoE session on this device", "VALIDATION_ERROR");
  // Tuần tự: router chạy request cùng user tuần tự (song song không nhanh hơn, chỉ xếp hàng).
  const rows: Array<{ name: string; line: string; result: string; rtt: string; ok: boolean }> = [];
  for (const s of sessions) {
    let p: PingSummary;
    try {
      p = await once({ interface: s.name });
    } catch (e) {
      // Lỗi quyền ⇒ dừng ngay (sẽ lỗi y hệt ở mọi phiên); lỗi khác ⇒ ghi vào dòng.
      if (e instanceof Error && /test` policy/.test(e.message)) throw e;
      rows.push({ name: s.name, line: s.line, result: `error: ${(e as Error).message.slice(0, 60)}`, rtt: "-", ok: false });
      continue;
    }
    rows.push({ name: s.name, line: s.line, result: `${p.received}/${p.sent}${p.status ? ` ${p.status}` : ""}`, rtt: rtt(p), ok: p.received > 0 });
  }
  const failed = rows.filter((r) => !r.ok);
  const { out, help } = renderList(
    {
      key: "sessions",
      rows: (global.full ? rows : failed).map((r) => ({ name: r.name, line: r.line, result: r.result, rtt: r.rtt })),
      fields: ["name", "line", "result", "rtt"],
      available: ["name", "line", "result", "rtt"],
      command: `mikrotik-axi ping ${address} --each-wan`,
    },
    global,
  );
  return {
    target: address,
    reach: `${rows.length - failed.length}/${rows.length} running sessions reach ${address}`,
    ...(failed.length ? { failing: failed.map((r) => r.name).join(", ") } : {}),
    ...(failed.length || global.full ? out : {}),
    help: [
      ...help,
      ...(failed.length
        ? ["A session that is running but gets no reply has lost its ISP route: `mikrotik-axi pppoe restart <name>` (dry-run first)"]
        : ["Add --full to list every session with its RTT"]),
    ],
  };
}

export interface Hop {
  hop: number;
  address: string;
  loss: string;
  rtt: string;
}

/** RTT của traceroute: CLI reference ghi `last`/`avg` kiểu `num` (mili-giây, số trần); chuỗi thời lượng có đơn vị vẫn nhận. */
function hopRtt(v: string | undefined): string | undefined {
  if (v === undefined || v === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return `${v} ms`;
  const t = ms(v);
  return t === undefined ? undefined : `${t} ms`;
}

/**
 * Bảng hop từ phản hồi traceroute. Lệnh báo tiến độ ⇒ có thể nhận NHIỀU bản chụp bảng (đánh số
 * `.section`, manual: "Commands that report progress … number their replies in .section") ⇒ chỉ lấy
 * bản chụp cuối. Đo trên RouterOS CHR 7.25.1 (CI, 2026-11-21): `last` là số trần (bản đầu in "0"
 * vì chờ chuỗi có đơn vị như "1ms").
 */
export function hopsFrom(records: RosRecord[]): Hop[] {
  const sections = records.map((r) => r[".section"]).filter((s) => s !== undefined);
  const last = sections.length ? sections[sections.length - 1] : undefined;
  const rows = last === undefined ? records : records.filter((r) => r[".section"] === last);
  // CLI reference: loss = phần trăm (số), last = RTT lần cuối, bảng in "timeout" khi gói cuối không về.
  return rows.map((r, i) => {
    const loss = r["loss"];
    return {
      hop: i + 1,
      address: r["address"] || "*",
      loss: loss === undefined ? "-" : /^\d+(\.\d+)?$/.test(loss) ? `${loss}%` : loss,
      rtt: hopRtt(r["last"]) ?? hopRtt(r["avg"]) ?? (r["last"] || r["status"] || "-"),
    };
  });
}

export async function tracerouteCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { positionals, global, flags } = parseCommandArgs("traceroute", args, FLAGS, 1);
  const address = target(positionals[0], "traceroute");
  const route = routeBody(flags, "traceroute");
  const ctx = await connect(global, rt);
  const records = await ctx.client.diagnose("/tool/traceroute", { address, count: "1", "max-hops": "30", ...route }, 50_000);
  const hops = hopsFrom(records);
  const { out, help } = renderList(
    { key: "hops", rows: hops.map((h) => ({ ...h })), fields: ["hop", "address", "loss", "rtt"], available: ["hop", "address", "loss", "rtt"], command: `mikrotik-axi traceroute ${address}` },
    global,
  );
  // Đích là tên miền ⇒ không so được với địa chỉ hop (router không trả tên đã phân giải ở đây):
  // chỉ nêu hop cuối, không kết luận "không tới". Review 2026-11-21.
  const last = hops.at(-1)?.address;
  const summary = isIP(address)
    ? `${hops.length} hops, ${hops.some((h) => h.address === address) ? "destination reached" : "destination not seen"}`
    : `${hops.length} hops, last hop ${last ?? "none"} (host name target: not compared)`;
  return {
    target: address,
    via: via(route),
    summary,
    ...out,
    ...(help.length ? { help } : {}),
  };
}
