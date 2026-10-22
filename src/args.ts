import { parseArgs } from "node:util";
import { fail } from "./errors.js";

export interface FlagSpec {
  type: "string" | "boolean";
  hint: string;
}

/** Flag toàn cục — mọi lệnh đều nhận (§3). */
export const GLOBAL_FLAGS = {
  device: { type: "string", hint: "--device <name>" },
  profile: { type: "string", hint: "--profile <path>" },
  fields: { type: "string", hint: "--fields a,b" },
  full: { type: "boolean", hint: "--full" },
  "no-identity-check": { type: "boolean", hint: "--no-identity-check" },
  help: { type: "boolean", hint: "--help" },
} as const satisfies Record<string, FlagSpec>;

export interface GlobalFlags {
  device?: string;
  profile?: string;
  fields?: string[];
  full: boolean;
  noIdentityCheck: boolean;
}

export interface ParsedArgs {
  positionals: string[];
  global: GlobalFlags;
  flags: Record<string, string | boolean | undefined>;
}

/** Flag lạ / thiếu giá trị ⇒ VALIDATION_ERROR (exit 2) kèm danh sách flag hợp lệ. */
export function parseCommandArgs(
  command: string,
  args: string[],
  extra: Record<string, FlagSpec> = {},
  maxPositionals = 0,
): ParsedArgs {
  const specs: Record<string, FlagSpec> = { ...GLOBAL_FLAGS, ...extra };
  const valid = Object.values(specs).map((s) => s.hint);
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      options: Object.fromEntries(Object.entries(specs).map(([k, s]) => [k, { type: s.type }])),
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    fail(`${command}: ${(e as Error).message.split("\n")[0]}`, "VALIDATION_ERROR", [`Valid flags: ${valid.join(", ")}`]);
  }
  if (parsed.positionals.length > maxPositionals) {
    fail(`${command}: unexpected argument ${parsed.positionals[maxPositionals]}`, "VALIDATION_ERROR", [
      `Run \`mikrotik-axi ${command} --help\` for usage`,
    ]);
  }
  const v = parsed.values as Record<string, string | boolean | undefined>;
  const str = (k: string): string | undefined => (typeof v[k] === "string" ? (v[k] as string) : undefined);
  const fields = str("fields");
  return {
    positionals: parsed.positionals,
    flags: v,
    global: {
      ...(str("device") ? { device: str("device") } : {}),
      ...(str("profile") ? { profile: str("profile") } : {}),
      ...(fields ? { fields: fields.split(",").map((f) => f.trim()).filter(Boolean) } : {}),
      full: v["full"] === true,
      noIdentityCheck: v["no-identity-check"] === true,
    },
  };
}
