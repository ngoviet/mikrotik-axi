import type { GlobalFlags } from "../args.js";
import { connect, type DeviceContext, type Runtime } from "../context.js";
import { effectiveEnv } from "../config/env.js";
import { AxiError, fail, type ErrorCode } from "../errors.js";
import { describeBody, type WriteOp } from "./ops.js";
import { saveSnapshot, snapshotRoot } from "./snapshot.js";

/** Flag riêng của lệnh ghi. */
export const CONFIRM_FLAG = { confirm: { type: "boolean", hint: "--confirm" } } as const;

/** §6 bước 1: identity guard KHÔNG bỏ qua được cho lệnh ghi. */
export async function connectForWrite(global: GlobalFlags, rt: Runtime): Promise<DeviceContext> {
  if (global.noIdentityCheck) {
    fail("--no-identity-check is not allowed for write commands", "VALIDATION_ERROR", [
      "Writes always verify the router identity; fix expect_identity in the profile instead",
    ]);
  }
  return connect(global, rt, { write: true });
}

/**
 * §6 bước 4–9 cho một op đã đọc trạng thái (bước 1–3 do người gọi làm):
 * no-op ⇒ exit 0 không snapshot; mặc định dry-run in plan; --confirm ⇒ snapshot → ghi →
 * đọc lại so sánh → in đường dẫn snapshot + lệnh revert.
 */
export async function runWrite(ctx: DeviceContext, op: WriteOp, confirm: boolean, rt: Runtime): Promise<Record<string, unknown>> {
  const env = effectiveEnv(rt.env);
  const readOnly = env["MIKROTIK_AXI_READ_ONLY"] === "1";
  const head = { device: `${ctx.name} (identity ${ctx.identity} verified)`, target: op.target };

  if (op.noop) return { result: "no-op", ...head, reason: op.noop };

  const steps = op.steps.map((s) => ({ method: s.method, path: s.path, body: s.body ? describeBody(s.body) : "" }));
  if (!confirm) {
    return {
      result: "dry-run (nothing changed)",
      ...head,
      changes: op.changes,
      steps,
      revert: describeRevert(op),
      ...(op.warnings.length ? { warnings: op.warnings } : {}),
      help: readOnly
        ? ["Writes are disabled here (MIKROTIK_AXI_READ_ONLY=1)"]
        : ["Run the same command with --confirm to apply"],
    };
  }

  if (readOnly) fail("writes are disabled (MIKROTIK_AXI_READ_ONLY=1)", "WRITE_REFUSED");

  // Snapshot TRƯỚC khi ghi: ghi hỏng giữa chừng vẫn có đường lui.
  const snapshot = saveSnapshot(snapshotRoot(env, rt.platform), {
    device: ctx.name,
    identity: ctx.identity,
    url: ctx.client.conn.url,
    command: op.command,
    before: op.before,
    revert: op.revert,
  });
  const revertHelp = `Run \`mikrotik-axi revert "${snapshot}" --confirm\` to undo`;
  try {
    await op.apply();
  } catch (e) {
    const code = (e instanceof AxiError ? e.code : "ROS_ERROR") as ErrorCode;
    const help = e instanceof AxiError ? [...e.suggestions] : [];
    if (code === "AUTH_ERROR") {
      help.push("Writes need a user with the `write` policy: set credential_env_write for this device in the profile");
    }
    fail(`write failed: ${(e as Error).message}`, code, [...help, `Snapshot taken before the attempt: ${snapshot}`, revertHelp]);
  }
  // Bẫy "thất bại im lặng" (vd. ghi `address` của /ip/service): luôn đọc lại.
  const mismatch = await op.verify();
  if (mismatch) {
    fail(`write did not take effect: ${mismatch}`, "ROS_ERROR", [`Snapshot: ${snapshot}`, revertHelp]);
  }
  return {
    result: "applied",
    ...head,
    changes: op.changes,
    verified: op.verified,
    ...(op.warnings.length ? { warnings: op.warnings } : {}),
    snapshot,
    help: [revertHelp],
  };
}

function describeRevert(op: WriteOp): string {
  const r = op.revert;
  switch (r.op) {
    case "set":
      return `set ${describeBody(r.body)} on ${r.menu} ${r.id}`;
    case "add":
      return `re-add ${describeBody(r.body)} to ${r.menu}`;
    case "remove":
      return `remove ${describeBody(r.match)} from ${r.menu}`;
    case "none":
      return `not revertible: ${r.reason}`;
  }
}
