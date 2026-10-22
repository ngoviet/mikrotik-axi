import { basename } from "node:path";
import { parseCommandArgs } from "../args.js";
import { selectDevice, loadProfile, profilePath } from "../config/profile.js";
import { effectiveEnv } from "../config/env.js";
import type { Runtime } from "../context.js";
import { fail } from "../errors.js";
import { encodeId } from "../ros/client.js";
import { toBool } from "../ros/normalize.js";
import { addOp, findMatching, opFromRevert, removeOp, type WriteOp } from "../write/ops.js";
import { assertNotProtected } from "../write/protected.js";
import { CONFIRM_FLAG, connectForWrite, runWrite } from "../write/run.js";
import { loadSnapshot } from "../write/snapshot.js";
import { readDefaultRoutes } from "./routes.js";

const WRITE_NOTE = "dry-run unless --confirm; verifies identity (never skippable), snapshots before writing, reads back, prints the revert command";

// ---------------------------------------------------------------- pppoe restart

export const PPPOE_HELP = `usage: mikrotik-axi pppoe restart <name> [--confirm]
description: Disable then re-enable one PPPoE client session; ${WRITE_NOTE}. Warns when the session carries the active main default route
examples[1]:
  mikrotik-axi pppoe restart pppoe-out17 --confirm
`;

/** Thời gian chờ phiên chạy lại sau khi bật (chỉ quan sát, không phải điều kiện thành công). */
export const RESTART_WAIT_MS = 15000;

export async function pppoeCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { positionals, global, flags } = parseCommandArgs("pppoe", args, CONFIRM_FLAG, 2);
  const [sub, name] = positionals;
  if (sub !== "restart" || !name) {
    fail("usage: mikrotik-axi pppoe restart <name>", "VALIDATION_ERROR", ["Run `mikrotik-axi wan` for session names"]);
  }
  const ctx = await connectForWrite(global, rt);
  const { client } = ctx;
  const menu = "/interface/pppoe-client";
  const [rows, routes] = await Promise.all([
    client.list(menu, { query: { name }, proplist: [".id", "name", "disabled", "running", "comment", "interface"] }),
    readDefaultRoutes(client),
  ]);
  const before = rows.find((r) => r["name"] === name);
  if (!before) fail(`no pppoe-client named ${name}`, "VALIDATION_ERROR", ["Run `mikrotik-axi wan` for session names"]);
  if (toBool(before["disabled"], "disabled")) {
    fail(`${name} is disabled: restart only applies to enabled sessions`, "VALIDATION_ERROR");
  }
  assertNotProtected(ctx.device, menu, before);
  const id = before[".id"] as string;
  const carriesMain = (routes.get("main") ?? []).some((r) => r.active && r.gateway === name);
  const waitMs = rt.restartWaitMs ?? RESTART_WAIT_MS;
  let runningAfter = false;

  const op: WriteOp = {
    command: `pppoe restart ${name}`,
    target: `${menu} ${id} (${name}, ${toBool(before["running"], "running") ? "running" : "not running"})`,
    changes: [`disabled: false → true → false`],
    steps: [
      { method: "PATCH", path: `${menu}/${encodeId(id)}`, body: { disabled: "true" } },
      { method: "PATCH", path: `${menu}/${encodeId(id)}`, body: { disabled: "false" } },
    ],
    warnings: carriesMain ? [`${name} carries the active main default route: Internet via table main drops until it reconnects`] : [],
    before,
    // Hoàn tác = bảo đảm phiên được BẬT lại (trường hợp bước bật hỏng giữa chừng).
    revert: { op: "set", menu, id, body: { disabled: "false" } },
    apply: async () => {
      await client.set(menu, id, { disabled: "true" });
      try {
        await client.set(menu, id, { disabled: "false" });
      } catch {
        // Một lần thử lại: phiên bị bỏ ở trạng thái TẮT là hậu quả tệ nhất của lệnh này.
        await new Promise((r) => setTimeout(r, 500));
        await client.set(menu, id, { disabled: "false" });
      }
    },
    verify: async () => {
      const deadline = Date.now() + waitMs;
      for (;;) {
        const now = (await client.list(menu, { query: { name }, proplist: ["name", "disabled", "running"] })).find((r) => r["name"] === name);
        if (!now || toBool(now["disabled"], "disabled")) return `${name} is still disabled`;
        runningAfter = toBool(now["running"], "running");
        if (runningAfter || Date.now() >= deadline) return null;
        await new Promise((r) => setTimeout(r, 1000));
      }
    },
    get verified() {
      return `disabled=false; running=${runningAfter}${runningAfter ? "" : ` after ${waitMs / 1000}s (still dialing: check \`mikrotik-axi wan\`)`}`;
    },
  };
  return runWrite(ctx, op, flags["confirm"] === true, rt);
}

// ---------------------------------------------------------------- arp flush

export const ARP_HELP = `usage: mikrotik-axi arp flush <address> [--confirm]
description: Remove the dynamic ARP entry of one address so the router re-resolves it (an ARP entry marked complete does not prove the device is alive); ${WRITE_NOTE}. Static entries are refused
`;

export async function arpCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { positionals, global, flags } = parseCommandArgs("arp", args, CONFIRM_FLAG, 2);
  const [sub, address] = positionals;
  if (sub !== "flush" || !address || !/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) {
    fail("usage: mikrotik-axi arp flush <ipv4-address>", "VALIDATION_ERROR");
  }
  const ctx = await connectForWrite(global, rt);
  const { client } = ctx;
  const menu = "/ip/arp";
  const rows = await findMatching(client, menu, { address });
  const before = rows[0] ?? null;
  if (before && !toBool(before["dynamic"], "dynamic")) {
    fail(`ARP entry for ${address} is static: flushing it would delete configuration`, "WRITE_REFUSED", [
      "Remove static ARP entries by hand on the router if that is really intended",
    ]);
  }
  const id = before?.[".id"] ?? "";
  const op: WriteOp = {
    command: `arp flush ${address}`,
    target: before ? `${menu} ${id} (${address} → ${before["mac-address"] ?? "?"} on ${before["interface"] ?? "?"})` : `${menu} ${address}`,
    ...(before ? {} : { noop: `no ARP entry for ${address}` }),
    changes: [`remove dynamic entry ${address}`],
    steps: [{ method: "DELETE", path: `${menu}/${encodeId(id)}` }],
    warnings: [],
    before,
    revert: { op: "none", reason: "dynamic ARP entries are re-learned automatically" },
    apply: () => client.remove(menu, id, { allowDynamic: true }),
    verify: async () => ((await findMatching(client, menu, { address })).some((r) => r[".id"] === id) ? "entry still present" : null),
    get verified() {
      return `entry ${id} removed (a new entry appears if the device answers ARP)`;
    },
  };
  return runWrite(ctx, op, flags["confirm"] === true, rt);
}

// ---------------------------------------------------------------- addr-list

export const ADDR_LIST_HELP = `usage: mikrotik-axi addr-list add <list> <address> [--comment c] [--confirm]
       mikrotik-axi addr-list remove <list> <address> [--confirm]
description: Add/remove ONE firewall address-list entry: the right way to match several addresses (src-address does not take comma lists); ${WRITE_NOTE}
`;

export async function addrListCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { positionals, global, flags } = parseCommandArgs(
    "addr-list",
    args,
    { ...CONFIRM_FLAG, comment: { type: "string", hint: "--comment <text>" } },
    3,
  );
  const [sub, list, address] = positionals;
  if ((sub !== "add" && sub !== "remove") || !list || !address) {
    fail("usage: mikrotik-axi addr-list add|remove <list> <address>", "VALIDATION_ERROR", ["Run `mikrotik-axi addr-list --help`"]);
  }
  // Một địa chỉ / CIDR / dải / tên miền — KHÔNG danh sách phẩy (bẫy #3).
  if (!/^[0-9A-Za-z.:/-]+$/.test(address)) {
    fail(`addr-list: one address, CIDR, range or DNS name per entry, got ${address}`, "VALIDATION_ERROR", [
      "Run the command once per address",
    ]);
  }
  const ctx = await connectForWrite(global, rt);
  const menu = "/ip/firewall/address-list";
  const command = `addr-list ${sub} ${list} ${address}`;
  const comment = typeof flags["comment"] === "string" ? flags["comment"] : undefined;
  const op =
    sub === "add"
      ? await addOp(ctx.client, ctx.device, { command, menu, body: { list, address, ...(comment ? { comment } : {}) }, match: { list, address } })
      : await removeOp(ctx.client, ctx.device, { command, menu, match: { list, address } });
  return runWrite(ctx, op, flags["confirm"] === true, rt);
}

// ---------------------------------------------------------------- revert

export const REVERT_HELP = `usage: mikrotik-axi revert <snapshot-file> [--confirm]
description: Undo a change recorded in a snapshot (path printed by every applied write). Targets the snapshot's device and refuses if its identity changed; the revert itself is ${WRITE_NOTE}
`;

export async function revertCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { positionals, global, flags } = parseCommandArgs("revert", args, CONFIRM_FLAG, 1);
  const file = positionals[0];
  if (!file) fail("usage: mikrotik-axi revert <snapshot-file>", "VALIDATION_ERROR");
  const snap = loadSnapshot(file);
  if (global.device && global.device !== snap.device) {
    fail(`snapshot belongs to device ${snap.device}, not ${global.device}`, "VALIDATION_ERROR");
  }
  // Kiểm sớm thiết bị có trong profile (thông điệp rõ hơn lỗi chung của connect).
  selectDevice(loadProfile(profilePath(global.profile, effectiveEnv(rt.env), rt.platform)), snap.device);
  const ctx = await connectForWrite({ ...global, device: snap.device }, rt);
  if (ctx.identity !== snap.identity) {
    fail(`identity changed: snapshot taken on "${snap.identity}", device now reports "${ctx.identity}"`, "IDENTITY_MISMATCH");
  }
  if (snap.revert.op === "none") {
    return { result: "nothing to revert", snapshot: file, reason: snap.revert.reason };
  }
  const op = await opFromRevert(ctx.client, ctx.device, snap.revert, `revert ${basename(file)}`);
  return { ...(await runWrite(ctx, op, flags["confirm"] === true, rt)), reverting: `${snap.command} (${snap.created})` };
}
