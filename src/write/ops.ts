import type { DeviceProfile } from "../config/profile.js";
import { AxiError, fail } from "../errors.js";
import { assertNotDynamic, encodeId, type RosClient } from "../ros/client.js";
import { toBool, type RosRecord } from "../ros/normalize.js";
import { validateWrite, type RosBody } from "../ros/validate.js";
import { assertNotProtected } from "./protected.js";
import type { RevertSpec } from "./snapshot.js";

export interface Step {
  method: "PATCH" | "POST" | "DELETE";
  path: string;
  body?: RosBody;
}

/** Một thay đổi đã đọc xong trạng thái hiện tại (§6 bước 3), sẵn sàng plan/apply/verify. */
export interface WriteOp {
  command: string;
  target: string;
  /** Có giá trị ⇒ đã đúng trạng thái mong muốn: no-op, không snapshot (§6 bước 9). */
  noop?: string;
  changes: string[];
  steps: Step[];
  warnings: string[];
  before: RosRecord | null;
  revert: RevertSpec;
  apply: () => Promise<void>;
  /** null = khớp; chuỗi = mô tả lệch (§6 bước 7: "write did not take effect"). */
  verify: () => Promise<string | null>;
  /** Mô tả điều verify đã xác nhận, in khi thành công. */
  verified: string;
}

// Field chỉ-đọc / do router quản lý: không đưa vào body khi tái tạo object (revert của remove).
const READ_ONLY_KEYS = new Set(["dynamic", "creation-time", "invalid", "running", "packets", "bytes", "status", "complete"]);

const BOOLISH = /^(true|false|yes|no)$/i;
/** So sánh giá trị REST: "true"≡"yes", "false"≡"no"≡vắng mặt (với field kiểu bool). */
export function sameValue(a: string | undefined, b: string | undefined): boolean {
  if ((a === undefined || BOOLISH.test(a)) && (b === undefined || BOOLISH.test(b)) && (a ?? b) !== undefined) {
    return toBool(a) === toBool(b);
  }
  return (a ?? "") === (b ?? "");
}

export const describeBody = (b: RosBody): string =>
  Object.entries(b)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

function label(menu: string, r: RosRecord): string {
  const name = r["name"] ?? r["comment"] ?? r["address"] ?? "";
  return `${menu} ${r[".id"] ?? ""}${name ? ` (${name})` : ""}`;
}

async function getOrFail(client: RosClient, menu: string, id: string, listHint: string): Promise<RosRecord> {
  try {
    return await client.getById(menu, id);
  } catch (e) {
    if (e instanceof AxiError && /no such item|not found/i.test(e.message)) {
      fail(`${menu}: no entry with .id ${id}`, "VALIDATION_ERROR", [listHint]);
    }
    throw e;
  }
}

/** Tìm entry khớp mọi cặp field trong `match` (lọc cả phía router lẫn client). */
export async function findMatching(client: RosClient, menu: string, match: RosBody): Promise<RosRecord[]> {
  const rows = await client.list(menu, { query: match });
  return rows.filter((r) => Object.entries(match).every(([k, v]) => r[k] === v));
}

/** PATCH các field của một object theo `.id`. */
export async function setOp(
  client: RosClient,
  device: DeviceProfile,
  opts: { command: string; menu: string; id: string; desired: RosBody; listHint: string },
): Promise<WriteOp> {
  const { menu, id, desired } = opts;
  const before = await getOrFail(client, menu, id, opts.listHint);
  assertNotDynamic(menu, id, before); // báo ngay ở dry-run, không đợi tới lúc ghi
  assertNotProtected(device, menu, before);
  const diff: RosBody = {};
  const undo: RosBody = {};
  for (const [k, v] of Object.entries(desired)) {
    if (sameValue(before[k], v)) continue;
    diff[k] = v;
    undo[k] = before[k] ?? (BOOLISH.test(v) ? "false" : "");
  }
  validateWrite(menu, diff, { ...before, ...diff });
  const changes = Object.keys(diff).map((k) => `${k}: ${before[k] ?? "(unset)"} → ${diff[k]}`);
  return {
    command: opts.command,
    target: label(menu, before),
    ...(changes.length ? {} : { noop: `already ${describeBody(desired)}` }),
    changes,
    steps: [{ method: "PATCH", path: `${menu}/${encodeId(id)}`, body: diff }],
    warnings: [],
    before,
    revert: { op: "set", menu, id, body: undo },
    apply: () => client.set(menu, id, diff),
    verify: async () => {
      const after = await client.getById(menu, id);
      const bad = Object.entries(diff).filter(([k, v]) => !sameValue(after[k], v));
      return bad.length ? bad.map(([k, v]) => `${k} is ${after[k] ?? "(unset)"}, wanted ${v}`).join("; ") : null;
    },
    verified: describeBody(diff),
  };
}

/** Thêm object nếu chưa có entry khớp `match`. */
export async function addOp(
  client: RosClient,
  device: DeviceProfile,
  opts: { command: string; menu: string; body: RosBody; match: RosBody },
): Promise<WriteOp> {
  const { menu, body, match } = opts;
  validateWrite(menu, body);
  const existing = await findMatching(client, menu, match);
  assertNotProtected(device, menu, body);
  return {
    command: opts.command,
    target: `${menu} ${describeBody(match)}`,
    ...(existing.length ? { noop: `already present (${existing.map((e) => e[".id"]).join(", ")})` } : {}),
    changes: [`add ${describeBody(body)}`],
    steps: [{ method: "POST", path: `${menu}/add`, body }],
    warnings: [],
    before: null,
    revert: { op: "remove", menu, match },
    apply: async () => {
      await client.add(menu, body);
    },
    verify: async () => ((await findMatching(client, menu, match)).length ? null : "entry not found after add"),
    verified: `present: ${describeBody(match)}`,
  };
}

/** Xoá đúng MỘT entry khớp `match`. */
export async function removeOp(
  client: RosClient,
  device: DeviceProfile,
  opts: { command: string; menu: string; match: RosBody },
): Promise<WriteOp> {
  const { menu, match } = opts;
  const rows = await findMatching(client, menu, match);
  if (rows.length > 1) {
    fail(`${menu}: ${rows.length} entries match ${describeBody(match)}, refusing to guess`, "VALIDATION_ERROR");
  }
  const before = rows[0] ?? null;
  if (before) {
    assertNotDynamic(menu, before[".id"] ?? "?", before);
    assertNotProtected(device, menu, before);
  }
  const restore: RosBody = before
    ? Object.fromEntries(Object.entries(before).filter(([k]) => !k.startsWith(".") && !READ_ONLY_KEYS.has(k)))
    : {};
  const id = before?.[".id"] ?? "";
  return {
    command: opts.command,
    target: before ? label(menu, before) : `${menu} ${describeBody(match)}`,
    ...(before ? {} : { noop: `not present: ${describeBody(match)}` }),
    changes: [`remove ${describeBody(match)}`],
    steps: [{ method: "DELETE", path: `${menu}/${encodeId(id)}` }],
    warnings: [],
    before,
    revert: { op: "add", menu, body: restore, match },
    apply: () => client.remove(menu, id),
    verify: async () => ((await findMatching(client, menu, match)).length ? "entry still present after remove" : null),
    verified: `absent: ${describeBody(match)}`,
  };
}

/** Op tương ứng một RevertSpec (dùng cho `revert`). */
export function opFromRevert(client: RosClient, device: DeviceProfile, spec: Exclude<RevertSpec, { op: "none" }>, command: string): Promise<WriteOp> {
  switch (spec.op) {
    case "set":
      return setOp(client, device, { command, menu: spec.menu, id: spec.id, desired: spec.body, listHint: "The object may have been deleted since the snapshot" });
    case "add":
      return addOp(client, device, { command, menu: spec.menu, body: spec.body, match: spec.match });
    case "remove":
      return removeOp(client, device, { command, menu: spec.menu, match: spec.match });
  }
}
