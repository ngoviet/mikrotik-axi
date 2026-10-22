#!/usr/bin/env node
import { runHook } from "./hook.js";

await runHook({
  env: process.env,
  // Claude Code đặt CLAUDE_PROJECT_DIR; các agent khác chạy hook với cwd = thư mục dự án.
  cwd: process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd(),
  write: (c) => process.stdout.write(c),
});
// Thoát ngay: socket tới router chưa đóng (khi hết ngân sách 3 s) không được giữ phiên agent.
process.stdout.write("", () => process.exit(0));
