import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fail } from "../errors.js";
import { RULE_IDS } from "../checks/index.js";
import type { Env } from "./env.js";


export interface DeviceProfile {
  url: string;
  expect_identity?: string;
  tls?: { self_signed_pin_sha256?: string };
  credential_env?: { user: string; pass: string };
  /**
   * Credential cho lệnh GHI (user có policy `write`). Lệnh đọc và hook không bao giờ dùng nó
   * ⇒ quyền ghi chỉ có mặt khi thật sự ghi. Vắng ⇒ lệnh ghi dùng `credential_env`.
   */
  credential_env_write?: { user: string; pass: string };
  /** Nhãn cho cổng vật lý mang PPPoE: { "ether1": "Line 1" }. Quan hệ cổng↔phiên do tool tự suy. */
  line_map?: Record<string, string>;
  expect?: { pppoe_running?: number; main_default_gateway?: string };
  protected?: { nat_dst_ports?: number[]; comment_prefixes?: string[] };
  timeout_ms?: number;
  /** Tắt luật kiểm theo id (§7), ví dụ ["zero-hit", "version"]. */
  alerts?: { disabled?: string[] };
}

export interface Profile {
  default?: string;
  devices: Record<string, DeviceProfile>;
}

export interface LoadedProfile {
  path: string;
  profile: Profile;
}

export const DEFAULT_CREDENTIAL_ENV = { user: "MIKROTIK_AXI_USER", pass: "MIKROTIK_AXI_PASS" } as const;

/** Thứ tự tìm: --profile → MIKROTIK_AXI_PROFILE → %APPDATA%\mikrotik-axi / ~/.config/mikrotik-axi. */
export function profilePath(flag: string | undefined, env: Env, platform = process.platform): string {
  if (flag) return flag;
  if (env["MIKROTIK_AXI_PROFILE"]) return env["MIKROTIK_AXI_PROFILE"];
  if (platform === "win32") {
    return join(env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), "mikrotik-axi", "profile.json");
  }
  return join(env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "mikrotik-axi", "profile.json");
}

export function loadProfile(path: string): LoadedProfile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      fail(`no profile found at ${path}`, "CONFIG_ERROR", [
        "Copy profiles/example.json from the mikrotik-axi package to that path and edit it",
        "Or pass --profile <path>, or set MIKROTIK_AXI_PROFILE",
      ]);
    }
    fail(`cannot read profile ${path} (${code ?? "error"})`, "CONFIG_ERROR");
  }
  let data: unknown;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); // bỏ BOM (Notepad)
  } catch (e) {
    fail(`profile ${path} is not valid JSON: ${(e as Error).message}`, "CONFIG_ERROR");
  }
  return { path, profile: validateProfile(data, path) };
}

const DEVICE_KEYS = new Set([
  "url",
  "expect_identity",
  "tls",
  "credential_env",
  "credential_env_write",
  "line_map",
  "expect",
  "protected",
  "timeout_ms",
  "alerts",
]);

export function validateProfile(data: unknown, path = "profile", knownAlertIds: readonly string[] = RULE_IDS): Profile {
  const bad = (where: string, msg: string): never => fail(`invalid profile ${path}: ${where} ${msg}`, "CONFIG_ERROR");
  if (!isObject(data)) bad("root", "must be an object");
  const root = data as Record<string, unknown>;
  if (!isObject(root["devices"]) || Object.keys(root["devices"] as object).length === 0) {
    bad("devices", "must be a non-empty object");
  }
  const devices = root["devices"] as Record<string, unknown>;
  for (const [name, dev] of Object.entries(devices)) {
    const at = `devices.${name}`;
    if (!isObject(dev)) bad(at, "must be an object");
    const d = dev as Record<string, unknown>;
    for (const key of Object.keys(d)) {
      if (!DEVICE_KEYS.has(key)) bad(`${at}.${key}`, `is not a known key (known: ${[...DEVICE_KEYS].join(", ")})`);
    }
    if (typeof d["url"] !== "string" || !/^https?:\/\/[^/]+\/?$/.test(d["url"])) {
      bad(`${at}.url`, 'must be "http(s)://host[:port]"');
    }
    optString(d, "expect_identity", at, bad);
    if (d["tls"] !== undefined) {
      if (!isObject(d["tls"])) bad(`${at}.tls`, "must be an object");
      const pin = (d["tls"] as Record<string, unknown>)["self_signed_pin_sha256"];
      if (pin !== undefined && (typeof pin !== "string" || pin.replace(/[^0-9a-f]/gi, "").length !== 64)) {
        bad(`${at}.tls.self_signed_pin_sha256`, "must be a SHA-256 fingerprint (64 hex digits, colons allowed)");
      }
    }
    for (const key of ["credential_env", "credential_env_write"]) {
      if (d[key] === undefined) continue;
      const c = d[key] as Record<string, unknown>;
      if (!isObject(c) || typeof c["user"] !== "string" || typeof c["pass"] !== "string") {
        bad(`${at}.${key}`, 'must be { "user": "<ENV_NAME>", "pass": "<ENV_NAME>" }');
      }
    }
    if (d["line_map"] !== undefined && !isStringMap(d["line_map"])) bad(`${at}.line_map`, "must map port names to labels");
    if (d["expect"] !== undefined) {
      const e = d["expect"] as Record<string, unknown>;
      if (!isObject(e)) bad(`${at}.expect`, "must be an object");
      if (e["pppoe_running"] !== undefined && !Number.isInteger(e["pppoe_running"])) bad(`${at}.expect.pppoe_running`, "must be an integer");
      optString(e, "main_default_gateway", `${at}.expect`, bad);
    }
    if (d["protected"] !== undefined && !isObject(d["protected"])) bad(`${at}.protected`, "must be an object");
    if (d["alerts"] !== undefined) {
      const dis = isObject(d["alerts"]) ? (d["alerts"] as Record<string, unknown>)["disabled"] : null;
      if (dis !== undefined && !(Array.isArray(dis) && dis.every((x) => typeof x === "string" && knownAlertIds.includes(x)))) {
        bad(`${at}.alerts.disabled`, `must list alert ids from: ${knownAlertIds.join(", ")}`);
      }
    }
    if (d["timeout_ms"] !== undefined && !(Number.isInteger(d["timeout_ms"]) && (d["timeout_ms"] as number) > 0)) {
      bad(`${at}.timeout_ms`, "must be a positive integer");
    }
  }
  if (root["default"] !== undefined && (typeof root["default"] !== "string" || !(root["default"] in devices))) {
    bad("default", `must name one of: ${Object.keys(devices).join(", ")}`);
  }
  return data as Profile;
}

export function selectDevice(loaded: LoadedProfile, name: string | undefined): { name: string; device: DeviceProfile } {
  const { devices } = loaded.profile;
  const names = Object.keys(devices);
  const chosen = name ?? loaded.profile.default ?? (names.length === 1 ? names[0] : undefined);
  if (!chosen) {
    fail(`profile ${loaded.path} has several devices and no default`, "CONFIG_ERROR", [
      `Pass --device <${names.join("|")}> or set "default" in the profile`,
    ]);
  }
  const device = devices[chosen];
  if (!device) {
    fail(`unknown device: ${chosen}`, "VALIDATION_ERROR", [`Known devices: ${names.join(", ")}`]);
  }
  return { name: chosen, device };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringMap(v: unknown): boolean {
  return isObject(v) && Object.values(v).every((x) => typeof x === "string");
}

function optString(o: Record<string, unknown>, key: string, at: string, bad: (w: string, m: string) => never): void {
  if (o[key] !== undefined && typeof o[key] !== "string") bad(`${at}.${key}`, "must be a string");
}
