import { readFileSync } from "node:fs";
import { fail } from "../errors.js";

export type Env = Readonly<Record<string, string | undefined>>;

/** Parser KEY=VALUE tối giản: bỏ dòng trống/#, hỗ trợ `export `, nháy đơn/kép bao ngoài. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = (m[2] ?? "").trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    out[m[1] as string] = value;
  }
  return out;
}

/**
 * Môi trường hiệu lực: process.env + file MIKROTIK_AXI_ENV_FILE (nếu có). File KHÔNG ghi đè
 * biến đã có. Không sửa process.env.
 */
export function effectiveEnv(env: Env = process.env): Env {
  const file = env["MIKROTIK_AXI_ENV_FILE"];
  if (!file) return env;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    fail(`cannot read MIKROTIK_AXI_ENV_FILE (${(e as NodeJS.ErrnoException).code ?? "error"}): ${file}`, "CONFIG_ERROR");
  }
  return { ...parseEnvFile(text), ...stripUndefined(env) };
}

function stripUndefined(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

export interface Credentials {
  user: string;
  pass: string;
}

export function readCredentials(env: Env, names: { user: string; pass: string }, device: string): Credentials {
  const user = env[names.user];
  const pass = env[names.pass];
  const missing = [!user && names.user, !pass && names.pass].filter(Boolean) as string[];
  if (missing.length) {
    fail(`credentials for ${device} missing: ${missing.join(", ")} not set`, "CONFIG_ERROR", [
      `Set ${missing.join(" and ")} in the environment, or point MIKROTIK_AXI_ENV_FILE at a private .env file`,
      "Use a dedicated read-only RouterOS user, never admin",
    ]);
  }
  return { user: user as string, pass: pass as string };
}
