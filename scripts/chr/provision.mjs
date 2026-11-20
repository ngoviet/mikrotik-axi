// Provision a throwaway CHR booted by scripts/chr/boot.sh for the CHR test suite (test/chr/).
// Logs in as the factory admin (empty password) and creates, through REST:
//   - identity AXI-CHR (what the profile expects; the identity guard is part of every test);
//   - users axi-ro (read), axi-rw (read+write) and axi-ping (read+test), random passwords;
//   - harmless objects the write commands act on: a passthrough filter rule AXI_TEST_live, a bridge
//     with a DHCP server and one static lease, a PPPoE client that dials nowhere.
// Writes, into the directory given as the first argument: profile.json, creds.env (KEY=VALUE for
// MIKROTIK_AXI_ENV_FILE) and fixture.json (ids the tests act on). Prints no password.
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/chr/provision.mjs <output-dir>");
  process.exit(2);
}
const port = process.env.CHR_HTTP_PORT ?? "18080";
const base = `http://127.0.0.1:${port}/rest`;
const IDENTITY = "AXI-CHR";

async function rest(method, path, body, user = "admin", pass = "") {
  const res = await globalThis.fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : undefined;
}

/** First boot can answer 401 for a few seconds before the user database is ready. */
async function waitForAdmin() {
  let last;
  for (let i = 0; i < 60; i++) {
    try {
      return await rest("GET", "/system/identity");
    } catch (e) {
      last = e;
      await sleep(2000);
    }
  }
  throw new Error(`admin login never succeeded: ${last?.message}`);
}

const secret = () => randomBytes(18).toString("base64url");

await waitForAdmin();
await rest("POST", "/system/identity/set", { name: IDENTITY });

const users = {
  ro: { name: "axi-ro", group: "axi-read", policy: "read,api,rest-api", pass: secret() },
  rw: { name: "axi-rw", group: "axi-write", policy: "read,write,api,rest-api", pass: secret() },
  ping: { name: "axi-ping", group: "axi-test", policy: "read,api,rest-api,test", pass: secret() },
};
for (const u of Object.values(users)) {
  await rest("PUT", "/user/group", { name: u.group, policy: u.policy });
  await rest("PUT", "/user", { name: u.name, group: u.group, password: u.pass });
}

// Write targets. All addresses are TEST-NET-1 (192.0.2.0/24).
const rule = await rest("PUT", "/ip/firewall/filter", { chain: "forward", action: "passthrough", comment: "AXI_TEST_live" });
await rest("PUT", "/interface/bridge", { name: "axi-br" });
await rest("PUT", "/ip/address", { address: "192.0.2.1/24", interface: "axi-br" });
await rest("PUT", "/ip/pool", { name: "axi-pool", ranges: "192.0.2.100-192.0.2.199" });
await rest("PUT", "/ip/dhcp-server", { name: "axi-dhcp", interface: "axi-br", "address-pool": "axi-pool", disabled: "no" });
await rest("PUT", "/ip/dhcp-server/network", { address: "192.0.2.0/24", gateway: "192.0.2.1" });
await rest("PUT", "/ip/dhcp-server/lease", { address: "192.0.2.50", "mac-address": "02:00:00:00:00:50", server: "axi-dhcp", comment: "AXI_TEST_lease" });
await rest("PUT", "/interface/pppoe-client", { name: "pppoe-axi", interface: "ether1", user: "axi", password: secret(), disabled: "no" });

// A dynamic ARP entry for the QEMU user-network gateway, so `arp flush` has something to remove.
const gateway = "10.0.2.2";
await rest("POST", "/ping", { address: gateway, count: "1" }).catch(() => undefined);

mkdirSync(out, { recursive: true });
writeFileSync(
  join(out, "profile.json"),
  `${JSON.stringify(
    {
      default: "chr",
      devices: {
        chr: {
          url: `http://127.0.0.1:${port}`,
          expect_identity: IDENTITY,
          credential_env: { user: "AXI_RO_USER", pass: "AXI_RO_PASS" },
          credential_env_write: { user: "AXI_RW_USER", pass: "AXI_RW_PASS" },
          timeout_ms: 15000,
        },
      },
    },
    null,
    2,
  )}\n`,
);
writeFileSync(
  join(out, "creds.env"),
  [
    `AXI_RO_USER=${users.ro.name}`,
    `AXI_RO_PASS=${users.ro.pass}`,
    `AXI_RW_USER=${users.rw.name}`,
    `AXI_RW_PASS=${users.rw.pass}`,
    `AXI_PING_USER=${users.ping.name}`,
    `AXI_PING_PASS=${users.ping.pass}`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);
writeFileSync(
  join(out, "fixture.json"),
  `${JSON.stringify({ rule: rule[".id"], dhcpServer: "axi-dhcp", lease: "192.0.2.50", pppoe: "pppoe-axi", gateway }, null, 2)}\n`,
);
console.log(`provisioned ${IDENTITY}: users ${Object.values(users).map((u) => u.name).join(", ")}; rule ${rule[".id"]}; files in ${out}`);
