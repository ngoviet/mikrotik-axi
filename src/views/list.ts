import { fail } from "../errors.js";
import type { GlobalFlags } from "../args.js";

export const DEFAULT_LIMIT = 50;
export const TEXT_LIMIT = 60;

export type Cell = string | number | boolean;
export type Row = Record<string, Cell>;

export interface ListSpec {
  /** Khoá TOON của bảng, ví dụ "sessions", "rules". */
  key: string;
  rows: Row[];
  /** Cột mặc định (gọn). --fields chọn trong `available`. */
  fields: readonly string[];
  available: readonly string[];
  /** Lệnh để gợi ý "xem hết", ví dụ "mikrotik-axi fw mangle". */
  command: string;
  /** Cột văn bản dài bị cắt TEXT_LIMIT ký tự trừ khi --full. */
  textFields?: readonly string[];
  limit?: number;
}

/**
 * Bảng theo quy ước AXI: mặc định cột gọn + ≤ 50 dòng; dài hơn ⇒ `count: 50 of 211 total` và
 * help cách xem hết (không mã hoá phân trang vào header TOON). --full bỏ mọi giới hạn.
 */
export function renderList(spec: ListSpec, flags: GlobalFlags): { out: Record<string, unknown>; help: string[] } {
  const fields = flags.fields?.length ? flags.fields : spec.fields;
  assertFields(fields, spec.available);
  const limit = flags.full ? Infinity : (spec.limit ?? DEFAULT_LIMIT);
  const shown = spec.rows.slice(0, limit).map((r) => {
    const o: Row = {};
    for (const f of fields) {
      const v = r[f] ?? "";
      o[f] = !flags.full && spec.textFields?.includes(f) && typeof v === "string" ? clip(v, TEXT_LIMIT) : v;
    }
    return o;
  });
  const total = spec.rows.length;
  const out: Record<string, unknown> = {
    count: shown.length < total ? `${shown.length} of ${total} total` : total,
  };
  out[spec.key] = shown;
  const help: string[] = [];
  if (shown.length < total) help.push(`Run \`${spec.command} --full\` to list all ${total}`);
  if (total === 0) out[spec.key] = `0 ${spec.key} found`;
  return { out, help };
}

/** Kiểm --fields TRƯỚC khi gọi mạng (lỗi dùng sai không nên tốn một lượt REST). */
export function assertFields(fields: readonly string[] | undefined, available: readonly string[]): void {
  const unknown = (fields ?? []).filter((f) => !available.includes(f));
  if (unknown.length) {
    fail(`unknown field: ${unknown.join(", ")}`, "VALIDATION_ERROR", [`Available fields: ${available.join(", ")}`]);
  }
}

export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Đếm theo khoá, trả "a 3, b 2" theo số giảm dần. */
export function countBy<T>(items: T[], key: (t: T) => string, top = Infinity): string {
  const m = new Map<string, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
}
