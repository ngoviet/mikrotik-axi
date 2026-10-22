import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { AxiError } from "axi-sdk-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RosClient } from "../../src/ros/client.js";
import { nodeTransport, normalizeFingerprint } from "../../src/ros/transport.js";

// Cert tự ký CHỈ dùng cho test (CN=mikrotik-axi-test, SAN 127.0.0.1).
const TLS_DIR = new URL("../fixtures/tls/", import.meta.url);
const cert = readFileSync(new URL("test-only.cert.pem", TLS_DIR));
const key = readFileSync(new URL("test-only.key.pem", TLS_DIR));
const PIN = normalizeFingerprint(new X509Certificate(cert).fingerprint256);

interface Seen {
  method?: string;
  url?: string;
  auth?: string;
  contentLength?: string;
  transferEncoding?: string;
  body?: string;
}

function handler(seen: Seen[]) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    const entry: Seen = {
      method: req.method ?? "",
      url: req.url ?? "",
      auth: req.headers.authorization ?? "",
      contentLength: req.headers["content-length"] ?? "",
      transferEncoding: req.headers["transfer-encoding"] ?? "",
      body: "",
    };
    seen.push(entry);
    req.on("data", (c: Buffer) => (entry.body += c.toString("utf8")));
    if (req.url?.startsWith("/rest/slow")) return; // không bao giờ trả lời ⇒ timeout
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: "CCR2004" }));
  };
}

let httpServer: http.Server;
let httpsServer: https.Server;
const httpSeen: Seen[] = [];
const httpsSeen: Seen[] = [];
let httpUrl = "";
let httpsUrl = "";

beforeAll(async () => {
  httpServer = http.createServer(handler(httpSeen));
  httpsServer = https.createServer({ cert, key }, handler(httpsSeen));
  await Promise.all([
    new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r)),
    new Promise<void>((r) => httpsServer.listen(0, "127.0.0.1", r)),
  ]);
  httpUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  httpsUrl = `https://127.0.0.1:${(httpsServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  httpServer.closeAllConnections();
  httpsServer.closeAllConnections();
  httpServer.close();
  httpsServer.close();
});

const client = (url: string, extra: { tlsPin?: string; timeoutMs?: number } = {}) =>
  new RosClient({ name: "dev", url, user: "axi-ro", pass: "pw", timeoutMs: extra.timeoutMs ?? 2000, ...extra }, nodeTransport);

async function axiErr(p: Promise<unknown>): Promise<AxiError> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(AxiError);
  return e as AxiError;
}

describe("node transport", () => {
  it("http: sends Basic auth, proplist query, parses JSON", async () => {
    const r = await client(httpUrl).single("/system/identity", { proplist: ["name"] });
    expect(r).toEqual({ name: "CCR2004" });
    const last = httpSeen.at(-1)!;
    expect(last.url).toBe("/rest/system/identity?.proplist=name");
    expect(last.auth).toBe(`Basic ${Buffer.from("axi-ro:pw").toString("base64")}`);
  });

  it("timeout becomes UNREACHABLE with the timeout in the message", async () => {
    const e = await axiErr(client(httpUrl, { timeoutMs: 300 }).list("/slow"));
    expect(e.code).toBe("UNREACHABLE");
    expect(e.message).toBe("dev (127.0.0.1) unreachable (timeout 0.3s)");
  });

  it("connection refused becomes UNREACHABLE", async () => {
    const e = await axiErr(client("http://127.0.0.1:1").list("/ip/route"));
    expect(e.code).toBe("UNREACHABLE");
  });

  it("https with matching pin succeeds", async () => {
    expect(await client(httpsUrl, { tlsPin: PIN }).single("/system/identity")).toEqual({ name: "CCR2004" });
  });

  it("https pin accepts colon-separated lowercase form", async () => {
    const colon = PIN.toLowerCase().match(/../g)!.join(":");
    expect(await client(httpsUrl, { tlsPin: colon }).single("/system/identity")).toEqual({ name: "CCR2004" });
  });

  it("https pin mismatch fails before any HTTP request reaches the server", async () => {
    const before = httpsSeen.length;
    const e = await axiErr(client(httpsUrl, { tlsPin: "00".repeat(32) }).single("/system/identity"));
    expect(e.code).toBe("TLS_ERROR");
    expect(e.suggestions[0]).toBe(`Server presented sha256 ${PIN}`);
    expect(httpsSeen.length).toBe(before);
  });

  it("https without pin rejects the self-signed cert and suggests its fingerprint", async () => {
    const before = httpsSeen.length;
    const e = await axiErr(client(httpsUrl).single("/system/identity"));
    expect(e.code).toBe("TLS_ERROR");
    expect(e.suggestions.join("\n")).toContain(PIN);
    expect(httpsSeen.length).toBe(before);
  });

  it("trap #8: write bodies carry Content-Length, never chunked (RouterOS reads chunked as empty)", async () => {
    const c = client(httpUrl);
    c.verified = { identity: "CCR2004", strict: true };
    await c.singletonSet("/system/identity", { name: "Bảo-Việt" });
    const last = httpSeen.at(-1)!;
    expect(last.method).toBe("POST");
    expect(last.transferEncoding).toBe("");
    expect(Number(last.contentLength)).toBe(Buffer.byteLength(last.body ?? ""));
    expect(JSON.parse(last.body ?? "{}")).toEqual({ name: "Bảo-Việt" });
  });
});
