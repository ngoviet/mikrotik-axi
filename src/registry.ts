import { AUDIT_HELP, auditCommand } from "./commands/audit.js";
import { DEVICES_HELP, devicesCommand } from "./commands/devices.js";
import { DHCP_HELP, dhcpCommand } from "./commands/dhcp.js";
import { EXPORT_HELP, exportCommand } from "./commands/export.js";
import { FW_HELP, fwCommand } from "./commands/fw.js";
import { HEALTH_HELP, healthCommand } from "./commands/health.js";
import { HOME_HELP } from "./commands/home.js";
import { IFACE_HELP, ifaceCommand, VLANS_HELP, vlansCommand } from "./commands/interfaces.js";
import { LOG_HELP, logCommand } from "./commands/log.js";
import { PING_HELP, pingCommand, TRACEROUTE_HELP, tracerouteCommand } from "./commands/ping.js";
import { ROUTES_HELP, routesCommand } from "./commands/routes.js";
import { SERVICES_HELP, servicesCommand } from "./commands/services.js";
import { SETUP_HELP, setupCommand } from "./commands/setup.js";
import { WAN_HELP, wanCommand } from "./commands/wan.js";
import {
  ADDR_LIST_HELP,
  addrListCommand,
  ARP_HELP,
  arpCommand,
  PPPOE_HELP,
  pppoeCommand,
  REVERT_HELP,
  revertCommand,
} from "./commands/writes.js";
import type { Runtime } from "./context.js";

export const DESCRIPTION = "Inspect and safely operate MikroTik RouterOS v7 devices over REST";

export interface CommandSpec {
  /** Dạng gọi ngắn cho bảng lệnh, ví dụ "fw <filter|nat|mangle|raw>". */
  usage: string;
  summary: string;
  help: string;
  /** home được cli.ts xử lý riêng (cần header). */
  run?: (args: string[], rt: Runtime) => Promise<Record<string, unknown>>;
}

/** NGUỒN DUY NHẤT cho --help, dispatch và skill/SKILL.md (pnpm skill:build). */
export const COMMANDS: Record<string, CommandSpec> = {
  home: { usage: "home", summary: "health summary + alerts (same as no arguments; accepts flags)", help: HOME_HELP },
  devices: { usage: "devices", summary: "every profile device: identity check, version, reachability", help: DEVICES_HELP, run: devicesCommand },
  health: { usage: "health", summary: "identity, board, version, uptime, cpu, memory, temperature, update status", help: HEALTH_HELP, run: healthCommand },
  wan: { usage: "wan [ips]", summary: "PPPoE sessions per physical line; `ips` = public IP per session", help: WAN_HELP, run: wanCommand },
  routes: { usage: "routes <defaults|rules>", summary: "default routes per routing-table; /routing/rule vs mangle", help: ROUTES_HELP, run: routesCommand },
  dhcp: { usage: "dhcp [leases <server> | move …]", summary: "DHCP servers, bound leases, pool usage; WRITE: `move` one static reservation", help: DHCP_HELP, run: dhcpCommand },
  vlans: { usage: "vlans", summary: "VLAN interfaces with addresses", help: VLANS_HELP, run: vlansCommand },
  iface: { usage: "iface [--type t]", summary: "interfaces, running state, byte counters", help: IFACE_HELP, run: ifaceCommand },
  fw: { usage: "fw <filter|nat|mangle|raw> [check | enable|disable <.id>]", summary: "firewall rules in order; mangle MSS/mark audit; WRITE: enable/disable a rule", help: FW_HELP, run: fwCommand },
  services: { usage: "services", summary: "management services and their real ACL (available-from)", help: SERVICES_HELP, run: servicesCommand },
  audit: { usage: "audit", summary: "security audit: plaintext services, admin user, PPTP, open DNS/SNMP, UPnP, RouterBOOT…", help: AUDIT_HELP, run: auditCommand },
  ping: { usage: "ping <address> [--interface i | --each-wan]", summary: "ping FROM the router; --each-wan finds PPPoE sessions that run but lost their ISP route (needs policy test)", help: PING_HELP, run: pingCommand },
  traceroute: { usage: "traceroute <address> [--interface i]", summary: "traceroute FROM the router (needs policy test)", help: TRACEROUTE_HELP, run: tracerouteCommand },
  log: { usage: "log [--topic t] [--since 1h] [--grep re]", summary: "recent router log", help: LOG_HELP, run: logCommand },
  export: { usage: "export [diff] [--section <menu>]", summary: "save the config to a local .rsc (path + sha256 only); `diff` = what changed since the last save", help: EXPORT_HELP, run: exportCommand },
  pppoe: { usage: "pppoe restart <name>", summary: "WRITE: restart one PPPoE session (dry-run unless --confirm)", help: PPPOE_HELP, run: pppoeCommand },
  arp: { usage: "arp flush <address>", summary: "WRITE: drop a dynamic ARP entry (dry-run unless --confirm)", help: ARP_HELP, run: arpCommand },
  "addr-list": { usage: "addr-list add|remove <list> <address>", summary: "WRITE: one firewall address-list entry (dry-run unless --confirm)", help: ADDR_LIST_HELP, run: addrListCommand },
  revert: { usage: "revert <snapshot-file>", summary: "WRITE: undo a change from its snapshot (dry-run unless --confirm)", help: REVERT_HELP, run: revertCommand },
  setup: { usage: "setup hooks", summary: "install the SessionStart hook for Claude Code, Codex, OpenCode", help: SETUP_HELP, run: setupCommand },
};

export function topLevelHelp(): string {
  const cmds = Object.values(COMMANDS);
  return `usage: mikrotik-axi <command> [args] [flags]
description: ${DESCRIPTION}
commands[${cmds.length}]:
${cmds.map((c) => `  ${c.usage}: ${c.summary}`).join("\n")}
flags[6]:
  --confirm: apply a WRITE command (without it every write is a dry-run)
  --device <name>: device from the profile (default: profile default)
  --profile <path>: profile file (default: MIKROTIK_AXI_PROFILE, then the user config dir)
  --fields a,b: only these output columns
  --full: no row limit, no text truncation
  --no-identity-check: skip the identity name comparison (read commands only)
env[5]:
  MIKROTIK_AXI_USER / MIKROTIK_AXI_PASS: credentials (or names set in profile credential_env)
  MIKROTIK_AXI_ENV_FILE: private .env file to read credentials from
  MIKROTIK_AXI_PROFILE: profile path
  MIKROTIK_AXI_READ_ONLY=1: refuse every write
  MIKROTIK_AXI_HOOK_DIRS: dirs where the session hook prints (see setup --help)
help[2]:
  Run \`mikrotik-axi\` with no arguments for the home view
  Run \`mikrotik-axi <command> --help\` for command details
`;
}
