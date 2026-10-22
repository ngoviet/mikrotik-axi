import http from "node:http";
import { isIP } from "node:net";
import tls from "node:tls";

export interface HttpRequest {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  url: URL;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** SHA-256 của cert server (hex, có hoặc không dấu ":"). Chỉ dùng với https. */
  tlsPin?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
}

export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

/** Lỗi mạng/TLS thô; client dịch sang AxiError có ngữ cảnh thiết bị. */
export class TransportError extends Error {
  constructor(
    message: string,
    readonly kind: "timeout" | "network" | "tls-untrusted" | "tls-pin-mismatch",
    /** Fingerprint SHA-256 cert thật của server (khi lỗi TLS) — để gợi ý pin. */
    readonly fingerprint?: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

const MAX_BODY_BYTES = 32 * 1024 * 1024;

export function normalizeFingerprint(fp: string): string {
  return fp.replace(/[^0-9a-f]/gi, "").toUpperCase();
}

// Vì sao không dùng fetch: pin cert tự ký với fetch cần Agent của `undici` (không export từ
// Node). Ở đây tự bắt tay TLS, so fingerprint XONG mới gửi request ⇒ credential không bao giờ
// đi tới server có cert lạ. Không bao giờ tắt kiểm TLS toàn cục.
export const nodeTransport: Transport = (req) =>
  new Promise<HttpResponse>((resolve, reject) => {
    const { url } = req;
    const https = url.protocol === "https:";
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port || (https ? 443 : 80));
    let settled = false;
    // Giữ tham chiếu để finish() huỷ được cả socket TLS lẫn request khi lỗi/timeout.
    const open: { socket?: tls.TLSSocket; request?: http.ClientRequest } = {};

    const finish = (err: Error | undefined, res?: HttpResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        open.request?.destroy();
        open.socket?.destroy();
        reject(err);
      } else {
        resolve(res as HttpResponse);
      }
    };

    const timer = setTimeout(
      () => finish(new TransportError(`timeout ${req.timeoutMs / 1000}s`, "timeout")),
      req.timeoutMs,
    );

    const send = (createConnection?: () => tls.TLSSocket): void => {
      const request = http.request(
        {
          host,
          port,
          method: req.method,
          path: `${url.pathname}${url.search}`,
          // Bẫy #8: thiếu Content-Length ⇒ Node gửi body kiểu `Transfer-Encoding: chunked`, và
          // REST của RouterOS coi như body rỗng ("Request is empty", "missing =list=").
          // Đo trên CCR2004 7.24.4 (2026-10-14). Luôn gửi độ dài chính xác.
          headers: {
            Host: url.host,
            ...req.headers,
            ...(req.body !== undefined ? { "Content-Length": String(Buffer.byteLength(req.body)) } : {}),
          },
          // Agent riêng trả về socket TLS đã pin. Lưu ý: `agent: false` + `createConnection`
          // bị Node bỏ qua (mở TCP thường, gửi HTTP trơn) — đã vấp khi viết test.
          ...(createConnection ? { agent: pinnedAgent(createConnection) } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_BODY_BYTES) {
              finish(new TransportError("response too large", "network"));
              return;
            }
            chunks.push(c);
          });
          res.on("end", () => {
            const headers: Record<string, string | undefined> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              headers[k] = Array.isArray(v) ? v.join(", ") : v;
            }
            finish(undefined, {
              status: res.statusCode ?? 0,
              headers,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
          res.on("error", (e) => finish(new TransportError(e.message, "network")));
        },
      );
      open.request = request;
      request.on("error", (e) => finish(new TransportError(describeNetError(e), "network")));
      if (req.body !== undefined) request.write(req.body);
      request.end();
    };

    if (!https) {
      send();
      return;
    }

    const pin = req.tlsPin ? normalizeFingerprint(req.tlsPin) : undefined;
    const socket = tls.connect({
      host,
      port,
      ...(isIP(host) ? {} : { servername: host }),
      // Có pin ⇒ tự xác minh bằng fingerprint bên dưới; không pin ⇒ kiểm CA bình thường.
      rejectUnauthorized: !pin,
    });
    open.socket = socket;
    socket.once("secureConnect", () => {
      const actual = normalizeFingerprint(socket.getPeerCertificate().fingerprint256 ?? "");
      if (pin && actual !== pin) {
        finish(new TransportError("certificate fingerprint does not match pin", "tls-pin-mismatch", actual));
        return;
      }
      send(() => socket);
    });
    socket.once("error", (e: NodeJS.ErrnoException) => {
      if (isTlsTrustError(e)) {
        // Lấy fingerprint thật để gợi ý pin (người dùng phải tự đối chiếu trên router).
        peekFingerprint(host, port, req.timeoutMs)
          .then((fp) => finish(new TransportError(e.message, "tls-untrusted", fp)))
          .catch(() => finish(new TransportError(e.message, "tls-untrusted")));
        return;
      }
      finish(new TransportError(describeNetError(e), "network"));
    });
  });

function pinnedAgent(createConnection: () => tls.TLSSocket): http.Agent {
  const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
  agent.createConnection = createConnection;
  return agent;
}

function isTlsTrustError(e: NodeJS.ErrnoException): boolean {
  return /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS_CERT_ALTNAME/i.test(e.code ?? "");
}

function describeNetError(e: NodeJS.ErrnoException): string {
  return e.code ? `${e.code}` : e.message;
}

function peekFingerprint(host: string, port: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port, rejectUnauthorized: false, ...(isIP(host) ? {} : { servername: host }) });
    const t = setTimeout(() => {
      s.destroy();
      reject(new Error("timeout"));
    }, timeoutMs);
    s.once("secureConnect", () => {
      clearTimeout(t);
      const fp = s.getPeerCertificate().fingerprint256 ?? "";
      s.destroy();
      resolve(normalizeFingerprint(fp));
    });
    s.once("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}
