import { fail } from "../errors.js";

export function percent(n: number | undefined): string {
  return n === undefined ? "n/a" : `${Math.round(n)}%`;
}

export function bytes(n: number | undefined): string {
  if (n === undefined) return "n/a";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}

/** So sánh tự nhiên: ether2 < ether10, pppoe-out9 < pppoe-out10. */
export const naturalCompare = (a: string, b: string): number =>
  a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });

/** Thông điệp lỗi gọn cho một section hỏng (không làm hỏng cả view). */
export function unavailable(e: unknown): string {
  return `unavailable (${e instanceof Error ? e.message : String(e)})`;
}

export function selectFields<T extends Record<string, unknown>>(out: T, fields: string[] | undefined): Partial<T> {
  if (!fields?.length) return out;
  const unknown = fields.filter((f) => !(f in out));
  if (unknown.length) {
    fail(`unknown field: ${unknown.join(", ")}`, "VALIDATION_ERROR", [`Available fields: ${Object.keys(out).join(", ")}`]);
  }
  return Object.fromEntries(fields.map((f) => [f, out[f]])) as Partial<T>;
}
