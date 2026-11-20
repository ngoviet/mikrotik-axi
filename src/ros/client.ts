import { createHash } from "node:crypto";
import { axiError, fail, redact } from "../errors.js";
import { assertMenu, isSingleton } from "./menus.js";
import { toBool, type RosRecord } from "./normalize.js";
import { nodeTransport, TransportError, type HttpRequest, type HttpResponse, type Transport } from "./transport.js";
import { validateWrite, type RosBody } from "./validate.js";

/**
 * RouterOS chạy TUẦN TỰ các request REST của cùng một user (manual chính thức, mục "Send parallel
 * requests from separate users"). Đo CCR2004 7.25.1 (2026-11-21): home view ở mức 1 / 2 / 6 cho
 * cùng tổng thời gian; ở 6 từng request phình lên 1–1,4 s vì xếp hàng trong router. Mức 2 giữ một
 * request chờ sẵn (che độ trễ mạng) mà không dồn phiên lên dịch vụ www (max-sessions mặc định 20).
 */
export const MAX_CONCURRENT = 2;
export type DiagnosticCommand = "/ping" | "/tool/traceroute";
const DIAGNOSTIC_COMMANDS = new Set<string>(["/ping", "/tool/traceroute"]);

/** REST cắt mọi request ở 60 s ("Session closed") — chờ vừa quá mức đó để thấy lỗi của router. */
export const EXPORT_TIMEOUT_MS = 61_000;

export interface DeviceConn {
  /** Tên thiết bị trong profile — dùng trong thông điệp lỗi. */
  name: string;
  /** Gốc URL, ví dụ https://192.168.100.1 (không kèm /rest). */
  url: string;
  user: string;
  pass: string;
  timeoutMs: number;
  tlsPin?: string;
  /** Hạn chót tuyệt đối (epoch ms) cho MỌI request — hook dùng để cả lượt lọt ngân sách 3 s. */
  deadlineAt?: number;
}

export interface GetOptions {
  /** Bắt buộc dùng cho mọi GET (giảm payload) — xem §5.2. */
  proplist?: readonly string[];
  /** Lọc phía router, ví dụ { "dst-address": "0.0.0.0/0" }. */
  query?: Record<string, string>;
  timeoutMs?: number;
}

interface CallOptions {
  query?: Record<string, string>;
  body?: unknown;
  auth?: boolean;
  timeoutMs?: number;
}

/** Bẫy #2: `.id` dạng `*3B` phải giữ NGUYÊN `*` trong path (`%2A3B` ⇒ 400). */
export function encodeId(id: string): string {
  return encodeURIComponent(id).replace(/%2A/gi, "*").replace(/%21/g, "!");
}

// RouterOS đọc query thô; giữ nguyên , / : * để `.proplist=a,b` và `0.0.0.0/0` không bị
// mã hoá thành %2C / %2F.
function encodeQueryPart(s: string): string {
  return encodeURIComponent(s).replace(/%2C/gi, ",").replace(/%2F/gi, "/").replace(/%3A/gi, ":").replace(/%2A/gi, "*");
}

export function credentialFingerprint(user: string, pass: string): string {
  const sha = createHash("sha256").update(pass).digest("hex").slice(0, 8);
  return `user=${user}, pass_len=${pass.length}, sha256=${sha}`;
}

export class RosClient {
  /** Đặt bởi guard.ts sau khi kiểm identity. strict=false nghĩa là đã bỏ qua so tên. */
  verified?: { identity: string; strict: boolean };
  /** Cache identity trong MỘT lần chạy (không cache giữa các lần chạy). */
  identityCheck?: Promise<string>;

  constructor(
    readonly conn: DeviceConn,
    private readonly transport: Transport = nodeTransport,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  get host(): string {
    return new URL(this.conn.url).hostname;
  }

  url(path: string, query?: Record<string, string>): URL {
    const base = this.conn.url.replace(/\/+$/, "");
    const qs = query
      ? Object.entries(query)
          .map(([k, v]) => `${encodeQueryPart(k)}=${encodeQueryPart(v)}`)
          .join("&")
      : "";
    return new URL(`${base}/rest${path}${qs ? `?${qs}` : ""}`);
  }

  /** Gọi HTTP thô (đã dịch lỗi mạng/TLS). Không kiểm status — guard dùng để dò. */
  async raw(method: HttpRequest["method"], path: string, opts: CallOptions = {}): Promise<HttpResponse> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.auth !== false) {
      headers["Authorization"] = `Basic ${Buffer.from(`${this.conn.user}:${this.conn.pass}`).toString("base64")}`;
    }
    let body: string | undefined;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["Content-Type"] = "application/json";
    }
    const queued = performance.now();
    const release = await this.acquire();
    const started = performance.now();
    // Tính SAU khi có slot: thời gian chờ slot đã tiêu vào hạn chót.
    let timeoutMs = opts.timeoutMs ?? this.conn.timeoutMs;
    if (this.conn.deadlineAt !== undefined) {
      timeoutMs = Math.max(1, Math.min(timeoutMs, this.conn.deadlineAt - Date.now()));
    }
    let status = "ERR";
    try {
      const res = await this.transport({
        method,
        url: this.url(path, opts.query),
        headers,
        timeoutMs,
        ...(body !== undefined ? { body } : {}),
        ...(this.conn.tlsPin ? { tlsPin: this.conn.tlsPin } : {}),
      });
      status = String(res.status);
      return res;
    } catch (e) {
      throw this.translateTransportError(e, timeoutMs, path);
    } finally {
      release();
      // MIKROTIK_AXI_TRACE=1: thời gian chờ slot + thời gian request, ra stderr (stdout dành cho agent).
      if (this.env["MIKROTIK_AXI_TRACE"] === "1") {
        const end = performance.now();
        process.stderr.write(
          `trace: ${method} ${path} ${status} wait=${Math.round(started - queued)}ms req=${Math.round(end - started)}ms
`,
        );
      }
    }
  }

  // Giới hạn số request đồng thời: router xử lý tuần tự theo user nên thêm song song chỉ dời hàng
  // đợi sang router (xem MAX_CONCURRENT) và chiếm phiên www của Winbox/web.
  private active = 0;
  private get maxConcurrent(): number {
    const n = Number(this.env["MIKROTIK_AXI_CONCURRENCY"]);
    return Number.isInteger(n) && n > 0 ? n : MAX_CONCURRENT;
  }
  private readonly waiting: Array<() => void> = [];

  private async acquire(): Promise<() => void> {
    // Slot được chuyển THẲNG cho người chờ (không giảm rồi tăng) — tránh request mới chen vào
    // giữa hai bước và vượt trần.
    if (this.active >= this.maxConcurrent) await new Promise<void>((r) => this.waiting.push(r));
    else this.active++;
    return () => {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }

  private translateTransportError(e: unknown, timeoutMs: number, path: string): Error {
    if (!(e instanceof TransportError)) return e instanceof Error ? e : new Error(String(e));
    const where = `${this.conn.name} (${this.host})`;
    switch (e.kind) {
      case "timeout":
        // Identity đã xác minh ⇒ router CÓ trả lời, chỉ chậm (đo thật: menu interface/firewall có
        // lúc mất 200–1400 ms khi router bận). Đừng báo "unreachable" sai.
        if (this.verified) {
          return axiError(`${where} timed out on ${path} after ${timeoutMs / 1000}s (router busy)`, "TIMEOUT", [
            "Retry; run with MIKROTIK_AXI_TRACE=1 to see per-request latency",
          ]);
        }
        return axiError(`${where} unreachable (timeout ${timeoutMs / 1000}s)`, "UNREACHABLE", [
          `Check that ${this.host} is reachable from this machine`,
          "Another network may use the same subnet: verify the route to the router",
        ]);
      case "network":
        return axiError(`${where} unreachable (${e.message})`, "UNREACHABLE", [
          `Check that the RouterOS www/www-ssl service is enabled and allows this machine`,
        ]);
      case "tls-pin-mismatch":
        return axiError(`${where} TLS certificate does not match the pinned fingerprint`, "TLS_ERROR", [
          `Server presented sha256 ${e.fingerprint ?? "?"}`,
          "If the router certificate was replaced on purpose, verify it on the router and update tls.self_signed_pin_sha256",
          "Otherwise another device may be answering at this address: do not proceed",
        ]);
      case "tls-untrusted":
        return axiError(`${where} TLS certificate is not trusted (${e.message})`, "TLS_ERROR", [
          ...(e.fingerprint ? [`Server presented sha256 ${e.fingerprint}`] : []),
          'Verify that fingerprint on the router (/certificate print detail), then set "tls": { "self_signed_pin_sha256": "<fingerprint>" } in the profile',
        ]);
    }
  }

  /** Gọi REST có xác thực, dịch status lỗi, parse JSON. */
  private async call(method: HttpRequest["method"], path: string, opts: CallOptions = {}): Promise<unknown> {
    const res = await this.raw(method, path, opts);
    const where = `${method} ${path}`;
    if (res.status === 401) {
      fail(`authentication failed on ${this.conn.name} (${credentialFingerprint(this.conn.user, this.conn.pass)})`, "AUTH_ERROR", [
        "Check the credential env vars named in the profile (credential_env)",
        "RouterOS also answers 401 when the user's `address` restriction excludes this machine",
      ]);
    }
    if (res.status === 403) {
      fail(`permission denied on ${this.conn.name} for ${where}`, "AUTH_ERROR", [
        "The RouterOS user group lacks a policy needed for this menu (read, rest-api)",
      ]);
    }
    let parsed: unknown;
    try {
      parsed = res.body.trim() === "" ? undefined : JSON.parse(res.body);
    } catch {
      fail(`${this.conn.name} returned non-JSON for ${where} (HTTP ${res.status})`, "NOT_ROUTEROS", [
        `Response starts with: ${redact(res.body, 80)}`,
      ]);
    }
    if (res.status >= 400) {
      const err = (parsed ?? {}) as { message?: string; detail?: string };
      const detail = err.detail ?? err.message ?? `HTTP ${res.status}`;
      fail(`RouterOS rejected ${where}: ${redact(detail)}`, "ROS_ERROR");
    }
    return parsed;
  }

  // ---- đọc ----

  /** Menu dạng bảng ⇒ luôn trả mảng. Gọi trên singleton là lỗi lập trình (bẫy #4). */
  async list(menu: string, opts: GetOptions = {}): Promise<RosRecord[]> {
    assertMenu(menu);
    if (isSingleton(menu)) throw new Error(`${menu} is a singleton menu: use single()`);
    const data = await this.call("GET", menu, this.getOpts(opts));
    if (!Array.isArray(data)) {
      fail(`expected a list from ${menu}, got ${typeof data}`, "ROS_ERROR", [
        "This menu may be a singleton: declare it in src/ros/menus.ts",
      ]);
    }
    return data as RosRecord[];
  }

  /** Menu singleton ⇒ luôn trả dict (bẫy #4). */
  async single(menu: string, opts: GetOptions = {}): Promise<RosRecord> {
    assertMenu(menu);
    if (!isSingleton(menu)) throw new Error(`${menu} is not declared singleton: use list() or declare it`);
    const data = await this.call("GET", menu, this.getOpts(opts));
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      fail(`expected an object from ${menu}`, "ROS_ERROR");
    }
    return data as RosRecord;
  }

  async getById(menu: string, id: string, opts: GetOptions = {}): Promise<RosRecord> {
    assertMenu(menu);
    const data = await this.call("GET", `${menu}/${encodeId(id)}`, this.getOpts(opts));
    return data as RosRecord;
  }

  private getOpts(opts: GetOptions): CallOptions {
    const query = { ...opts.query };
    if (opts.proplist?.length) query[".proplist"] = opts.proplist.join(",");
    return {
      ...(Object.keys(query).length ? { query } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    };
  }

  /**
   * Export cấu hình (`<section>/export terse`) qua `POST /execute` + `as-string` — đường DUY NHẤT
   * chạy được với user chỉ đọc (đo CCR2004 7.25.1, 2026-11-21: `POST /rest/export` trả `[]` sau
   * 8,4 s; `/execute as-string` trả nguyên văn trong 0,15–0,7 s).
   * `/execute` là cửa chạy script tuỳ ý (§3.2 cấm cho agent) ⇒ script do TOOL dựng: section phải là
   * menu hợp lệ (chỉ [a-z0-9-/]) và đuôi cố định `/export terse`. Script chạy với policy của chính
   * user (axi-ro không có `write`/`sensitive` ⇒ không ghi được gì, mật khẩu bị router ẩn).
   * Bẫy #10: script lỗi vẫn trả HTTP 200, lỗi nằm trong `ret` ("syntax error (line 1 column 14)")
   * ⇒ chỉ nhận output mở đầu bằng dòng `# … by RouterOS …`.
   */
  async exportConfig(section: string): Promise<string> {
    if (section !== "/") assertMenu(section);
    const script = `${section === "/" ? "" : section}/export terse`;
    const res = (await this.call("POST", "/execute", { body: { script, "as-string": "" }, timeoutMs: EXPORT_TIMEOUT_MS })) as
      | { ret?: unknown }
      | undefined;
    const text = typeof res?.ret === "string" ? res.ret : "";
    if (!/^# .* by RouterOS /.test(text)) {
      fail(`export of ${section} failed: ${redact(text.split("\n")[0] ?? "", 120) || "empty reply"}`, "ROS_ERROR", [
        "Check the section path (menu as in `/ip/firewall`, not `/ip firewall`)",
      ]);
    }
    return text;
  }

  /**
   * Lệnh chẩn đoán chạy TRÊN router (POST, không đổi cấu hình). Danh sách trắng: chỉ ping và
   * traceroute — không có POST tuỳ ý. Cần policy `test` cho user: đo CCR2004 7.25.1 (2026-11-21),
   * `axi-ro` (read,api,rest-api) nhận HTTP 500 `not enough permissions (9)` ⇒ dịch thành AUTH_ERROR
   * kèm cách sửa. Lệnh không có `count` chạy mãi ⇒ REST cắt ở 60 s ("Session closed"): người gọi
   * phải truyền count.
   */
  async diagnose(command: DiagnosticCommand, body: Record<string, string>, timeoutMs: number): Promise<RosRecord[]> {
    if (!DIAGNOSTIC_COMMANDS.has(command)) throw new Error(`not a diagnostic command: ${command}`);
    if (body["count"] === undefined) throw new Error(`${command} needs count (REST ends endless commands at 60 s)`);
    try {
      const data = await this.call("POST", command, { body, timeoutMs });
      return Array.isArray(data) ? (data as RosRecord[]) : data ? [data as RosRecord] : [];
    } catch (e) {
      if (e instanceof Error && /not enough permissions/i.test(e.message)) {
        fail(`${this.conn.user} may not run ${command} on ${this.conn.name}: the user group lacks the \`test\` policy`, "AUTH_ERROR", [
          "Add `test` to the read-only group on the router, e.g. /user group set axi-read policy=read,api,rest-api,test",
          "`test` also allows fetch, email and bandwidth-test (manual: /user group): weigh that before granting it to a user agents share",
        ]);
      }
      throw e;
    }
  }

  // ---- ghi (dùng bởi lớp write/ ở M3; ở đây chỉ mã hoá bẫy + chốt chặn cuối) ----

  private assertWriteAllowed(): void {
    if (this.env["MIKROTIK_AXI_READ_ONLY"] === "1") {
      fail("writes are disabled (MIKROTIK_AXI_READ_ONLY=1)", "WRITE_REFUSED");
    }
    if (!this.verified?.strict) {
      fail(`identity of ${this.conn.name} not verified: writes always require the identity check`, "WRITE_REFUSED");
    }
  }

  /** Bẫy #1: thêm object là POST <menu>/add, KHÔNG phải POST <menu>. Trả `.id` mới. */
  async add(menu: string, body: RosBody): Promise<string> {
    assertMenu(menu);
    this.assertWriteAllowed();
    validateWrite(menu, body);
    const res = (await this.call("POST", `${menu}/add`, { body })) as { ret?: string } | undefined;
    return res?.ret ?? "";
  }

  async set(menu: string, id: string, body: RosBody): Promise<void> {
    assertMenu(menu);
    if (isSingleton(menu)) throw new Error(`${menu} is a singleton menu: use singletonSet()`);
    this.assertWriteAllowed();
    const current = await this.getById(menu, id);
    assertNotDynamic(menu, id, current);
    validateWrite(menu, body, { ...current, ...body });
    await this.call("PATCH", `${menu}/${encodeId(id)}`, { body });
  }

  async remove(menu: string, id: string, opts: { allowDynamic?: boolean } = {}): Promise<void> {
    assertMenu(menu);
    this.assertWriteAllowed();
    if (opts.allowDynamic && !DYNAMIC_REMOVABLE.has(menu)) {
      throw new Error(`${menu}: removing dynamic entries is only allowed for ${[...DYNAMIC_REMOVABLE].join(", ")}`);
    }
    if (!opts.allowDynamic) assertNotDynamic(menu, id, await this.getById(menu, id));
    await this.call("DELETE", `${menu}/${encodeId(id)}`);
  }

  /** Bẫy #4: singleton sửa bằng POST <menu>/set, không PATCH <menu>. */
  async singletonSet(menu: string, body: RosBody): Promise<void> {
    assertMenu(menu);
    if (!isSingleton(menu)) throw new Error(`${menu} is not a singleton menu: use set()`);
    this.assertWriteAllowed();
    validateWrite(menu, body);
    await this.call("POST", `${menu}/set`, { body });
  }
}

/**
 * Menu mà xoá entry ĐỘNG là thao tác hợp lệ (router tự học lại): ARP. Khác với route động —
 * xoá/sửa route do PPPoE sinh là vô nghĩa (bẫy #6).
 */
const DYNAMIC_REMOVABLE = new Set(["/ip/arp"]);

/** Bẫy #6: object động (route do PPPoE sinh…) không sửa được — báo trước thay vì để router trả 400. */
export function assertNotDynamic(menu: string, id: string, current: RosRecord): void {
  if (!toBool(current["dynamic"], "dynamic")) return;
  fail(`${menu} ${id} is dynamic and cannot be modified`, "WRITE_REFUSED", [
    menu === "/ip/route"
      ? "Dynamic default routes come from /interface/pppoe-client: change `default-route-distance` there instead"
      : "Change the object that created it instead",
  ]);
}
