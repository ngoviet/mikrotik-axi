import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Env } from "../config/env.js";

// Export cấu hình RouterOS (`/export terse`) lưu ra máy + so sánh hai bản. RouterOS KHÔNG tự giữ
// lịch sử cấu hình: thay đổi qua WinBox không để lại dấu vết ⇒ bản lưu trước là mốc duy nhất.

/** %LOCALAPPDATA%\mikrotik-axi\exports (Windows) / $XDG_STATE_HOME/mikrotik-axi/exports. */
export function exportRoot(env: Env, platform = process.platform): string {
  if (env["MIKROTIK_AXI_EXPORT_DIR"]) return env["MIKROTIK_AXI_EXPORT_DIR"];
  if (platform === "win32") return join(env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "mikrotik-axi", "exports");
  return join(env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "mikrotik-axi", "exports");
}

/** "/" ⇒ "all"; "/ip/firewall" ⇒ "ip-firewall" (đi vào tên file, dùng để tìm bản trước). */
export function sectionSlug(section: string): string {
  return section === "/" ? "all" : section.replace(/^\//, "").replace(/\//g, "-");
}

/**
 * Dòng lệnh của export, đã chuẩn hoá để băm/so: bỏ \r, nối dòng tiếp (`\` cuối dòng), bỏ dòng
 * chú thích `#` (giờ xuất, software id, model, serial — đổi mỗi lần hoặc là định danh máy) và dòng rỗng.
 * Export KHÔNG terse (dòng menu `/container envs` rồi các dòng `add …`) được đưa về dạng terse
 * (`/container envs add …`): so được với bản terse và mỗi dòng đều mang tên menu (review 2026-11-21:
 * dòng không mang menu làm nhánh che theo menu không chạy).
 */
export function commandLines(rsc: string): string[] {
  const out: string[] = [];
  let pending = "";
  let context = "";
  const emit = (line: string) => {
    if (line.trim() === "" || line.startsWith("#")) return;
    if (line.startsWith("/")) {
      // Dòng chỉ có đường dẫn menu (không động từ, không khoá=giá trị) ⇒ ngữ cảnh cho các dòng sau.
      const tokens = tokenizeLine(line);
      if (tokens.every((t) => !t.includes("=") && !VERB.test(t))) {
        context = line.trim();
        return;
      }
      out.push(line);
      return;
    }
    // Chỉ gắn ngữ cảnh cho dòng mở đầu bằng động từ (`add …`, `set …`). Dòng khác (mảnh thừa của một
    // dòng nối hỏng…) giữ nguyên ⇒ không phân tích được ⇒ không bao giờ in nội dung (redactLine).
    const first = line.trim().split(" ")[0] ?? "";
    out.push(context && VERB.test(first) ? `${context} ${line.trim()}` : line);
  };
  for (const raw of rsc.replace(/\r/g, "").split("\n")) {
    const line = pending ? pending + raw.trimStart() : raw;
    // Nối dòng = số dấu `\` cuối dòng LẺ (`\\` là một `\` đã thoát). Bản trước chỉ xét "kết thúc bằng
    // `\` mà không bằng `\\`" ⇒ `\\` + `\` nối (3 dấu) không được nối, đuôi giá trị thành dòng riêng
    // và in nguyên văn (review vòng 3, 2026-11-21).
    if ((line.length - line.replace(/\\+$/, "").length) % 2 === 1) {
      pending = line.slice(0, -1);
      continue;
    }
    pending = "";
    emit(line);
  }
  if (pending) emit(pending);
  return out;
}

const VERB = /^(add|set|remove|enable|disable)$/;

/** RouterOS version trong dòng đầu `# 2026-11-21 03:29:24 by RouterOS 7.25.1`. */
export function exportVersion(rsc: string): string | undefined {
  return /^# .* by RouterOS (\S+)/.exec(rsc)?.[1];
}

export function rscHash(lines: readonly string[]): string {
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/**
 * Trường chứa MÃ script: không che được bằng regex (bí mật nằm trong `:local pass "…"`, trong đường
 * dẫn URL `bot123:TOKEN/…`…) ⇒ không bao giờ in nội dung. Theo NHÓM, không theo danh sách tên (review
 * 2026-11-21 lần 2: danh sách cố định sót `on-master`, `on-backup`, `on-fail` của VRRP và
 * `binding-script` của DHCPv6): `source`, `script`, mọi `*-script`, mọi `on-*`.
 */
const CODE_KEY = /^(source|script|[a-z0-9-]+-script|on-[a-z0-9-]+)$/;
/** Giá trị tự do có thể là bí mật (lệnh container, biến môi trường, chuỗi AT `modem-init` mang PIN SIM…): che, không băm. */
const OPAQUE_KEY = /^(cmd|entrypoint|value|modem-init)$/;
/**
 * Họ khoá bí mật: che hẳn, không độ dài, không băm (băm một mật khẩu do người đặt ⇒ dò được bằng từ điển).
 * Review vòng 3: `secrets=` (/tool romon) và `pin=` (LTE) lọt qua `maskSecrets`.
 */
const SECRET_KEY =
  /^(([a-z0-9-]*-)?(password|passwd|passphrase|pass|pwd|secret|secrets|key|psk|pin|puk|token|community|identity)|static-key-\d+|cak)$/;
// Review vòng 4: khoá WEP `static-key-0..3`, khoá MACsec `cak`, `identity` (ZeroTier: chứa khoá riêng).
/** Khoá chỉ bí mật trong một menu: tên community SNMP là mật khẩu; user PPPoE/VPN client là tài khoản nhà mạng. */
function menuSecret(menu: string, key: string): boolean {
  if (menu === "/snmp community") return key === "name";
  return key === "user" && /^\/interface [a-z0-9-]+-client$/.test(menu);
}

/** Giá trị trông như mã RouterOS script ở trường KHÔNG thuộc các họ trên ⇒ cũng che (phòng thủ thêm lớp). */
const SCRIPT_LIKE = /(^|[\s;{("])(:local|:global|:set|:put|:log|:do|:if|:foreach|:while|:delay|:execute|:return|:resolve)\b|\/tool\s+fetch|\$[A-Za-z_]/;

/** Băm chỉ khi giá trị đủ dài (thân script): giá trị ngắn + băm ⇒ dò được bằng đoán. */
const HASH_MIN = 24;

const unquote = (v: string) => (v.startsWith('"') && v.endsWith('"') && v.length >= 2 ? v.slice(1, -1) : v);
const shortHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 8);

/** Tách dòng terse thành token, giữ nguyên chuỗi trong nháy (có thoát `\"`, `\\`). */
export function tokenizeLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted && c === "\\" && i + 1 < line.length) {
      cur += c + line[i + 1];
      i++;
      continue;
    }
    if (c === '"') quoted = !quoted;
    if (c === " " && !quoted) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Dòng export an toàn để IN.
 * - Dòng không đúng dạng `/menu … <động từ> …` ⇒ không in gì của nó: `<unparsed line N chars>`.
 * - Thân script (CODE_KEY, hoặc giá trị trông như script) ⇒ `<redacted N chars[, sha256 x]>`.
 * - cmd/entrypoint/value ⇒ `<redacted N chars>`; họ khoá bí mật ⇒ `<redacted>`.
 * - Token còn lại qua `mask` TỪNG TOKEN (chạy `mask` trên cả dòng từng làm vỡ dấu `<redacted …>`).
 * Phần còn lại (comment, name, note…) chỉ được che CỐ GẮNG TỐT NHẤT, không bảo đảm.
 */
export function redactLine(line: string, mask: (s: string) => string): string {
  const parsed = parseLine(line);
  if (!parsed) {
    return `<unparsed line ${line.length} chars${line.length >= HASH_MIN ? `, sha256 ${shortHash(line)}` : ""}>`;
  }
  return tokenizeLine(line)
    .map((t) => {
      const eq = t.indexOf("=");
      if (eq <= 0) return mask(t);
      const key = t.slice(0, eq);
      const body = unquote(t.slice(eq + 1));
      if (SECRET_KEY.test(key) || menuSecret(parsed.menu, key)) return `${key}=<redacted>`;
      if (OPAQUE_KEY.test(key)) return `${key}=<redacted ${body.length} chars>`;
      if (CODE_KEY.test(key) || SCRIPT_LIKE.test(body)) {
        return `${key}=<redacted ${body.length} chars${body.length >= HASH_MIN ? `, sha256 ${shortHash(body)}` : ""}>`;
      }
      return mask(t);
    })
    .join(" ");
}

const MENU_WORD = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Đường dẫn menu + động từ của một dòng terse (`/ip firewall filter add …` ⇒ menu `/ip firewall filter`,
 * verb `add`). Menu chỉ gồm từ [a-z0-9-]; dòng không có động từ sau đường dẫn ⇒ undefined (không phân
 * tích được ⇒ không in, và bảng `menus` không bao giờ chứa nội dung của nó — review vòng 3).
 */
export function parseLine(line: string): { menu: string; verb: string } | undefined {
  const tokens = line.split(" ");
  const head = tokens[0] ?? "";
  if (!head.startsWith("/") || !MENU_WORD.test(head.slice(1))) return undefined;
  const menu = [head];
  for (const t of tokens.slice(1)) {
    if (VERB.test(t)) return { menu: menu.join(" "), verb: t };
    if (!MENU_WORD.test(t)) return undefined;
    menu.push(t);
  }
  return undefined;
}

/** Menu của một dòng terse; dòng không phân tích được ⇒ "?". */
export const menuOf = (line: string): string => parseLine(line)?.menu ?? "?";

export interface RscDiff {
  added: string[];
  removed: string[];
  /** Menu có cùng tập dòng nhưng khác thứ tự (quan trọng với firewall: thứ tự = hành vi). */
  reordered: string[];
  menus: Array<{ menu: string; added: number; removed: number }>;
}

/**
 * So hai bản theo TẬP dòng (có đếm lặp), không theo vị trí: RouterOS đổi thứ tự export giữa các
 * phiên bản (7.25 "improve export order") ⇒ diff theo vị trí báo nhiễu sau mỗi lần nâng cấp.
 * Đổi thứ tự trong cùng menu vẫn được báo riêng ở `reordered`.
 */
export function diffRsc(before: readonly string[], after: readonly string[]): RscDiff {
  const count = (xs: readonly string[]) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const b = count(before);
  const a = count(after);
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of after) {
    const left = b.get(line) ?? 0;
    if (left > 0) b.set(line, left - 1);
    else added.push(line);
  }
  for (const line of before) {
    const left = a.get(line) ?? 0;
    if (left > 0) a.set(line, left - 1);
    else removed.push(line);
  }
  const perMenu = new Map<string, { added: number; removed: number }>();
  for (const l of added) bump(perMenu, menuOf(l)).added++;
  for (const l of removed) bump(perMenu, menuOf(l)).removed++;

  const changed = new Set(perMenu.keys());
  const seq = (xs: readonly string[]) => {
    const m = new Map<string, string[]>();
    for (const x of xs) {
      const k = menuOf(x);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(x);
    }
    return m;
  };
  const sb = seq(before);
  const sa = seq(after);
  const reordered = [...sa.keys()].filter((k) => !changed.has(k) && sb.has(k) && sb.get(k)!.join("\n") !== sa.get(k)!.join("\n"));

  return {
    added,
    removed,
    reordered,
    menus: [...perMenu.entries()].map(([menu, c]) => ({ menu, ...c })).sort((x, y) => x.menu.localeCompare(y.menu)),
  };
}

function bump(m: Map<string, { added: number; removed: number }>, k: string) {
  let v = m.get(k);
  if (!v) m.set(k, (v = { added: 0, removed: 0 }));
  return v;
}

export interface SavedExport {
  path: string;
  created: string;
}

/** Tên file `<ISO ts>_<slug>.rsc` ⇒ sắp xếp theo tên = theo thời gian. */
export function saveExport(root: string, device: string, section: string, rsc: string, now = new Date()): string {
  const dir = join(root, device);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${now.toISOString().replace(/[:.]/g, "-")}_${sectionSlug(section)}.rsc`);
  writeFileSync(path, rsc.endsWith("\n") ? rsc : `${rsc}\n`, { flag: "wx" });
  return path;
}

export function latestExport(root: string, device: string, section: string): string | undefined {
  const dir = join(root, device);
  const suffix = `_${sectionSlug(section)}.rsc`;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(suffix));
  } catch {
    return undefined;
  }
  const last = files.sort().at(-1);
  return last ? join(dir, last) : undefined;
}

export function readExport(path: string): string {
  return readFileSync(path, "utf8");
}
