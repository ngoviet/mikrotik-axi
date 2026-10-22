import { AxiError } from "axi-sdk-js";
import { describe, expect, it } from "vitest";
import { RosClient, credentialFingerprint, encodeId, type DeviceConn } from "../../src/ros/client.js";
import { fakeRouter, type Dataset } from "../helpers/fake-router.js";

const CONN: DeviceConn = { name: "ccr2004", url: "https://router.test", user: "axi-rw", pass: "s3cret-pass", timeoutMs: 1000 };

function setup(dataset: Dataset = {}, env: NodeJS.ProcessEnv = {}) {
  const router = fakeRouter(dataset, { user: CONN.user, pass: CONN.pass });
  const client = new RosClient(CONN, router.transport, env);
  // Giả lập guard đã chạy (strict) — test ghi cần điều kiện này.
  client.verified = { identity: "CCR2004", strict: true };
  const last = () => router.requests.at(-1)!;
  return { router, client, last };
}

async function axiErr(p: Promise<unknown>): Promise<AxiError> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(AxiError);
  return e as AxiError;
}

const filter = () => ({
  "/ip/firewall/filter": [
    { ".id": "*3B", chain: "forward", action: "accept", protocol: "tcp", "dst-port": "443", disabled: "false" },
  ],
});

describe("trap #1 — add posts to <menu>/add", () => {
  it("POST /rest/ip/firewall/filter/add and returns the new .id", async () => {
    const { client, last } = setup(filter());
    const id = await client.add("/ip/firewall/filter", { chain: "forward", action: "drop", comment: "AXI_TEST_x" });
    expect(last().method).toBe("POST");
    expect(last().url.pathname).toBe("/rest/ip/firewall/filter/add");
    expect(id).toMatch(/^\*[0-9A-F]+$/);
  });
});

describe("trap #2 — .id keeps its raw *", () => {
  it("encodeId leaves * and ! untouched", () => {
    expect(encodeId("*3B")).toBe("*3B");
    expect(encodeId("*8000003A")).toBe("*8000003A");
    expect(encodeId("!x")).toBe("!x");
  });

  it("PATCH path contains *3B, never %2A3B", async () => {
    const { client, last } = setup(filter());
    await client.set("/ip/firewall/filter", "*3B", { comment: "AXI_TEST_y" });
    expect(last().method).toBe("PATCH");
    expect(last().url.href).toContain("/rest/ip/firewall/filter/*3B");
    expect(last().url.href).not.toMatch(/%2A/i);
  });
});

describe("trap #3 — no comma lists in address fields", () => {
  it.each(["src-address", "dst-address"])("rejects comma list in %s with address-list help", async (field) => {
    const { client, router } = setup(filter());
    const e = await axiErr(client.add("/ip/firewall/filter", { chain: "forward", [field]: "192.168.0.0/16,10.99.99.0/30" }));
    expect(e.code).toBe("VALIDATION_ERROR");
    expect(e.suggestions.join(" ")).toContain(`${field}-list`);
    expect(router.requests).toHaveLength(0);
  });

  it("rejects protocol=tcp,udp and dst-port without protocol", async () => {
    const { client } = setup(filter());
    expect((await axiErr(client.add("/ip/firewall/nat", { chain: "dstnat", protocol: "tcp,udp", "dst-port": "53" }))).code).toBe(
      "VALIDATION_ERROR",
    );
    expect((await axiErr(client.add("/ip/firewall/nat", { chain: "dstnat", "dst-port": "53" }))).message).toContain(
      "requires protocol",
    );
  });

  it("set() accepts dst-port when protocol already exists on the rule", async () => {
    const { client, last } = setup(filter());
    await client.set("/ip/firewall/filter", "*3B", { "dst-port": "8443" });
    expect(last().method).toBe("PATCH");
  });
});

describe("trap #4 — singleton menus", () => {
  const ds = (): Dataset => ({ "/system/identity": { name: "CCR2004" }, "/tool/bandwidth-server": { enabled: "true" } });

  it("single() returns a dict; list() on a singleton is a programming error", async () => {
    const { client } = setup(ds());
    expect(await client.single("/system/identity")).toEqual({ name: "CCR2004" });
    await expect(client.list("/system/identity")).rejects.toThrow(/singleton/);
  });

  it("singletonSet posts to <menu>/set; set() refuses singleton menus", async () => {
    const { client, last } = setup(ds());
    await client.singletonSet("/tool/bandwidth-server", { enabled: "no" });
    expect(last().method).toBe("POST");
    expect(last().url.pathname).toBe("/rest/tool/bandwidth-server/set");
    await expect(client.set("/tool/bandwidth-server", "*1", { enabled: "no" })).rejects.toThrow(/singletonSet/);
  });

  it("list() fails clearly if an undeclared menu returns a dict", async () => {
    const { client } = setup({ "/ip/firewall/connection/tracking": { enabled: "auto" } });
    const e = await axiErr(client.list("/ip/firewall/connection/tracking"));
    expect(e.suggestions.join(" ")).toContain("menus.ts");
  });
});

describe("trap #5 — /ip/service ACL lives in available-from", () => {
  it("refuses writes to `address`", async () => {
    const { client, router } = setup({ "/ip/service": [{ ".id": "*1", name: "www", address: "", "available-from": "" }] });
    const e = await axiErr(client.set("/ip/service", "*1", { address: "192.168.100.0/24" }));
    expect(e.code).toBe("VALIDATION_ERROR");
    expect(e.suggestions.join(" ")).toContain("available-from");
    expect(router.requests.every((r) => r.method === "GET")).toBe(true);
  });
});

describe("trap #6 — dynamic objects cannot be modified", () => {
  it("refuses PATCH on a dynamic route with a pppoe-client hint, before any write", async () => {
    const { client, router } = setup({
      "/ip/route": [{ ".id": "*8000003A", "dst-address": "0.0.0.0/0", gateway: "pppoe-out2", dynamic: "true" }],
    });
    const e = await axiErr(client.set("/ip/route", "*8000003A", { "check-gateway": "ping" }));
    expect(e.code).toBe("WRITE_REFUSED");
    expect(e.suggestions.join(" ")).toContain("default-route-distance");
    expect(router.requests.map((r) => r.method)).toEqual(["GET"]);
  });
});

describe("write safety net", () => {
  it("refuses writes when MIKROTIK_AXI_READ_ONLY=1", async () => {
    const { client, router } = setup(filter(), { MIKROTIK_AXI_READ_ONLY: "1" });
    expect((await axiErr(client.add("/ip/firewall/filter", { chain: "forward" }))).code).toBe("WRITE_REFUSED");
    expect(router.requests).toHaveLength(0);
  });

  it("refuses writes unless identity was strictly verified", async () => {
    const { client } = setup(filter());
    client.verified = { identity: "X", strict: false };
    expect((await axiErr(client.add("/ip/firewall/filter", { chain: "forward" }))).message).toContain("identity");
  });
});

describe("reads", () => {
  it("sends .proplist and query unescaped", async () => {
    const { client, last } = setup({ "/ip/route": [] });
    await client.list("/ip/route", { query: { "dst-address": "0.0.0.0/0" }, proplist: ["gateway", "routing-table"] });
    expect(last().url.search).toBe("?dst-address=0.0.0.0/0&.proplist=gateway,routing-table");
  });

  it("translates RouterOS 400 detail without leaking the body", async () => {
    const { client } = setup({});
    const e = await axiErr(client.list("/no/such-menu"));
    expect(e.code).toBe("ROS_ERROR");
    expect(e.message).toBe("RouterOS rejected GET /no/such-menu: no such command or directory");
  });

  it("401 reports user, pass_len and hash prefix — never the password", async () => {
    const router = fakeRouter({ "/ip/route": [] }, { user: "axi-ro", pass: "other" });
    const client = new RosClient(CONN, router.transport, {});
    const e = await axiErr(client.list("/ip/route"));
    expect(e.code).toBe("AUTH_ERROR");
    expect(e.message).toContain(credentialFingerprint("axi-rw", "s3cret-pass"));
    expect(e.message).toMatch(/user=axi-rw, pass_len=11, sha256=[0-9a-f]{8}/);
    expect(JSON.stringify(e)).not.toContain("s3cret-pass");
  });
});
