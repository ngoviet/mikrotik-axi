import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Chạy bin đã build với profile/credential THẬT. Chỉ lệnh đọc (READ_ONLY ép bật).
//   MIKROTIK_AXI_LIVE=1 pnpm test:live
// Đối chiếu số đếm với một script đếm độc lập (in dòng "TỔNG KẾT: … pppoe=a/b vlan=n dhcp=n
// default-route=n nat=n filter=n mangle=n"), nếu đặt:
//   MIKROTIK_AXI_PROBE_CMD="python <đường dẫn>/probe_dem_hien_trang.py"
const BIN = fileURLToPath(new URL("../../dist/bin/mikrotik-axi.js", import.meta.url));
const live = process.env["MIKROTIK_AXI_LIVE"] === "1";
const probeCmd = process.env["MIKROTIK_AXI_PROBE_CMD"];

function run(args: string[]): { out: string; code: number | null; ms: number } {
  return runEnv(args, {});
}

function runEnv(args: string[], extra: Record<string, string>): { out: string; code: number | null; ms: number } {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, ...extra, MIKROTIK_AXI_READ_ONLY: "1" } });
  return { out: r.stdout, code: r.status, ms: performance.now() - t0 };
}

const num = (out: string, re: RegExp): number => {
  const m = re.exec(out);
  if (!m) throw new Error(`pattern ${re} not found in:\n${out.slice(0, 400)}`);
  return Number(m[1]);
};

const READ_COMMANDS = [
  ["health"],
  ["wan"],
  ["wan", "ips"],
  ["routes", "defaults"],
  ["routes", "defaults", "--table", "main"],
  ["routes", "rules"],
  ["dhcp"],
  ["vlans"],
  ["iface"],
  ["fw", "filter"],
  ["fw", "nat"],
  ["fw", "mangle"],
  ["fw", "raw"],
  ["fw", "mangle", "check"],
  ["services"],
  ["audit"],
  ["log", "--since", "1h"],
];

describe.skipIf(!live)("live read-only (MIKROTIK_AXI_LIVE=1)", () => {
  it("export with the read-only user: two saves of one section hash the same, diff says identical", () => {
    // Thư mục tạm riêng: không lẫn vào bản lưu thật của chủ.
    // Xoá ngay sau test: file là cấu hình THẬT (nguồn script có thể chứa bí mật).
    const dir = mkdtempSync(join(tmpdir(), "axi-live-export-"));
    const env = { MIKROTIK_AXI_EXPORT_DIR: dir };
    try {
      const a = runEnv(["export", "--section", "/ip/firewall/filter"], env);
      expect(a.code, a.out).toBe(0);
      const b = runEnv(["export", "--section", "/ip/firewall/filter"], env);
      expect(b.out).toMatch(/^changed_since_last: no$/m);
      expect(runEnv(["export", "diff", "--section", "/ip/firewall/filter"], env).out).toMatch(/^summary: identical$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Cần policy `test` cho user đọc (chủ thêm trên router) ⇒ bật riêng: MIKROTIK_AXI_LIVE_PING=1.
  it.skipIf(process.env["MIKROTIK_AXI_LIVE_PING"] !== "1")("ping and traceroute from the router (needs policy test)", () => {
    const p = run(["ping", "1.1.1.1", "--count", "2"]);
    expect(p.code, p.out).toBe(0);
    expect(p.out).toMatch(/^result: "\d\/2 replies/m);
    const each = run(["ping", "1.1.1.1", "--each-wan"]);
    expect(each.code, each.out).toBe(0);
    expect(each.out).toMatch(/^reach: \d+\/\d+ running sessions/m);
    const t = run(["traceroute", "1.1.1.1"]);
    expect(t.code, t.out).toBe(0);
    expect(t.out).toMatch(/^hops\[\d+\]\{hop,address,loss,rtt\}:/m);
  });

  it("home view: identity ok, complete every time; fastest run under 1.5 s", () => {
    // Đo thật 2026-10-14: router có lúc bận và xử lý menu interface/firewall tuần tự 200–1400 ms
    // mỗi cái (PowerShell gọi tuần tự cũng thấy) ⇒ thời gian home có 2 cụm ~250 ms / ~2,2 s.
    // Phần của tool đo bằng lần nhanh nhất; mọi lần đều phải in đủ (không phần nào hỏng).
    run([]); // làm nóng (đĩa/cache module)
    const runs = Array.from({ length: 5 }, () => run([]));
    const ms = runs.map((r) => Math.round(r.ms)).sort((a, b) => a - b);
    console.log(`${runs[0]!.out}\n[home ms: ${ms.join(", ")}]`);
    for (const r of runs) {
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/identity \S+ ok/);
      expect(r.out).not.toMatch(/unavailable|checks_skipped/);
    }
    expect(ms[0]).toBeLessThan(1500);
  });

  it.each(READ_COMMANDS.map((c) => [c.join(" "), c]))("%s: exit 0, nothing unavailable", (_name, args) => {
    const { out, code, ms } = run(args as string[]);
    console.log(`$ mikrotik-axi ${(args as string[]).join(" ")}  [${ms.toFixed(0)} ms]\n${out.split("\n").slice(0, 12).join("\n")}`);
    expect(code).toBe(0);
    expect(out).not.toMatch(/unavailable/);
    expect(ms).toBeLessThan(2000);
  });

  it.skipIf(!probeCmd)("counts match probe_dem_hien_trang.py", () => {
    // Python trên Windows mặc định in cp1252 ⇒ vỡ ở tiếng Việt ("TỔNG KẾT"); ép UTF-8.
    const p = spawnSync(probeCmd as string, {
      shell: true,
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
    const summary = /TỔNG KẾT:.*$/m.exec(p.stdout)?.[0];
    expect(summary, p.stdout.slice(-500)).toBeDefined();
    const probe = (k: string) => num(summary as string, new RegExp(`${k}=(\\d+)`));
    const [pRun, pAll] = /pppoe=(\d+)\/(\d+)/.exec(summary as string)!.slice(1).map(Number);

    const wan = run(["wan", "--full"]).out;
    // probe đếm cả phiên disabled trong mẫu số; wan in running/enabled + danh sách disabled.
    expect(num(wan, /^running: (\d+)\//m)).toBe(pRun);
    expect(num(wan, /^count: (\d+)$/m)).toBe(pAll);
    expect(num(run(["vlans"]).out, /^count: (\d+)/m)).toBe(probe("vlan"));
    expect(num(run(["dhcp"]).out, /^count: (\d+)/m)).toBe(probe("dhcp"));
    const tables = run(["routes", "defaults", "--full"]).out;
    const totalDefaults = [...tables.matchAll(/^ {2}[^,\n]+,(\d+),\d+,/gm)].reduce((n, m) => n + Number(m[1]), 0);
    expect(totalDefaults).toBe(probe("default-route"));
    for (const t of ["nat", "filter", "mangle"]) {
      expect(num(run(["fw", t]).out, /^summary: "(\d+) rules/m), t).toBe(probe(t));
    }
  });
});
