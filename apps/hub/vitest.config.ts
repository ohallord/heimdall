import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Fixed test key so sealing never auto-creates a key file in the repo.
    env: {
      HEIMDALL_SECRET_KEY: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
      // Existing alert tests expect an alert on the first breaching sample; sustain tests set the window explicitly.
      HEIMDALL_ALERT_SUSTAIN_DEFAULT_SECONDS: "0",
    },
    // pglite cold-start under parallel load can exceed the 5s default
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
