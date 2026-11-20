import { defineConfig } from "vitest/config";

// Suite on a throwaway RouterOS CHR (reads AND writes). Run: MIKROTIK_AXI_CHR=1 pnpm test:chr, after
// scripts/chr/boot.sh and scripts/chr/provision.mjs (see .github/workflows/chr.yml).
export default defineConfig({
  test: {
    include: ["test/chr/**/*.chr.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 45000,
  },
});
