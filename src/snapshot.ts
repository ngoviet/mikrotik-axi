import type { CheckData } from "./checks/index.js";
import { readDhcp, type DhcpSummary } from "./commands/dhcp.js";
import { readRules, MANGLE_PROPLIST, RULE_PROPLIST } from "./commands/fw.js";
import { readResource, readTemperature } from "./commands/health.js";
import { readDefaultRoutes } from "./commands/routes.js";
import { readReverseProxyRules, readServices } from "./commands/services.js";
import { readWan } from "./commands/wan.js";
import type { DeviceProfile } from "./config/profile.js";
import type { RosClient } from "./ros/client.js";

export interface HomeData extends CheckData {
  temp: number | undefined;
  dhcp: DhcpSummary;
}

export interface Snapshot {
  data: Partial<HomeData>;
  /** Lỗi theo phần — để in "unavailable (…)" thay vì im lặng. */
  errors: Partial<Record<keyof HomeData, string>>;
}

/**
 * Mọi thứ home view + luật kiểm cần, đọc một lượt song song (client tự giới hạn đồng thời).
 * Luật kiểm chỉ dùng dữ liệu này — không gọi REST riêng (§7).
 */
export async function loadSnapshot(client: RosClient, device: DeviceProfile): Promise<Snapshot> {
  const tasks: { [K in keyof HomeData]: Promise<HomeData[K]> } = {
    resource: readResource(client),
    temp: readTemperature(client),
    update: client.single("/system/package/update", { proplist: ["channel", "installed-version", "latest-version"] }),
    wan: readWan(client, device.line_map),
    routes: readDefaultRoutes(client),
    dhcp: readDhcp(client),
    mangle: readRules(client, "mangle", MANGLE_PROPLIST),
    filter: readRules(client, "filter", RULE_PROPLIST),
    nat: readRules(client, "nat", RULE_PROPLIST),
    raw: readRules(client, "raw", RULE_PROPLIST),
    services: readServices(client),
    reverseProxyRules: readReverseProxyRules(client),
    macServer: client.single("/tool/mac-server", { proplist: ["allowed-interface-list"] }),
    macWinbox: client.single("/tool/mac-server/mac-winbox", { proplist: ["allowed-interface-list"] }),
    netwatch: client.list("/tool/netwatch", { proplist: ["host", "disabled"] }),
    bridgePorts: client.list("/interface/bridge/port", { proplist: ["interface", "bridge", "disabled", "dynamic", "bpdu-guard"] }),
    ethernet: client.list("/interface/ethernet", { proplist: ["name", "loop-protect"] }),
  };
  const keys = Object.keys(tasks) as Array<keyof HomeData>;
  const settled = await Promise.allSettled(keys.map((k) => tasks[k]));
  const snap: Snapshot = { data: {}, errors: {} };
  settled.forEach((r, i) => {
    const k = keys[i] as keyof HomeData;
    if (r.status === "fulfilled") (snap.data as Record<string, unknown>)[k] = r.value;
    else snap.errors[k] = r.reason instanceof Error ? r.reason.message : String(r.reason);
  });
  return snap;
}
