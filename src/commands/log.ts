import { parseCommandArgs } from "../args.js";
import { connect, type Runtime } from "../context.js";
import { fail } from "../errors.js";
import { formatDuration, parseDuration, type RosRecord } from "../ros/normalize.js";
import { clip, countBy, renderList } from "../views/list.js";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export const MESSAGE_LIMIT = 200;

/** Ngày giờ "đồng hồ tường" (không múi giờ) → số giây; chỉ dùng để so sánh với nhau. */
function wall(y: number, mo: number, d: number, h: number, mi: number, s: number): number {
  return Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
}

/** /system/clock: date "2026-10-13" (v7.10+) hoặc "oct/13/2026" (cũ); time "07:30:00". */
export function parseClock(date: string | undefined, time: string | undefined): number | undefined {
  const t = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(time ?? "");
  if (!t) return undefined;
  const [h, mi, s] = [Number(t[1]), Number(t[2]), Number(t[3])];
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? "");
  if (m) return wall(Number(m[1]), Number(m[2]), Number(m[3]), h, mi, s);
  m = /^([a-z]{3})\/(\d{2})\/(\d{4})$/i.exec(date ?? "");
  const mo = m ? MONTHS.indexOf((m[1] ?? "").toLowerCase()) + 1 : 0;
  if (m && mo) return wall(Number(m[3]), mo, Number(m[2]), h, mi, s);
  return undefined;
}

/**
 * Thời gian một dòng log, theo đồng hồ router `now`. Các dạng đã gặp qua các bản RouterOS:
 * "2026-10-13 07:01:02" · "10-13 07:01:02" · "07:01:02" (hôm nay) · "oct/13 07:01:02" ·
 * "oct/13/2025 07:01:02". Dạng thiếu năm ⇒ năm của `now` (lùi 1 năm nếu rơi vào tương lai).
 */
export function parseLogTime(value: string | undefined, now: number): number | undefined {
  const v = (value ?? "").trim();
  const t = /(\d{1,2}):(\d{2}):(\d{2})$/.exec(v);
  if (!t) return undefined;
  const [h, mi, s] = [Number(t[1]), Number(t[2]), Number(t[3])];
  const datePart = v.slice(0, t.index).trim();
  const today = new Date(now * 1000);
  const [cy, cm, cd] = [today.getUTCFullYear(), today.getUTCMonth() + 1, today.getUTCDate()];
  const withYear = (mo: number, d: number, y?: number): number => {
    const ts = wall(y ?? cy, mo, d, h, mi, s);
    return y === undefined && ts > now + 86400 ? wall(cy - 1, mo, d, h, mi, s) : ts;
  };
  if (datePart === "") return wall(cy, cm, cd, h, mi, s);
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  if (m) return wall(Number(m[1]), Number(m[2]), Number(m[3]), h, mi, s);
  m = /^(\d{2})-(\d{2})$/.exec(datePart);
  if (m) return withYear(Number(m[1]), Number(m[2]));
  m = /^([a-z]{3})\/(\d{2})(?:\/(\d{4}))?$/i.exec(datePart);
  if (m) {
    const mo = MONTHS.indexOf((m[1] ?? "").toLowerCase()) + 1;
    if (mo) return withYear(mo, Number(m[2]), m[3] ? Number(m[3]) : undefined);
  }
  return undefined;
}

export const LOG_HELP = `usage: mikrotik-axi log [--topic <t>] [--since <dur>] [--grep <regex>] [flags]
description: Router log, newest ${50} matching entries in time order; messages cut to ${MESSAGE_LIMIT} chars. --since is measured against the ROUTER clock
flags[5]:
  --topic <t>: entries whose topics include t (e.g. error, pppoe, dhcp)
  --since <dur>: only the last dur (e.g. 30m, 1h, 2d)
  --grep <regex>: case-insensitive match on the message
  --full: every matching entry, untruncated
  --device <name>: device from the profile
examples[2]:
  mikrotik-axi log --since 1h
  mikrotik-axi log --topic error --grep "login failure"
`;

export async function logCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { global, flags } = parseCommandArgs("log", args, {
    topic: { type: "string", hint: "--topic <t>" },
    since: { type: "string", hint: "--since <dur>" },
    grep: { type: "string", hint: "--grep <regex>" },
  });
  const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
  const topic = str("topic")?.toLowerCase();
  const sinceRaw = str("since");
  const since = sinceRaw === undefined ? undefined : parseDuration(sinceRaw);
  if (sinceRaw !== undefined && !since) {
    fail(`log: invalid --since ${sinceRaw}`, "VALIDATION_ERROR", ["Use a duration like 30m, 1h, 2d"]);
  }
  let grep: RegExp | undefined;
  const grepRaw = str("grep");
  if (grepRaw !== undefined) {
    try {
      grep = new RegExp(grepRaw, "i");
    } catch (e) {
      fail(`log: invalid --grep regex: ${(e as Error).message}`, "VALIDATION_ERROR");
    }
  }
  const fields = ["time", "topics", "message"];
  if (global.fields?.some((f) => !fields.includes(f))) {
    fail(`unknown field: ${global.fields.filter((f) => !fields.includes(f)).join(", ")}`, "VALIDATION_ERROR", [`Available fields: ${fields.join(", ")}`]);
  }

  const ctx = await connect(global, rt);
  const [entries, clock] = await Promise.all([
    ctx.client.list("/log", { proplist: ["time", "topics", "message"] }),
    // Luôn đọc đồng hồ router (rẻ): cần để tính buffer log thực sự trải bao lâu.
    ctx.client.single("/system/clock", { proplist: ["date", "time"] }).catch(() => undefined),
  ]);
  const now = clock ? parseClock(clock["date"], clock["time"]) : undefined;
  if (since && now === undefined) {
    fail(`cannot read the router clock (date=${clock?.["date"] ?? "?"}, time=${clock?.["time"] ?? "?"})`, "ROS_ERROR", [
      "Run without --since and filter by time manually",
    ]);
  }

  let unparsed = 0;
  const matched = entries.filter((e) => {
    if (topic && !(e["topics"] ?? "").toLowerCase().split(",").includes(topic)) return false;
    if (grep && !grep.test(e["message"] ?? "")) return false;
    if (since && now !== undefined) {
      const ts = parseLogTime(e["time"], now);
      if (ts === undefined) {
        unparsed++;
        return false;
      }
      if (ts < now - since) return false;
    }
    return true;
  });

  // Mới nhất 50, giữ thứ tự thời gian (log REST trả cũ → mới).
  const rows = matched.map((e) => ({
    time: e["time"] ?? "",
    topics: e["topics"] ?? "",
    message: global.full ? (e["message"] ?? "") : clip(e["message"] ?? "", MESSAGE_LIMIT),
  }));
  const shown = global.full ? rows : rows.slice(-50);
  const { out } = renderList(
    { key: "entries", rows: shown, fields, available: fields, command: "mikrotik-axi log", limit: Infinity },
    global,
  );
  const help: string[] = [];
  if (shown.length < rows.length) help.push(`Showing the newest ${shown.length}: add --full for all ${rows.length}`);
  // Buffer log trong RAM có hạn (mặc định 1000 dòng). Đo thật 2026-10-14: 2000 dòng chỉ chứa
  // ~2,5 phút vì rule DROP_INPUT ghi log mọi gói chặn ⇒ "--since 1h" KHÔNG thể đủ 1 giờ. Luôn nói
  // rõ log thực sự trải bao lâu, và cảnh báo khi ngắn hơn khoảng được hỏi.
  const span = coverage(entries, now);
  const short = since !== undefined && span !== undefined && span.seconds < since;
  return {
    matched: `${rows.length} of ${entries.length} entries`,
    ...(span ? { covers: `${span.from} → ${span.to} (${formatDuration(span.seconds)})` } : {}),
    ...(short
      ? {
          warning: `log buffer holds only ${formatDuration(span.seconds)}, less than --since ${sinceRaw}: older entries are gone`,
        }
      : {}),
    by_topic: countBy(matched, (e) => e["topics"] ?? "", 6) || "none",
    top_messages: countBy(matched, (e) => messagePrefix(e["message"]), 4) || "none",
    ...(unparsed ? { unparsed_times: `${unparsed} entries skipped (unknown time format)` } : {}),
    ...out,
    ...(shown.length < rows.length ? { count: `${shown.length} of ${rows.length} total` } : {}),
    ...(help.length || short
      ? {
          help: [
            ...help,
            ...(short
              ? ["Keep more history: raise /system/logging/action memory-lines, log noisy rules less, or log to disk/remote"]
              : []),
          ],
        }
      : {}),
  };
}

/** Khoảng thời gian buffer log thực sự trải (theo đồng hồ router). */
function coverage(entries: RosRecord[], now: number | undefined): { from: string; to: string; seconds: number } | undefined {
  if (now === undefined || entries.length === 0) return undefined;
  const first = entries[0]!["time"];
  const last = entries[entries.length - 1]!["time"];
  const a = parseLogTime(first, now);
  const b = parseLogTime(last, now);
  if (a === undefined || b === undefined) return undefined;
  return { from: first ?? "", to: last ?? "", seconds: Math.max(0, b - a) };
}

/** Tiền tố thông điệp để gom nhóm: phần trước dấu ":" đầu tiên (vd. "DROP_INPUT"), tối đa 40 ký tự. */
function messagePrefix(message: string | undefined): string {
  const m = (message ?? "").trim();
  const i = m.indexOf(":");
  return (i > 0 ? m.slice(0, i) : m).slice(0, 40) || "(empty)";
}
