import { AxiError } from "axi-sdk-js";
import { describe, expect, it } from "vitest";
import { RosClient, type DeviceConn } from "../../src/ros/client.js";
import { verifyIdentity } from "../../src/ros/guard.js";
import { fakeRouter, foreignDevice, loadDataset } from "../helpers/fake-router.js";

const CONN: DeviceConn = { name: "ccr2004", url: "http://192.168.10.1", user: "axi-ro", pass: "test-pass", timeoutMs: 1000 };

async function axiErr(p: Promise<unknown>): Promise<AxiError> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(AxiError);
  return e as AxiError;
}

describe("identity guard (§5.1)", () => {
  it("blocks the ZTE router and never sends credentials to it", async () => {
    const zte = foreignDevice("zte-404.json");
    const client = new RosClient(CONN, zte.transport);
    const e = await axiErr(verifyIdentity(client, { expectIdentity: "CCR2004", skipNameCheck: false }));
    expect(e.code).toBe("NOT_ROUTEROS");
    expect(e.message).toBe('device at http://192.168.10.1 is not RouterOS (got HTTP 404, server "ZTE web server 1.0 ZTE corp 2015")');
    expect(e.suggestions[0]).toBe("Check routing to 192.168.10.1: another network may use the same subnet");
    expect(zte.requests).toHaveLength(1);
    expect(zte.requests[0]!.headers["Authorization"]).toBeUndefined();
  });

  it("blocks --no-identity-check too when the device is not RouterOS", async () => {
    const client = new RosClient(CONN, foreignDevice("zte-404.json").transport);
    expect((await axiErr(verifyIdentity(client, { skipNameCheck: true }))).code).toBe("NOT_ROUTEROS");
  });

  it("passes on the expected identity and marks the client strictly verified", async () => {
    const router = fakeRouter(loadDataset("ccr2004"));
    const client = new RosClient(CONN, router.transport);
    expect(await verifyIdentity(client, { expectIdentity: "CCR2004", skipNameCheck: false })).toBe("CCR2004");
    expect(client.verified).toEqual({ identity: "CCR2004", strict: true });
    // Bước 1 không kèm credential, bước 2 có.
    expect(router.requests.map((r) => Boolean(r.headers["Authorization"]))).toEqual([false, true]);
  });

  it("stops on identity mismatch", async () => {
    const ds = loadDataset("ccr2004");
    ds["/system/identity"] = { name: "CRS326" };
    const client = new RosClient(CONN, fakeRouter(ds).transport);
    const e = await axiErr(verifyIdentity(client, { expectIdentity: "CCR2004", skipNameCheck: false }));
    expect(e.code).toBe("IDENTITY_MISMATCH");
    expect(e.message).toContain('expected "CCR2004", got "CRS326"');
  });

  it("--no-identity-check skips only the name comparison and is not strict", async () => {
    const ds = loadDataset("ccr2004");
    ds["/system/identity"] = { name: "CRS326" };
    const client = new RosClient(CONN, fakeRouter(ds).transport);
    expect(await verifyIdentity(client, { expectIdentity: "CCR2004", skipNameCheck: true })).toBe("CRS326");
    expect(client.verified?.strict).toBe(false);
  });

  it("asks to set expect_identity when the profile has none", async () => {
    const client = new RosClient(CONN, fakeRouter(loadDataset("ccr2004")).transport);
    const e = await axiErr(verifyIdentity(client, { skipNameCheck: false }));
    expect(e.code).toBe("CONFIG_ERROR");
    expect(e.suggestions[0]).toContain('"expect_identity": "CCR2004"');
  });

  it("caches the result within one run", async () => {
    const router = fakeRouter(loadDataset("ccr2004"));
    const client = new RosClient(CONN, router.transport);
    const expect_ = { expectIdentity: "CCR2004", skipNameCheck: false };
    await Promise.all([verifyIdentity(client, expect_), verifyIdentity(client, expect_)]);
    expect(router.requests).toHaveLength(2);
  });
});
