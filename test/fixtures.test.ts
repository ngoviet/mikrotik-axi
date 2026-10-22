import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// §9.1: fixture phải được làm sạch. Mọi field nhạy cảm chỉ được mang giá trị "***" (hoặc rỗng).
const ROOT = fileURLToPath(new URL("./fixtures/", import.meta.url));
const SENSITIVE_KEY = /^(password|passwd|secret|.*-secret|key|private-key|token|\.about)$/i;

function jsonFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? jsonFiles(p) : f.endsWith(".json") ? [p] : [];
  });
}

function findLeaks(node: unknown, menu: string, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => findLeaks(n, menu, `${path}[${i}]`, out));
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    const sensitive = SENSITIVE_KEY.test(k) || (menu.includes("pppoe") && k === "user");
    if (sensitive && typeof v === "string" && v !== "" && v !== "***") out.push(`${path}.${k}`);
    findLeaks(v, menu, `${path}.${k}`, out);
  }
}

describe("fixtures are sanitized", () => {
  const files = jsonFiles(ROOT);

  it("found fixture files", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((f) => [f.slice(ROOT.length)]))("%s has no secrets", (rel) => {
    const leaks: string[] = [];
    findLeaks(JSON.parse(readFileSync(join(ROOT, rel), "utf8")), rel, "$", leaks);
    expect(leaks).toEqual([]);
  });

  it("no PEM private key outside the test-only TLS fixture", () => {
    for (const f of jsonFiles(ROOT)) expect(readFileSync(f, "utf8")).not.toContain("PRIVATE KEY");
  });
});
