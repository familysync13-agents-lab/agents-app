import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src"), "server-only": path.resolve(import.meta.dirname, "tests/support/empty.ts") } },
  test: { environment: "node", include: ["tests/**/*.test.ts"], testTimeout: 30000, pool: "forks" },
});
