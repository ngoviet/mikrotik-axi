import { homedir } from "node:os";
import { AxiError } from "axi-sdk-js";
import { parseCommandArgs } from "../args.js";
import { runChecks } from "../checks/index.js";
import { connect, type Runtime } from "../context.js";
import { formatDuration } from "../ros/normalize.js";
import { loadSnapshot, type HomeData } from "../snapshot.js";
import { dhcpLine } from "./dhcp.js";
import { healthLine } from "./health.js";
import { mainDefaultLine } from "./routes.js";
import { wanLine } from "./wan.js";

export const HOME_HELP = `usage: mikrotik-axi home [flags]
description: Health summary and alerts for one device (same as running with no arguments, but accepts flags)
flags[3]:
  --device <name>: device from the profile (default: profile default)
  --profile <path>: profile file to use
  --no-identity-check: skip the identity name comparison (read commands only)
`;

/** Home view nạp vào MỌI phiên agent qua hook ⇒ tổng ≤ 20 dòng (kể cả bin/description). */
export const HOME_MAX_LINES = 20;

type Out = Record<string, unknown>;

// Gợi ý bước tiếp theo theo cảnh báo đang có (ưu tiên trên xuống).
const HINTS: Array<[RegExp, string]> = [
  [/^pppoe-down/, "Run `mikrotik-axi wan` for per-session status"],
  [/^(mss-order|mss-raise|dup-mark)/, "Run `mikrotik-axi fw mangle check` to audit rule order"],
  [/^(main-default|no-netwatch)/, "Run `mikrotik-axi routes defaults` for default routes per table"],
  [/^service-open/, "Run `mikrotik-axi services` for management service ACLs"],
];
const DEFAULT_HINTS = ["Run `mikrotik-axi wan` for per-session status", "Run `mikrotik-axi log --since 1h` for recent events"];

/**
 * Mọi section đọc song song và hỏng độc lập: một menu bị 403 chỉ làm dòng đó "unavailable",
 * luật thiếu dữ liệu được liệt kê ở `checks_skipped` — không bao giờ im lặng.
 */
export async function homeView(args: string[], rt: Runtime): Promise<Out> {
  let deviceName: string | undefined;
  try {
    const { global } = parseCommandArgs("home", args);
    deviceName = global.device;
    const ctx = await connect(global, rt);
    deviceName = ctx.name;
    const { data, errors } = await loadSnapshot(ctx.client, ctx.device);
    const err = (k: keyof HomeData) => `unavailable (${errors[k] ?? "unknown error"})`;

    const res = data.resource;
    const checked = ctx.client.verified?.strict ? "ok" : "not checked";
    const deviceLine = [
      `identity ${ctx.identity} ${checked}`,
      res?.version ? `RouterOS ${res.version}` : "",
      res?.uptimeS !== undefined ? `up ${formatDuration(res.uptimeS)}` : "",
    ].filter(Boolean);

    const out: Out = {
      device: `${ctx.name} (${deviceLine.join(", ")})`,
      health: res ? healthLine(res, data.temp === undefined ? "n/a" : `${data.temp}C`) : err("resource"),
      wan: data.wan ? wanLine(data.wan) : err("wan"),
    };
    if (data.wan?.down.length) {
      out["wan_down"] = data.wan.down.length > 8 ? `${data.wan.down.slice(0, 8).join(", ")}, …` : data.wan.down.join(", ");
    }
    out["main_default"] = data.routes ? mainDefaultLine(data.routes) : err("routes");
    out["dhcp"] = data.dhcp ? dhcpLine(data.dhcp) : err("dhcp");

    const { alerts, skipped } = runChecks(data, ctx.device);
    if (skipped.length) out["checks_skipped"] = `${skipped.join(", ")} (data unavailable)`;

    // Thứ tự ưu tiên: gợi ý theo cảnh báo → các thiết bị khác trong profile → gợi ý mặc định.
    const hints = [...new Set(alerts.flatMap((a) => HINTS.filter(([re]) => re.test(a.id)).map(([, h]) => h)))];
    if (ctx.profileDevices.length > 1) hints.push(`Run \`mikrotik-axi devices\` for all ${ctx.profileDevices.length} devices in the profile`);
    for (const h of DEFAULT_HINTS) if (!hints.includes(h)) hints.push(h);

    // Ngân sách dòng: 2 header + các dòng trên + "alerts[n]:" + n + "help[k]:" + k.
    const used = 2 + Object.keys(out).length;
    const helpN = Math.min(2, hints.length);
    const room = HOME_MAX_LINES - used - 1 - helpN - (alerts.length ? 1 : 0);
    if (alerts.length) {
      // Mảng object đồng dạng ⇒ TOON in dạng bảng `alerts[n]{id,message}:`, mỗi cảnh báo một dòng.
      out["alerts"] =
        alerts.length <= room
          ? alerts
          : [...alerts.slice(0, room - 1), { id: "more", message: `${alerts.length - room + 1} more (disable noisy ids in profile alerts.disabled)` }];
    }
    out["help"] = hints.slice(0, helpN);
    return out;
  } catch (e) {
    return homeError(e, deviceName);
  }
}

/** Router không với tới / cấu hình sai: vẫn in header + lỗi + cách sửa, exit ≠ 0. */
function homeError(e: unknown, device: string | undefined): Out {
  const err = e instanceof AxiError ? e : new AxiError(e instanceof Error ? e.message : String(e), "UNKNOWN");
  process.exitCode = err.code === "VALIDATION_ERROR" ? 2 : 1;
  return {
    ...(device ? { device } : {}),
    error: err.message,
    code: err.code,
    ...(err.suggestions.length ? { help: err.suggestions } : {}),
  };
}

/** `mikrotik-axi home …` đi qua dispatch thường (không phải home của SDK) ⇒ tự thêm header. */
export function homeHeader(description: string): Out {
  const bin = process.argv[1] ?? "";
  const home = homedir();
  return { bin: bin.startsWith(home) ? `~${bin.slice(home.length)}` : bin, description };
}
