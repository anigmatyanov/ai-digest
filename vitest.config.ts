import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{packages,apps}/*/src/**/*.test.ts", "scripts/**/*.test.ts"],
    setupFiles: ["./test/setup/no-network.ts"],
    reporters: ["default"],
    passWithNoTests: false,
  },
});
