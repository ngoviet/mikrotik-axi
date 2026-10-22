import { AxiError } from "axi-sdk-js";
import { parseCommandArgs } from "../args.js";
import { connect, type Runtime } from "../context.js";
import type { RosClient } from "../ros/client.js";
import { toBool, toNumber, type RosRecord } from "../ros/normalize.js";
import { renderList } from "../views/list.js";
import { classifyOpen } from "../checks/services.js";

/**
 * Bẫy #5: ACL thật của /ip/service ở `available-from`; `address` luôn rỗng (tên cũ). Cố ý KHÔNG
 * xin `address` trong proplist để không ai đọc nhầm nó.
 * Bẫy #7: từ 7.2x menu này trả cả entry ĐỘNG — socket nội bộ (resolver, dhcp, ntp, detnet…) và
 * từng kết nối đang mở (`connection=true`) — không có `available-from` ⇒ trông như "mở mọi nguồn".
 * Đo trên CCR2004 7.24.4 (2026-10-14): 137 entry, chỉ 9 entry `dynamic=false` là dịch vụ thật.
 */
export async function readServices(client: RosClient): Promise<RosRecord[]> {
  const rows = await client.list("/ip/service", {
    query: { dynamic: "false" },
    proplist: ["name", "port", "disabled", "dynamic", "available-from"],
  });
  // Lọc lại phía client: không phụ thuộc việc router có áp query hay không.
  return rows.filter((r) => !toBool(r["dynamic"], "dynamic"));
}

/**
 * Số rule reverse-proxy đang bật. Dịch vụ `reverse-proxy` (7.2x) bật mà KHÔNG có rule thì không
 * nghe cổng nào — đo CRS310/CRS326 7.24.4 (2026-10-14): `/ip/reverse-proxy` rỗng, TCP 443 bị từ chối.
 * RouterOS cũ không có menu ⇒ 0. Lỗi khác ⇒ ném (snapshot ghi lỗi ⇒ luật coi như có thể đang nghe).
 */
export async function readReverseProxyRules(client: RosClient): Promise<number> {
  try {
    const rules = await client.list("/ip/reverse-proxy", { proplist: [".id", "disabled"] });
    return rules.filter((r) => !toBool(r["disabled"], "disabled")).length;
  } catch (e) {
    if (e instanceof AxiError && /no such command/i.test(e.message)) return 0;
    throw e;
  }
}

export const SERVICES_HELP = `usage: mikrotik-axi services [flags]
description: Configured management services (/ip/service, dynamic sockets/connections excluded) with their real ACL (available-from). The legacy \`address\` field is always empty on v7 and is never shown
flags[2]:
  --fields a,b: columns (name,port,disabled,available_from)
  --device <name>: device from the profile
`;

export async function servicesCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { global } = parseCommandArgs("services", args);
  const ctx = await connect(global, rt);
  const [raw, proxyRules] = await Promise.all([
    readServices(ctx.client),
    readReverseProxyRules(ctx.client).catch(() => undefined),
  ]);
  const { open, idle } = classifyOpen(raw, proxyRules);
  const rows = raw.map((s) => ({
    name: s["name"] ?? "",
    port: toNumber(s["port"]) ?? 0,
    disabled: toBool(s["disabled"], "disabled"),
    available_from: s["available-from"] || "any",
  }));
  const { out, help } = renderList(
    { key: "services", rows, fields: ["name", "port", "disabled", "available_from"], available: ["name", "port", "disabled", "available_from"], command: "mikrotik-axi services" },
    global,
  );
  return {
    enabled: rows.filter((r) => !r.disabled).map((r) => r.name).join(", ") || "none",
    open_to_any: open.length ? open.join(", ") : "none",
    ...(idle.length ? { idle: `${idle.join(", ")}: enabled with no proxy rules, not listening (disable it or set available-from)` } : {}),
    ...out,
    ...(help.length || open.length
      ? { help: [...help, ...(open.length ? ["Restrict with available-from (the `address` field has no effect on v7)"] : [])] }
      : {}),
  };
}
