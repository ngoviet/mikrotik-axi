import type { RosRecord } from "../ros/normalize.js";
import { toBool, toNumber } from "../ros/normalize.js";

// Phân tích thuần trên danh sách rule (thứ tự REST = thứ tự xử lý = số `#` của `print`).

export interface RuleRef {
  idx: number;
  chain: string;
  comment: string;
}

const enabled = (r: RosRecord) => !toBool(r["disabled"], "disabled");
const ref = (r: RosRecord, idx: number): RuleRef => ({ idx, chain: r["chain"] ?? "?", comment: r["comment"] ?? "" });

/**
 * mss-order: `accept` trong mangle DỪNG xử lý chain đó ⇒ `change-mss` đứng sau `accept` đầu tiên
 * CÙNG chain không bao giờ chạy (hiện trạng: 120 rule TRF-* accept, change-mss phải ở trước).
 */
export function mssAfterAccept(mangle: RosRecord[]): Array<RuleRef & { firstAccept: number }> {
  const firstAccept = new Map<string, number>();
  const out: Array<RuleRef & { firstAccept: number }> = [];
  mangle.forEach((r, idx) => {
    if (!enabled(r)) return;
    const chain = r["chain"] ?? "?";
    if (r["action"] === "accept" && !firstAccept.has(chain)) firstAccept.set(chain, idx);
    const acc = firstAccept.get(chain);
    if (r["action"] === "change-mss" && acc !== undefined && acc < idx) out.push({ ...ref(r, idx), firstAccept: acc });
  });
  return out;
}

/** mss-raise: `new-mss=<số>` mà thiếu `tcp-mss=<n+1>-65535` sẽ NÂNG MSS nhỏ hơn (Google 1412 → 1452). */
export function mssRaise(mangle: RosRecord[]): Array<RuleRef & { newMss: string }> {
  return mangle.flatMap((r, idx) =>
    enabled(r) && r["action"] === "change-mss" && /^\d+$/.test(r["new-mss"] ?? "") && !r["tcp-mss"]
      ? [{ ...ref(r, idx), newMss: r["new-mss"] as string }]
      : [],
  );
}

/** dup-mark: `mark-routing` trùng (chain + nguồn + mark) — ví dụ Mark-V239 ×2. */
export function duplicateMarks(mangle: RosRecord[]): Array<{ key: string; label: string; idx: number[] }> {
  const groups = new Map<string, { label: string; idx: number[] }>();
  mangle.forEach((r, idx) => {
    if (!enabled(r) || r["action"] !== "mark-routing") return;
    const src = r["src-address"] || (r["src-address-list"] ? `list:${r["src-address-list"]}` : "");
    const key = `${r["chain"]}|${src}|${r["new-routing-mark"]}`;
    const g = groups.get(key) ?? { label: r["comment"] || `${src} → ${r["new-routing-mark"]}`, idx: [] };
    g.idx.push(idx);
    groups.set(key, g);
  });
  return [...groups.entries()].filter(([, g]) => g.idx.length > 1).map(([key, g]) => ({ key, ...g }));
}

/** Khoá nhóm theo comment: bỏ số đuôi — "TRF-grass-po12" → "TRF-grass-po*", "FARM-SNAT-3" → "FARM-SNAT-*". */
export function commentGroup(comment: string | undefined): string {
  if (!comment) return "(no comment)";
  const stem = comment.replace(/\d+$/, "");
  return stem === comment ? comment : `${stem}*`;
}

/** zero-hit: nhóm rule (theo comment) mà MỌI rule bật đều 0 packet. Bỏ rule động. */
export function zeroHitGroups(tables: Record<string, RosRecord[]>): Array<{ group: string; table: string; count: number }> {
  const out: Array<{ group: string; table: string; count: number }> = [];
  for (const [table, rules] of Object.entries(tables)) {
    const groups = new Map<string, { zero: number; total: number; first: string }>();
    for (const r of rules) {
      if (!enabled(r) || toBool(r["dynamic"], "dynamic")) continue;
      const g = commentGroup(r["comment"]);
      const e = groups.get(g) ?? { zero: 0, total: 0, first: r["comment"] ?? "" };
      e.total++;
      if ((toNumber(r["packets"]) ?? 0) === 0) e.zero++;
      groups.set(g, e);
    }
    for (const [group, e] of groups) {
      // Rule không comment không cùng "nhóm" thật ⇒ đếm từng rule 0 packet.
      if (group === "(no comment)") {
        if (e.zero) out.push({ group, table, count: e.zero });
      } else if (e.zero === e.total) {
        // Nhóm chỉ 1 rule ⇒ in nguyên comment ("…192.168.10.0", không phải "…192.168.10.*").
        out.push({ group: e.total === 1 ? e.first : group, table, count: e.total });
      }
    }
  }
  return out.sort((a, b) => b.count - a.count || a.group.localeCompare(b.group));
}
