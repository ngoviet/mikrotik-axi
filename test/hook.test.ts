import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionStartHookStatus } from "axi-sdk-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOOK_MARKER } from "../src/commands/setup.js";
import { inHookDirs, runHook } from "../src/hook.js";
import { TransportError, type Transport } from "../src/ros/transport.js";
import { fakeRouter, loadDataset } from "./helpers/fake-router.js";
import { CREDS, runCli, writeProfile } from "./helpers/run.js";

const env = (extra: Record<string, string> = {}) => ({
  MIKROTIK_AXI_PROFILE: writeProfile(),
  MIKROTIK_AXI_USER: CREDS.user,
  MIKROTIK_AXI_PASS: CREDS.pass,
  ...extra,
});

async function hook(opts: { transport: Transport; env?: Record<string, string>; cwd?: string; budgetMs?: number }) {
  let out = "";
  await runHook({
    env: env(opts.env),
    cwd: opts.cwd ?? "D:\\work\\netops",
    write: (c) => (out += c),
    transport: opts.transport,
    platform: "win32",
    ...(opts.budgetMs ? { budgetMs: opts.budgetMs } : {}),
  });
  return out;
}

describe("session hook", () => {
  it("prints the home view (with header) in a listed project dir", async () => {
    const out = await hook({
      transport: fakeRouter(loadDataset("ccr2004"), CREDS).transport,
      env: { MIKROTIK_AXI_HOOK_DIRS: "D:\\work\\netops;D:\\work\\home-assistant" },
      cwd: "d:\\work\\netops\\docs",
    });
    expect(out).toMatch(/^description: /m);
    expect(out).toMatch(/^alerts\[6\]/m);
  });

  it("prints nothing outside MIKROTIK_AXI_HOOK_DIRS and makes no request", async () => {
    const router = fakeRouter(loadDataset("ccr2004"), CREDS);
    const out = await hook({ transport: router.transport, env: { MIKROTIK_AXI_HOOK_DIRS: "D:\\work\\home-assistant" }, cwd: "D:\\work\\other" });
    expect(out).toBe("");
    expect(router.requests).toHaveLength(0);
  });

  it("unreachable router: exactly one line", async () => {
    const down: Transport = async (req) => {
      await new Promise((r) => setTimeout(r, Math.min(req.timeoutMs, 50)));
      throw new TransportError("timeout", "timeout");
    };
    expect(await hook({ transport: down })).toBe("mikrotik-axi: device unreachable\n");
  });

  it("every request shares one deadline inside the 3 s budget (no fixed 1 s cap)", async () => {
    const seen: number[] = [];
    const base = fakeRouter(loadDataset("ccr2004"), CREDS).transport;
    const spy: Transport = async (req) => {
      seen.push(req.timeoutMs);
      await new Promise((r) => setTimeout(r, 40));
      return base(req);
    };
    await hook({ transport: spy });
    expect(Math.max(...seen)).toBeLessThanOrEqual(2700);
    expect(seen[0]).toBeGreaterThan(2000);
    // Request sau nhận phần còn lại của hạn chót, không phải một trần cố định.
    expect(seen.at(-1)!).toBeLessThan(seen[0]!);
  });

  it("slow-but-alive router (serialized, slow interface/firewall menus) still yields the full view", async () => {
    // Mô phỏng hành vi đo thật: router bận xử lý tuần tự, menu interface/firewall chậm.
    const base = fakeRouter(loadDataset("ccr2004"), CREDS).transport;
    let chain: Promise<unknown> = Promise.resolve();
    const busy: Transport = (req) => {
      const slow = /\/(interface|ip\/firewall)/.test(req.url.pathname);
      const run = chain.then(() => new Promise((r) => setTimeout(r, slow ? 110 : 5)));
      chain = run;
      return run.then(() => base(req));
    };
    const out = await hook({ transport: busy });
    expect(out).toMatch(/^alerts\[6\]/m);
    expect(out).not.toMatch(/unavailable|checks_skipped|unreachable/);
  });

  it("hanging router: one line when the budget runs out", async () => {
    const hang: Transport = () => new Promise(() => {});
    expect(await hook({ transport: hang, budgetMs: 100 })).toBe(
      "mikrotik-axi: no answer within 0.1s (router busy or unreachable)\n",
    );
  });

  it("config errors also collapse to one line", async () => {
    const out = await hook({ transport: fakeRouter(loadDataset("ccr2004"), CREDS).transport, env: { MIKROTIK_AXI_PASS: "" } });
    expect(out).toBe("mikrotik-axi: credentials for ccr2004 missing: MIKROTIK_AXI_PASS not set\n");
  });

  it("inHookDirs: unset = everywhere; prefix match is per path segment", () => {
    expect(inHookDirs("/x", undefined, "linux")).toBe(true);
    expect(inHookDirs("/code/a/b", "/code/a", "linux")).toBe(true);
    expect(inHookDirs("/code/ab", "/code/a", "linux")).toBe(false);
    expect(inHookDirs("C:\\Code\\A", "c:\\code\\a", "win32")).toBe(true);
  });
});

// Ghi file cấu hình agent thật (settings.json, hooks.json, plugin) — chậm khi cả bộ test chạy song song.
describe("setup hooks", { timeout: 15000 }, () => {
  let dir: string;
  let hookBin: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    // Giả lập cài global: shim npm trên PATH trỏ tới dist/bin/mikrotik-axi-hook.js.
    dir = mkdtempSync(join(tmpdir(), "mikrotik-axi-setup-"));
    const binDir = join(dir, "npm");
    hookBin = join(binDir, "node_modules", "mikrotik-axi", "dist", "bin", "mikrotik-axi-hook.js");
    mkdirSync(join(hookBin, ".."), { recursive: true });
    writeFileSync(hookBin, "#!/usr/bin/env node\n");
    writeFileSync(
      join(binDir, "mikrotik-axi-hook"),
      `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/node_modules/mikrotik-axi/dist/bin/mikrotik-axi-hook.js" "$@"\n`,
    );
    savedPath = process.env["PATH"];
    process.env["PATH"] = `${binDir}${process.platform === "win32" ? ";" : ":"}${savedPath ?? ""}`;
  });

  afterEach(() => {
    process.env["PATH"] = savedPath;
  });

  const setup = (argv: string[], platform: NodeJS.Platform = process.platform) =>
    runCli(["setup", "hooks", ...argv], { env: { PATH: process.env["PATH"] ?? "" }, runtime: { hookBin, homeDir: join(dir, "home"), platform } });

  it("installs a bare `mikrotik-axi-hook` command, idempotently", async () => {
    const first = await setup([]);
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/^command: mikrotik-axi-hook$/m);
    const settingsPath = join(dir, "home", ".claude", "settings.json");
    const settings = readFileSync(settingsPath, "utf8");
    expect(settings).toContain('"command": "mikrotik-axi-hook"');
    await setup([]);
    expect(readFileSync(settingsPath, "utf8")).toBe(settings);
    expect((await setup(["--status"])).out).toMatch(/^claude: "?installed/m);
  });

  it("--remove removes only our entry", async () => {
    await setup([]);
    const removed = await setup(["--remove"]);
    expect(removed.code).toBe(0);
    expect(removed.out).toMatch(/^setup: hooks removed$/m);
    expect(removed.out).toMatch(/^claude: "?not installed/m);
  });

  it("install that could not write a config fails (no false success)", async () => {
    // settings.json là thư mục ⇒ SDK báo lỗi qua onError rồi vẫn trả về bình thường.
    mkdirSync(join(dir, "home", ".claude", "settings.json"), { recursive: true });
    const r = await setup([]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^code: SETUP_FAILED$/m);
    expect(r.out).toContain("install incomplete (not installed: claude)");
    expect(r.out).toContain("settings.json");
    expect(r.out).not.toContain("hooks installed");
  });

  it("--remove that leaves something behind fails", async () => {
    await setup([]);
    // Plugin OpenCode mất dấu marker ⇒ SDK từ chối xoá file người dùng (onError).
    const { opencode } = sessionStartHookStatus({ marker: HOOK_MARKER, execPath: hookBin, scope: "user", homeDir: join(dir, "home") });
    writeFileSync(opencode.path, "// user's own plugin\n");
    const r = await setup(["--remove"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^code: SETUP_FAILED$/m);
    expect(r.out).toContain("remove incomplete");
    expect(r.out).toContain("refusing to remove unmanaged OpenCode plugin");
  });

  it("on Windows refuses to install a raw .js path (agents cannot execute it)", async () => {
    process.env["PATH"] = savedPath;
    const r = await runCli(["setup", "hooks"], {
      env: { PATH: "" },
      runtime: { hookBin, homeDir: join(dir, "home2"), platform: "win32" },
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("mikrotik-axi-hook is not on PATH");
    expect(existsSync(join(dir, "home2", ".claude", "settings.json"))).toBe(false);
  });

  it("rejects anything but `setup hooks`", async () => {
    expect((await runCli(["setup", "nope"])).code).toBe(2);
  });
});
