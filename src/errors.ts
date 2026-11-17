import { AxiError } from "axi-sdk-js";

// Mã lỗi của tool. SDK chỉ map VALIDATION_ERROR → exit 2; mọi mã khác → exit 1.
export type ErrorCode =
  | "VALIDATION_ERROR"
  | "CONFIG_ERROR"
  | "AUTH_ERROR"
  | "UNREACHABLE"
  | "TIMEOUT"
  | "TLS_ERROR"
  | "NOT_ROUTEROS"
  | "IDENTITY_MISMATCH"
  | "ROS_ERROR"
  | "WRITE_REFUSED"
  | "SETUP_FAILED";

export function axiError(message: string, code: ErrorCode, help: string[] = []): AxiError {
  return new AxiError(message, code, help);
}

export function fail(message: string, code: ErrorCode, help: string[] = []): never {
  throw axiError(message, code, help);
}

export { AxiError };

const MASK = "***";

// URL có mật khẩu: scheme://user:pass@host ⇒ giữ scheme, user, host; che pass.
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/?#@:"'\\]*:)([^\s/?#@"'\\]+)@/gi;
// Header Authorization: giữ tên lược đồ (Bearer, Basic…), che phần chứng thực.
const AUTH_HEADER = /(\bauthorization\\?["']?\s*[:=]\s*\\?["']?\s*)(?:(bearer|basic|digest|token|apikey)\s+)?([^\s,;"'\\]+)/gi;
// "Bearer <token>" đứng riêng, không có chữ Authorization phía trước.
const BEARER = /(\bbearer\s+)([^\s,;"'\\*][^\s,;"'\\]*)/gi;
// khoá=giá trị / "khoá":"giá trị" / khoá: giá trị. Không neo đầu từ ⇒ bắt cả api_key, X-Auth-Key,
// client-secret, pre-shared-key, cfToken. Giá trị: trong nháy (kể cả nháy thoát \" của nguồn script)
// hoặc trần tới khoảng trắng / , ; & } ] (ranh giới trong query string, JSON, header gộp).
const SECRET_PAIR =
  /((?:password|passwd|passphrase|pass|pwd|secret|token|key)\\?["']?\s*[:=]\s*)(\\?"[^"\\]*(?:\\?")?|'[^']*'?|[^\s,;&"'}\]\\]+)/gi;

/** Che phần ruột của giá trị, giữ nguyên dấu nháy bao quanh. Giá trị rỗng giữ nguyên (rỗng là thông tin chẩn đoán). */
function maskValue(value: string): string {
  const m = /^(\\?["']?)([\s\S]*?)(\\?["']?)$/.exec(value);
  if (!m || m[2] === "") return value;
  return `${m[1]}${MASK}${m[3]}`;
}

/**
 * Che bí mật trong chuỗi tự do (dòng log router, body lỗi, URL…): mật khẩu trong URL, header
 * Authorization / Bearer, cặp password|passwd|secret|token|key = giá trị. Phần còn lại giữ nguyên
 * để vẫn chẩn đoán được. Chạy lại trên chuỗi đã che không đổi gì.
 */
export function maskSecrets(text: string): string {
  return text
    .replace(URL_PASSWORD, (_m, head: string) => `${head}${MASK}@`)
    .replace(AUTH_HEADER, (_m, head: string, scheme: string | undefined) => `${head}${scheme ? `${scheme} ` : ""}${MASK}`)
    .replace(BEARER, (_m, head: string) => `${head}${MASK}`)
    .replace(SECRET_PAIR, (_m, head: string, value: string) => `${head}${maskValue(value)}`);
}

// Che bí mật trong chuỗi bất kỳ sẽ in ra (body lỗi từ router, URL…), rồi cắt ≤ max ký tự.
export function redact(text: string, max = 300): string {
  const masked = maskSecrets(text);
  return masked.length > max ? `${masked.slice(0, max)}…` : masked;
}
