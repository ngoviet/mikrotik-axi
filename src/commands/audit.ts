import { isIP } from "node:net";
import { AxiError } from "axi-sdk-js";
import { parseCommandArgs } from "../args.js";
import { AUDIT_RULES, runAudit, type AuditData, type AuditKey } from "../checks/audit.js";
import type { WanSet } from "../checks/firewall-sim.js";
import { connect, type Runtime } from "../context.js";
import { fail } from "../errors.js";
import type { RosClient } from "../ros/client.js";
import { toBool } from "../ros/normalize.js";
import { readDefaultRoutes } from "./routes.js";
import { readReverseProxyRules, readServices } from "./services.js";
import { naturalCompare } from "../views/format.js";
import { renderList } from "../views/list.js";

export const AUDIT_HELP = `usage: mikrotik-axi audit [flags]
description: Security audit of one device: ${AUDIT_RULES.length} checks, each a judgement rather than a syntax check. Findings sorted high > medium > low; a check whose menu could not be read is listed under checks_skipped with the reason (absent on this device, or the read error), never guessed. Exit 1 when no check could run. Read-only; the home view does not run these (it must stay one fast round of reads). Disable a check with alerts.disabled in the profile
checks[${AUDIT_RULES.length}]{id,severity,summary}:
${AUDIT_RULES.map((r) => `  ${r.id},${r.severity},"${r.summary.replace(/"/g, "'")}"`).join("\n")}
flags[2]:
  --fields a,b: columns (id,severity,message)
  --device <name>: device from the profile
`;

export interface AuditRead {
  data: Partial<AuditData>;
  /** Lý do không đọc được, theo khoá dữ liệu. */
  errors: Partial<Record<AuditKey, string>>;
}

/** Menu không có trên model/phiên bản này ⇒ RouterOS trả 400 "no such command or directory". */
function reason(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/no such command/i.test(msg)) return "not on this device";
  const code = e instanceof AxiError ? e.code : undefined;
  return `read failed${code ? `: ${code}` : ""}`;
}

/**
 * Cổng ra của từng route mặc định: MỌI next-hop của `immediate-gw` (ECMP; review vòng 4: trước chỉ lấy
 * cái đầu ⇒ cổng ra thứ hai không được xét); gateway dạng `ip%iface` ⇒ phần sau `%`. Route `blackhole` bị
 * bỏ (không có cổng ra, gói bị huỷ). Còn lại (IP trần, rỗng, "?": route chưa resolve hoặc không có
 * gateway) ⇒ `unknown`, KHÔNG bỏ âm thầm (review vòng 3): dns-open không được kết luận "closed" khi còn
 * route chưa rõ cổng ra. Đo CCR2004 7.25.1: cả 82 route mặc định đều có immediate-gw.
 */
export function wanSet(routes: Array<{ via: string; vias?: string[]; gateway: string; blackhole?: boolean }>): WanSet {
  const interfaces = new Set<string>();
  const unknown = new Set<string>();
  for (const r of routes) {
    if (r.blackhole) continue;
    for (const raw of r.vias?.length ? r.vias : [r.via]) {
      const v = raw.includes("%") ? raw.slice(raw.lastIndexOf("%") + 1) : raw;
      if (v && v !== "?" && !isIP(v)) interfaces.add(v);
      else unknown.add(r.gateway && r.gateway !== "?" ? r.gateway : "(none)");
    }
  }
  return { interfaces: [...interfaces].sort(naturalCompare), unknown: [...unknown].sort(naturalCompare) };
}

export async function readAuditData(client: RosClient): Promise<AuditRead> {
  const errors: Partial<Record<AuditKey, string>> = {};
  const reads: { [K in AuditKey]?: () => Promise<AuditData[K]> } = {
    services: () => readServices(client),
    macServer: () => client.single("/tool/mac-server", { proplist: ["allowed-interface-list"] }),
    macWinbox: () => client.single("/tool/mac-server/mac-winbox", { proplist: ["allowed-interface-list"] }),
    // Không xin `password`/`last-logged-in`: chỉ cần tên, group, địa chỉ cho phép.
    users: () => client.list("/user", { proplist: ["name", "group", "address", "disabled"] }),
    groups: () => client.list("/user/group", { proplist: ["name", "policy"] }),
    pptp: () => client.single("/interface/pptp-server/server", { proplist: ["enabled"] }),
    l2tp: () => client.single("/interface/l2tp-server/server", { proplist: ["enabled", "use-ipsec"] }),
    ssh: () => client.single("/ip/ssh", { proplist: ["strong-crypto", "host-key-type", "host-key-size"] }),
    dns: () => client.single("/ip/dns", { proplist: ["allow-remote-requests"] }),
    // KHÔNG dùng proplist: dns-open coi mọi trường lạ (limit, src-mac-address…) là điều kiện chưa
    // đánh giá được; proplist sẽ giấu chúng và làm rule trông rộng hơn thật. Lọc lại chain phía client.
    filter: async () => (await client.list("/ip/firewall/filter", { query: { chain: "input" } })).filter((r) => r["chain"] === "input"),
    upnp: () => client.single("/ip/upnp", { proplist: ["enabled"] }),
    socks: () => client.single("/ip/socks", { proplist: ["enabled", "auth-method"] }),
    proxy: () => client.single("/ip/proxy", { proplist: ["enabled"] }),
    snmp: () => client.single("/snmp", { proplist: ["enabled"] }),
    snmpCommunities: () => client.list("/snmp/community", { proplist: ["name", "addresses", "disabled"] }),
    neighbor: () => client.single("/ip/neighbor/discovery-settings", { proplist: ["discover-interface-list"] }),
    routerboard: () => client.single("/system/routerboard", { proplist: ["current-firmware", "upgrade-firmware"] }),
    romon: () => client.single("/tool/romon", { proplist: ["enabled"] }),
    // dns-open: WAN = cổng ra (immediate-gw) của mọi route mặc định đang bật, mọi bảng.
    wan: async () => wanSet([...(await readDefaultRoutes(client)).values()].flat()),
    // `builtin` không cần: list dựng sẵn nhận theo tên (firewall-sim.ts).
    interfaceLists: () => client.list("/interface/list", { proplist: ["name", "include", "exclude"] }),
    listMembers: () => client.list("/interface/list/member", { proplist: ["list", "interface", "disabled"] }),
  };
  const data: Partial<AuditData> = {};
  const settled = await Promise.all(
    (Object.entries(reads) as Array<[AuditKey, () => Promise<unknown>]>).map(async ([key, read]) => {
      try {
        return [key, await read()] as const;
      } catch (e) {
        errors[key] = reason(e);
        return [key, undefined] as const;
      }
    }),
  );
  for (const [key, value] of settled) if (value !== undefined) (data as Record<string, unknown>)[key] = value;
  // Đọc lỗi ⇒ undefined ⇒ luật service-open coi reverse-proxy là có thể đang nghe (thận trọng).
  data.reverseProxyRules = await readReverseProxyRules(client).catch(() => undefined);
  return { data, errors };
}

export async function auditCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { global } = parseCommandArgs("audit", args);
  const ctx = await connect(global, rt);
  const { data, errors } = await readAuditData(ctx.client);
  const { findings, passed, skipped } = runAudit(data, ctx.device.alerts?.disabled ?? []);
  const skippedWhy = skipped.map((id) => {
    const rule = AUDIT_RULES.find((r) => r.id === id)!;
    const why = [...new Set(rule.needs.map((k) => errors[k]).filter(Boolean))].join(", ");
    return `${id} (${why || "no data"})`;
  });
  if (!findings.length && !passed.length && !skipped.length) {
    // Profile tắt hết mọi luật: không phải lỗi đọc (review 2026-11-21 lần 2).
    return {
      device: ctx.name,
      verdict: "no checks enabled (alerts.disabled in the profile lists every audit check)",
      help: ["Remove ids from alerts.disabled to run them"],
    };
  }
  if (!findings.length && !passed.length) {
    fail(`audit: no check could run on ${ctx.name}`, "ROS_ERROR", [
      `Skipped: ${skippedWhy.join("; ")}`,
      "Check that the user can read these menus (policy read), then retry",
    ]);
  }
  const by = (s: string) => findings.filter((f) => f.severity === s).length;
  const { out, help } = renderList(
    {
      key: "findings",
      rows: findings.map((f) => ({ ...f })),
      fields: ["id", "severity", "message"],
      available: ["id", "severity", "message"],
      command: "mikrotik-axi audit",
      limit: 50,
    },
    global,
  );
  return {
    device: ctx.name,
    verdict: findings.length ? `${by("high")} high, ${by("medium")} medium, ${by("low")} low` : `no findings (${passed.length} checks passed)`,
    ...(findings.length ? out : {}),
    passed: passed.length ? passed.join(", ") : "none",
    // Ngữ cảnh của dns-open: đã xét bao nhiêu WAN, có route nào chưa rõ cổng ra (review vòng 3). Chỉ khi
    // DNS nhận truy vấn từ xa: tắt thì luật dừng sớm, không có WAN nào thực sự được xét.
    ...(data.wan &&
    toBool(data.dns?.["allow-remote-requests"], "allow-remote-requests") &&
    (passed.includes("dns-open") || findings.some((f) => f.id === "dns-open"))
      ? {
          wan_tested: `${data.wan.interfaces.length} interface(s) carrying a default route${data.wan.unknown.length ? `; ${data.wan.unknown.length} route(s) with unknown egress not tested` : ""}`,
        }
      : {}),
    ...(skippedWhy.length ? { checks_skipped: skippedWhy.join("; ") } : {}),
    ...(help.length || findings.length
      ? {
          help: [
            ...help,
            ...(findings.length ? ["Fix on the router (these are judgements, not changes this tool makes); silence one with alerts.disabled in the profile"] : []),
          ],
        }
      : {}),
  };
}
