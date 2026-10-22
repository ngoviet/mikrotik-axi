import { parseCommandArgs } from "../args.js";
import { connect, type Runtime } from "../context.js";
import { fail } from "../errors.js";
import { toBool, toNumber, type RosRecord } from "../ros/normalize.js";
import { bytes, naturalCompare } from "../views/format.js";
import { assertFields, renderList } from "../views/list.js";

export const VLANS_HELP = `usage: mikrotik-axi vlans [flags]
description: VLAN interfaces ordered by VLAN id, with their IP addresses
flags[3]:
  --fields a,b: columns name,vlan_id,address,running (also parent,disabled)
  --full: all rows
  --device <name>: device from the profile
`;

const VLAN_FIELDS = ["name", "vlan_id", "address", "running", "parent", "disabled"];

export async function vlansCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { global } = parseCommandArgs("vlans", args);
  assertFields(global.fields, VLAN_FIELDS);
  const ctx = await connect(global, rt);
  const [vlans, addrs] = await Promise.all([
    ctx.client.list("/interface/vlan", { proplist: ["name", "vlan-id", "interface", "running", "disabled"] }),
    ctx.client.list("/ip/address", { proplist: ["address", "interface", "disabled"] }),
  ]);
  const addrOf = groupAddresses(addrs);
  const rows = vlans
    .map((v) => ({
      name: v["name"] ?? "",
      vlan_id: toNumber(v["vlan-id"]) ?? 0,
      address: addrOf.get(v["name"] ?? "")?.join(" ") ?? "",
      running: toBool(v["running"], "running"),
      parent: v["interface"] ?? "",
      disabled: toBool(v["disabled"], "disabled"),
    }))
    .sort((a, b) => a.vlan_id - b.vlan_id || naturalCompare(a.name, b.name));
  const down = rows.filter((r) => !r.disabled && !r.running).map((r) => r.name);
  const { out, help } = renderList(
    { key: "vlans", rows, fields: ["name", "vlan_id", "address", "running"], available: VLAN_FIELDS, command: "mikrotik-axi vlans" },
    global,
  );
  return { down: down.length ? down.join(", ") : "none", ...out, ...(help.length ? { help } : {}) };
}

function groupAddresses(addrs: RosRecord[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const a of addrs) {
    if (toBool(a["disabled"], "disabled") || !a["interface"] || !a["address"]) continue;
    m.set(a["interface"], [...(m.get(a["interface"]) ?? []), a["address"]]);
  }
  return m;
}

// Tên loại cho người dùng → điều kiện trên /interface. SFP là type=ether nhưng tên sfp*.
const TYPES: Record<string, (r: RosRecord) => boolean> = {
  ether: (r) => r["type"] === "ether" && !(r["name"] ?? "").startsWith("sfp"),
  sfp: (r) => r["type"] === "ether" && (r["name"] ?? "").startsWith("sfp"),
  bridge: (r) => r["type"] === "bridge",
  vlan: (r) => r["type"] === "vlan",
  pppoe: (r) => r["type"] === "pppoe-out" || r["type"] === "pppoe-in",
  vrrp: (r) => r["type"] === "vrrp",
};

export const IFACE_HELP = `usage: mikrotik-axi iface [--type ${Object.keys(TYPES).join("|")}] [flags]
description: Interfaces with running state and byte counters (counters live on /interface, not on /interface/pppoe-client)
flags[4]:
  --type <t>: only ${Object.keys(TYPES).join(", ")}
  --fields a,b: columns name,type,running,rx (name,running,rx,tx with --type; also tx,disabled,comment,link_downs,rx_bytes,tx_bytes)
  --full: all rows
  --device <name>: device from the profile
`;

const IFACE_FIELDS = ["name", "type", "running", "rx", "tx", "disabled", "comment", "link_downs", "rx_bytes", "tx_bytes"];

export async function ifaceCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { global, flags } = parseCommandArgs("iface", args, { type: { type: "string", hint: "--type <t>" } });
  const type = typeof flags["type"] === "string" ? flags["type"] : undefined;
  if (type !== undefined && !TYPES[type]) {
    fail(`iface: unknown --type ${type}`, "VALIDATION_ERROR", [`Valid types: ${Object.keys(TYPES).join(", ")}`]);
  }
  assertFields(global.fields, IFACE_FIELDS);
  const ctx = await connect(global, rt);
  const all = await ctx.client.list("/interface", {
    proplist: ["name", "type", "running", "disabled", "rx-byte", "tx-byte", "comment", "link-downs"],
  });
  const rows = all
    .filter((r) => !type || TYPES[type]!(r))
    .map((r) => {
      const rx = toNumber(r["rx-byte"]) ?? 0;
      const tx = toNumber(r["tx-byte"]) ?? 0;
      return {
        name: r["name"] ?? "",
        type: r["type"] ?? "",
        running: toBool(r["running"], "running"),
        rx: bytes(rx),
        tx: bytes(tx),
        disabled: toBool(r["disabled"], "disabled"),
        comment: r["comment"] ?? "",
        link_downs: toNumber(r["link-downs"]) ?? 0,
        rx_bytes: rx,
        tx_bytes: tx,
      };
    })
    .sort((a, b) => naturalCompare(a.name, b.name));
  const down = rows.filter((r) => !r.disabled && !r.running).map((r) => r.name);
  const { out, help } = renderList(
    {
      key: "interfaces",
      rows,
      fields: type ? ["name", "running", "rx", "tx"] : ["name", "type", "running", "rx"],
      available: IFACE_FIELDS,
      command: `mikrotik-axi iface${type ? ` --type ${type}` : ""}`,
      textFields: ["comment"],
    },
    global,
  );
  return {
    ...(type ? { type } : {}),
    down: down.length ? `${down.length} (${down.slice(0, 8).join(", ")}${down.length > 8 ? ", …" : ""})` : "0",
    disabled: rows.filter((r) => r.disabled).length,
    ...out,
    ...(help.length || !type ? { help: [...help, ...(type ? [] : [`Filter with --type ${Object.keys(TYPES).join("|")}`])] } : {}),
  };
}
