import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Test bin (fast path, shebang, đường dẫn dist) cần bản build thật ⇒ build 1 lần trước cả suite.
export default function setup(): void {
  const require = createRequire(import.meta.url);
  const tsupCli = join(dirname(require.resolve("tsup/package.json")), "dist", "cli-default.js");
  execFileSync(process.execPath, [tsupCli, "--silent"], { stdio: "inherit" });
}
