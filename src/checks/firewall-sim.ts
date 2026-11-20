import { toBool, type RosRecord } from "../ros/normalize.js";

// Mô phỏng chain `input` (IPv4) cho MỘT gói giả định: truy vấn DNS MỚI (UDP, cổng đích 53) từ Internet,
// đi vào qua một interface WAN, đích là chính router.
//
// Lịch sử (review độc lập 2026-11-21):
// - Bản 1 so "có rule drop nào không lọc cổng" ⇒ drop `in-interface-list=LAN` bị coi là chặn WAN.
// - Bản 2 đoán WAN theo TÊN list (/wan/, /lan/) ⇒ báo "đã chặn" sai: list `WAN2` (WAN khác vẫn mở),
//   `ISP_VLAN` ("VLAN" chứa "lan"), rule `invalid`. "Đã chặn" sai là lỗi tệ nhất của một luật bảo mật.
// - Bản 3: WAN = interface mang route mặc định (cổng ra thật, `immediate-gw`); thành viên list tính từ
//   `/interface/list/member` (+ include/exclude); mô phỏng RIÊNG cho từng interface WAN. Không đoán theo tên.
//   Mỗi điều kiện ra yes/no/maybe; chỉ "closed" khi mọi nhánh có thể của mọi WAN đều drop.
// - Bản 4 (review vòng 3): thứ tự include → exclude → thành viên tĩnh đúng manual; list dựng sẵn nhận theo
//   tên; route chưa rõ cổng ra ⇒ không kết luận closed; nguồn 10/8, 172.16/12 không còn bị coi là "nội bộ".
// - Bản 5 (review vòng 4): `port` khớp cổng nguồn HOẶC đích (nguồn do kẻ gửi chọn ⇒ maybe); mọi next-hop
//   ECMP là WAN; route blackhole không phải WAN; `connection-nat-state=dstnat` ⇒ maybe.
// Phạm vi của "closed": chỉ trong mô hình này — UDP/53, IPv4, chain input, không lần theo jump, nguồn
// 192.168/16 coi là nội bộ. Ngoài phạm vi đó luật không kết luận được gì.

export type Match = "yes" | "no" | "maybe";

/** Trường không phải điều kiện khớp gói. Trường lạ khác ⇒ điều kiện chưa đánh giá được (maybe). */
const NEUTRAL = new Set([".id", "chain", "action", "disabled", "comment", "bytes", "packets", "dynamic", "log", "log-prefix", "reject-with", "jump-target", ".nextid"]);

const TERMINAL_OPEN = new Set(["accept", "return"]); // return ở chain gốc = policy accept
const TERMINAL_CLOSED = new Set(["drop", "reject", "tarpit"]);

const enabled = (r: RosRecord) => !toBool(r["disabled"], "disabled");

function negated(v: string): { neg: boolean; val: string } {
  return v.startsWith("!") ? { neg: true, val: v.slice(1) } : { neg: false, val: v };
}

function flip(m: Match, neg: boolean): Match {
  if (!neg || m === "maybe") return m;
  return m === "yes" ? "no" : "yes";
}

function portMatch(spec: string, n: number): Match {
  const { neg, val } = negated(spec);
  const hit = val.split(",").some((p) => {
    const [a, b] = p.split("-").map(Number);
    return a !== undefined && (b === undefined ? n === a : n >= a && n <= b);
  });
  return flip(hit ? "yes" : "no", neg);
}

/** Một IPv4 CIDR/địa chỉ nằm TRỌN trong các dải cho trước. Dạng khác (dải a-b, IPv6, tên) ⇒ false. */
function within(spec: string, ranges: ReadonlyArray<readonly [number, number, number]>): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(spec.trim());
  if (!m) return false;
  const oct = [m[1], m[2], m[3], m[4]].map(Number);
  const len = m[5] === undefined ? 32 : Number(m[5]);
  if (oct.some((x) => x > 255) || len > 32) return false;
  const ip = ((oct[0]! << 24) >>> 0) + (oct[1]! << 16) + (oct[2]! << 8) + oct[3]!;
  // Prefix của spec phải dài ít nhất bằng của dải (172.0.0.0/8 không nằm trọn trong 172.16/12).
  return ranges.some(([base, mask, minLen]) => len >= minLen && (ip & mask) >>> 0 === base);
}

const R = (a: number, b: number, len: number): readonly [number, number, number] => {
  const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
  // `&` của JS trả số 32 bit CÓ DẤU ⇒ ép về không dấu, nếu không 172.16/12 và 192.168/16 không bao giờ khớp.
  return [((((a << 24) >>> 0) + (b << 16)) & mask) >>> 0, mask, len] as const;
};
/**
 * Nguồn coi như KHÔNG tới từ Internet: 192.168/16 và 127/8. Gói giả mạo nguồn đó thì câu trả lời đi về
 * LAN/loopback chứ không về kẻ gửi, nên không thành open resolver/khuếch đại. KHÔNG gồm 10/8, 172.16/12,
 * 100.64/10: nhà mạng dùng các dải này cho thuê bao CGNAT ⇒ gói THẬT từ thuê bao khác có thể tới qua WAN
 * và nhận được trả lời (review vòng 3, 2026-11-21).
 */
const NEVER_FROM_WAN = [R(192, 168, 16), R(127, 0, 8)];
const LOOPBACK = [R(127, 0, 8)];

export const neverFromWan = (spec: string): boolean => within(spec, NEVER_FROM_WAN);

/** Một interface có thuộc một interface list không: yes / no / maybe. */
export type ListMembers = (list: string, iface: string) => Match;

/** OR ba giá trị: có yes ⇒ yes; không yes mà có maybe ⇒ maybe; rỗng hoặc toàn no ⇒ no. */
function anyOf(ms: Match[]): Match {
  return ms.includes("yes") ? "yes" : ms.includes("maybe") ? "maybe" : "no";
}

/**
 * Thành viên theo đúng thứ tự của CLI reference `/interface/list` (manual.mikrotik.com, đọc 2026-11-21):
 * "Include members are added to the interface list. Exclude members are removed from the list.
 * Statically configured members are added to the list." ⇒ entry ở `/interface/list/member` được thêm SAU
 * bước exclude, nên exclude không trừ được nó (bản trước trừ ⇒ "closed" sai, review vòng 3).
 * List dựng sẵn nhận theo TÊN ("Predefined lists include all, none, dynamic, and static"), không theo trường
 * `builtin` (REST có thể không trả). `dynamic`/`static` cần cờ dynamic của từng interface (không đọc) ⇒
 * maybe; list không có trong dữ liệu, vòng include ⇒ maybe.
 */
export function listResolver(lists: RosRecord[], members: RosRecord[]): ListMembers {
  const byName = new Map(lists.map((l) => [l["name"] ?? "", l]));
  const direct = new Map<string, Set<string>>();
  for (const m of members) {
    if (!enabled(m)) continue;
    const l = m["list"] ?? "";
    if (!direct.has(l)) direct.set(l, new Set());
    direct.get(l)!.add(m["interface"] ?? "");
  }
  const memberOf = (name: string, iface: string, seen: ReadonlySet<string>): Match => {
    if (name === "all") return "yes";
    if (name === "none") return "no";
    if (name === "dynamic" || name === "static") return "maybe";
    if (seen.has(name)) return "maybe";
    const l = byName.get(name);
    if (!l && !direct.has(name)) return "maybe";
    if (direct.get(name)?.has(iface)) return "yes";
    const next = new Set(seen).add(name);
    const names = (k: string) =>
      (l?.[k] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const inc = anyOf(names("include").map((i) => memberOf(i, iface, next)));
    if (inc === "no") return "no";
    const exc = anyOf(names("exclude").map((e) => memberOf(e, iface, next)));
    if (exc === "yes") return "no";
    return inc === "yes" && exc === "no" ? "yes" : "maybe";
  };
  return (name, iface) => memberOf(name, iface, new Set());
}

function condition(key: string, value: string, wan: string, members: ListMembers): Match {
  const { neg, val } = negated(value);
  switch (key) {
    case "connection-state":
      return flip(val.split(",").includes("new") ? "yes" : "no", neg);
    case "connection-nat-state":
      // Gói mới tới router mang trạng thái dstnat nếu một rule NAT (redirect / dst-nat cổng 53) đổi đích
      // của nó ⇒ không biết; srcnat không áp cho gói mới đi vào (review vòng 4: trước coi dstnat là "no").
      return flip(val.split(",").includes("dstnat") ? "maybe" : "no", neg);
    case "protocol":
      return flip(val === "udp" || val === "17" ? "yes" : "no", neg);
    case "dst-port":
      return portMatch(value, 53);
    case "port": {
      // CLI reference filter: `port` "Matches if any (source or destination) port matches". Cổng nguồn do
      // kẻ gửi chọn ⇒ 53 trong danh sách: khớp chắc (qua cổng đích); không có: tuỳ cổng nguồn ⇒ maybe
      // (review vòng 4: trước tính như dst-port ⇒ accept port=123 rồi drop cho "closed" sai).
      const hit53 = portMatch(val, 53) === "yes";
      return flip(hit53 ? "yes" : "maybe", neg);
    }
    case "in-interface":
      // all-ethernet / all-ppp / all-vlan…: nhóm đặc biệt ⇒ không đoán.
      if (val.startsWith("all-")) return "maybe";
      return flip(val === wan ? "yes" : "no", neg);
    case "in-interface-list":
      return flip(members(val, wan), neg);
    case "dst-address-type":
      return flip(val.split(",").includes("local") ? "yes" : "maybe", neg);
    case "dst-address":
      // Gói từ WAN có đích là địa chỉ của router trên WAN, không bao giờ là loopback. Defconf có
      // "accept to local loopback (for CAPsMAN)" dst-address=127.0.0.1 (review lần 2).
      return flip(val.split(",").every((s) => within(s, LOOPBACK)) ? "no" : "maybe", neg);
    case "src-address":
      // Xem NEVER_FROM_WAN. Đo CCR2004: `ALLOW_DNS_INPUT src-address=192.168.0.0/16` ⇒ không khớp.
      return flip(val.split(",").every(neverFromWan) ? "no" : "maybe", neg);
    default:
      return "maybe"; // src-address-list, in-bridge-port, limit, src-mac-address…: không đánh giá được
  }
}

function ruleMatch(r: RosRecord, wan: string, members: ListMembers): { m: Match; why?: string } {
  let m: Match = "yes";
  let why: string | undefined;
  for (const [k, v] of Object.entries(r)) {
    if (NEUTRAL.has(k) || k === "invalid" || v === undefined || v === "") continue;
    const c = condition(k, v, wan, members);
    if (c === "no") return { m: "no" };
    if (c === "maybe" && m === "yes") {
      m = "maybe";
      why = `${k}=${v}`;
    }
  }
  return { m, ...(why ? { why } : {}) };
}

export interface ChainVerdict {
  state: "open" | "closed" | "uncertain";
  /** Vị trí (1-based trong chain input, kể cả rule tắt) + comment; vắng = hết chain. */
  rule?: string;
  why?: string;
}

/**
 * Một interface WAN: duyệt chain input theo thứ tự (REST trả đúng thứ tự xử lý); hết chain ⇒ policy
 * accept. Rule `invalid=true` (RouterOS không áp dụng): drop/reject ⇒ bỏ qua (không được tính là chặn);
 * accept ⇒ coi là "có thể khớp" (không được dùng để kết luận "chặn").
 */
export function inputVerdict(filter: RosRecord[], wan: string, members: ListMembers): ChainVerdict {
  const outcomes = new Set<"open" | "closed">();
  let firstMaybe: { rule: string; why: string } | undefined;
  const chain = filter.filter((r) => r["chain"] === "input");
  for (let i = 0; i < chain.length; i++) {
    const r = chain[i]!;
    if (!enabled(r)) continue;
    const action = r["action"] ?? "accept";
    const invalid = toBool(r["invalid"], "invalid");
    const terminal = TERMINAL_OPEN.has(action) ? "open" : TERMINAL_CLOSED.has(action) ? "closed" : action === "jump" ? "jump" : undefined;
    if (!terminal) continue; // log, passthrough, add-*-to-address-list…: gói đi tiếp
    if (invalid && terminal === "closed") continue;
    const matched = ruleMatch(r, wan, members);
    let { m } = matched;
    let why = matched.why;
    if (m === "no") continue;
    if (invalid && m === "yes") {
      m = "maybe";
      why = "invalid=true";
    }
    const label = `#${i + 1}${r["comment"] ? ` "${r["comment"]}"` : ""}`;
    if (terminal === "jump") {
      // Không lần theo chain con: kết cục sau jump không biết được.
      return { state: "uncertain", rule: label, why: `jump to ${r["jump-target"] ?? "?"}` };
    }
    if (m === "yes") {
      outcomes.add(terminal);
      return outcomes.size > 1 ? { state: "uncertain", ...(firstMaybe ?? { rule: label, why: "" }) } : { state: terminal, rule: label };
    }
    outcomes.add(terminal);
    firstMaybe ??= { rule: label, why: why ?? "" };
  }
  outcomes.add("open"); // hết chain: policy accept
  return outcomes.size > 1 ? { state: "uncertain", ...firstMaybe! } : { state: "open" };
}

/** Interface WAN = cổng ra của mọi route mặc định đang bật; `unknown` = gateway của route chưa rõ cổng ra. */
export interface WanSet {
  interfaces: string[];
  unknown: string[];
}

export interface WanDnsVerdict extends ChainVerdict {
  /** Interface WAN mà kết luận dựa vào (interface mở/không chắc đầu tiên). */
  wan?: string;
  wans: number;
}

/**
 * Mọi interface WAN: một cái mở ⇒ open; không cái nào mở mà có cái không chắc ⇒ uncertain; còn lại
 * closed. Có route mặc định chưa rõ cổng ra ⇒ không được kết luận closed (interface đó chưa được xét;
 * review vòng 3). Không có WAN nào ⇒ uncertain.
 */
export function dnsFromWan(filter: RosRecord[], wan: WanSet, members: ListMembers): WanDnsVerdict {
  const wans = wan.interfaces.length;
  const unknownWhy = () =>
    `${wan.unknown.length} default route(s) with unknown egress interface (gateway ${wan.unknown.slice(0, 3).join(", ")}${wan.unknown.length > 3 ? ", …" : ""}) were not tested`;
  if (!wans) return { state: "uncertain", why: wan.unknown.length ? unknownWhy() : "no default route, so no upstream interface to test", wans: 0 };
  let uncertain: WanDnsVerdict | undefined;
  let closed: ChainVerdict | undefined;
  for (const w of wan.interfaces) {
    const v = inputVerdict(filter, w, members);
    if (v.state === "open") return { ...v, wan: w, wans };
    if (v.state === "uncertain") uncertain ??= { ...v, wan: w, wans };
    else closed ??= v;
  }
  if (uncertain) return uncertain;
  if (wan.unknown.length) return { state: "uncertain", why: unknownWhy(), wans };
  return { ...closed!, state: "closed", wans };
}
