import { defineConfig } from "tsup";

// Script dev (skill, ghi fixture) — build vào build/ (gitignore), KHÔNG vào dist/ (gói publish).
export default defineConfig({
  entry: { skill: "scripts/skill.ts", "record-fixtures": "scripts/record-fixtures.ts" },
  outDir: "build/scripts",
  format: ["esm"],
  platform: "node",
  target: "node20",
  clean: true,
  silent: true,
});
