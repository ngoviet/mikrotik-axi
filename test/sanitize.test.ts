import { describe, expect, it } from "vitest";
import { pseudonymizeIps, sanitize } from "../src/sanitize.js";

describe("fixture sanitizer", () => {
  it("masks secrets and PPPoE users", () => {
    expect(sanitize("/interface/pppoe-client", [{ name: "pppoe-out1", user: "subscriber@isp.example", password: "x" }])).toEqual([
      { name: "pppoe-out1", user: "***", password: "***" },
    ]);
    expect(sanitize("/ppp/secret", { name: "a", "wpa2-pre-shared-key": "k", secret: "s" })).toMatchObject({ secret: "***" });
  });

  it("pseudonymizes public IPv4 consistently, keeps private and CGNAT", () => {
    const a = pseudonymizeIps("93.184.216.34");
    expect(a).toMatch(/^(203\.0\.113|198\.51\.100)\.\d+$/);
    expect(pseudonymizeIps("ip 93.184.216.34/32 via 93.184.216.34")).toBe(`ip ${a}/32 via ${a}`);
    for (const ip of ["10.1.2.3", "192.168.100.1", "172.16.0.1", "100.64.0.1", "0.0.0.0"]) expect(pseudonymizeIps(ip)).toBe(ip);
  });

  it("replaces MACs and host names, deterministically", () => {
    const one = sanitize("/ip/dhcp-server/lease", { "mac-address": "F4:1E:57:D8:8B:C8", "host-name": "Phone-of-X" });
    expect(one).toEqual(sanitize("/ip/dhcp-server/lease", { "mac-address": "f4:1e:57:d8:8b:c8", "host-name": "Phone-of-X" }));
    expect((one as Record<string, string>)["mac-address"]).toMatch(/^02(:[0-9A-F]{2}){5}$/);
    expect((one as Record<string, string>)["host-name"]).toMatch(/^host-[0-9a-f]{4}$/);
  });
});
