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
  | "WRITE_REFUSED";

export function axiError(message: string, code: ErrorCode, help: string[] = []): AxiError {
  return new AxiError(message, code, help);
}

export function fail(message: string, code: ErrorCode, help: string[] = []): never {
  throw axiError(message, code, help);
}

export { AxiError };

const SECRET_KEYS = /("?(?:password|passwd|pass|secret|key|token|authorization)"?\s*[:=]\s*)("[^"]*"|[^\s,}&]+)/gi;

// Che bí mật trong chuỗi bất kỳ sẽ in ra (body lỗi từ router, URL…), rồi cắt ≤ max ký tự.
export function redact(text: string, max = 300): string {
  const masked = text.replace(SECRET_KEYS, (_m, k: string) => `${k}"***"`);
  return masked.length > max ? `${masked.slice(0, max)}…` : masked;
}
