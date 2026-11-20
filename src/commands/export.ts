import { statSync } from "node:fs";
import { parseCommandArgs } from "../args.js";
import { connect, type Runtime } from "../context.js";
import { fail, maskSecrets } from "../errors.js";
import {
  commandLines,
  diffRsc,
  exportRoot,
  exportVersion,
  latestExport,
  readExport,
  redactLine,
  rscHash,
  saveExport,
} from "../export/rsc.js";
import { readResource } from "./health.js";
import { clip, renderList } from "../views/list.js";

/**
 * Export toàn bộ (`/export terse`) chỉ từ 7.25: bản 7.25 sửa lỗi hết bộ nhớ khi `:execute as-string`
 * trả output lớn (changelog 7.25, "console - prevent an out-of-memory condition…"). Bản cũ hơn ⇒
 * bắt buộc --section để output nhỏ. Đo CCR2004 7.25.1: toàn bộ 1388 dòng / 153 KB trong 0,7 s.
 */
export const FULL_EXPORT_MIN_VERSION = [7, 25] as const;
const LINE_LIMIT = 160;

export const EXPORT_HELP = `usage: mikrotik-axi export [--section <menu>] [flags]
       mikrotik-axi export diff [--section <menu>] [--against <file.rsc>] [flags]
description: Save the router configuration (\`/export terse\`) to a local .rsc file and print only its path, sha256 and line count — never the content. RouterOS hides password fields from a user without the \`sensitive\` policy, but script and scheduler sources are exported verbatim and can hold secrets: treat the file as private. \`export diff\` compares the live configuration with the newest saved export of the same section (or --against) by set of lines: +added / -removed per menu, plus menus whose order changed (firewall order is behaviour). Printed lines never show: a line that does not parse as \`/menu … verb …\` (<unparsed line N chars>); the value of a code-bearing field (source, script, any *-script, any on-*) or of anything that looks like RouterOS script (length, plus sha256 when long); cmd/entrypoint/value (length only); secret-like keys (password, secret, secrets, key, psk, pin, puk, token, community…), SNMP community names and VPN/PPPoE client users (<redacted>). Other values (comment, name…) get best-effort masking (key=value secrets, URL passwords, bearer tokens), not a guarantee. Works with a read-only user. A full export needs RouterOS >= ${FULL_EXPORT_MIN_VERSION.join(".")}; older versions need --section
flags[4]:
  --section <menu>: one menu tree, e.g. /ip/firewall or /ip/dhcp-server (default: whole configuration)
  --against <file.rsc>: export diff: compare with this file instead of the newest saved one
  --full: export diff: every changed line, uncut
  --device <name>: device from the profile
env[1]:
  MIKROTIK_AXI_EXPORT_DIR: where exports are saved (default %LOCALAPPDATA%\\mikrotik-axi\\exports, or $XDG_STATE_HOME/mikrotik-axi/exports)
examples[3]:
  mikrotik-axi export --section /ip/firewall
  mikrotik-axi export diff --section /ip/firewall
  mikrotik-axi export
`;

/** "/ip/firewall", "ip/firewall", "/ip firewall" ⇒ "/ip/firewall"; vắng ⇒ "/". Sai ⇒ exit 2. */
export function parseSection(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "" || raw.trim() === "/") return "/";
  const s = `/${raw.trim().replace(/^\/+/, "").replace(/\s+/g, "/").replace(/\/+$/, "")}`;
  if (!/^\/[a-z0-9][a-z0-9\-/]*[a-z0-9]$/.test(s) || s.includes("//")) {
    fail(`export: invalid --section ${raw}`, "VALIDATION_ERROR", ["Use a menu path such as /ip/firewall or /interface/vlan"]);
  }
  return s;
}

export function versionAtLeast(version: string | undefined, min: readonly number[]): boolean {
  const parts = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version ?? "")?.slice(1).map((x) => Number(x ?? 0));
  if (!parts) return false;
  for (let i = 0; i < min.length; i++) {
    const a = parts[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

export async function exportCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { positionals, global, flags } = parseCommandArgs(
    "export",
    args,
    {
      section: { type: "string", hint: "--section <menu>" },
      against: { type: "string", hint: "--against <file.rsc>" },
    },
    1,
  );
  const sub = positionals[0];
  if (sub !== undefined && sub !== "diff") {
    fail(`export: unknown sub-command ${sub}`, "VALIDATION_ERROR", ["Run `mikrotik-axi export --help` for usage"]);
  }
  if (flags["against"] !== undefined && sub !== "diff") {
    fail("export: --against only applies to `export diff`", "VALIDATION_ERROR");
  }
  const section = parseSection(flags["section"] as string | undefined);
  const root = exportRoot(rt.env, rt.platform);

  // --against kiểm TRƯỚC khi gọi router (sai ⇒ exit sớm, 0 request).
  const baseline = sub === "diff" ? resolveBaseline(flags["against"] as string | undefined, section) : undefined;

  const ctx = await connect(global, rt);
  if (section === "/") {
    const res = await readResource(ctx.client);
    if (!versionAtLeast(res.version, FULL_EXPORT_MIN_VERSION)) {
      fail(`full export needs RouterOS >= ${FULL_EXPORT_MIN_VERSION.join(".")} (${ctx.name} runs ${res.version ?? "unknown"})`, "VALIDATION_ERROR", [
        "Older versions can run out of memory on a large :execute as-string output: export one section, e.g. --section /ip/firewall",
      ]);
    }
  }
  const rsc = await ctx.client.exportConfig(section);
  const lines = commandLines(rsc);

  if (sub !== "diff") {
    const prev = latestExport(root, ctx.name, section);
    const prevLines = prev ? commandLines(readExport(prev)) : undefined;
    const path = saveExport(root, ctx.name, section, rsc);
    const sha = rscHash(lines);
    const changed = prevLines === undefined ? "first export of this section" : rscHash(prevLines) === sha ? "no" : "yes";
    return {
      section,
      saved: path,
      sha256: sha,
      lines: lines.length,
      bytes: statSync(path).size,
      version: exportVersion(rsc) ?? "unknown",
      changed_since_last: changed,
      help: [
        ...(changed === "yes" ? [`Run \`mikrotik-axi export diff --section ${section} --against "${prev}"\` to see what changed`] : []),
        "The file is never printed: open it locally if you need the content",
      ],
    };
  }

  // Vắng --against ⇒ bản mới nhất của ĐÚNG thiết bị đã chọn (biết tên sau connect).
  const basePath = baseline?.path ?? latestExport(root, ctx.name, section);
  if (!basePath) {
    fail(`no saved export of ${section} for ${ctx.name}`, "VALIDATION_ERROR", [
      `Run \`mikrotik-axi export${section === "/" ? "" : ` --section ${section}`}\` first to record a baseline`,
    ]);
  }
  const baseText = readExport(basePath);
  const d = diffRsc(commandLines(baseText), lines);
  const baseVersion = exportVersion(baseText);
  const liveVersion = exportVersion(rsc);
  const rows = [...d.removed.map((l) => ({ change: "-", line: l })), ...d.added.map((l) => ({ change: "+", line: l }))].map((r) => ({
    change: r.change,
    line: global.full ? redactLine(r.line, maskSecrets) : clip(redactLine(r.line, maskSecrets), LINE_LIMIT),
  }));
  const total = d.added.length + d.removed.length;
  const { out, help } = renderList(
    { key: "changes", rows, fields: ["change", "line"], available: ["change", "line"], command: `mikrotik-axi export diff --section ${section}` },
    global,
  );
  return {
    section,
    against: basePath,
    versions: baseVersion === liveVersion ? (liveVersion ?? "unknown") : `${baseVersion ?? "?"} -> ${liveVersion ?? "?"}`,
    summary: total === 0 && d.reordered.length === 0 ? "identical" : `+${d.added.length} -${d.removed.length} lines in ${d.menus.length} menus`,
    ...(d.menus.length ? { menus: d.menus } : {}),
    ...(d.reordered.length ? { reordered: d.reordered.join(", ") } : {}),
    ...(total ? out : {}),
    ...(baseVersion !== liveVersion
      ? { warning: "RouterOS version changed between the two exports: new default values can show up as changes" }
      : {}),
    ...(total || d.reordered.length
      ? { help: [...help, `Run \`mikrotik-axi export --section ${section}\` to record the current state as the new baseline`] }
      : {}),
  };
}

/** --against phải là file đọc được; vắng ⇒ tìm bản mới nhất SAU khi biết tên thiết bị. */
function resolveBaseline(against: string | undefined, section: string): { path?: string } {
  if (against === undefined) return {};
  let text: string;
  try {
    text = readExport(against);
  } catch (e) {
    fail(`export diff: cannot read ${against} (${(e as NodeJS.ErrnoException).code ?? "error"})`, "VALIDATION_ERROR");
  }
  if (!/^# .* by RouterOS /.test(text)) {
    fail(`export diff: ${against} is not a RouterOS export`, "VALIDATION_ERROR", [`Use a file saved by \`mikrotik-axi export --section ${section}\``]);
  }
  return { path: against };
}
