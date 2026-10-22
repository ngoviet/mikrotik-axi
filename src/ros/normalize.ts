// REST của RouterOS trả MỌI giá trị là chuỗi, kể cả "true"/"false". Cấm Boolean(str):
// Boolean("false") === true. Trường vắng mặt (thường gặp với `disabled`) = false.

export type RosRecord = Record<string, string>;

export function toBool(value: string | undefined, field = "value"): boolean {
  if (value === undefined || value === "") return false;
  switch (value.trim().toLowerCase()) {
    case "true":
    case "yes":
      return true;
    case "false":
    case "no":
      return false;
    default:
      throw new Error(`unexpected boolean for ${field}: ${JSON.stringify(value)}`);
  }
}

export function toNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

const UNIT_SECONDS: Record<string, number> = { w: 604800, d: 86400, h: 3600, m: 60, s: 1, ms: 0.001, us: 1e-6 };

/** "1w2d3h4m5s", "5s200ms", "00:01:02", "1d00:01:02" → giây. Sai định dạng ⇒ undefined. */
export function parseDuration(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (v === "") return undefined;
  const clock = /^(?:(\d+)d)?(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(v);
  if (clock) {
    const [, d, h, m, s, frac] = clock;
    return Number(d ?? 0) * 86400 + Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(`0.${frac ?? 0}`);
  }
  const re = /(\d+(?:\.\d+)?)(ms|us|w|d|h|m|s)/g;
  let total = 0;
  let consumed = 0;
  for (const match of v.matchAll(re)) {
    const [whole, num, unit] = match;
    total += Number(num) * (UNIT_SECONDS[unit as string] ?? 0);
    consumed += whole.length;
  }
  return consumed === v.length && consumed > 0 ? total : undefined;
}

/** Giây → 2 đơn vị lớn nhất, gộp tuần vào ngày: 1058400 → "12d6h". */
export function formatDuration(seconds: number): string {
  const s = Math.floor(seconds);
  const parts: Array<[number, string]> = [
    [Math.floor(s / 86400), "d"],
    [Math.floor((s % 86400) / 3600), "h"],
    [Math.floor((s % 3600) / 60), "m"],
    [s % 60, "s"],
  ];
  const first = parts.findIndex(([n]) => n > 0);
  if (first === -1) return "0s";
  return parts
    .slice(first, first + 2)
    .filter(([n]) => n > 0)
    .map(([n, u]) => `${n}${u}`)
    .join("");
}

export type FieldType = "string" | "bool" | "number" | "duration";
export type Schema = Record<string, FieldType>;
type FieldValue<T extends FieldType> = T extends "bool"
  ? boolean
  : T extends "number" | "duration"
    ? number | undefined
    : string | undefined;
export type Normalized<S extends Schema> = { [K in keyof S]: FieldValue<S[K]> };

/** Chuyển kiểu một bản ghi REST theo schema field. Field ngoài schema bị bỏ. */
export function normalize<S extends Schema>(raw: RosRecord, schema: S): Normalized<S> {
  const out: Record<string, unknown> = {};
  for (const [field, type] of Object.entries(schema)) {
    const v = raw[field];
    out[field] =
      type === "bool" ? toBool(v, field) : type === "number" ? toNumber(v) : type === "duration" ? parseDuration(v) : v;
  }
  return out as Normalized<S>;
}
