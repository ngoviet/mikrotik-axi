import { readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import {
  extractNpmShimScriptPath,
  installSessionStartHooks,
  resolvePortableHookCommand,
  sessionStartHookStatus,
  uninstallSessionStartHooks,
} from "axi-sdk-js";
import { parseCommandArgs } from "../args.js";
import type { Runtime } from "../context.js";
import { fail } from "../errors.js";

export const HOOK_MARKER = "mikrotik-axi";
export const HOOK_BIN = "mikrotik-axi-hook";

export const SETUP_HELP = `usage: mikrotik-axi setup hooks [--scope user|project] [--status] [--remove]
description: Install (idempotent), inspect or remove the SessionStart hook for Claude Code, Codex and OpenCode. The hook runs \`${HOOK_BIN}\`: the home view, read-only, 3 s budget, empty output outside MIKROTIK_AXI_HOOK_DIRS
flags[3]:
  --scope user|project: user config (default) or the current repository
  --status: report what is installed, change nothing
  --remove: remove only mikrotik-axi hook entries
env[1]:
  MIKROTIK_AXI_HOOK_DIRS: ${delimiter}-separated project dirs where the hook prints; elsewhere it prints nothing (0 tokens)
`;

export async function setupCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { positionals, flags } = parseCommandArgs(
    "setup",
    args,
    {
      scope: { type: "string", hint: "--scope user|project" },
      status: { type: "boolean", hint: "--status" },
      remove: { type: "boolean", hint: "--remove" },
    },
    1,
  );
  if (positionals[0] !== "hooks") {
    fail(`setup: expected \`hooks\`${positionals[0] ? `, got ${positionals[0]}` : ""}`, "VALIDATION_ERROR", ["Run `mikrotik-axi setup hooks`"]);
  }
  const scope = flags["scope"] ?? "user";
  if (scope !== "user" && scope !== "project") {
    fail(`setup hooks: --scope must be user or project, got ${String(scope)}`, "VALIDATION_ERROR");
  }
  const execPath = rt.hookBin ?? defaultHookBin();
  const base = {
    marker: HOOK_MARKER,
    execPath,
    scope,
    ...(rt.homeDir ? { homeDir: rt.homeDir } : {}),
    ...(rt.projectDir ? { projectDir: rt.projectDir } : {}),
  } as const;

  if (flags["status"]) return statusOutput(sessionStartHookStatus(base));

  const errors: string[] = [];
  if (flags["remove"]) {
    uninstallSessionStartHooks({ ...base, onError: (m) => errors.push(m) });
    return { ...statusOutput(sessionStartHookStatus(base)), ...(errors.length ? { errors } : {}) };
  }

  const command = resolvePortableHookCommand(execPath, [HOOK_BIN], HOOK_MARKER, pathContext(rt.env));
  // Windows không chạy thẳng được file .js: hook phải là lệnh trần (shim npm/pnpm trên PATH).
  if (command !== HOOK_BIN && (rt.platform ?? process.platform) === "win32") {
    fail(`${HOOK_BIN} is not on PATH, so agents could not run the hook`, "CONFIG_ERROR", [
      "Install globally first: `npm i -g mikrotik-axi` (or `pnpm link --global` from a checkout)",
      "Then run `mikrotik-axi setup hooks` again",
    ]);
  }
  installSessionStartHooks({
    ...base,
    binaryNames: [HOOK_BIN],
    timeoutSeconds: 5,
    shouldInstall: () => true,
    onError: (m) => errors.push(m),
  });
  return {
    setup: "hooks installed or already up to date",
    command,
    ...statusOutput(sessionStartHookStatus(base)),
    ...(errors.length ? { errors } : {}),
    help: [
      `Set MIKROTIK_AXI_HOOK_DIRS to the project dirs that should see router context (${delimiter}-separated)`,
      "Run `mikrotik-axi setup hooks --status` to verify",
    ],
  };
}

function statusOutput(s: ReturnType<typeof sessionStartHookStatus>): Record<string, unknown> {
  return {
    scope: s.scope,
    claude: `${s.claude.installed ? "installed" : "not installed"} (${s.claude.path})`,
    codex: `${s.codex.installed ? "installed" : "not installed"} (${s.codex.path})${s.codex.installed && !s.codex.userFeatureEnabled ? ", hooks feature off" : ""}`,
    opencode: `${s.opencode.installed ? "installed" : "not installed"} (${s.opencode.path})`,
  };
}

function defaultHookBin(): string {
  const self = process.argv[1] ?? "";
  let dir: string;
  try {
    dir = dirname(realpathSync(self));
  } catch {
    dir = dirname(resolve(self));
  }
  return join(dir, `${HOOK_BIN}.js`);
}

// Bản sao ngữ cảnh PATH của SDK (hàm gốc không export) — để biết TRƯỚC khi ghi file cấu hình
// hook sẽ là lệnh trần hay đường dẫn tuyệt đối.
function pathContext(env: Runtime["env"]) {
  const rawPath = env["PATH"] ?? env["Path"] ?? "";
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile() ? realpathSync(p) : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    pathEntries: rawPath.split(delimiter).filter(Boolean),
    pathExtensions: process.platform === "win32" ? ["", ...(env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";")] : [""],
    resolveRealPath: isFile,
    resolveShimTarget: (shim: string) => {
      try {
        const rel = extractNpmShimScriptPath(readFileSync(shim, "utf8"));
        return rel ? realpathSync(resolve(dirname(shim), rel)) : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
