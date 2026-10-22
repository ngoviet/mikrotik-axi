import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Ghi THẬT trên router (§9.2 "Live write"): chỉ chạy tay, chỉ chạm object vô hại.
//   MIKROTIK_AXI_LIVE_WRITE=1 pnpm test:live            (cần profile + user axi-rw)
//   MIKROTIK_AXI_TEST_RULE=*3B  (tuỳ chọn) .id của một filter rule có comment AXI_TEST_…
// pppoe restart / arp flush KHÔNG tự động hoá (gây gián đoạn): thử tay theo CLAUDE.md §9.2.
const BIN = fileURLToPath(new URL("../../dist/bin/mikrotik-axi.js", import.meta.url));
const live = process.env["MIKROTIK_AXI_LIVE_WRITE"] === "1";
const testRule = process.env["MIKROTIK_AXI_TEST_RULE"];

function run(args: string[]): { out: string; code: number | null } {
  const env = { ...process.env };
  delete env["MIKROTIK_AXI_READ_ONLY"];
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env });
  console.log(`$ mikrotik-axi ${args.join(" ")}  [exit ${r.status}]\n${r.stdout}`);
  return { out: r.stdout, code: r.status };
}

const snapshotOf = (out: string): string => JSON.parse(/^snapshot: (".*")$/m.exec(out)![1]!) as string;

describe.skipIf(!live)("live writes on AXI_TEST objects (MIKROTIK_AXI_LIVE_WRITE=1)", () => {
  const LIST = "AXI_TEST";
  const ADDR = "192.0.2.123"; // TEST-NET-1, không bao giờ là địa chỉ thật

  it("addr-list: dry-run → confirm → read back → no-op → revert", () => {
    run(["addr-list", "remove", LIST, ADDR, "--confirm"]); // dọn lần chạy trước (nếu có)
    const dry = run(["addr-list", "add", LIST, ADDR, "--comment", "AXI_TEST_live"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/^result: dry-run/m);

    const applied = run(["addr-list", "add", LIST, ADDR, "--comment", "AXI_TEST_live", "--confirm"]);
    expect(applied.code).toBe(0);
    expect(applied.out).toMatch(/^result: applied$/m);
    expect(run(["addr-list", "add", LIST, ADDR, "--confirm"]).out).toMatch(/^result: no-op$/m);

    const reverted = run(["revert", snapshotOf(applied.out), "--confirm"]);
    expect(reverted.code).toBe(0);
    expect(run(["addr-list", "remove", LIST, ADDR]).out).toMatch(/^result: no-op$/m);
  });

  it.skipIf(!testRule)("fw filter disable/enable on the AXI_TEST_ rule, then revert", () => {
    const listing = run(["fw", "filter", "--fields", "id,comment", "--full"]).out;
    const row = listing.split("\n").find((l) => l.trim().startsWith(`${testRule},`));
    // Chốt an toàn: tuyệt đối không đụng rule nào không mang comment AXI_TEST_.
    expect(row, `rule ${testRule} not found`).toBeDefined();
    expect(row!.trim().split(",")[1]).toMatch(/^"?AXI_TEST_/);

    const applied = run(["fw", "filter", "disable", testRule as string, "--confirm"]);
    expect(applied.code).toBe(0);
    if (/^result: applied$/m.test(applied.out)) {
      const reverted = run(["revert", snapshotOf(applied.out), "--confirm"]);
      expect(reverted.code).toBe(0);
      expect(reverted.out).toMatch(/^verified: disabled=false$/m);
    }
  });
});
