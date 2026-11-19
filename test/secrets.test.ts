import { describe, expect, it } from "vitest";
import { maskSecrets, redact } from "../src/errors.js";

// Mọi bí mật ở đây là GIẢ, chỉ dùng trong test. Repo public: không bao giờ dán giá trị thật.
const CF_TOKEN = "FAKEcfTokenForTestsOnly0000000000000000x"; // 40 ký tự, cùng dạng token Cloudflare
const CF_KEY = "fakeglobalapikey0000000000000000000ab";
const DYNU_PASS = "fake-dynu-pass-1234";
const PASS = "fake-pass-5678";

describe("maskSecrets: DDNS lines (Cloudflare, Dynu)", () => {
  it.each([
    [
      "Cloudflare Bearer token in a fetch http-header-field",
      `fetch: url=https://api.cloudflare.com/client/v4/zones/z1/dns_records/r1 http-method=put http-header-field="Authorization: Bearer ${CF_TOKEN},Content-Type: application/json"`,
      `fetch: url=https://api.cloudflare.com/client/v4/zones/z1/dns_records/r1 http-method=put http-header-field="Authorization: Bearer ***,Content-Type: application/json"`,
    ],
    [
      "Cloudflare token inside an escaped script source",
      `(ppp profile on-up) /tool fetch http-header-field=\\"Authorization: Bearer ${CF_TOKEN}\\" output=none`,
      `(ppp profile on-up) /tool fetch http-header-field=\\"Authorization: Bearer ***\\" output=none`,
    ],
    [
      "Cloudflare global API key header",
      `cf-ddns: X-Auth-Email: owner@example.com, X-Auth-Key: ${CF_KEY}`,
      "cf-ddns: X-Auth-Email: owner@example.com, X-Auth-Key: ***",
    ],
    [
      "Dynu password in the update query string",
      `Download from https://api.dynu.com/nic/update?hostname=home.example.net&myip=203.0.113.7&password=${DYNU_PASS} FAILED: Fetch failed with status 401`,
      "Download from https://api.dynu.com/nic/update?hostname=home.example.net&myip=203.0.113.7&password=*** FAILED: Fetch failed with status 401",
    ],
    [
      "Dynu password as a quoted fetch parameter",
      `update-dynu-ddns: /tool fetch url="https://api.dynu.com/nic/update?hostname=home.example.net" user="dynu-user" password="${DYNU_PASS}" mode=https`,
      'update-dynu-ddns: /tool fetch url="https://api.dynu.com/nic/update?hostname=home.example.net" user="dynu-user" password="***" mode=https',
    ],
    [
      "Dynu password in URL userinfo",
      `fetch failed: https://dynu-user:${DYNU_PASS}@api.dynu.com/nic/update?hostname=home.example.net`,
      "fetch failed: https://dynu-user:***@api.dynu.com/nic/update?hostname=home.example.net",
    ],
    [
      "DDNS script logging its own token variable",
      `cf-ddns: token=${CF_TOKEN} zone=example.net ip=203.0.113.7`,
      "cf-ddns: token=*** zone=example.net ip=203.0.113.7",
    ],
  ])("%s", (_name, line, expected) => {
    expect(maskSecrets(line)).toBe(expected);
  });
});

describe("maskSecrets: generic patterns", () => {
  it.each([
    ["password=", `login password=${PASS} via api`, "login password=*** via api"],
    ["passwd with colon", `passwd: ${PASS}`, "passwd: ***"],
    ["token= in a query", `GET /update?token=${CF_TOKEN}&host=a.example.net`, "GET /update?token=***&host=a.example.net"],
    ["secret=", `radius secret=${PASS} server=192.0.2.10`, "radius secret=*** server=192.0.2.10"],
    ["client-secret, quoted with spaces", `client-secret = "${PASS} more"`, 'client-secret = "***"'],
    ["JSON token", `{"name":"ddns","token":"${CF_TOKEN}"}`, '{"name":"ddns","token":"***"}'],
    ["escaped JSON password", `http-data={\\"password\\":\\"${PASS}\\"}`, 'http-data={\\"password\\":\\"***\\"}'],
    ["key=", `wg: key=${CF_KEY} peer=wg1`, "wg: key=*** peer=wg1"],
    ["api_key=", `notify api_key=${CF_KEY}`, "notify api_key=***"],
    ["camelCase cfToken=", `cfToken=${CF_TOKEN}`, "cfToken=***"],
    ["Authorization: Bearer", `Authorization: Bearer ${CF_TOKEN}`, "Authorization: Bearer ***"],
    ["Authorization: Basic", "authorization: Basic ZmFrZTpmYWtlLXBhc3M=", "authorization: Basic ***"],
    ["Authorization without a scheme", `Authorization=${CF_TOKEN}`, "Authorization=***"],
    ["Bearer on its own", `sent header Bearer ${CF_TOKEN} to api`, "sent header Bearer *** to api"],
    ["https://user:pass@host", `https://admin:${PASS}@router.example.net/rest`, "https://admin:***@router.example.net/rest"],
    ["ftp://user:pass@host", `backup to ftp://bk:${PASS}@192.0.2.20/x.backup`, "backup to ftp://bk:***@192.0.2.20/x.backup"],
  ])("%s", (_name, line, expected) => {
    expect(maskSecrets(line)).toBe(expected);
  });

  it("leaves ordinary log lines untouched", () => {
    for (const line of [
      "DROP_INPUT: input: in:pppoe-out1 out:(unknown 0), connection-state:new proto TCP (SYN), 192.0.2.5:51234->203.0.113.7:8291, len 52",
      "login failure for user admin from 192.0.2.9 via ssh",
      "defconf assigned 192.168.88.10 for AA:BB:CC:00:11:22 host-a",
      "pppoe-out1: authenticated",
      "ipsec: phase1 negotiation failed due to time up, key exchange not finished",
      "invalid username or password",
      'user dynu-user password="" (empty)',
      "https://api.dynu.com/nic/update?hostname=home.example.net&myip=203.0.113.7",
    ]) {
      expect(maskSecrets(line)).toBe(line);
    }
  });

  it("is idempotent", () => {
    const line = `Authorization: Bearer ${CF_TOKEN} password="${PASS}" https://u:${PASS}@h.example.net token=${CF_TOKEN}`;
    const once = maskSecrets(line);
    expect(maskSecrets(once)).toBe(once);
    for (const s of [CF_TOKEN, PASS]) expect(once).not.toContain(s);
  });

  it("does not leak the tail of a quoted value containing a backslash escape", () => {
    expect(maskSecrets(`password="ab\\$cdSECRET" x=1`)).toBe(`password="***" x=1`);
    // Dạng nháy thoát của nguồn script vẫn dừng đúng ở \" đóng.
    expect(maskSecrets(`secret=\\"ab\\$cdSECRET\\" next=1`)).toBe(`secret=\\"***\\" next=1`);
  });

  it("masks a URL password that contains @ up to the last @ before the host", () => {
    expect(maskSecrets("get ftp://bob:p@ssSECRET@host.example/file failed")).toBe("get ftp://bob:***@host.example/file failed");
    expect(maskSecrets("mail to a@b.example via https://u:pw@h.example")).toBe("mail to a@b.example via https://u:***@h.example");
  });
});

describe("redact reuses the same masking", () => {
  it("masks a Bearer token and URL password in error text, then truncates", () => {
    const out = redact(`RouterOS said: Authorization: Bearer ${CF_TOKEN} at https://u:${PASS}@h.example.net`);
    expect(out).not.toContain(CF_TOKEN);
    expect(out).not.toContain(PASS);
    expect(out).toContain("Bearer ***");
    expect(redact(`password=${PASS} ${"a".repeat(400)}`)).toHaveLength(301);
  });
});
