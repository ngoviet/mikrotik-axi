import { createHash } from "node:crypto";

// Làm sạch dữ liệu REST trước khi lưu làm fixture (§9.1). Fixture được commit (và repo sẽ public)
// ⇒ ngoài bí mật còn phải ẩn danh: IP công khai, MAC, hostname, user PPPoE.

const SECRET_KEY = /^(password|passwd|secret|.*-secret|key|private-key|passphrase|token|\.about)$/i;

export const isSecretKey = (k: string): boolean => SECRET_KEY.test(k);
const MASK = "***";

function h(s: string, n: number): string {
  return createHash("sha256").update(s).digest("hex").slice(0, n);
}

function isPrivateV4(a: number, b: number): boolean {
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||
    a === 0 ||
    a >= 224 ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0)
  );
}

/** IPv4 công khai → 203.0.113.x / 198.51.100.x (TEST-NET), ổn định theo hash. */
export function pseudonymizeIps(text: string): string {
  return text.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (m, a, b, c, d) => {
    const parts = [a, b, c, d].map(Number);
    if (parts.some((x) => x > 255) || isPrivateV4(parts[0]!, parts[1]!)) return m;
    const n = parseInt(h(m, 4), 16);
    return `${n % 2 ? "203.0.113" : "198.51.100"}.${(n % 254) + 1}`;
  });
}

function pseudoMac(mac: string): string {
  const x = h(mac.toUpperCase(), 10).toUpperCase();
  return `02:${x.slice(0, 2)}:${x.slice(2, 4)}:${x.slice(4, 6)}:${x.slice(6, 8)}:${x.slice(8, 10)}`;
}

/** Làm sạch một giá trị REST (record, mảng record hoặc dict singleton) của menu `menu`. */
export function sanitize(menu: string, data: unknown): unknown {
  if (Array.isArray(data)) return data.map((d) => sanitize(menu, d));
  if (data === null || typeof data !== "object") return data;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (typeof v !== "string") {
      out[k] = sanitize(menu, v);
      continue;
    }
    if (SECRET_KEY.test(k) && v !== "") out[k] = MASK;
    else if (k === "user" && menu.includes("pppoe")) out[k] = v ? MASK : v;
    else if (/mac-address|^mac$|active-mac-address|client-id/.test(k) && v) out[k] = pseudoMac(v);
    else if (/host-name|^hostname$/.test(k) && v) out[k] = `host-${h(v, 4)}`;
    else out[k] = pseudonymizeIps(v);
  }
  return out;
}
