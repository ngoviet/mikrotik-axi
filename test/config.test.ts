import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { describe, expect, it } from "vitest";
import { effectiveEnv, parseEnvFile, readCredentials } from "../src/config/env.js";
import { loadProfile, profilePath, selectDevice, validateProfile } from "../src/config/profile.js";

function catchAxi(fn: () => unknown): AxiError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AxiError);
    return e as AxiError;
  }
  throw new Error("expected an AxiError");
}

const tmp = () => mkdtempSync(join(tmpdir(), "mikrotik-axi-"));

describe("profile lookup order", () => {
  it("--profile beats env beats the platform default", () => {
    expect(profilePath("/a.json", { MIKROTIK_AXI_PROFILE: "/b.json" })).toBe("/a.json");
    expect(profilePath(undefined, { MIKROTIK_AXI_PROFILE: "/b.json" })).toBe("/b.json");
    expect(profilePath(undefined, { APPDATA: "C:\\Users\\x\\AppData\\Roaming" }, "win32")).toBe(
      join("C:\\Users\\x\\AppData\\Roaming", "mikrotik-axi", "profile.json"),
    );
    expect(profilePath(undefined, { XDG_CONFIG_HOME: "/home/x/.config" }, "linux")).toBe(
      join("/home/x/.config", "mikrotik-axi", "profile.json"),
    );
  });

  it("missing profile explains where to put one", () => {
    const e = catchAxi(() => loadProfile(join(tmp(), "nope.json")));
    expect(e.code).toBe("CONFIG_ERROR");
    expect(e.suggestions.join(" ")).toContain("profiles/example.json");
  });

  it("accepts a UTF-8 BOM (Notepad)", () => {
    const p = join(tmp(), "p.json");
    writeFileSync(p, `\uFEFF${JSON.stringify({ devices: { a: { url: "https://10.0.0.1" } } })}`);
    expect(loadProfile(p).profile.devices["a"]?.url).toBe("https://10.0.0.1");
  });
});

describe("profile validation", () => {
  it("accepts the shipped example", async () => {
    const { readFileSync } = await import("node:fs");
    const example = JSON.parse(readFileSync(new URL("../profiles/example.json", import.meta.url), "utf8"));
    expect(() => validateProfile(example)).not.toThrow();
  });

  it.each([
    [{ devices: {} }, "devices must be a non-empty object"],
    [{ devices: { a: { url: "192.168.100.1" } } }, "devices.a.url"],
    [{ devices: { a: { url: "https://x", expect_identiy: "X" } } }, "devices.a.expect_identiy is not a known key"],
    [{ devices: { a: { url: "https://x", tls: { self_signed_pin_sha256: "abc" } } } }, "self_signed_pin_sha256"],
    [{ default: "b", devices: { a: { url: "https://x" } } }, "default must name one of: a"],
  ])("rejects %j", (data, msg) => {
    const e = catchAxi(() => validateProfile(data));
    expect(e.code).toBe("CONFIG_ERROR");
    expect(e.message).toContain(msg);
  });

  it("selects --device, then default, then the only device", () => {
    const loaded = { path: "p", profile: { default: "b", devices: { a: { url: "https://a" }, b: { url: "https://b" } } } };
    expect(selectDevice(loaded, "a").name).toBe("a");
    expect(selectDevice(loaded, undefined).name).toBe("b");
    expect(selectDevice({ path: "p", profile: { devices: { a: { url: "https://a" } } } }, undefined).name).toBe("a");
    expect(catchAxi(() => selectDevice(loaded, "zz")).code).toBe("VALIDATION_ERROR");
  });
});

describe("credentials", () => {
  it("parses KEY=VALUE files with comments, export and quotes", () => {
    expect(parseEnvFile('# c\nexport A=1\nB = "two words"\nC=\'x\'\n\nbad line\nD=a=b\r\n')).toEqual({
      A: "1",
      B: "two words",
      C: "x",
      D: "a=b",
    });
  });

  it("env file never overrides existing variables", () => {
    const p = join(tmp(), ".env");
    writeFileSync(p, "MIKROTIK_AXI_USER=from-file\nMIKROTIK_AXI_PASS=file-pass\n");
    const env = effectiveEnv({ MIKROTIK_AXI_ENV_FILE: p, MIKROTIK_AXI_USER: "from-env" });
    expect(env["MIKROTIK_AXI_USER"]).toBe("from-env");
    expect(env["MIKROTIK_AXI_PASS"]).toBe("file-pass");
  });

  it("missing credentials name the variables, never print values", () => {
    const e = catchAxi(() => readCredentials({ X_USER: "u" }, { user: "X_USER", pass: "X_PASS" }, "ccr2004"));
    expect(e.code).toBe("CONFIG_ERROR");
    expect(e.message).toBe("credentials for ccr2004 missing: X_PASS not set");
  });
});
