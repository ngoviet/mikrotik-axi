import { describe, expect, it } from "vitest";
import { formatDuration, normalize, parseDuration, toBool, toNumber } from "../../src/ros/normalize.js";
import { isSingleton } from "../../src/ros/menus.js";
import { redact } from "../../src/errors.js";

describe("toBool", () => {
  it('maps REST strings, treats a missing field as false, never Boolean("false")', () => {
    expect(toBool("true")).toBe(true);
    expect(toBool("yes")).toBe(true);
    expect(toBool("false")).toBe(false);
    expect(toBool("no")).toBe(false);
    expect(toBool(undefined)).toBe(false);
  });

  it("throws on garbage instead of guessing", () => {
    expect(() => toBool("maybe", "running")).toThrow(/running/);
  });
});

describe("durations", () => {
  it.each([
    ["1w5d4h12m3s", 7 * 86400 + 5 * 86400 + 4 * 3600 + 12 * 60 + 3],
    ["5s200ms", 5.2],
    ["00:01:02", 62],
    ["1d00:00:10", 86410],
    ["", undefined],
    ["soon", undefined],
  ])("parseDuration(%j)", (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it("formats the two largest units, weeks folded into days", () => {
    expect(formatDuration(parseDuration("1w5d4h12m3s")!)).toBe("12d4h");
    expect(formatDuration(3 * 3600 + 5)).toBe("3h");
    expect(formatDuration(42)).toBe("42s");
    expect(formatDuration(0)).toBe("0s");
  });
});

describe("normalize", () => {
  it("converts by schema and drops unknown fields", () => {
    const n = normalize({ running: "true", "cpu-load": "6", uptime: "1h", name: "x", extra: "y" }, {
      running: "bool",
      disabled: "bool",
      "cpu-load": "number",
      uptime: "duration",
      name: "string",
    });
    expect(n).toEqual({ running: true, disabled: false, "cpu-load": 6, uptime: 3600, name: "x" });
    expect(toNumber("abc")).toBeUndefined();
  });
});

describe("singleton registry (trap #4)", () => {
  it.each([
    ["/system/identity", true],
    ["/system/resource", true],
    ["/ipv6/settings", true],
    ["/tool/bandwidth-server", true],
    ["/tool/mac-server", true],
    ["/tool/netwatch", false],
    ["/system/health", false],
    ["/ip/route", false],
  ])("%s → %s", (menu, expected) => {
    expect(isSingleton(menu)).toBe(expected);
  });
});

describe("redact", () => {
  it("masks secrets and truncates", () => {
    expect(redact('{"name":"x","password":"hunter2"}')).toBe('{"name":"x","password":"***"}');
    expect(redact("token=abc&x=1")).toBe('token="***"&x=1');
    expect(redact("a".repeat(400))).toHaveLength(301);
  });
});
