// Kiểm cây file TRƯỚC khi public repo (M4). Chạy: pnpm public:check
//  - .public-ignore (commit): file riêng tư không bao giờ được public (tài liệu dev theo site).
//  - .public-deny.local (KHÔNG commit): regex chuỗi định danh của site (domain, IP thật, tên
//    WiFi…), mỗi dòng một mẫu. Chính danh sách này là thông tin cá nhân nên phải ở ngoài repo.
//  - Kiểm chung: .env, profile thật, private key ngoài cert test.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const lines = (f) =>
  existsSync(f)
    ? readFileSync(f, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
    : [];

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\n").filter(Boolean);
// Mẫu trong .public-ignore: đường dẫn chính xác hoặc có `*` (khớp trong một cấp thư mục).
const privatePatterns = lines(".public-ignore");

/** `*` khớp mọi chuỗi không chứa "/"; phần còn lại so nguyên văn (không dùng regex ⇒ khỏi escape). */
function globMatch(pattern, path) {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === path;
  if (!path.startsWith(parts[0]) || !path.endsWith(parts[parts.length - 1])) return false;
  let pos = parts[0].length;
  const end = path.length - parts[parts.length - 1].length;
  for (const mid of parts.slice(1, -1)) {
    const i = path.indexOf(mid, pos);
    if (i === -1 || i > end || path.slice(pos, i).includes("/")) return false;
    pos = i + mid.length;
  }
  return pos <= end && !path.slice(pos, end).includes("/");
}
const isPrivate = (f) => privatePatterns.some((p) => globMatch(p, f));
const deny = lines(".public-deny.local").map((p) => new RegExp(p, "i"));
const problems = [];

for (const f of files) {
  if (isPrivate(f)) continue;
  if (/(^|\/)\.env(\.|$)/.test(f) && !f.endsWith(".env.example")) problems.push(`${f}: env file tracked`);
  if (/(^|\/)profile\.json$/.test(f) || (/^profiles\//.test(f) && f !== "profiles/example.json")) problems.push(`${f}: real profile tracked`);
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  if (/BEGIN [A-Z ]*PRIVATE KEY/.test(text) && !f.startsWith("test/fixtures/tls/")) problems.push(`${f}: private key`);
  text.split("\n").forEach((line, i) => {
    for (const re of deny) if (re.test(line)) problems.push(`${f}:${i + 1}: matches ${re.source}`);
  });
}

// Lịch sử git: file riêng tư đã từng commit ⇒ không push lịch sử này lên repo public.
const history = execFileSync("git", ["log", "--all", "--name-only", "--format="], { encoding: "utf8" }).split("\n");
const leakedHistory = [...new Set(history.filter((f) => f && isPrivate(f)))];

console.log(`checked ${files.filter((f) => !isPrivate(f)).length} public files, ${deny.length} deny patterns`);
if (!deny.length) console.log("warning: no .public-deny.local — site-specific strings were not checked");
if (leakedHistory.length) {
  console.log(`warning: private files exist in git history (${leakedHistory.join(", ")}): publish from a fresh orphan branch, never this history`);
}
for (const p of problems) console.log(`FAIL ${p}`);
process.exit(problems.length ? 1 : 0);
