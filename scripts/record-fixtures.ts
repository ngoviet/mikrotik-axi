import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCommandArgs } from "../src/args.js";
import { connect, defaultRuntime } from "../src/context.js";
import { isSingleton } from "../src/ros/menus.js";
import { sanitize } from "../src/sanitize.js";

// pnpm fixtures:record --device ccr2004 [--out test/fixtures/ccr2004-recorded]
// CHỈ GET (READ_ONLY ép bật), qua identity guard, dùng user chỉ đọc (axi-ro). Ghi bản ĐÃ làm
// sạch + ẩn danh. Đọc lại trước khi commit: tên comment/interface vẫn giữ nguyên.

// Mọi menu mà các lệnh đọc dùng tới — giữ khớp với src/commands/*.
const MENUS = [
  "/system/identity",
  "/system/resource",
  "/system/clock",
  "/system/health",
  "/system/package/update",
  "/interface",
  "/interface/pppoe-client",
  "/interface/vrrp",
  "/interface/vlan",
  "/interface/ethernet",
  "/interface/bridge/port",
  "/ip/address",
  "/ip/route",
  "/routing/rule",
  "/ip/dhcp-server",
  "/ip/dhcp-server/lease",
  "/ip/pool",
  "/ip/pool/used",
  "/ip/firewall/filter",
  "/ip/firewall/nat",
  "/ip/firewall/mangle",
  "/ip/firewall/raw",
  "/ip/service",
  "/tool/mac-server",
  "/tool/mac-server/mac-winbox",
  "/tool/netwatch",
  "/log",
];

const { global, flags } = parseCommandArgs("fixtures:record", process.argv.slice(2), {
  out: { type: "string", hint: "--out <dir>" },
});
const rt = defaultRuntime();
rt.env = { ...rt.env, MIKROTIK_AXI_READ_ONLY: "1" };
const ctx = await connect(global, rt);
const out = typeof flags["out"] === "string" ? flags["out"] : join("test", "fixtures", `${ctx.name}-recorded`);
mkdirSync(out, { recursive: true });

let failed = 0;
for (const menu of MENUS) {
  try {
    const data = isSingleton(menu) ? await ctx.client.single(menu) : await ctx.client.list(menu);
    const file = join(out, `${menu.slice(1).replaceAll("/", "__")}.json`);
    writeFileSync(file, `${JSON.stringify(sanitize(menu, data), null, 2)}\n`);
    console.log(`ok   ${menu} (${Array.isArray(data) ? `${data.length} rows` : "object"})`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${menu}: ${(e as Error).message}`);
  }
}
console.log(`\nwrote ${MENUS.length - failed}/${MENUS.length} menus to ${out} — review before committing`);
process.exit(failed ? 1 : 0);
