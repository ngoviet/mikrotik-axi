import { AxiError } from "axi-sdk-js";
import { parseCommandArgs } from "../args.js";
import { effectiveEnv } from "../config/env.js";
import { loadProfile, profilePath } from "../config/profile.js";
import { connect, type Runtime } from "../context.js";
import { formatDuration, normalize } from "../ros/normalize.js";
import { assertFields, renderList, type Row } from "../views/list.js";

export const DEVICES_HELP = `usage: mikrotik-axi devices [flags]
description: Every device in the profile checked in parallel: identity guard, RouterOS version, uptime. One failing device never hides the others
flags[2]:
  --fields a,b: columns name,status,identity,version (also url,board,uptime)
  --profile <path>: profile file to use
`;

const FIELDS = ["name", "status", "identity", "version", "url", "board", "uptime"];

export async function devicesCommand(args: string[], rt: Runtime): Promise<Record<string, unknown>> {
  const { global } = parseCommandArgs("devices", args);
  assertFields(global.fields, FIELDS);
  const loaded = loadProfile(profilePath(global.profile, effectiveEnv(rt.env), rt.platform));
  const rows: Row[] = await Promise.all(
    Object.entries(loaded.profile.devices).map(async ([name, dev]): Promise<Row> => {
      const base = { name, url: dev.url, identity: "", version: "", board: "", uptime: "" };
      try {
        const ctx = await connect({ ...global, device: name, noIdentityCheck: false }, rt);
        const r = normalize(await ctx.client.single("/system/resource", { proplist: ["version", "board-name", "uptime"] }), {
          version: "string",
          "board-name": "string",
          uptime: "duration",
        });
        return {
          ...base,
          status: "ok",
          identity: ctx.identity,
          version: r.version ?? "",
          board: r["board-name"] ?? "",
          uptime: r.uptime === undefined ? "" : formatDuration(r.uptime),
        };
      } catch (e) {
        // Mã lỗi gọn làm trạng thái (UNREACHABLE, IDENTITY_MISMATCH, AUTH_ERROR, CONFIG_ERROR…).
        const code = e instanceof AxiError ? e.code.toLowerCase().replace(/_/g, "-") : "error";
        return { ...base, status: code, identity: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  const ok = rows.filter((r) => r["status"] === "ok").length;
  const { out, help } = renderList(
    { key: "devices", rows, fields: ["name", "status", "identity", "version"], available: FIELDS, command: "mikrotik-axi devices", textFields: ["identity"] },
    global,
  );
  return {
    ok: `${ok}/${rows.length}`,
    ...out,
    help: [...help, "Run `mikrotik-axi home --device <name>` for one device"],
  };
}
