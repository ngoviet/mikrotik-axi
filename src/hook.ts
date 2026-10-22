import { isAbsolute, relative, resolve } from "node:path";
import { main } from "./cli.js";
import type { Env } from "./config/env.js";
import type { Transport } from "./ros/transport.js";

// Lệnh mà `setup hooks` cài cho SessionStart (Claude Code, Codex, OpenCode). Tách khỏi
// `mikrotik-axi` vì SDK cài lệnh TRẦN (không tham số, không env) — OpenCode còn spawn không qua
// shell — nên chỉ đổi được hành vi bằng một bin riêng.

export const HOOK_BUDGET_MS = 3000;
/**
 * Hạn chót chung cho mọi request (chừa ~300 ms để in). KHÔNG đặt trần riêng 1 s/request: đo thật
 * trên CCR2004, lúc router bận các menu interface/firewall mất 200–1400 ms mỗi cái và router xử lý
 * tuần tự ⇒ trần 1 s làm hook in "unavailable" dù router vẫn trả lời. Mỗi request được dùng phần
 * còn lại của hạn chót.
 */
export const HOOK_DEADLINE_MS = 2700;

export interface HookOptions {
  env: Env;
  cwd: string;
  write: (chunk: string) => unknown;
  transport?: Transport;
  platform?: NodeJS.Platform;
  /** Chỉ test đổi. */
  budgetMs?: number;
}

/** cwd nằm trong một thư mục của MIKROTIK_AXI_HOOK_DIRS? Không đặt biến ⇒ luôn in. */
export function inHookDirs(cwd: string, dirs: string | undefined, platform = process.platform): boolean {
  if (!dirs?.trim()) return true;
  const norm = (p: string) => (platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const sep = platform === "win32" ? ";" : /[:;]/;
  return dirs
    .split(sep)
    .map((d) => d.trim())
    .filter(Boolean)
    .some((d) => {
      const rel = relative(norm(d), norm(cwd));
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
}

export async function runHook(opts: HookOptions): Promise<void> {
  // Ngoài thư mục liên quan mạng: không in gì (0 token cho phiên agent).
  if (!inHookDirs(opts.cwd, opts.env["MIKROTIK_AXI_HOOK_DIRS"], opts.platform)) return;

  let out = "";
  let exit = 0;
  const work = (async () => {
    const before = process.exitCode;
    await main({
      argv: [],
      stdout: { write: (c: string) => (out += c) },
      runtime: {
        // Hook luôn chỉ đọc, kể cả nếu sau này home view có thao tác ghi.
        env: { ...opts.env, MIKROTIK_AXI_READ_ONLY: "1" },
        stderr: { write: () => true },
        timeoutCapMs: HOOK_DEADLINE_MS,
        deadlineAt: Date.now() + Math.min(HOOK_DEADLINE_MS, (opts.budgetMs ?? HOOK_BUDGET_MS) - 300),
        ...(opts.transport ? { transport: opts.transport } : {}),
        ...(opts.platform ? { platform: opts.platform } : {}),
      },
    });
    exit = Number(process.exitCode ?? 0);
    process.exitCode = before;
  })();

  const budget = opts.budgetMs ?? HOOK_BUDGET_MS;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), budget);
  });
  const res = await Promise.race([work.then(() => "done" as const), timeout]);
  clearTimeout(timer);

  // Không bao giờ treo phiên agent, không bao giờ in cả khối lỗi: đúng 1 dòng.
  if (res === "timeout") {
    opts.write(`mikrotik-axi: no answer within ${budget / 1000}s (router busy or unreachable)\n`);
    return;
  }
  if (exit !== 0) {
    const code = /^code: (\S+)$/m.exec(out)?.[1];
    const msg = /^error: "?(.*?)"?$/m.exec(out)?.[1] ?? "failed";
    opts.write(code === "UNREACHABLE" ? "mikrotik-axi: device unreachable\n" : `mikrotik-axi: ${msg}\n`);
    return;
  }
  opts.write(out);
}
