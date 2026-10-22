import { readdirSync, readFileSync } from "node:fs";
import type { HttpRequest, HttpResponse, Transport } from "../../src/ros/transport.js";

export type Dataset = Record<string, Record<string, string> | Array<Record<string, string>>>;

export const FIXTURES = new URL("../fixtures/", import.meta.url);

/** Nạp thư mục fixture: tên file `ip__route.json` ⇒ menu `/ip/route`. */
export function loadDataset(name: string): Dataset {
  const dir = new URL(`${name}/`, FIXTURES);
  const out: Dataset = {};
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    out[`/${f.slice(0, -5).replaceAll("__", "/")}`] = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
  }
  return out;
}

export interface FakeCred {
  user: string;
  pass: string;
  readOnly?: boolean;
}

export interface FakeRouter {
  transport: Transport;
  requests: HttpRequest[];
  dataset: Dataset;
}

const json = (status: number, data: unknown): HttpResponse => ({
  status,
  headers: { "content-type": "application/json" },
  body: data === undefined ? "" : JSON.stringify(data),
});

const rosError = (status: number, detail: string): HttpResponse =>
  json(status, { error: status, message: status === 400 ? "Bad Request" : "Error", detail });

/**
 * RouterOS REST giả, bám hành vi thật đã đo: chưa auth ⇒ 401 JSON; singleton trả dict; query
 * lọc theo field; `.proplist` chỉ giữ các field đã xin; POST <menu> (thiếu /add) ⇒ 400.
 */
export function fakeRouter(
  dataset: Dataset,
  // Một hoặc nhiều tài khoản; `readOnly` ⇒ lệnh ghi bị 403 như router thật (thiếu policy write).
  creds: FakeCred | FakeCred[] = { user: "axi-ro", pass: "test-pass" },
  // ignoreQuery: router bỏ qua bộ lọc trong query string (kiểm lớp lọc lại phía client).
  opts: { latencyMs?: number; fail?: Record<string, HttpResponse>; ignoreWrites?: boolean; ignoreQuery?: boolean } = {},
): FakeRouter {
  const requests: HttpRequest[] = [];
  const accounts = (Array.isArray(creds) ? creds : [creds]).map((c) => ({
    ...c,
    header: `Basic ${Buffer.from(`${c.user}:${c.pass}`).toString("base64")}`,
  }));
  let nextId = 0x9000;

  const transport: Transport = async (req) => {
    requests.push(req);
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
    const account = accounts.find((a) => a.header === req.headers["Authorization"]);
    if (!account) return json(401, { error: 401, message: "Unauthorized" });
    if (account.readOnly && req.method !== "GET") return json(403, { error: 403, message: "Forbidden", detail: "not enough permissions" });

    const path = decodeURIComponent(req.url.pathname).replace(/^\/rest/, "");
    const forced = opts.fail?.[path];
    if (forced) return forced;
    const query = parseQuery(req.url.search);
    const proplist = query[".proplist"]?.split(",");
    delete query[".proplist"];
    const project = (r: Record<string, string>): Record<string, string> =>
      proplist ? Object.fromEntries(Object.entries(r).filter(([k]) => proplist.includes(k))) : r;

    if (req.method === "GET") {
      const data = dataset[path];
      if (data !== undefined) {
        if (!Array.isArray(data)) return json(200, project(data));
        const rows = opts.ignoreQuery ? data : data.filter((r) => Object.entries(query).every(([k, v]) => r[k] === v));
        return json(200, rows.map(project));
      }
      const { menu, id } = splitId(path);
      const rows = dataset[menu];
      if (Array.isArray(rows) && id) {
        const row = rows.find((r) => r[".id"] === id);
        return row ? json(200, project(row)) : rosError(404, "no such item");
      }
      return rosError(400, "no such command or directory");
    }

    const body = req.body ? (JSON.parse(req.body) as Record<string, string>) : {};
    // Router "nuốt" lệnh ghi: trả OK nhưng không đổi gì (bẫy thất bại im lặng).
    if (opts.ignoreWrites) return json(200, req.method === "POST" && path.endsWith("/add") ? { ret: "*FFFF" } : []);
    if (req.method === "POST") {
      if (path.endsWith("/add")) {
        const rows = dataset[path.slice(0, -4)];
        if (!Array.isArray(rows)) return rosError(400, "no such command");
        const id = `*${(nextId++).toString(16).toUpperCase()}`;
        rows.push({ ".id": id, ...body });
        return json(200, { ret: id });
      }
      if (path.endsWith("/set")) {
        const obj = dataset[path.slice(0, -4)];
        if (!obj || Array.isArray(obj)) return rosError(400, "no such command");
        Object.assign(obj, body);
        return json(200, []);
      }
      return rosError(400, "no such command");
    }

    const { menu, id } = splitId(path);
    const rows = dataset[menu];
    if (!Array.isArray(rows) || !id) return rosError(400, "missing or invalid resource identifier");
    const idx = rows.findIndex((r) => r[".id"] === id);
    if (idx === -1) return rosError(404, "no such item");
    if (req.method === "PATCH") {
      Object.assign(rows[idx] as object, body);
      return json(200, rows[idx]);
    }
    if (req.method === "DELETE") {
      rows.splice(idx, 1);
      return json(204, undefined);
    }
    return rosError(400, "unsupported method");
  };

  return { transport, requests, dataset };
}

// Path đã decode: `.id` hợp lệ chỉ khi URL gửi `*` thô — `%2A` decode ra `*` nên kiểm trên
// pathname gốc ở test riêng (bẫy #2), không ở đây.
function splitId(path: string): { menu: string; id?: string } {
  const i = path.lastIndexOf("/");
  const last = path.slice(i + 1);
  return last.startsWith("*") ? { menu: path.slice(0, i), id: last } : { menu: path };
}

function parseQuery(search: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of search.replace(/^\?/, "").split("&")) {
    if (!part) continue;
    const [k, v = ""] = part.split("=");
    out[decodeURIComponent(k as string)] = decodeURIComponent(v);
  }
  return out;
}

/** Thiết bị lạ: trả cùng một phản hồi cho mọi request (ví dụ ZTE 404 HTML). */
export function foreignDevice(fixture: string): FakeRouter {
  const f = JSON.parse(readFileSync(new URL(`foreign/${fixture}`, FIXTURES), "utf8")) as {
    status: number;
    headers: Record<string, string>;
    body: string;
  };
  const requests: HttpRequest[] = [];
  return {
    requests,
    dataset: {},
    transport: async (req) => {
      requests.push(req);
      return { status: f.status, headers: f.headers, body: f.body };
    },
  };
}
