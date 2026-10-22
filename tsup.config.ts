import { defineConfig } from "tsup";

export default defineConfig({
  // Tên entry "bin/mikrotik-axi" ⇒ dist/bin/mikrotik-axi.js (khớp "bin" trong package.json).
  // cli.ts nạp động từ bin.ts ⇒ esbuild tách thành chunk riêng, fast path không chạm tới.
  // bin/mikrotik-axi-hook: lệnh SessionStart hook (src/hook.ts giải thích vì sao tách riêng).
  entry: { "bin/mikrotik-axi": "src/bin.ts", "bin/mikrotik-axi-hook": "src/hook-bin.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  splitting: true,
  clean: true,
  sourcemap: false,
  dts: false,
});
