import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSection, versionAtLeast } from "../src/commands/export.js";
import { maskSecrets } from "../src/errors.js";
import { commandLines, diffRsc, menuOf, parseLine, redactLine, rscHash, tokenizeLine } from "../src/export/rsc.js";
import type { Dataset } from "./helpers/fake-router.js";
import { fakeRouter, loadDataset } from "./helpers/fake-router.js";
import { CREDS, runCli } from "./helpers/run.js";

const HEAD = (v = "7.25.1") =>
  `# 2026-11-21 03:29:24 by RouterOS ${v}\r\n# software id = TEST-0000\r\n#\r\n# model = CCR2004-16G-2S+\r\n# serial number = X0000000\r\n`;

const FW_A = `${HEAD()}/ip firewall address-list add address=192.0.2.0/24 list=LAN\r\n/ip firewall filter add action=accept chain=input comment=A\r\n/ip firewall filter add action=drop chain=input comment=B\r\n`;

function setup(exports: Record<string, string>, opts: { version?: string; readOnly?: boolean } = {}) {
  const ds: Dataset = loadDataset("ccr2004");
  ds["/export"] = exports;
  if (opts.version) (ds["/system/resource"] as Record<string, string>)["version"] = opts.version;
  const router = fakeRouter(ds, { ...CREDS, readOnly: opts.readOnly ?? true });
  const dir = mkdtempSync(join(tmpdir(), "axi-export-"));
  const run = (argv: string[]) => runCli(argv, { transport: router.transport, env: { MIKROTIK_AXI_EXPORT_DIR: dir } });
  return { ds, router, dir, run };
}

describe("rsc helpers", () => {
  it("commandLines drops comments/CR and joins continuation lines", () => {
    const text = `${HEAD()}/system script add name=x source=":log info a\\\r\n    \\n:log info b"\r\n\r\n/ip dns set servers=9.9.9.9\r\n`;
    expect(commandLines(text)).toEqual(['/system script add name=x source=":log info a\\n:log info b"', "/ip dns set servers=9.9.9.9"]);
  });

  it("hash ignores the export header (timestamp, serial)", () => {
    const a = commandLines(FW_A);
    const b = commandLines(FW_A.replace("03:29:24", "09:00:00").replace("X0000000", "Y1111111"));
    expect(rscHash(a)).toBe(rscHash(b));
  });

  it("tokenizeLine keeps quoted values (with escaped quotes) whole", () => {
    expect(tokenizeLine('/system script add name=x source=":put \\"a b\\"" policy=read')).toEqual([
      "/system",
      "script",
      "add",
      "name=x",
      'source=":put \\"a b\\""',
      "policy=read",
    ]);
  });

  it("redactLine hides code-bearing keys by family, script-like values anywhere, then applies the mask", () => {
    const mask = (s: string) => s.replace(/password=\S+/g, "password=***");
    // Thân script dài ⇒ kèm băm; giá trị ngắn ⇒ không băm (băm giá trị ngắn dò được bằng đoán).
    expect(redactLine('/system script add name=x source=":local pass \\"zz\\"; :log info done"', mask)).toMatch(
      /^\/system script add name=x source=<redacted \d+ chars, sha256 [0-9a-f]{8}>$/,
    );
    expect(redactLine("/container envs add key=K list=l value=v1", mask)).toBe("/container envs add key=<redacted> list=l value=<redacted 2 chars>");
    expect(redactLine("/ip pool add name=value", mask)).toBe("/ip pool add name=value");
    expect(redactLine('/tool e-mail set password=abc comment="x"', mask)).toBe('/tool e-mail set password=<redacted> comment="x"');
    // Họ khoá: on-*, *-script, cmd, entrypoint (review lần 2: VRRP on-master/on-backup/on-fail, DHCPv6 binding-script).
    for (const key of ["on-master", "on-backup", "on-fail", "on-message", "on-alert", "binding-script", "lease-script", "cmd", "entrypoint"]) {
      expect(redactLine(`/x add ${key}="SECRET-1"`, mask), key).toBe(`/x add ${key}=<redacted 8 chars>`);
    }
    // Giá trị trông như script ở trường lạ.
    expect(redactLine('/x add foo=":global t \\"SECRET-2\\""', mask)).not.toContain("SECRET-2");
    expect(redactLine('/x add foo="a $tok b"', mask)).not.toContain("$tok");
    // Bình thường giữ nguyên.
    expect(redactLine('/ip firewall filter add action=drop chain=input comment="drop: all; from WAN"', mask)).toBe(
      '/ip firewall filter add action=drop chain=input comment="drop: all; from WAN"',
    );
  });

  it("secret key families and menu-specific secrets are fully redacted; the marker survives the mask (review round 3)", () => {
    const mask = maskSecrets;
    const line = '/x set secrets=s1 pin=1234 sim-pin=4321 puk=99999999 psk=p1 wpa2-pre-shared-key="a b c" private-key="k==" trap-community=t1 password="x y"';
    const out = redactLine(line, mask);
    for (const s of ["s1", "1234", "4321", "99999999", "p1", "a b c", "k==", "t1", "x y"]) expect(out, s).not.toContain(s);
    expect(out).toBe(
      "/x set secrets=<redacted> pin=<redacted> sim-pin=<redacted> puk=<redacted> psk=<redacted> wpa2-pre-shared-key=<redacted> private-key=<redacted> trap-community=<redacted> password=<redacted>",
    );
    expect(redactLine("/snmp community add addresses=10.0.0.0/8 name=private", mask)).toBe("/snmp community add addresses=10.0.0.0/8 name=<redacted>");
    expect(redactLine("/interface pppoe-client add name=pppoe-out1 user=isp-account-1", mask)).toBe("/interface pppoe-client add name=pppoe-out1 user=<redacted>");
    expect(redactLine("/ip hotspot user add name=u1", mask)).toBe("/ip hotspot user add name=u1");
    // Review vòng 4: khoá WEP, khoá MACsec, identity ZeroTier, chuỗi AT có PIN.
    expect(redactLine("/interface wireless security-profiles add name=wep static-key-0=SECRET-50 static-transmit-key=key-0", mask)).toBe(
      "/interface wireless security-profiles add name=wep static-key-0=<redacted> static-transmit-key=<redacted>",
    );
    expect(redactLine("/interface macsec add interface=ether2 name=macsec1 cak=SECRET-51 ckn=00", mask)).toBe("/interface macsec add interface=ether2 name=macsec1 cak=<redacted> ckn=00");
    expect(redactLine("/zerotier set identity=SECRET-52", mask)).toBe("/zerotier set identity=<redacted>");
    expect(redactLine('/interface lte apn add name=a modem-init="AT+CPIN=1234"', mask)).toBe("/interface lte apn add name=a modem-init=<redacted 12 chars>");
  });

  it("a line that does not parse as /menu … verb … is never printed, and its menu is '?'", () => {
    const mask = maskSecrets;
    for (const bad of ["/system script hunter2 foo=bar", "SECRET-TAIL\\\"\"", "/System script add x=1", "add name=x source=y"]) {
      expect(redactLine(bad, mask), bad).toMatch(/^<unparsed line \d+ chars(, sha256 [0-9a-f]{8})?>$/);
      expect(menuOf(bad), bad).toBe("?");
    }
    expect(parseLine("/interface ethernet set [ find default-name=ether1 ] comment=x")).toEqual({ menu: "/interface ethernet", verb: "set" });
    expect(parseLine("/ip firewall connection tracking set enabled=auto")).toEqual({ menu: "/ip firewall connection tracking", verb: "set" });
  });

  it("joins a continuation after an escaped backslash: odd number of trailing backslashes (review round 3)", () => {
    const NONTERSE = ["# 2026-11-21 03:29:24 by RouterOS 7.25.1", "/system script", 'add name=b source=":local d \\"C:\\\\\\', '    SECRET-43-AFTER-BSLASH\\""'].join("\r\n");
    expect(commandLines(NONTERSE)).toEqual(['/system script add name=b source=":local d \\"C:\\\\SECRET-43-AFTER-BSLASH\\""']);
    // Hai dấu `\` cuối dòng là một `\` đã thoát, không phải nối dòng.
    expect(commandLines(`${HEAD()}/x add a="b\\\\"\r\n/x add c=d\r\n`)).toEqual(['/x add a="b\\\\"', "/x add c=d"]);
  });

  it("commandLines turns a non-terse export into terse lines (menu on every line)", () => {
    const text = `${HEAD()}/container envs\r\nadd key=K list=l value=S1\r\n/system identity\r\nset name=R1\r\n`;
    expect(commandLines(text)).toEqual(["/container envs add key=K list=l value=S1", "/system identity set name=R1"]);
  });

  it("menuOf stops at the verb or first key=value", () => {
    expect(menuOf("/ip firewall filter add chain=input")).toBe("/ip firewall filter");
    expect(menuOf("/ip dns set servers=1.1.1.1")).toBe("/ip dns");
    expect(menuOf("/system identity set name=x")).toBe("/system identity");
  });

  it("diff is by set of lines: order across menus is not a change, order inside a menu is reported", () => {
    const base = ["/a add x=1", "/b add y=1", "/b add y=2"];
    expect(diffRsc(base, ["/b add y=1", "/b add y=2", "/a add x=1"])).toMatchObject({ added: [], removed: [], reordered: [] });
    expect(diffRsc(base, ["/a add x=1", "/b add y=2", "/b add y=1"]).reordered).toEqual(["/b"]);
    const d = diffRsc(base, ["/a add x=1", "/b add y=1", "/b add y=3", "/b add y=3"]);
    expect(d.added).toEqual(["/b add y=3", "/b add y=3"]);
    expect(d.removed).toEqual(["/b add y=2"]);
    expect(d.menus).toEqual([{ menu: "/b", added: 2, removed: 1 }]);
  });

  it("parseSection normalises menu forms and rejects junk", () => {
    expect(parseSection(undefined)).toBe("/");
    expect(parseSection("ip/firewall")).toBe("/ip/firewall");
    expect(parseSection("/ip firewall")).toBe("/ip/firewall");
    expect(() => parseSection("/ip/firewall; /system reboot")).toThrow(/invalid --section/);
  });

  it("versionAtLeast", () => {
    expect(versionAtLeast("7.25.1 (stable)", [7, 25])).toBe(true);
    expect(versionAtLeast("7.24.4 (stable)", [7, 25])).toBe(false);
    expect(versionAtLeast("8.0", [7, 25])).toBe(true);
    expect(versionAtLeast(undefined, [7, 25])).toBe(false);
  });
});

describe("export", () => {
  it("saves the file, prints path + sha256 + lines, never the content; works for a read-only user", async () => {
    const { run, dir, router } = setup({ "/ip/firewall": FW_A });
    const r = await run(["export", "--section", "/ip/firewall"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^section: \/ip\/firewall$/m);
    expect(r.out).toMatch(/^lines: 3$/m);
    expect(r.out).toMatch(/^changed_since_last: first export of this section$/m);
    expect(r.out).not.toContain("address-list add");
    const files = readdirSync(join(dir, "ccr2004"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/_ip-firewall\.rsc$/);
    expect(readFileSync(join(dir, "ccr2004", files[0]!), "utf8")).toContain("comment=B");
    const exec = router.requests.find((q) => q.url.pathname === "/rest/execute")!;
    expect(JSON.parse(exec.body!)).toEqual({ script: "/ip/firewall/export terse", "as-string": "" });
  });

  it("second identical export reports no change", async () => {
    const { run } = setup({ "/ip/firewall": FW_A });
    await run(["export", "--section", "/ip/firewall"]);
    const r = await run(["export", "--section", "/ip/firewall"]);
    expect(r.out).toMatch(/^changed_since_last: no$/m);
  });

  it("full export is refused below 7.25 (OOM fix) before any export request", async () => {
    const { run, router } = setup({ "/": FW_A }, { version: "7.24.4 (stable)" });
    const r = await run(["export"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("full export needs RouterOS >= 7.25");
    expect(router.requests.some((q) => q.url.pathname === "/rest/execute")).toBe(false);
  });

  it("full export on 7.25+ uses /export terse", async () => {
    const { run, router } = setup({ "/": FW_A }, { version: "7.25.1 (stable)" });
    const r = await run(["export"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^section: \/$/m);
    expect(JSON.parse(router.requests.find((q) => q.url.pathname === "/rest/execute")!.body!).script).toBe("/export terse");
  });

  it("an in-band script error (HTTP 200) becomes ROS_ERROR, nothing saved", async () => {
    const { run, dir } = setup({});
    const r = await run(["export", "--section", "/ip/firewallx"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("export of /ip/firewallx failed: syntax error");
    expect(() => readdirSync(join(dir, "ccr2004"))).toThrow();
  });

  it("bad section and unknown sub-command exit 2 with no request", async () => {
    const { run, router } = setup({});
    expect((await run(["export", "--section", "/ip/x;y"])).code).toBe(2);
    expect((await run(["export", "show"])).code).toBe(2);
    expect((await run(["export", "--against", "x.rsc"])).code).toBe(2);
    expect(router.requests).toHaveLength(0);
  });
});

describe("export diff", () => {
  it("needs a baseline", async () => {
    const { run } = setup({ "/ip/firewall": FW_A });
    const r = await run(["export", "diff", "--section", "/ip/firewall"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("no saved export of /ip/firewall for ccr2004");
  });

  it("identical → summary identical, no table", async () => {
    const { run } = setup({ "/ip/firewall": FW_A });
    await run(["export", "--section", "/ip/firewall"]);
    const r = await run(["export", "diff", "--section", "/ip/firewall"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^summary: identical$/m);
    expect(r.out).not.toContain("changes[");
  });

  it("reports added/removed per menu, masks secrets, flags reorder", async () => {
    const { run, ds } = setup({ "/ip/firewall": FW_A });
    await run(["export", "--section", "/ip/firewall"]);
    (ds["/export"] as Record<string, string>)["/ip/firewall"] =
      `${HEAD()}/ip firewall address-list add address=192.0.2.0/24 list=LAN\r\n/ip firewall filter add action=drop chain=input comment=B\r\n/ip firewall filter add action=accept chain=input comment=A\r\n/ip firewall nat add action=dst-nat chain=dstnat comment="password=hunter2"\r\n`;
    const r = await run(["export", "diff", "--section", "/ip/firewall"]);
    expect(r.out).toMatch(/^summary: \+1 -0 lines in 1 menus$/m);
    expect(r.out).toMatch(/^reordered: \/ip firewall filter$/m);
    expect(r.out).toContain("+,");
    expect(r.out).not.toContain("hunter2");
  });

  it("never prints script bodies or container env values, even with --full (review repro)", async () => {
    const SCRIPT_BASE = `${HEAD()}/system script add name=ddns owner=ops source=":log info start"\r\n/container envs add key=DB_PASS list=app value=plain1\r\n`;
    const SCRIPT_NEW =
      `${HEAD()}/system script add name=ddns owner=ops source=":local ddnspass \\"hunter2-PW\\";:global apiToken \\"tok-ABC123\\";/tool fetch url=\\"https://api.telegram.org/bot123456:AAE-SECRETBOT/sendMessage\\" keep-result=no"\r\n` +
      `/container envs add key=DB_PASS list=app value=s3cr3t-env\r\n` +
      `/system scheduler add name=t on-event="/tool fetch url=\\"https://user:pw-in-url@example.com/x\\"" interval=1d\r\n` +
      // Review lần 2: các trường script ngoài danh sách cũ.
      `/interface vrrp add interface=ether1 name=vrrp1 on-master=":local pw \\"SECRET-01-VRRP-MASTER\\"" on-backup=":local pw \\"SECRET-02-VRRP-BACKUP\\"" on-fail=":global t \\"SECRET-03-VRRP-FAIL\\"" vrid=1\r\n` +
      `/ipv6 dhcp-server add name=s binding-script=":global t \\"SECRET-04-BINDING\\""\r\n`;
    const { run, ds } = setup({ "/system/script": SCRIPT_BASE });
    await run(["export", "--section", "/system/script"]);
    (ds["/export"] as Record<string, string>)["/system/script"] = SCRIPT_NEW;
    for (const argv of [["export", "diff", "--section", "/system/script"], ["export", "diff", "--section", "/system/script", "--full"]]) {
      const r = await run(argv);
      expect(r.code).toBe(0);
      for (const secret of ["hunter2-PW", "tok-ABC123", "AAE-SECRETBOT", "s3cr3t-env", "plain1", "pw-in-url", "SECRET-01", "SECRET-02", "SECRET-03", "SECRET-04"]) {
        expect(r.out, `${argv.join(" ")} leaks ${secret}`).not.toContain(secret);
      }
      expect(r.out).toMatch(/source=<redacted \d+ chars, sha256 [0-9a-f]{8}>/);
      expect(r.out).toContain("value=<redacted ");
    }
  });

  it("a non-terse --against file cannot leak env values either (review repro)", async () => {
    const { run } = setup({ "/container": `${HEAD()}/container envs add key=K list=l value=SECRET-31-LIVE\r\n` });
    const old = join(mkdtempSync(join(tmpdir(), "axi-old-")), "nonterse.rsc");
    writeFileSync(old, `${HEAD()}/container envs\r\nadd key=K list=l value=SECRET-30-ENV-NONTERSE\r\n`);
    const r = await run(["export", "diff", "--section", "/container", "--against", old, "--full"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("SECRET-30");
    expect(r.out).not.toContain("SECRET-31");
    expect(r.out).toMatch(/^summary: \+1 -1 lines in 1 menus$/m);
  });

  it("review round 3 repro: a non-terse --against file with an escaped backslash at a wrap leaks nothing, not even in the menus table", async () => {
    const { run } = setup({ "/system/script": HEAD() });
    const file = join(mkdtempSync(join(tmpdir(), "axi-old-")), "bslash.rsc");
    writeFileSync(file, ["# 2026-11-21 03:29:24 by RouterOS 7.25.1", "/system script", 'add name=b source=":local d \\"C:\\\\\\', '    SECRET-43-AFTER-BSLASH\\""', "orphan-SECRET-44 tail"].join("\r\n"));
    for (const extra of [[], ["--full"]]) {
      const r = await run(["export", "diff", "--section", "/system/script", "--against", file, ...extra]);
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("SECRET-43");
      expect(r.out).not.toContain("SECRET-44");
      expect(r.out).toMatch(/^ {2}"?\/system script"?,0,1$/m);
      expect(r.out).toMatch(/^ {2}"?\?"?,0,1$/m);
    }
  });

  it("--against a hand-picked file; version change warns", async () => {
    const { run } = setup({ "/ip/firewall": FW_A });
    const old = join(mkdtempSync(join(tmpdir(), "axi-old-")), "old.rsc");
    writeFileSync(old, FW_A.replace("RouterOS 7.25.1", "RouterOS 7.24.4").replace("comment=B\r\n", "comment=B\r\n/ip firewall raw add chain=prerouting\r\n"));
    const r = await run(["export", "diff", "--section", "/ip/firewall", "--against", old]);
    expect(r.out).toMatch(/^versions: 7\.24\.4 -> 7\.25\.1$/m);
    expect(r.out).toMatch(/^summary: \+0 -1 lines in 1 menus$/m);
    expect(r.out).toContain("warning:");
  });

  it("--against a non-export file exits 2 before any request", async () => {
    const { run, router } = setup({});
    const bad = join(mkdtempSync(join(tmpdir(), "axi-bad-")), "x.rsc");
    writeFileSync(bad, "hello");
    expect((await run(["export", "diff", "--against", bad])).code).toBe(2);
    expect(router.requests).toHaveLength(0);
  });
});
