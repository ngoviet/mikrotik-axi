import type { GlobalFlags } from "./args.js";
import { effectiveEnv, readCredentials, type Env } from "./config/env.js";
import { DEFAULT_CREDENTIAL_ENV, loadProfile, profilePath, selectDevice, type DeviceProfile } from "./config/profile.js";
import { RosClient } from "./ros/client.js";
import { verifyIdentity } from "./ros/guard.js";
import type { Transport } from "./ros/transport.js";

export const DEFAULT_TIMEOUT_MS = 5000;

/** Điểm tiêm phụ thuộc cho test (transport giả, env giả, stderr giả). */
export interface Runtime {
  env: Env;
  transport?: Transport;
  stderr: { write: (chunk: string) => unknown };
  platform?: NodeJS.Platform;
  /** Trần timeout mỗi request. */
  timeoutCapMs?: number;
  /** Hạn chót tuyệt đối cho mọi request (hook SessionStart: cả lượt phải xong trong 3 s). */
  deadlineAt?: number;
  /** setup hooks: đường dẫn bin hook + thư mục home/dự án (test tiêm vào). */
  hookBin?: string;
  homeDir?: string;
  projectDir?: string;
  /** pppoe restart: thời gian chờ phiên chạy lại (test đặt 0). */
  restartWaitMs?: number;
}

export const defaultRuntime = (): Runtime => ({ env: process.env, stderr: process.stderr });

export interface DeviceContext {
  name: string;
  device: DeviceProfile;
  client: RosClient;
  /** Identity đã xác minh (guard §5.1 chạy xong trước khi trả context). */
  identity: string;
  /** Mọi thiết bị trong profile (để gợi ý `devices`). */
  profileDevices: string[];
}

/** Bước 1 — chỉ cấu hình, không mạng: profile + credential + client. */
export interface OpenOptions {
  /** Lệnh ghi ⇒ dùng `credential_env_write` nếu profile có (quyền ghi chỉ xuất hiện khi ghi). */
  write?: boolean;
}

export function openDevice(flags: GlobalFlags, rt: Runtime, opts: OpenOptions = {}): Omit<DeviceContext, "identity"> {
  const env = effectiveEnv(rt.env);
  const loaded = loadProfile(profilePath(flags.profile, env, rt.platform));
  const { name, device } = selectDevice(loaded, flags.device);
  const names = (opts.write && device.credential_env_write) || device.credential_env || DEFAULT_CREDENTIAL_ENV;
  const creds = readCredentials(env, names, name);
  if (device.url.startsWith("http://")) {
    // Basic auth qua http = mật khẩu base64 trên LAN. Nhắc mỗi lần, ra stderr (stdout dành cho agent).
    rt.stderr.write(`warning: plaintext credentials to ${name} (use https)\n`);
  }
  const client = new RosClient(
    {
      name,
      url: device.url,
      user: creds.user,
      pass: creds.pass,
      timeoutMs: Math.min(device.timeout_ms ?? DEFAULT_TIMEOUT_MS, rt.timeoutCapMs ?? Infinity),
      ...(device.tls?.self_signed_pin_sha256 ? { tlsPin: device.tls.self_signed_pin_sha256 } : {}),
      ...(rt.deadlineAt !== undefined ? { deadlineAt: rt.deadlineAt } : {}),
    },
    rt.transport,
    env as NodeJS.ProcessEnv,
  );
  return { name, device, client, profileDevices: Object.keys(loaded.profile.devices) };
}

/** Bước 2 — identity guard. Lệnh đọc được phép --no-identity-check; lệnh ghi thì không. */
export async function connect(flags: GlobalFlags, rt: Runtime, opts: OpenOptions = {}): Promise<DeviceContext> {
  const ctx = openDevice(flags, rt, opts);
  const identity = await verifyIdentity(ctx.client, {
    ...(ctx.device.expect_identity ? { expectIdentity: ctx.device.expect_identity } : {}),
    skipNameCheck: flags.noIdentityCheck,
  });
  return { ...ctx, identity };
}
