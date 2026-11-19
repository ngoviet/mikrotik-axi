import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Env } from "../config/env.js";
import { fail } from "../errors.js";
import type { RosRecord } from "../ros/normalize.js";
import { isSecretKey } from "../sanitize.js";
import type { RosBody } from "../ros/validate.js";

/** Cách hoàn tác một thay đổi — chỉ các phép đã có op tương ứng (write/ops.ts). */
export type RevertSpec =
  | { op: "set"; menu: string; id: string; body: RosBody }
  | { op: "add"; menu: string; body: RosBody; match: RosBody }
  | { op: "remove"; menu: string; match: RosBody }
  | { op: "none"; reason: string };

export interface Snapshot {
  version: 1;
  created: string;
  device: string;
  identity: string;
  url: string;
  command: string;
  /** Object TRƯỚC khi đổi (bí mật đã che). */
  before: RosRecord | null;
  revert: RevertSpec;
}

/** %LOCALAPPDATA%\mikrotik-axi\snapshots (Windows) / $XDG_STATE_HOME/mikrotik-axi/snapshots. */
export function snapshotRoot(env: Env, platform = process.platform): string {
  if (env["MIKROTIK_AXI_SNAPSHOT_DIR"]) return env["MIKROTIK_AXI_SNAPSHOT_DIR"];
  if (platform === "win32") return join(env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "mikrotik-axi", "snapshots");
  return join(env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "mikrotik-axi", "snapshots");
}

function scrub(r: RosRecord | null): RosRecord | null {
  if (!r) return r;
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, isSecretKey(k) && v ? "***" : v]));
}

export function saveSnapshot(root: string, snap: Omit<Snapshot, "version" | "created">, now = new Date()): string {
  const dir = join(root, snap.device);
  mkdirSync(dir, { recursive: true });
  const ts = now.toISOString().replace(/[:.]/g, "-");
  const slug = snap.command.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60);
  const path = join(dir, `${ts}_${slug}.json`);
  const full: Snapshot = { version: 1, created: now.toISOString(), ...snap, before: scrub(snap.before) };
  writeFileSync(path, `${JSON.stringify(full, null, 2)}\n`, { flag: "wx" });
  return path;
}

/**
 * Phép hoàn tác mà tool TỰ sinh — tệp snapshot là JSON sửa tay được, nên `revert` chỉ nhận đúng
 * các dạng này. Không có danh sách ⇒ `revert` thành lối ghi tuỳ ý vào menu bất kỳ (§3.2 cấm).
 * set: menu → các khoá body được phép. add/remove: chỉ address-list.
 */
const REVERTIBLE_SET: Record<string, readonly string[]> = {
  "/ip/firewall/filter": ["disabled"],
  "/ip/firewall/nat": ["disabled"],
  "/ip/firewall/mangle": ["disabled"],
  "/ip/firewall/raw": ["disabled"],
  "/interface/pppoe-client": ["disabled"],
  "/ip/dhcp-server/lease": ["address"],
};
const REVERTIBLE_LIST = "/ip/firewall/address-list";
const ROS_ID = /^\*[0-9A-Fa-f]+$/;

function stringBody(b: unknown, allowed?: readonly string[]): boolean {
  if (!b || typeof b !== "object" || Array.isArray(b)) return false;
  return Object.entries(b).every(([k, v]) => typeof v === "string" && !k.startsWith(".") && (!allowed || allowed.includes(k)));
}

function validRevert(r: unknown): r is RevertSpec {
  const x = r as Record<string, unknown> | undefined;
  switch (x?.["op"]) {
    case "none":
      return typeof x["reason"] === "string";
    case "set": {
      const keys = REVERTIBLE_SET[x["menu"] as string];
      return !!keys && typeof x["id"] === "string" && ROS_ID.test(x["id"]) && stringBody(x["body"], keys);
    }
    case "add":
      return x["menu"] === REVERTIBLE_LIST && stringBody(x["body"]) && stringBody(x["match"], ["list", "address"]);
    case "remove":
      return x["menu"] === REVERTIBLE_LIST && stringBody(x["match"], ["list", "address"]);
    default:
      return false;
  }
}

export function loadSnapshot(path: string): Snapshot {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    fail(`cannot read snapshot ${path}: ${(e as Error).message}`, "VALIDATION_ERROR");
  }
  const s = data as Partial<Snapshot>;
  if (s.version !== 1 || typeof s.device !== "string" || typeof s.identity !== "string" || !s.revert) {
    fail(`not a mikrotik-axi snapshot: ${path}`, "VALIDATION_ERROR");
  }
  if (!validRevert(s.revert)) {
    fail(`snapshot ${path} holds a revert this tool never produces: refusing (snapshots can be edited by hand)`, "VALIDATION_ERROR", [
      "Revertible: disabled on firewall rules / pppoe-client, address on DHCP leases, address-list add/remove",
    ]);
  }
  return s as Snapshot;
}
