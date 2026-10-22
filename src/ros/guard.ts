import { fail, redact } from "../errors.js";
import type { RosClient } from "./client.js";

export interface IdentityExpectation {
  expectIdentity?: string;
  /** --no-identity-check: chỉ cho lệnh đọc. Lệnh ghi luôn truyền false. */
  skipNameCheck: boolean;
}

const PROBE_TIMEOUT_MS = 5000;

/**
 * §5.1 — chạy trước MỌI lệnh. IP không phải danh tính: `192.168.10.1` từng là router ZTE
 * của mạng WiFi khác. Hai bước:
 *  1. Dò KHÔNG kèm credential: RouterOS REST luôn trả 401 + JSON {"error":401,…}. Thứ khác
 *     (404 HTML của ZTE…) ⇒ dừng, mật khẩu chưa từng được gửi đi.
 *  2. GET /system/identity có xác thực, so `name` với expect_identity.
 * Kết quả cache trên client trong một lần chạy.
 */
export function verifyIdentity(client: RosClient, expect: IdentityExpectation): Promise<string> {
  client.identityCheck ??= runCheck(client, expect);
  return client.identityCheck;
}

async function runCheck(client: RosClient, expect: IdentityExpectation): Promise<string> {
  const { name, url } = client.conn;
  const timeoutMs = Math.min(PROBE_TIMEOUT_MS, client.conn.timeoutMs);
  const probe = await client.raw("GET", "/system/identity", { auth: false, timeoutMs });
  if (!looksLikeRouterOsUnauthorized(probe.status, probe.headers["content-type"], probe.body)) {
    const server = probe.headers["server"];
    fail(
      `device at ${url} is not RouterOS (got HTTP ${probe.status}${server ? `, server "${redact(server, 80)}"` : ", no server header"})`,
      "NOT_ROUTEROS",
      [
        `Check routing to ${client.host}: another network may use the same subnet`,
        "Disconnect other network adapters (e.g. Wi-Fi) or use the router's management VLAN address",
      ],
    );
  }

  const ident = await client.single("/system/identity", { proplist: ["name"], timeoutMs });
  const identity = ident["name"];
  if (typeof identity !== "string" || identity === "") {
    fail(`device at ${url} returned no identity`, "NOT_ROUTEROS");
  }

  if (!expect.skipNameCheck) {
    if (!expect.expectIdentity) {
      fail(`device ${name} has no expect_identity in the profile (router reports "${identity}")`, "CONFIG_ERROR", [
        `Confirm this is the intended router, then set "expect_identity": "${identity}" for ${name}`,
      ]);
    }
    if (identity !== expect.expectIdentity) {
      fail(`identity mismatch at ${url}: expected "${expect.expectIdentity}", got "${identity}"`, "IDENTITY_MISMATCH", [
        `Check routing to ${client.host}: this address may reach a different router`,
        "Use --no-identity-check only for read commands, and only if you know why the name differs",
      ]);
    }
  }
  client.verified = { identity, strict: !expect.skipNameCheck };
  return identity;
}

function looksLikeRouterOsUnauthorized(status: number, contentType: string | undefined, body: string): boolean {
  if (status !== 401 || !contentType?.includes("application/json")) return false;
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return parsed.error === 401;
  } catch {
    return false;
  }
}
