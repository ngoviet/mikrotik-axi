import { defineConfig } from "vitest/config";

// Test trên router THẬT, chỉ đọc. Chạy: MIKROTIK_AXI_LIVE=1 pnpm test:live (cần profile + axi-ro).
export default defineConfig({
  test: {
    include: ["test/live/**/*.live.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 15000,
  },
});
