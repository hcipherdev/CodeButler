import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 30000
  }
});
