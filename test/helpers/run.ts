import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/cli.js";
import type { Runtime } from "../../src/context.js";
import type { Transport } from "../../src/ros/transport.js";

export const CREDS = { user: "axi-ro", pass: "test-pass" };

export const TEST_PROFILE = {
  default: "ccr2004",
  devices: {
    ccr2004: {
      url: "https://192.168.100.1",
      expect_identity: "CCR2004",
      tls: { self_signed_pin_sha256: "AB".repeat(32) },
      line_map: { ether1: "Line 1", ether2: "Line 2", ether3: "Line 3", ether4: "Line 4", ether5: "Line 5" },
    },
    crs326: { url: "http://192.168.100.254", expect_identity: "CRS326" },
  },
};

export function writeProfile(profile: unknown = TEST_PROFILE): string {
  const p = join(mkdtempSync(join(tmpdir(), "mikrotik-axi-")), "profile.json");
  writeFileSync(p, JSON.stringify(profile));
  return p;
}

export interface RunResult {
  out: string;
  err: string;
  code: number;
}

/** Chạy CLI trong tiến trình với transport/env giả. Không chạm mạng hay profile thật. */
export async function runCli(
  argv: string[],
  opts: { transport?: Transport; env?: Record<string, string>; profile?: unknown; runtime?: Partial<Runtime> } = {},
): Promise<RunResult> {
  let out = "";
  let err = "";
  const runtime: Runtime = {
    env: {
      MIKROTIK_AXI_PROFILE: writeProfile(opts.profile),
      MIKROTIK_AXI_USER: CREDS.user,
      MIKROTIK_AXI_PASS: CREDS.pass,
      ...opts.env,
    },
    stderr: { write: (c: string) => (err += c) },
    ...(opts.transport ? { transport: opts.transport } : {}),
    ...opts.runtime,
  };
  process.exitCode = undefined;
  try {
    await main({ argv, stdout: { write: (c: string) => (out += c) }, runtime });
    return { out, err, code: Number(process.exitCode ?? 0) };
  } finally {
    process.exitCode = undefined;
  }
}
