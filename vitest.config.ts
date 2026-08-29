import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `profiles/` is included so a test can sit next to profiles/schema.ts. Added ahead of
    // E-006 on purpose: putting vitest.config.ts in that epic's file map would have forced
    // it to hold the `toolchain` label and collide with E-007, which is in flight.
    include: [
      "{packages,apps}/*/src/**/*.test.ts",
      "scripts/**/*.test.ts",
      "profiles/**/*.test.ts",
    ],
    setupFiles: ["./test/setup/no-network.ts"],
    reporters: ["default"],
    passWithNoTests: false,
  },
});
